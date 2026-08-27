import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  FACTORIO_DEVELOPMENT_TASKS,
  FACTORIO_EXPERIMENT_TASKS,
  FACTORIO_OFFICIAL_HOLDOUT_TASKS,
  OFFICIAL_EXPERIMENT_INPUT_REFS,
  assertExperimentTaskPartitions,
  resolveFactorioExperimentCase,
} from '../src/experiment/cases.js'
import { assertOfficialPromotionPrecondition, parseExperimentEvidenceIndex, writeExperimentAnalysis } from '../src/experiment/evidence.js'
import {
  OFFICIAL_FREEZE_ID,
  assertIsolatedExperimentStateRoot,
  assertFreezeIntegrity,
  assertProjectionHasNoHoldout,
  assertSuiteProjectionMatchesMatrix,
  buildOfficialFreeze,
  buildOfficialMatrix,
  buildOfficialSuiteCases,
  classifyOfficialIndex,
  defaultDurableHarnessStateRoot,
  sealFactorioExperimentFreeze,
  type CanonicalMatrixRow,
} from '../src/experiment/freeze.js'
import { analyzeFactorioExperiment } from '../src/experiment/statistics.js'

const FREEZE = buildOfficialFreeze({
  suiteId: 'suite:success-rate-v1',
  suiteDigest: 'sha256:suite',
  policyId: 'policy:success-rate-v1',
  policyDigest: 'sha256:policy',
})

function liveJson(row: CanonicalMatrixRow, success: boolean, cost: number, latencyMs: number): string {
  const profile = resolveFactorioExperimentCase({ inputRef: row.inputRef, seed: row.slot })
  return JSON.stringify({
    schema: 'helix.factorio.live/v3',
    runId: `${row.caseId}-live`,
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    pins: { model: 'test-model', fle: '0.4.3', taskId: row.taskId, taskDigest: row.taskDigest },
    experimentProfile: {
      inputRef: row.inputRef,
      taskId: row.taskId,
      taskDigest: row.taskDigest,
      category: row.category,
      slot: row.slot,
      seed: row.seed,
      digest: profile.digest,
    },
    finalProjection: { verification: { success }, modelCallCount: cost },
    budget: { deadlineAt: 1, remainingWallMsAtEnd: 1_800_000 - latencyMs },
  })
}

async function writePairFiles(
  temp: string,
  row: CanonicalMatrixRow,
  values: { success: boolean; cost: number; latencyMs: number },
) {
  const files = {
    baselineEvidencePath: path.join(temp, `${row.caseId}-b-live.json`),
    candidateEvidencePath: path.join(temp, `${row.caseId}-c-live.json`),
    baselineReplayPath: path.join(temp, `${row.caseId}-b-replay.json`),
    candidateReplayPath: path.join(temp, `${row.caseId}-c-replay.json`),
  }
  const live = liveJson(row, values.success, values.cost, values.latencyMs)
  await Promise.all([
    writeFile(files.baselineEvidencePath, live),
    writeFile(files.candidateEvidencePath, live),
    writeFile(files.baselineReplayPath, JSON.stringify({ verdict: 'pass' })),
    writeFile(files.candidateReplayPath, JSON.stringify({ verdict: 'pass' })),
  ])
  return {
    ...row,
    baseline: { success: values.success, replayPassed: true, cost: values.cost, latencyMs: values.latencyMs },
    candidate: { success: values.success, replayPassed: true, cost: values.cost, latencyMs: values.latencyMs },
    ...files,
  }
}

test('experiment case selects a real task and a configured FLE slot', () => {
  const value = resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 3 }, { slots: 4 })
  assert.equal(value.taskId, 'iron_plate_throughput')
  assert.equal(value.taskDigest, 'sha256:0e111447aae5e5d6ba9430a0219b70f632ac4f99b63c2f25101b8663b072aee2')
  assert.equal(value.slot, 3)
  assert.equal(value.seed, 3)
  assert.throws(() => resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 4 }, { slots: 4 }), /configured slot/)
  assert.throws(
    () => resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 1, slot: 2 }, { slots: 4 }),
    /must equal slot/,
  )
})

