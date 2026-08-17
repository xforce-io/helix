import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { HarnessDocument, HarnessPinsV1 } from '../../src/harness/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { RefinementError } from '../../src/refinement/errors.js'
import {
  type EvaluationMetric,
  type RefinementPolicyV1,
  type RefinementRunAdapter,
  RefinementWorkflow,
  signAutoPromotionGrant,
  type EvaluationSuiteV1,
  type RefinementArtifactRef,
} from '../../src/refinement/workflow.js'
import { FIXTURE_EXTRACTOR_DIGEST, signedConfiguration } from './fixtures.js'

const document: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: { systemInstructionTemplate: 'base', taskNarrativeTemplate: 'task', protocolRules: ['verify'], termination: { successSource: 'scenario-verifier', stopConditions: ['done'] } },
  catalogCards: [], compatibility: { codeProtocolPins: ['fixture/v1'] },
}

const policy: RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1',
  generation: { model: 'fixture-model', maxOutputTokens: 100 },
  extractorDigest: FIXTURE_EXTRACTOR_DIGEST,
  gate: { minQualityDelta: 0.1, maxCostRatio: 1.1, maxLatencyRatio: 1.1, maxFailureRateDelta: 0 },
  authority: { manualApprovers: ['researcher'] },
}
const suite: EvaluationSuiteV1 = {
  schemaVersion: 'helix.refinement-suite/v1',
  cases: [{ caseId: 'holdout-1', inputRef: 'input:1', seed: 7, weight: 1 }],
}

function pins(base: ReturnType<RefinementControlStore['publishBaseline']>, overlay?: ReturnType<RefinementControlStore['publishBaseline']>): HarnessPinsV1 {
  return {
    format: 'harness/v1', codeProtocolPin: 'fixture/v1', baselineRef: base,
    ...(overlay === undefined ? {} : { overlayRef: overlay }),
    harnessContentHash: 'b'.repeat(64), schemaVersion: 'helix.harness/v1', catalogCards: [],
    compatibilityDecision: { documentAcceptsCodeProtocolPin: true, catalogResolved: true },
  }
}

function adapter(base: ReturnType<RefinementControlStore['publishBaseline']>): RefinementRunAdapter {
  return {
    async generate(input) {
      return {
        generationRunRef: input.reservedGenerationRunRef,
        payloadText: JSON.stringify({ schemaVersion: 'helix.harness-overlay/v1', baseBaselineRef: base, changes: { systemInstructionTemplate: 'candidate' } }),
        modelPins: { model: 'fixture-model', provider: 'recorded-ioport' },
        budget: { reserved: 100, charged: 12 },
      }
    },
    async evaluate(input): Promise<EvaluationMetric> {
      const candidate = input.arm === 'candidate'
      return {
        quality: candidate ? 0.9 : 0.7, cost: candidate ? 10 : 10, latencyMs: candidate ? 100 : 100,
        failed: false, replayPassed: true, sharedPins: { model: 'fixture-model', seed: String(input.case.seed), runner: 'fixture' },
        harnessPins: pins(base, candidate ? input.overlayRef : undefined),
        runRef: input.reservedRunRef,
        extractorDigest: FIXTURE_EXTRACTOR_DIGEST,
      }
    },
  }
}

function refinementError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RefinementError)
    return true
  })
}

async function proposeCandidate(
  workflow: RefinementWorkflow,
  input: { proposalId: string; sourceRunRefs: string[]; baselineRef: ReturnType<RefinementControlStore['publishBaseline']>; policyRef: RefinementArtifactRef },
): Promise<{ generationJobRef: RefinementArtifactRef; candidateRef: RefinementArtifactRef }> {
  const ack = await workflow.propose(input)
  const shown = workflow.showGenerationJob(ack.generationJobRef)
  assert.ok(shown.candidateRef)
  return { generationJobRef: ack.generationJobRef, candidateRef: shown.candidateRef }
}

