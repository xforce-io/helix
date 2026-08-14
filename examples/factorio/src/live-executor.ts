import path from 'node:path'
import type { ITraceObjectStore, ModelRequest, ModelResponse } from 'milkie'
import type { IOInvocationControl } from 'milkie'
import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import { byteLength, canonicalJson, digest } from './canonical.js'
import { JsonLineProcess } from './line-process.js'
import {
  allocateChildRunId,
  applyReserve,
  buildRejectedResult,
  buildSucceededResult,
  DEFAULT_PARENT_RECURSIVE_TOKEN_POOL,
  decideReserve,
  emptyReservation,
  extractResponseText,
  mapProviderError,
  MAX_RECURSIVE_CALLS_PER_RUN,
  MAX_RECURSIVE_COMPLETION_TOKENS,
  modelEffectFromResult,
  MODEL_RESPONSE_KIND,
  MODEL_RESPONSE_SCHEMA,
  prepareRecursiveAdmission,
  RECURSIVE_CHILD_AGENT_ID,
  RECURSIVE_TEMPERATURE,
  refundReserve,
  reservationFromDeclared,
  resultToWire,
  settleReserve,
  truncateGoal,
  truncatePreview,
} from './recursive-model.js'
import type { DeclaredLimits, PreparedRecursiveAdmission } from './recursive-model.js'
import { SessionAsyncHost, type SessionAsyncHostOptions } from './session-async-host.js'
import { CELL_EXECUTION_SCHEMA } from './session-async-constants.js'
import {
  childRecordedFromFrozen,
  inheritFrozenHarnessSlice,
  toHarnessPinsV1,
  type FrozenHarnessSlice,
  type HarnessPinsV1,
} from '../../../src/harness/index.js'
import { harnessError } from '../../../src/harness/errors.js'
import type {
  AgentEffect,
  CellExecutionRecord,
  FactorioEffect,
  MailboxEffect,
  ModelBudgetPool,
  ModelBudgetSettlement,
  ModelEffect,
  ObjectRef,
  RecursiveModelResult,
  RunPins,
  SessionEffect,
  TaskVerification,
} from './types.js'

interface ExecuteCellInput {
  cellId: string
  code: string
  expectedKernelRevision: number
  expectedEpisodeRevision: number
  pinsDigest: string
}

interface BridgeResult {
  observation: Record<string, unknown>
  stateRaw: string
  reward: number
  terminated: boolean
  truncated: boolean
  stepSeconds: number
  verification: TaskVerification
  info: Record<string, unknown>
  actionCapabilities: string[]
}

export interface ChildPortHandle {
  port: IIOPort
  /** True once agent.run.started / attach has been observed. */
  attached: boolean
  detach: (payload: {
    status: 'completed' | 'interrupted' | 'error'
    lastTextOutput?: string
    error?: string
  }) => Promise<void>
}

export type ChildPortFactory = (args: {
  childRunId: string
  parentRunId: string
  episodeId: string
  goal: string
  /** Non-secret attach/input payload — never a capability token. */
  input: string
  agentId: string
  /**
   * Inherited parent frozen harness slice for the child run.
   * Host-private control-plane identity — not a public Kernel binding.
   */
  frozenHarness?: FrozenHarnessSlice
  /** Child RunPins.harnessState recorded from the inherited slice. */
  harnessState?: HarnessPinsV1
  /**
   * Host-private child session binding. MUST NOT be copied into attach,
   * trace payloads, or invokeLLM request bodies.
   */
  sessionBootstrap?: {
    sessionId: string
    handleId: string
    capabilityToken: string
  }
}) => Promise<ChildPortHandle>

export interface LiveCellExecutorOptions {
  recursiveModelEnabled?: boolean
  recursiveTokenPool?: number
  maxRecursiveCalls?: number
  childPortFactory?: ChildPortFactory
  /**
   * Parent frozen harness slice. Required for real recursive child bootstrap:
   * child inherits and records this slice; drift is HARNESS_CHILD_SELECTION_DRIFT
   * before any child model request/effect.
   */
  frozenHarness?: FrozenHarnessSlice
  /** Injected parent absolute control for child invokeLLM. */
  control?: IOInvocationControl
  /**
   * Test seam: force attach branch.
   * - 'never-started' → C1
   * - 'post-started' → C2 (attached then fail before LLM)
   */
  attachFault?: 'never-started' | 'post-started'
  /**
   * Test seam: throw after prepareRecursiveAdmission succeeds (I4 INTERNAL path).
   * Used to prove catch preserves digest/declared* before atomic commit.
   */
  internalFaultAfterPrepare?: boolean
  /**
   * Test seam: throw after child invokeLLM returns a terminal response,
   * before response object-store / final settlement packaging.
   * Proves post-invoke INTERNAL settles actual usage and detaches once.
   */
  internalFaultAfterInvoke?: boolean
  /** Issue #7 session/async/mailbox host options. */
  sessionAsync?: SessionAsyncHostOptions
}

/** Mutable stage tracker for post-prepare INTERNAL / unexpected failure handling. */
function readUsageTokens(
  error: unknown,
  field: 'inputTokens' | 'outputTokens',
): number {
  if (!error || typeof error !== 'object' || !('usage' in error)) return 0
  const usageValue = error.usage
  if (!usageValue || typeof usageValue !== 'object') return 0
  const record = usageValue as Record<string, unknown>
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

interface ModelsCallStage {
  committed: boolean
  declared?: DeclaredLimits
  reserve: number
  remainingBeforeSettle: number
  childRunId?: string
  handle?: ChildPortHandle
  observedStarted: boolean
  invokedLlm: boolean
  terminalUsage?: { inputTokens: number; outputTokens: number }
  settled: boolean
  detached: boolean
}

const FLE_STEP_TIMEOUT_MS = 120_000
const KERNEL_CELL_TIMEOUT_MS = 130_000


function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'PORT_OFFSET', 'FLE_STATE_DIR'] as const
  const env: NodeJS.ProcessEnv = {
    PYTHONUNBUFFERED: '1',
    HELIX_KERNEL_MEMORY_BYTES: '1073741824',
    HELIX_KERNEL_CPU_SECONDS: '600',
  }
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, 512)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 2) return String(value).slice(0, 512)
  if (Array.isArray(value)) return value.slice(0, 16).map(item => boundedValue(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 24)
      .map(([key, item]) => [key, boundedValue(item, depth + 1)]),
  )
}

