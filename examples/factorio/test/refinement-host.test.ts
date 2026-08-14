import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { pins } from '../src/cli-common.js'
import {
  assembleFactorioRun,
  createFactorioHostBundle,
  openFactorioReplayHost,
} from '../src/harness-host.js'
import {
  createFactorioRefinementCommandHost,
  extractFactorioEvaluationMetrics,
  FACTORIO_EXTRACTOR_DIGEST,
  parseHarnessStateRef,
  projectFactorioGenerationInput,
} from '../src/refinement-host.js'
import { reconstructFactorioReplayHarness } from '../src/replay.js'
import type { LiveEvidence } from '../src/types.js'
import { RefinementError } from '../../../src/refinement/errors.js'
import { RefinementWorkflow } from '../../../src/refinement/workflow.js'
import { signedConfiguration } from '../../../test/refinement/fixtures.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function recordedLive(runId: string, success: boolean): LiveEvidence {
  return {
    schema: 'helix.factorio.live/v3',
    verdict: success ? 'pass' : 'fail',
    runId,
    pins: pins('test-model'),
    budget: { deadlineAt: 1, remainingWallMsAtEnd: 1_000 },
    termination: success ? 'verifier_succeeded' : 'environment_failed',
    projectionDigest: 'd'.repeat(64),
    traceFile: 'trace.jsonl',
    objectStore: 'objects',
    finalProjection: {
      runId,
      episodeId: `${runId}:episode:0`,
      kernelRevision: 1,
      resetCount: 1,
      stepCount: 4,
      modelCallCount: 3,
      recursiveCallCount: 0,
      remainingRecursiveModelTokens: 0,
      cells: [],
      verification: { success, meta: [] },
      terminated: true,
      truncated: false,
    },
    finalization: {
      status: 'finalized',
      value: success ? 'success' : 'failure',
      verifierId: 'fle',
      finalizationId: 'fin',
      intentHash: 'i'.repeat(64),
      recordHash: 'r'.repeat(64),
    },
    childRunIds: [],
    checks: [],
  }
}

const policy = {
  schemaVersion: 'helix.refinement-policy/v1' as const,
  generation: { model: 'fixture-recorded-model', maxOutputTokens: 64 },
  extractorDigest: FACTORIO_EXTRACTOR_DIGEST,
  gate: { minQualityDelta: 0, maxCostRatio: 2, maxLatencyRatio: 2, maxFailureRateDelta: 1 },
  authority: { manualApprovers: ['fixture-researcher'] },
}

const suite = {
  schemaVersion: 'helix.refinement-suite/v1' as const,
  cases: [{ caseId: 'holdout', inputRef: 'in', seed: 0, weight: 1 }],
}

test('S1 live and replay Host share one RCS snapshot', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-rcs-'))
  try {
    const live = createFactorioHostBundle({ rootDir: root })
    const replay = openFactorioReplayHost({ rootDir: root })
    assert.equal(live.rcs.exportSnapshot().baselines.length, replay.store.exportSnapshot().baselines.length)
    assert.equal(live.defaultBaselineRef.contentHash, replay.store.read(live.defaultBaselineRef).ref.contentHash)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S2 Factorio exports a loadable refinement command host', () => {
  const host = createFactorioRefinementCommandHost()
  assert.equal(typeof host.adapter.generate, 'function')
  assert.ok(host.rcs)
  assert.equal(host.trustBundle.schemaVersion, 'helix.refinement-trust-bundle/v1')
})

