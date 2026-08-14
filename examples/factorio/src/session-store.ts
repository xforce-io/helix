import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import {
  MAILBOX_DEPTH,
  MAILBOX_MSG_TTL_MS,
  MAX_HANDLES,
  MAX_HANDLES_PER_SESSION,
  MAX_IN_FLIGHT_MSGS,
  MAX_MSG_BYTES,
  MAX_PAYLOAD_PREVIEW_BYTES,
  SESSION_CONTROL_MAILBOX_ID,
  SESSION_DOMAIN_EVENT_SCHEMA,
  SESSION_PROJECTION_SCHEMA,
} from './session-async-constants.js'
import type { BoundActor, SessionActor } from './session-capability.js'
import { mailboxIdForHandle } from './session-capability.js'
import {
  appendLedgerLineSync,
  loadAllSessionsSync,
  ledgerPath as ledgerPathFor,
  writeCheckpointAtomicSync,
} from './session-persistence.js'

// ---------- Domain types ----------

export type HandleStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

export type SessionLifecycle = 'active' | 'aborted'

export interface HandleRecord {
  handleId: string
  childRunId: string | null
  status: HandleStatus
  preview: string
  resultRef: string | null
  error: { code: string; message: string } | null
  terminalGeneration: number
  /** ordinal within session for stable ids */
  ordinal: number
  mailboxEnabled: boolean
  reservedTokens: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens: number
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
  settled: boolean
}

export interface MailboxMessageRecord {
  msgId: string
  msgSeq: number
  mailboxId: string
  from: string
  payloadHash: string
  payloadRef: string | null
  preview: string
  /** wall ms for TTL */
  enqueuedAt: number
  /** full payload kept Host-side only; never enters projection */
  payloadCanonical: string
  expired?: boolean
}

export interface MailboxRecord {
  mailboxId: string
  headSeq: number
  tailSeq: number
  /** unconsumed messages in order */
  messages: MailboxMessageRecord[]
}

export interface SessionProjection {
  v: 1
  sessionId: string
  sessionVersion: number
  principalId: string
  handles: Array<{
    handleId: string
    status: HandleStatus
    childRunId: string | null
    terminalGeneration: number
    resultRef: string | null
    errorCode: string | null
    /** Budget ledger fields (cross-run authoritative). */
    reservedTokens: number
    declaredPromptTokens: number
    declaredCompletionTokens: number
    requestedCompletionTokens: number
    actualUsageTokens: number
    chargedTokens: number
    overflowTokens: number
    settled: boolean
  }>
  mailboxes: Array<{
    mailboxId: string
    headSeq: number
    tailSeq: number
    msgs: Array<{
      msgSeq: number
      msgId: string
      payloadHash: string
      from: string
      to: string
    }>
  }>
  memorySummaryRef: string | null
  cutoffCausalSeq: number
  lifecycle: SessionLifecycle
  /** Session token pool remaining after this committed version. */
  poolRemaining: number
  poolInitial: number
  openReserves: PersistedOpenReserve[]
  settlements: SessionBudgetSettlement[]
}

export interface SessionDomainEvent {
  recordType: 'domain'
  causalSeq: number
  mergeKey: string
  kind: 'handle.terminal' | 'mailbox.enqueue' | 'mailbox.consume'
  payloadHash: string
  payloadRef?: string
  handleId?: string
  terminalGeneration?: number
  status?: 'completed' | 'failed' | 'cancelled'
  mailboxId?: string
  msgId?: string
  msgSeq?: number
  recordedAt: number
  /** Host-only full payload for re-apply; stripped from canonical ledger hash */
  _payload?: unknown
  _preview?: string
  _from?: string
  _resultRef?: string | null
  _error?: { code: string; message: string } | null
  _childRunId?: string | null
  /** Terminal budget settlement — durable on ledger tail for resume. */
  _actualUsageTokens?: number
  _chargedTokens?: number
  _overflowTokens?: number
  _reservedTokens?: number
  _poolRemainingAfter?: number
  _declaredPromptTokens?: number
  _declaredCompletionTokens?: number
  _requestedCompletionTokens?: number
}

export interface SessionMergeCommit {
  recordType: 'merge.commit'
  causalSeq: number
  sessionVersion: number
  cutoffCausalSeq: number
  committedMergeKeys: string[]
  projectionHash: string
  dedupeSnapshotHash: string
  recordedAt: number
}

export type SessionLedgerRecord = SessionDomainEvent | SessionMergeCommit

export interface CommittedVersion {
  sessionVersion: number
  projection: SessionProjection
  projectionHash: string
  cutoffCausalSeq: number
  dedupeSnapshot: ReadonlySet<string>
  dedupeSnapshotHash: string
  committedAt: number
  note?: string
  /** Authoritative budget book at this version (cross-run). */
  budget: SessionBudgetSnapshot
}

export interface LiveSessionState {
  sessionId: string
  principalId: string
  /** last committed version number */
  committedVersion: number
  committedProjectionHash: string
  committedCutoff: number
  lifecycle: SessionLifecycle
  handles: Map<string, HandleRecord>
  mailboxes: Map<string, MailboxRecord>
  /** memory of commit-merged keys + live-applied keys (memory only for live) */
  liveDedupe: Set<string>
  committedDedupe: Set<string>
  nextHandleOrdinal: number
  activeHandleCount: number
  memorySummaryRef: string | null
  metadataLabel?: string
  /** Live (uncommitted) budget book — checkpoint persists it. */
  poolInitial: number
  poolRemaining: number
  openReserves: Map<string, PersistedOpenReserve>
  settlements: SessionBudgetSettlement[]
}

export interface HandleView {
  handle_id: string
  child_run_id: string | null
  status: HandleStatus
  preview: string
  result_ref: string | null
  error: { code: string; message: string } | null
  terminal_generation: number
}

export interface MailboxBrief {
  mailbox_id: string
  depth: number
  head_seq: number
  tail_seq: number
  message_hashes: string[]
}

export interface MailboxMessageView {
  msg_id: string
  msg_seq: number
  mailbox_id: string
  from: string
  preview: string
  payload_ref: string | null
  payload_hash: string
}

export interface SessionView {
  session_id: string
  session_version: number
  projection_hash: string
  cutoff_causal_seq: number
  handles: HandleView[]
  mailboxes: MailboxBrief[]
  memory_summary_ref: string | null
  principal_id: string
  lifecycle: SessionLifecycle
  live_applied_merge_keys_count?: number
  session_capability_token?: string
  noop?: boolean
  committed_version?: number
}

export interface SessionBudgetSettlement {
  handleId: string
  reservedTokens: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens: number
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
  status: HandleStatus
}

/** Open spawn reserve tracked across resume (persisted with checkpoint). */
export interface PersistedOpenReserve {
  handleId: string
  reserve: number
  remainingBeforeSettle: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens: number
}

/** Budget book kept with each committed version (cross-run authority). */
export interface SessionBudgetSnapshot {
  poolInitial: number
  poolRemaining: number
  openReserves: PersistedOpenReserve[]
  settlements: SessionBudgetSettlement[]
}

export interface SessionMergeEventEvidence {
  mergeKey: string
  causalSeq: number
  payloadHash: string
  kind: SessionDomainEvent['kind']
  count: 1
}

export interface SessionMergeCommitEvidence {
  sessionVersion: number
  cutoffCausalSeq: number
  committedMergeKeysHash: string
  projectionHash: string
}

// ---------- Pure helpers ----------

export function sha256Hex(bytes: string | Uint8Array): string {
  const h = createHash('sha256')
  if (typeof bytes === 'string') h.update(bytes, 'utf8')
  else h.update(bytes)
  return h.digest('hex')
}

export function handleTerminalMergeKey(handleId: string, terminalGeneration = 1): string {
  return `${handleId}:${terminalGeneration}`
}

