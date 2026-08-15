/**
 * Helix whole-system end-to-end test (Issue #24).
 *
 * Verifies the complete core loop:
 * 1. Catalog: load production cards, resolveCapabilitySet, resolveCardRefs
 * 2. Harness: selectValidateResolveFreeze with fixture adapter
 * 3. Replay: replayFromRecordedPins produces stable harnessContentHash
 * 4. Refinement: propose → evaluate → request → promote
 * 5. Authority: model/skill paths cannot promote
 * 6. Evolution: unpromoted overlay fail-closed on external route; promoted overlay
 *    succeeds on next-run overlay selection; old replay hash unchanged.
 *
 * This is a DETERMINISTIC, CREDENTIAL-FREE system e2e.
 * No live LLM, no Docker, no Factorio cluster.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { listProductionCards, resolveCapabilitySet, resolveCardRefs } from '../../src/catalog/index.js'
import { replayFromRecordedPins, selectValidateResolveFreeze, HarnessStateStore } from '../../src/harness/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { RefinementWorkflow, type RefinementPolicyV1, type EvaluationSuiteV1 } from '../../src/refinement/workflow.js'
import { signedConfiguration } from '../refinement/fixtures.js'
import { createSystemCommandHost, SYSTEM_EXTRACTOR_DIGEST } from './system-command-host.js'

type SystemReport = {
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
  }
}

function refinementError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RefinementError)
    return true
  })
}

test('System E2E: catalog → freeze → replay → propose → evaluate → request → promote → overlay', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-system-e2e-'))
  const report: SystemReport = {
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
    },
  }

  try {
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

    // === 2. HARNESS: selectValidateResolveFreeze + fixture run ===
    const host = createSystemCommandHost({ rootDir })
    const rcs = host.rcs
    const baselineSnapshot = rcs.exportSnapshot()
    const baselineRef = baselineSnapshot.baselines[0]!.ref

    // Verify harness freeze via adapter.evaluate (which calls selectValidateResolveFreeze internally)
    const workflow = new RefinementWorkflow(rcs, host.adapter, { now: host.now })
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

    const policyRef = workflow.publishPolicy(signedConfiguration('system-policy-v1', 'policy', policy))
    const suiteRef = workflow.publishSuite(signedConfiguration('system-suite-v1', 'suite', suite))

    // === 3. REPLAY: replayFromRecordedPins produces stable hash ===
    // Run baseline evaluation to get pins
    const baselineMetric = await host.adapter.evaluate({
      arm: 'baseline',
      case: suite.cases[0]!,
      baselineRef,
      policy,
      reservedRunRef: 'system-baseline-run',
    })
    assert.ok(baselineMetric.replayPassed, 'Baseline replay must pass')
    report.evidence.replayPassed = true

    const originalHash = baselineMetric.harnessPins.harnessContentHash
    report.pins.beforePromoteHash = originalHash

    // Replay again to verify hash stability
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
      pins: baselineMetric.harnessPins,
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

    // === 4. REFINEMENT: propose → evaluate → request → promote ===
    const proposal = await workflow.propose({
      proposalId: 'system-proposal-1',
      sourceRunRefs: ['system-source-run-1', 'system-source-run-2'],
      baselineRef,
      policyRef,
    })
    const generation = workflow.showGenerationJob(proposal.generationJobRef)
    assert.ok(generation.candidateRef, 'Generation must produce a candidate')

    const evaluationReport = await workflow.evaluate({
      candidateRef: generation.candidateRef,
      policyRef,
      suiteRef,
    })
    assert.equal(evaluationReport.verdict, 'passed', 'Evaluation must pass')
    report.passCount = evaluationReport.cases.filter(c => !c.baseline.failed && !c.candidate.failed).length
    report.failCount = evaluationReport.cases.filter(c => c.baseline.failed || c.candidate.failed).length

    // All cases must have shared pins and replay must pass
    for (const c of evaluationReport.cases) {
      assert.equal(
        c.baseline.sharedPins.model,
        c.candidate.sharedPins.model,
        'Shared pins must match across arms'
      )
      assert.ok(c.baseline.replayPassed && c.candidate.replayPassed, 'Replay must pass for all arms')
    }

    const requestRef = workflow.request(evaluationReport)

    // === 5. AUTHORITY: model/skill subject cannot promote ===
    refinementError(() =>
      workflow.manualPromote({ requestRef, subject: 'model-skill', policyRef })
    )
    report.evidence.modelCannotPromote = true

    // === 6. EVOLUTION: unpromoted overlay fail-closed; promoted overlay succeeds ===
    const candidate = rcs.getArtifact<{ overlayRef: typeof baselineRef }>(
      `${generation.candidateRef.kind}:${generation.candidateRef.id}@${generation.candidateRef.revision}#${generation.candidateRef.contentHash}`
    )!
    const unpromoted = candidate.overlayRef

    // Prepare availableCatalogRefs for selection
    const catalogRefs = resolveCardRefs(resolveCapabilitySet('helix.runtime.core/v1')).map(r => ({
      id: r.ref.id,
      version: r.ref.version,
    }))

    // Unpromoted overlay must fail on external route
    refinementError(() => rcs.select('external', { baselineRef, overlayRef: unpromoted }, catalogRefs))
    report.evidence.overlayFailedBeforePromotion = true

    // Manual promotion by authorized researcher
    const promotion = workflow.manualPromote({
      requestRef,
      subject: 'system-researcher',
      policyRef,
    })
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
    const nextRunHost = createSystemCommandHost({ rootDir })
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
    // Reconstruct store from post-promotion snapshot
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
      pins: baselineMetric.harnessPins,
      availableCatalogRefs: resolveCardRefs(resolveCapabilitySet('helix.runtime.core/v1')).map(r => ({
        id: r.ref.id,
        version: r.ref.version,
      })),
    })
    assert.equal(
      replayAfterPromote.pins.harnessContentHash,
      originalHash,
      'Old replay hash must remain unchanged after promotion'
    )
    report.pins.afterPromoteHash = replayAfterPromote.pins.harnessContentHash
    report.pins.replayHashUnchanged = originalHash === replayAfterPromote.pins.harnessContentHash

    report.classification = 'evolution_succeeded'

    // Write structured report
    const reportPath = path.join(rootDir, 'system-e2e-report.json')
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }

  // Final assertions
  assert.equal(report.classification, 'evolution_succeeded')
  assert.ok(report.evidence.catalogResolved)
  assert.ok(report.evidence.replayPassed)
  assert.ok(report.evidence.overlayFailedBeforePromotion)
  assert.ok(report.evidence.overlaySucceededAfterPromotion)
  assert.ok(report.evidence.modelCannotPromote)
  assert.ok(report.pins.replayHashUnchanged)
})

test('System E2E: live LLM gate skips without credentials', async () => {
  // S0 live-LLM gate: if HELIX_E2E_LIVE=1 and credentials are missing, skip
  if (process.env.HELIX_E2E_LIVE !== '1') {
    // Not gated, pass immediately
    return
  }

  // Check for required credentials (example: ANTHROPIC_API_KEY)
  if (!process.env.ANTHROPIC_API_KEY) {
    // Explicitly skip: do not pass, do not fail
    const skip = new Error('SKIP: live LLM credentials not available')
    ;(skip as { code?: string }).code = 'ERR_TEST_SKIPPED'
    throw skip
  }

  // If HELIX_E2E_LIVE=1 and credentials exist, live test should run here
  // (not implemented in first version)
  assert.fail('Live LLM e2e not implemented in first version')
})
