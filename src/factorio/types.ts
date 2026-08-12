import type { HarnessEvidenceSlice, HarnessPinsV1 } from '../harness/index.js'


export interface ObjectRef {
  hash: string
  kind:
    | 'fle.observation'
    | 'fle.game-state'
    | 'fle.action-program'
    | 'helix.output'
    | 'helix.model-response'
    | 'helix.mailbox-payload'
    | 'helix.session-projection'
    | 'helix.handle-result'
    | 'helix.session-dedupe'
  schema: string
  mediaType: 'application/json' | 'text/plain'
  bytes: number
  preview?: unknown
  truncated: boolean
}

export interface TaskVerification {
  success: boolean
  meta: Array<{ key: string; value: unknown }>
}

export interface FactorioEffect {
  method: 'reset' | 'step'
  episodeId: string
  stepIndex: number
  commandId: string
  programRef?: ObjectRef
  inputStateRef?: ObjectRef
  observationRef: ObjectRef
  outputStateRef: ObjectRef
  actionCapabilities: string[]
  observation: Record<string, unknown>
  reward: number
  terminated: boolean
  truncated: boolean
  verification: TaskVerification
  metrics: {
    stepSeconds: number
    tick: number
    productionScore: number
    automatedProductionScore: number
    actionHadError: boolean
  }
}

export type RecursiveModelStatus = 'succeeded' | 'rejected' | 'failed' | 'cancelled'

export type RecursiveModelErrorCode =
  | 'RECURSIVE_MODEL_NOT_ENABLED'
  | 'RECURSIVE_PARAM_INVALID'
  | 'MULTIPLE_EFFECTS_IN_CELL'
  | 'RECURSIVE_CALL_LIMIT_EXCEEDED'
  | 'RECURSIVE_BUDGET_INSUFFICIENT'
  | 'RECURSIVE_MODEL_FAILED'
  | 'RECURSIVE_MODEL_DEADLINE'
  | 'RECURSIVE_MODEL_CANCELLED'
  | 'RECURSIVE_CHILD_ATTACH_FAILED'
  | 'RECURSIVE_CHILD_POST_ATTACH_FAILED'
  | 'RECURSIVE_MODEL_INTERNAL'
  | 'KERNEL_PROTOCOL_INVALID'

export interface ModelEffectReservation {
  reservedTokens: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens?: number
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
}

export interface ModelEffect {
  method: 'models.call'
  childRunId?: string
  status: RecursiveModelStatus
  /** I4: absent only on param/canonical failure. */
  requestDigest?: string
  /**
   * Admission request echo for Replay digest recompute (B3).
   * Present whenever requestDigest is present.
   */
  request?: {
    instructions: string
    /** Omitted / null = missing default empty canonical (IMP-2). */
    input?: unknown
    model: string
  }
  /** C1 never-started only. */
  attachFailed?: boolean
  textPreview: string
  textTruncated: boolean
  usage?: { inputTokens: number; outputTokens: number }
  responseRef?: ObjectRef
  reservation: ModelEffectReservation
  error?: { code: string; message: string }
}

export interface RecursiveModelResult {
  schema: 'helix.recursive-model-result/v1'
  status: RecursiveModelStatus
  text: string
  textTruncated: boolean
  childRunId: string | null
  usage: { inputTokens: number; outputTokens: number } | null
  responseRef: ObjectRef | null
  reservation: ModelEffectReservation | null
  requestDigest?: string
  attachFailed?: boolean
  error: { code: RecursiveModelErrorCode | string; message: string } | null
}

export interface ModelBudgetSettlement {
  childRunId?: string
  reservedTokens: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens?: number
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
  status: RecursiveModelStatus
  requestDigest?: string
  attachFailed?: boolean
}

/** Optional in-flight audit item; not a second ledger. */
export interface OpenRecursiveCall {
  childRunId: string
  reserve: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens: number
}

