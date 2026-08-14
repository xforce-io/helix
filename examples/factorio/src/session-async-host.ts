/**
 * Host-side session / agents / mailbox effect handlers (Issue #7).
 * Owned by LiveCellExecutor; serial boundary = single-threaded Host.
 */
import type { IOInvocationControl, ModelRequest, IIOPort } from 'milkie'

import {
  agentEffectFromHandle,
  applySpawnReserve,
  clampReceiveTimeoutMs,
  clampWaitTimeoutMs,
  decideSpawnReserve,
  errorBody,
  handleViewToWire,
  mailboxEffectRecord,
  prepareSpawnAdmission,
  projectSessionAsyncCapability,
  refundSpawnReserve,
  rejectedHandleView,
  sessionEffectFromView,
  sessionViewToWire,
  type SessionAsyncErrorCode,
  validateCheckpointParams,
  validateSessionCreateParams,
  validateSessionResumeParams,
} from './session-async.js'
import {
  MAX_HANDLES,
  MAX_HANDLES_PER_SESSION,
  MAX_SPAWN_COMPLETION_TOKENS,
  SESSION_CONTROL_MAILBOX_ID,
  WAIT_MAX_TIMEOUT_MS,
} from './session-async-constants.js'
import {
  CHILD_DEFAULT_PERMISSIONS,
  PARENT_PERMISSIONS,
  SessionCapabilityRegistry,
  type BoundActor,
  type SessionActor,
  type SessionCapability,
  handleIdFromActor,
  mailboxIdForHandle,
} from './session-capability.js'
import {
  SessionStore,
  handleRecordToView,
  mailboxMatrixAllows,
  materializeSessionView,
  resolveMailboxTarget,
  type HandleRecord,
  type HandleView,
  type SessionView,
} from './session-store.js'
import type {
  AgentEffect,
  MailboxEffect,
  SessionAsyncCapability,
  SessionEffect,
} from './types.js'
import type { FrozenHarnessSlice, HarnessPinsV1 } from '../../../src/harness/index.js'
/** Same shape as live-executor ChildPortFactory (avoid circular import). */
export type SessionChildPortFactory = (args: {
  childRunId: string
  parentRunId: string
  episodeId: string
  goal: string
  /** Non-secret attach/input payload — never a capability token. */
  input: string
  agentId: string
  /** Optional inherited frozen harness identity (Issue #10 child slice). */
  frozenHarness?: FrozenHarnessSlice
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
}) => Promise<{
  port: IIOPort
  attached: boolean
  detach: (payload: {
    status: 'completed' | 'interrupted' | 'error'
    lastTextOutput?: string
    error?: string
  }) => Promise<void>
}>

export interface SessionAsyncHostOptions {
  enabled?: boolean
  principalId?: string
  sessionTokenPool?: number
  capabilityRegistry?: SessionCapabilityRegistry
  sessionStore?: SessionStore
  /** Durable root for SessionStore when sessionStore not injected. */
  sessionStoreRoot?: string
  control?: IOInvocationControl
  /**
   * Real child-run factory (same shape as #5 models.call).
   * Production default path uses this — not an instant mock.
   */
  childPortFactory?: SessionChildPortFactory
  /** Model pin used when invoking child LLM via childPortFactory. */
  model?: string
  /**
   * Test seam: barrier that holds child terminal until released.
   * spawn returns before barrier release (M1).
   */
  childBarrier?: {
    wait: () => Promise<void>
    /** optional immediate schedule hook after spawn commit */
    onSpawned?: (handleId: string) => void
  }
  /**
   * Test seam override: when set, bypasses childPortFactory.
   * Production path MUST inject childPortFactory instead.
   */
  childRunner?: (args: {
    handleId: string
    childRunId: string
    instructions: string
    signal?: AbortSignal
  }) => Promise<{
    status: 'completed' | 'failed' | 'cancelled'
    preview?: string
    resultRef?: string | null
    error?: { code: string; message: string } | null
    actualUsageTokens?: number
    /** optional mailbox send from child after work */
    controlMessage?: unknown
  }>
  now?: () => number
}

export type SessionAsyncHandleResult =
  | {
      ok: true
      result: Record<string, unknown>
      occupied: boolean
      sessionEffect?: SessionEffect
      agentEffect?: AgentEffect
      mailboxEffect?: MailboxEffect
      /** business error embedded in result (still ok:true wire) */
      businessError?: { code: string; message: string }
    }
  | {
      ok: false
      code: string
      message: string
    }

interface BoundRunContext {
  actor: SessionActor
  sessionId: string | null
  sessionCapability: SessionCapability | undefined
  sessionToken: string | undefined
  handleId: string | undefined
}

interface OpenHandleReserve {
  handleId: string
  reserve: number
  remainingBeforeSettle: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens: number
}

/**
 * Session-async Host facade used by LiveCellExecutor.
 */
export class SessionAsyncHost {
  readonly enabled: boolean
  readonly principalId: string
  readonly capabilities: SessionCapabilityRegistry
  readonly store: SessionStore
  private control: IOInvocationControl | undefined
  private sessionPoolRemaining: number
  private readonly sessionPoolInitial: number
  private bound: BoundRunContext
  private creationToken: string | undefined
  private readonly openReserves = new Map<string, OpenHandleReserve>()
  private readonly terminalWaiters = new Map<
    string,
    Array<(handle: HandleRecord) => void>
  >()
  private readonly childBarrier: SessionAsyncHostOptions['childBarrier']
  /** Optional unit-test override; production uses childPortFactory. */
  private readonly childRunner: SessionAsyncHostOptions['childRunner']
  private childPortFactory: SessionChildPortFactory | undefined
  private readonly model: string
  private parentRunId: string | undefined
  private readonly now: () => number
  /** background child tasks */
  private readonly inflight = new Map<string, Promise<void>>()
  /** Observed started child run ids from agents.spawn */
  readonly agentChildRunIds: string[] = []
  /**
   * Host-private child capability tokens keyed by childRunId.
   * Never serialized into attach input, LLM request bodies, or evidence.
   */
  private readonly childCapabilityByRunId = new Map<string, string>()

