import assert from 'node:assert/strict'
import test from 'node:test'

import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import type { HarnessDocument } from '../../src/harness/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { createMilkieRefinementAdapter } from '../../src/refinement/milkie-adapter.js'
import { RefinementWorkflow, type RefinementPolicyV1, type EvaluationSuiteV1 } from '../../src/refinement/workflow.js'
import { signedConfiguration, FIXTURE_EXTRACTOR_DIGEST } from './fixtures.js'


const document: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: 'baseline system',
    taskNarrativeTemplate: 'task',
    protocolRules: ['rule'],
    termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
  },
  catalogCards: [],
  compatibility: { codeProtocolPins: ['fixture/v1'] },
}

const policy: RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1',
  generation: { model: 'pinned-model', maxOutputTokens: 32 },
  extractorDigest: FIXTURE_EXTRACTOR_DIGEST,
  gate: { minQualityDelta: 0.05, maxCostRatio: 1.2, maxLatencyRatio: 1.2, maxFailureRateDelta: 0 },
  authority: { manualApprovers: ['researcher'] },
}

const suite: EvaluationSuiteV1 = {
  schemaVersion: 'helix.refinement-suite/v1',
  cases: [{ caseId: 'c1', inputRef: 'in-1', seed: 3, weight: 1 }],
}

function stubPort(overlayText: string): IIOPort {
  return {
    async invokeLLM(request) {
      assert.equal(request.model, 'pinned-model')
      return {
        content: [{ type: 'text', text: overlayText }],
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 8 },
      }
    },
    async invokeTool(_name, _input, execute) {
      return execute(new AbortController().signal)
    },
    now: () => 1,
    uuid: () => 'milkie-uuid',
  }
}

test('S1/S2 milkie adapter generates via IOPort and evaluates with ordinary #10 freeze+replay', async () => {
  const rcs = new RefinementControlStore({ skipRegistryLookup: true })
  const baselineRef = rcs.publishBaseline(document, { id: 'milkie-base', revision: 0 })
  const overlayPayload = JSON.stringify({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: baselineRef,
    changes: { systemInstructionTemplate: 'candidate system' },
  })

  const adapter = createMilkieRefinementAdapter({
    rcs,
    availableCatalogRefs: [],
    codeProtocolPin: 'fixture/v1',
    innerPort: stubPort(overlayPayload),
    generationRunRef: 'milkie-generation-run',
    generationModel: 'pinned-model',
    sharedPins: { runner: 'milkie-fixture', model: 'pinned-model' },
    projectGenerationInput: (sourceRunRefs) => ({ sourceRunRefs }),
    extractorDigest: FIXTURE_EXTRACTOR_DIGEST,
    runArm: ({ arm, reservedRunRef }) => ({
      runRef: reservedRunRef,
      quality: arm === 'candidate' ? 0.95 : 0.8,
      cost: 5,
      latencyMs: 12,
      failed: false,
    }),
  })

  const workflow = new RefinementWorkflow(rcs, adapter)
  const policyRef = workflow.publishPolicy(signedConfiguration('milkie-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('milkie-suite', 'suite', suite))

  const ack = await workflow.propose({
    proposalId: 'milkie-proposal',
    sourceRunRefs: ['source-run'],
    baselineRef,
    policyRef,
  })
  const generation = workflow.showGenerationJob(ack.generationJobRef)
  assert.ok(generation.candidateRef)

  const report = await workflow.evaluate({
    candidateRef: generation.candidateRef,
    policyRef,
    suiteRef,
  })
  assert.equal(report.verdict, 'passed')
  assert.equal(report.cases.length, 1)
  assert.equal(report.cases[0]!.baseline.replayPassed, true)
  assert.equal(report.cases[0]!.candidate.replayPassed, true)
  assert.equal(report.cases[0]!.baseline.sharedPins.model, report.cases[0]!.candidate.sharedPins.model)
  assert.equal(report.cases[0]!.baseline.harnessPins.overlayRef, undefined)
  assert.ok(report.cases[0]!.candidate.harnessPins.overlayRef)
  assert.equal(
    report.cases[0]!.candidate.harnessPins.overlayRef?.contentHash,
    report.cases[0]!.candidate.harnessPins.overlayRef?.contentHash,
  )
})