export interface ModelBudgetPool {
  initialTokens: number
  remainingTokens: number
  recursiveCallCount: number
  settlements: ModelBudgetSettlement[]
  openRecursiveCalls?: OpenRecursiveCall[]
}

export interface RecursiveModelCapability {
  enabled: boolean
  remainingCalls: number
  remainingTokens: number
  maxCompletionTokens: number
}

/** S1 Live evidence: auto-scanned subsequent cell reference. */
export interface RecursiveResultWitness {
  cellIndex: number
  matchedField: 'childRunId' | 'textPrefix' | 'responseRefId'
  matchedValueHash: string
}

export interface SessionEffect {
  method: 'session.create' | 'session.resume' | 'session.checkpoint'
  sessionId: string
  sessionVersion: number
  projectionHash: string
  cutoffCausalSeq: number
  noop?: boolean
}

export interface AgentEffectReservation {
  reservedTokens: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens?: number
  actualUsageTokens?: number
  chargedTokens?: number
  overflowTokens?: number
}

export interface AgentEffect {
  method: 'agents.spawn' | 'agents.wait'
  handleId: string
  childRunId?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected'
  requestDigest?: string
  reservation?: AgentEffectReservation
  error?: { code: string; message: string }
}

export interface MailboxEffect {
  method: 'mailbox.send' | 'mailbox.receive'
  mailboxId: string
  msgId?: string
  msgSeq?: number
  payloadHash?: string
  consumed?: boolean
  causalSeq?: number
}

export interface SessionAsyncCapability {
  enabled: boolean
  maxActiveHandles: number
  remainingActiveHandleSlots: number
  maxHandlesPerSession: number
  remainingHistoricalHandleSlots: number
  maxMailboxDepth: number
  maxMailboxMsgBytes: number
  sessionId: string | null
  sessionVersion: number | null
}

export interface SessionMergeEventEvidence {
  mergeKey: string
  causalSeq: number
  payloadHash: string
  kind: string
  count: number
}

export interface SessionMergeCommitEvidence {
  sessionVersion: number
  cutoffCausalSeq: number
  committedMergeKeysHash: string
  projectionHash: string
}

export interface SessionBudgetSettlementEvidence {
  handleId: string
  reservedTokens: number
  declaredPromptTokens: number
  declaredCompletionTokens: number
  requestedCompletionTokens?: number
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
  status: string
}

export interface CellExecutionRecord {
  schema: 'helix.cell-execution/v2' | 'helix.cell-execution/v3'
  cellId: string
  /** Recorded cell source/code used for S1 witness scan (I3). */
  source: string
  sourceDigest: string
  startRevision: number
  endRevision: number
  status: 'success' | 'error'
  stdoutPreview: string
  stderrPreview: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  namespace: Array<{ name: string; type: string; length?: number }>
  managedObjects: ObjectRef[]
  factorioEffect?: FactorioEffect
  /** Mutually exclusive with factorioEffect / sessionEffect / agentEffect / mailboxEffect. */
  modelEffect?: ModelEffect
  sessionEffect?: SessionEffect
  agentEffect?: AgentEffect
  mailboxEffect?: MailboxEffect
  error?: {
    code: string
    type?: string
    message: string
    stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
  }
}

export interface RunPins {
  model: string
  /**
   * Code/protocol compatibility pin (historical field name).
   * Identifies runner/binding issuance only — not harness content identity.
   */
  harness: 'factorio-rlm/v4' | 'factorio-rlm/v5'
  /**
   * Issue #10 new-format harness state pins. Present on runs assembled through
   * Host select→validate→resolve→freeze. Content identity is harnessContentHash.
   */
  harnessState?: HarnessPinsV1
  kernelProtocol: '2'
  bindingSet: 'factorio/v3' | 'factorio/v4'
  renderer: 'markdown-json/v1'
  isolationProfile: 'local-process-ast/v2'
  milkie: string
  fle: '0.4.3'
  factorioServer: '2.0.73'
  taskId: 'iron_ore_throughput'
  taskDigest: string
  kernelMemoryBytes: number
  kernelCpuSeconds: number
  /** Present on v5 session-async runs only. */
  sessionAsyncVersion?: '1'
}

