/** Immutable, Factorio-only experiment evidence index and analysis writer. */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { canonicalJson, digest } from '../canonical.js'
import { ARTIFACT_ROOT, LIVE_WALL_TIMEOUT_MS } from '../cli-common.js'
import { resolveFactorioExperimentCase } from './cases.js'
import {
  assertFreezeIntegrity,
  classifyOfficialIndex,
  type FactorioExperimentFreeze,
} from './freeze.js'
import {
  analyzeFactorioExperiment,
  type ExperimentAnalysis,
  type ExperimentArm,
  type ExperimentPair,
} from './statistics.js'

export type ExperimentPairEvidence = ExperimentPair & {
  inputRef: string
  taskId: string
  taskDigest: string
  slot: number
  seed: number
  repetitionIndex: number
  baselineEvidencePath: string
  candidateEvidencePath: string
  baselineReplayPath: string
  candidateReplayPath: string
}

export type ExperimentEvidenceIndex = {
  schemaVersion: 'helix.factorio.experiment-index/v1'
  experimentId: string
  freezeId: string
  contentDigest: string
  /** RCS report identity is opaque to the example analysis code. */
  reportRef: string
  candidateRef: string
  overlayRef: string
  pairs: ExperimentPairEvidence[]
}

export type ExperimentAnalysisArtifact = {
  schemaVersion: 'helix.factorio.experiment-analysis/v1'
  experimentId: string
  indexDigest: string
  freezeId: string
  contentDigest: string
  mode: 'official' | 'smoke'
  reportRef: string
  candidateRef: string
  overlayRef: string
  analysis: ExperimentAnalysis
}


function isSafeExperimentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function readArm(value: unknown, label: string): ExperimentPair['baseline'] {
  const arm = asRecord(value)
  if (arm === undefined || typeof arm.success !== 'boolean' || typeof arm.replayPassed !== 'boolean') {
    throw new Error(`${label} must have boolean success and replayPassed`)
  }
  return {
    success: arm.success,
    replayPassed: arm.replayPassed,
    cost: requireFinite(arm.cost, `${label}.cost`),
    latencyMs: requireFinite(arm.latencyMs, `${label}.latencyMs`),
  }
}

function readPair(value: unknown, index: number): ExperimentPairEvidence {
  const pair = asRecord(value)
  if (pair === undefined) throw new Error(`pairs[${index}] must be an object`)
  const slot = requireFinite(pair.slot, `pairs[${index}].slot`)
  const seed = requireFinite(pair.seed, `pairs[${index}].seed`)
  const repetitionIndex = requireFinite(pair.repetitionIndex, `pairs[${index}].repetitionIndex`)
  if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(seed) || !Number.isSafeInteger(repetitionIndex)) {
    throw new Error(`pairs[${index}] slot, seed, and repetitionIndex must be integers`)
  }
  return {
    caseId: requireString(pair.caseId, `pairs[${index}].caseId`),
    inputRef: requireString(pair.inputRef, `pairs[${index}].inputRef`),
    taskId: requireString(pair.taskId, `pairs[${index}].taskId`),
    taskDigest: requireString(pair.taskDigest, `pairs[${index}].taskDigest`),
    slot,
    seed,
    repetitionIndex,
    category: requireString(pair.category, `pairs[${index}].category`),
    weight: requireFinite(pair.weight, `pairs[${index}].weight`),
    baseline: readArm(pair.baseline, `pairs[${index}].baseline`),
    candidate: readArm(pair.candidate, `pairs[${index}].candidate`),
    baselineEvidencePath: requireString(pair.baselineEvidencePath, `pairs[${index}].baselineEvidencePath`),
    candidateEvidencePath: requireString(pair.candidateEvidencePath, `pairs[${index}].candidateEvidencePath`),
    baselineReplayPath: requireString(pair.baselineReplayPath, `pairs[${index}].baselineReplayPath`),
    candidateReplayPath: requireString(pair.candidateReplayPath, `pairs[${index}].candidateReplayPath`),
  }
}