export function boundedObservation(
  observation: Record<string, unknown>,
): Record<string, unknown> {
  const rawText = String(observation['raw_text'] ?? '')
  const entities = Array.isArray(observation['entities'])
    ? observation['entities'].slice(0, 24).map(item => boundedValue(item))
    : []
  const inventory = Array.isArray(observation['inventory'])
    ? observation['inventory'].slice(0, 64).map(item => boundedValue(item))
    : []
  const gameInfo = asRecord(observation['game_info'])
  const taskInfo = asRecord(observation['task_info'])
  const taskVerification = asRecord(observation['task_verification'])
  const verificationMeta = Array.isArray(taskVerification['meta'])
    ? taskVerification['meta'].slice(0, 8).map(item => {
        const entry = asRecord(item)
        return {
          key: String(entry['key'] ?? '').slice(0, 256),
          value: String(entry['value'] ?? '').slice(0, 256),
        }
      })
    : []
  const preview: Record<string, unknown> = {
    rawText: rawText.slice(0, 4_096),
    rawTextTruncated: rawText.length > 4_096,
    entities,
    entityCount: Array.isArray(observation['entities']) ? observation['entities'].length : 0,
    inventory,
    gameInfo: {
      tick: gameInfo['tick'] ?? 0,
      time: gameInfo['time'] ?? 0,
      speed: gameInfo['speed'] ?? 0,
    },
    taskInfo: {
      goal_description: String(taskInfo['goal_description'] ?? '').slice(0, 1_024),
      agent_instructions: String(taskInfo['agent_instructions'] ?? '').slice(0, 512),
      task_key: String(taskInfo['task_key'] ?? '').slice(0, 256),
      trajectory_length: taskInfo['trajectory_length'] ?? 0,
    },
    taskVerification: {
      success: taskVerification['success'] ?? false,
      meta: verificationMeta,
    },
    score: observation['score'] ?? 0,
    automatedScore: observation['automated_score'] ?? 0,
    characterPositions: Array.isArray(observation['character_positions'])
      ? observation['character_positions'].slice(0, 4).map(item => boundedValue(item))
      : [],
  }
  while (byteLength(canonicalJson(preview)) > 8_192) {
    if (entities.length > 0) entities.pop()
    else if (inventory.length > 0) inventory.pop()
    else {
      const current = String(preview['rawText'] ?? '')
      if (current.length === 0) break
      preview['rawText'] = current.slice(0, Math.floor(current.length / 2))
      preview['rawTextTruncated'] = true
    }
  }
  return preview
}

async function putJsonObject(
  store: ITraceObjectStore,
  value: unknown,
  kind: ObjectRef['kind'],
  schema: string,
  preview?: unknown,
): Promise<ObjectRef> {
  const canonical = canonicalJson(value)
  const hash = await store.putCanonical(canonical)
  return {
    hash,
    kind,
    schema,
    mediaType: 'application/json',
    bytes: byteLength(canonical),
    ...(preview === undefined ? {} : { preview }),
    truncated: preview !== undefined && canonicalJson(preview) !== canonical,
  }
}

async function putTextObject(
  store: ITraceObjectStore,
  value: string,
  kind: ObjectRef['kind'],
  schema: string,
): Promise<ObjectRef> {
  const hash = await store.putCanonical(value)
  return {
    hash,
    kind,
    schema,
    mediaType: 'text/plain',
    bytes: byteLength(value),
    preview: value.slice(0, 2_048),
    truncated: value.length > 2_048,
  }
}

function sanitizeModelResponse(response: ModelResponse): Record<string, unknown> {
  return {
    content: response.content,
    toolCalls: response.toolCalls,
    usage: response.usage ?? null,
    finishReason: response.finishReason ?? null,
    // raw intentionally stripped — secrets / SDK body stay out of object store
  }
}

export class LiveCellExecutor {
  private kernel: JsonLineProcess | undefined
  private bridge: JsonLineProcess | undefined
  private bridgeOrdinal = 0
  private commandOrdinal = 0
  private stateRaw: string | undefined
  private stateRef: ObjectRef | undefined
  private resetCount = 0
  private stepCount = 0
  private hostEffectOccupied = false
  private recursiveOrdinal = 0
  private readonly budgetPool: ModelBudgetPool
  private readonly maxRecursiveCalls: number
  private readonly recursiveModelEnabled: boolean
  private control: IOInvocationControl | undefined
  private childPortFactory: ChildPortFactory | undefined
  private frozenHarness: FrozenHarnessSlice | undefined
  private attachFault: LiveCellExecutorOptions['attachFault']
  private internalFaultAfterPrepare: boolean
  private internalFaultAfterInvoke: boolean
  /** In-flight post-prepare stage for INTERNAL catch (not concurrent). */
  private activeModelsCallStage: ModelsCallStage | undefined
  private pendingControlTermination: 'cancelled' | 'wall_budget_exhausted' | undefined
  /** Issue #7 session/async host (optional). */
  readonly sessionAsync: SessionAsyncHost | undefined

  /** Observed started/attached child run ids (success + C2). */
  readonly childRunIds: string[] = []
  /** C1 never-started ids. */
  readonly nonReplayableChildRunIds: string[] = []
  /** Live Provider invokeLLM count on recursive path (for S3 assertions). */
  recursiveProviderCalls = 0

  kernelStartCount = 0
  bridgeStartCount = 0
  effectCount = 0

  constructor(
    private readonly runId: string,
    private readonly episodeId: string,
    private readonly pins: RunPins,
    private readonly objectStore: ITraceObjectStore,
    options: LiveCellExecutorOptions = {},
  ) {
    const initial =
      options.recursiveTokenPool ?? DEFAULT_PARENT_RECURSIVE_TOKEN_POOL
    this.budgetPool = {
      initialTokens: initial,
      remainingTokens: initial,
      recursiveCallCount: 0,
      settlements: [],
      openRecursiveCalls: [],
    }
    this.maxRecursiveCalls = options.maxRecursiveCalls ?? MAX_RECURSIVE_CALLS_PER_RUN
    this.recursiveModelEnabled = options.recursiveModelEnabled !== false
    this.control = options.control
    this.childPortFactory = options.childPortFactory
    this.frozenHarness = options.frozenHarness
    this.attachFault = options.attachFault
    this.internalFaultAfterPrepare = options.internalFaultAfterPrepare === true
    this.internalFaultAfterInvoke = options.internalFaultAfterInvoke === true
    if (options.sessionAsync) {
      const saOpts: SessionAsyncHostOptions = { ...options.sessionAsync }
      if (options.control) saOpts.control = options.control
      if (options.childPortFactory && !saOpts.childPortFactory) {
        saOpts.childPortFactory = options.childPortFactory
      }
      if (!saOpts.model) saOpts.model = this.pins.model
      this.sessionAsync = new SessionAsyncHost(saOpts)
      this.sessionAsync.bindParent()
      this.sessionAsync.setParentRunId(runId)
    }
  }

  setControl(control: IOInvocationControl | undefined): void {
    this.control = control
    this.sessionAsync?.setControl(control)
  }

  getBudgetPool(): ModelBudgetPool {
    return {
      initialTokens: this.budgetPool.initialTokens,
      remainingTokens: this.budgetPool.remainingTokens,
      recursiveCallCount: this.budgetPool.recursiveCallCount,
      settlements: [...this.budgetPool.settlements],
      ...(this.budgetPool.openRecursiveCalls
        ? { openRecursiveCalls: [...this.budgetPool.openRecursiveCalls] }
        : {}),
    }
  }

  /** Test/harness seam: swap child port factory between cells. */
  setChildPortFactory(factory: ChildPortFactory | undefined): void {
    this.childPortFactory = factory
    this.sessionAsync?.setChildPortFactory(factory)
  }

