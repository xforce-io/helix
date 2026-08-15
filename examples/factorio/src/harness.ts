import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import {
  IOControlError,
  type IOInvocationControl,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from 'milkie'
import { canonicalJson, digest } from './canonical.js'
import {
  DEFAULT_PARENT_RECURSIVE_TOKEN_POOL,
  MAX_RECURSIVE_CALLS_PER_RUN,
  MAX_RECURSIVE_COMPLETION_TOKENS,
  parentTerminationFromRecursive,
} from './recursive-model.js'
import type {
  CellExecutionRecord,
  EpisodeProjection,
  RunBudget,
  RunPins,
  TaskVerification,
  TerminationReason,
} from './types.js'
import type { ExecuteCellInput } from './live-executor.js'
import {
  assertControlPlaneBinding,
  assertFrozenHarnessMatchesPins,
  type FrozenHarnessSlice,
} from '../../../src/harness/index.js'


export const EXECUTE_CELL_TOOL = 'execute_cell'
export const MAX_CELLS = 16
export const MAX_MODEL_CALLS = 16

export interface HarnessOptions {
  runId: string
  episodeId: string
  pins: RunPins
  port: IIOPort
  budget: RunBudget
  control: IOInvocationControl
  execute: (input: ExecuteCellInput, signal?: AbortSignal) => Promise<CellExecutionRecord>
  /**
   * Frozen harness slice from Host select→validate→resolve→freeze (or recorded replay).
   * Required — production runs must not fall back to source prompts.
   */
  frozenHarness: FrozenHarnessSlice
  /**
   * Complete frozen control-plane text from renderControlPlane (§4.5 order):
   * system + task/protocol/termination + catalog docs + agentSpecs + scenario.
   * Injected as the ModelRequest system field. Must be Host-bound for the
   * same frozenHarness identity via controlPlaneContentHash.
   */
  controlPlaneText: string
  /**
   * Host-issued binding hash of controlPlaneText for this frozenHarness.
   * Rejects independent/forged system text even when pins match.
   */
  controlPlaneContentHash: string
  /** Optional overrides for recursive model budget projection. */
  recursiveModel?: {
    enabled?: boolean
    initialTokens?: number
    maxCalls?: number
  }
  /**
   * Live source of truth for remaining recursive tokens / call count.
   * When provided, ContextEnvelope budget fields prefer this over fold approx.
   */
  getRecursiveBudget?: () => {
    remainingTokens: number
    recursiveCallCount: number
  }
}

export interface HarnessResult {
  projection: EpisodeProjection
  modelResponses: ModelResponse[]
  modelOwned: boolean
  feedbackLinked: boolean
  uncertain: boolean
  termination: TerminationReason
  toolCallCount: number
}

function initialProjection(
  runId: string,
  episodeId: string,
  initialRecursiveTokens: number,
): EpisodeProjection {
  return {
    runId,
    episodeId,
    kernelRevision: 0,
    resetCount: 0,
    stepCount: 0,
    modelCallCount: 0,
    recursiveCallCount: 0,
    remainingRecursiveModelTokens: initialRecursiveTokens,
    cells: [],
    verification: { success: false, meta: [] },
    terminated: false,
    truncated: false,
  }
}

function foldRecord(
  projection: EpisodeProjection,
  record: CellExecutionRecord,
): EpisodeProjection {
  const effect = record.factorioEffect
  const modelEffect = record.modelEffect
  let recursiveCallCount = projection.recursiveCallCount
  let remainingRecursiveModelTokens = projection.remainingRecursiveModelTokens
  let recursiveControlTermination = projection.recursiveControlTermination

  if (modelEffect) {
    if (modelEffect.childRunId || modelEffect.status === 'succeeded') {
      recursiveCallCount += 1
    }
    const charged = modelEffect.reservation.chargedTokens
    const reserved = modelEffect.reservation.reservedTokens
    if (
      modelEffect.status === 'succeeded' ||
      modelEffect.status === 'failed' ||
      modelEffect.status === 'cancelled'
    ) {
      if (reserved > 0) {
        remainingRecursiveModelTokens = Math.max(
          0,
          remainingRecursiveModelTokens - charged,
        )
      }
    }
    const control = parentTerminationFromRecursive(
      modelEffect.error?.code as
        | 'RECURSIVE_MODEL_CANCELLED'
        | 'RECURSIVE_MODEL_DEADLINE'
        | undefined,
    )
    if (control) recursiveControlTermination = control
  }

  return {
    ...projection,
    kernelRevision: record.endRevision,
    resetCount: projection.resetCount + (effect?.method === 'reset' ? 1 : 0),
    stepCount: projection.stepCount + (effect?.method === 'step' ? 1 : 0),
    recursiveCallCount,
    remainingRecursiveModelTokens,
    ...(recursiveControlTermination
      ? { recursiveControlTermination }
      : {}),
    cells: [...projection.cells, record],
    ...(effect
      ? {
          lastObservationRef: effect.observationRef,
          lastStateRef: effect.outputStateRef,
          actionCapabilities: effect.actionCapabilities,
          verification: effect.verification,
          terminated: effect.terminated,
          truncated: effect.truncated,
        }
      : {}),
  }
}

function contextEnvelope(
  projection: EpisodeProjection,
  pins: RunPins,
  remainingWallMs: number,
  recursiveEnabled: boolean,
  maxRecursiveCalls: number,
  maxCompletionTokens: number,
  frozenHarness: FrozenHarnessSlice,
  sessionAsync?: {
    enabled: boolean
    maxActiveHandles: number
    remainingActiveHandleSlots: number
    maxHandlesPerSession: number
    remainingHistoricalHandleSlots: number
    maxMailboxDepth: number
    maxMailboxMsgBytes: number
    sessionId: string | null
    sessionVersion: number | null
  },
): Record<string, unknown> {
  const lastCell = projection.cells.at(-1)
  const remainingCalls = Math.max(0, maxRecursiveCalls - projection.recursiveCallCount)
  const schema =
    pins.sessionAsyncVersion === '1' ? 'helix.context/v4' : 'helix.context/v3'
  const taskInstruction = frozenHarness.document.control.taskNarrativeTemplate
  // pins.harnessState is required and equality-gated against frozenHarness
  // before the first model request; Context always records that same slice.
  const harnessSlice = pins.harnessState!
  return {
    schema,
    runtime: {
      runId: projection.runId,
      episodeId: projection.episodeId,
      kernelRevision: projection.kernelRevision,
      pins,
      harness: harnessSlice,
    },
    task: {
      id: pins.taskId,
      instruction: taskInstruction,
      acceptance: 'task_verification.success=true',
      trajectoryLength: 64,
    },
    capabilities: {
      executeCell: {
        tool: EXECUTE_CELL_TOOL,
        persistentNamespace: true,
        maxOneEnvironmentEffect: true,
      },
      recursiveModel: {
        enabled: recursiveEnabled,
        remainingCalls,
        remainingTokens: projection.remainingRecursiveModelTokens,
        maxCompletionTokens,
      },
      ...(sessionAsync ? { sessionAsync } : {}),
      factorioActionCalls: projection.actionCapabilities ?? [],
    },
    episode: {
      resetCount: projection.resetCount,
      stepCount: projection.stepCount,
      verification: projection.verification,
      terminated: projection.terminated,
      truncated: projection.truncated,
      lastObservationRef: refForModel(projection.lastObservationRef),
      lastStateRef: refForModel(projection.lastStateRef),
    },
    lastCell: lastCell
      ? {
          cellId: lastCell.cellId,
          status: lastCell.status,
          sourceDigest: lastCell.sourceDigest,
          error: lastCell.error,
          observationRef: lastCell.factorioEffect?.observationRef.hash,
          stateRef: lastCell.factorioEffect?.outputStateRef.hash,
          modelEffect: lastCell.modelEffect
            ? {
                status: lastCell.modelEffect.status,
                childRunId: lastCell.modelEffect.childRunId,
                textPreview: lastCell.modelEffect.textPreview.slice(0, 512),
                requestDigest: lastCell.modelEffect.requestDigest,
                error: lastCell.modelEffect.error,
              }
            : undefined,
        }
      : null,
    budget: {
      remainingCells: MAX_CELLS - projection.cells.length,
      remainingEnvironmentSteps: 64 - projection.stepCount,
      remainingModelCalls: MAX_MODEL_CALLS - projection.modelCallCount,
      remainingWallMs,
      remainingRecursiveModelCalls: remainingCalls,
      remainingRecursiveModelTokens: projection.remainingRecursiveModelTokens,
      ...(sessionAsync
        ? {
            remainingSessionTokens: projection.remainingSessionTokens ?? 0,
            remainingActiveHandleSlots: sessionAsync.remainingActiveHandleSlots,
            remainingHistoricalHandleSlots:
              sessionAsync.remainingHistoricalHandleSlots,
          }
        : {}),
    },
  }
}

function refForModel(ref: CellExecutionRecord['managedObjects'][number] | undefined) {
  if (!ref) return undefined
  return {
    hash: ref.hash,
    kind: ref.kind,
    schema: ref.schema,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    truncated: ref.truncated,
  }
}

function entityForModel(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const entity = value as Record<string, unknown>
  const fields = [
    'name',
    'prototype',
    'position',
    'direction',
    'status',
    'warnings',
    'drop_position',
    'resources',
    'fuel',
    'inventory',
  ]
  return Object.fromEntries(fields.flatMap(field => (field in entity ? [[field, entity[field]]] : [])))
}

/**
 * The trace retains the full execution record. The model sees only the bounded
 * observation and content-addressed metadata; large values remain in the
 * kernel/object store and are never echoed recursively into later prompts.
 */
function recordForModel(record: CellExecutionRecord): Record<string, unknown> {
  const effect = record.factorioEffect
  const modelEffect = record.modelEffect
  const observation = effect?.observation ?? {}
  const rawText = String(observation['rawText'] ?? '')
  const entities = Array.isArray(observation['entities'])
    ? observation['entities'].slice(0, 24).map(entityForModel)
    : []
  return {
    schema: 'helix.cell-result-for-model/v1',
    cellId: record.cellId,
    sourceDigest: record.sourceDigest,
    startRevision: record.startRevision,
    endRevision: record.endRevision,
    status: record.status,
    stdoutPreview: effect || modelEffect ? undefined : record.stdoutPreview.slice(0, 2_048),
    stderrPreview: record.stderrPreview.slice(0, 2_048),
    error: record.error,
    namespace: record.namespace,
    factorioEffect: effect
      ? {
          method: effect.method,
          stepIndex: effect.stepIndex,
          programRef: refForModel(effect.programRef),
          observationRef: refForModel(effect.observationRef),
          outputStateRef: refForModel(effect.outputStateRef),
          actionCapabilities: effect.actionCapabilities,
          observation: {
            rawText: rawText.slice(0, 4_096),
            rawTextTruncated:
              observation['rawTextTruncated'] === true || rawText.length > 4_096,
            entities,
            entityCount: observation['entityCount'] ?? entities.length,
            inventory: Array.isArray(observation['inventory'])
              ? observation['inventory'].slice(0, 64)
              : [],
            gameInfo: observation['gameInfo'] ?? {},
            taskInfo: observation['taskInfo'] ?? {},
            taskVerification: observation['taskVerification'] ?? {},
            score: observation['score'] ?? 0,
            automatedScore: observation['automatedScore'] ?? 0,
            characterPositions: observation['characterPositions'] ?? [],
          },
          reward: effect.reward,
          terminated: effect.terminated,
          truncated: effect.truncated,
          verification: effect.verification,
          metrics: effect.metrics,
        }
      : undefined,
    modelEffect: modelEffect
      ? {
          method: modelEffect.method,
          status: modelEffect.status,
          childRunId: modelEffect.childRunId,
          requestDigest: modelEffect.requestDigest,
          attachFailed: modelEffect.attachFailed === true ? true : undefined,
          textPreview: modelEffect.textPreview.slice(0, 2_048),
          textTruncated: modelEffect.textTruncated,
          usage: modelEffect.usage,
          responseRef: refForModel(modelEffect.responseRef),
          reservation: modelEffect.reservation,
          error: modelEffect.error,
        }
      : undefined,
  }
}

function renderEnvelope(envelope: Record<string, unknown>): string {
  return `## Helix ContextEnvelope\n\nThe JSON block is the canonical model-visible state for this decision.\n\n\`\`\`json\n${canonicalJson(envelope)}\n\`\`\``
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

function codeFromToolResponse(response: ModelResponse): { id: string; code: string } | undefined {
  if (response.toolCalls.length === 0) return undefined
  if (response.toolCalls.length !== 1) {
    throw new Error(`model returned ${response.toolCalls.length} tool calls; exactly one is allowed`)
  }
  const call = response.toolCalls[0]!
  if (call.name !== EXECUTE_CELL_TOOL) {
    throw new Error(`model called unexpected tool ${call.name}`)
  }
  if (call.invalidArguments) {
    throw new Error(`${call.invalidArguments.code}: ${call.invalidArguments.message}`)
  }
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
    throw new Error('execute_cell input must be an object')
  }
  const code = (call.input as Record<string, unknown>)['code']
  if (typeof code !== 'string' || code.trim() === '') {
    throw new Error('execute_cell.code must be a non-empty string')
  }
  return { id: call.id, code }
}

function verificationFrom(projection: EpisodeProjection): TaskVerification {
  return projection.verification ?? { success: false, meta: [] }
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  if (
    options.frozenHarness === undefined ||
    options.frozenHarness === null ||
    typeof options.controlPlaneText !== 'string' ||
    options.controlPlaneText.length === 0
  ) {
    throw new Error(
      'runHarness requires frozenHarness and non-empty controlPlaneText from Host freeze; source-prompt fallback is forbidden',
    )
  }
  if (options.pins.harnessState === undefined) {
    throw new Error(
      'runHarness requires pins.harnessState from Host freeze; code/protocol pin alone is not a state selection',
    )
  }
  // L2 §10.1 + ship-review: Context/pins/evidence share one frozen slice, and
  // controlPlaneText must be the Host-bound payload for that slice. Gate before
  // any model request so callers cannot pair freeze/pins A with system text B.
  assertControlPlaneBinding({
    frozen: options.frozenHarness,
    pins: options.pins.harnessState,
    controlPlaneText: options.controlPlaneText,
    controlPlaneContentHash: options.controlPlaneContentHash,
    label: 'runHarness.control-plane',
  })
  // Keep explicit pins gate for clearer frozen-vs-pins mismatch diagnostics.
  assertFrozenHarnessMatchesPins(
    options.frozenHarness,
    options.pins.harnessState,
    'runHarness.frozenHarness-vs-pins.harnessState',
  )
  const recursiveEnabled = options.recursiveModel?.enabled !== false
  const initialRecursiveTokens =
    options.recursiveModel?.initialTokens ?? DEFAULT_PARENT_RECURSIVE_TOKEN_POOL
  const maxRecursiveCalls =
    options.recursiveModel?.maxCalls ?? MAX_RECURSIVE_CALLS_PER_RUN
  const systemInstruction = options.controlPlaneText

  let projection = initialProjection(
    options.runId,
    options.episodeId,
    initialRecursiveTokens,
  )
  let priorExchange: Message[] = []
  let retryMessage: Message | undefined
  const modelResponses: ModelResponse[] = []
  let feedbackLinked = true
  let modelOwned = true
  let uncertain = false
  let toolCallCount = 0

  const finish = (termination: TerminationReason): HarnessResult => ({
    projection,
    modelResponses,
    modelOwned,
    feedbackLinked,
    uncertain,
    termination,
    toolCallCount,
  })

  for (let modelOrdinal = 0; modelOrdinal < MAX_MODEL_CALLS; modelOrdinal += 1) {
    if (projection.recursiveControlTermination === 'cancelled') {
      return finish('cancelled')
    }
    if (projection.recursiveControlTermination === 'wall_budget_exhausted') {
      return finish('wall_budget_exhausted')
    }

    const liveBudget = options.getRecursiveBudget?.()
    if (liveBudget) {
      projection = {
        ...projection,
        remainingRecursiveModelTokens: liveBudget.remainingTokens,
        recursiveCallCount: liveBudget.recursiveCallCount,
      }
    }

    const remainingWallMs = Math.max(0, options.budget.deadlineAt - options.port.now())
    const envelope = contextEnvelope(
      projection,
      options.pins,
      remainingWallMs,
      recursiveEnabled,
      maxRecursiveCalls,
      MAX_RECURSIVE_COMPLETION_TOKENS,
      options.frozenHarness,
    )
    const envelopeText = renderEnvelope(envelope)
    const messages = [
      ...priorExchange,
      ...(retryMessage ? [retryMessage] : []),
      textMessage('user', envelopeText),
    ]
    if (projection.cells.length > 0) {
      const priorCellId = projection.cells.at(-1)!.cellId
      feedbackLinked =
        feedbackLinked &&
        messages.some(
          message =>
            message.role === 'tool' &&
            message.content.some(
              content =>
                content.type === 'tool_result' && content.content.includes(priorCellId),
            ),
        )
    }

    const request: ModelRequest = {
      model: options.pins.model,
      system: systemInstruction,
      messages: [...messages],
      tools: [
        {
          name: EXECUTE_CELL_TOOL,
          description: 'Execute one Python cell in the persistent Helix IPython session.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'The complete Python source for the next persistent cell.',
              },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { type: 'any' },
      temperature: 0,
      maxTokens: 8_096,
      metadata: {
        runId: options.runId,
        renderer: options.pins.renderer,
        contextEnvelopeDigest: digest(envelope),
        pinsDigest: digest(options.pins),
        modelOrdinal,
        harnessContentHash: options.frozenHarness.harnessContentHash,
      },
    }
    let response: ModelResponse
    try {
      response = await options.port.invokeLLM(request, { control: options.control })
    } catch (error) {
      projection = { ...projection, modelCallCount: projection.modelCallCount + 1 }
      if (error instanceof IOControlError) {
        return finish(error.code === 'IO_CANCELLED' ? 'cancelled' : 'wall_budget_exhausted')
      }
      throw error
    }
    modelResponses.push(response)
    projection = { ...projection, modelCallCount: projection.modelCallCount + 1 }

    const authored = codeFromToolResponse(response)
    if (!authored) {
      retryMessage = textMessage(
        'user',
        'The previous response submitted no cell. Call execute_cell now; prose does not change the environment.',
      )
      continue
    }
    retryMessage = undefined
    const cellInput: ExecuteCellInput = {
      cellId: `${options.runId}:cell:${projection.cells.length}`,
      code: authored.code,
      expectedKernelRevision: projection.kernelRevision,
      expectedEpisodeRevision: projection.resetCount + projection.stepCount,
      pinsDigest: digest(options.pins),
    }
    let output: unknown
    toolCallCount += 1
    try {
      output = await options.port.invokeTool(
        'helix.kernel.execute_cell',
        cellInput,
        signal => options.execute(cellInput, signal),
        { toolCallId: authored.id, control: options.control },
      )
    } catch (error) {
      if (error instanceof IOControlError) {
        uncertain = error.code === 'IO_DEADLINE_EXCEEDED'
        return finish(error.code === 'IO_CANCELLED' ? 'cancelled' : 'uncertain_effect')
      }
      throw error
    }
    const record = output as CellExecutionRecord
    modelOwned =
      modelOwned &&
      record.cellId === cellInput.cellId &&
      record.sourceDigest === digest(authored.code)
    projection = foldRecord(projection, record)
    uncertain = uncertain || record.error?.stateCertainty === 'uncertain'
    priorExchange = [
      { role: 'assistant', content: response.content },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            tool_use_id: authored.id,
            content: canonicalJson(recordForModel(record)),
            is_error: record.status === 'error',
          },
        ],
      },
    ]

    if (projection.recursiveControlTermination === 'cancelled') {
      return finish('cancelled')
    }
    if (projection.recursiveControlTermination === 'wall_budget_exhausted') {
      return finish('wall_budget_exhausted')
    }

    if (`${record.error?.code ?? ''} ${record.error?.message ?? ''}`.includes('POLICY_VIOLATION')) {
      return finish('policy_violation')
    }
    if (record.error?.stateCertainty === 'uncertain') return finish('uncertain_effect')
    if (
      record.error?.code === 'KERNEL_TIMEOUT' ||
      record.error?.code === 'KERNEL_RESOURCE_EXHAUSTED'
    ) {
      return finish('kernel_resource_exhausted')
    }
    if (verificationFrom(projection).success) return finish('verifier_succeeded')
    if (projection.truncated) return finish('cell_budget_exhausted')
    if (projection.terminated) return finish('environment_failed')
    if (projection.cells.length >= MAX_CELLS) return finish('cell_budget_exhausted')
  }

  return finish('model_budget_exhausted')
}