function assertSameNumber(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label} differs from immutable live evidence`)
}

/**
 * A replay of a failed task is still valid evidence when it deterministically
 * reproduces the recorded failure.  `verdict=pass` additionally includes
 * S2.live-success, so it cannot serve as the experiment's replay predicate.
 */
function replayReproduced(record: Record<string, unknown>): boolean {
  const checks = record.checks
  if (!Array.isArray(checks)) return record.verdict === 'pass'
  const required = new Set([
    'S2.parent-replay-zero-live',
    'S2.parent-replay-io-consumed',
    'S2.parent-replay-projection',
    'S2.replay-object-refs',
    'S2.replay-finalization',
    'S3.replay-zero-live-effects',
    'S3.replay-io-consumed',
  ])
  const found = new Set<string>()
  for (const value of checks) {
    const check = asRecord(value)
    if (check !== undefined && typeof check.id === 'string' && required.has(check.id)) {
      if (check.passed !== true) return false
      found.add(check.id)
    }
  }
  return found.size === required.size
}

async function verifyArmEvidence(input: {
  arm: ExperimentArm
  livePath: string
  replayPath: string
  label: string
  pair: ExperimentPairEvidence
  freezeId: string
  contentDigest: string
}): Promise<{ model: string; fle: unknown; taskId: string; taskDigest: string }> {
  if (!path.isAbsolute(input.livePath) || !path.isAbsolute(input.replayPath)) {
    throw new Error(`${input.label} evidence paths must be absolute`)
  }
  let live: unknown
  let replay: unknown
  try {
    [live, replay] = await Promise.all([
      fs.readFile(input.livePath, 'utf8').then(JSON.parse),
      fs.readFile(input.replayPath, 'utf8').then(JSON.parse),
    ])
  } catch (error) {
    throw new Error(`${input.label} evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const liveRecord = asRecord(live)
  const replayRecord = asRecord(replay)
  const projection = liveRecord === undefined ? undefined : asRecord(liveRecord.finalProjection)
  const budget = liveRecord === undefined ? undefined : asRecord(liveRecord.budget)
  const pins = liveRecord === undefined ? undefined : asRecord(liveRecord.pins)
  const profile = liveRecord === undefined ? undefined : asRecord(liveRecord.experimentProfile)
  if (
    liveRecord === undefined ||
    typeof liveRecord.schema !== 'string' || !liveRecord.schema.startsWith('helix.factorio.live/') ||
    typeof liveRecord.runId !== 'string' ||
    liveRecord.freezeId !== input.freezeId ||
    liveRecord.contentDigest !== input.contentDigest ||
    projection === undefined || budget === undefined || pins === undefined || profile === undefined ||
    typeof asRecord(projection.verification)?.success !== 'boolean' ||
    typeof projection.modelCallCount !== 'number' ||
    typeof budget.deadlineAt !== 'number' || typeof budget.remainingWallMsAtEnd !== 'number' ||
    typeof pins.model !== 'string' || pins.fle !== '0.4.3' ||
    typeof pins.taskId !== 'string' || typeof pins.taskDigest !== 'string' ||
    typeof profile.digest !== 'string' ||
    replayRecord === undefined || typeof replayRecord.verdict !== 'string'
  ) {
    throw new Error(`${input.label} evidence schema is incomplete`)
  }
  const expectedProfile = resolveFactorioExperimentCase({ inputRef: input.pair.inputRef, seed: input.pair.slot })
  if (
    pins.taskId !== input.pair.taskId ||
    pins.taskDigest !== input.pair.taskDigest ||
    profile.inputRef !== input.pair.inputRef ||
    profile.taskId !== input.pair.taskId ||
    profile.taskDigest !== input.pair.taskDigest ||
    profile.slot !== input.pair.slot ||
    profile.seed !== input.pair.seed ||
    profile.category !== input.pair.category ||
    profile.digest !== expectedProfile.digest
  ) {
    throw new Error(`${input.label} live identity does not match freeze matrix`)
  }
  const success = asRecord(projection.verification)!.success as boolean
  assertSameNumber(projection.modelCallCount, input.arm.cost, `${input.label}.cost`)
  assertSameNumber(
    Math.max(0, LIVE_WALL_TIMEOUT_MS - budget.remainingWallMsAtEnd),
    input.arm.latencyMs,
    `${input.label}.latencyMs`,
  )
  if (success !== input.arm.success) throw new Error(`${input.label}.success differs from immutable live evidence`)
  if (replayReproduced(replayRecord) !== input.arm.replayPassed) {
    throw new Error(`${input.label}.replayPassed differs from immutable replay evidence`)
  }
  return { model: pins.model, fle: pins.fle, taskId: pins.taskId, taskDigest: pins.taskDigest }
}