  constructor(options: SessionAsyncHostOptions = {}) {
    this.enabled = options.enabled === true
    this.principalId = options.principalId ?? 'principal-default'
    this.capabilities = options.capabilityRegistry ?? new SessionCapabilityRegistry()
    this.sessionPoolInitial = options.sessionTokenPool ?? 16_384
    this.store =
      options.sessionStore ??
      new SessionStore({
        ...(options.now ? { now: options.now } : {}),
        ...(options.sessionStoreRoot
          ? { rootDir: options.sessionStoreRoot }
          : {}),
        defaultPoolInitial: this.sessionPoolInitial,
      })
    this.control = options.control
    this.sessionPoolRemaining = this.sessionPoolInitial
    this.childBarrier = options.childBarrier
    this.childRunner = options.childRunner
    this.childPortFactory = options.childPortFactory
    this.model = options.model ?? 'session-async-child'
    this.now = options.now ?? (() => Date.now())
    this.bound = {
      actor: 'none',
      sessionId: null,
      sessionCapability: undefined,
      sessionToken: undefined,
      handleId: undefined,
    }

    if (this.enabled) {
      const created = this.capabilities.issueCreationCapability(this.principalId)
      this.creationToken = created.token
    }
  }

  /** Wire parent run id for child attach parentId lineage. */
  setParentRunId(runId: string): void {
    this.parentRunId = runId
  }
  setChildPortFactory(factory: SessionChildPortFactory | undefined): void {
    this.childPortFactory = factory
  }

  setControl(control: IOInvocationControl | undefined): void {
    this.control = control
  }

  getCreationToken(): string | undefined {
    return this.creationToken
  }

  getBoundSessionId(): string | null {
    return this.bound.sessionId
  }

  getBoundSessionToken(): string | undefined {
    return this.bound.sessionToken
  }

  getBoundActor(): SessionActor {
    return this.bound.actor
  }

  getSessionPoolRemaining(): number {
    return this.sessionPoolRemaining
  }

  getSessionPoolInitial(): number {
    return this.sessionPoolInitial
  }

  /**
   * Bind this Host run as parent with optional existing session.
   */
  bindParent(args?: {
    sessionId?: string | null
    sessionToken?: string
  }): void {
    this.bound = {
      actor: 'parent',
      sessionId: args?.sessionId ?? this.bound.sessionId,
      sessionCapability: args?.sessionToken
        ? this.capabilities.resolve(args.sessionToken)?.kind === 'session_bound'
          ? (this.capabilities.resolve(args.sessionToken) as SessionCapability)
          : undefined
        : this.bound.sessionCapability,
      sessionToken: args?.sessionToken ?? this.bound.sessionToken,
      handleId: undefined,
    }
  }

  /**
   * Bind Host as a child actor (for child Kernel bootstrap simulation / tests).
   */
  bindChild(args: {
    sessionId: string
    handleId: string
    sessionToken: string
  }): void {
    const cap = this.capabilities.validateSessionBound(args.sessionToken, {
      principalId: this.principalId,
      sessionId: args.sessionId,
    })
    this.bound = {
      actor: `handle:${args.handleId}`,
      sessionId: args.sessionId,
      sessionCapability: cap,
      sessionToken: args.sessionToken,
      handleId: args.handleId,
    }
  }

  /**
   * Execute Host operations as a previously spawned child actor.
   * Uses Host-private childCapabilityByRunId — never requires token in trace.
   */
  async runAsChild<T>(
    childRunId: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const token = this.childCapabilityByRunId.get(childRunId)
    if (!token) {
      throw new Error(`no Host-private child capability for ${childRunId}`)
    }
    const sessionId = this.bound.sessionId
    if (!sessionId) throw new Error('parent session not bound')
    const live = this.store.getLive(sessionId)
    let handleId: string | undefined
    if (live) {
      for (const h of live.handles.values()) {
        if (h.childRunId === childRunId) {
          handleId = h.handleId
          break
        }
      }
    }
    if (!handleId) throw new Error(`handle not found for childRunId ${childRunId}`)
    const previous = { ...this.bound }
    try {
      this.bindChild({
        sessionId,
        handleId,
        sessionToken: token,
      })
      return await fn()
    } finally {
      this.bound = previous
    }
  }

  /** Test/integration seam: whether a child capability was issued (not the token). */
  hasChildCapability(childRunId: string): boolean {
    return this.childCapabilityByRunId.has(childRunId)
  }

  clearBinding(): void {
    this.bound = {
      actor: 'none',
      sessionId: null,
      sessionCapability: undefined,
      sessionToken: undefined,
      handleId: undefined,
    }
  }

  capabilityProjection(): SessionAsyncCapability {
    const sessionId = this.bound.sessionId
    return projectSessionAsyncCapability({
      enabled: this.enabled,
      sessionId,
      sessionVersion: sessionId
        ? (this.store.latestCommittedVersion(sessionId) ?? null)
        : null,
      remainingActiveHandleSlots: this.store.remainingActiveSlots(sessionId),
      remainingHistoricalHandleSlots: this.store.remainingHistoricalSlots(sessionId),
    })
  }

  bootstrapPayload(): Record<string, unknown> {
    const cap = this.capabilityProjection()
    const session: Record<string, unknown> = {
      creationToken: this.creationToken ?? null,
      sessionToken: this.bound.sessionToken ?? null,
      sessionId: this.bound.sessionId,
      actor: this.bound.actor,
      handleId: this.bound.handleId ?? null,
    }
    return {
      sessionAsync: cap,
      session,
    }
  }

