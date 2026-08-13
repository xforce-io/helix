/**
 * Deterministic refinement workflow coordinator (Issue #13).
 *
 * It deliberately accepts recorded-run adapters rather than owning a second
 * runtime: production adapters must use milkie IOPort/lifecycle/Trace, while
 * tests inject deterministic recorded runs. RCS remains the only mutation
 * boundary and #10 remains the only overlay/hash authority.
 */

import { createHash, createHmac } from 'node:crypto'

import type { IIOPort, ModelResponse } from 'milkie'
import { refsEqual, type HarnessPinsV1, type HarnessStateRef } from '../harness/index.js'
import { RefinementControlStore } from './control-store.js'
import { refinementError } from './errors.js'
import { verifyAutoGrant, verifyPolicyPublisher, type RefinementTrustBundleV1 } from './trust.js'

export type RefinementArtifactRef = {
  kind: string
  id: string
  revision: number
  contentHash: string
}

export type RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1'
  generation: { model: string; maxOutputTokens: number }
  gate: {
    minQualityDelta: number
    maxCostRatio: number
    maxLatencyRatio: number
    maxFailureRateDelta: number
  }
  authority: { manualApprovers: string[]; autoAudience?: string }
}

export type EvaluationSuiteV1 = {
  schemaVersion: 'helix.refinement-suite/v1'
  cases: Array<{ caseId: string; inputRef: string; seed: number; weight: number }>
}

export type RecordedGeneration = {
  generationRunRef: string
  payloadText: string
  modelPins: Record<string, string>
  budget: { reserved: number; charged: number }
}

export type EvaluationMetric = {
  quality: number
  cost: number
  latencyMs: number
  failed: boolean
  replayPassed: boolean
  sharedPins: Record<string, string>
  harnessPins: HarnessPinsV1
  runRef: string
}

export interface RefinementRunAdapter {
  generate(input: {
    sourceRunRefs: string[]
    baselineRef: HarnessStateRef
    policy: RefinementPolicyV1
  }): Promise<RecordedGeneration>
  evaluate(input: {
    arm: 'baseline' | 'candidate'
    case: EvaluationSuiteV1['cases'][number]
    baselineRef: HarnessStateRef
    overlayRef?: HarnessStateRef
    policy: RefinementPolicyV1
  }): Promise<EvaluationMetric>
}

/** Immutable propose ACK: only job identity. Candidate is published via show. */
export type ProposalAck = {
  proposalRef: RefinementArtifactRef
  generationJobRef: RefinementArtifactRef
}

/** Immutable evaluate ACK: only job identity. Report is published via show. */
export type EvaluationAck = {
  evaluationJobRef: RefinementArtifactRef
}

export type AutoPromotionGrantV1 = {
  schemaVersion: 'helix.refinement-auto-grant/v1'
  requestRef: RefinementArtifactRef
  reportRef: RefinementArtifactRef
  candidateRef: RefinementArtifactRef
  subject: string
  audience: string
  issuer: string
  keyId: string
  expiresAt: string
  nonce: string
  trustBundleGeneration?: string
  signature: string
}

export type EvaluationReport = {
  reportRef: RefinementArtifactRef
  candidateRef: RefinementArtifactRef
  passed: boolean
  verdict: 'passed' | 'failed' | 'indeterminate'
  baseline: Aggregate
  candidate: Aggregate
  cases: Array<{ caseId: string; baseline: EvaluationMetric; candidate: EvaluationMetric }>
}

type Aggregate = { quality: number; cost: number; latencyMs: number; failureRate: number }

type Artifact<T> = { ref: RefinementArtifactRef; payload: T }

/** Internal state machine for propose → evaluate → request → promote. */
export class RefinementWorkflow {
  private readonly generationWorkers = new Map<string, Promise<{ candidateRef: RefinementArtifactRef }>>()
  private readonly evaluationWorkers = new Map<string, Promise<EvaluationReport>>()

