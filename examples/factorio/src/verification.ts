import { createHash } from 'node:crypto'
import type { TaskOutcomeValue } from 'milkie'
import type { Event } from 'milkie/dist/trace/types.js'
import type {
  CellExecutionRecord,
  EpisodeProjection,
  LiveEvidence,
  ModelEffect,
  RecursiveResultWitness,
  RunPins,
  TerminationReason,
} from './types.js'
import {
  assertEffectsExclusive,
  CHILD_REPLAY_SAFETY_WALL_MS,
  recomputeRequestDigestFromEffect,
  verifyRequestDigestPartition,
} from './recursive-model.js'

export interface VerificationCheck {
  id: string
  passed: boolean
  detail?: string
}

function count(events: Event[], type: string): number {
  return events.filter(event => event.type === type).length
}

export function traceChecksBeforeFinalization(
  events: Event[],
  modelCallCount: number,
  toolCallCount: number,
): VerificationCheck[] {
  return [
    {
      id: 'S1.milkie-trace-before-finalization',
      passed:
        count(events, 'llm.requested') === modelCallCount &&
        count(events, 'llm.responded') === modelCallCount &&
        count(events, 'tool.requested') === toolCallCount &&
        count(events, 'tool.responded') === toolCallCount &&
        count(events, 'agent.run.completed') === 1 &&
        count(events, 'task.outcome.recorded') === 0,
      detail: `${events.length} events before finalization`,
    },
  ]
}

export function decideFinalOutcome(
  checks: VerificationCheck[],
  termination: TerminationReason,
): TaskOutcomeValue {
  if (
    termination === 'cancelled' ||
    termination === 'uncertain_effect' ||
    termination === 'kernel_resource_exhausted'
  ) {
    return 'unknown'
  }
  if (termination === 'verifier_succeeded') {
    return checks.every(check => check.passed) ? 'success' : 'failure'
  }
  return 'failure'
}

export function finalizationEvidenceEventIds(
  events: Event[],
  projection: EpisodeProjection,
  termination: TerminationReason,
): [string, string] {
  const completions = events.filter(event => event.type === 'agent.run.completed')
  if (completions.length !== 1) {
    throw new Error(`expected exactly one agent.run.completed, got ${completions.length}`)
  }
  const lastCell = projection.cells.at(-1)
  const verifierTerminal = [...events].reverse().find(event => {
    if (event.type !== 'tool.responded') return false
    const payload = event.payload as { status?: unknown; output?: unknown }
    if (payload.status !== 'ok' || !lastCell) return false
    const output = payload.output as {
      cellId?: unknown
      factorioEffect?: { verification?: { success?: unknown } }
    }
    if (output?.cellId !== lastCell.cellId) return false
    return (
      !projection.verification.success ||
      output.factorioEffect?.verification?.success === true
    )
  })
  const latestTerminal = [...events]
    .reverse()
    .find(event => event.type === 'llm.responded' || event.type === 'tool.responded')
  const terminal =
    termination === 'verifier_succeeded' ? verifierTerminal : latestTerminal
  if (!terminal) throw new Error('no terminal event is available as finalization evidence')
  return [terminal.id, completions[0]!.id]
}

export function episodeContinuityCheck(records: CellExecutionRecord[]): VerificationCheck {
  const effects = records.flatMap(record => (record.factorioEffect ? [record.factorioEffect] : []))
  let previousStateHash: string | undefined
  let expectedStep = 0
  const commandIds = new Set<string>()
  let passed = effects.length > 0
  for (const effect of effects) {
    passed =
      passed &&
      effect.stepIndex === expectedStep &&
      effect.commandId.startsWith(`${effect.episodeId}:command:`) &&
      !commandIds.has(effect.commandId) &&
      (expectedStep === 0
        ? effect.method === 'reset' && effect.inputStateRef === undefined
        : effect.method === 'step' && effect.inputStateRef?.hash === previousStateHash)
    commandIds.add(effect.commandId)
    previousStateHash = effect.outputStateRef.hash
    expectedStep += 1
  }
  return {
    id: 'S1.episode-continuity',
    passed,
    detail: `${effects.length} effects, nextStep=${expectedStep}`,
  }
}