test('S1-S4 E2E: recorded proposal → isolated evaluation → request → manual promotion → future selection', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-refinement-e2e-'))
  try {
    const rcs = new RefinementControlStore({ rootDir })
    const base = rcs.publishBaseline(document, { id: 'base', revision: 0 })
    const workflow = new RefinementWorkflow(rcs, adapter(base))
    const policyRef = workflow.publishPolicy(signedConfiguration('policy-v1', 'policy', policy))
    const suiteRef = workflow.publishSuite(signedConfiguration('suite-v1', 'suite', suite))

    const proposal = await proposeCandidate(workflow, { proposalId: 'proposal-1', sourceRunRefs: ['recorded-source-1'], baselineRef: base, policyRef })
    assert.ok(rcs.listArtifacts().some(entry => entry.ref.startsWith('generation-job-event:proposal-1:completed@')))
    const report = await workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
    assert.ok(rcs.listArtifacts().some(entry => entry.ref.startsWith('evaluation-job-result:')))
    const evaluationJob = rcs.listArtifacts().find(entry => entry.ref.startsWith('evaluation-job:'))!
    const evaluationRef = {
      kind: 'evaluation-job',
      id: evaluationJob.ref.match(/^evaluation-job:(.+)@0#/)![1]!,
      revision: 0,
      contentHash: evaluationJob.ref.match(/#([0-9a-f]{64})$/)![1]!,
    }
    assert.equal(workflow.showEvaluationJob(evaluationRef).reportRef?.contentHash, report.reportRef.contentHash)
    assert.deepEqual(
      await workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef }),
      report,
    )
    assert.equal(report.verdict, 'passed')
    assert.equal(report.cases.length, 1)
    assert.equal(report.cases[0]!.baseline.sharedPins.model, report.cases[0]!.candidate.sharedPins.model)
    const requestRef = workflow.request(report)

    const candidate = rcs.getArtifact<{ overlayRef: ReturnType<RefinementControlStore['publishBaseline']> }>(
      `${proposal.candidateRef.kind}:${proposal.candidateRef.id}@${proposal.candidateRef.revision}#${proposal.candidateRef.contentHash}`,
    )!
    refinementError(() => rcs.select('external', { baselineRef: base, overlayRef: candidate.overlayRef }, []))
    refinementError(() => workflow.manualPromote({ requestRef, subject: 'model-skill', policyRef }))

    const promotion = workflow.manualPromote({ requestRef, subject: 'researcher', policyRef })
    assert.equal(promotion.overlayRef.contentHash, candidate.overlayRef.contentHash)
    assert.equal(
      rcs.select('external', { baselineRef: base, overlayRef: promotion.overlayRef }, []).overlayRef?.contentHash,
      promotion.overlayRef.contentHash,
    )

    const reopened = new RefinementControlStore({ rootDir })
    assert.equal(
      reopened.select('external', { baselineRef: base, overlayRef: promotion.overlayRef }, []).overlayRef?.contentHash,
      promotion.overlayRef.contentHash,
    )
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('S1 propose ACK is immutable before generation completes and retries share candidate', async () => {
  let generateCalls = 0
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'ack-base', revision: 0 })
  const slow = adapter(base)
  slow.generate = async input => {
    generateCalls += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    return {
      generationRunRef: input.reservedGenerationRunRef,
      payloadText: JSON.stringify({
        schemaVersion: 'helix.harness-overlay/v1',
        baseBaselineRef: base,
        changes: { systemInstructionTemplate: 'candidate' },
      }),
      modelPins: { model: 'fixture-model' },
      budget: { reserved: 1, charged: 1 },
    }
  }
  const workflow = new RefinementWorkflow(rcs, slow)
  const policyRef = workflow.publishPolicy(signedConfiguration('ack-policy', 'policy', policy))
  const ack = workflow.beginPropose({
    proposalId: 'ack-proposal',
    sourceRunRefs: ['source'],
    baselineRef: base,
    policyRef,
  })
  assert.equal(workflow.showGenerationJob(ack.generationJobRef).candidateRef, undefined)
  assert.deepEqual(workflow.beginPropose({
    proposalId: 'ack-proposal',
    sourceRunRefs: ['source'],
    baselineRef: base,
    policyRef,
  }), ack)
  const [a, b] = await Promise.all([
    workflow.completeGenerationJob(ack.generationJobRef),
    workflow.completeGenerationJob(ack.generationJobRef),
  ])
  assert.equal(generateCalls, 1)
  assert.deepEqual(a, b)
  assert.ok(workflow.showGenerationJob(ack.generationJobRef).candidateRef)
})

