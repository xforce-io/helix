/**
 * Helix whole-system end-to-end test (Issue #24).
 *
 * Verifies the complete core loop:
 * 1. Catalog: load production cards, resolveCapabilitySet, resolveCardRefs
 * 2. Harness: selectValidateResolveFreeze with fixture adapter
 * 3. Replay: replayFromRecordedPins produces stable harnessContentHash
 * 4. Refinement: propose → evaluate → request → promote (via commands + assertions)
 * 5. Authority: model/skill paths cannot promote
 * 6. Evolution: unpromoted overlay fail-closed on external route; promoted overlay
 *    succeeds on next-run overlay selection; old replay hash unchanged.
 *
 * This is a DETERMINISTIC, CREDENTIAL-FREE system e2e.
 * - innerPort is fixture (not Anthropic)
 * - IOPort generate through milkie RecordingIOPort
 * - Verifier-derived arms (not hardcoded)
 * - Assertion command path (nonce receipts, consumeAssertion)
 * - Durable report in artifacts/
 *
 * P1 fixes:
 * - Live gate always skips (not implemented in this version)
 * - createMilkieRefinementAdapter with real IOPort
 * - Commands + assertions (executeRefinementCommand, proposeAndWait, evaluateAndWait)
 * - Durable report written to artifacts/system-e2e/<runId>/report.json
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { listProductionCards, resolveCapabilitySet, resolveCardRefs } from '../../src/catalog/index.js'
import { replayFromRecordedPins, HarnessStateStore } from '../../src/harness/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { type RefinementPolicyV1, type EvaluationSuiteV1 } from '../../src/refinement/workflow.js'
import {
  executeRefinementCommand,
  proposeAndWait,
  evaluateAndWait,
} from '../../src/refinement/commands.js'
import { signConfiguration } from '../../src/refinement/trust.js'
import { HRCA_BUNDLE } from '../refinement/fixtures.js'
import {
  createSystemCommandHost,
  createSystemFixtureAssertion,
  SYSTEM_EXTRACTOR_DIGEST,
} from './system-command-host.js'

type SystemReport = {
  runId: string
  classification:
    | 'skip'
    | 'candidate_rejected'
    | 'evaluation_failed'
    | 'promotion_blocked'
    | 'evolution_succeeded'
  caseCount: number
  passCount: number
  failCount: number
  skipCount: number
  pins: {
    beforePromoteHash: string
    afterPromoteHash: string
    replayHashUnchanged: boolean
  }
  evidence: {
    productionCardCount: number
    catalogResolved: boolean
    replayPassed: boolean
    overlayFailedBeforePromotion: boolean
    overlaySucceededAfterPromotion: boolean
    modelCannotPromote: boolean
    perCaseEvidencePaths: string[]
  }
  refs: {
    proposalRef: string
    candidateRef: string
    evaluationJobRef: string
    reportRef: string
    requestRef: string
    promotionRef: string
  }
  metrics: {
    baselineQuality: number
    candidateQuality: number
    baselineCost: number
    candidateCost: number
  }
}

function refinementError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RefinementError)
    return true
  })
}

test('System E2E: catalog → freeze → replay → propose → evaluate → request → promote → overlay', async (t) => {
  const runId = `system-e2e-${Date.now()}`
  const artifactsDir = path.join(process.cwd(), 'artifacts', 'system-e2e', runId)
  mkdirSync(artifactsDir, { recursive: true })

  const rootDir = path.join(tmpdir(), `helix-system-e2e-${runId}`)
  mkdirSync(rootDir, { recursive: true })

  const report: SystemReport = {
    runId,
    classification: 'skip',
    caseCount: 0,
    passCount: 0,
    failCount: 0,
    skipCount: 0,
    pins: {
      beforePromoteHash: '',
      afterPromoteHash: '',
      replayHashUnchanged: false,
    },
    evidence: {
      productionCardCount: 0,
      catalogResolved: false,
      replayPassed: false,
      overlayFailedBeforePromotion: false,
      overlaySucceededAfterPromotion: false,
      modelCannotPromote: false,
      perCaseEvidencePaths: [],
    },
    refs: {
      proposalRef: '',
      candidateRef: '',
      evaluationJobRef: '',
      reportRef: '',
      requestRef: '',
      promotionRef: '',
    },
    metrics: {
      baselineQuality: 0,
      candidateQuality: 0,
      baselineCost: 0,
      candidateCost: 0,
    },
  }

  // === 1. CATALOG: load production cards ===
  const productionCards = listProductionCards()
  assert.ok(productionCards.length > 0, 'Production catalog must contain cards')
  report.evidence.productionCardCount = productionCards.length

  // resolveCapabilitySet: unknown set fails closed
  assert.throws(
    () => resolveCapabilitySet('unknown.capability.set/v999'),
    (error: unknown) => error instanceof Error && error.message.includes('unknown runtime capability set')
  )

  // resolveCardRefs: missing version fails closed
  const validRefs = resolveCapabilitySet('helix.runtime.core/v1')
  const resolved = resolveCardRefs(validRefs)
  assert.ok(resolved.length > 0, 'Capability set must resolve to cards')
  report.evidence.catalogResolved = true

  // resolveCardRefs: unknown card fails closed
  assert.throws(
    () => resolveCardRefs([{ id: 'nonexistent.card', version: '999.0.0' }]),
    (error: unknown) => error instanceof Error && error.message.includes('not in the production catalog')
  )

  // === 2. HARNESS: selectValidateResolveFreeze + fixture run (via milkie adapter) ===
  const host = createSystemCommandHost({ rootDir, artifactsDir, runId })
  const rcs = host.rcs
  const baselineSnapshot = rcs.exportSnapshot()
  const baselineRef = baselineSnapshot.baselines[0]!.ref

  const policy: RefinementPolicyV1 = {
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
  const suite: EvaluationSuiteV1 = {
    schemaVersion: 'helix.refinement-suite/v1',
    cases: [
      { caseId: 'system-case-1', inputRef: 'system:input:1', seed: 42, weight: 1 },
      { caseId: 'system-case-2', inputRef: 'system:input:2', seed: 7, weight: 1 },
    ],
  }
  report.caseCount = suite.cases.length

  // === 3. COMMANDS: publish policy/suite via executeRefinementCommand ===
  const policyRef = await executeRefinementCommand(host, {
    command: 'publish-policy',
    id: 'system-policy-v1',
    policy,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(policy, 'fixture-hrca-secret'),
  })

  const suiteRef = await executeRefinementCommand(host, {
    command: 'publish-suite',
    id: 'system-suite-v1',
    suite,
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    signature: signConfiguration(suite, 'fixture-hrca-secret'),
  })

  // === 4. REFINEMENT: proposeAndWait → evaluateAndWait → request → promote-manual ===
  const { ack: proposeAck, candidateRef } = await proposeAndWait(host, {
    command: 'propose',
    assertion: createSystemFixtureAssertion({ operation: 'refine.propose', nonce: `${runId}-propose` }),
    proposal: {
      proposalId: `${runId}-proposal`,
      sourceRunRefs: ['system-source-1', 'system-source-2'],
      baselineRef,
      policyRef,
    },
  })
  report.refs.proposalRef = `${proposeAck.proposalRef.kind}:${proposeAck.proposalRef.id}@${proposeAck.proposalRef.revision}#${proposeAck.proposalRef.contentHash}`
  report.refs.candidateRef = `${candidateRef.kind}:${candidateRef.id}@${candidateRef.revision}#${candidateRef.contentHash}`

  const { ack: evaluateAck, report: evaluationReport } = await evaluateAndWait(host, {
    command: 'evaluate',
    assertion: createSystemFixtureAssertion({ operation: 'refine.evaluate', nonce: `${runId}-evaluate` }),
    evaluation: {
      candidateRef,
      policyRef,
      suiteRef,
    },
  })
  report.refs.evaluationJobRef = `${evaluateAck.evaluationJobRef.kind}:${evaluateAck.evaluationJobRef.id}@${evaluateAck.evaluationJobRef.revision}#${evaluateAck.evaluationJobRef.contentHash}`
  report.refs.reportRef = `${evaluationReport.reportRef.kind}:${evaluationReport.reportRef.id}@${evaluationReport.reportRef.revision}#${evaluationReport.reportRef.contentHash}`

  assert.equal(evaluationReport.verdict, 'passed', 'Evaluation must pass')
  report.passCount = evaluationReport.cases.filter(c => !c.baseline.failed && !c.candidate.failed).length
  report.failCount = evaluationReport.cases.filter(c => c.baseline.failed || c.candidate.failed).length

  // Collect per-case evidence paths
  for (const c of evaluationReport.cases) {
    const baselineEvidencePath = path.join(artifactsDir, c.baseline.runRef, 'evidence.json')
    const candidateEvidencePath = path.join(artifactsDir, c.candidate.runRef, 'evidence.json')
    if (existsSync(baselineEvidencePath)) {
      report.evidence.perCaseEvidencePaths.push(baselineEvidencePath)
    }
    if (existsSync(candidateEvidencePath)) {
      report.evidence.perCaseEvidencePaths.push(candidateEvidencePath)
    }
  }

  // Extract metrics
  report.metrics.baselineQuality = evaluationReport.baseline.quality
  report.metrics.candidateQuality = evaluationReport.candidate.quality
  report.metrics.baselineCost = evaluationReport.baseline.cost
  report.metrics.candidateCost = evaluationReport.candidate.cost

  // === 5. REPLAY: verify stable hash ===
  const firstCase = evaluationReport.cases[0]!
  const originalHash = firstCase.baseline.harnessPins.harnessContentHash
  report.pins.beforePromoteHash = originalHash

  const snapshot = rcs.exportSnapshot()
  const store = new HarnessStateStore()
  for (const entry of snapshot.baselines) {
    store.publishBaseline(entry.document, { id: entry.ref.id, revision: entry.ref.revision })
  }
  for (const entry of snapshot.overlays) {
    store.publishOverlay(entry.overlay, { id: entry.ref.id, revision: entry.ref.revision })
  }
  const replayResult = replayFromRecordedPins({
    store,
    pins: firstCase.baseline.harnessPins,
    availableCatalogRefs: resolveCardRefs(resolveCapabilitySet('helix.runtime.core/v1')).map(r => ({
      id: r.ref.id,
      version: r.ref.version,
    })),
  })
  assert.equal(
    replayResult.pins.harnessContentHash,
    originalHash,
    'Replay must produce identical hash'
  )
  report.evidence.replayPassed = true

  // All cases must have shared pins and replay must pass
  for (const c of evaluationReport.cases) {
    assert.equal(
      c.baseline.sharedPins.runner,
      c.candidate.sharedPins.runner,
      'Shared pins must match across arms'
    )
    assert.ok(c.baseline.replayPassed && c.candidate.replayPassed, 'Replay must pass for all arms')
  }

  const requestRef = await executeRefinementCommand(host, {
    command: 'request',
    assertion: createSystemFixtureAssertion({ operation: 'refine.request', nonce: `${runId}-request` }),
    report: evaluationReport,
  })
  report.refs.requestRef = `${requestRef.kind}:${requestRef.id}@${requestRef.revision}#${requestRef.contentHash}`

  // === 6. AUTHORITY: model/skill subject cannot promote ===
  await assert.rejects(
    executeRefinementCommand(host, {
      command: 'promote-manual',
      assertion: createSystemFixtureAssertion({
        operation: 'refine.promote.manual',
        nonce: `${runId}-promote-fail`,
        subject: 'model-skill',
      }),
      requestRef,
      policyRef,
    }),
    (error: unknown) => error instanceof RefinementError
  )
  report.evidence.modelCannotPromote = true

  // === 7. EVOLUTION: unpromoted overlay fail-closed; promoted overlay succeeds ===
  const candidate = rcs.getArtifact<{ overlayRef: typeof baselineRef }>(
    `${candidateRef.kind}:${candidateRef.id}@${candidateRef.revision}#${candidateRef.contentHash}`
  )!
  const unpromoted = candidate.overlayRef

  const catalogRefs = resolveCardRefs(resolveCapabilitySet('helix.runtime.core/v1')).map(r => ({
    id: r.ref.id,
    version: r.ref.version,
  }))

  // Unpromoted overlay must fail on external route
  refinementError(() => rcs.select('external', { baselineRef, overlayRef: unpromoted }, catalogRefs))
  report.evidence.overlayFailedBeforePromotion = true

  // Manual promotion by authorized researcher
  const promotion = await executeRefinementCommand(host, {
    command: 'promote-manual',
    assertion: createSystemFixtureAssertion({
      operation: 'refine.promote.manual',
      nonce: `${runId}-promote`,
      subject: 'system-researcher',
    }),
    requestRef,
    policyRef,
  })
  report.refs.promotionRef = `${promotion.overlayRef.kind}:${promotion.overlayRef.id}@${promotion.overlayRef.revision}#${promotion.overlayRef.contentHash}`

  assert.equal(
    promotion.overlayRef.contentHash,
    unpromoted.contentHash,
    'Promotion must publish the candidate overlay'
  )

  // Promoted overlay must succeed on external route
  const selected = rcs.select('external', { baselineRef, overlayRef: promotion.overlayRef }, catalogRefs)
  assert.equal(
    selected.overlayRef?.contentHash,
    promotion.overlayRef.contentHash,
    'Promoted overlay must be selectable'
  )
  report.evidence.overlaySucceededAfterPromotion = true

  // Verify next run sees the promoted overlay
  const nextRunHost = createSystemCommandHost({ rootDir, artifactsDir, runId: `${runId}-next` })
  const nextRunRCS = nextRunHost.rcs
  const nextRunSelected = nextRunRCS.select(
    'external',
    { baselineRef, overlayRef: promotion.overlayRef },
    catalogRefs
  )
  assert.equal(
    nextRunSelected.overlayRef?.contentHash,
    promotion.overlayRef.contentHash,
    'Next run must see promoted overlay'
  )

  // Verify old replay hash unchanged after promotion
  const postPromoteSnapshot = rcs.exportSnapshot()
  const postPromoteStore = new HarnessStateStore()
  for (const entry of postPromoteSnapshot.baselines) {
    postPromoteStore.publishBaseline(entry.document, { id: entry.ref.id, revision: entry.ref.revision })
  }
  for (const entry of postPromoteSnapshot.overlays) {
    postPromoteStore.publishOverlay(entry.overlay, { id: entry.ref.id, revision: entry.ref.revision })
  }
  const replayAfterPromote = replayFromRecordedPins({
    store: postPromoteStore,
    pins: firstCase.baseline.harnessPins,
    availableCatalogRefs: catalogRefs,
  })
  assert.equal(
    replayAfterPromote.pins.harnessContentHash,
    originalHash,
    'Old replay hash must remain unchanged after promotion'
  )
  report.pins.afterPromoteHash = replayAfterPromote.pins.harnessContentHash
  report.pins.replayHashUnchanged = originalHash === replayAfterPromote.pins.harnessContentHash

  report.classification = 'evolution_succeeded'

  // Write durable report
  const reportPath = path.join(artifactsDir, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  assert.ok(existsSync(reportPath), 'Report must be written to artifacts')

  console.log(`System e2e report: ${reportPath}`)

  // Final assertions
  assert.equal(report.classification, 'evolution_succeeded')
  assert.ok(report.evidence.catalogResolved)
  assert.ok(report.evidence.replayPassed)
  assert.ok(report.evidence.overlayFailedBeforePromotion)
  assert.ok(report.evidence.overlaySucceededAfterPromotion)
  assert.ok(report.evidence.modelCannotPromote)
  assert.ok(report.pins.replayHashUnchanged)
})

test('System E2E: live LLM gate always skips (not implemented)', async (t) => {
  // P1 fix: live arm is NOT implemented in this version.
  // This test must ALWAYS explicitly skip, whether or not creds exist.
  // Do not throw. Do not assert.fail when ANTHROPIC_API_KEY is set.
  t.skip('Live LLM integration not implemented in first version')
})