test('experiment task catalog contains only FLE-verified official identities', () => {
  assert.equal(Object.keys(FACTORIO_EXPERIMENT_TASKS).length, 20)
  assert.deepEqual(Object.keys(FACTORIO_OFFICIAL_HOLDOUT_TASKS), [...OFFICIAL_EXPERIMENT_INPUT_REFS])
  assert.equal(Object.keys(FACTORIO_DEVELOPMENT_TASKS).length, 10)
  assert.equal(resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/electronic-circuit/v1', seed: 0 }).taskId, 'electronic_circuit_throughput')
  assert.throws(
    () => resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/processing-unit/v1', seed: 0 }),
    /not registered/,
  )
  assert.doesNotThrow(assertExperimentTaskPartitions)
  assert.equal(OFFICIAL_FREEZE_ID, 'success-rate-v2')
  const developmentIdentities = new Set(Object.values(FACTORIO_DEVELOPMENT_TASKS)
    .flatMap(task => [task.taskId, task.taskDigest]))
  for (const task of Object.values(FACTORIO_OFFICIAL_HOLDOUT_TASKS)) {
    assert.equal(developmentIdentities.has(task.taskId), false)
    assert.equal(developmentIdentities.has(task.taskDigest), false)
  }
})

test('official freeze is exactly 10 tasks by 4 slots by 4 repetitions', () => {
  const matrix = buildOfficialMatrix()
  assert.equal(matrix.length, 160)
  assert.equal(new Set(matrix.map(row => row.caseId)).size, 160)
  assert.equal(new Set(matrix.map(row => row.inputRef)).size, 10)
  assert.deepEqual(FREEZE.coverage, {
    intermediate: { variants: 8, pairs: 32 },
    circuit: { variants: 4, pairs: 16 },
    science: { variants: 12, pairs: 48 },
    structure: { variants: 4, pairs: 16 },
    oil: { variants: 12, pairs: 48 },
  })
  assertSuiteProjectionMatchesMatrix(buildOfficialSuiteCases(), matrix)
  assert.equal(classifyOfficialIndex(matrix, FREEZE), 'official')
  assert.equal(classifyOfficialIndex(matrix.slice(0, 12), FREEZE), 'smoke')
  assert.throws(() => classifyOfficialIndex([{ ...matrix[0]!, taskDigest: 'sha256:forged' }], FREEZE), /drifts/)
  assert.throws(() => classifyOfficialIndex([{ ...matrix[0]!, caseId: 'unknown-slot-0-rep-0' }], FREEZE), /not in freeze matrix/)
})

test('a signed freeze cannot substitute a legacy id or development catalog', () => {
  const legacyId = sealFactorioExperimentFreeze({
    ...FREEZE,
    freezeId: 'success-rate-v1',
  })
  assert.throws(() => assertFreezeIntegrity(legacyId), /current official declaration/)

  const developmentCatalog = sealFactorioExperimentFreeze({
    ...FREEZE,
    catalog: { ...FACTORIO_DEVELOPMENT_TASKS },
  })
  assert.throws(() => assertFreezeIntegrity(developmentCatalog), /certified official holdout/)
})

test('analysis only accepts a significant 10pp paired improvement with replay', () => {
  const pairs = Array.from({ length: 160 }, (_, index) => ({
    caseId: `case-${index}`,
    category: index % 2 === 0 ? 'raw-material' : 'intermediate',
    weight: 1,
    baseline: { success: index < 48, replayPassed: true, cost: 10, latencyMs: 10 },
    candidate: { success: index < 96, replayPassed: true, cost: 11, latencyMs: 11 },
  }))
  assert.equal(analyzeFactorioExperiment(pairs).verdict, 'passed')
  pairs[0]!.candidate.replayPassed = false
  assert.equal(analyzeFactorioExperiment(pairs).verdict, 'indeterminate')
})

test('analysis rejects a category regression despite aggregate success uplift', () => {
  const pairs = Array.from({ length: 160 }, (_, index) => ({
    caseId: `case-${index}`,
    category: index < 20 ? 'advanced' : 'raw-material',
    weight: 1,
    baseline: { success: index < 70, replayPassed: true, cost: 10, latencyMs: 10 },
    candidate: { success: index >= 20 && index < 130, replayPassed: true, cost: 10, latencyMs: 10 },
  }))
  const analysis = analyzeFactorioExperiment(pairs)
  assert.ok(analysis.failures.includes('CATEGORY_REGRESSION_EXCEEDED'))
  assert.equal(analysis.verdict, 'failed')
})

test('smoke index of a freeze subset cannot be an official promotion verdict', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-experiment-'))
  const matrix = buildOfficialMatrix()
  const rows = [
    ...[0, 1, 2, 3].map(slot => matrix.find(row => row.slot === slot)!),
    ...FREEZE.keyCategories
      .map(category => matrix.find(row => row.category === category)!),
  ].filter((row, index, all) => all.findIndex(item => item.caseId === row.caseId) === index)
  assert.equal(new Set(rows.map(row => row.category)).size, FREEZE.keyCategories.length)
  assert.equal(new Set(rows.map(row => row.slot)).size, 4)
  const pairs = await Promise.all(rows.map(row => writePairFiles(temp, row, { success: true, cost: 10, latencyMs: 10 })))
  const index = parseExperimentEvidenceIndex(JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-index/v1',
    experimentId: FREEZE.freezeId,
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    reportRef: 'evaluation-report:report@0#abc',
    candidateRef: 'candidate:candidate@0#def',
    overlayRef: 'overlay:factorio.candidate@1#123',
    pairs,
  }))
  const written = await writeExperimentAnalysis({ index, freeze: FREEZE, root: temp })
  assert.equal(written.artifact.mode, 'smoke')
  assert.equal(written.artifact.analysis.verdict, 'indeterminate')
  assert.ok(written.artifact.analysis.failures.includes('NOT_OFFICIAL_MATRIX'))
  assert.equal(written.artifact.candidateRef, 'candidate:candidate@0#def')
  assert.throws(
    () => parseExperimentEvidenceIndex(JSON.stringify({ ...index, pairs: [...pairs, pairs[0]] })),
    /duplicate caseId/,
  )
})