async function verifyPairEvidence(pair: ExperimentPairEvidence, freezeId: string, contentDigest: string): Promise<void> {
  const [baseline, candidate] = await Promise.all([
    verifyArmEvidence({ arm: pair.baseline, livePath: pair.baselineEvidencePath, replayPath: pair.baselineReplayPath, label: `${pair.caseId}.baseline`, pair, freezeId, contentDigest }),
    verifyArmEvidence({ arm: pair.candidate, livePath: pair.candidateEvidencePath, replayPath: pair.candidateReplayPath, label: `${pair.caseId}.candidate`, pair, freezeId, contentDigest }),
  ])
  if (
    baseline.model !== candidate.model ||
    baseline.fle !== candidate.fle ||
    baseline.taskId !== candidate.taskId ||
    baseline.taskDigest !== candidate.taskDigest
  ) {
    throw new Error(`${pair.caseId} baseline/candidate shared pins are asymmetric`)
  }
}

/** Closed parser: hand-edited or incomplete pair indexes never reach statistics. */
export function parseExperimentEvidenceIndex(text: string): ExperimentEvidenceIndex {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('experiment evidence index is not JSON')
  }
  const index = asRecord(raw)
  if (index === undefined || index.schemaVersion !== 'helix.factorio.experiment-index/v1') {
    throw new Error('experiment evidence index schemaVersion is invalid')
  }
  const experimentId = requireString(index.experimentId, 'experimentId')
  if (!isSafeExperimentId(experimentId)) throw new Error('experimentId must be a lowercase safe identifier')
  if (!Array.isArray(index.pairs) || index.pairs.length === 0) throw new Error('pairs must be a non-empty array')
  const pairs = index.pairs.map(readPair)
  if (new Set(pairs.map(pair => pair.caseId)).size !== pairs.length) {
    throw new Error('experiment evidence index has duplicate caseId')
  }
  const evidencePaths = pairs.flatMap(pair => [
    pair.baselineEvidencePath,
    pair.candidateEvidencePath,
    pair.baselineReplayPath,
    pair.candidateReplayPath,
  ])
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    throw new Error('experiment evidence index reuses an arm evidence path')
  }
  return {
    schemaVersion: 'helix.factorio.experiment-index/v1',
    experimentId,
    freezeId: requireString(index.freezeId, 'freezeId'),
    contentDigest: requireString(index.contentDigest, 'contentDigest'),
    reportRef: requireString(index.reportRef, 'reportRef'),
    candidateRef: requireString(index.candidateRef, 'candidateRef'),
    overlayRef: requireString(index.overlayRef, 'overlayRef'),
    pairs,
  }
}

/**
 * Persist canonical analysis under the experiment's own artifact directory.
 * Input evidence remains immutable and is only referenced by the index.
 */
export async function writeExperimentAnalysis(input: {
  index: ExperimentEvidenceIndex
  freeze: FactorioExperimentFreeze
  root?: string
}): Promise<{ artifact: ExperimentAnalysisArtifact; path: string }> {
  if (input.index.freezeId !== input.freeze.freezeId || input.index.contentDigest !== input.freeze.contentDigest) {
    throw new Error('experiment index freeze identity does not match freeze')
  }
  assertFreezeIntegrity(input.freeze)
  const mode = classifyOfficialIndex(input.index.pairs, input.freeze)
  await Promise.all(input.index.pairs.map(pair => verifyPairEvidence(pair, input.index.freezeId, input.index.contentDigest)))
  const analysis = analyzeFactorioExperiment(input.index.pairs, input.freeze.thresholds)
  const official = mode === 'official'
    ? analysis
    : {
        ...analysis,
        verdict: 'indeterminate' as const,
        failures: [...analysis.failures.filter(item => item !== 'PAIR_COUNT_BELOW_MINIMUM'), 'NOT_OFFICIAL_MATRIX'],
      }
  const artifact: ExperimentAnalysisArtifact = {
    schemaVersion: 'helix.factorio.experiment-analysis/v1',
    experimentId: input.index.experimentId,
    indexDigest: digest(canonicalJson(input.index)),
    freezeId: input.freeze.freezeId,
    contentDigest: input.freeze.contentDigest,
    mode,
    reportRef: input.index.reportRef,
    candidateRef: input.index.candidateRef,
    overlayRef: input.index.overlayRef,
    analysis: official,
  }
  const root = path.resolve(input.root ?? path.join(ARTIFACT_ROOT, 'experiments'))
  const output = path.join(root, input.index.experimentId, 'analysis.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, `${canonicalJson(artifact)}\n`, 'utf8')
  return { artifact, path: output }
}
