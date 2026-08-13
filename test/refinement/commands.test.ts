import assert from 'node:assert/strict'
import test from 'node:test'

import type { HarnessDocument, HarnessPinsV1 } from '../../src/harness/index.js'
import {
  evaluateAndWait,
  executeRefinementCommand,
  proposeAndWait,
} from '../../src/refinement/commands.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { signActorAssertion } from '../../src/refinement/trust.js'
import type {
  EvaluationMetric,
  EvaluationSuiteV1,
  ProposalAck,
  RefinementPolicyV1,
  RefinementRunAdapter,
} from '../../src/refinement/workflow.js'
import { RefinementWorkflow } from '../../src/refinement/workflow.js'
import { HRCA_BUNDLE, signedConfiguration } from './fixtures.js'

const document: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: 's',
    taskNarrativeTemplate: 't',
    protocolRules: ['p'],
    termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
  },
  catalogCards: [],
  compatibility: { codeProtocolPins: ['p'] },
}
const policy: RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1',
  generation: { model: 'm', maxOutputTokens: 2 },
  gate: { minQualityDelta: 0, maxCostRatio: 1, maxLatencyRatio: 1, maxFailureRateDelta: 0 },
  authority: { manualApprovers: ['human'] },
}
const suite: EvaluationSuiteV1 = {
  schemaVersion: 'helix.refinement-suite/v1',
  cases: [{ caseId: 'c', inputRef: 'i', seed: 0, weight: 1 }],
}

function assertion(
  operation:
    | 'refine.propose'
    | 'refine.evaluate'
    | 'refine.request'
    | 'refine.promote.manual'
    | 'refine.reject.manual',
  nonce: string,
) {
  return signActorAssertion(
    {
      schemaVersion: 'helix.refinement-actor-assertion/v1',
      subject: 'human',
      issuer: 'idp',
      keyId: 'key',
      audience: 'commands',
      operation,
      issuedAt: '2026-08-12T00:00:00Z',
      expiresAt: '2026-08-13T00:00:00Z',
      nonce,
    },
    'assertion-secret',
  )
}

const trustBundle = {
  ...HRCA_BUNDLE,
  audience: 'commands',
  assertionKeys: [
    {
      issuer: 'idp',
      keyId: 'key',
      secret: 'assertion-secret',
      notBefore: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    },
  ],
}

test('formal command dispatcher claims assertion with ACK before generation and retries share one run', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'b', revision: 0 })
  const pin = (overlay?: typeof base): HarnessPinsV1 => ({
    format: 'harness/v1',
    codeProtocolPin: 'p',
    baselineRef: base,
    ...(overlay === undefined ? {} : { overlayRef: overlay }),
    harnessContentHash: overlay === undefined ? 'a'.repeat(64) : 'b'.repeat(64),
    schemaVersion: 'helix.harness/v1',
    catalogCards: [],
    compatibilityDecision: { documentAcceptsCodeProtocolPin: true, catalogResolved: true },
  })
  let generateCalls = 0
  const adapter: RefinementRunAdapter = {
    async generate() {
      generateCalls += 1
      await new Promise(resolve => setTimeout(resolve, 15))
      return {
        generationRunRef: 'recorded',
        payloadText: JSON.stringify({
          schemaVersion: 'helix.harness-overlay/v1',
          baseBaselineRef: base,
          changes: { systemInstructionTemplate: 'new' },
        }),
        modelPins: { model: 'm' },
        budget: { reserved: 2, charged: 1 },
      }
    },
    async evaluate(input): Promise<EvaluationMetric> {
      return {
        quality: 1,
        cost: 1,
        latencyMs: 1,
        failed: false,
        replayPassed: true,
        sharedPins: { seed: '0' },
        harnessPins: pin(input.arm === 'candidate' ? input.overlayRef : undefined),
        runRef: input.arm,
      }
    },
  }
  const host = { rcs, adapter, trustBundle, now: () => new Date('2026-08-12T01:00:00Z') }
  const setup = new RefinementWorkflow(rcs, adapter)
  const policyRef = setup.publishPolicy(signedConfiguration('p', 'policy', policy))
  const suiteRef = setup.publishSuite(signedConfiguration('s', 'suite', suite))
  const proposalInput = {
    proposalId: 'proposal',
    sourceRunRefs: ['source'],
    baselineRef: base,
    policyRef,
  }

  const [first, retry] = (await Promise.all([
    executeRefinementCommand(host, {
      command: 'propose',
      assertion: assertion('refine.propose', 'n1'),
      proposal: proposalInput,
    }),
    executeRefinementCommand(host, {
      command: 'propose',
      assertion: assertion('refine.propose', 'n1'),
      proposal: proposalInput,
    }),
  ])) as [ProposalAck, ProposalAck]

  // ACK is only job identity; candidate is not in the first response.
  assert.equal('candidateRef' in first, false)
  assert.deepEqual(retry, first)
  assert.ok(first.proposalRef)
  assert.ok(first.generationJobRef)

  await assert.rejects(
    executeRefinementCommand(host, {
      command: 'propose',
      assertion: assertion('refine.propose', 'n1'),
      proposal: { ...proposalInput, proposalId: 'changed' },
    }),
    error => (error as { code?: string }).code === 'REFINEMENT_ASSERTION_REPLAYED',
  )

  const shown = (await executeRefinementCommand(host, {
    command: 'show-generation-job',
    ref: first.generationJobRef,
  })) as { candidateRef?: { contentHash: string } }
  assert.ok(shown.candidateRef)
  assert.equal(generateCalls, 1)

  const { report } = await evaluateAndWait(host, {
    command: 'evaluate',
    assertion: assertion('refine.evaluate', 'n2'),
    evaluation: {
      candidateRef: shown.candidateRef as never,
      policyRef,
      suiteRef,
    },
  })
  assert.equal(report.verdict, 'passed')

  const requestRef = (await executeRefinementCommand(host, {
    command: 'request',
    assertion: assertion('refine.request', 'n3'),
    report,
  })) as { kind: string }

  const promotion = (await executeRefinementCommand(host, {
    command: 'promote-manual',
    assertion: assertion('refine.promote.manual', 'n4'),
    requestRef: requestRef as never,
    policyRef,
  })) as { overlayRef: { kind: string } }
  assert.equal(promotion.overlayRef.kind, 'overlay')
})

test('proposeAndWait helper returns candidate only after terminal generation job', async () => {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline(document, { id: 'wait', revision: 0 })
  const adapter: RefinementRunAdapter = {
    async generate() {
      return {
        generationRunRef: 'run',
        payloadText: JSON.stringify({
          schemaVersion: 'helix.harness-overlay/v1',
          baseBaselineRef: base,
          changes: { systemInstructionTemplate: 'x' },
        }),
        modelPins: { model: 'm' },
        budget: { reserved: 1, charged: 1 },
      }
    },
    async evaluate() {
      throw new Error('unused')
    },
  }
  const host = { rcs, adapter, trustBundle, now: () => new Date('2026-08-12T01:00:00Z') }
  const setup = new RefinementWorkflow(rcs, adapter)
  const policyRef = setup.publishPolicy(signedConfiguration('wait-p', 'policy', policy))
  const { ack, candidateRef } = await proposeAndWait(host, {
    command: 'propose',
    assertion: assertion('refine.propose', 'wait-n'),
    proposal: {
      proposalId: 'wait-proposal',
      sourceRunRefs: ['s'],
      baselineRef: base,
      policyRef,
    },
  })
  assert.equal(ack.generationJobRef.kind, 'generation-job')
  assert.equal(candidateRef.kind, 'candidate')
})