  evidenceSlice(): {
    session?: {
      id: string
      version: number
      projectionHash: string
      cutoffCausalSeq: number
    }
    sessionMergeEvents: SessionStore['mergeEvents']
    sessionMergeCommits: SessionStore['mergeCommits']
    sessionBudgetSettlements: SessionStore['budgetSettlements']
    agentChildRunIds: string[]
  } {
    const sessionId = this.bound.sessionId
    const committed = sessionId ? this.store.getCommitted(sessionId) : undefined
    return {
      ...(committed && sessionId
        ? {
            session: {
              id: sessionId,
              version: committed.sessionVersion,
              projectionHash: committed.projectionHash,
              cutoffCausalSeq: committed.cutoffCausalSeq,
            },
          }
        : {}),
      sessionMergeEvents: [...this.store.mergeEvents],
      sessionMergeCommits: [...this.store.mergeCommits],
      sessionBudgetSettlements: [...this.store.budgetSettlements],
      agentChildRunIds: [...this.agentChildRunIds],
    }
  }

  /**
   * Dispatch a session/agents/mailbox method.
   * `hostEffectOccupied` is read/written via callbacks so LiveCellExecutor remains authority.
   */
  async handle(
    method: string,
    params: Record<string, unknown>,
    ctx: {
      hostEffectOccupied: boolean
      occupy: () => void
      parentRunId: string
      signal?: AbortSignal
    },
  ): Promise<SessionAsyncHandleResult> {
    if (!this.enabled) {
      return this.bizReject('SESSION_ASYNC_NOT_ENABLED')
    }

    switch (method) {
      case 'session.create':
        return this.handleSessionCreate(params, ctx)
      case 'session.resume':
        return this.handleSessionResume(params, ctx)
      case 'session.checkpoint':
        return this.handleSessionCheckpoint(params, ctx)
      case 'session.lookup':
        return this.handleSessionLookup(params)
      case 'agents.spawn':
        return this.handleAgentsSpawn(params, ctx)
      case 'agents.wait':
        return this.handleAgentsWait(params, ctx)
      case 'agents.poll':
        return this.handleAgentsPoll(params)
      case 'mailbox.send':
        return this.handleMailboxSend(params, ctx)
      case 'mailbox.receive':
        return this.handleMailboxReceive(params, ctx)
      case 'mailbox.peek':
        return this.handleMailboxPeek(params)
      default:
        return {
          ok: false,
          code: 'UNKNOWN_METHOD',
          message: `unknown method ${method}`,
        }
    }
  }

  // ---------- session.* ----------

  private handleSessionCreate(
    params: Record<string, unknown>,
    ctx: { hostEffectOccupied: boolean; occupy: () => void },
  ): SessionAsyncHandleResult {
    const parsed = validateSessionCreateParams(params)
    if (!parsed.ok) return this.bizReject(parsed.code, parsed.message)

    const creation = this.capabilities.validateCreation(
      parsed.capabilityToken,
      this.principalId,
      this.now(),
    )
    if (!creation) return this.bizReject('SESSION_AUTH_DENIED')

    if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')

    const created = this.store.create({
      principalId: this.principalId,
      ...(parsed.metadataLabel === undefined ? {} : { metadataLabel: parsed.metadataLabel }),
    })
    const issued = this.capabilities.issueSessionCapability({
      sessionId: created.sessionId,
      principalId: this.principalId,
      permissions: PARENT_PERMISSIONS,
      boundActor: 'parent',
      now: this.now(),
    })
    this.bound = {
      actor: 'parent',
      sessionId: created.sessionId,
      sessionCapability: issued.record,
      sessionToken: issued.token,
      handleId: undefined,
    }
    ctx.occupy()

    const view: SessionView = {
      ...created.view,
      session_capability_token: issued.token,
    }
    return {
      ok: true,
      result: sessionViewToWire(view),
      occupied: true,
      sessionEffect: sessionEffectFromView('session.create', view),
    }
  }

  private handleSessionResume(
    params: Record<string, unknown>,
    ctx: { hostEffectOccupied: boolean; occupy: () => void },
  ): SessionAsyncHandleResult {
    const parsed = validateSessionResumeParams(params)
    if (!parsed.ok) return this.bizReject(parsed.code, parsed.message)

    // Auth first — never reveal existence
    const cap = this.capabilities.validateSessionBound(parsed.capabilityToken, {
      principalId: this.principalId,
      sessionId: parsed.sessionId,
      permission: 'resume',
      now: this.now(),
    })
    if (!cap) return this.bizReject('SESSION_AUTH_DENIED')
    // Also require ownership match
    const owner = this.store.ownerOf(parsed.sessionId)
    if (owner !== this.principalId) return this.bizReject('SESSION_AUTH_DENIED')

    if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')

    const resumed = this.store.resume({
      sessionId: parsed.sessionId,
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
    })
    if (!resumed.ok) return this.bizReject(resumed.code)

    // Restore session budget pool + open reserves from committed projection
    const poolRem = this.store.getPoolRemaining(parsed.sessionId)
    if (poolRem !== undefined) {
      this.sessionPoolRemaining = poolRem
    }
    this.openReserves.clear()
    const live = this.store.getLive(parsed.sessionId)
    if (live) {
      for (const [, r] of live.openReserves) {
        this.openReserves.set(r.handleId, { ...r })
      }
    }

    this.bound = {
      actor: 'parent',
      sessionId: parsed.sessionId,
      sessionCapability: cap,
      sessionToken: parsed.capabilityToken,
      handleId: undefined,
    }
    ctx.occupy()

    return {
      ok: true,
      result: sessionViewToWire(resumed.view),
      occupied: true,
      sessionEffect: sessionEffectFromView('session.resume', resumed.view),
    }
  }