  /** Host control-plane seam: bind parent frozen harness for child inheritance. */
  setFrozenHarness(frozen: FrozenHarnessSlice | undefined): void {
    this.frozenHarness = frozen
  }

  getFrozenHarness(): FrozenHarnessSlice | undefined {
    return this.frozenHarness
  }

  /** Test seam: clear per-cell host effect gate between cells. */
  resetHostEffectOccupied(): void {
    this.hostEffectOccupied = false
  }

  getRecursiveControlTermination():
    | 'cancelled'
    | 'wall_budget_exhausted'
    | undefined {
    return this.pendingControlTermination
  }

  private pythonExecutable(): string {
    return (
      process.env['HELIX_FACTORIO_PYTHON'] ??
      path.resolve('examples/factorio/.venv/bin/python')
    )
  }

  private ensureKernel(): JsonLineProcess {
    if (!this.kernel) {
      this.kernel = new JsonLineProcess(
        this.pythonExecutable(),
        [path.resolve('examples/factorio/workers/kernel_worker.py')],
        workerEnvironment(),
        'kernel-worker',
        { memoryBytes: this.pins.kernelMemoryBytes },
      )
      this.kernelStartCount += 1
    }
    return this.kernel
  }

  private ensureBridge(): JsonLineProcess {
    if (!this.bridge) {
      this.bridge = new JsonLineProcess(
        this.pythonExecutable(),
        [path.resolve('examples/factorio/workers/bridge_worker.py')],
        workerEnvironment(),
        'factorio-bridge',
      )
      this.bridgeStartCount += 1
    }
    return this.bridge
  }

  private async bridgeRequest(
    method: 'reset' | 'step',
    commandId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BridgeResult> {
    const bridge = this.ensureBridge()
    const id = `${this.runId}:bridge:${this.bridgeOrdinal++}`
    bridge.send({ protocolVersion: '2', id, commandId, method, params })
    const response = await bridge.receive({
      timeoutMs: FLE_STEP_TIMEOUT_MS,
      code: method === 'step' ? 'FLE_TIMEOUT_UNCERTAIN' : 'FLE_RESET_TIMEOUT',
      stateCertainty: method === 'step' ? 'uncertain' : 'unchanged',
      ...(signal === undefined ? {} : { signal }),
    })
    if (response['id'] !== id) throw new Error(`bridge response id mismatch for ${id}`)
    if (response['ok'] !== true) {
      const error = asRecord(response['error'])
      throw Object.assign(new Error(String(error['message'] ?? 'FLE bridge failed')), {
        code: String(error['code'] ?? 'FLE_EXECUTION_ERROR'),
        stateCertainty:
          error['stateCertainty'] === 'uncertain'
            ? ('uncertain' as const)
            : error['stateCertainty'] === 'confirmed'
              ? ('confirmed' as const)
              : ('unchanged' as const),
      })
    }
    return response['result'] as unknown as BridgeResult
  }

  private recordSettlement(settlement: ModelBudgetSettlement): void {
    this.budgetPool.settlements.push(settlement)
  }

  private removeOpenCall(childRunId: string): void {
    if (!this.budgetPool.openRecursiveCalls) return
    this.budgetPool.openRecursiveCalls = this.budgetPool.openRecursiveCalls.filter(
      item => item.childRunId !== childRunId,
    )
  }

  /**
   * Host-authoritative models.call path (L2 §6.2).
   * Always returns ok:true + RecursiveModelResult for parseable frames (IMP-B).
   */
  private async handleModelsCall(
    frame: Record<string, unknown>,
    cellId: string,
    signal?: AbortSignal,
  ): Promise<{ result: RecursiveModelResult; modelEffect: ModelEffect }> {
    const params = asRecord(frame['params'])
    const admissionInput = Object.prototype.hasOwnProperty.call(params, 'input')
      ? params['input']
      : undefined
    const prepared = prepareRecursiveAdmission({
      instructions: params['instructions'],
      input: admissionInput,
      maxOutputTokens: params['maxOutputTokens'],
      remainingTokens: this.budgetPool.remainingTokens,
      model: this.pins.model,
    })

    // Step 1 fail: param/canonical — no digest (I4 partition 2).
    if (!prepared.ok) {
      return { result: prepared.result, modelEffect: prepared.modelEffect }
    }

    // Stage tracker for post-prepare INTERNAL: settle/detach by phase, never blind refund.
    const stage: ModelsCallStage = {
      committed: false,
      reserve: 0,
      remainingBeforeSettle: 0,
      observedStarted: false,
      invokedLlm: false,
      settled: false,
      detached: false,
    }
    this.activeModelsCallStage = stage
    try {
      return await this.handleModelsCallAfterPrepare(
        prepared,
        admissionInput,
        cellId,
        signal,
        stage,
      )
    } catch (error) {
      // Child harness identity drift is a Host control-plane fail-closed error:
      // do not convert it into a RecursiveModelResult INTERNAL failure.
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'HARNESS_CHILD_SELECTION_DRIFT'
      ) {
        throw error
      }
      return await this.buildInternalFailureFromPrepared(
        prepared,
        admissionInput,
        error,
        stage,
      )
    } finally {
      this.activeModelsCallStage = undefined
    }
  }

