import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  FACTORIO_EXPERIMENT_TASKS,
  resolveFactorioExperimentCase,
} from '../src/experiment/cases.js'
import { analyzeFactorioExperiment } from '../src/experiment/statistics.js'
import { parseExperimentEvidenceIndex, writeExperimentAnalysis } from '../src/experiment/evidence.js'

test('experiment case selects a real task and a configured FLE slot', () => {
  const value = resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 3 }, { slots: 4 })
  assert.equal(value.taskId, 'iron_plate_throughput')
  assert.equal(value.taskDigest, 'sha256:0e111447aae5e5d6ba9430a0219b70f632ac4f99b63c2f25101b8663b072aee2')
  assert.equal(value.slot, 3)
  assert.throws(() => resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 4 }, { slots: 4 }), /configured slot/)
})

test('experiment task catalog contains only FLE-verified task identities', () => {
  assert.deepEqual(Object.keys(FACTORIO_EXPERIMENT_TASKS).sort(), [
    'factorio.throughput/iron-ore/v1',
    'factorio.throughput/iron-plate/v1',
  ])
  assert.throws(
    () => resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/electronic-circuit/v1', seed: 0 }),
    /not registered/,
  )
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

test('experiment index is closed, canonical, and binds analysis to candidate and overlay', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-experiment-'))
  const pairs = Array.from({ length: 10 }, (_, index) => ({
    caseId: `case-${index}`,
    category: 'raw-material',
    weight: 1,
    baseline: { success: true, replayPassed: true, cost: 10, latencyMs: 10 },
    candidate: { success: true, replayPassed: true, cost: 10, latencyMs: 10 },
    baselineEvidencePath: path.join(temp, `baseline-${index}-live.json`),
    candidateEvidencePath: path.join(temp, `candidate-${index}-live.json`),
    baselineReplayPath: path.join(temp, `baseline-${index}-replay.json`),
    candidateReplayPath: path.join(temp, `candidate-${index}-replay.json`),
  }))
  await Promise.all(pairs.flatMap(pair => [
    writeFile(pair.baselineEvidencePath, JSON.stringify({ finalProjection: { verification: { success: true }, modelCallCount: 10 }, budget: { deadlineAt: 1000, remainingWallMsAtEnd: 1_800_000 - 10 } })),
    writeFile(pair.candidateEvidencePath, JSON.stringify({ finalProjection: { verification: { success: true }, modelCallCount: 10 }, budget: { deadlineAt: 1000, remainingWallMsAtEnd: 1_800_000 - 10 } })),
    writeFile(pair.baselineReplayPath, JSON.stringify({ verdict: 'pass' })),
    writeFile(pair.candidateReplayPath, JSON.stringify({ verdict: 'pass' })),
  ]))
  const index = parseExperimentEvidenceIndex(JSON.stringify({
    schemaVersion: 'helix.factorio.experiment-index/v1',
    experimentId: 'success-rate-v1',
    reportRef: 'evaluation-report:report@0#abc',
    candidateRef: 'candidate:candidate@0#def',
    overlayRef: 'overlay:factorio.candidate@1#123',
    pairs,
  }))
  const written = await writeExperimentAnalysis({ index, root: temp, thresholds: { minPairs: 10 } })
  assert.equal(written.artifact.analysis.verdict, 'failed')
  assert.equal(written.artifact.candidateRef, 'candidate:candidate@0#def')
  assert.equal(JSON.parse(await readFile(written.path, 'utf8')).overlayRef, 'overlay:factorio.candidate@1#123')
  assert.throws(() => parseExperimentEvidenceIndex(JSON.stringify({ ...index, pairs: [...pairs, pairs[0]] })), /duplicate caseId/)
})

test('experiment evidence accepts a deterministically replayed failed arm', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'helix-factorio-experiment-replay-'))
  const livePaths = [path.join(temp, 'baseline-live.json'), path.join(temp, 'candidate-live.json')]
  const replayPaths = [path.join(temp, 'baseline-replay.json'), path.join(temp, 'candidate-replay.json')]
  const live = JSON.stringify({ finalProjection: { verification: { success: false }, modelCallCount: 2 }, budget: { deadlineAt: 1, remainingWallMsAtEnd: 1_800_000 - 2 } })
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
    schemaVersion: 'helix.factorio.experiment-index/v1', experimentId: 'failed-replay-v1',
    reportRef: 'report', candidateRef: 'candidate', overlayRef: 'overlay',
    pairs: [{
      caseId: 'case-0', category: 'raw-material', weight: 1,
      baseline: { success: false, replayPassed: true, cost: 2, latencyMs: 2 },
      candidate: { success: false, replayPassed: true, cost: 2, latencyMs: 2 },
      baselineEvidencePath: livePaths[0], candidateEvidencePath: livePaths[1],
      baselineReplayPath: replayPaths[0], candidateReplayPath: replayPaths[1],
    }],
  }))
  await assert.doesNotReject(() => writeExperimentAnalysis({ index, root: temp, thresholds: { minPairs: 1 } }))
})