  private handleSessionCheckpoint(
    params: Record<string, unknown>,
    ctx: { hostEffectOccupied: boolean; occupy: () => void },
  ): SessionAsyncHandleResult {
    const parsed = validateCheckpointParams(params)
    if (!parsed.ok) return this.bizReject(parsed.code, parsed.message)

    const sessionId = this.bound.sessionId
    if (!sessionId || !this.bound.sessionCapability) {
      return this.bizReject('SESSION_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('checkpoint')) {
      return this.bizReject('SESSION_AUTH_DENIED')
    }
    if (this.bound.actor !== 'parent') {
      return this.bizReject('SESSION_AUTH_DENIED')
    }
    if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')

    // Ensure live budget book matches host before commit
    this.store.setPoolRemaining(sessionId, this.sessionPoolRemaining)

    const result = this.store.checkpoint({
      sessionId,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    })
    if (!result.ok) return this.bizReject('SESSION_AUTH_DENIED')

    ctx.occupy()
    return {
      ok: true,
      result: sessionViewToWire(result.view),
      occupied: true,
      sessionEffect: sessionEffectFromView(
        'session.checkpoint',
        result.view,
        result.noop,
      ),
    }
  }

  private handleSessionLookup(
    params: Record<string, unknown>,
  ): SessionAsyncHandleResult {
    const sessionId =
      typeof params['sessionId'] === 'string' && params['sessionId'].length > 0
        ? params['sessionId']
        : this.bound.sessionId
    const token =
      typeof params['capabilityToken'] === 'string'
        ? params['capabilityToken']
        : this.bound.sessionToken

    if (!sessionId || !token) return this.bizReject('SESSION_AUTH_DENIED')

    const cap = this.capabilities.validateSessionBound(token, {
      principalId: this.principalId,
      sessionId,
      permission: 'lookup',
      now: this.now(),
    })
    if (!cap) return this.bizReject('SESSION_AUTH_DENIED')
    if (this.store.ownerOf(sessionId) !== this.principalId) {
      return this.bizReject('SESSION_AUTH_DENIED')
    }

    const state = this.store.getLive(sessionId)
    const committed = this.store.getCommitted(sessionId)
    if (!state || !committed) return this.bizReject('SESSION_AUTH_DENIED')

    const actor = this.capabilities.actorFromCapability(cap)
    const view = materializeSessionView({
      state,
      actor,
      committedVersion: committed.sessionVersion,
      committedProjectionHash: committed.projectionHash,
      committedCutoff: committed.cutoffCausalSeq,
    })
    // lookup does not occupy
    return { ok: true, result: sessionViewToWire(view), occupied: false }
  }

  // ---------- agents.* ----------

  private handleAgentsSpawn(
    params: Record<string, unknown>,
    ctx: {
      hostEffectOccupied: boolean
      occupy: () => void
      parentRunId: string
      signal?: AbortSignal
    },
  ): SessionAsyncHandleResult {
    // auth
    if (!this.bound.sessionId || !this.bound.sessionCapability) {
      return this.bizReject('AGENT_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('spawn')) {
      return this.bizReject('AGENT_AUTH_DENIED')
    }
    // ignore forged actor fields
    void params['actor']
    void params['handleId']
    void params['principalId']

    const prepared = prepareSpawnAdmission({
      instructions: params['instructions'],
      input: Object.prototype.hasOwnProperty.call(params, 'input')
        ? params['input']
        : undefined,
      maxOutputTokens:
        params['maxOutputTokens'] ?? params['max_output_tokens'],
      mailbox: params['mailbox'],
      remainingTokens: this.sessionPoolRemaining,
    })
    if (!prepared.ok) return this.bizReject(prepared.code, prepared.message)

    if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')

    // live remaining budget decision
    const reserveDecision = decideSpawnReserve({
      instructionsByteLength: prepared.instructionsBytes.byteLength,
      inputByteLength: prepared.inputByteLength,
      maxOutputTokens: prepared.maxOutputTokens,
      remainingTokens: this.sessionPoolRemaining,
    })
    if (!reserveDecision.ok) {
      return this.bizReject('AGENT_BUDGET_INSUFFICIENT')
    }
    const declared = reserveDecision.declared

    const sessionId = this.bound.sessionId
    // pre-check limits (spawnHandle also checks)
    if (this.store.activeHandleCount(sessionId) >= MAX_HANDLES) {
      return this.bizReject('AGENT_ACTIVE_HANDLE_LIMIT')
    }
    if (this.store.historicalHandleCount(sessionId) >= MAX_HANDLES_PER_SESSION) {
      return this.bizReject('AGENT_HISTORICAL_HANDLE_LIMIT')
    }

    // atomic: occupy + reserve + allocate handle
    this.sessionPoolRemaining = applySpawnReserve(
      this.sessionPoolRemaining,
      declared.reserve,
    )
    this.store.setPoolRemaining(sessionId, this.sessionPoolRemaining)
    ctx.occupy()
    this.parentRunId = ctx.parentRunId

    const spawned = this.store.spawnHandle({
      sessionId,
      parentRunId: ctx.parentRunId,
      mailbox: prepared.mailbox,
      reserve: declared.reserve,
      declaredPromptTokens: declared.declaredPromptTokens,
      declaredCompletionTokens: declared.declaredCompletionTokens,
      requestedCompletionTokens: declared.requestedCompletionTokens,
      preview: '',
    })
    if (!spawned.ok) {
      // rollback reserve (should be rare after pre-check)
      const refund = refundSpawnReserve(
        this.sessionPoolRemaining,
        declared.reserve,
      )
      this.sessionPoolRemaining = refund.remainingAfter
      this.store.setPoolRemaining(sessionId, this.sessionPoolRemaining)
      const code =
        spawned.code === 'SESSION_NOT_FOUND'
          ? 'AGENT_AUTH_DENIED'
          : spawned.code
      return this.bizReject(code)
    }

    const handle = spawned.handle
    const openReserve = {
      handleId: handle.handleId,
      reserve: declared.reserve,
      remainingBeforeSettle: this.sessionPoolRemaining,
      declaredPromptTokens: declared.declaredPromptTokens,
      declaredCompletionTokens: declared.declaredCompletionTokens,
      requestedCompletionTokens: declared.requestedCompletionTokens,
    }
    this.openReserves.set(handle.handleId, openReserve)
    this.store.setOpenReserve(sessionId, openReserve)

    // Issue child capability (no lookup). Token stays Host-private.
    const childCap = this.capabilities.issueSessionCapability({
      sessionId,
      principalId: this.principalId,
      permissions: CHILD_DEFAULT_PERMISSIONS,
      boundActor: { handleId: handle.handleId },
      now: this.now(),
    })
    if (handle.childRunId) {
      this.childCapabilityByRunId.set(handle.childRunId, childCap.token)
    }

    // Schedule async child — does NOT block return
    const childArgs: {
      handle: HandleRecord
      instructions: string
      signal?: AbortSignal
    } = {
      handle,
      instructions: prepared.instructions,
    }
    if (ctx.signal) childArgs.signal = ctx.signal
    const childPromise = this.runChild(childArgs)
    this.inflight.set(handle.handleId, childPromise)

    this.childBarrier?.onSpawned?.(handle.handleId)

    const view = handleRecordToView(handle)
    return {
      ok: true,
      result: handleViewToWire(view),
      occupied: true,
      agentEffect: agentEffectFromHandle('agents.spawn', handle, {
        requestDigest: prepared.requestDigest,
        reservation: {
          reservedTokens: declared.reserve,
          declaredPromptTokens: declared.declaredPromptTokens,
          declaredCompletionTokens: declared.declaredCompletionTokens,
          requestedCompletionTokens: declared.requestedCompletionTokens,
          actualUsageTokens: 0,
          chargedTokens: 0,
          overflowTokens: 0,
        },
      }),
    }
  }

  private async runChild(args: {
    handle: HandleRecord
    instructions: string
    signal?: AbortSignal
  }): Promise<void> {
    const { handle } = args
    const sessionId = this.bound.sessionId
    if (!sessionId) return

    // mark running + observe started
    this.store.markHandleRunning(sessionId, handle.handleId)
    if (handle.childRunId && !this.agentChildRunIds.includes(handle.childRunId)) {
      this.agentChildRunIds.push(handle.childRunId)
    }

    try {
      if (this.childBarrier) {
        await this.childBarrier.wait()
      }
      if (args.signal?.aborted || this.control?.signal?.aborted) {
        this.finalizeHandle(sessionId, handle.handleId, {
          status: 'cancelled',
          error: { code: 'AGENT_SPAWN_FAILED', message: 'cancelled' },
          actualUsageTokens: 0,
        })
        return
      }

      const childSignal = args.signal ?? this.control?.signal
      const outcome = await this.executeChildWork({
        handle,
        instructions: args.instructions,
        ...(childSignal ? { signal: childSignal } : {}),
      })

      if (outcome.controlMessage !== undefined) {
        // child send to session.control (authorized by matrix)
        this.store.enqueue({
          sessionId,
          mailboxId: SESSION_CONTROL_MAILBOX_ID,
          from: handle.handleId,
          payload: outcome.controlMessage,
        })
      }

      const fin: {
        status: 'completed' | 'failed' | 'cancelled'
        preview?: string
        resultRef?: string | null
        error?: { code: string; message: string } | null
        actualUsageTokens?: number
      } = {
        status: outcome.status,
        resultRef: outcome.resultRef ?? null,
        error: outcome.error ?? null,
        actualUsageTokens: outcome.actualUsageTokens ?? 0,
      }
      if (outcome.preview !== undefined) fin.preview = outcome.preview
      this.finalizeHandle(sessionId, handle.handleId, fin)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'child failed'
      this.finalizeHandle(sessionId, handle.handleId, {
        status: 'failed',
        error: { code: 'AGENT_SPAWN_FAILED', message: message.slice(0, 512) },
        actualUsageTokens: 0,
      })
    } finally {
      this.inflight.delete(handle.handleId)
    }
  }

  /**
   * Production path: childPortFactory → attach(parentId) → invokeLLM → detach.
   * Unit seam: optional childRunner override (still goes through finalizeHandle).
   * Child capability tokens never enter attach input or LLM request bodies.
   */
  private async executeChildWork(args: {
    handle: HandleRecord
    instructions: string
    signal?: AbortSignal
  }): Promise<{
    status: 'completed' | 'failed' | 'cancelled'
    preview?: string
    resultRef?: string | null
    error?: { code: string; message: string } | null
    actualUsageTokens?: number
    controlMessage?: unknown
  }> {
    // Explicit test override
    if (this.childRunner) {
      return this.childRunner({
        handleId: args.handle.handleId,
        childRunId: args.handle.childRunId ?? '',
        instructions: args.instructions,
        ...(args.signal ? { signal: args.signal } : {}),
      })
    }

    if (!this.childPortFactory) {
      // Fail closed — production must inject factory; no silent instant mock.
      return {
        status: 'failed',
        error: {
          code: 'AGENT_SPAWN_FAILED',
          message: 'childPortFactory is not configured',
        },
        actualUsageTokens: 0,
      }
    }

    const childRunId = args.handle.childRunId ?? `${this.parentRunId ?? 'run'}:agent:0`
    const parentRunId = this.parentRunId ?? 'parent'
    const sessionId = this.bound.sessionId
    const childToken =
      this.childCapabilityByRunId.get(childRunId) ??
      (args.handle.childRunId
        ? this.childCapabilityByRunId.get(args.handle.childRunId)
        : undefined)
    // Non-secret attach input — digest of child identity, never the token.
    const attachInput = `session-agent:${args.handle.handleId}:${childRunId}`
    let handlePort:
      | {
          port: IIOPort
          attached: boolean
          detach: (payload: {
            status: 'completed' | 'interrupted' | 'error'
            lastTextOutput?: string
            error?: string
          }) => Promise<void>
        }
      | undefined

    try {
      handlePort = await this.childPortFactory({
        childRunId,
        parentRunId,
        episodeId: `${parentRunId}:episode:0`,
        goal: args.instructions.slice(0, 512),
        input: attachInput,
        agentId: 'helix.factorio.session-agent',
        ...(sessionId && childToken
          ? {
              sessionBootstrap: {
                sessionId,
                handleId: args.handle.handleId,
                capabilityToken: childToken,
              },
            }
          : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'attach failed'
      return {
        status: 'failed',
        error: {
          code: 'AGENT_SPAWN_FAILED',
          message: message.slice(0, 512),
        },
        actualUsageTokens: 0,
      }
    }

    if (!handlePort.attached) {
      return {
        status: 'failed',
        error: {
          code: 'AGENT_SPAWN_FAILED',
          message: 'child run attach never started',
        },
        actualUsageTokens: 0,
      }
    }

    // Observed started → lineage id for evidence
    if (!this.agentChildRunIds.includes(childRunId)) {
      this.agentChildRunIds.push(childRunId)
    }

    // Host-private child actor bind for any in-process child-side Host ops.
    // Must not permanently overwrite parent binding.
    const previousBound = { ...this.bound }
    if (sessionId && childToken) {
      this.bindChild({
        sessionId,
        handleId: args.handle.handleId,
        sessionToken: childToken,
      })
      // Restore parent immediately — child identity stays in childCapabilityByRunId
      // and is re-applied via runAsChild() when Host executes child-authenticated ops.
      this.bound = previousBound
    }

    const request: ModelRequest = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: args.instructions }],
        },
      ],
      maxTokens: Math.min(MAX_SPAWN_COMPLETION_TOKENS, 512),
      metadata: {
        parentRunId,
        childRunId,
        handleId: args.handle.handleId,
        sessionAgent: true,
      },
    }

    const childControl: IOInvocationControl = {
      ...(this.control?.deadlineAt === undefined
        ? {}
        : { deadlineAt: this.control.deadlineAt }),
      ...(args.signal
        ? { signal: args.signal }
        : this.control?.signal
          ? { signal: this.control.signal }
          : {}),
    }

    try {
      const response = await handlePort.port.invokeLLM(request, {
        control: childControl,
      })
      const inputTokens = response.usage?.inputTokens ?? 0
      const outputTokens = response.usage?.outputTokens ?? 0
      const textParts =
        response.content
          ?.filter(
            (c): c is { type: 'text'; text: string } =>
              c !== null &&
              typeof c === 'object' &&
              (c as { type?: string }).type === 'text' &&
              typeof (c as { text?: unknown }).text === 'string',
          )
          .map(c => c.text) ?? []
      const preview = textParts.join('').slice(0, 512)
      try {
        await handlePort.detach({
          status: 'completed',
          lastTextOutput: preview,
        })
      } catch {
        // detach best-effort
      }
      return {
        status: 'completed',
        preview: preview || 'child-done',
        actualUsageTokens: inputTokens + outputTokens,
        controlMessage: {
          fromChild: args.handle.handleId,
          note: 'child-completed',
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'child invoke failed'
      const cancelled =
        args.signal?.aborted === true ||
        this.control?.signal?.aborted === true ||
        /cancel/i.test(message)
      try {
        await handlePort.detach({
          status: cancelled ? 'interrupted' : 'error',
          error: message.slice(0, 512),
        })
      } catch {
        // detach best-effort
      }
      return {
        status: cancelled ? 'cancelled' : 'failed',
        error: {
          code: 'AGENT_SPAWN_FAILED',
          message: message.slice(0, 512),
        },
        actualUsageTokens: 0,
      }
    }
  }

  private finalizeHandle(
    sessionId: string,
    handleId: string,
    outcome: {
      status: 'completed' | 'failed' | 'cancelled'
      preview?: string
      resultRef?: string | null
      error?: { code: string; message: string } | null
      actualUsageTokens?: number
    },
  ): void {
    // Settlement is durable on handle.terminal domain event via completeHandle.
    // Host mirrors pool/openReserves from store after apply so resume is consistent.
    const result = this.store.completeHandle({
      sessionId,
      handleId,
      status: outcome.status,
      ...(outcome.preview === undefined ? {} : { preview: outcome.preview }),
      ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      actualUsageTokens: outcome.actualUsageTokens ?? 0,
    })

    this.openReserves.delete(handleId)
    const poolRem = this.store.getPoolRemaining(sessionId)
    if (poolRem !== undefined) {
      this.sessionPoolRemaining = poolRem
    }

    if (result.ok) {
      const waiters = this.terminalWaiters.get(handleId) ?? []
      this.terminalWaiters.delete(handleId)
      for (const w of waiters) w(result.handle)
    }
  }

  private async handleAgentsWait(
    params: Record<string, unknown>,
    ctx: {
      hostEffectOccupied: boolean
      occupy: () => void
      signal?: AbortSignal
    },
  ): Promise<SessionAsyncHandleResult> {
    const handleId = params['handleId'] ?? params['handle_id']
    if (typeof handleId !== 'string' || handleId.length === 0) {
      return this.bizReject('AGENT_PARAM_INVALID', 'handleId is required')
    }

    if (!this.bound.sessionId || !this.bound.sessionCapability) {
      return this.bizReject('AGENT_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('wait')) {
      return this.bizReject('AGENT_AUTH_DENIED')
    }
    // child may only wait self
    if (this.bound.actor !== 'parent') {
      const self = handleIdFromActor(this.bound.actor)
      if (self !== handleId) return this.bizReject('AGENT_AUTH_DENIED')
    }

    const handle = this.store.getHandle(this.bound.sessionId, handleId)
    if (!handle) return this.bizReject('AGENT_NOT_FOUND')

    if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')

    // Entering blocking path occupies immediately
    ctx.occupy()
    const timeoutMs = clampWaitTimeoutMs(
      params['timeout_ms'] ?? params['timeoutMs'],
    )

    const terminal = await this.waitForTerminal(
      this.bound.sessionId,
      handleId,
      timeoutMs,
      ctx.signal,
    )

    if (!terminal) {
      const view = handleRecordToView(
        this.store.getHandle(this.bound.sessionId, handleId) ?? handle,
      )
      const timed: HandleView = {
        ...view,
        error: errorBody('AGENT_WAIT_TIMEOUT'),
      }
      return {
        ok: true,
        result: handleViewToWire(timed),
        occupied: true,
        agentEffect: agentEffectFromHandle('agents.wait', timed, {
          error: errorBody('AGENT_WAIT_TIMEOUT'),
        }),
        businessError: errorBody('AGENT_WAIT_TIMEOUT'),
      }
    }

    const view = handleRecordToView(terminal)
    return {
      ok: true,
      result: handleViewToWire(view),
      occupied: true,
      agentEffect: agentEffectFromHandle('agents.wait', terminal),
    }
  }

  private waitForTerminal(
    sessionId: string,
    handleId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HandleRecord | null> {
    const current = this.store.getHandle(sessionId, handleId)
    if (current && ['completed', 'failed', 'cancelled', 'rejected'].includes(current.status)) {
      return Promise.resolve(current)
    }

    return new Promise(resolve => {
      let settled = false
      const finish = (value: HandleRecord | null) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }

      const onTerminal = (h: HandleRecord) => finish(h)
      const list = this.terminalWaiters.get(handleId) ?? []
      list.push(onTerminal)
      this.terminalWaiters.set(handleId, list)

      const timer =
        timeoutMs <= 0
          ? undefined
          : setTimeout(() => finish(null), Math.min(timeoutMs, WAIT_MAX_TIMEOUT_MS))

      const onAbort = () => finish(null)
      if (signal) {
        if (signal.aborted) {
          finish(null)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (this.control?.signal) {
        if (this.control.signal.aborted) {
          finish(null)
          return
        }
        this.control.signal.addEventListener('abort', onAbort, { once: true })
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        const waiters = this.terminalWaiters.get(handleId)
        if (waiters) {
          const next = waiters.filter(w => w !== onTerminal)
          if (next.length === 0) this.terminalWaiters.delete(handleId)
          else this.terminalWaiters.set(handleId, next)
        }
        signal?.removeEventListener('abort', onAbort)
        this.control?.signal?.removeEventListener('abort', onAbort)
      }

      // re-check after registration (race)
      const again = this.store.getHandle(sessionId, handleId)
      if (again && ['completed', 'failed', 'cancelled', 'rejected'].includes(again.status)) {
        finish(again)
      }
    })
  }

  private handleAgentsPoll(
    params: Record<string, unknown>,
  ): SessionAsyncHandleResult {
    const handleId = params['handleId'] ?? params['handle_id']
    if (typeof handleId !== 'string' || handleId.length === 0) {
      return this.bizReject('AGENT_PARAM_INVALID', 'handleId is required')
    }
    if (!this.bound.sessionId || !this.bound.sessionCapability) {
      return this.bizReject('AGENT_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('poll')) {
      return this.bizReject('AGENT_AUTH_DENIED')
    }
    if (this.bound.actor !== 'parent') {
      const self = handleIdFromActor(this.bound.actor)
      if (self !== handleId) return this.bizReject('AGENT_AUTH_DENIED')
    }
    const handle = this.store.getHandle(this.bound.sessionId, handleId)
    if (!handle) return this.bizReject('AGENT_NOT_FOUND')
    return {
      ok: true,
      result: handleViewToWire(handleRecordToView(handle)),
      occupied: false,
    }
  }

  // ---------- mailbox.* ----------

  private handleMailboxSend(
    params: Record<string, unknown>,
    ctx: { hostEffectOccupied: boolean; occupy: () => void },
  ): SessionAsyncHandleResult {
    if (!this.bound.sessionId || !this.bound.sessionCapability) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('mailbox.send')) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }
    // ignore forged from/actor
    void params['from']
    void params['actor']

    if (!Object.prototype.hasOwnProperty.call(params, 'payload')) {
      return this.bizReject('MAILBOX_PARAM_INVALID', 'payload is required')
    }

    const sendTargetArgs: {
      actor: SessionActor
      to?: string
      toHandleId?: string
      defaultForActor: 'control'
    } = {
      actor: this.bound.actor,
      defaultForActor: 'control',
    }
    if (typeof params['to'] === 'string') sendTargetArgs.to = params['to']
    if (typeof params['to_handle_id'] === 'string') {
      sendTargetArgs.toHandleId = params['to_handle_id']
    } else if (typeof params['toHandleId'] === 'string') {
      sendTargetArgs.toHandleId = params['toHandleId']
    }
    const target = resolveMailboxTarget(sendTargetArgs)
    if (!target.ok) return this.bizReject(target.code)

    // Auth matrix first
    if (!mailboxMatrixAllows(this.bound.actor, 'send', target.mailboxId)) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }

    if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')

    const from =
      this.bound.actor === 'parent'
        ? 'parent'
        : (handleIdFromActor(this.bound.actor) ?? 'parent')

    const enqueued = this.store.enqueue({
      sessionId: this.bound.sessionId,
      mailboxId: target.mailboxId,
      from,
      payload: params['payload'],
    })
    if (!enqueued.ok) {
      // full / too large / not found — no occupy
      const code =
        enqueued.code === 'SESSION_NOT_FOUND' ? 'MAILBOX_AUTH_DENIED' : enqueued.code
      return this.bizReject(code)
    }

    ctx.occupy()
    return {
      ok: true,
      result: {
        msg_id: enqueued.msgId,
        msg_seq: enqueued.msgSeq,
        mailbox_id: enqueued.mailboxId,
        payload_hash: enqueued.payloadHash,
        payload_ref: enqueued.payloadRef,
      },
      occupied: true,
      mailboxEffect: mailboxEffectRecord('mailbox.send', {
        mailboxId: enqueued.mailboxId,
        msgId: enqueued.msgId,
        msgSeq: enqueued.msgSeq,
        payloadHash: enqueued.payloadHash,
        causalSeq: enqueued.causalSeq,
      }),
    }
  }

  private async handleMailboxReceive(
    params: Record<string, unknown>,
    ctx: {
      hostEffectOccupied: boolean
      occupy: () => void
      signal?: AbortSignal
    },
  ): Promise<SessionAsyncHandleResult> {
    if (!this.bound.sessionId || !this.bound.sessionCapability) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('mailbox.receive')) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }

    const recvTargetArgs: {
      actor: SessionActor
      mailboxId?: string
      defaultForActor: 'control' | 'self'
    } = {
      actor: this.bound.actor,
      defaultForActor: this.bound.actor === 'parent' ? 'control' : 'self',
    }
    if (typeof params['mailbox_id'] === 'string') {
      recvTargetArgs.mailboxId = params['mailbox_id']
    } else if (typeof params['mailboxId'] === 'string') {
      recvTargetArgs.mailboxId = params['mailboxId']
    }
    const target = resolveMailboxTarget(recvTargetArgs)
    if (!target.ok) return this.bizReject(target.code)

    if (!mailboxMatrixAllows(this.bound.actor, 'receive', target.mailboxId)) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }

    const timeoutMs = clampReceiveTimeoutMs(
      params['timeout_ms'] ?? params['timeoutMs'],
    )

    const mapMbErr = (code: string): SessionAsyncErrorCode =>
      code === 'SESSION_NOT_FOUND'
        ? 'MAILBOX_AUTH_DENIED'
        : (code as SessionAsyncErrorCode)

    if (timeoutMs > 0) {
      if (ctx.hostEffectOccupied) return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')
      ctx.occupy()
      const deadline = this.now() + timeoutMs
      while (this.now() < deadline) {
        if (ctx.signal?.aborted || this.control?.signal?.aborted) break
        const got = this.store.consume({
          sessionId: this.bound.sessionId,
          mailboxId: target.mailboxId,
          now: this.now(),
        })
        if (!got.ok) return this.bizReject(mapMbErr(got.code))
        if (got.consumed && got.message) {
          const effectFields: Omit<MailboxEffect, 'method'> = {
            mailboxId: target.mailboxId,
            msgId: got.message.msg_id,
            msgSeq: got.message.msg_seq,
            payloadHash: got.message.payload_hash,
            consumed: true,
          }
          if (got.causalSeq !== undefined) effectFields.causalSeq = got.causalSeq
          return {
            ok: true,
            result: { ...got.message },
            occupied: true,
            mailboxEffect: mailboxEffectRecord('mailbox.receive', effectFields),
          }
        }
        await sleep(20)
      }
      return {
        ok: true,
        result: { message: null, error: errorBody('MAILBOX_RECEIVE_TIMEOUT') },
        occupied: true,
        mailboxEffect: mailboxEffectRecord('mailbox.receive', {
          mailboxId: target.mailboxId,
          consumed: false,
        }),
        businessError: errorBody('MAILBOX_RECEIVE_TIMEOUT'),
      }
    }

    if (ctx.hostEffectOccupied) {
      const peek = this.store.peek({
        sessionId: this.bound.sessionId,
        mailboxId: target.mailboxId,
        now: this.now(),
      })
      if (!peek.ok) return this.bizReject(mapMbErr(peek.code))
      if (peek.message) {
        return this.bizReject('MULTIPLE_EFFECTS_IN_CELL')
      }
      return { ok: true, result: { message: null }, occupied: false }
    }

    const got = this.store.consume({
      sessionId: this.bound.sessionId,
      mailboxId: target.mailboxId,
      now: this.now(),
    })
    if (!got.ok) return this.bizReject(mapMbErr(got.code))
    if (!got.consumed || !got.message) {
      return { ok: true, result: { message: null }, occupied: false }
    }
    ctx.occupy()
    const effectFields: Omit<MailboxEffect, 'method'> = {
      mailboxId: target.mailboxId,
      msgId: got.message.msg_id,
      msgSeq: got.message.msg_seq,
      payloadHash: got.message.payload_hash,
      consumed: true,
    }
    if (got.causalSeq !== undefined) effectFields.causalSeq = got.causalSeq
    return {
      ok: true,
      result: { ...got.message },
      occupied: true,
      mailboxEffect: mailboxEffectRecord('mailbox.receive', effectFields),
    }
  }