test('S2 refinement CLI loads the relocated Factorio Host', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-cli-'))
  try {
    const result = spawnSync(
      path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
      [
        path.join(REPO_ROOT, 'src/refinement/cli.ts'),
        'refine',
        'show',
        'generation-job',
        '--host-module', path.join(REPO_ROOT, 'examples/factorio/src/refinement-host.ts'),
        '--ref', `generation-job:missing@0#${'0'.repeat(64)}`,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, /unknown file extension|Cannot find module|host module must export/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S3 live overlay selection admits only promoted refs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-overlay-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const host = createFactorioRefinementCommandHost({ rcs: bundle.rcs })
    const workflow = new RefinementWorkflow(host.rcs, host.adapter)
    const policyRef = workflow.publishPolicy(signedConfiguration('factorio-policy', 'policy', policy))
    const suiteRef = workflow.publishSuite(signedConfiguration('factorio-suite', 'suite', suite))
    const ack = await workflow.propose({
      proposalId: 'factorio-proposal',
      sourceRunRefs: ['factorio-source'],
      baselineRef: bundle.defaultBaselineRef,
      policyRef,
    })
    const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef
    assert.ok(candidateRef)
    const report = await workflow.evaluate({ candidateRef, policyRef, suiteRef })
    const requestRef = workflow.request(report)
    const candidate = host.rcs.getArtifact<{ overlayRef: { kind: string; id: string; revision: number; contentHash: string } }>(
      `${candidateRef.kind}:${candidateRef.id}@${candidateRef.revision}#${candidateRef.contentHash}`,
    )!
    assert.throws(
      () => assembleFactorioRun({
        bundle,
        basePins: pins('m'),
        baselineRef: bundle.defaultBaselineRef,
        overlayRef: candidate.overlayRef,
      }),
      (error: unknown) => error instanceof RefinementError,
    )
    const promotion = workflow.manualPromote({
      requestRef,
      subject: 'fixture-researcher',
      policyRef,
    })
    const assembled = assembleFactorioRun({
      bundle,
      basePins: pins('m'),
      baselineRef: bundle.defaultBaselineRef,
      overlayRef: promotion.overlayRef,
    })
    assert.equal(assembled.pins.harnessState?.overlayRef?.contentHash, promotion.overlayRef.contentHash)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S4 replay after promotion still uses recorded pins hash', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-replay-overlay-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const liveAssembled = assembleFactorioRun({
      bundle,
      basePins: pins('replay-model'),
      baselineRef: bundle.defaultBaselineRef,
    })
    const recordedHash = liveAssembled.frozen.harnessContentHash
    const host = createFactorioRefinementCommandHost({ rcs: bundle.rcs })
    const workflow = new RefinementWorkflow(host.rcs, host.adapter)
    const policyRef = workflow.publishPolicy(signedConfiguration('replay-policy', 'policy', policy))
    const suiteRef = workflow.publishSuite(signedConfiguration('replay-suite', 'suite', suite))
    const ack = await workflow.propose({
      proposalId: 'replay-proposal',
      sourceRunRefs: ['source'],
      baselineRef: bundle.defaultBaselineRef,
      policyRef,
    })
    const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef!
    const report = await workflow.evaluate({ candidateRef, policyRef, suiteRef })
    workflow.manualPromote({
      requestRef: workflow.request(report),
      subject: 'fixture-researcher',
      policyRef,
    })
    const reconstructed = reconstructFactorioReplayHarness(
      { pins: liveAssembled.pins, harness: liveAssembled.freeze.evidence },
      { rootDir: root },
    )
    assert.equal(reconstructed.freeze.frozen.harnessContentHash, recordedHash)
    assert.equal(reconstructed.pins.harnessState?.overlayRef, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P3 projection is a bounded summary and rejects unfinished runs', () => {
  const live = recordedLive('factorio-ok', false)
  const projection = projectFactorioGenerationInput(['factorio-ok'], {
    readLive: (runId) => runId === 'factorio-ok' ? live : undefined,
  })
  assert.equal(projection.sourceRunRefs[0], 'factorio-ok')
  assert.equal(projection.outcomes[0]?.verificationSuccess, false)
  assert.equal('cells' in projection, false)
  assert.throws(
    () => projectFactorioGenerationInput(['missing'], { readLive: () => undefined }),
    /recorded Factorio run/,
  )
  const unfinished = recordedLive('factorio-open', false)
  unfinished.finalProjection.terminated = false
  assert.throws(
    () => projectFactorioGenerationInput(['factorio-open'], { readLive: () => unfinished }),
    /not terminal/,
  )
})

test('P3 extractor reads FLE outcome not handwritten constants', () => {
  const pass = extractFactorioEvaluationMetrics(recordedLive('win', true))
  const fail = extractFactorioEvaluationMetrics(recordedLive('lose', false))
  assert.equal(pass.quality, 1)
  assert.equal(pass.failed, false)
  assert.equal(fail.quality, 0)
  assert.equal(fail.failed, true)
  assert.equal(pass.cost, 3)
  assert.ok(pass.latencyMs > 0)
})

test('parseHarnessStateRef accepts a complete overlay ref', () => {
  const ref = parseHarnessStateRef(`overlay:o1@0#${'a'.repeat(64)}`)
  assert.equal(ref.kind, 'overlay')
  assert.equal(ref.id, 'o1')
})
