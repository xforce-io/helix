import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import type { HarnessDocument, HarnessPinsV1, HarnessStateRef } from '../../src/harness/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { createMilkieRefinementAdapter } from '../../src/refinement/milkie-adapter.js'
import {
  createIOPortGenerationAdapter,
  RefinementWorkflow,
  type EvaluationMetric,
  type EvaluationSuiteV1,
  type RefinementPolicyV1,
  type RefinementRunAdapter,
} from '../../src/refinement/workflow.js'
import { signedConfiguration } from './fixtures.js'

const EXTRACTOR_DIGEST = 'e'.repeat(64)
const OTHER_DIGEST = 'f'.repeat(64)

const document: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: 'base',
    taskNarrativeTemplate: 'task',
    protocolRules: ['verify'],
    termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
  },
  catalogCards: [],
  compatibility: { codeProtocolPins: ['fixture/v1'] },
}

const policy: RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1',
  generation: { model: 'pinned-model', maxOutputTokens: 32 },
  extractorDigest: EXTRACTOR_DIGEST,
  gate: { minQualityDelta: 0.05, maxCostRatio: 1.2, maxLatencyRatio: 1.2, maxFailureRateDelta: 0 },
  authority: { manualApprovers: ['researcher'] },
}

const suite: EvaluationSuiteV1 = {
  schemaVersion: 'helix.refinement-suite/v1',
  cases: [{ caseId: 'c1', inputRef: 'in-1', seed: 3, weight: 1 }],
}

function pins(
  base: HarnessStateRef,
  overlay?: HarnessStateRef,
): HarnessPinsV1 {
  return {
    format: 'harness/v1',
    codeProtocolPin: 'fixture/v1',
    baselineRef: base,
    ...(overlay === undefined ? {} : { overlayRef: overlay }),
    harnessContentHash: 'b'.repeat(64),
    schemaVersion: 'helix.harness/v1',
    catalogCards: [],
    compatibilityDecision: { documentAcceptsCodeProtocolPin: true, catalogResolved: true },
  }
}

function recordedAdapter(
  base: HarnessStateRef,
): RefinementRunAdapter {
  return {
    async generate(input) {
      return {
        generationRunRef: input.reservedGenerationRunRef,
        payloadText: JSON.stringify({
          schemaVersion: 'helix.harness-overlay/v1',
          baseBaselineRef: base,
          changes: { systemInstructionTemplate: 'candidate' },
        }),
        modelPins: { model: 'fixture-model' },
        budget: { reserved: 32, charged: 4 },
      }
    },
    async evaluate(input): Promise<EvaluationMetric> {
      const candidate = input.arm === 'candidate'
      return {
        quality: candidate ? 0.9 : 0.7,
        cost: 10,
        latencyMs: 100,
        failed: false,
        replayPassed: true,
        sharedPins: { model: 'fixture-model', seed: String(input.case.seed) },
        harnessPins: pins(base, candidate ? input.overlayRef : undefined),
        runRef: input.reservedRunRef,
        extractorDigest: EXTRACTOR_DIGEST,
      }
    },
  }
}