  private handleMailboxPeek(
    params: Record<string, unknown>,
  ): SessionAsyncHandleResult {
    if (!this.bound.sessionId || !this.bound.sessionCapability) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }
    if (!this.bound.sessionCapability.permissions.includes('mailbox.peek')) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }
    const peekTargetArgs: {
      actor: SessionActor
      mailboxId?: string
      defaultForActor: 'control' | 'self'
    } = {
      actor: this.bound.actor,
      defaultForActor: this.bound.actor === 'parent' ? 'control' : 'self',
    }
    if (typeof params['mailbox_id'] === 'string') {
      peekTargetArgs.mailboxId = params['mailbox_id']
    } else if (typeof params['mailboxId'] === 'string') {
      peekTargetArgs.mailboxId = params['mailboxId']
    }
    const target = resolveMailboxTarget(peekTargetArgs)
    if (!target.ok) return this.bizReject(target.code)
    if (!mailboxMatrixAllows(this.bound.actor, 'peek', target.mailboxId)) {
      return this.bizReject('MAILBOX_AUTH_DENIED')
    }
    const got = this.store.peek({
      sessionId: this.bound.sessionId,
      mailboxId: target.mailboxId,
      now: this.now(),
    })
    if (!got.ok) {
      const code =
        got.code === 'SESSION_NOT_FOUND' ? 'MAILBOX_AUTH_DENIED' : got.code
      return this.bizReject(code)
    }
    return {
      ok: true,
      result: got.message ? { ...got.message } : { message: null },
      occupied: false,
    }
  }

  private bizReject(
    code: SessionAsyncErrorCode,
    message?: string,
  ): SessionAsyncHandleResult {
    const body = errorBody(code, message)
    // For agent-like rejects that need a HandleView shape, callers handle specially.
    // Generic structured reject:
    return {
      ok: true,
      result: {
        status: 'rejected',
        error: body,
      },
      occupied: false,
      businessError: body,
    }
  }

  /** Await all in-flight children (tests / teardown). */
  async drain(timeoutMs = 5_000): Promise<void> {
    const pending = [...this.inflight.values()]
    if (pending.length === 0) return
    await Promise.race([
      Promise.allSettled(pending),
      sleep(timeoutMs),
    ])
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { rejectedHandleView, MAX_SPAWN_COMPLETION_TOKENS }