  constructor(
    private readonly rcs: RefinementControlStore,
    private readonly adapter: RefinementRunAdapter,
    private readonly options: { now?: () => Date } = {},
  ) {}

  /** HRCA-only configuration publication. No unsigned Policy write path exists. */
  publishPolicy(input: { id: string; policy: RefinementPolicyV1; issuer: string; keyId: string; signature: string; bundle: RefinementTrustBundleV1 }): RefinementArtifactRef {
    verifyPolicyPublisher({ bundle: input.bundle, issuer: input.issuer, keyId: input.keyId, payload: input.policy, signature: input.signature })
    validatePolicy(input.policy)
    return this.put('policy', input.id, input.policy).ref
  }

  /** HRCA-only configuration publication. No unsigned Suite write path exists. */
  publishSuite(input: { id: string; suite: EvaluationSuiteV1; issuer: string; keyId: string; signature: string; bundle: RefinementTrustBundleV1 }): RefinementArtifactRef {
    verifyPolicyPublisher({ bundle: input.bundle, issuer: input.issuer, keyId: input.keyId, payload: input.suite, signature: input.signature })
    validateSuite(input.suite)
    return this.put('suite', input.id, input.suite).ref
  }

  /**
   * First assertion transaction boundary: only Proposal + GenerationJob + ACK.
   * Does not run the model; completeGenerationJob does that idempotently.
   */
  beginPropose(input: {
    proposalId: string
    sourceRunRefs: string[]
    baselineRef: HarnessStateRef
    policyRef: RefinementArtifactRef
  }): ProposalAck {
    this.read<RefinementPolicyV1>(input.policyRef, 'policy')
    if (input.sourceRunRefs.length === 0 || new Set(input.sourceRunRefs).size !== input.sourceRunRefs.length) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'proposal requires unique recorded source run refs')
    }
    const existing = this.findById<ProposalAck>('proposal-ack', input.proposalId)
    if (existing !== undefined) return existing.payload

    const proposalArtifact = artifact('proposal', input.proposalId, {
      sourceRunRefs: [...input.sourceRunRefs], baselineRef: input.baselineRef, policyRef: input.policyRef,
    })
    const generationJobArtifact = artifact('generation-job', input.proposalId, {
      proposalRef: proposalArtifact.ref, state: 'running', policyRef: input.policyRef,
      sourceRunRefs: [...input.sourceRunRefs], baselineRef: input.baselineRef,
    })
    const ack: ProposalAck = { proposalRef: proposalArtifact.ref, generationJobRef: generationJobArtifact.ref }
    const ackArtifact = artifact('proposal-ack', input.proposalId, ack)
    this.rcs.commitArtifacts(
      [proposalArtifact, generationJobArtifact, ackArtifact].map(item => ({ ref: refKey(item.ref), payload: item.payload })),
    )
    return ack
  }

  /** Full propose path for fixtures: begin + complete. */
  async propose(input: {
    proposalId: string
    sourceRunRefs: string[]
    baselineRef: HarnessStateRef
    policyRef: RefinementArtifactRef
  }): Promise<ProposalAck> {
    const ack = this.beginPropose(input)
    await this.completeGenerationJob(ack.generationJobRef)
    return ack
  }

  /** Idempotent worker: same proposal never starts a second generation run. */
  async completeGenerationJob(jobRef: RefinementArtifactRef): Promise<{ candidateRef: RefinementArtifactRef }> {
    const key = refKey(jobRef)
    const existing = this.generationWorkers.get(key)
    if (existing !== undefined) return existing
    const started = this.runGenerationJob(jobRef).finally(() => {
      this.generationWorkers.delete(key)
    })
    this.generationWorkers.set(key, started)
    return started
  }

  private async runGenerationJob(jobRef: RefinementArtifactRef): Promise<{ candidateRef: RefinementArtifactRef }> {
    const shown = this.showGenerationJob(jobRef)
    if (shown.candidateRef !== undefined) return { candidateRef: shown.candidateRef }

    const job = this.read<{
      proposalRef: RefinementArtifactRef
      policyRef: RefinementArtifactRef
      sourceRunRefs: string[]
      baselineRef: HarnessStateRef
      state: string
    }>(jobRef, 'generation-job')
    const policy = this.read<RefinementPolicyV1>(job.policyRef, 'policy')
    const generated = await this.adapter.generate({
      sourceRunRefs: job.sourceRunRefs,
      baselineRef: job.baselineRef,
      policy,
    })
    if (!nonEmpty(generated.generationRunRef) || !nonEmpty(generated.payloadText)) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'generation adapter did not return a recorded run and one payload')
    }
    // Another worker may have finished while we generated; re-check before admit.
    const raced = this.showGenerationJob(jobRef)
    if (raced.candidateRef !== undefined) return { candidateRef: raced.candidateRef }

    const candidateId = `candidate-${jobRef.id}`
    const candidatePayloadFor = (admitted: { generationRunRef: string; baseBaselineRef: HarnessStateRef; overlayRef: HarnessStateRef; payloadHash: string }) => ({
      jobRef,
      generationRunRef: admitted.generationRunRef,
      baseBaselineRef: admitted.baseBaselineRef,
      policyRef: job.policyRef,
      overlayRef: admitted.overlayRef,
      payloadHash: admitted.payloadHash,
      modelPins: generated.modelPins,
      budget: generated.budget,
    })
    const admitted = this.rcs.admitCandidate({
      candidateId,
      generationRunRef: generated.generationRunRef,
      baseBaselineRef: job.baselineRef,
      payloadText: generated.payloadText,
      artifacts: admittedRecord => {
        const candidateArtifact = artifact('candidate', candidateId, candidatePayloadFor(admittedRecord))
        const event = artifact('generation-job-event', `${jobRef.id}:completed`, { jobRef, type: 'completed' })
        const result = artifact('generation-job-result', jobRef.id, { jobRef, candidateRef: candidateArtifact.ref })
        return [candidateArtifact, event, result].map(item => ({ ref: refKey(item.ref), payload: item.payload }))
      },
    })
    return { candidateRef: artifact('candidate', candidateId, candidatePayloadFor(admitted)).ref }
  }

  /** First assertion transaction: only EvaluationJob + ACK. */
  beginEvaluate(input: {
    candidateRef: RefinementArtifactRef
    policyRef: RefinementArtifactRef
    suiteRef: RefinementArtifactRef
  }): EvaluationAck {
    const candidate = this.read<CandidatePayload>(input.candidateRef, 'candidate')
    this.read<RefinementPolicyV1>(input.policyRef, 'policy')
    this.read<EvaluationSuiteV1>(input.suiteRef, 'suite')
    if (!sameRef(candidate.policyRef, input.policyRef)) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'candidate and evaluation policy refs differ')
    }
    const jobId = `${input.candidateRef.contentHash}-${input.suiteRef.contentHash}`
    const existingAck = this.findById<EvaluationAck>('evaluation-ack', jobId)
    if (existingAck !== undefined) return existingAck.payload

    const evaluationJobArtifact = artifact('evaluation-job', jobId, {
      candidateRef: input.candidateRef, policyRef: input.policyRef, suiteRef: input.suiteRef, state: 'running',
    })
    const ack: EvaluationAck = { evaluationJobRef: evaluationJobArtifact.ref }
    const ackArtifact = artifact('evaluation-ack', jobId, ack)
    this.rcs.commitArtifacts(
      [evaluationJobArtifact, ackArtifact].map(item => ({ ref: refKey(item.ref), payload: item.payload })),
    )
    return ack
  }

  async evaluate(input: {
    candidateRef: RefinementArtifactRef
    policyRef: RefinementArtifactRef
    suiteRef: RefinementArtifactRef
  }): Promise<EvaluationReport> {
    const ack = this.beginEvaluate(input)
    return this.completeEvaluationJob(ack.evaluationJobRef)
  }

  async completeEvaluationJob(jobRef: RefinementArtifactRef): Promise<EvaluationReport> {
    const key = refKey(jobRef)
    const existing = this.evaluationWorkers.get(key)
    if (existing !== undefined) return existing
    const started = this.runEvaluationJob(jobRef).finally(() => {
      this.evaluationWorkers.delete(key)
    })
    this.evaluationWorkers.set(key, started)
    return started
  }

  private async runEvaluationJob(jobRef: RefinementArtifactRef): Promise<EvaluationReport> {
    const shown = this.showEvaluationJob(jobRef)
    if (shown.reportRef !== undefined) return this.readReport(shown.reportRef)

    const job = this.read<{
      candidateRef: RefinementArtifactRef
      policyRef: RefinementArtifactRef
      suiteRef: RefinementArtifactRef
    }>(jobRef, 'evaluation-job')
    const candidate = this.read<CandidatePayload>(job.candidateRef, 'candidate')
    const policy = this.read<RefinementPolicyV1>(job.policyRef, 'policy')
    const suite = this.read<EvaluationSuiteV1>(job.suiteRef, 'suite')
    const cases: EvaluationReport['cases'] = []
    for (const item of suite.cases) {
      const baseline = await this.adapter.evaluate({ arm: 'baseline', case: item, baselineRef: candidate.baseBaselineRef, policy })
      const candidateArm = await this.adapter.evaluate({
        arm: 'candidate', case: item, baselineRef: candidate.baseBaselineRef, overlayRef: candidate.overlayRef, policy,
      })
      assertEvaluationArmPins({
        baseline, candidate: candidateArm, baselineRef: candidate.baseBaselineRef, overlayRef: candidate.overlayRef,
      })
      if (!samePins(baseline.sharedPins, candidateArm.sharedPins)) {
        throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'baseline and candidate shared execution pins differ')
      }
      cases.push({ caseId: item.caseId, baseline, candidate: candidateArm })
    }
    const baseline = aggregate(cases.map((entry, index) => ({ metric: entry.baseline, weight: suite.cases[index]!.weight })))
    const candidateAggregate = aggregate(cases.map((entry, index) => ({ metric: entry.candidate, weight: suite.cases[index]!.weight })))
    const indeterminate = cases.some(entry => !entry.baseline.replayPassed || !entry.candidate.replayPassed)
    const passed = !indeterminate &&
      candidateAggregate.quality - baseline.quality >= policy.gate.minQualityDelta &&
      ratioOk(candidateAggregate.cost, baseline.cost, policy.gate.maxCostRatio) &&
      ratioOk(candidateAggregate.latencyMs, baseline.latencyMs, policy.gate.maxLatencyRatio) &&
      candidateAggregate.failureRate - baseline.failureRate <= policy.gate.maxFailureRateDelta

    // Race-safe: another worker may have published the report already.
    const raced = this.showEvaluationJob(jobRef)
    if (raced.reportRef !== undefined) return this.readReport(raced.reportRef)

    const reportBody = {
      candidateRef: job.candidateRef,
      passed,
      verdict: (indeterminate ? 'indeterminate' : passed ? 'passed' : 'failed') as EvaluationReport['verdict'],
      baseline,
      candidate: candidateAggregate,
      cases,
      policyRef: job.policyRef,
      suiteRef: job.suiteRef,
    }
    const reportArtifact = artifact('evaluation-report', jobRef.id, reportBody)
    const event = artifact('evaluation-job-event', `${jobRef.id}:completed`, { jobRef, type: 'completed' })
    const result = artifact('evaluation-job-result', jobRef.id, { jobRef, reportRef: reportArtifact.ref })
    this.rcs.commitArtifacts(
      [reportArtifact, event, result].map(item => ({ ref: refKey(item.ref), payload: item.payload })),
    )
    return this.readReport(reportArtifact.ref)
  }

  readReport(ref: RefinementArtifactRef): EvaluationReport {
    const payload = this.read<Omit<EvaluationReport, 'reportRef'> & { policyRef: RefinementArtifactRef; suiteRef: RefinementArtifactRef }>(ref, 'evaluation-report')
    const { policyRef: _policyRef, suiteRef: _suiteRef, ...report } = payload
    return { ...report, reportRef: ref }
  }

  showGenerationJob(ref: RefinementArtifactRef): { jobRef: RefinementArtifactRef; candidateRef?: RefinementArtifactRef } {
    this.read<{ proposalRef: RefinementArtifactRef; state: string; policyRef: RefinementArtifactRef }>(ref, 'generation-job')
    const result = this.findById<{ jobRef: RefinementArtifactRef; candidateRef: RefinementArtifactRef }>('generation-job-result', ref.id)
    return result === undefined ? { jobRef: ref } : { jobRef: ref, candidateRef: result.payload.candidateRef }
  }

  showEvaluationJob(ref: RefinementArtifactRef): { jobRef: RefinementArtifactRef; reportRef?: RefinementArtifactRef } {
    this.read<{ candidateRef: RefinementArtifactRef; policyRef: RefinementArtifactRef; suiteRef: RefinementArtifactRef }>(ref, 'evaluation-job')
    const result = this.findById<{ jobRef: RefinementArtifactRef; reportRef: RefinementArtifactRef }>('evaluation-job-result', ref.id)
    return result === undefined ? { jobRef: ref } : { jobRef: ref, reportRef: result.payload.reportRef }
  }

  request(report: EvaluationReport): RefinementArtifactRef {
    if (report.verdict !== 'passed') {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'only passed reports can create a promotion request')
    }
    const existing = this.findById<{ reportRef: RefinementArtifactRef }>('promotion-request', report.reportRef.contentHash)
    if (existing !== undefined) return existing.ref
    return this.put('promotion-request', report.reportRef.contentHash, { reportRef: report.reportRef, candidateRef: report.candidateRef }).ref
  }

  manualPromote(input: { requestRef: RefinementArtifactRef; subject: string; policyRef: RefinementArtifactRef }): { overlayRef: HarnessStateRef; decisionRef: RefinementArtifactRef } {
    const request = this.read<{ reportRef: RefinementArtifactRef; candidateRef: RefinementArtifactRef }>(input.requestRef, 'promotion-request')
    const report = this.read<StoredReport & { policyRef: RefinementArtifactRef; candidateRef: RefinementArtifactRef }>(request.reportRef, 'evaluation-report')
    const policy = this.read<RefinementPolicyV1>(input.policyRef, 'policy')
    if (!sameRef(report.policyRef, input.policyRef) || !sameRef(report.candidateRef, request.candidateRef) || !policy.authority.manualApprovers.includes(input.subject) || report.verdict !== 'passed') {
      throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'manual actor is not authorized or report no longer passes')
    }
    const candidate = this.read<CandidatePayload>(request.candidateRef, 'candidate')
    const prior = this.findById<{ subject: string; outcome: 'approved' | 'rejected' }>('promotion-decision', input.requestRef.contentHash)
    if (prior !== undefined) {
      if (prior.payload.outcome === 'approved' && prior.payload.subject === input.subject) {
        return { overlayRef: candidate.overlayRef, decisionRef: prior.ref }
      }
      throw refinementError('REFINEMENT_ASSERTION_REPLAYED', 'promotion request already has a terminal decision')
    }
    const decision = artifact('promotion-decision', input.requestRef.contentHash, { requestRef: input.requestRef, subject: input.subject, outcome: 'approved' as const })
    const association = artifact('association', input.requestRef.contentHash, { requestRef: input.requestRef, overlayRef: candidate.overlayRef, candidateRef: request.candidateRef })
    const overlayRef = this.rcs.promoteCandidateWithArtifacts({
      requestKey: refKey(input.requestRef),
      candidateId: candidateIdFromRef(request.candidateRef),
      artifacts: [{ ref: refKey(decision.ref), payload: decision.payload }, { ref: refKey(association.ref), payload: association.payload }],
    })
    return { overlayRef, decisionRef: decision.ref }
  }

  manualReject(input: { requestRef: RefinementArtifactRef; subject: string; policyRef: RefinementArtifactRef }): RefinementArtifactRef {
    const request = this.read<{ reportRef: RefinementArtifactRef; candidateRef: RefinementArtifactRef }>(input.requestRef, 'promotion-request')
    const policy = this.read<RefinementPolicyV1>(input.policyRef, 'policy')
    if (!policy.authority.manualApprovers.includes(input.subject)) {
      throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'manual actor is not authorized')
    }
    const decision = artifact('promotion-decision', input.requestRef.contentHash, {
      requestRef: input.requestRef, candidateRef: request.candidateRef, subject: input.subject, outcome: 'rejected' as const,
    })
    this.rcs.rejectRequestWithArtifact(refKey(input.requestRef), { ref: refKey(decision.ref), payload: decision.payload })
    return decision.ref
  }

  autoPromote(input: {
    requestRef: RefinementArtifactRef
    policyRef: RefinementArtifactRef
    grant: AutoPromotionGrantV1
    bundle: RefinementTrustBundleV1
  }): { overlayRef: HarnessStateRef; decisionRef: RefinementArtifactRef } {
    const request = this.read<{ reportRef: RefinementArtifactRef; candidateRef: RefinementArtifactRef }>(input.requestRef, 'promotion-request')
    const report = this.read<StoredReport & { candidateRef: RefinementArtifactRef; policyRef: RefinementArtifactRef }>(request.reportRef, 'evaluation-report')
    const policy = this.read<RefinementPolicyV1>(input.policyRef, 'policy')
    const grant = input.grant
    const now = (this.options.now ?? (() => new Date()))()
    const { signature, trustBundleGeneration, ...claims } = grant
    verifyAutoGrant({
      bundle: input.bundle,
      generation: trustBundleGeneration ?? '',
      issuer: grant.issuer,
      keyId: grant.keyId,
      payload: { ...claims, trustBundleGeneration },
      signature,
      now,
    })
    if (
      grant.schemaVersion !== 'helix.refinement-auto-grant/v1' ||
      policy.authority.autoAudience === undefined ||
      grant.audience !== policy.authority.autoAudience ||
      !sameRef(grant.requestRef, input.requestRef) ||
      !sameRef(grant.reportRef, request.reportRef) ||
      !sameRef(grant.candidateRef, request.candidateRef) ||
      !sameRef(report.policyRef, input.policyRef) || !sameRef(report.candidateRef, request.candidateRef) ||
      !nonEmpty(grant.subject) || !nonEmpty(grant.nonce) ||
      Number.isNaN(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now.getTime()
    ) throw refinementError('REFINEMENT_GRANT_INVALID', 'auto promotion grant is invalid')
    if (report.verdict !== 'passed') throw refinementError('REFINEMENT_GRANT_INVALID', 'report does not pass current deterministic gate')
    const consumptionId = `${grant.issuer}:${grant.keyId}:${grant.nonce}`
    if (this.findById('grant-consumption', consumptionId) !== undefined) {
      throw refinementError('REFINEMENT_GRANT_REPLAYED', 'auto promotion grant nonce was already consumed')
    }
    const candidate = this.read<CandidatePayload>(request.candidateRef, 'candidate')
    if (this.findById('promotion-decision', input.requestRef.contentHash) !== undefined) {
      throw refinementError('REFINEMENT_GRANT_REPLAYED', 'promotion request already has a terminal decision')
    }
    const decision = artifact('promotion-decision', input.requestRef.contentHash, { requestRef: input.requestRef, subject: grant.subject, outcome: 'approved' as const, mode: 'auto' as const })
    const association = artifact('association', input.requestRef.contentHash, { requestRef: input.requestRef, overlayRef: candidate.overlayRef, candidateRef: request.candidateRef })
    const consumption = artifact('grant-consumption', consumptionId, { requestRef: input.requestRef, issuer: grant.issuer, keyId: grant.keyId, nonce: grant.nonce })
    const overlayRef = this.rcs.promoteCandidateWithArtifacts({
      requestKey: refKey(input.requestRef),
      candidateId: candidateIdFromRef(request.candidateRef),
      artifacts: [decision, association, consumption].map(item => ({ ref: refKey(item.ref), payload: item.payload })),
    })
    return { overlayRef, decisionRef: decision.ref }
  }

  private put<T>(kind: string, id: string, payload: T): Artifact<T> {
    const value = artifact(kind, id, payload)
    this.rcs.putArtifact(refKey(value.ref), value.payload)
    return value
  }

  private read<T>(ref: RefinementArtifactRef, expectedKind: string): T {
    if (ref.kind !== expectedKind) throw refinementError('REFINEMENT_CANDIDATE_INVALID', `expected ${expectedKind} ref`)
    const payload = this.rcs.getArtifact<T>(refKey(ref))
    if (payload === undefined) throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'artifact not found')
    return payload
  }

  private findById<T>(kind: string, id: string): Artifact<T> | undefined {
    const prefix = `${kind}:${id}@0#`
    const found = this.rcs.listArtifacts().find(entry => entry.ref.startsWith(prefix))
    if (found === undefined) return undefined
    const ref = parseRef(found.ref)
    return { ref, payload: found.payload as T }
  }
}