test('index that replaces a frozen task identity is rejected before analysis', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-experiment-drift-'))
  const row = buildOfficialMatrix()[0]!
  const pair = await writePairFiles(temp, row, { success: true, cost: 10, latencyMs: 10 })
  const index = parseExperimentEvidenceIndex(JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-index/v1',
    experimentId: FREEZE.freezeId,
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    reportRef: 'report',
    candidateRef: 'candidate',
    overlayRef: 'overlay',
    pairs: [{ ...pair, taskDigest: 'sha256:forged' }],
  }))
  await assert.rejects(() => writeExperimentAnalysis({ index, freeze: FREEZE, root: temp }), /drifts/)
})

test('experiment evidence accepts a deterministically replayed failed arm', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-experiment-replay-'))
  const row = buildOfficialMatrix()[0]!
  const livePaths = [path.join(temp, 'baseline-live.json'), path.join(temp, 'candidate-live.json')]
  const replayPaths = [path.join(temp, 'baseline-replay.json'), path.join(temp, 'candidate-replay.json')]
  const live = liveJson(row, false, 2, 2)
  const replay = JSON.stringify({
    verdict: 'fail',
    checks: [
      'S2.parent-replay-zero-live', 'S2.parent-replay-io-consumed',
      'S2.parent-replay-projection', 'S2.replay-object-refs',
      'S2.replay-finalization', 'S3.replay-zero-live-effects',
      'S3.replay-io-consumed',
    ].map(id => ({ id, passed: true })),
  })
  await Promise.all([...livePaths.map(file => writeFile(file, live)), ...replayPaths.map(file => writeFile(file, replay))])
  const index = parseExperimentEvidenceIndex(JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-index/v1',
    experimentId: FREEZE.freezeId,
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    reportRef: 'report',
    candidateRef: 'candidate',
    overlayRef: 'overlay',
    pairs: [{
      ...row,
      baseline: { success: false, replayPassed: true, cost: 2, latencyMs: 2 },
      candidate: { success: false, replayPassed: true, cost: 2, latencyMs: 2 },
      baselineEvidencePath: livePaths[0],
      candidateEvidencePath: livePaths[1],
      baselineReplayPath: replayPaths[0],
      candidateReplayPath: replayPaths[1],
    }],
  }))
  const written = await writeExperimentAnalysis({ index, freeze: FREEZE, root: temp })
  assert.equal(written.artifact.mode, 'smoke')
  assert.equal(written.artifact.analysis.verdict, 'indeterminate')
})