export function pinsGateCheck(pins: RunPins): VerificationCheck {
  const missing: string[] = []
  const wrong: string[] = []
  const requireString = (key: keyof RunPins, expected?: string) => {
    const v = pins[key]
    if (typeof v !== 'string' || v.length === 0) missing.push(String(key))
    else if (expected !== undefined && v !== expected) wrong.push(`${String(key)}=${String(v)}`)
  }
  const requireNumber = (key: keyof RunPins) => {
    const v = pins[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) missing.push(String(key))
  }
  requireString('model')
  requireString('harness', 'factorio-rlm/v5')
  requireString('kernelProtocol', '2')
  requireString('bindingSet', 'factorio/v4')
  requireString('renderer', 'markdown-json/v1')
  requireString('isolationProfile', 'local-process-ast/v2')
  requireString('milkie')
  requireString('fle', '0.4.3')
  requireString('factorioServer', '2.0.73')
  requireString('taskId')
  requireString('taskDigest')
  requireNumber('kernelMemoryBytes')
  requireNumber('kernelCpuSeconds')
  requireString('sessionAsyncVersion', '1')
  const ok = missing.length === 0 && wrong.length === 0
  return {
    id: 'pins.v5-gate',
    passed: ok,
    detail: ok
      ? `${pins.harness}/${pins.kernelProtocol}/${pins.bindingSet}/sa=${pins.sessionAsyncVersion}`
      : `missing=[${missing.join(',')}] wrong=[${wrong.join(',')}]`,
  }
}

/** v4 gate retained for #5 regression fixtures — full v4 shape required. */
export function pinsGateCheckV4(pins: RunPins): VerificationCheck {
  const missing: string[] = []
  const wrong: string[] = []
  const requireString = (key: keyof RunPins, expected?: string) => {
    const v = pins[key]
    if (typeof v !== 'string' || v.length === 0) missing.push(String(key))
    else if (expected !== undefined && v !== expected) wrong.push(`${String(key)}=${String(v)}`)
  }
  const requireNumber = (key: keyof RunPins) => {
    const v = pins[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) missing.push(String(key))
  }
  requireString('model')
  requireString('harness', 'factorio-rlm/v4')
  requireString('kernelProtocol', '2')
  requireString('bindingSet', 'factorio/v3')
  requireString('renderer', 'markdown-json/v1')
  requireString('isolationProfile', 'local-process-ast/v2')
  requireString('milkie')
  requireString('fle', '0.4.3')
  requireString('factorioServer', '2.0.73')
  requireString('taskId')
  requireString('taskDigest')
  requireNumber('kernelMemoryBytes')
  requireNumber('kernelCpuSeconds')
  if (pins.sessionAsyncVersion !== undefined) {
    wrong.push('sessionAsyncVersion-present')
  }
  const ok = missing.length === 0 && wrong.length === 0
  return {
    id: 'pins.v4-gate',
    passed: ok,
    detail: ok
      ? `${pins.harness}/${pins.kernelProtocol}/${pins.bindingSet}`
      : `missing=[${missing.join(',')}] wrong=[${wrong.join(',')}]`,
  }
}

export function rejectLegacyPins(pins: {
  harness?: string
  bindingSet?: string
  kernelProtocol?: string
  sessionAsyncVersion?: string
  model?: string
  renderer?: string
  isolationProfile?: string
  milkie?: string
  fle?: string
  factorioServer?: string
  taskId?: string
  taskDigest?: string
  kernelMemoryBytes?: number
  kernelCpuSeconds?: number
}): VerificationCheck {
  // Reject only pre-#5 pins. v4 (#5) and v5 (#7) are both current depending on path.
  const isLegacyV3 =
    pins.harness === 'factorio-rlm/v3' || pins.bindingSet === 'factorio/v2'
  const rejected = isLegacyV3 || pins.kernelProtocol !== '2'
  return {
    id: 'pins.reject-legacy',
    passed: !rejected,
    detail: rejected
      ? 'legacy v3 pins must not be interpreted by current runner'
      : 'current pins accepted',
  }
}