type CandidatePayload = { policyRef: RefinementArtifactRef; baseBaselineRef: HarnessStateRef; overlayRef: HarnessStateRef }
type StoredReport = { verdict: EvaluationReport['verdict'] }

/** IOPort-only generation adapter: no provider is reachable outside milkie. */
export function createIOPortGenerationAdapter(input: {
  port: IIOPort
  model: string
  generationRunRef: string
  evaluate: RefinementRunAdapter['evaluate']
}): Pick<RefinementRunAdapter, 'generate'> & Pick<RefinementRunAdapter, 'evaluate'> {
  return {
    async generate(args) {
      const response: ModelResponse = await input.port.invokeLLM({
        model: input.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(args) }] }],
        maxTokens: args.policy.generation.maxOutputTokens,
      })
      const texts = response.content.filter(c => c.type === 'text').map(c => c.text)
      if (texts.length !== 1) throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'generation run must output exactly one text envelope')
      return {
        generationRunRef: input.generationRunRef,
        payloadText: texts[0]!, modelPins: { model: input.model },
        budget: { reserved: args.policy.generation.maxOutputTokens, charged: response.usage?.outputTokens ?? 0 },
      }
    },
    evaluate: input.evaluate,
  }
}

export function signAutoPromotionGrant(
  claims: Omit<AutoPromotionGrantV1, 'signature'>,
  secret: string,
): AutoPromotionGrantV1 {
  return { ...claims, signature: createHmac('sha256', secret).update(stable(claims)).digest('hex') }
}

