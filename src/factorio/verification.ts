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
  const ok =
    pins.harness === 'factorio-rlm/v4' &&
    pins.kernelProtocol === '2' &&
    pins.bindingSet === 'factorio/v3'
  return {
    id: 'pins.v4-gate',
    passed: ok,
    detail: `${pins.harness}/${pins.kernelProtocol}/${pins.bindingSet}`,
  }
}

export function rejectLegacyPins(pins: {
  harness?: string
  bindingSet?: string
  kernelProtocol?: string
}): VerificationCheck {
  const isLegacy =
    pins.harness === 'factorio-rlm/v3' || pins.bindingSet === 'factorio/v2'
  return {
    id: 'pins.reject-legacy-v3',
    passed: !isLegacy && pins.kernelProtocol === '2',
    detail: isLegacy
      ? 'legacy v3 pins must not be interpreted by v4 runner'
      : 'current pins accepted',
  }
}

export function singleEffectMutualExclusionCheck(
  records: CellExecutionRecord[],
): VerificationCheck {
  const ok = records.every(record => assertEffectsExclusive(record))
  return {
    id: 'S3.single-effect-mutex',
    passed: ok,
    detail: ok ? 'no cell has both factorioEffect and modelEffect' : 'mutex violated',
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