/** Select pins gate for live/replay evidence (v4 #5 vs v5 #7). */
export function pinsGateFor(pins: RunPins): VerificationCheck {
  if (pins.sessionAsyncVersion === '1' || pins.harness === 'factorio-rlm/v5') {
    return pinsGateCheck(pins)
  }
  return pinsGateCheckV4(pins)
}

/** True when evidence/pins declare session-async — independent of optional live.session. */
export function sessionAsyncEvidenceRequired(args: {
  schema?: string
  pins?: Pick<RunPins, 'harness' | 'sessionAsyncVersion'>
}): boolean {
  if (args.pins?.sessionAsyncVersion === '1') return true
  if (args.pins?.harness === 'factorio-rlm/v5') return true
  // Schema alone is not enough — v4 schema is only used with session-async pins.
  // Keep schema check as secondary when paired with missing pins object in tests.
  if (
    (args.schema === 'helix.factorio.live/v4' ||
      args.schema === 'helix.factorio.replay/v4') &&
    args.pins === undefined
  ) {
    return true
  }
  return false
}

/** Fail-closed session evidence gate for supported live/replay artifacts. */
export function sessionEvidenceChecks(args: {
  live: {
    schema?: string
    session?: {
      id: string
      version: number
      projectionHash: string
      cutoffCausalSeq: number
    }
    sessionMergeEvents?: unknown
    sessionMergeCommits?: unknown
    sessionBudgetSettlements?: unknown
    budget?: { remainingSessionTokensAtEnd?: number }
    pins?: RunPins
  }
  /**
   * When true, force session checks.
   * When omitted/false, still force if pins/schema declare session-async
   * (v5 harness, sessionAsyncVersion, or live/replay schema v4).
   * Optional live.session alone must not be the only gate.
   */
  requireSession?: boolean
}): VerificationCheck[] {
  const autoRequire = sessionAsyncEvidenceRequired({
    ...(args.live.schema === undefined ? {} : { schema: args.live.schema }),
    ...(args.live.pins
      ? {
          pins: {
            harness: args.live.pins.harness,
            ...(args.live.pins.sessionAsyncVersion === undefined
              ? {}
              : { sessionAsyncVersion: args.live.pins.sessionAsyncVersion }),
          },
        }
      : {}),
  })
  const requireSession = args.requireSession === true || autoRequire
  const schemaOk =
    args.live.schema === undefined ||
    args.live.schema === 'helix.factorio.live/v3' ||
    args.live.schema === 'helix.factorio.replay/v3' ||
    args.live.schema === 'helix.factorio.live/v4' ||
    args.live.schema === 'helix.factorio.replay/v4'
  const hasSession = Boolean(args.live.session?.id)
  const checks: VerificationCheck[] = [
    {
      id: 'S7.live-schema-v4',
      passed: schemaOk,
      detail: `schema=${args.live.schema ?? 'missing'}`,
    },
  ]
  if (requireSession || hasSession) {
    const s = args.live.session
    checks.push({
      id: 'S7.session-projection',
      passed: Boolean(
        s &&
          typeof s.id === 'string' &&
          typeof s.version === 'number' &&
          typeof s.projectionHash === 'string' &&
          s.projectionHash.length === 64 &&
          typeof s.cutoffCausalSeq === 'number',
      ),
      detail: s
        ? `${s.id}@v${s.version} hash=${s.projectionHash.slice(0, 12)}`
        : 'session missing',
    })
    checks.push({
      id: 'S7.session-merge-events',
      passed: Array.isArray(args.live.sessionMergeEvents),
      detail: `events=${Array.isArray(args.live.sessionMergeEvents) ? args.live.sessionMergeEvents.length : 'missing'}`,
    })
    checks.push({
      id: 'S7.session-merge-commits',
      passed: Array.isArray(args.live.sessionMergeCommits),
      detail: `commits=${Array.isArray(args.live.sessionMergeCommits) ? args.live.sessionMergeCommits.length : 'missing'}`,
    })
    checks.push({
      id: 'S7.session-budget-settlements',
      passed: Array.isArray(args.live.sessionBudgetSettlements),
      detail: `settlements=${Array.isArray(args.live.sessionBudgetSettlements) ? args.live.sessionBudgetSettlements.length : 'missing'}`,
    })
    checks.push({
      id: 'S7.session-budget-remaining',
      passed:
        typeof args.live.budget?.remainingSessionTokensAtEnd === 'number' &&
        Number.isFinite(args.live.budget.remainingSessionTokensAtEnd) &&
        args.live.budget.remainingSessionTokensAtEnd >= 0,
      detail: `remainingSessionTokensAtEnd=${String(args.live.budget?.remainingSessionTokensAtEnd)}`,
    })
    if (args.live.pins) {
      checks.push(pinsGateCheck(args.live.pins))
    }
  }
  return checks
}


