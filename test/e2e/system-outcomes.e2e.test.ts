/**
 * System e2e outcome classifications (Issue #24 S2/S4).
 *
 * These cases use the same command, IOPort, freeze, replay, and evidence paths
 * as the happy path, then prove that rejected and failed candidates are not
 * promotable and leave an inspectable classified report.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveCapabilitySet, resolveCardRefs } from '../../src/catalog/index.js'
import { executeRefinementCommand, evaluateAndWait, proposeAndWait } from '../../src/refinement/commands.js'
import { RefinementError } from '../../src/refinement/errors.js'
import type {
  EvaluationSuiteV1,
  RefinementArtifactRef,
  RefinementPolicyV1,
} from '../../src/refinement/workflow.js'
import { signConfiguration } from '../../src/refinement/trust.js'
import {
  createSystemCommandHost,
  createSystemFixtureAssertion,
  SYSTEM_EXTRACTOR_DIGEST,
} from './system-command-host.js'

type OutcomeReport = {
  classification: 'candidate_rejected' | 'evaluation_failed'
  caseCount: number
  failedCandidatePromotions: number
  evidencePaths: string[]
  error?: string
}

function fixturePolicy(): RefinementPolicyV1 {
  return {
    schemaVersion: 'helix.refinement-policy/v1',
    generation: { model: 'system-fixture-model', maxOutputTokens: 128 },
    extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
    gate: {
      minQualityDelta: 0.1,
      maxCostRatio: 1.5,
      maxLatencyRatio: 1.5,
      maxFailureRateDelta: 0,
    },
    authority: { manualApprovers: ['system-researcher'] },
  }
}

function fixtureSuite(): EvaluationSuiteV1 {
  return {
    schemaVersion: 'helix.refinement-suite/v1',
    cases: [{ caseId: 'failure-case', inputRef: 'system:failure', seed: 1, weight: 1 }],
  }
}

function writeOutcomeReport(artifactsDir: string, report: OutcomeReport): string {
  const reportPath = path.join(artifactsDir, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  assert.ok(existsSync(reportPath), 'outcome report must persist')
  assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), report)
  return reportPath
}

async function publishPolicyAndSuite(
  host: ReturnType<typeof createSystemCommandHost>,
): Promise<{ policyRef: RefinementArtifactRef; suiteRef: RefinementArtifactRef }> {
  const policy = fixturePolicy()
  const suite = fixtureSuite()
  const policyRef = await executeRefinementCommand(host, {
    command: 'publish-policy',
    id: 'outcome-policy',
    policy,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(policy, 'fixture-hrca-secret'),
  }) as RefinementArtifactRef
  const suiteRef = await executeRefinementCommand(host, {
    command: 'publish-suite',
    id: 'outcome-suite',
    suite,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(suite, 'fixture-hrca-secret'),
  }) as RefinementArtifactRef
  return { policyRef, suiteRef }
}

test('S2/S4: invalid IOPort candidate is rejected and reported without promotion', async () => {
  const runId = `candidate-rejected-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })
  const host = createSystemCommandHost({
    rootDir: path.join(tmpdir(), `helix-system-e2e-${runId}`),
    artifactsDir,
    runId,
    generationPayloadText: 'not a HarnessOverlay JSON object',
  })
  const baselineRef = host.rcs.exportSnapshot().baselines[0]!.ref
  const { policyRef } = await publishPolicyAndSuite(host)

  const error = await assert.rejects(
    proposeAndWait(host, {
      command: 'propose',
      assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: `${runId}-propose` }),
      proposal: {
        proposalId: runId,
        sourceRunRefs: ['candidate-rejected-source'],
        baselineRef,
        policyRef,
      },
    }),
    (caught: unknown) => caught instanceof RefinementError,
  )

  const report: OutcomeReport = {
    classification: 'candidate_rejected',
    caseCount: 0,
    failedCandidatePromotions: 0,
    evidencePaths: [],
    error: String(error),
  }
  writeOutcomeReport(artifactsDir, report)
  assert.equal(host.rcs.exportSnapshot().overlays.length, 0)
})

test('S2/S4: verifier-failed candidate is reported and cannot request promotion', async () => {
  const runId = `evaluation-failed-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })
  const host = createSystemCommandHost({
    rootDir: path.join(tmpdir(), `helix-system-e2e-${runId}`),
    artifactsDir,
    runId,
    candidateVerificationFails: true,
  })
  const baselineRef = host.rcs.exportSnapshot().baselines[0]!.ref
  const { policyRef, suiteRef } = await publishPolicyAndSuite(host)
  const { candidateRef } = await proposeAndWait(host, {
    command: 'propose',
    assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: `${runId}-propose` }),
    proposal: {
      proposalId: runId,
      sourceRunRefs: ['evaluation-failed-source'],
      baselineRef,
      policyRef,
    },
  })
  const { report: evaluation } = await evaluateAndWait(host, {
    command: 'evaluate',
    assertion: createSystemFixtureAssertion({ operation: 'refine.evaluate', nonce: `${runId}-evaluate` }),
    evaluation: {
      candidateRef,
      policyRef,
      suiteRef,
    },
  })
  assert.equal(evaluation.verdict, 'failed')

  await assert.rejects(
    executeRefinementCommand(host, {
      command: 'request',
      assertion: createSystemFixtureAssertion({ operation: 'refine.request', nonce: `${runId}-request` }),
      report: evaluation,
    }),
    (error: unknown) => error instanceof RefinementError,
  )

  const evidencePaths = evaluation.cases.flatMap((entry) => [
    path.join(artifactsDir, entry.baseline.runRef, 'evidence.json'),
    path.join(artifactsDir, entry.candidate.runRef, 'evidence.json'),
  ])
  for (const evidencePath of evidencePaths) assert.ok(existsSync(evidencePath))
  writeOutcomeReport(artifactsDir, {
    classification: 'evaluation_failed',
    caseCount: evaluation.cases.length,
    failedCandidatePromotions: 0,
    evidencePaths,
  })

  const catalogRefs = resolveCardRefs(resolveCapabilitySet('helix.runtime.core/v1')).map((entry) => entry.ref)
  const candidate = host.rcs.getArtifact<{ overlayRef: typeof baselineRef }>(
    `${candidateRef.kind}:${candidateRef.id}@${candidateRef.revision}#${candidateRef.contentHash}`,
  )!
  assert.throws(
    () => host.rcs.select('external', { baselineRef, overlayRef: candidate.overlayRef }, catalogRefs),
    (error: unknown) => error instanceof RefinementError,
  )
})