export function mailboxConsumeMergeKey(mailboxId: string, msgSeq: number): string {
  return `${mailboxId}:consume:${msgSeq}`
}

export function isTerminalStatus(status: HandleStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'rejected'
  )
}

export function isActiveStatus(status: HandleStatus): boolean {
  return status === 'pending' || status === 'running'
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function truncatePreview(
  text: string,
  maxBytes = MAX_PAYLOAD_PREVIEW_BYTES,
): string {
  if (utf8Bytes(text) <= maxBytes) return text
  let end = Math.min(text.length, maxBytes)
  while (end > 0 && utf8Bytes(text.slice(0, end)) > maxBytes) end -= 1
  return text.slice(0, end)
}

/**
 * Canonical session projection bytes (L2 §7.3).
 * No secrets, no payload bodies, no capability tokens.
 */
export function buildCanonicalProjection(state: {
  sessionId: string
  sessionVersion: number
  principalId: string
  handles: HandleRecord[]
  mailboxes: MailboxRecord[]
  memorySummaryRef: string | null
  cutoffCausalSeq: number
  lifecycle: SessionLifecycle
  poolRemaining: number
  poolInitial: number
  openReserves: PersistedOpenReserve[]
  settlements: SessionBudgetSettlement[]
}): SessionProjection {
  const handles = [...state.handles]
    .sort((a, b) => a.handleId.localeCompare(b.handleId))
    .map(h => ({
      handleId: h.handleId,
      status: h.status,
      childRunId: h.childRunId,
      terminalGeneration: h.terminalGeneration,
      resultRef: h.resultRef,
      errorCode: h.error?.code ?? null,
      reservedTokens: h.reservedTokens,
      declaredPromptTokens: h.declaredPromptTokens,
      declaredCompletionTokens: h.declaredCompletionTokens,
      requestedCompletionTokens: h.requestedCompletionTokens,
      actualUsageTokens: h.actualUsageTokens,
      chargedTokens: h.chargedTokens,
      overflowTokens: h.overflowTokens,
      settled: h.settled,
    }))
  const mailboxes = [...state.mailboxes]
    .sort((a, b) => a.mailboxId.localeCompare(b.mailboxId))
    .map(m => ({
      mailboxId: m.mailboxId,
      headSeq: m.headSeq,
      tailSeq: m.tailSeq,
      msgs: m.messages.map(msg => ({
        msgSeq: msg.msgSeq,
        msgId: msg.msgId,
        payloadHash: msg.payloadHash,
        from: msg.from,
        to: m.mailboxId,
      })),
    }))
  const openReserves = [...state.openReserves].sort((a, b) =>
    a.handleId.localeCompare(b.handleId),
  )
  const settlements = [...state.settlements].sort((a, b) =>
    a.handleId.localeCompare(b.handleId),
  )
  return {
    v: 1,
    sessionId: state.sessionId,
    sessionVersion: state.sessionVersion,
    principalId: state.principalId,
    handles,
    mailboxes,
    memorySummaryRef: state.memorySummaryRef,
    cutoffCausalSeq: state.cutoffCausalSeq,
    lifecycle: state.lifecycle,
    poolRemaining: state.poolRemaining,
    poolInitial: state.poolInitial,
    openReserves,
    settlements,
  }
}

export function projectionHashOf(projection: SessionProjection): string {
  return sha256Hex(canonicalJson(projection))
}

export function dedupeSnapshotHashOf(keys: Iterable<string>): string {
  const sorted = [...keys].sort((a, b) => a.localeCompare(b))
  return sha256Hex(canonicalJson(sorted))
}

export function isCommitMerged(
  mergeKey: string,
  args: {
    dedupeSnapshot: ReadonlySet<string>
    mergeCommits: readonly SessionMergeCommit[]
    asOfVersion: number
  },
): boolean {
  if (args.dedupeSnapshot.has(mergeKey)) return true
  for (const commit of args.mergeCommits) {
    if (commit.sessionVersion <= args.asOfVersion && commit.committedMergeKeys.includes(mergeKey)) {
      return true
    }
  }
  return false
}

export function handleRecordToView(h: HandleRecord): HandleView {
  return {
    handle_id: h.handleId,
    child_run_id: h.childRunId,
    status: h.status,
    preview: h.preview,
    result_ref: h.resultRef,
    error: h.error,
    terminal_generation: h.terminalGeneration,
  }
}

export function mailboxToBrief(m: MailboxRecord): MailboxBrief {
  return {
    mailbox_id: m.mailboxId,
    depth: m.messages.length,
    head_seq: m.headSeq,
    tail_seq: m.tailSeq,
    message_hashes: m.messages.map(msg => msg.payloadHash),
  }
}

/**
 * Actor-filtered SessionView (L2 §4.6.4).
 * Parent sees full; non-parent sees only self handle + h:self mailbox.
 */
export function materializeSessionView(args: {
  state: LiveSessionState
  actor: SessionActor
  committedVersion: number
  committedProjectionHash: string
  committedCutoff: number
}): SessionView {
  const { state, actor } = args
  const isParent = actor === 'parent'
  const selfHandleId = actor.startsWith('handle:') ? actor.slice('handle:'.length) : undefined

  let handles: HandleView[]
  let mailboxes: MailboxBrief[]
  if (isParent) {
    handles = [...state.handles.values()]
      .sort((a, b) => a.handleId.localeCompare(b.handleId))
      .map(handleRecordToView)
    mailboxes = [...state.mailboxes.values()]
      .sort((a, b) => a.mailboxId.localeCompare(b.mailboxId))
      .map(mailboxToBrief)
  } else if (selfHandleId) {
    const self = state.handles.get(selfHandleId)
    handles = self ? [handleRecordToView(self)] : []
    const inbox = state.mailboxes.get(mailboxIdForHandle(selfHandleId))
    mailboxes = inbox ? [mailboxToBrief(inbox)] : []
  } else {
    handles = []
    mailboxes = []
  }

  const liveApplied = Math.max(0, state.liveDedupe.size - state.committedDedupe.size)

  return {
    session_id: state.sessionId,
    session_version: args.committedVersion,
    projection_hash: args.committedProjectionHash,
    cutoff_causal_seq: args.committedCutoff,
    handles,
    mailboxes,
    memory_summary_ref: isParent ? state.memorySummaryRef : null,
    principal_id: state.principalId,
    lifecycle: state.lifecycle,
    ...(isParent ? { live_applied_merge_keys_count: liveApplied } : {}),
  }
}

// ---------- SessionStore ----------

export interface SessionStoreOptions {
  /** Injected clock for tests */
  now?: () => number
  /** Injected id generators */
  newSessionId?: () => string
  newHandleId?: (sessionId: string, ordinal: number) => string
  newMsgId?: () => string
  newChildRunId?: (parentRunId: string, ordinal: number) => string
  /**
   * Durable root directory. When set, ledger appends and checkpoints
   * fsync to disk; a new SessionStore({ rootDir }) reloads all sessions.
   */
  rootDir?: string
  /** Default session token pool for newly created sessions. */
  defaultPoolInitial?: number
}

/**
 * Host SessionStore — memory + optional durable root.
 * Serial boundary is the single-threaded await chain of Host methods —
 * all mutating methods are synchronous critical sections (no await inside).
 * Durability uses sync fsync/rename so the critical section stays sync.
 */
export class SessionStore {
  /** Append-only ledger per session */
  private readonly ledgers = new Map<string, SessionLedgerRecord[]>()
  /** Committed versions per session (version → snapshot) */
  private readonly versions = new Map<string, Map<number, CommittedVersion>>()
  /** Live working state per session (current run observation) */
  private readonly live = new Map<string, LiveSessionState>()
  /** next causal seq per session (next to allocate) */
  private readonly nextCausal = new Map<string, number>()
  /** principal owning each session */
  private readonly owners = new Map<string, string>()

  private readonly now: () => number
  private readonly newSessionId: () => string
  private readonly newHandleId: (sessionId: string, ordinal: number) => string
  private readonly newMsgId: () => string
  readonly newChildRunId: (parentRunId: string, ordinal: number) => string
  /** When set, mutations are durable under this root. */
  readonly rootDir: string | undefined
  private readonly defaultPoolInitial: number

  /** Evidence collectors (cleared only by tests). */
  readonly mergeEvents: SessionMergeEventEvidence[] = []
  readonly mergeCommits: SessionMergeCommitEvidence[] = []
  readonly budgetSettlements: SessionBudgetSettlement[] = []

  constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.newSessionId =
      options.newSessionId ?? (() => `sess_${randomBytes(12).toString('hex')}`)
    this.newHandleId =
      options.newHandleId ??
      ((sessionId, ordinal) => {
        const short = sessionId.replace(/^sess_/, '').slice(0, 8)
        return `h_${short}_${ordinal}`
      })
    this.newMsgId = options.newMsgId ?? (() => `msg_${randomBytes(12).toString('hex')}`)
    this.newChildRunId =
      options.newChildRunId ??
      ((parentRunId, ordinal) => `${parentRunId}:agent:${ordinal}`)
    this.rootDir = options.rootDir
    this.defaultPoolInitial = options.defaultPoolInitial ?? 16_384

    if (this.rootDir) {
      this.hydrateFromDisk(this.rootDir)
    }
  }

  /** Reload every durable session into memory (no live state until resume). */
  private hydrateFromDisk(rootDir: string): void {
    const loaded = loadAllSessionsSync(rootDir)
    for (const [sessionId, data] of loaded) {
      this.owners.set(sessionId, data.principalId)
      this.ledgers.set(sessionId, [...data.ledger])
      this.versions.set(sessionId, new Map(data.versions))
      this.nextCausal.set(sessionId, data.nextCausalSeq)
      // live left empty — callers must resume
    }
  }

  // ----- queries -----

  hasSession(sessionId: string): boolean {
    return this.owners.has(sessionId)
  }

  ownerOf(sessionId: string): string | undefined {
    return this.owners.get(sessionId)
  }

  getLive(sessionId: string): LiveSessionState | undefined {
    return this.live.get(sessionId)
  }

  getLedger(sessionId: string): readonly SessionLedgerRecord[] {
    return this.ledgers.get(sessionId) ?? []
  }

  getCommitted(sessionId: string, version?: number): CommittedVersion | undefined {
    const map = this.versions.get(sessionId)
    if (!map) return undefined
    if (version === undefined) {
      let latest: CommittedVersion | undefined
      for (const v of map.values()) {
        if (!latest || v.sessionVersion > latest.sessionVersion) latest = v
      }
      return latest
    }
    return map.get(version)
  }

  latestCommittedVersion(sessionId: string): number | undefined {
    return this.getCommitted(sessionId)?.sessionVersion
  }

  activeHandleCount(sessionId: string): number {
    return this.live.get(sessionId)?.activeHandleCount ?? 0
  }

  historicalHandleCount(sessionId: string): number {
    return this.live.get(sessionId)?.handles.size ?? 0
  }

  remainingActiveSlots(sessionId: string | null): number {
    if (!sessionId) return MAX_HANDLES
    return Math.max(0, MAX_HANDLES - this.activeHandleCount(sessionId))
  }

  remainingHistoricalSlots(sessionId: string | null): number {
    if (!sessionId) return MAX_HANDLES_PER_SESSION
    return Math.max(0, MAX_HANDLES_PER_SESSION - this.historicalHandleCount(sessionId))
  }

  totalInFlightMessages(sessionId: string): number {
    const state = this.live.get(sessionId)
    if (!state) return 0
    let n = 0
    for (const m of state.mailboxes.values()) n += m.messages.length
    return n
  }

  // ----- create / resume / checkpoint -----

  /**
   * Atomic create: allocate sessionId, empty ledger, V=1 projection.
   * Caller issues session-bound capability after success.
   */
  create(args: {
    principalId: string
    metadataLabel?: string
    poolInitial?: number
  }): {
    sessionId: string
    view: SessionView
    state: LiveSessionState
  } {
    const sessionId = this.newSessionId()
    const now = this.now()
    const poolInitial = args.poolInitial ?? this.defaultPoolInitial
    this.owners.set(sessionId, args.principalId)
    this.ledgers.set(sessionId, [])
    this.nextCausal.set(sessionId, 1)

    const control: MailboxRecord = {
      mailboxId: SESSION_CONTROL_MAILBOX_ID,
      headSeq: 0,
      tailSeq: 0,
      messages: [],
    }
    const state: LiveSessionState = {
      sessionId,
      principalId: args.principalId,
      committedVersion: 1,
      committedProjectionHash: '',
      committedCutoff: 1,
      lifecycle: 'active',
      handles: new Map(),
      mailboxes: new Map([[SESSION_CONTROL_MAILBOX_ID, control]]),
      liveDedupe: new Set(),
      committedDedupe: new Set(),
      nextHandleOrdinal: 0,
      activeHandleCount: 0,
      memorySummaryRef: null,
      ...(args.metadataLabel === undefined ? {} : { metadataLabel: args.metadataLabel }),
      poolInitial,
      poolRemaining: poolInitial,
      openReserves: new Map(),
      settlements: [],
    }

    const emptyBudget: SessionBudgetSnapshot = {
      poolInitial,
      poolRemaining: poolInitial,
      openReserves: [],
      settlements: [],
    }
    const projection = buildCanonicalProjection({
      sessionId,
      sessionVersion: 1,
      principalId: args.principalId,
      handles: [],
      mailboxes: [control],
      memorySummaryRef: null,
      cutoffCausalSeq: 1,
      lifecycle: 'active',
      poolRemaining: poolInitial,
      poolInitial,
      openReserves: [],
      settlements: [],
    })
    const pHash = projectionHashOf(projection)
    const dHash = dedupeSnapshotHashOf([])
    const committed: CommittedVersion = {
      sessionVersion: 1,
      projection,
      projectionHash: pHash,
      cutoffCausalSeq: 1,
      dedupeSnapshot: new Set(),
      dedupeSnapshotHash: dHash,
      committedAt: now,
      budget: emptyBudget,
    }
    this.versions.set(sessionId, new Map([[1, committed]]))
    state.committedProjectionHash = pHash
    this.live.set(sessionId, state)

    // Append merge.commit for V=1 (empty)
    const causalSeq = this.allocateCausalSeq(sessionId)
    const mergeCommit: SessionMergeCommit = {
      recordType: 'merge.commit',
      causalSeq,
      sessionVersion: 1,
      cutoffCausalSeq: 1,
      committedMergeKeys: [],
      projectionHash: pHash,
      dedupeSnapshotHash: dHash,
      recordedAt: now,
    }
    this.appendLedger(sessionId, mergeCommit)
    this.persistCheckpoint(sessionId, committed)
    this.mergeCommits.push({
      sessionVersion: 1,
      cutoffCausalSeq: 1,
      committedMergeKeysHash: dHash,
      projectionHash: pHash,
    })

    const view = materializeSessionView({
      state,
      actor: 'parent',
      committedVersion: 1,
      committedProjectionHash: pHash,
      committedCutoff: 1,
    })
    return { sessionId, view, state }
  }

  /**
   * Resume from committed version V; apply post-cutoff unmerged domain events to live only.
   * Does not commit a new version.
   */
  resume(args: {
    sessionId: string
    version?: number
  }):
    | { ok: true; view: SessionView; state: LiveSessionState }
    | { ok: false; code: 'SESSION_VERSION_NOT_FOUND' } {
    const committed = this.getCommitted(args.sessionId, args.version)
    if (!committed) {
      return { ok: false, code: 'SESSION_VERSION_NOT_FOUND' }
    }

    // Rebuild live from committed projection
    const state = this.hydrateLiveFromCommitted(args.sessionId, committed)

    // Apply post-cutoff domain events that are not commit-merged
    const ledger = this.ledgers.get(args.sessionId) ?? []
    const mergeCommits = ledger.filter(
      (r): r is SessionMergeCommit => r.recordType === 'merge.commit',
    )
    const domainEvents = ledger
      .filter((r): r is SessionDomainEvent => r.recordType === 'domain')
      .filter(
        e =>
          e.causalSeq >= committed.cutoffCausalSeq &&
          !isCommitMerged(e.mergeKey, {
            dedupeSnapshot: committed.dedupeSnapshot,
            mergeCommits,
            asOfVersion: committed.sessionVersion,
          }),
      )
      .sort((a, b) => a.causalSeq - b.causalSeq)

    for (const event of domainEvents) {
      if (state.liveDedupe.has(event.mergeKey)) continue
      this.applyDomainEventToLive(state, event)
      state.liveDedupe.add(event.mergeKey)
    }

    this.live.set(args.sessionId, state)
    // Keep nextCausal at least past last ledger entry
    const maxSeq = ledger.reduce((m, r) => Math.max(m, r.causalSeq), 0)
    this.nextCausal.set(args.sessionId, Math.max(this.nextCausal.get(args.sessionId) ?? 1, maxSeq + 1))

    const view = materializeSessionView({
      state,
      actor: 'parent',
      committedVersion: committed.sessionVersion,
      committedProjectionHash: committed.projectionHash,
      committedCutoff: committed.cutoffCausalSeq,
    })
    return { ok: true, view, state }
  }

  /**
   * Checkpoint: atomic commit of live → V' with merge.commit + dedupe snapshot.
   */
  checkpoint(args: {
    sessionId: string
    note?: string
  }):
    | { ok: true; view: SessionView; noop: boolean; committedVersion: number }
    | { ok: false; code: 'SESSION_NOT_FOUND' } {
    const state = this.live.get(args.sessionId)
    if (!state) return { ok: false, code: 'SESSION_NOT_FOUND' }

    const now = this.now()
    const currentV = state.committedVersion
    const currentCommitted = this.getCommitted(args.sessionId, currentV)
    if (!currentCommitted) return { ok: false, code: 'SESSION_NOT_FOUND' }

    // Determine newly commit-merged keys = liveDedupe \ committedDedupe
    const newlyMerged: string[] = []
    for (const key of state.liveDedupe) {
      if (!state.committedDedupe.has(key)) newlyMerged.push(key)
    }
    newlyMerged.sort((a, b) => a.localeCompare(b))

    // Also include any domain events with causalSeq < cutoff that aren't merged yet
    const cutoffCausalSeq = this.nextCausal.get(args.sessionId) ?? 1
    const ledger = this.ledgers.get(args.sessionId) ?? []
    for (const rec of ledger) {
      if (rec.recordType !== 'domain') continue
      if (rec.causalSeq >= cutoffCausalSeq) continue
      if (state.committedDedupe.has(rec.mergeKey)) continue
      if (state.liveDedupe.has(rec.mergeKey)) continue
      // Apply then mark
      this.applyDomainEventToLive(state, rec)
      state.liveDedupe.add(rec.mergeKey)
      newlyMerged.push(rec.mergeKey)
    }
    newlyMerged.sort((a, b) => a.localeCompare(b))
    // unique
    const uniqueNew = [...new Set(newlyMerged)].sort((a, b) => a.localeCompare(b))

    const noop = uniqueNew.length === 0 && this.liveEqualsCommitted(state, currentCommitted)
    if (noop) {
      const view = materializeSessionView({
        state,
        actor: 'parent',
        committedVersion: currentV,
        committedProjectionHash: currentCommitted.projectionHash,
        committedCutoff: currentCommitted.cutoffCausalSeq,
      })
      return {
        ok: true,
        view: { ...view, noop: true, committed_version: currentV },
        noop: true,
        committedVersion: currentV,
      }
    }

    const newVersion = currentV + 1
    const newDedupe = new Set(state.committedDedupe)
    for (const k of uniqueNew) newDedupe.add(k)

    const budgetSnapshot: SessionBudgetSnapshot = {
      poolInitial: state.poolInitial,
      poolRemaining: state.poolRemaining,
      openReserves: [...state.openReserves.values()].sort((a, b) =>
        a.handleId.localeCompare(b.handleId),
      ),
      settlements: [...state.settlements].sort((a, b) =>
        a.handleId.localeCompare(b.handleId),
      ),
    }
    const projection = buildCanonicalProjection({
      sessionId: state.sessionId,
      sessionVersion: newVersion,
      principalId: state.principalId,
      handles: [...state.handles.values()],
      mailboxes: [...state.mailboxes.values()],
      memorySummaryRef: state.memorySummaryRef,
      cutoffCausalSeq,
      lifecycle: state.lifecycle,
      poolRemaining: budgetSnapshot.poolRemaining,
      poolInitial: budgetSnapshot.poolInitial,
      openReserves: budgetSnapshot.openReserves,
      settlements: budgetSnapshot.settlements,
    })
    const pHash = projectionHashOf(projection)
    const dHash = dedupeSnapshotHashOf(newDedupe)

    const causalSeq = this.allocateCausalSeq(args.sessionId)
    const mergeCommit: SessionMergeCommit = {
      recordType: 'merge.commit',
      causalSeq,
      sessionVersion: newVersion,
      cutoffCausalSeq,
      committedMergeKeys: uniqueNew,
      projectionHash: pHash,
      dedupeSnapshotHash: dHash,
      recordedAt: now,
    }
    // Atomic: persist version + append merge.commit
    const committed: CommittedVersion = {
      sessionVersion: newVersion,
      projection,
      projectionHash: pHash,
      cutoffCausalSeq,
      dedupeSnapshot: newDedupe,
      dedupeSnapshotHash: dHash,
      committedAt: now,
      budget: budgetSnapshot,
      ...(args.note === undefined ? {} : { note: args.note }),
    }
    let map = this.versions.get(args.sessionId)
    if (!map) {
      map = new Map()
      this.versions.set(args.sessionId, map)
    }
    map.set(newVersion, committed)
    this.appendLedger(args.sessionId, mergeCommit)
    this.persistCheckpoint(args.sessionId, committed)

    state.committedVersion = newVersion
    state.committedProjectionHash = pHash
    state.committedCutoff = cutoffCausalSeq
    state.committedDedupe = new Set(newDedupe)
    state.liveDedupe = new Set(newDedupe)

    this.mergeCommits.push({
      sessionVersion: newVersion,
      cutoffCausalSeq,
      committedMergeKeysHash: sha256Hex(canonicalJson(uniqueNew)),
      projectionHash: pHash,
    })

    const view = materializeSessionView({
      state,
      actor: 'parent',
      committedVersion: newVersion,
      committedProjectionHash: pHash,
      committedCutoff: cutoffCausalSeq,
    })
    return {
      ok: true,
      view: { ...view, noop: false, committed_version: newVersion },
      noop: false,
      committedVersion: newVersion,
    }
  }

  // ----- handles -----

  spawnHandle(args: {
    sessionId: string
    parentRunId: string
    mailbox: boolean
    reserve: number
    declaredPromptTokens: number
    declaredCompletionTokens: number
    requestedCompletionTokens: number
    preview?: string
  }):
    | { ok: true; handle: HandleRecord }
    | {
        ok: false
        code: 'AGENT_ACTIVE_HANDLE_LIMIT' | 'AGENT_HISTORICAL_HANDLE_LIMIT' | 'SESSION_NOT_FOUND'
      } {
    const state = this.live.get(args.sessionId)
    if (!state) return { ok: false, code: 'SESSION_NOT_FOUND' }
    if (state.activeHandleCount >= MAX_HANDLES) {
      return { ok: false, code: 'AGENT_ACTIVE_HANDLE_LIMIT' }
    }
    if (state.handles.size >= MAX_HANDLES_PER_SESSION) {
      return { ok: false, code: 'AGENT_HISTORICAL_HANDLE_LIMIT' }
    }

    const ordinal = state.nextHandleOrdinal++
    const handleId = this.newHandleId(args.sessionId, ordinal)
    const childRunId = this.newChildRunId(args.parentRunId, ordinal)
    const handle: HandleRecord = {
      handleId,
      childRunId,
      status: 'pending',
      preview: args.preview ?? '',
      resultRef: null,
      error: null,
      terminalGeneration: 0,
      ordinal,
      mailboxEnabled: args.mailbox,
      reservedTokens: args.reserve,
      declaredPromptTokens: args.declaredPromptTokens,
      declaredCompletionTokens: args.declaredCompletionTokens,
      requestedCompletionTokens: args.requestedCompletionTokens,
      actualUsageTokens: 0,
      chargedTokens: 0,
      overflowTokens: 0,
      settled: false,
    }
    state.handles.set(handleId, handle)
    state.activeHandleCount += 1
    if (args.mailbox) {
      const mbId = mailboxIdForHandle(handleId)
      if (!state.mailboxes.has(mbId)) {
        state.mailboxes.set(mbId, {
          mailboxId: mbId,
          headSeq: 0,
          tailSeq: 0,
          messages: [],
        })
      }
    }
    return { ok: true, handle }
  }

  // ----- budget book (session-level, checkpointed) -----

  getPoolRemaining(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.poolRemaining
  }

  getPoolInitial(sessionId: string): number | undefined {
    return this.live.get(sessionId)?.poolInitial
  }

  setPoolRemaining(sessionId: string, remaining: number): void {
    const state = this.live.get(sessionId)
    if (!state) return
    state.poolRemaining = Math.max(0, remaining)
  }

  setOpenReserve(sessionId: string, reserve: PersistedOpenReserve): void {
    const state = this.live.get(sessionId)
    if (!state) return
    state.openReserves.set(reserve.handleId, reserve)
  }

  getOpenReserve(
    sessionId: string,
    handleId: string,
  ): PersistedOpenReserve | undefined {
    return this.live.get(sessionId)?.openReserves.get(handleId)
  }

  clearOpenReserve(sessionId: string, handleId: string): void {
    this.live.get(sessionId)?.openReserves.delete(handleId)
  }

  recordBudgetSettlement(
    sessionId: string,
    settlement: SessionBudgetSettlement,
  ): void {
    const state = this.live.get(sessionId)
    if (!state) return
    // replace prior settlement for same handle if any
    state.settlements = state.settlements.filter(s => s.handleId !== settlement.handleId)
    state.settlements.push(settlement)
    this.budgetSettlements.push(settlement)
  }


  markHandleRunning(sessionId: string, handleId: string): void {
    const h = this.live.get(sessionId)?.handles.get(handleId)
    if (!h) return
    if (h.status === 'pending') h.status = 'running'
  }

  /**
   * Record handle terminal via append-only domain event + live apply.
   * Budget settlement (pool/openReserves/settlements) is part of the durable
   * handle.terminal payload so resume can rebuild the ledger tail.
   * Exactly-once via mergeKey.
   */
  completeHandle(args: {
    sessionId: string
    handleId: string
    status: 'completed' | 'failed' | 'cancelled'
    preview?: string
    resultRef?: string | null
    error?: { code: string; message: string } | null
    actualUsageTokens?: number
    childRunId?: string | null
  }):
    | { ok: true; handle: HandleRecord; settlement: SessionBudgetSettlement; duplicate: boolean }
    | { ok: false; code: 'AGENT_NOT_FOUND' | 'SESSION_NOT_FOUND' } {
    const state = this.live.get(args.sessionId)
    if (!state) return { ok: false, code: 'SESSION_NOT_FOUND' }
    const handle = state.handles.get(args.handleId)
    if (!handle) return { ok: false, code: 'AGENT_NOT_FOUND' }

    const mergeKey = handleTerminalMergeKey(args.handleId, 1)
    if (state.liveDedupe.has(mergeKey) || isTerminalStatus(handle.status)) {
      // already terminal — exactly-once
      const settlement: SessionBudgetSettlement = {
        handleId: handle.handleId,
        reservedTokens: handle.reservedTokens,
        declaredPromptTokens: handle.declaredPromptTokens,
        declaredCompletionTokens: handle.declaredCompletionTokens,
        requestedCompletionTokens: handle.requestedCompletionTokens,
        actualUsageTokens: handle.actualUsageTokens,
        chargedTokens: handle.chargedTokens,
        overflowTokens: handle.overflowTokens,
        status: handle.status,
      }
      return { ok: true, handle, settlement, duplicate: true }
    }

    const open = state.openReserves.get(args.handleId)
    const actual = Math.max(0, args.actualUsageTokens ?? 0)
    const reservedTokens = open?.reserve ?? handle.reservedTokens
    const chargedTokens = Math.min(reservedTokens, actual)
    const overflowTokens = Math.max(0, actual - reservedTokens)
    // Pool still holds this reserve; refund unspent portion.
    const poolRemainingAfter =
      state.poolRemaining + (reservedTokens - chargedTokens)
    if (!Number.isFinite(poolRemainingAfter) || poolRemainingAfter < 0) {
      throw new Error('handle.terminal settlement produced invalid poolRemaining')
    }

    const preview = args.preview ?? handle.preview
    const resultRef = args.resultRef ?? null
    const error = args.error ?? null
    const childRunId =
      args.childRunId !== undefined ? args.childRunId : handle.childRunId

    const payloadHash = sha256Hex(
      canonicalJson({
        handleId: args.handleId,
        status: args.status,
        preview: preview ?? '',
        resultRef,
        error,
        actualUsageTokens: actual,
        chargedTokens,
        overflowTokens,
        reservedTokens,
        poolRemainingAfter,
      }),
    )
    const causalSeq = this.allocateCausalSeq(args.sessionId)
    const event: SessionDomainEvent = {
      recordType: 'domain',
      causalSeq,
      mergeKey,
      kind: 'handle.terminal',
      payloadHash,
      handleId: args.handleId,
      terminalGeneration: 1,
      status: args.status,
      recordedAt: this.now(),
      _preview: preview,
      _resultRef: resultRef,
      _error: error,
      _childRunId: childRunId,
      _actualUsageTokens: actual,
      _chargedTokens: chargedTokens,
      _overflowTokens: overflowTokens,
      _reservedTokens: reservedTokens,
      _poolRemainingAfter: poolRemainingAfter,
      _declaredPromptTokens: handle.declaredPromptTokens,
      _declaredCompletionTokens: handle.declaredCompletionTokens,
      _requestedCompletionTokens: handle.requestedCompletionTokens,
    }
    this.appendLedger(args.sessionId, event)
    this.mergeEvents.push({
      mergeKey,
      causalSeq,
      payloadHash,
      kind: 'handle.terminal',
      count: 1,
    })

    this.applyDomainEventToLive(state, event)
    state.liveDedupe.add(mergeKey)

    const after = state.handles.get(args.handleId)!
    const settlement: SessionBudgetSettlement = {
      handleId: after.handleId,
      reservedTokens: after.reservedTokens,
      declaredPromptTokens: after.declaredPromptTokens,
      declaredCompletionTokens: after.declaredCompletionTokens,
      requestedCompletionTokens: after.requestedCompletionTokens,
      actualUsageTokens: after.actualUsageTokens,
      chargedTokens: after.chargedTokens,
      overflowTokens: after.overflowTokens,
      status: after.status,
    }
    return { ok: true, handle: after, settlement, duplicate: false }
  }

  rejectHandleAdmission(args: {
    sessionId: string
    handleId: string
    error: { code: string; message: string }
  }): void {
    const state = this.live.get(args.sessionId)
    const handle = state?.handles.get(args.handleId)
    if (!handle || isTerminalStatus(handle.status)) return
    const wasActive = isActiveStatus(handle.status)
    handle.status = 'rejected'
    handle.terminalGeneration = 1
    handle.error = args.error
    handle.actualUsageTokens = 0
    handle.chargedTokens = 0
    handle.overflowTokens = 0
    handle.settled = true
    if (wasActive && state) state.activeHandleCount = Math.max(0, state.activeHandleCount - 1)
    this.budgetSettlements.push({
      handleId: handle.handleId,
      reservedTokens: handle.reservedTokens,
      declaredPromptTokens: handle.declaredPromptTokens,
      declaredCompletionTokens: handle.declaredCompletionTokens,
      requestedCompletionTokens: handle.requestedCompletionTokens,
      actualUsageTokens: 0,
      chargedTokens: 0,
      overflowTokens: 0,
      status: 'rejected',
    })
  }

  getHandle(sessionId: string, handleId: string): HandleRecord | undefined {
    return this.live.get(sessionId)?.handles.get(handleId)
  }

  // ----- mailbox -----

  /**
   * Enqueue message. Caller must have already authorized.
   * Returns structured error codes without throwing.
   */
  enqueue(args: {
    sessionId: string
    mailboxId: string
    from: string
    payload: unknown
  }):
    | {
        ok: true
        msgId: string
        msgSeq: number
        mailboxId: string
        payloadHash: string
        payloadRef: string | null
        preview: string
        causalSeq: number
      }
    | {
        ok: false
        code:
          | 'MAILBOX_NOT_FOUND'
          | 'MAILBOX_MSG_TOO_LARGE'
          | 'MAILBOX_FULL'
          | 'MAILBOX_SESSION_BACKPRESSURE'
          | 'SESSION_NOT_FOUND'
          | 'MAILBOX_PARAM_INVALID'
      } {
    const state = this.live.get(args.sessionId)
    if (!state) return { ok: false, code: 'SESSION_NOT_FOUND' }
    const mailbox = state.mailboxes.get(args.mailboxId)
    if (!mailbox) return { ok: false, code: 'MAILBOX_NOT_FOUND' }

    let canonical: string
    try {
      canonical = canonicalJson(args.payload)
    } catch {
      return { ok: false, code: 'MAILBOX_PARAM_INVALID' }
    }
    const bytes = utf8Bytes(canonical)
    if (bytes > MAX_MSG_BYTES) return { ok: false, code: 'MAILBOX_MSG_TOO_LARGE' }
    if (mailbox.messages.length >= MAILBOX_DEPTH) return { ok: false, code: 'MAILBOX_FULL' }
    if (this.totalInFlightMessages(args.sessionId) >= MAX_IN_FLIGHT_MSGS) {
      return { ok: false, code: 'MAILBOX_SESSION_BACKPRESSURE' }
    }

    const msgId = this.newMsgId()
    const msgSeq = mailbox.tailSeq + 1
    const payloadHash = sha256Hex(canonical)
    const preview = truncatePreview(
      typeof args.payload === 'string' ? args.payload : canonical,
    )
    const mergeKey = msgId
    if (state.liveDedupe.has(mergeKey)) {
      // should not happen with fresh ids
      return { ok: false, code: 'MAILBOX_PARAM_INVALID' }
    }

    const causalSeq = this.allocateCausalSeq(args.sessionId)
    const event: SessionDomainEvent = {
      recordType: 'domain',
      causalSeq,
      mergeKey,
      kind: 'mailbox.enqueue',
      payloadHash,
      mailboxId: args.mailboxId,
      msgId,
      msgSeq,
      recordedAt: this.now(),
      _payload: args.payload,
      _preview: preview,
      _from: args.from,
    }
    this.appendLedger(args.sessionId, event)
    this.mergeEvents.push({
      mergeKey,
      causalSeq,
      payloadHash,
      kind: 'mailbox.enqueue',
      count: 1,
    })
    this.applyDomainEventToLive(state, event)
    state.liveDedupe.add(mergeKey)

    return {
      ok: true,
      msgId,
      msgSeq,
      mailboxId: args.mailboxId,
      payloadHash,
      payloadRef: null,
      preview,
      causalSeq,
    }
  }

  /**
   * Consume head message (receive). Advances cursor.
   */
  consume(args: {
    sessionId: string
    mailboxId: string
    now?: number
  }):
    | { ok: true; message: MailboxMessageView | null; consumed: boolean; causalSeq?: number }
    | { ok: false; code: 'MAILBOX_NOT_FOUND' | 'SESSION_NOT_FOUND' } {
    const state = this.live.get(args.sessionId)
    if (!state) return { ok: false, code: 'SESSION_NOT_FOUND' }
    const mailbox = state.mailboxes.get(args.mailboxId)
    if (!mailbox) return { ok: false, code: 'MAILBOX_NOT_FOUND' }

    const now = args.now ?? this.now()
    // Skip expired
    while (mailbox.messages.length > 0) {
      const head = mailbox.messages[0]!
      if (now - head.enqueuedAt > MAILBOX_MSG_TTL_MS) {
        head.expired = true
        // consume expired without delivering body
        const mergeKey = mailboxConsumeMergeKey(args.mailboxId, head.msgSeq)
        if (!state.liveDedupe.has(mergeKey)) {
          const causalSeq = this.allocateCausalSeq(args.sessionId)
          const event: SessionDomainEvent = {
            recordType: 'domain',
            causalSeq,
            mergeKey,
            kind: 'mailbox.consume',
            payloadHash: head.payloadHash,
            mailboxId: args.mailboxId,
            msgId: head.msgId,
            msgSeq: head.msgSeq,
            recordedAt: now,
          }
          this.appendLedger(args.sessionId, event)
          this.mergeEvents.push({
            mergeKey,
            causalSeq,
            payloadHash: head.payloadHash,
            kind: 'mailbox.consume',
            count: 1,
          })
          this.applyDomainEventToLive(state, event)
          state.liveDedupe.add(mergeKey)
        } else {
          mailbox.messages.shift()
          mailbox.headSeq = head.msgSeq
        }
        continue
      }
      break
    }

    if (mailbox.messages.length === 0) {
      return { ok: true, message: null, consumed: false }
    }

    const head = mailbox.messages[0]!
    const mergeKey = mailboxConsumeMergeKey(args.mailboxId, head.msgSeq)
    if (state.liveDedupe.has(mergeKey)) {
      // already consumed in live
      return { ok: true, message: null, consumed: false }
    }

    const causalSeq = this.allocateCausalSeq(args.sessionId)
    const event: SessionDomainEvent = {
      recordType: 'domain',
      causalSeq,
      mergeKey,
      kind: 'mailbox.consume',
      payloadHash: head.payloadHash,
      mailboxId: args.mailboxId,
      msgId: head.msgId,
      msgSeq: head.msgSeq,
      recordedAt: now,
    }
    this.appendLedger(args.sessionId, event)
    this.mergeEvents.push({
      mergeKey,
      causalSeq,
      payloadHash: head.payloadHash,
      kind: 'mailbox.consume',
      count: 1,
    })
    this.applyDomainEventToLive(state, event)
    state.liveDedupe.add(mergeKey)

    return {
      ok: true,
      message: {
        msg_id: head.msgId,
        msg_seq: head.msgSeq,
        mailbox_id: head.mailboxId,
        from: head.from,
        preview: head.preview,
        payload_ref: head.payloadRef,
        payload_hash: head.payloadHash,
      },
      consumed: true,
      causalSeq,
    }
  }

  peek(args: {
    sessionId: string
    mailboxId: string
    now?: number
  }):
    | { ok: true; message: MailboxMessageView | null }
    | { ok: false; code: 'MAILBOX_NOT_FOUND' | 'SESSION_NOT_FOUND' } {
    const state = this.live.get(args.sessionId)
    if (!state) return { ok: false, code: 'SESSION_NOT_FOUND' }
    const mailbox = state.mailboxes.get(args.mailboxId)
    if (!mailbox) return { ok: false, code: 'MAILBOX_NOT_FOUND' }
    const now = args.now ?? this.now()
    for (const msg of mailbox.messages) {
      if (now - msg.enqueuedAt > MAILBOX_MSG_TTL_MS) continue
      return {
        ok: true,
        message: {
          msg_id: msg.msgId,
          msg_seq: msg.msgSeq,
          mailbox_id: msg.mailboxId,
          from: msg.from,
          preview: msg.preview,
          payload_ref: msg.payloadRef,
          payload_hash: msg.payloadHash,
        },
      }
    }
    return { ok: true, message: null }
  }

  setLifecycle(sessionId: string, lifecycle: SessionLifecycle): void {
    const state = this.live.get(sessionId)
    if (state) state.lifecycle = lifecycle
  }

  setMemorySummaryRef(sessionId: string, ref: string | null): void {
    const state = this.live.get(sessionId)
    if (state) state.memorySummaryRef = ref
  }

  /**
   * Test / crash-recovery seam: drop live state, keep ledger + committed versions.
   * Next resume rebuilds from committed + domain tail.
   */
  dropLive(sessionId: string): void {
    this.live.delete(sessionId)
  }

  /** Full wipe of one session (tests). */
  deleteSession(sessionId: string): void {
    this.live.delete(sessionId)
    this.ledgers.delete(sessionId)
    this.versions.delete(sessionId)
    this.nextCausal.delete(sessionId)
    this.owners.delete(sessionId)
  }

  // ----- internals -----

  private allocateCausalSeq(sessionId: string): number {
    const next = this.nextCausal.get(sessionId) ?? 1
    this.nextCausal.set(sessionId, next + 1)
    return next
  }

  private appendLedger(sessionId: string, record: SessionLedgerRecord): void {
    let list = this.ledgers.get(sessionId)
    if (!list) {
      list = []
      this.ledgers.set(sessionId, list)
    }
    // append-only: never mutate prior entries
    list.push(record)
    if (this.rootDir) {
      // durable: fsync before notify (caller continues after return)
      appendLedgerLineSync(ledgerPathFor(this.rootDir, sessionId), record)
    }
  }

  private persistCheckpoint(sessionId: string, committed: CommittedVersion): void {
    if (!this.rootDir) return
    const nextCausalSeq = this.nextCausal.get(sessionId) ?? 1
    writeCheckpointAtomicSync(this.rootDir, {
      sessionId,
      principalId: committed.projection.principalId,
      sessionVersion: committed.sessionVersion,
      projection: committed.projection,
      projectionHash: committed.projectionHash,
      cutoffCausalSeq: committed.cutoffCausalSeq,
      dedupeSnapshot: [...committed.dedupeSnapshot].sort((a, b) => a.localeCompare(b)),
      dedupeSnapshotHash: committed.dedupeSnapshotHash,
      committedAt: committed.committedAt,
      ...(committed.note === undefined ? {} : { note: committed.note }),
      budget: committed.budget,
      nextCausalSeq,
    })
  }

  private applyDomainEventToLive(state: LiveSessionState, event: SessionDomainEvent): void {
    if (event.kind === 'handle.terminal') {
      const handleId = event.handleId
      if (!handleId) return
      let handle = state.handles.get(handleId)
      const actual = Math.max(0, event._actualUsageTokens ?? 0)
      const charged = Math.max(
        0,
        event._chargedTokens ?? Math.min(event._reservedTokens ?? 0, actual),
      )
      const overflow = Math.max(0, event._overflowTokens ?? Math.max(0, actual - charged))
      const reserved =
        event._reservedTokens ??
        state.openReserves.get(handleId)?.reserve ??
        handle?.reservedTokens ??
        0

      if (!handle) {
        // recreate stub from event (resume path)
        handle = {
          handleId,
          childRunId: event._childRunId ?? null,
          status: event.status ?? 'failed',
          preview: event._preview ?? '',
          resultRef: event._resultRef ?? null,
          error: event._error ?? null,
          terminalGeneration: 1,
          ordinal: state.nextHandleOrdinal++,
          mailboxEnabled: false,
          reservedTokens: reserved,
          declaredPromptTokens: event._declaredPromptTokens ?? 0,
          declaredCompletionTokens: event._declaredCompletionTokens ?? 0,
          requestedCompletionTokens: event._requestedCompletionTokens ?? 0,
          actualUsageTokens: actual,
          chargedTokens: charged,
          overflowTokens: overflow,
          settled: true,
        }
        state.handles.set(handleId, handle)
      } else if (!isTerminalStatus(handle.status)) {
        const wasActive = isActiveStatus(handle.status)
        handle.status = event.status ?? 'failed'
        handle.terminalGeneration = 1
        if (event._preview !== undefined) handle.preview = String(event._preview)
        if (event._resultRef !== undefined) handle.resultRef = event._resultRef
        if (event._error !== undefined) handle.error = event._error
        if (event._childRunId !== undefined) handle.childRunId = event._childRunId
        handle.reservedTokens = reserved
        if (event._declaredPromptTokens !== undefined) {
          handle.declaredPromptTokens = event._declaredPromptTokens
        }
        if (event._declaredCompletionTokens !== undefined) {
          handle.declaredCompletionTokens = event._declaredCompletionTokens
        }
        if (event._requestedCompletionTokens !== undefined) {
          handle.requestedCompletionTokens = event._requestedCompletionTokens
        }
        handle.actualUsageTokens = actual
        handle.chargedTokens = charged
        handle.overflowTokens = overflow
        handle.settled = true
        if (wasActive) state.activeHandleCount = Math.max(0, state.activeHandleCount - 1)
      } else if (handle.settled) {
        // already terminal+settled — still ensure open reserve is gone
        state.openReserves.delete(handleId)
        return
      }

      // Clear open reserve and restore pool from durable settlement.
      state.openReserves.delete(handleId)
      if (typeof event._poolRemainingAfter === 'number' && Number.isFinite(event._poolRemainingAfter)) {
        state.poolRemaining = Math.max(0, event._poolRemainingAfter)
      } else {
        // Fallback formula when older events lack poolRemainingAfter.
        state.poolRemaining = Math.max(
          0,
          state.poolRemaining + (reserved - charged),
        )
      }

      const settlement: SessionBudgetSettlement = {
        handleId: handle.handleId,
        reservedTokens: handle.reservedTokens,
        declaredPromptTokens: handle.declaredPromptTokens,
        declaredCompletionTokens: handle.declaredCompletionTokens,
        requestedCompletionTokens: handle.requestedCompletionTokens,
        actualUsageTokens: handle.actualUsageTokens,
        chargedTokens: handle.chargedTokens,
        overflowTokens: handle.overflowTokens,
        status: handle.status,
      }
      state.settlements = state.settlements.filter(s => s.handleId !== handleId)
      state.settlements.push(settlement)
      // Evidence collector — only append if not already present for this handle+status
      if (
        !this.budgetSettlements.some(
          s => s.handleId === settlement.handleId && s.status === settlement.status,
        )
      ) {
        this.budgetSettlements.push(settlement)
      }
      return
    }

    if (event.kind === 'mailbox.enqueue') {
      const mailboxId = event.mailboxId
      if (!mailboxId || !event.msgId || event.msgSeq === undefined) return
      let mailbox = state.mailboxes.get(mailboxId)
      if (!mailbox) {
        mailbox = { mailboxId, headSeq: 0, tailSeq: 0, messages: [] }
        state.mailboxes.set(mailboxId, mailbox)
      }
      // idempotent insert by msgId
      if (mailbox.messages.some(m => m.msgId === event.msgId)) return
      const msg: MailboxMessageRecord = {
        msgId: event.msgId,
        msgSeq: event.msgSeq,
        mailboxId,
        from: event._from ?? 'parent',
        payloadHash: event.payloadHash,
        payloadRef: event.payloadRef ?? null,
        preview: event._preview ?? '',
        enqueuedAt: event.recordedAt,
        payloadCanonical:
          event._payload !== undefined ? canonicalJson(event._payload) : '',
      }
      mailbox.messages.push(msg)
      mailbox.messages.sort((a, b) => a.msgSeq - b.msgSeq)
      mailbox.tailSeq = Math.max(mailbox.tailSeq, event.msgSeq)
      return
    }

    if (event.kind === 'mailbox.consume') {
      const mailboxId = event.mailboxId
      if (!mailboxId || event.msgSeq === undefined) return
      const mailbox = state.mailboxes.get(mailboxId)
      if (!mailbox) return
      const idx = mailbox.messages.findIndex(m => m.msgSeq === event.msgSeq)
      if (idx >= 0) mailbox.messages.splice(idx, 1)
      mailbox.headSeq = Math.max(mailbox.headSeq, event.msgSeq)
    }
  }

  private hydrateLiveFromCommitted(
    sessionId: string,
    committed: CommittedVersion,
  ): LiveSessionState {
    const handles = new Map<string, HandleRecord>()
    let ordinal = 0
    let active = 0
    for (const h of committed.projection.handles) {
      const rec: HandleRecord = {
        handleId: h.handleId,
        childRunId: h.childRunId,
        status: h.status,
        preview: '',
        resultRef: h.resultRef,
        error: h.errorCode ? { code: h.errorCode, message: h.errorCode } : null,
        terminalGeneration: h.terminalGeneration,
        ordinal: ordinal++,
        mailboxEnabled: committed.projection.mailboxes.some(
          m => m.mailboxId === mailboxIdForHandle(h.handleId),
        ),
        reservedTokens: h.reservedTokens,
        declaredPromptTokens: h.declaredPromptTokens,
        declaredCompletionTokens: h.declaredCompletionTokens,
        requestedCompletionTokens: h.requestedCompletionTokens,
        actualUsageTokens: h.actualUsageTokens,
        chargedTokens: h.chargedTokens,
        overflowTokens: h.overflowTokens,
        settled: h.settled,
      }
      handles.set(h.handleId, rec)
      if (isActiveStatus(h.status)) active += 1
    }

    const mailboxes = new Map<string, MailboxRecord>()
    for (const m of committed.projection.mailboxes) {
      mailboxes.set(m.mailboxId, {
        mailboxId: m.mailboxId,
        headSeq: m.headSeq,
        tailSeq: m.tailSeq,
        messages: m.msgs.map(msg => ({
          msgId: msg.msgId,
          msgSeq: msg.msgSeq,
          mailboxId: m.mailboxId,
          from: msg.from,
          payloadHash: msg.payloadHash,
          payloadRef: null,
          preview: '',
          enqueuedAt: committed.committedAt,
          payloadCanonical: '',
        })),
      })
    }
    if (!mailboxes.has(SESSION_CONTROL_MAILBOX_ID)) {
      mailboxes.set(SESSION_CONTROL_MAILBOX_ID, {
        mailboxId: SESSION_CONTROL_MAILBOX_ID,
        headSeq: 0,
        tailSeq: 0,
        messages: [],
      })
    }

    const budget = committed.budget
    const openReserves = new Map<string, PersistedOpenReserve>()
    for (const r of budget.openReserves) {
      openReserves.set(r.handleId, { ...r })
    }

    return {
      sessionId,
      principalId: committed.projection.principalId,
      committedVersion: committed.sessionVersion,
      committedProjectionHash: committed.projectionHash,
      committedCutoff: committed.cutoffCausalSeq,
      lifecycle: committed.projection.lifecycle,
      handles,
      mailboxes,
      liveDedupe: new Set(committed.dedupeSnapshot),
      committedDedupe: new Set(committed.dedupeSnapshot),
      nextHandleOrdinal: ordinal,
      activeHandleCount: active,
      memorySummaryRef: committed.projection.memorySummaryRef,
      poolInitial: budget.poolInitial,
      poolRemaining: budget.poolRemaining,
      openReserves,
      settlements: budget.settlements.map(s => ({ ...s })),
    }
  }

  private liveEqualsCommitted(state: LiveSessionState, committed: CommittedVersion): boolean {
    const projection = buildCanonicalProjection({
      sessionId: state.sessionId,
      sessionVersion: committed.sessionVersion,
      principalId: state.principalId,
      handles: [...state.handles.values()],
      mailboxes: [...state.mailboxes.values()],
      memorySummaryRef: state.memorySummaryRef,
      cutoffCausalSeq: committed.cutoffCausalSeq,
      lifecycle: state.lifecycle,
      poolRemaining: state.poolRemaining,
      poolInitial: state.poolInitial,
      openReserves: [...state.openReserves.values()],
      settlements: state.settlements,
    })
    // Compare content ignoring version field by hashing handles/mailboxes shape
    return projectionHashOf({
      ...projection,
      sessionVersion: committed.projection.sessionVersion,
      cutoffCausalSeq: committed.projection.cutoffCausalSeq,
    }) === committed.projectionHash
  }
}

