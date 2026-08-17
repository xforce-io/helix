import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveFactorioExperimentCase } from '../src/experiment/cases.js'
import { analyzeFactorioExperiment } from '../src/experiment/statistics.js'
import { parseExperimentEvidenceIndex, writeExperimentAnalysis } from '../src/experiment/evidence.js'

test('experiment case selects a real task and a configured FLE slot', () => {
  const value = resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 3 }, { slots: 4 })
  assert.equal(value.taskId, 'iron_plate_throughput')
  assert.equal(value.slot, 3)
  assert.throws(() => resolveFactorioExperimentCase({ inputRef: 'factorio.throughput/iron-plate/v1', seed: 4 }, { slots: 4 }), /configured slot/)
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