  private async handleModelsCallAfterPrepare(
    prepared: PreparedRecursiveAdmission,
    admissionInput: unknown,
    cellId: string,
    signal: AbortSignal | undefined,
    stage: ModelsCallStage,
  ): Promise<{ result: RecursiveModelResult; modelEffect: ModelEffect }> {
    if (this.internalFaultAfterPrepare) {
      throw new Error('injected internal fault after prepare')
    }
    const requestEcho = {
      instructions: prepared.instructions,
      ...(admissionInput === undefined ? {} : { input: admissionInput }),
      model: this.pins.model,
    }
    const toModelEffect = (result: RecursiveModelResult): ModelEffect =>
      modelEffectFromResult(result, requestEcho)

    const rejectWithDigest = (
      code: Parameters<typeof buildRejectedResult>[0]['code'],
      message: string,
    ): { result: RecursiveModelResult; modelEffect: ModelEffect } => {
      const result = buildRejectedResult({
        code,
        message,
        reservation: reservationFromDeclared(prepared.declared),
        requestDigest: prepared.requestDigest,
      })
      const modelEffect = toModelEffect(result)
      this.recordSettlement({
        reservedTokens: 0,
        declaredPromptTokens: prepared.declared.declaredPromptTokens,
        declaredCompletionTokens: prepared.declared.declaredCompletionTokens,
        requestedCompletionTokens: prepared.declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'rejected',
        requestDigest: prepared.requestDigest,
      })
      return { result, modelEffect }
    }

    // Step 3: occupied gate (IMP-B → ok:true + rejected)
    if (this.hostEffectOccupied) {
      return rejectWithDigest(
        'MULTIPLE_EFFECTS_IN_CELL',
        'one external effect per cell',
      )
    }

    // Step 4: capability
    if (!this.recursiveModelEnabled) {
      return rejectWithDigest(
        'RECURSIVE_MODEL_NOT_ENABLED',
        'recursive model capability is not enabled',
      )
    }

    // Step 5: call count
    if (this.budgetPool.recursiveCallCount >= this.maxRecursiveCalls) {
      return rejectWithDigest(
        'RECURSIVE_CALL_LIMIT_EXCEEDED',
        `recursive call limit ${this.maxRecursiveCalls} exceeded`,
      )
    }

    // Step 6: budget clamp gate (live remaining)
    const reserveDecision = decideReserve({
      instructionsByteLength: prepared.instructionsBytes.byteLength,
      inputByteLength: prepared.inputByteLength,
      maxOutputTokens: prepared.declared.requestedCompletionTokens,
      remainingTokens: this.budgetPool.remainingTokens,
    })
    const declared = reserveDecision.declared
    // Digest is bound to declaredCompletionTokens; prepare used the same remaining.
    const requestDigest = prepared.requestDigest
    if (!reserveDecision.ok) {
      const result = buildRejectedResult({
        code: 'RECURSIVE_BUDGET_INSUFFICIENT',
        message:
          reserveDecision.reason === 'prompt_exceeds_pool'
            ? 'declared prompt exceeds remaining pool'
            : 'reserve below minimum after clamp',
        reservation: reservationFromDeclared(declared),
        requestDigest,
      })
      this.recordSettlement({
        reservedTokens: 0,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'rejected',
        requestDigest,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    // Child harness inheritance BEFORE atomic reserve/commit so drift fails
    // closed with no budget/effect side effects and before any child LLM.
    // Legacy unit paths without #10 freeze keep prior attach-only behavior.
    let childFrozen: FrozenHarnessSlice | undefined
    let childHarnessState: HarnessPinsV1 | undefined
    if (this.frozenHarness !== undefined) {
      const parentFrozen = this.frozenHarness
      // Prefer child-recorded identity from parent pins.harnessState when present
      // so a mismatched recorded selection is rejected before the child LLM.
      const childRecorded =
        this.pins.harnessState !== undefined
          ? {
              selection: {
                baselineRef: this.pins.harnessState.baselineRef,
                ...(this.pins.harnessState.overlayRef !== undefined
                  ? { overlayRef: this.pins.harnessState.overlayRef }
                  : {}),
              },
              harnessContentHash: this.pins.harnessState.harnessContentHash,
              schemaVersion: this.pins.harnessState.schemaVersion,
              catalogCards: this.pins.harnessState.catalogCards,
              compatibilityDecision: this.pins.harnessState.compatibilityDecision,
              codeProtocolPin: this.pins.harnessState.codeProtocolPin,
            }
          : childRecordedFromFrozen(parentFrozen)
      childFrozen = inheritFrozenHarnessSlice({
        parent: parentFrozen,
        childRecorded,
      })
      childHarnessState = toHarnessPinsV1({
        document: childFrozen.document,
        selection: childFrozen.selection,
        harnessContentHash: childFrozen.harnessContentHash,
        schemaVersion: childFrozen.schemaVersion,
        catalogCards: childFrozen.catalogCards,
        compatibilityDecision: childFrozen.compatibilityDecision,
        codeProtocolPin: childFrozen.codeProtocolPin,
        availableCatalogRefs: childFrozen.availableCatalogRefs,
      })
    } else if (this.pins.harnessState !== undefined) {
      // New-format pins without Host-bound freeze cannot spawn children.
      throw harnessError(
        'HARNESS_CHILD_SELECTION_DRIFT',
        'recursive child requires parent frozen harness slice when pins.harnessState is present',
        { parentRunId: this.runId },
      )
    }

    // Step 7: atomic commit — occupy + reserve + count + allocate id
    const reserve = declared.reserve
    this.budgetPool.remainingTokens = applyReserve(
      this.budgetPool.remainingTokens,
      reserve,
    )
    this.budgetPool.recursiveCallCount += 1
    this.hostEffectOccupied = true
    this.effectCount += 1
    const ordinal = this.recursiveOrdinal++
    const childRunId = allocateChildRunId(this.runId, ordinal)
    this.budgetPool.openRecursiveCalls = [
      ...(this.budgetPool.openRecursiveCalls ?? []),
      {
        childRunId,
        reserve,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
      },
    ]

    const remainingBeforeSettle = this.budgetPool.remainingTokens
    stage.committed = true
    stage.declared = declared
    stage.reserve = reserve
    stage.remainingBeforeSettle = remainingBeforeSettle
    stage.childRunId = childRunId

    // Attach (IMP-A)
    if (this.attachFault === 'never-started') {
      const settlement = refundReserve(remainingBeforeSettle, reserve)
      this.budgetPool.remainingTokens = settlement.remainingAfter
      this.removeOpenCall(childRunId)
      stage.settled = true
      this.nonReplayableChildRunIds.push(childRunId)
      const result = buildRejectedResult({
        code: 'RECURSIVE_CHILD_ATTACH_FAILED',
        message: 'child run attach never started',
        childRunId,
        attachFailed: true,
        requestDigest: prepared.requestDigest,
        reservation: reservationFromDeclared(declared, {
          reservedTokens: 0,
          actualUsageTokens: 0,
          chargedTokens: 0,
          overflowTokens: 0,
        }),
      })
      this.recordSettlement({
        childRunId,
        reservedTokens: 0,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'failed',
        requestDigest: prepared.requestDigest,
        attachFailed: true,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    if (!this.childPortFactory) {
      // No factory configured → treat as C1 never-started (no Provider).
      const settlement = refundReserve(remainingBeforeSettle, reserve)
      this.budgetPool.remainingTokens = settlement.remainingAfter
      this.removeOpenCall(childRunId)
      stage.settled = true
      this.nonReplayableChildRunIds.push(childRunId)
      const result = buildRejectedResult({
        code: 'RECURSIVE_CHILD_ATTACH_FAILED',
        message: 'child port factory is not configured',
        childRunId,
        attachFailed: true,
        requestDigest: prepared.requestDigest,
        reservation: reservationFromDeclared(declared, {
          reservedTokens: 0,
        }),
      })
      this.recordSettlement({
        childRunId,
        reservedTokens: 0,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'failed',
        requestDigest: prepared.requestDigest,
        attachFailed: true,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    let handle: ChildPortHandle | undefined
    let observedStarted = false
    try {
      handle = await this.childPortFactory({
        childRunId,
        parentRunId: this.runId,
        episodeId: this.episodeId,
        goal: truncateGoal(prepared.instructions),
        input: prepared.requestDigest,
        agentId: RECURSIVE_CHILD_AGENT_ID,
        ...(childFrozen !== undefined ? { frozenHarness: childFrozen } : {}),
        ...(childHarnessState !== undefined ? { harnessState: childHarnessState } : {}),
      })
      observedStarted = handle.attached === true
      stage.handle = handle
      stage.observedStarted = observedStarted
    } catch (error) {
      // Attach threw before started observation → C1
      const settlement = refundReserve(remainingBeforeSettle, reserve)
      this.budgetPool.remainingTokens = settlement.remainingAfter
      this.removeOpenCall(childRunId)
      stage.settled = true
      this.nonReplayableChildRunIds.push(childRunId)
      const result = buildRejectedResult({
        code: 'RECURSIVE_CHILD_ATTACH_FAILED',
        message: String(
          error instanceof Error ? error.message : 'child run attach never started',
        ).slice(0, 512),
        childRunId,
        attachFailed: true,
        requestDigest: prepared.requestDigest,
        reservation: reservationFromDeclared(declared, { reservedTokens: 0 }),
      })
      this.recordSettlement({
        childRunId,
        reservedTokens: 0,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'failed',
        requestDigest: prepared.requestDigest,
        attachFailed: true,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    if (!observedStarted) {
      // Factory returned without attach confirmation → C1
      // I2: attached=false ⇒ do NOT detach (never-started has no started lifecycle).
      const settlement = refundReserve(remainingBeforeSettle, reserve)
      this.budgetPool.remainingTokens = settlement.remainingAfter
      this.removeOpenCall(childRunId)
      stage.settled = true
      this.nonReplayableChildRunIds.push(childRunId)
      const result = buildRejectedResult({
        code: 'RECURSIVE_CHILD_ATTACH_FAILED',
        message: 'child run attach never started',
        childRunId,
        attachFailed: true,
        requestDigest: prepared.requestDigest,
        reservation: reservationFromDeclared(declared, { reservedTokens: 0 }),
      })
      this.recordSettlement({
        childRunId,
        reservedTokens: 0,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'failed',
        requestDigest: prepared.requestDigest,
        attachFailed: true,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    // Observed started → id enters childRunIds (success path or C2)
    this.childRunIds.push(childRunId)

    if (this.attachFault === 'post-started') {
      try {
        await handle.detach({ status: 'error', error: 'post-attach failure before LLM' })
      } catch {
        // detach once best-effort
      }
      stage.detached = true
      const settlement = refundReserve(remainingBeforeSettle, reserve)
      this.budgetPool.remainingTokens = settlement.remainingAfter
      this.removeOpenCall(childRunId)
      stage.settled = true
      const result = buildRejectedResult({
        code: 'RECURSIVE_CHILD_POST_ATTACH_FAILED',
        message: 'post-attach failure before LLM',
        childRunId,
        requestDigest: prepared.requestDigest,
        reservation: reservationFromDeclared(declared, { reservedTokens: 0 }),
      })
      // ensure attachFailed is not true
      delete (result as { attachFailed?: boolean }).attachFailed
      this.recordSettlement({
        childRunId,
        reservedTokens: 0,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: 0,
        chargedTokens: 0,
        overflowTokens: 0,
        status: 'failed',
        requestDigest: prepared.requestDigest,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    // invokeLLM on child
    const request: ModelRequest = {
      model: this.pins.model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prepared.userContent }],
        },
      ],
      temperature: RECURSIVE_TEMPERATURE,
      maxTokens: declared.declaredCompletionTokens,
      metadata: {
        parentRunId: this.runId,
        childRunId,
        cellId,
        recursiveOrdinal: ordinal,
        pinsDigest: digest(this.pins),
        requestDigest: prepared.requestDigest,
        ...(childFrozen !== undefined
          ? {
              // Child identity record: inherited parent harness slice (L2 §4.4).
              harnessContentHash: childFrozen.harnessContentHash,
              harnessState: childHarnessState,
            }
          : {}),
      },
    }

    const childControl: IOInvocationControl = {
      ...(this.control?.deadlineAt === undefined
        ? {}
        : { deadlineAt: this.control.deadlineAt }),
      ...(signal
        ? { signal }
        : this.control?.signal
          ? { signal: this.control.signal }
          : {}),
    }

    let response: ModelResponse
    try {
      this.recursiveProviderCalls += 1
      // Mark request-started before await so INTERNAL mid-flight settles as invoked.
      stage.invokedLlm = true
      response = await handle.port.invokeLLM(request, {
        control: childControl,
      })
    } catch (error) {
      const mapped = mapProviderError(error)
      if (mapped.parentTermination) {
        this.pendingControlTermination = mapped.parentTermination
      }
      const usageInput = readUsageTokens(error, 'inputTokens')
      const usageOutput = readUsageTokens(error, 'outputTokens')
      stage.terminalUsage = { inputTokens: usageInput, outputTokens: usageOutput }
      const settlement = settleReserve({
        remainingBeforeSettle,
        reserve,
        inputTokens: usageInput,
        outputTokens: usageOutput,
      })
      this.budgetPool.remainingTokens = settlement.remainingAfter
      this.removeOpenCall(childRunId)
      stage.settled = true
      try {
        await handle.detach({
          status: mapped.status === 'cancelled' ? 'interrupted' : 'error',
          error: mapped.message,
        })
      } catch {
        // detach once
      }
      stage.detached = true
      const result: RecursiveModelResult = {
        schema: 'helix.recursive-model-result/v1',
        status: mapped.status,
        text: '',
        textTruncated: false,
        childRunId,
        usage:
          usageInput + usageOutput > 0
            ? { inputTokens: usageInput, outputTokens: usageOutput }
            : null,
        responseRef: null,
        reservation: reservationFromDeclared(declared, {
          reservedTokens: reserve,
          actualUsageTokens: settlement.actualUsageTokens,
          chargedTokens: settlement.chargedTokens,
          overflowTokens: settlement.overflowTokens,
        }),
        requestDigest: prepared.requestDigest,
        error: { code: mapped.code, message: mapped.message },
      }
      this.recordSettlement({
        childRunId,
        reservedTokens: reserve,
        declaredPromptTokens: declared.declaredPromptTokens,
        declaredCompletionTokens: declared.declaredCompletionTokens,
        requestedCompletionTokens: declared.requestedCompletionTokens,
        actualUsageTokens: settlement.actualUsageTokens,
        chargedTokens: settlement.chargedTokens,
        overflowTokens: settlement.overflowTokens,
        status: mapped.status,
        requestDigest: prepared.requestDigest,
      })
      return { result, modelEffect: toModelEffect(result) }
    }

    // Success terminal — capture usage before any post-invoke work that may throw.
    const inputTokens = response.usage?.inputTokens ?? 0
    const outputTokens = response.usage?.outputTokens ?? 0
    stage.terminalUsage = { inputTokens, outputTokens }

    if (this.internalFaultAfterInvoke) {
      throw new Error('injected internal fault after invokeLLM')
    }

    const sanitized = sanitizeModelResponse(response)
    const responseRef = await putJsonObject(
      this.objectStore,
      sanitized,
      MODEL_RESPONSE_KIND,
      MODEL_RESPONSE_SCHEMA,
    )

    const settlement = settleReserve({
      remainingBeforeSettle,
      reserve,
      inputTokens,
      outputTokens,
    })
    this.budgetPool.remainingTokens = settlement.remainingAfter
    this.removeOpenCall(childRunId)
    stage.settled = true

    const fullText = extractResponseText(response)
    const preview = truncatePreview(fullText)
    const result = buildSucceededResult({
      text: preview.text,
      textTruncated: preview.truncated,
      childRunId,
      usage: { inputTokens, outputTokens },
      responseRef,
      reservation: reservationFromDeclared(declared, {
        reservedTokens: reserve,
        actualUsageTokens: settlement.actualUsageTokens,
        chargedTokens: settlement.chargedTokens,
        overflowTokens: settlement.overflowTokens,
      }),
      requestDigest: prepared.requestDigest,
    })

    try {
      await handle.detach({
        status: 'completed',
        lastTextOutput: preview.text.slice(0, 512),
      })
    } catch {
      // detach once best-effort after success
    }
    stage.detached = true

    this.recordSettlement({
      childRunId,
      reservedTokens: reserve,
      declaredPromptTokens: declared.declaredPromptTokens,
      declaredCompletionTokens: declared.declaredCompletionTokens,
      requestedCompletionTokens: declared.requestedCompletionTokens,
      actualUsageTokens: settlement.actualUsageTokens,
      chargedTokens: settlement.chargedTokens,
      overflowTokens: settlement.overflowTokens,
      status: 'succeeded',
      requestDigest: prepared.requestDigest,
    })
    return { result, modelEffect: toModelEffect(result) }
  }

  /**
   * I4 INTERNAL catch after prepare: keep requestDigest, request echo, declared*.
   * Settle / detach by stage — never blind-refund openRecursiveCalls after invoke.
   */
  private async buildInternalFailureFromPrepared(
    prepared: PreparedRecursiveAdmission,
    admissionInput: unknown,
    error: unknown,
    stage: ModelsCallStage,
  ): Promise<{ result: RecursiveModelResult; modelEffect: ModelEffect }> {
    const structured = error instanceof Error ? error : new Error(String(error))
    const requestEcho = {
      instructions: prepared.instructions,
      ...(admissionInput === undefined ? {} : { input: admissionInput }),
      model: this.pins.model,
    }
    const declared = stage.declared ?? prepared.declared
    const childRunId = stage.childRunId

    let reservedTokens = 0
    let actualUsageTokens = 0
    let chargedTokens = 0
    let overflowTokens = 0
    let usage: { inputTokens: number; outputTokens: number } | null = null

    if (!stage.committed) {
      // Pre-commit: pool untouched; digest/declared retained; reserved=0.
    } else if (!stage.invokedLlm) {
      // Commit but no LLM request yet → full refund (C1/C2 pre-LLM semantics).
      if (!stage.settled) {
        const settlement = refundReserve(stage.remainingBeforeSettle, stage.reserve)
        this.budgetPool.remainingTokens = settlement.remainingAfter
        if (childRunId !== undefined) this.removeOpenCall(childRunId)
        stage.settled = true
      }
      reservedTokens = 0
      actualUsageTokens = 0
      chargedTokens = 0
      overflowTokens = 0
    } else {
      // LLM request started → settle actual usage; never full refund that masks usage.
      const inputTokens = stage.terminalUsage?.inputTokens ?? 0
      const outputTokens = stage.terminalUsage?.outputTokens ?? 0
      if (!stage.settled) {
        const settlement = settleReserve({
          remainingBeforeSettle: stage.remainingBeforeSettle,
          reserve: stage.reserve,
          inputTokens,
          outputTokens,
        })
        this.budgetPool.remainingTokens = settlement.remainingAfter
        if (childRunId !== undefined) this.removeOpenCall(childRunId)
        stage.settled = true
        actualUsageTokens = settlement.actualUsageTokens
        chargedTokens = settlement.chargedTokens
        overflowTokens = settlement.overflowTokens
      } else {
        const settlement = settleReserve({
          remainingBeforeSettle: stage.remainingBeforeSettle,
          reserve: stage.reserve,
          inputTokens,
          outputTokens,
        })
        actualUsageTokens = settlement.actualUsageTokens
        chargedTokens = settlement.chargedTokens
        overflowTokens = settlement.overflowTokens
      }
      reservedTokens = stage.reserve
      if (inputTokens + outputTokens > 0) {
        usage = { inputTokens, outputTokens }
      }
    }

    // C2 lifecycle: started child must be in childRunIds and detached once.
    if (stage.observedStarted && childRunId !== undefined) {
      if (!this.childRunIds.includes(childRunId)) {
        this.childRunIds.push(childRunId)
      }
      if (stage.handle && !stage.detached) {
        try {
          await stage.handle.detach({
            status: 'error',
            error: structured.message.slice(0, 512),
          })
        } catch {
          // detach once best-effort
        }
        stage.detached = true
      }
    }

    const result: RecursiveModelResult = {
      schema: 'helix.recursive-model-result/v1',
      status: 'failed',
      text: '',
      textTruncated: false,
      childRunId: childRunId === undefined ? null : childRunId,
      usage,
      responseRef: null,
      reservation: reservationFromDeclared(declared, {
        reservedTokens,
        actualUsageTokens,
        chargedTokens,
        overflowTokens,
      }),
      requestDigest: prepared.requestDigest,
      error: {
        code: 'RECURSIVE_MODEL_INTERNAL',
        message: structured.message.slice(0, 512),
      },
    }
    this.recordSettlement({
      ...(childRunId === undefined ? {} : { childRunId }),
      reservedTokens,
      declaredPromptTokens: declared.declaredPromptTokens,
      declaredCompletionTokens: declared.declaredCompletionTokens,
      requestedCompletionTokens: declared.requestedCompletionTokens,
      actualUsageTokens,
      chargedTokens,
      overflowTokens,
      status: 'failed',
      requestDigest: prepared.requestDigest,
    })
    return {
      result,
      modelEffect: modelEffectFromResult(result, requestEcho),
    }
  }

  private async handleFactorioEffect(
    frame: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ result: Record<string, unknown>; effect: FactorioEffect }> {
    if (this.hostEffectOccupied) {
      throw Object.assign(new Error('one external effect per cell'), {
        code: 'MULTIPLE_EFFECTS_IN_CELL',
        stateCertainty: 'unchanged' as const,
      })
    }
    const method = frame['method']
    if (method !== 'reset' && method !== 'step') {
      throw Object.assign(new Error(`unknown Factorio effect: ${String(method)}`), {
        code: 'UNKNOWN_EFFECT',
      })
    }
    if (method === 'reset' && this.resetCount !== 0) {
      throw Object.assign(new Error('factorio.reset() may succeed only once per run'), {
        code: 'DUPLICATE_RESET',
      })
    }
    if (method === 'step' && this.resetCount !== 1) {
      throw Object.assign(new Error('call factorio.reset() before factorio.step()'), {
        code: 'EPISODE_NOT_RESET',
      })
    }
    const params = asRecord(frame['params'])
    const program = method === 'step' ? String(params['program'] ?? '') : undefined
    const inputStateRef = this.stateRef
    const stepIndex = method === 'reset' ? 0 : this.stepCount + 1
    const commandId = `${this.episodeId}:command:${this.commandOrdinal++}`
    const bridgeResult = await this.bridgeRequest(
      method,
      commandId,
      {
        ...(program === undefined ? {} : { program }),
        ...(method === 'step' && this.stateRaw !== undefined
          ? { stateRaw: this.stateRaw }
          : {}),
      },
      signal,
    )
    // Bridge admission succeeded → occupy host effect slot
    this.hostEffectOccupied = true
    this.effectCount += 1

    const preview = boundedObservation(bridgeResult.observation)
    const observationRef = await putJsonObject(
      this.objectStore,
      bridgeResult.observation,
      'fle.observation',
      'fle.observation/v1',
      preview,
    )
    let parsedState: unknown = bridgeResult.stateRaw
    try {
      parsedState = JSON.parse(bridgeResult.stateRaw)
    } catch {
      // FLE owns the state codec; an opaque string is still content-addressed.
    }
    const outputStateRef = await putJsonObject(
      this.objectStore,
      parsedState,
      'fle.game-state',
      'fle.game-state/v1',
    )
    const programRef =
      program === undefined
        ? undefined
        : await putTextObject(
            this.objectStore,
            program,
            'fle.action-program',
            'fle.action-program/v1',
          )
    this.stateRaw = bridgeResult.stateRaw
    this.stateRef = outputStateRef
    if (method === 'reset') this.resetCount += 1
    else this.stepCount += 1
    const info = asRecord(bridgeResult.info)
    const gameInfo = asRecord(bridgeResult.observation['game_info'])
    const effect: FactorioEffect = {
      method,
      episodeId: this.episodeId,
      stepIndex,
      commandId,
      ...(programRef === undefined ? {} : { programRef }),
      ...(inputStateRef === undefined ? {} : { inputStateRef }),
      observationRef,
      outputStateRef,
      actionCapabilities: bridgeResult.actionCapabilities,
      observation: preview,
      reward: numeric(bridgeResult.reward),
      terminated: bridgeResult.terminated === true,
      truncated: bridgeResult.truncated === true,
      verification: bridgeResult.verification,
      metrics: {
        stepSeconds: numeric(bridgeResult.stepSeconds),
        tick: numeric(gameInfo['tick']),
        productionScore: numeric(info['production_score']),
        automatedProductionScore: numeric(info['automated_production_score']),
        actionHadError: info['error_occurred'] === true,
      },
    }
    return {
      effect,
      result: {
        observation: preview,
        refs: { observation: observationRef, state: outputStateRef },
        metrics: {
          reward: effect.reward,
          terminated: effect.terminated,
          truncated: effect.truncated,
          verification: effect.verification,
          ...effect.metrics,
        },
      },
    }
  }

  async execute(input: ExecuteCellInput, signal?: AbortSignal): Promise<CellExecutionRecord> {
    const contractError = (code: string, message: string): CellExecutionRecord => ({
      schema: 'helix.cell-execution/v2',
      cellId: input.cellId,
      source: input.code,
      sourceDigest: digest(input.code),
      startRevision: input.expectedKernelRevision,
      endRevision: input.expectedKernelRevision,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      error: { code, message, stateCertainty: 'unchanged' },
    })
    const episodeRevision = this.resetCount + this.stepCount
    if (input.expectedEpisodeRevision !== episodeRevision) {
      return contractError(
        'STALE_EPISODE_REVISION',
        `expected episode revision ${input.expectedEpisodeRevision}, current ${episodeRevision}`,
      )
    }
    if (input.pinsDigest !== digest(this.pins)) {
      return contractError('PINS_DIGEST_MISMATCH', 'execute_cell pins do not match this run')
    }

    // Reset Host effect gate per cell (I2)
    this.hostEffectOccupied = false

    const kernel = this.ensureKernel()
    const sessionBootstrap = this.sessionAsync?.bootstrapPayload()
    kernel.send({
      protocolVersion: '2',
      type: 'execute',
      code: input.code,
      expectedRevision: input.expectedKernelRevision,
      bootstrap: {
        task: {
          id: this.pins.taskId,
          acceptance: 'task_verification.success=true',
        },
        runtime: {
          runId: this.runId,
          episodeId: this.episodeId,
          pins: this.pins,
        },
        capabilities: {
          recursiveModel: {
            enabled: this.recursiveModelEnabled,
            remainingCalls: Math.max(
              0,
              this.maxRecursiveCalls - this.budgetPool.recursiveCallCount,
            ),
            remainingTokens: this.budgetPool.remainingTokens,
            maxCompletionTokens: MAX_RECURSIVE_COMPLETION_TOKENS,
          },
          ...(sessionBootstrap
            ? { sessionAsync: sessionBootstrap['sessionAsync'] }
            : {}),
        },
        ...(sessionBootstrap
          ? { session: sessionBootstrap['session'] }
          : {}),
      },
    })
    let factorioEffect: FactorioEffect | undefined
    let modelEffect: ModelEffect | undefined
    let sessionEffect: SessionEffect | undefined
    let agentEffect: AgentEffect | undefined
    let mailboxEffect: MailboxEffect | undefined
    const cellSchema = this.sessionAsync
      ? CELL_EXECUTION_SCHEMA
      : ('helix.cell-execution/v2' as const)
    let effectError:
      | (Error & {
          code?: string
          stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
        })
      | undefined
    const anyWriteEffect = () =>
      Boolean(factorioEffect || modelEffect || sessionEffect || agentEffect || mailboxEffect)
    for (;;) {
      let frame: Record<string, unknown>
      try {
        frame = await kernel.receive({
          timeoutMs: KERNEL_CELL_TIMEOUT_MS,
          code: 'KERNEL_TIMEOUT',
          stateCertainty: anyWriteEffect() ? 'confirmed' : 'unchanged',
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        const structured = error as Error & {
          code?: string
          stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
        }
        const managed: ObjectRef[] = []
        if (factorioEffect) {
          if (factorioEffect.programRef) managed.push(factorioEffect.programRef)
          managed.push(factorioEffect.observationRef, factorioEffect.outputStateRef)
        }
        if (modelEffect?.responseRef) managed.push(modelEffect.responseRef)
        return {
          schema: cellSchema,
          cellId: input.cellId,
          source: input.code,
          sourceDigest: digest(input.code),
          startRevision: input.expectedKernelRevision,
          endRevision: input.expectedKernelRevision,
          status: 'error',
          stdoutPreview: '',
          stderrPreview: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          namespace: [],
          managedObjects: managed,
          ...(factorioEffect === undefined ? {} : { factorioEffect }),
          ...(modelEffect === undefined ? {} : { modelEffect }),
          ...(sessionEffect === undefined ? {} : { sessionEffect }),
          ...(agentEffect === undefined ? {} : { agentEffect }),
          ...(mailboxEffect === undefined ? {} : { mailboxEffect }),
          error: {
            code: structured.code ?? 'KERNEL_RESOURCE_EXHAUSTED',
            message: structured.message,
            stateCertainty: anyWriteEffect()
              ? 'confirmed'
              : (structured.stateCertainty ?? 'unchanged'),
          },
        }
      }
      if (frame['type'] === 'effect_request') {
        if (frame['protocolVersion'] !== '2') {
          kernel.send({
            type: 'effect_response',
            ok: false,
            error: {
              code: 'KERNEL_PROTOCOL_INVALID',
              message: `expected protocolVersion "2", got ${String(frame['protocolVersion'])}`,
            },
          })
          continue
        }
        const method = frame['method']
        if (method === 'models.call') {
          try {
            const handled = await this.handleModelsCall(frame, input.cellId, signal)
            // Last models.call wins modelEffect (second call is rejected result).
            modelEffect = handled.modelEffect
            kernel.send({
              type: 'effect_response',
              ok: true,
              result: resultToWire(handled.result),
            })
          } catch (error) {
            // Last-ditch safety net: handleModelsCall should already catch
            // post-prepare failures with digest. If something still escapes,
            // re-run prepare from the frame so I4 partition is preserved when
            // param/canonical already succeeded.
            const params = asRecord(frame['params'])
            const admissionInput = Object.prototype.hasOwnProperty.call(params, 'input')
              ? params['input']
              : undefined
            const prepared = prepareRecursiveAdmission({
              instructions: params['instructions'],
              input: admissionInput,
              maxOutputTokens: params['maxOutputTokens'],
              remainingTokens: this.budgetPool.remainingTokens,
              model: this.pins.model,
            })
            if (prepared.ok) {
              const stage: ModelsCallStage = this.activeModelsCallStage ?? {
                committed: false,
                reserve: 0,
                remainingBeforeSettle: 0,
                observedStarted: false,
                invokedLlm: false,
                settled: false,
                detached: false,
              }
              const handled = await this.buildInternalFailureFromPrepared(
                prepared,
                admissionInput,
                error,
                stage,
              )
              modelEffect = handled.modelEffect
              kernel.send({
                type: 'effect_response',
                ok: true,
                result: resultToWire(handled.result),
              })
            } else {
              const structured = error instanceof Error ? error : new Error(String(error))
              const result = buildRejectedResult({
                code: 'RECURSIVE_MODEL_INTERNAL',
                message: structured.message.slice(0, 512),
                reservation: emptyReservation(),
              })
              modelEffect = modelEffectFromResult(result)
              kernel.send({
                type: 'effect_response',
                ok: true,
                result: resultToWire(result),
              })
            }
          }
          continue
        }
        if (
          typeof method === 'string' &&
          (method.startsWith('session.') ||
            method.startsWith('agents.') ||
            method.startsWith('mailbox.'))
        ) {
          if (!this.sessionAsync) {
            kernel.send({
              type: 'effect_response',
              ok: true,
              result: {
                status: 'rejected',
                error: {
                  code: 'SESSION_ASYNC_NOT_ENABLED',
                  message: 'session async capability is not enabled',
                },
              },
            })
            continue
          }
          const params = asRecord(frame['params'])
          const handleCtx: {
            hostEffectOccupied: boolean
            occupy: () => void
            parentRunId: string
            signal?: AbortSignal
          } = {
            hostEffectOccupied: this.hostEffectOccupied,
            occupy: () => {
              this.hostEffectOccupied = true
              this.effectCount += 1
            },
            parentRunId: this.runId,
          }
          if (signal) handleCtx.signal = signal
          const handled = await this.sessionAsync.handle(method, params, handleCtx)
          if (!handled.ok) {
            kernel.send({
              type: 'effect_response',
              ok: false,
              error: { code: handled.code, message: handled.message },
            })
            continue
          }
          if (handled.sessionEffect) sessionEffect = handled.sessionEffect
          if (handled.agentEffect) agentEffect = handled.agentEffect
          if (handled.mailboxEffect) mailboxEffect = handled.mailboxEffect
          // Merge agent child run ids into executor list
          for (const id of this.sessionAsync.agentChildRunIds) {
            if (!this.childRunIds.includes(id)) this.childRunIds.push(id)
          }
          kernel.send({
            type: 'effect_response',
            ok: true,
            result: handled.result,
          })
          continue
        }
        // factorio reset/step
        try {
          const handled = await this.handleFactorioEffect(frame, signal)
          factorioEffect = handled.effect
          kernel.send({ type: 'effect_response', ok: true, result: handled.result })
        } catch (error) {
          const structured = error as Error & {
            code?: string
            stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
          }
          effectError = structured
          kernel.send({
            type: 'effect_response',
            ok: false,
            error: {
              code: structured.code ?? 'FLE_EXECUTION_ERROR',
              message: structured.message,
              stateCertainty: structured.stateCertainty ?? 'unchanged',
            },
          })
        }
        continue
      }
      if (frame['type'] !== 'execute_result') {
        throw new Error(`unexpected kernel frame: ${JSON.stringify(frame).slice(0, 500)}`)
      }
      const error = asRecord(frame['error'])
      const managed: ObjectRef[] = []
      if (factorioEffect) {
        if (factorioEffect.programRef) managed.push(factorioEffect.programRef)
        managed.push(factorioEffect.observationRef, factorioEffect.outputStateRef)
      }
      if (modelEffect?.responseRef) managed.push(modelEffect.responseRef)

      // Cell-level error when modelEffect is failed/cancelled (not rejected)
      const modelFailed =
        modelEffect !== undefined &&
        (modelEffect.status === 'failed' || modelEffect.status === 'cancelled')
      const cellOk =
        frame['ok'] === true && effectError === undefined && !modelFailed

      const record: CellExecutionRecord = {
        schema: cellSchema,
        cellId: input.cellId,
        source: input.code,
        sourceDigest: digest(input.code),
        startRevision: numeric(frame['startRevision']),
        endRevision: numeric(frame['endRevision']),
        status: cellOk ? 'success' : 'error',
        stdoutPreview: String(frame['stdout'] ?? ''),
        stderrPreview: String(frame['stderr'] ?? ''),
        stdoutTruncated: frame['stdoutTruncated'] === true,
        stderrTruncated: frame['stderrTruncated'] === true,
        namespace: Array.isArray(frame['namespace'])
          ? (frame['namespace'] as CellExecutionRecord['namespace'])
          : [],
        managedObjects: managed,
        ...(factorioEffect === undefined ? {} : { factorioEffect }),
        ...(modelEffect === undefined ? {} : { modelEffect }),
        ...(sessionEffect === undefined ? {} : { sessionEffect }),
        ...(agentEffect === undefined ? {} : { agentEffect }),
        ...(mailboxEffect === undefined ? {} : { mailboxEffect }),
        ...(cellOk
          ? {}
          : {
              error: {
                code:
                  modelEffect?.error?.code ??
                  effectError?.code ??
                  String(error['code'] ?? 'CELL_EXECUTION_ERROR'),
                ...(error['type'] === undefined
                  ? {}
                  : { type: String(error['type']) }),
                message:
                  modelEffect?.error?.message ??
                  effectError?.message ??
                  String(error['message'] ?? 'cell execution failed'),
                stateCertainty: effectError?.stateCertainty ?? 'unchanged',
              },
            }),
      }
      return record
    }
  }

  async close(): Promise<void> {
    await this.sessionAsync?.drain()
    await this.kernel?.close({ type: 'close', protocolVersion: '2' })
    await this.bridge?.close({
      protocolVersion: '2',
      id: `${this.runId}:bridge:close`,
      method: 'close',
      params: {},
    })
  }
}

export type { ExecuteCellInput }