test('S2 replay failure makes the deterministic report indeterminate and blocks request', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'replay-base', revision: 0 })
  const replayFailing = adapter(base)
  const original = replayFailing.evaluate
  replayFailing.evaluate = async input => ({ ...(await original(input)), replayPassed: input.arm === 'baseline' })
  const workflow = new RefinementWorkflow(rcs, replayFailing)
  const policyRef = workflow.publishPolicy(signedConfiguration('replay-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('replay-suite', 'suite', suite))
  const proposal = await proposeCandidate(workflow, { proposalId: 'replay-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })
  const report = await workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
  assert.equal(report.verdict, 'indeterminate')
  refinementError(() => workflow.request(report))
})

test('S2 evaluation rejects forged ordinary #10 arm pins before report publication', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'pin-base', revision: 0 })
  const bad = adapter(base)
  bad.evaluate = async input => ({
    quality: 1, cost: 1, latencyMs: 1, failed: false, replayPassed: true, sharedPins: { same: 'yes' },
    harnessPins: pins(base, input.arm === 'candidate' ? undefined : undefined),
    runRef: input.reservedRunRef,
    extractorDigest: FIXTURE_EXTRACTOR_DIGEST,
  })
  const workflow = new RefinementWorkflow(rcs, bad)
  const policyRef = workflow.publishPolicy(signedConfiguration('pin-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('pin-suite', 'suite', suite))
  const proposal = await proposeCandidate(workflow, { proposalId: 'pin-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })
  await assert.rejects(
    workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef }),
    (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CANDIDATE_INVALID',
  )
})

test('S2 failed candidate metric is recorded and does not truncate the remaining suite', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'failed-candidate-base', revision: 0 })
  const threeCases: EvaluationSuiteV1 = {
    schemaVersion: 'helix.refinement-suite/v1',
    cases: [
      { caseId: 'holdout-1', inputRef: 'input:1', seed: 1, weight: 1 },
      { caseId: 'holdout-2', inputRef: 'input:2', seed: 2, weight: 1 },
      { caseId: 'holdout-3', inputRef: 'input:3', seed: 3, weight: 1 },
    ],
  }
  let calls = 0
  const recorded = adapter(base)
  const original = recorded.evaluate
  recorded.evaluate = async input => {
    calls += 1
    const metric = await original(input)
    return input.arm === 'candidate' && input.case.caseId === 'holdout-2'
      ? { ...metric, quality: 0, failed: true }
      : metric
  }
  const workflow = new RefinementWorkflow(rcs, recorded)
  const policyRef = workflow.publishPolicy(signedConfiguration('failed-candidate-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('failed-candidate-suite', 'suite', threeCases))
  const proposal = await proposeCandidate(workflow, { proposalId: 'failed-candidate-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })

  const report = await workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
  assert.equal(calls, 6)
  assert.equal(report.cases.length, 3)
  assert.equal(report.cases[1]!.candidate.quality, 0)
  assert.equal(report.cases[1]!.candidate.failed, true)
  assert.equal(report.verdict, 'failed')
  assert.equal(rcs.listArtifacts().filter(entry => entry.ref.startsWith('evaluation-arm-terminal:')).length, 6)
})

test('S1 restart after a started arm fails closed without replaying completed trace identity', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-evaluation-retry-'))
  try {
    const rcs = new RefinementControlStore({ rootDir })
    const base = rcs.publishBaseline(document, { id: 'restart-evaluation-base', revision: 0 })
    let firstCalls = 0
    const interrupted = adapter(base)
    const original = interrupted.evaluate
    interrupted.evaluate = async input => {
      firstCalls += 1
      if (input.arm === 'candidate') throw new Error('simulated process interruption after live trace starts')
      return original(input)
    }
    const first = new RefinementWorkflow(rcs, interrupted)
    const policyRef = first.publishPolicy(signedConfiguration('restart-evaluation-policy', 'policy', policy))
    const suiteRef = first.publishSuite(signedConfiguration('restart-evaluation-suite', 'suite', suite))
    const proposal = await proposeCandidate(first, { proposalId: 'restart-evaluation-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })
    const ack = first.beginEvaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
    await assert.rejects(first.completeEvaluationJob(ack.evaluationJobRef), /simulated process interruption/)
    assert.equal(firstCalls, 2)
    assert.equal(rcs.listArtifacts().filter(entry => entry.ref.startsWith('evaluation-arm-terminal:')).length, 1)

    const reopened = new RefinementControlStore({ rootDir })
    let retryCalls = 0
    const resumed = new RefinementWorkflow(reopened, {
      generate: async () => { throw new Error('generation is not part of evaluation recovery') },
      evaluate: async () => {
        retryCalls += 1
        throw new Error('a started arm must not be replayed')
      },
    })
    await assert.rejects(
      resumed.completeEvaluationJob(ack.evaluationJobRef),
      (error: unknown) => error instanceof RefinementError && /cannot be retried safely/.test(error.message),
    )
    assert.equal(retryCalls, 0)
    assert.equal(reopened.listArtifacts().filter(entry => entry.ref.startsWith('evaluation-arm-terminal:')).length, 1)
    assert.equal(reopened.listArtifacts().filter(entry => entry.ref.startsWith('evaluation-arm-started:')).length, 2)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('S1 concurrent evaluators allow only the RCS arm claimant to invoke the adapter', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-evaluation-claim-'))
  try {
    const firstStore = new RefinementControlStore({ rootDir })
    const base = firstStore.publishBaseline(document, { id: 'claim-base', revision: 0 })
    let firstCalls = 0
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const releasePromise = new Promise<void>(resolve => { release = resolve })
    const blocking = adapter(base)
    const original = blocking.evaluate
    blocking.evaluate = async input => {
      firstCalls += 1
      entered!()
      await releasePromise
      return original(input)
    }
    const first = new RefinementWorkflow(firstStore, blocking)
    const policyRef = first.publishPolicy(signedConfiguration('claim-policy', 'policy', policy))
    const suiteRef = first.publishSuite(signedConfiguration('claim-suite', 'suite', suite))
    const proposal = await proposeCandidate(first, { proposalId: 'claim-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })
    const ack = first.beginEvaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
    const running = first.completeEvaluationJob(ack.evaluationJobRef)
    await enteredPromise

    const secondStore = new RefinementControlStore({ rootDir })
    let secondCalls = 0
    const second = new RefinementWorkflow(secondStore, {
      generate: async () => { throw new Error('generation is not part of evaluation recovery') },
      evaluate: async () => {
        secondCalls += 1
        throw new Error('concurrent evaluator must not invoke adapter')
      },
    })
    await assert.rejects(
      second.completeEvaluationJob(ack.evaluationJobRef),
      (error: unknown) => error instanceof RefinementError && /cannot be retried safely/.test(error.message),
    )
    assert.equal(secondCalls, 0)
    release!()
    await running
    assert.equal(firstCalls, 2)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('S3 manual rejection is terminal and does not publish its reserved overlay', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'reject-base', revision: 0 })
  const workflow = new RefinementWorkflow(rcs, adapter(base))
  const policyRef = workflow.publishPolicy(signedConfiguration('reject-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('reject-suite', 'suite', suite))
  const proposal = await proposeCandidate(workflow, { proposalId: 'reject-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })
  const report = await workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
  const requestRef = workflow.request(report)
  assert.equal(workflow.manualReject({ requestRef, subject: 'researcher', policyRef }).kind, 'promotion-decision')
  refinementError(() => workflow.manualPromote({ requestRef, subject: 'researcher', policyRef }))
  const candidate = rcs.getArtifact<{ overlayRef: ReturnType<RefinementControlStore['publishBaseline']> }>(
    `${proposal.candidateRef.kind}:${proposal.candidateRef.id}@${proposal.candidateRef.revision}#${proposal.candidateRef.contentHash}`,
  )!
  refinementError(() => rcs.select('external', { baselineRef: base, overlayRef: candidate.overlayRef }, []))
})

test('S3 E2E: a scoped valid auto grant promotes once and rejects replay', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'auto-base', revision: 0 })
  const autoPolicy = { ...policy, authority: { manualApprovers: ['researcher'], autoAudience: 'helix-ci' } }
  const workflow = new RefinementWorkflow(rcs, adapter(base), {
    now: () => new Date('2026-08-12T00:00:00.000Z'),
  })
  const policyRef = workflow.publishPolicy(signedConfiguration('auto-policy', 'policy', autoPolicy))
  const suiteRef = workflow.publishSuite(signedConfiguration('auto-suite', 'suite', suite))
  const proposal = await proposeCandidate(workflow, { proposalId: 'auto-proposal', sourceRunRefs: ['source'], baselineRef: base, policyRef })
  const report = await workflow.evaluate({ candidateRef: proposal.candidateRef, policyRef, suiteRef })
  const requestRef = workflow.request(report)
  const grant = signAutoPromotionGrant({
    schemaVersion: 'helix.refinement-auto-grant/v1', requestRef, reportRef: report.reportRef,
    candidateRef: proposal.candidateRef, subject: 'ci-job-1', audience: 'helix-ci',
    issuer: 'ci', keyId: 'key-1', expiresAt: '2026-08-13T00:00:00.000Z', nonce: 'one-time', trustBundleGeneration: 'g1',
  }, 'fixture-secret')
  const bundle = {
    schemaVersion: 'helix.refinement-trust-bundle/v1' as const,
    generation: 'g1',
    audience: 'unused',
    assertionKeys: [],
    policyPublisherKeys: [],
    autoGrantKeys: [{
      issuer: 'ci', keyId: 'key-1', secret: 'fixture-secret',
      notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
    }],
  }
  const invalidGrant = { ...grant, audience: 'wrong-audience' }
  refinementError(() => workflow.autoPromote({ requestRef, policyRef, grant: invalidGrant, bundle }))
  assert.equal(workflow.autoPromote({ requestRef, policyRef, grant, bundle }).overlayRef.kind, 'overlay')
  refinementError(() => workflow.autoPromote({ requestRef, policyRef, grant, bundle }))
})