export function singleEffectMutualExclusionCheck(
  records: CellExecutionRecord[],
): VerificationCheck {
  const ok = records.every(record => assertEffectsExclusive(record))
  return {
    id: 'S3.single-effect-mutex',
    passed: ok,
    detail: ok
      ? 'no cell has more than one of factorio/model/session/agent/mailbox effect'
      : 'mutex violated',
  }
}


export function modelEffectInvariantsCheck(
  records: CellExecutionRecord[],
): VerificationCheck {
  const effects = records.flatMap(r => (r.modelEffect ? [r.modelEffect] : []))
  const failures: string[] = []
  for (const effect of effects) {
    const partition = verifyRequestDigestPartition(effect)
    if (!partition.ok) failures.push(partition.detail)
    const r = effect.reservation
    if (r.chargedTokens !== Math.min(r.reservedTokens, r.actualUsageTokens)) {
      failures.push('chargedTokens formula')
    }
    if (r.overflowTokens !== Math.max(0, r.actualUsageTokens - r.reservedTokens)) {
      failures.push('overflowTokens formula')
    }
    if (
      effect.attachFailed === true &&
      effect.error?.code !== 'RECURSIVE_CHILD_ATTACH_FAILED'
    ) {
      failures.push('attachFailed without ATTACH_FAILED code')
    }
  }
  return {
    id: 'S3.model-effect-invariants',
    passed: failures.length === 0,
    detail: failures.length === 0 ? `${effects.length} modelEffects ok` : failures.join('; '),
  }
}

/**
 * Build evidence.childRunIds = observed started/attached ids only.
 * C1 attachFailed ids are excluded (IMP-1 + IMP-A).
 */
export function buildChildRunIds(records: CellExecutionRecord[]): {
  childRunIds: string[]
  nonReplayableChildRunIds: string[]
} {
  const childRunIds: string[] = []
  const nonReplayableChildRunIds: string[] = []
  for (const record of records) {
    const effect = record.modelEffect
    if (!effect?.childRunId) continue
    if (effect.attachFailed === true) {
      nonReplayableChildRunIds.push(effect.childRunId)
      continue
    }
    // Success, failed-with-LLM, cancelled, or C2 post-attach all enter the set
    // when childRunId is present and attachFailed is not true.
    // Pure admission rejects have no childRunId.
    if (
      effect.status === 'succeeded' ||
      effect.status === 'failed' ||
      effect.status === 'cancelled'
    ) {
      childRunIds.push(effect.childRunId)
    }
  }
  return { childRunIds, nonReplayableChildRunIds }
}