export interface RunBudget {
  deadlineAt: number
}

export type TerminationReason =
  | 'verifier_succeeded'
  | 'model_budget_exhausted'
  | 'cell_budget_exhausted'
  | 'wall_budget_exhausted'
  | 'cancelled'
  | 'uncertain_effect'
  | 'policy_violation'
  | 'kernel_resource_exhausted'
  | 'environment_failed'

export interface FinalizationSummary {
  status: 'finalized' | 'idempotent'
  value: 'success' | 'failure' | 'partial' | 'unknown'
  verifierId: string
  finalizationId: string
  intentHash: string
  recordHash: string
}

export interface EpisodeProjection {
  runId: string
  episodeId: string
  kernelRevision: number
  resetCount: number
  stepCount: number
  modelCallCount: number
  recursiveCallCount: number
  remainingRecursiveModelTokens: number
  cells: CellExecutionRecord[]
  lastObservationRef?: ObjectRef
  lastStateRef?: ObjectRef
  actionCapabilities?: string[]
  verification: TaskVerification
  terminated: boolean
  truncated: boolean
  /** Control-class recursive termination signal latched from child path. */
  recursiveControlTermination?: 'cancelled' | 'wall_budget_exhausted'
  /** Bound Helix session id when sessionAsync is active. */
  sessionId?: string | null
  sessionVersion?: number | null
  remainingSessionTokens?: number
  remainingActiveHandleSlots?: number
  remainingHistoricalHandleSlots?: number
}

export interface LiveEvidence {
  schema: 'helix.factorio.live/v3' | 'helix.factorio.live/v4'
  verdict: 'pass' | 'fail'
  runId: string
  pins: RunPins
  /** Issue #10 harness evidence slice when assembled via Host freeze. */
  harness?: HarnessEvidenceSlice
  budget: RunBudget & {
    remainingWallMsAtEnd: number
    remainingRecursiveModelTokensAtEnd?: number
    remainingSessionTokensAtEnd?: number
  }
  termination: TerminationReason
  projectionDigest: string
  traceFile: string
  objectStore: string
  finalProjection: EpisodeProjection
  finalization: FinalizationSummary
  /** Observed started/attached child run ids (success LLM + C2 + agents). */
  childRunIds: string[]
  /** C1 attachFailed ids (never-started); optional audit. */
  nonReplayableChildRunIds?: string[]
  recursiveModel?: {
    calls: number
    settlements: ModelBudgetSettlement[]
  }
  recursiveResultWitness?: RecursiveResultWitness
  session?: {
    id: string
    version: number
    projectionHash: string
    cutoffCausalSeq: number
  }
  sessionMergeEvents?: SessionMergeEventEvidence[]
  sessionMergeCommits?: SessionMergeCommitEvidence[]
  sessionBudgetSettlements?: SessionBudgetSettlementEvidence[]
  checks: Array<{ id: string; passed: boolean; detail?: string }>
  evidenceRef?: string
}

export interface ReplayEvidence {
  schema: 'helix.factorio.replay/v3' | 'helix.factorio.replay/v4'
  verdict: 'pass' | 'fail'
  runId: string
  termination: TerminationReason
  projectionDigest: string
  finalization: FinalizationSummary
  finalizationMatch: boolean
  liveEffectCount: number
  remainingIO: { llm: number; tool: number; clock: number; uuid: number }
  childRunIds: string[]
  childReplays?: Array<{
    childRunId: string
    liveEffectCount: number
    remainingIO: { llm: number; tool: number; clock: number; uuid: number }
    parentId?: string
  }>
  sessionProjectionHash?: string
  checks: Array<{ id: string; passed: boolean; detail?: string }>
  evidenceRef?: string
}