function stubPort(overlayText: string, seen: { prompt?: string }): IIOPort {
  return {
    async invokeLLM(request) {
      const first = request.messages[0]
      if (first !== undefined && 'content' in first) {
        const block = first.content[0]
        if (block !== undefined && block.type === 'text') seen.prompt = block.text
      }
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

test('S1 milkie adapter projects source runs into the IOPort prompt', async () => {
  const rcs = new RefinementControlStore({ skipRegistryLookup: true })
  const baselineRef = rcs.publishBaseline(document, { id: 'proj-base', revision: 0 })
  const overlayPayload = JSON.stringify({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: baselineRef,
    changes: { systemInstructionTemplate: 'candidate system' },
  })
  const seen: { prompt?: string } = {}
  const adapter = createMilkieRefinementAdapter({
    rcs,
    availableCatalogRefs: [],
    codeProtocolPin: 'fixture/v1',
    innerPort: stubPort(overlayPayload, seen),
    generationRunRef: 'milkie-generation-run',
    generationModel: 'pinned-model',
    sharedPins: { runner: 'milkie-fixture', model: 'pinned-model' },
    projectGenerationInput: (sourceRunRefs) => ({
      sourceRunRefs,
      outcome: { success: false, quality: 0.2 },
    }),
    runArm: ({ arm }) => ({
      runRef: `recorded-arm-${arm}`,
      quality: arm === 'candidate' ? 0.95 : 0.8,
      cost: 5,
      latencyMs: 12,
      failed: false,
    }),
    extractorDigest: EXTRACTOR_DIGEST,
  })

  const generated = await adapter.generate({
    sourceRunRefs: ['source-a', 'source-b'],
    baselineRef,
    policy,
    reservedGenerationRunRef: 'milkie-generation-run',
  })
  assert.equal(generated.generationRunRef, 'milkie-generation-run')
  assert.match(seen.prompt ?? '', /source-a/)
  assert.match(seen.prompt ?? '', /"success":false/)
})

test('S2 milkie adapter rejects synthetic eval-arm run refs', async () => {
  const rcs = new RefinementControlStore({ skipRegistryLookup: true })
  const baselineRef = rcs.publishBaseline(document, { id: 'synth-base', revision: 0 })
  const overlayPayload = JSON.stringify({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: baselineRef,
    changes: { systemInstructionTemplate: 'candidate system' },
  })
  const adapter = createMilkieRefinementAdapter({
    rcs,
    availableCatalogRefs: [],
    codeProtocolPin: 'fixture/v1',
    innerPort: stubPort(overlayPayload, {}),
    generationRunRef: 'milkie-generation-run',
    generationModel: 'pinned-model',
    sharedPins: { runner: 'milkie-fixture', model: 'pinned-model' },
    projectGenerationInput: () => ({ ok: true }),
    runArm: ({ arm, case: suiteCase }) => ({
      runRef: `eval-${arm}-${suiteCase.caseId}-deadbeef`,
      quality: 1,
      cost: 1,
      latencyMs: 1,
      failed: false,
    }),
    extractorDigest: EXTRACTOR_DIGEST,
  })
  const workflow = new RefinementWorkflow(rcs, adapter)
  const policyRef = workflow.publishPolicy(signedConfiguration('synth-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('synth-suite', 'suite', suite))
  const ack = await workflow.propose({
    proposalId: 'synth-proposal',
    sourceRunRefs: ['source'],
    baselineRef,
    policyRef,
  })
  const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef
  assert.ok(candidateRef)
  await assert.rejects(
    workflow.evaluate({ candidateRef, policyRef, suiteRef }),
    (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CANDIDATE_INVALID',
  )
})

test('S2 report arms each carry a recorded runRef', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'arm-base', revision: 0 })
  const workflow = new RefinementWorkflow(rcs, recordedAdapter(base))
  const policyRef = workflow.publishPolicy(signedConfiguration('arm-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('arm-suite', 'suite', suite))
  const ack = await workflow.propose({
    proposalId: 'arm-proposal',
    sourceRunRefs: ['source'],
    baselineRef: base,
    policyRef,
  })
  const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef
  assert.ok(candidateRef)
  const report = await workflow.evaluate({ candidateRef, policyRef, suiteRef })
  assert.equal(report.cases.length, 1)
  assert.match(report.cases[0]!.baseline.runRef, /^recorded-evaluation:/)
  assert.match(report.cases[0]!.candidate.runRef, /^recorded-evaluation:/)
  assert.notEqual(report.cases[0]!.baseline.runRef, report.cases[0]!.candidate.runRef)
  assert.doesNotMatch(report.cases[0]!.baseline.runRef, /^eval-/)
  assert.doesNotMatch(report.cases[0]!.candidate.runRef, /^eval-/)
})

test('S3 restart after reserved generation payload does not call generate again', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-reserve-'))
  try {
    const rcs = new RefinementControlStore({ rootDir })
    const base = rcs.publishBaseline(document, { id: 'rsv-base', revision: 0 })
    let generateCalls = 0
    const counting: RefinementRunAdapter = {
      async generate(input) {
        generateCalls += 1
        return recordedAdapter(base).generate(input)
      },
      evaluate: recordedAdapter(base).evaluate,
    }
    const first = new RefinementWorkflow(rcs, counting)
    const policyRef = first.publishPolicy(signedConfiguration('rsv-policy', 'policy', policy))
    const ack = await first.propose({
      proposalId: 'rsv-proposal',
      sourceRunRefs: ['source'],
      baselineRef: base,
      policyRef,
    })
    assert.equal(generateCalls, 1)
    const reopened = new RefinementControlStore({ rootDir })
    let secondCalls = 0
    const second = new RefinementWorkflow(reopened, {
      async generate() {
        secondCalls += 1
        throw new Error('restart must not generate again')
      },
      evaluate: recordedAdapter(base).evaluate,
    })
    const again = await second.completeGenerationJob(ack.generationJobRef)
    assert.equal(secondCalls, 0)
    assert.ok(again.candidateRef)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('S3 failed first generate retries with the same reserved generation run ref', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'retry-base', revision: 0 })
  const reserved: string[] = []
  let calls = 0
  const adapter: RefinementRunAdapter = {
    async generate(input) {
      calls += 1
      assert.ok(input.reservedGenerationRunRef)
      reserved.push(input.reservedGenerationRunRef!)
      if (calls === 1) throw new Error('provider interrupted')
      return recordedAdapter(base).generate(input)
    },
    evaluate: recordedAdapter(base).evaluate,
  }
  const workflow = new RefinementWorkflow(rcs, adapter)
  const policyRef = workflow.publishPolicy(signedConfiguration('retry-policy', 'policy', policy))
  const ack = workflow.beginPropose({
    proposalId: 'retry-proposal',
    sourceRunRefs: ['source'],
    baselineRef: base,
    policyRef,
  })
  await assert.rejects(workflow.completeGenerationJob(ack.generationJobRef))
  const completed = await workflow.completeGenerationJob(ack.generationJobRef)
  assert.equal(calls, 2)
  assert.equal(reserved[0], reserved[1])
  assert.ok(completed.candidateRef)
})

test('S4 policy publish requires extractorDigest', () => {
  const workflow = new RefinementWorkflow(new RefinementControlStore(), recordedAdapter(
    { kind: 'baseline', id: 'x', revision: 0, contentHash: 'a'.repeat(64) },
  ))
  const unsigned = {
    ...policy,
    extractorDigest: undefined,
  }
  assert.throws(
    () => workflow.publishPolicy(signedConfiguration('no-digest', 'policy', unsigned as unknown as RefinementPolicyV1)),
    (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CONFIGURATION_UNTRUSTED',
  )
})

test('S4 evaluate fail-closes when Host extractorDigest disagrees with policy', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'digest-base', revision: 0 })
  const adapter = recordedAdapter(base)
  adapter.evaluate = async input => ({
    ...(await recordedAdapter(base).evaluate(input)),
    extractorDigest: OTHER_DIGEST,
  })
  const workflow = new RefinementWorkflow(rcs, adapter)
  const policyRef = workflow.publishPolicy(signedConfiguration('digest-policy', 'policy', policy))
  const suiteRef = workflow.publishSuite(signedConfiguration('digest-suite', 'suite', suite))
  const ack = await workflow.propose({
    proposalId: 'digest-proposal',
    sourceRunRefs: ['source'],
    baselineRef: base,
    policyRef,
  })
  const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef
  assert.ok(candidateRef)
  await assert.rejects(
    workflow.evaluate({ candidateRef, policyRef, suiteRef }),
    (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CANDIDATE_INVALID',
  )
})

test('S1 IOPort adapter includes Host projection in the recorded prompt', async () => {
  let prompt = ''
  const adapter = createIOPortGenerationAdapter({
    port: {
      async invokeLLM(request) {
        const first = request.messages[0]
        if (first !== undefined && 'content' in first) {
          const block = first.content[0]
          if (block !== undefined && block.type === 'text') prompt = block.text
        }
        return {
          content: [{ type: 'text', text: '{"overlay":"raw"}' }],
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
      async invokeTool(_name, _input, execute) {
        return execute(new AbortController().signal)
      },
      now: () => 0,
      uuid: () => 'p',
    },
    model: 'pinned-model',
    generationRunRef: 'recorded-run',
    projectGenerationInput: (sourceRunRefs) => ({ clipped: sourceRunRefs, note: 'bounded' }),
    evaluate: async () => {
      throw new Error('not used')
    },
  })
  await adapter.generate({
    sourceRunRefs: ['run-1'],
    baselineRef: { kind: 'baseline', id: 'base', revision: 0, contentHash: 'a'.repeat(64) },
    policy,
    reservedGenerationRunRef: 'recorded-run',
  })
  assert.match(prompt, /bounded/)
  assert.match(prompt, /run-1/)
})