function artifact<T>(kind: string, id: string, payload: T): Artifact<T> {
  const contentHash = hash(payload)
  return { ref: { kind, id, revision: 0, contentHash }, payload }
}
function refKey(ref: RefinementArtifactRef): string { return `${ref.kind}:${ref.id}@${ref.revision}#${ref.contentHash}` }
function parseRef(value: string): RefinementArtifactRef {
  const match = /^(.+):(.+)@(\d+)#([0-9a-f]{64})$/.exec(value)
  if (match === null) throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'stored artifact ref is malformed')
  return { kind: match[1]!, id: match[2]!, revision: Number(match[3]), contentHash: match[4]! }
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex') }
function stable(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value !== 'object' || value === undefined) throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'artifact is not JSON-shaped')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}
function validatePolicy(policy: RefinementPolicyV1): void {
  if (policy.schemaVersion !== 'helix.refinement-policy/v1' || !nonEmpty(policy.generation.model) || !Number.isSafeInteger(policy.generation.maxOutputTokens) || policy.generation.maxOutputTokens <= 0 || policy.authority.manualApprovers.length === 0) throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'policy schema is invalid')
  for (const value of Object.values(policy.gate)) if (!Number.isFinite(value) || value < 0) throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'policy gate is invalid')
}
function validateSuite(suite: EvaluationSuiteV1): void {
  if (suite.schemaVersion !== 'helix.refinement-suite/v1' || suite.cases.length === 0 || new Set(suite.cases.map(c => c.caseId)).size !== suite.cases.length) throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'suite schema is invalid')
  for (const item of suite.cases) if (!nonEmpty(item.inputRef) || !Number.isSafeInteger(item.seed) || item.seed < 0 || !Number.isFinite(item.weight) || item.weight <= 0) throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'suite case is invalid')
}
function aggregate(entries: Array<{ metric: EvaluationMetric; weight: number }>): Aggregate {
  const total = entries.reduce((sum, item) => sum + item.weight, 0)
  return { quality: entries.reduce((sum, item) => sum + item.metric.quality * item.weight, 0) / total, cost: entries.reduce((sum, item) => sum + item.metric.cost, 0), latencyMs: entries.reduce((sum, item) => sum + item.metric.latencyMs, 0), failureRate: entries.reduce((sum, item) => sum + (item.metric.failed ? item.weight : 0), 0) / total }
}
function assertEvaluationArmPins(input: {
  baseline: EvaluationMetric
  candidate: EvaluationMetric
  baselineRef: HarnessStateRef
  overlayRef: HarnessStateRef
}): void {
  const b = input.baseline.harnessPins
  const c = input.candidate.harnessPins
  if (
    b.overlayRef !== undefined ||
    c.overlayRef === undefined ||
    !refsEqual(b.baselineRef, input.baselineRef) ||
    !refsEqual(c.baselineRef, input.baselineRef) ||
    !refsEqual(c.overlayRef, input.overlayRef) ||
    b.codeProtocolPin !== c.codeProtocolPin ||
    b.schemaVersion !== c.schemaVersion ||
    JSON.stringify(b.catalogCards) !== JSON.stringify(c.catalogCards) ||
    b.compatibilityDecision.documentAcceptsCodeProtocolPin !== c.compatibilityDecision.documentAcceptsCodeProtocolPin ||
    b.compatibilityDecision.catalogResolved !== c.compatibilityDecision.catalogResolved
  ) throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'evaluation arms do not use ordinary matching #10 pins')
  for (const metric of [input.baseline, input.candidate]) {
    if (!Number.isFinite(metric.quality) || !Number.isFinite(metric.cost) || !Number.isFinite(metric.latencyMs) || metric.cost < 0 || metric.latencyMs < 0) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'evaluation metric is invalid')
    }
  }
}

function ratioOk(candidate: number, baseline: number, max: number): boolean { return baseline === 0 ? candidate === 0 : candidate / baseline <= max }
function samePins(a: Record<string, string>, b: Record<string, string>): boolean { return stable(a) === stable(b) }
function sameRef(a: RefinementArtifactRef, b: RefinementArtifactRef): boolean { return refKey(a) === refKey(b) }
function candidateIdFromRef(ref: RefinementArtifactRef): string { return ref.id }
function nonEmpty(value: string): boolean { return value.length > 0 }
