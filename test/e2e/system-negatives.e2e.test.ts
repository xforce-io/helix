/**
 * System e2e negative tests (S3 authority boundaries).
 *
 * Verifies:
 * - Nonce receipt: same nonce + same intent returns first ACK; changed intent fail-closed
 * - Model cannot mint/publish: model/skill assertion cannot publish-policy / publish-suite
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RefinementError } from '../../src/refinement/errors.js'
import { type RefinementPolicyV1, type EvaluationSuiteV1 } from '../../src/refinement/workflow.js'
import { executeRefinementCommand, proposeAndWait } from '../../src/refinement/commands.js'
import { signConfiguration } from '../../src/refinement/trust.js'
import { createSystemCommandHost, createSystemFixtureAssertion, SYSTEM_EXTRACTOR_DIGEST } from './system-command-host.js'

test('S3: nonce receipt — same nonce + same intent returns first ACK', async () => {
  const runId = `nonce-same-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })

  const rootDir = path.join(tmpdir(), `helix-system-e2e-${runId}`)
  mkdirSync(rootDir, { recursive: true })

  const host = createSystemCommandHost({ rootDir, artifactsDir, runId })
  const baselineRef = host.rcs.exportSnapshot().baselines[0]!.ref

  const policy: RefinementPolicyV1 = {
    schemaVersion: 'helix.refinement-policy/v1',
    generation: { model: 'system-fixture-model', maxOutputTokens: 128 },
    extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
    gate: { minQualityDelta: 0.1, maxCostRatio: 1.5, maxLatencyRatio: 1.5, maxFailureRateDelta: 0 },
    authority: { manualApprovers: ['system-researcher'] },
  }

  const policyRef = await executeRefinementCommand(host, {
    command: 'publish-policy',
    id: 'nonce-policy',
    policy,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(policy, 'fixture-hrca-secret'),
  })

  // First proposal with nonce 'nonce-test-1'
  const proposal1Input = {
    proposalId: 'nonce-proposal-1',
    sourceRunRefs: ['nonce-source'],
    baselineRef,
    policyRef,
  }
  const { ack: ack1 } = await proposeAndWait(host, {
    command: 'propose',
    assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: 'nonce-test-1' }),
    proposal: proposal1Input,
  })

  // Retry with same nonce + same intent should return same ACK
  const { ack: ack2 } = await proposeAndWait(host, {
    command: 'propose',
    assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: 'nonce-test-1' }),
    proposal: proposal1Input,
  })

  assert.deepEqual(ack1, ack2, 'Same nonce + same intent must return first ACK')
})

test('S3: nonce receipt — same nonce + changed intent fail-closed', async () => {
  const runId = `nonce-changed-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })

  const rootDir = path.join(tmpdir(), `helix-system-e2e-${runId}`)
  mkdirSync(rootDir, { recursive: true })

  const host = createSystemCommandHost({ rootDir, artifactsDir, runId })
  const baselineRef = host.rcs.exportSnapshot().baselines[0]!.ref

  const policy: RefinementPolicyV1 = {
    schemaVersion: 'helix.refinement-policy/v1',
    generation: { model: 'system-fixture-model', maxOutputTokens: 128 },
    extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
    gate: { minQualityDelta: 0.1, maxCostRatio: 1.5, maxLatencyRatio: 1.5, maxFailureRateDelta: 0 },
    authority: { manualApprovers: ['system-researcher'] },
  }

  const policyRef = await executeRefinementCommand(host, {
    command: 'publish-policy',
    id: 'nonce-changed-policy',
    policy,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(policy, 'fixture-hrca-secret'),
  })

  // First proposal with nonce 'nonce-test-2'
  const proposal1Input = {
    proposalId: 'nonce-proposal-2',
    sourceRunRefs: ['nonce-source-1'],
    baselineRef,
    policyRef,
  }
  await proposeAndWait(host, {
    command: 'propose',
    assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: 'nonce-test-2' }),
    proposal: proposal1Input,
  })

  // Retry with same nonce but CHANGED intent (different sourceRunRefs) must fail-closed
  const proposal2Input = {
    proposalId: 'nonce-proposal-2',
    sourceRunRefs: ['nonce-source-DIFFERENT'], // Changed intent
    baselineRef,
    policyRef,
  }
  await assert.rejects(
    proposeAndWait(host, {
      command: 'propose',
      assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: 'nonce-test-2' }),
      proposal: proposal2Input,
    }),
    (error: unknown) =>
      error instanceof RefinementError && error.code === 'REFINEMENT_ASSERTION_REPLAYED'
  )
})

test('S3: model/skill assertion cannot publish-policy', async () => {
  const runId = `model-publish-policy-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })

  const rootDir = path.join(tmpdir(), `helix-system-e2e-${runId}`)
  mkdirSync(rootDir, { recursive: true })

  const host = createSystemCommandHost({ rootDir, artifactsDir, runId })

  const policy: RefinementPolicyV1 = {
    schemaVersion: 'helix.refinement-policy/v1',
    generation: { model: 'system-fixture-model', maxOutputTokens: 128 },
    extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
    gate: { minQualityDelta: 0.1, maxCostRatio: 1.5, maxLatencyRatio: 1.5, maxFailureRateDelta: 0 },
    authority: { manualApprovers: ['system-researcher'] },
  }

  // Model/skill subject trying to publish policy must fail
  // (Only HRCA keys can publish policy; model/skill assertion uses different issuer)
  await assert.rejects(
    executeRefinementCommand(host, {
      command: 'publish-policy',
      id: 'model-policy-attempt',
      policy,
      issuer: 'model-issuer', // Wrong issuer (not fixture-hrca)
      keyId: 'fixture-key',
      signature: signConfiguration(policy, 'fixture-hrca-secret'),
    }),
    (error: unknown) => error instanceof RefinementError
  )
})

test('S3: model/skill assertion cannot publish-suite', async () => {
  const runId = `model-publish-suite-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })

  const rootDir = path.join(tmpdir(), `helix-system-e2e-${runId}`)
  mkdirSync(rootDir, { recursive: true })

  const host = createSystemCommandHost({ rootDir, artifactsDir, runId })

  const suite: EvaluationSuiteV1 = {
    schemaVersion: 'helix.refinement-suite/v1',
    cases: [{ caseId: 'model-case', inputRef: 'model:input', seed: 1, weight: 1 }],
  }

  // Model/skill subject trying to publish suite must fail
  await assert.rejects(
    executeRefinementCommand(host, {
      command: 'publish-suite',
      id: 'model-suite-attempt',
      suite,
      issuer: 'model-issuer', // Wrong issuer
      keyId: 'fixture-key',
      signature: signConfiguration(suite, 'fixture-hrca-secret'),
    }),
    (error: unknown) => error instanceof RefinementError
  )
})

test('S3: unsigned assertion cannot mint', async () => {
  const runId = `unsigned-mint-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })

  const rootDir = path.join(tmpdir(), `helix-system-e2e-${runId}`)
  mkdirSync(rootDir, { recursive: true })

  const host = createSystemCommandHost({ rootDir, artifactsDir, runId })
  const baselineRef = host.rcs.exportSnapshot().baselines[0]!.ref

  const policy: RefinementPolicyV1 = {
    schemaVersion: 'helix.refinement-policy/v1',
    generation: { model: 'system-fixture-model', maxOutputTokens: 128 },
    extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
    gate: { minQualityDelta: 0.1, maxCostRatio: 1.5, maxLatencyRatio: 1.5, maxFailureRateDelta: 0 },
    authority: { manualApprovers: ['system-researcher'] },
  }

  const policyRef = await executeRefinementCommand(host, {
    command: 'publish-policy',
    id: 'unsigned-policy',
    policy,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(policy, 'fixture-hrca-secret'),
  })

  // Create assertion with wrong signature (tampering)
  const validAssertion = createSystemFixtureAssertion({
    operation: 'refine.propose',
    nonce: 'unsigned-nonce',
  })
  const tamperedAssertion = {
    ...validAssertion,
    signature: 'a'.repeat(64), // Tampered signature
  }

  // Unsigned/tampered assertion cannot propose
  await assert.rejects(
    proposeAndWait(host, {
      command: 'propose',
      assertion: tamperedAssertion,
      proposal: {
        proposalId: 'unsigned-proposal',
        sourceRunRefs: ['unsigned-source'],
        baselineRef,
        policyRef,
      },
    }),
    (error: unknown) => error instanceof RefinementError
  )
})