// ---------- Mailbox authorization matrix (L2 §4.6.3) ----------

export type MailboxOp = 'send' | 'receive' | 'peek'

/**
 * Returns true if actor may perform op on target mailboxId within the session.
 * Does not check existence — auth first.
 */
export function mailboxMatrixAllows(
  actor: SessionActor,
  op: MailboxOp,
  mailboxId: string,
): boolean {
  if (actor === 'none') return false
  if (actor === 'parent') return true

  // handle actor
  const handleId = actor.slice('handle:'.length)
  const selfBox = mailboxIdForHandle(handleId)

  if (mailboxId === SESSION_CONTROL_MAILBOX_ID) {
    // child may send to control; receive/peek deny
    return op === 'send'
  }
  if (mailboxId === selfBox) {
    return true
  }
  // other handle inboxes
  return false
}

export function resolveMailboxTarget(args: {
  actor: SessionActor
  to?: string
  toHandleId?: string
  mailboxId?: string
  /** default mailbox when omitted */
  defaultForActor: 'control' | 'self'
}):
  | { ok: true; mailboxId: string }
  | { ok: false; code: 'MAILBOX_PARAM_INVALID' } {
  if (args.toHandleId !== undefined) {
    const derived = mailboxIdForHandle(args.toHandleId)
    if (args.to !== undefined && args.to !== derived) {
      return { ok: false, code: 'MAILBOX_PARAM_INVALID' }
    }
    return { ok: true, mailboxId: derived }
  }
  if (args.to !== undefined) return { ok: true, mailboxId: args.to }
  if (args.mailboxId !== undefined) return { ok: true, mailboxId: args.mailboxId }

  if (args.defaultForActor === 'control') {
    return { ok: true, mailboxId: SESSION_CONTROL_MAILBOX_ID }
  }
  if (args.actor.startsWith('handle:')) {
    return { ok: true, mailboxId: mailboxIdForHandle(args.actor.slice('handle:'.length)) }
  }
  return { ok: true, mailboxId: SESSION_CONTROL_MAILBOX_ID }
}

// re-export schema constants for consumers
export { SESSION_DOMAIN_EVENT_SCHEMA, SESSION_PROJECTION_SCHEMA }