test('official experiment state root must be isolated from the durable default', async () => {
  const previous = process.env['HELIX_FACTORIO_HARNESS_STATE_ROOT']
  delete process.env['HELIX_FACTORIO_HARNESS_STATE_ROOT']
  assert.throws(() => assertIsolatedExperimentStateRoot(), /requires HELIX_FACTORIO_HARNESS_STATE_ROOT/)
  assert.throws(() => assertIsolatedExperimentStateRoot(defaultDurableHarnessStateRoot()), /overlap/)
  assert.throws(() => assertIsolatedExperimentStateRoot(path.join(defaultDurableHarnessStateRoot(), 'nested-experiment')), /overlap/)
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-isolated-'))
  const isolated = path.join(temp, 'experiment-state')
  await mkdir(isolated)
  assert.match(assertIsolatedExperimentStateRoot(isolated), /experiment-state$/)
  const link = path.join(temp, 'alias-default')
  await mkdir(defaultDurableHarnessStateRoot(), { recursive: true })
  await symlink(defaultDurableHarnessStateRoot(), link)
  assert.throws(() => assertIsolatedExperimentStateRoot(link), /overlap/)
  assert.throws(() => assertIsolatedExperimentStateRoot(path.join(link, 'not-yet', 'experiment')), /overlap/)
  if (previous === undefined) delete process.env['HELIX_FACTORIO_HARNESS_STATE_ROOT']
  else process.env['HELIX_FACTORIO_HARNESS_STATE_ROOT'] = previous
})

test('generation projection cannot carry official holdout identity', () => {
  assert.throws(
    () => assertProjectionHasNoHoldout({ recentFeedback: 'factorio.throughput/advanced-circuit/v1' }),
    /inputRef/,
  )
  assert.doesNotThrow(() => assertProjectionHasNoHoldout({ recentFeedback: 'reuse successful mining cells' }))
})

test('official promotion requires a passed official analysis bound to the candidate', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-promote-'))
  const analysisPath = path.join(temp, 'analysis.json')
  assert.throws(
    () => assertOfficialPromotionPrecondition({ freeze: FREEZE, candidateId: 'cand-1', analysisPath }),
    /readable official analysis/,
  )
  await writeFile(analysisPath, JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-analysis/v1',
    experimentId: FREEZE.freezeId,
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    mode: 'smoke',
    candidateRef: 'candidate:cand-1@0#abc',
    overlayRef: 'overlay:o@0#def',
    analysis: { verdict: 'indeterminate' },
  }))
  assert.throws(
    () => assertOfficialPromotionPrecondition({ freeze: FREEZE, candidateId: 'cand-1', analysisPath }),
    /passed official 160-pair analysis/,
  )
  await writeFile(analysisPath, JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-analysis/v1',
    experimentId: 'other-experiment',
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    mode: 'official',
    candidateRef: 'candidate:cand-1@0#abc',
    overlayRef: 'overlay:o@0#def',
    analysis: { verdict: 'passed' },
  }))
  assert.throws(
    () => assertOfficialPromotionPrecondition({ freeze: FREEZE, candidateId: 'cand-1', analysisPath }),
    /does not match the published freeze/,
  )
  await writeFile(analysisPath, JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-analysis/v1',
    experimentId: FREEZE.freezeId,
    freezeId: FREEZE.freezeId,
    contentDigest: FREEZE.contentDigest,
    mode: 'official',
    candidateRef: 'candidate:cand-1@0#abc',
    overlayRef: 'overlay:o@0#def',
    analysis: { verdict: 'passed' },
  }))
  assert.doesNotThrow(() => assertOfficialPromotionPrecondition({ freeze: FREEZE, candidateId: 'cand-1', analysisPath }))
  assert.throws(
    () => assertOfficialPromotionPrecondition({ freeze: FREEZE, candidateId: 'cand-1-approved', analysisPath }),
    /candidate does not match/,
  )
  assert.throws(
    () => assertOfficialPromotionPrecondition({ freeze: FREEZE, candidateId: 'other', analysisPath }),
    /candidate does not match/,
  )
  const tampered = { ...FREEZE, contentDigest: 'sha256:forged' }
  assert.throws(
    () => assertOfficialPromotionPrecondition({ freeze: tampered, candidateId: 'cand-1', analysisPath }),
    /contentDigest|untrusted|freeze/,
  )
})