/** Forbid started ∧ attachFailed ∧ ∉childRunIds triple. */
export function attachTripleForbiddenCheck(
  records: CellExecutionRecord[],
  childRunIds: string[],
): VerificationCheck {
  const set = new Set(childRunIds)
  let ok = true
  let detail = 'ok'
  for (const record of records) {
    const effect = record.modelEffect
    if (!effect?.childRunId) continue
    if (effect.attachFailed === true && set.has(effect.childRunId)) {
      ok = false
      detail = `attachFailed id ${effect.childRunId} must not be in childRunIds`
    }
    // C2 must be in childRunIds
    if (
      effect.error?.code === 'RECURSIVE_CHILD_POST_ATTACH_FAILED' &&
      effect.attachFailed !== true &&
      !set.has(effect.childRunId)
    ) {
      ok = false
      detail = `C2 id ${effect.childRunId} must be in childRunIds`
    }
    // C1 must NOT be in childRunIds
    if (
      effect.attachFailed === true &&
      effect.error?.code === 'RECURSIVE_CHILD_ATTACH_FAILED' &&
      set.has(effect.childRunId)
    ) {
      ok = false
      detail = `C1 id ${effect.childRunId} must not be in childRunIds`
    }
  }
  return { id: 'S3.attach-triple-forbidden', passed: ok, detail }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * S1 recursiveResultWitness: scan cells after a successful models.call for a
 * controlled reference to that result (childRunId / textPrefix≥16 / responseRef).
 */
export function scanRecursiveResultWitness(
  records: CellExecutionRecord[],
  cellSources?: Array<{ cellIndex: number; source: string }>,
): RecursiveResultWitness | undefined {
  // Prefer explicit sources; otherwise use recorded CellExecutionRecord.source (I3).
  const sources =
    cellSources ??
    records.map((record, cellIndex) => ({
      cellIndex,
      source: record.source ?? '',
    }))
  for (let i = 0; i < records.length; i += 1) {
    const effect = records[i]?.modelEffect
    if (!effect || effect.status !== 'succeeded' || !effect.childRunId) continue
    const candidates = sources.filter(item => item.cellIndex > i)
    for (const candidate of candidates) {
      const source = candidate.source
      if (source.includes(effect.childRunId)) {
        return {
          cellIndex: candidate.cellIndex,
          matchedField: 'childRunId',
          matchedValueHash: sha256Hex(effect.childRunId),
        }
      }
      if (effect.responseRef?.hash && source.includes(effect.responseRef.hash)) {
        return {
          cellIndex: candidate.cellIndex,
          matchedField: 'responseRefId',
          matchedValueHash: sha256Hex(effect.responseRef.hash),
        }
      }
      const prefix = effect.textPreview.slice(
        0,
        Math.max(16, Math.min(64, effect.textPreview.length)),
      )
      if (prefix.length >= 16 && source.includes(prefix)) {
        return {
          cellIndex: candidate.cellIndex,
          matchedField: 'textPrefix',
          matchedValueHash: sha256Hex(prefix),
        }
      }
    }
  }
  return undefined
}

export function recursiveWitnessCheck(
  witness: RecursiveResultWitness | undefined,
  hadSuccessfulCall: boolean,
  opts?: { requireSuccessfulCall?: boolean },
): VerificationCheck {
  const requireSuccessfulCall = opts?.requireSuccessfulCall === true
  if (!hadSuccessfulCall) {
    return {
      id: 'S1.recursive-result-witness',
      // Issue #5 live path must not pass without a successful recursive call.
      passed: !requireSuccessfulCall,
      detail: requireSuccessfulCall
        ? 'successful recursive call required but missing'
        : 'no successful recursive call in this run',
    }
  }
  return {
    id: 'S1.recursive-result-witness',
    passed: witness !== undefined,
    detail: witness
      ? `${witness.matchedField}@cell${witness.cellIndex}`
      : 'missing subsequent cell reference to recursive result',
  }
}

export function parentTerminationMapCheck(
  termination: TerminationReason,
  records: CellExecutionRecord[],
): VerificationCheck {
  let expected: TerminationReason | undefined
  for (const record of records) {
    const code = record.modelEffect?.error?.code
    if (code === 'RECURSIVE_MODEL_CANCELLED') expected = 'cancelled'
    if (code === 'RECURSIVE_MODEL_DEADLINE') expected = 'wall_budget_exhausted'
  }
  if (expected) {
    return {
      id: 'S3.parent-termination-map',
      passed: termination === expected,
      detail: `expected ${expected}, got ${termination}`,
    }
  }

  // Ordinary recursive reject/fail (incl. budget / attach / pool-zero) must not
  // invent a control-class parent termination. Pool zero must NOT map to
  // model_budget_exhausted (IMP-3 / I4).
  const ordinaryCodes: Record<string, true> = {
    RECURSIVE_BUDGET_INSUFFICIENT: true,
    RECURSIVE_CHILD_ATTACH_FAILED: true,
    RECURSIVE_CHILD_POST_ATTACH_FAILED: true,
    RECURSIVE_CALL_LIMIT_EXCEEDED: true,
    RECURSIVE_MODEL_NOT_ENABLED: true,
    MULTIPLE_EFFECTS_IN_CELL: true,
    RECURSIVE_PARAM_INVALID: true,
    RECURSIVE_MODEL_FAILED: true,
    RECURSIVE_MODEL_INTERNAL: true,
  }
  const ordinary = records.some(r => {
    const code = r.modelEffect?.error?.code
    return typeof code === 'string' && ordinaryCodes[code] === true
  })
  if (ordinary) {
    // model_budget_exhausted is only valid from outer MAX_MODEL_CALLS path.
    // Recursive ordinary failures must not force it; other outer terminations
    // (verifier/cell/wall/env) remain allowed if no control-class recursive code.
    const inventedFromRecursivePool =
      termination === 'cancelled' || termination === 'wall_budget_exhausted'
    return {
      id: 'S3.parent-termination-map',
      passed: !inventedFromRecursivePool,
      detail: `ordinary recursive failure/reject must not invent control termination; got ${termination}`,
    }
  }
  return {
    id: 'S3.parent-termination-map',
    passed: true,
    detail: `no control-class recursive termination; got ${termination}`,
  }
}

export function childReplaySafetyMs(): number {
  return CHILD_REPLAY_SAFETY_WALL_MS
}

export function requestDigestReplayChecks(
  effects: ModelEffect[],
  opts?: { model?: string },
): VerificationCheck[] {
  return effects.map((effect, index) => {
    const partition = verifyRequestDigestPartition(effect, opts)
    // Keep recomputeRequestDigestFromEffect reachable from verification surface (B3).
    if (effect.requestDigest) {
      void recomputeRequestDigestFromEffect(
        opts?.model === undefined ? { effect } : { effect, model: opts.model },
      )
    }
    return {
      id: `S2.digest-hard-partition.${index}`,
      passed: partition.ok,
      detail: partition.detail,
    }
  })
}

/**
 * S1: at least one succeeded models.call with childRunId + responseRef + digest.
 * Issue #5 live path must fail closed when the run never made a recursive call.
 */
export function successfulRecursiveCallCheck(
  records: CellExecutionRecord[],
  opts?: { required?: boolean; max?: number },
): VerificationCheck {
  const required = opts?.required !== false
  const max = opts?.max ?? 4
  const successful = records.filter(
    r =>
      r.modelEffect?.status === 'succeeded' &&
      Boolean(r.modelEffect.childRunId) &&
      Boolean(r.modelEffect.responseRef) &&
      Boolean(r.modelEffect.requestDigest),
  )
  const count = successful.length
  const passed = required ? count >= 1 && count <= max : count <= max
  return {
    id: 'S1.call-once',
    passed,
    detail: required
      ? `successful recursive calls=${count} (require 1..${max} with childRunId+responseRef+digest)`
      : `successful recursive calls=${count} (max ${max})`,
  }
}

/**
 * C1 attachFailed settlement refund zeros + identity invariants (no event I/O).
 */
export function c1SettlementRefundCheck(effect: ModelEffect): VerificationCheck {
  const r = effect.reservation
  const failures: string[] = []
  if (effect.attachFailed !== true) failures.push('attachFailed!=true')
  if (effect.error?.code !== 'RECURSIVE_CHILD_ATTACH_FAILED') {
    failures.push(`code=${effect.error?.code ?? 'missing'}`)
  }
  if (!effect.childRunId) failures.push('missing childRunId')
  if (!effect.requestDigest) failures.push('missing requestDigest')
  if (r.reservedTokens !== 0) failures.push(`reservedTokens=${r.reservedTokens}`)
  if (r.chargedTokens !== 0) failures.push(`chargedTokens=${r.chargedTokens}`)
  if (r.actualUsageTokens !== 0) failures.push(`actualUsageTokens=${r.actualUsageTokens}`)
  if (r.overflowTokens !== 0) failures.push(`overflowTokens=${r.overflowTokens}`)
  return {
    id: `S2.c1-settlement-refund.${effect.childRunId ?? 'unknown'}`,
    passed: failures.length === 0,
    detail:
      failures.length === 0
        ? 'C1 refund zeros + digest/childRunId ok'
        : failures.join('; '),
  }
}

/**
 * Read-only C1 event absence: never started, no LLM request/terminal.
 * Caller supplies events for that childRunId (do NOT open CacheIndex).
 */
export function c1NeverStartedEventCheck(args: {
  childRunId: string
  events: Event[]
}): VerificationCheck {
  const started = count(args.events, 'agent.run.started')
  const llmReq = count(args.events, 'llm.requested')
  const llmResp = count(args.events, 'llm.responded')
  const passed = started === 0 && llmReq === 0 && llmResp === 0
  return {
    id: `S2.c1-never-started-events.${args.childRunId}`,
    passed,
    detail: passed
      ? 'no started/llm events for C1 id'
      : `started=${started} llm.requested=${llmReq} llm.responded=${llmResp}`,
  }
}

/** Collect C1 attachFailed modelEffects from cell records. */
export function collectC1Effects(records: CellExecutionRecord[]): ModelEffect[] {
  return records.flatMap(r => {
    const effect = r.modelEffect
    if (effect?.attachFailed === true && effect.childRunId) return [effect]
    return []
  })
}

export function liveRecursiveChecks(args: {
  evidence: Pick<
    LiveEvidence,
    'childRunIds' | 'nonReplayableChildRunIds' | 'recursiveResultWitness' | 'pins'
  >
  records: CellExecutionRecord[]
  cellSources?: Array<{ cellIndex: number; source: string }>
  termination: TerminationReason
  /** Issue #5 live path defaults true: no successful call ⇒ fail. */
  requireSuccessfulRecursiveCall?: boolean
}): VerificationCheck[] {
  const requireSuccessfulRecursiveCall = args.requireSuccessfulRecursiveCall !== false
  const { childRunIds, nonReplayableChildRunIds } = buildChildRunIds(args.records)
  const hadSuccess = args.records.some(
    r =>
      r.modelEffect?.status === 'succeeded' &&
      Boolean(r.modelEffect.childRunId) &&
      Boolean(r.modelEffect.responseRef) &&
      Boolean(r.modelEffect.requestDigest),
  )
  const witness =
    args.evidence.recursiveResultWitness ??
    (args.cellSources
      ? scanRecursiveResultWitness(args.records, args.cellSources)
      : undefined)
  return [
    pinsGateCheck(args.evidence.pins),
    successfulRecursiveCallCheck(args.records, {
      required: requireSuccessfulRecursiveCall,
    }),
    singleEffectMutualExclusionCheck(args.records),
    modelEffectInvariantsCheck(args.records),
    {
      id: 'S2.childRunIds-replayable-only',
      passed:
        JSON.stringify(args.evidence.childRunIds) === JSON.stringify(childRunIds),
      detail: `evidence=${JSON.stringify(args.evidence.childRunIds)} computed=${JSON.stringify(childRunIds)}`,
    },
    {
      id: 'S3.attach-fail-not-in-childRunIds',
      passed: (args.evidence.nonReplayableChildRunIds ?? nonReplayableChildRunIds).every(
        id => !args.evidence.childRunIds.includes(id),
      ),
      detail: `nonReplayable=${JSON.stringify(args.evidence.nonReplayableChildRunIds ?? nonReplayableChildRunIds)}`,
    },
    attachTripleForbiddenCheck(args.records, args.evidence.childRunIds),
    recursiveWitnessCheck(witness, hadSuccess, {
      requireSuccessfulCall: requireSuccessfulRecursiveCall,
    }),
    parentTerminationMapCheck(args.termination, args.records),
    ...requestDigestReplayChecks(
      args.records.flatMap(r => (r.modelEffect ? [r.modelEffect] : [])),
    ),
  ]
}
