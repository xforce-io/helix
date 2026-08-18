/** Official 160-pair freeze identity for the Factorio success-rate experiment. */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { signConfiguration, type RefinementTrustBundleV1 } from '../../../../src/refinement/trust.js'
import { canonicalJson, digest } from '../canonical.js'
import { ARTIFACT_ROOT } from '../cli-common.js'
import {
  FACTORIO_EXPERIMENT_TASKS,
  OFFICIAL_EXPERIMENT_INPUT_REFS,
  type FactorioExperimentTask,
} from './cases.js'
import {
  DEFAULT_EXPERIMENT_THRESHOLDS,
  type ExperimentThresholds,
} from './statistics.js'

export const OFFICIAL_FREEZE_ID = 'success-rate-v1'
export const OFFICIAL_FREEZE_SCHEMA = 'helix.factorio.experiment-freeze/v1' as const
export const OFFICIAL_SLOT_COUNT = 4
export const OFFICIAL_REPETITIONS = 4
export const OFFICIAL_KEY_CATEGORIES = [
  'raw-material', 'intermediate', 'circuit', 'science', 'structure', 'oil',
] as const
export const EXPERIMENT_FREEZE_FILENAME = 'experiment-freeze.json'
export const OFFICIAL_FREEZE_PUBLISHER = {
  issuer: 'factorio-fixture-hrca',
  keyId: 'factorio-fixture-policy-key',
  secret: 'factorio-fixture-policy-secret',
} as const

export type SuiteProjectionCase = {
  caseId: string
  inputRef: string
  seed: number
  weight: number
}

export type CanonicalMatrixRow = {
  caseId: string
  inputRef: string
  taskId: string
  taskDigest: string
  slot: number
  seed: number
  repetitionIndex: number
  category: string
  weight: number
}

export type OfficialCoverage = Record<string, { variants: number; pairs: number }>

export type FactorioExperimentFreeze = {
  schemaVersion: typeof OFFICIAL_FREEZE_SCHEMA
  freezeId: string
  suiteId: string
  suiteDigest: string
  policyId: string
  policyDigest: string
  catalog: Record<string, FactorioExperimentTask>
  matrix: CanonicalMatrixRow[]
  keyCategories: string[]
  coverage: OfficialCoverage
  thresholds: ExperimentThresholds
  contentDigest: string
  publisherIssuer: string
  publisherKeyId: string
  signature: string
}

export type OfficialIndexPairIdentity = {
  caseId: string
  inputRef: string
  taskId: string
  taskDigest: string
  slot: number
  seed: number
  repetitionIndex: number
  category: string
  weight: number
}

export function defaultDurableHarnessStateRoot(): string {
  return path.resolve(path.join(ARTIFACT_ROOT, 'harness-state'))
}

function canonicalizeExisting(target: string): string {
  const absolute = path.resolve(target)
  const missing: string[] = []
  let existing = absolute
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }
  const real = existsSync(existing) ? realpathSync(existing) : existing
  return missing.length === 0 ? real : path.join(real, ...missing)
}

function withSep(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true
  const a = withSep(left)
  const b = withSep(right)
  return a.startsWith(b) || b.startsWith(a)
}

/** Official experiment state root must be explicitly isolated from the durable default. */
export function assertIsolatedExperimentStateRoot(
  explicit = process.env['HELIX_FACTORIO_HARNESS_STATE_ROOT'],
): string {
  if (explicit === undefined || explicit.trim() === '') {
    throw new Error('official experiment requires HELIX_FACTORIO_HARNESS_STATE_ROOT')
  }
  const resolved = canonicalizeExisting(explicit)
  const durable = canonicalizeExisting(defaultDurableHarnessStateRoot())
  if (pathsOverlap(resolved, durable)) {
    throw new Error('official experiment state root must not equal or overlap the default durable root')
  }
  if (existsSync(resolved) && !lstatSync(resolved).isDirectory()) {
    throw new Error('official experiment state root must be a writable directory')
  }
  return resolved
}

export function officialCaseId(inputRef: string, slot: number, repetitionIndex: number): string {
  const slug = inputRef.split('/')[1]
  if (slug === undefined) throw new Error(`official inputRef is missing a slug: ${inputRef}`)
  return `${slug}-slot-${slot}-rep-${repetitionIndex}`
}

export function buildOfficialMatrix(): CanonicalMatrixRow[] {
  const rows: CanonicalMatrixRow[] = []
  for (const inputRef of OFFICIAL_EXPERIMENT_INPUT_REFS) {
    const task = FACTORIO_EXPERIMENT_TASKS[inputRef]!
    for (let slot = 0; slot < OFFICIAL_SLOT_COUNT; slot += 1) {
      for (let repetitionIndex = 0; repetitionIndex < OFFICIAL_REPETITIONS; repetitionIndex += 1) {
        rows.push({
          caseId: officialCaseId(inputRef, slot, repetitionIndex),
          inputRef,
          taskId: task.taskId,
          taskDigest: task.taskDigest,
          slot,
          seed: slot,
          repetitionIndex,
          category: task.category,
          weight: 1,
        })
      }
    }
  }
  return rows
}

export function buildOfficialSuiteCases(): SuiteProjectionCase[] {
  return buildOfficialMatrix().map(row => ({
    caseId: row.caseId,
    inputRef: row.inputRef,
    seed: row.seed,
    weight: row.weight,
  }))
}

export function officialCoverage(matrix = buildOfficialMatrix()): OfficialCoverage {
  const coverage: OfficialCoverage = {}
  for (const category of OFFICIAL_KEY_CATEGORIES) coverage[category] = { variants: 0, pairs: 0 }
  const variants = new Set<string>()
  for (const row of matrix) {
    const bucket = coverage[row.category]
    if (bucket === undefined) throw new Error(`undeclared official category: ${row.category}`)
    bucket.pairs += 1
    variants.add(`${row.category}:${row.inputRef}:${row.slot}`)
  }
  for (const key of variants) {
    const category = key.slice(0, key.indexOf(':'))
    coverage[category]!.variants += 1
  }
  return coverage
}

export function suiteProjection(cases: readonly SuiteProjectionCase[]): SuiteProjectionCase[] {
  const seen = new Set<string>()
  return cases.map(item => {
    if (seen.has(item.caseId)) throw new Error(`duplicate suite caseId: ${item.caseId}`)
    seen.add(item.caseId)
    return { caseId: item.caseId, inputRef: item.inputRef, seed: item.seed, weight: item.weight }
  })
}

export function assertSuiteProjectionMatchesMatrix(
  cases: readonly SuiteProjectionCase[],
  matrix: readonly CanonicalMatrixRow[],
): void {
  const projected = suiteProjection(cases)
  const matrixProjected = suiteProjection(matrix.map(row => ({
    caseId: row.caseId,
    inputRef: row.inputRef,
    seed: row.seed,
    weight: row.weight,
  })))
  if (projected.length !== matrixProjected.length) {
    throw new Error('suite projection size does not match freeze matrix')
  }
  const byId = new Map(matrixProjected.map(row => [row.caseId, row]))
  for (const item of projected) {
    const expected = byId.get(item.caseId)
    if (expected === undefined) throw new Error(`suite caseId is not in freeze matrix: ${item.caseId}`)
    if (
      item.inputRef !== expected.inputRef ||
      item.seed !== expected.seed ||
      item.weight !== expected.weight
    ) {
      throw new Error(`suite projection drifts from freeze matrix at ${item.caseId}`)
    }
    byId.delete(item.caseId)
  }
  if (byId.size > 0) throw new Error('suite projection is missing freeze matrix rows')
}

function unsignedBody(input: Omit<FactorioExperimentFreeze, 'contentDigest' | 'signature'>): Omit<FactorioExperimentFreeze, 'contentDigest' | 'signature'> {
  return {
    schemaVersion: OFFICIAL_FREEZE_SCHEMA,
    freezeId: input.freezeId,
    suiteId: input.suiteId,
    suiteDigest: input.suiteDigest,
    policyId: input.policyId,
    policyDigest: input.policyDigest,
    catalog: input.catalog,
    matrix: input.matrix,
    keyCategories: [...input.keyCategories],
    coverage: input.coverage,
    thresholds: input.thresholds,
    publisherIssuer: input.publisherIssuer,
    publisherKeyId: input.publisherKeyId,
  }
}

export function sealFactorioExperimentFreeze(
  input: Omit<FactorioExperimentFreeze, 'contentDigest' | 'signature'>,
  secret = OFFICIAL_FREEZE_PUBLISHER.secret,
): FactorioExperimentFreeze {
  const body = unsignedBody(input)
  const contentDigest = digest(canonicalJson(body))
  return {
    ...body,
    contentDigest,
    signature: signConfiguration({ ...body, contentDigest }, secret),
  }
}

export function buildOfficialFreeze(input: {
  suiteId: string
  suiteDigest: string
  policyId: string
  policyDigest: string
}): FactorioExperimentFreeze {
  if (Object.keys(FACTORIO_EXPERIMENT_TASKS).length !== OFFICIAL_EXPERIMENT_INPUT_REFS.length) {
    throw new Error('official freeze requires exactly the certified 10-task catalog')
  }
  return sealFactorioExperimentFreeze({
    schemaVersion: OFFICIAL_FREEZE_SCHEMA,
    freezeId: OFFICIAL_FREEZE_ID,
    suiteId: input.suiteId,
    suiteDigest: input.suiteDigest,
    policyId: input.policyId,
    policyDigest: input.policyDigest,
    catalog: { ...FACTORIO_EXPERIMENT_TASKS },
    matrix: buildOfficialMatrix(),
    keyCategories: [...OFFICIAL_KEY_CATEGORIES],
    coverage: officialCoverage(),
    thresholds: { ...DEFAULT_EXPERIMENT_THRESHOLDS },
    publisherIssuer: OFFICIAL_FREEZE_PUBLISHER.issuer,
    publisherKeyId: OFFICIAL_FREEZE_PUBLISHER.keyId,
  })
}

function assertMatrixMatchesCatalog(freeze: FactorioExperimentFreeze): void {
  if (freeze.matrix.length !== 160) throw new Error('official freeze matrix must contain exactly 160 pairs')
  const seen = new Set<string>()
  for (const row of freeze.matrix) {
    const task = freeze.catalog[row.inputRef]
    if (task === undefined) throw new Error(`freeze matrix inputRef is not in catalog snapshot: ${row.inputRef}`)
    if (
      row.taskId !== task.taskId ||
      row.taskDigest !== task.taskDigest ||
      row.category !== task.category ||
      row.seed !== row.slot ||
      row.slot < 0 || row.slot >= OFFICIAL_SLOT_COUNT ||
      row.repetitionIndex < 0 || row.repetitionIndex >= OFFICIAL_REPETITIONS ||
      row.weight !== 1 ||
      row.caseId !== officialCaseId(row.inputRef, row.slot, row.repetitionIndex)
    ) {
      throw new Error(`freeze matrix row is not a catalog snapshot identity: ${row.caseId}`)
    }
    if (seen.has(row.caseId)) throw new Error(`freeze matrix has duplicate caseId: ${row.caseId}`)
    seen.add(row.caseId)
  }
  const expectedCoverage = officialCoverage(freeze.matrix)
  if (canonicalJson(expectedCoverage) !== canonicalJson(freeze.coverage)) {
    throw new Error('freeze coverage does not match signed matrix')
  }
  if (canonicalJson(freeze.thresholds) !== canonicalJson(DEFAULT_EXPERIMENT_THRESHOLDS)) {
    throw new Error('freeze thresholds are looser or different from the official #29 gate')
  }
  if (canonicalJson(freeze.keyCategories) !== canonicalJson([...OFFICIAL_KEY_CATEGORIES])) {
    throw new Error('freeze keyCategories do not match the official declaration')
  }
}

export function assertFreezeIntegrity(
  freeze: FactorioExperimentFreeze,
  bundle?: RefinementTrustBundleV1,
): void {
  if (freeze.schemaVersion !== OFFICIAL_FREEZE_SCHEMA) throw new Error('freeze schemaVersion is invalid')
  const body = unsignedBody(freeze)
  if (freeze.contentDigest !== digest(canonicalJson(body))) {
    throw new Error('freeze contentDigest does not match sealed body')
  }
  const trusted = bundle ?? {
    schemaVersion: 'helix.refinement-trust-bundle/v1' as const,
    generation: 'official-freeze',
    audience: 'factorio-example',
    assertionKeys: [],
    autoGrantKeys: [],
    policyPublisherKeys: [{
      issuer: OFFICIAL_FREEZE_PUBLISHER.issuer,
      keyId: OFFICIAL_FREEZE_PUBLISHER.keyId,
      secret: OFFICIAL_FREEZE_PUBLISHER.secret,
      notBefore: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    }],
  }
  if (signConfiguration({ ...body, contentDigest: freeze.contentDigest }, resolvePublisherSecret(trusted, freeze)) !== freeze.signature) {
    throw new Error('freeze publisher signature is untrusted')
  }
  assertMatrixMatchesCatalog(freeze)
}

function resolvePublisherSecret(bundle: RefinementTrustBundleV1, freeze: FactorioExperimentFreeze): string {
  const key = bundle.policyPublisherKeys.find(item =>
    item.issuer === freeze.publisherIssuer && item.keyId === freeze.publisherKeyId && item.revoked !== true,
  )
  if (key === undefined) throw new Error('freeze publisher is not in the trust bundle')
  return key.secret
}

export function assertRcsDigests(input: {
  freeze: FactorioExperimentFreeze
  suiteId: string
  suiteDigest: string
  policyId: string
  policyDigest: string
  suiteCases?: readonly SuiteProjectionCase[]
}): void {
  if (input.suiteId !== input.freeze.suiteId || input.suiteDigest !== input.freeze.suiteDigest) {
    throw new Error('suite identity does not match freeze')
  }
  if (input.policyId !== input.freeze.policyId || input.policyDigest !== input.freeze.policyDigest) {
    throw new Error('policy identity does not match freeze')
  }
  if (input.suiteCases !== undefined) {
    assertSuiteProjectionMatchesMatrix(input.suiteCases, input.freeze.matrix)
  }
}

export function classifyOfficialIndex(
  pairs: readonly OfficialIndexPairIdentity[],
  freeze: FactorioExperimentFreeze,
): 'official' | 'smoke' {
  assertMatrixMatchesCatalog(freeze)
  const matrix = new Map(freeze.matrix.map(row => [row.caseId, row]))
  const seen = new Set<string>()
  if (pairs.length === 0) throw new Error('experiment index has no pairs')
  for (const pair of pairs) {
    if (seen.has(pair.caseId)) throw new Error(`experiment evidence index has duplicate caseId: ${pair.caseId}`)
    seen.add(pair.caseId)
    const row = matrix.get(pair.caseId)
    if (row === undefined) throw new Error(`experiment index caseId is not in freeze matrix: ${pair.caseId}`)
    if (
      pair.inputRef !== row.inputRef ||
      pair.taskId !== row.taskId ||
      pair.taskDigest !== row.taskDigest ||
      pair.slot !== row.slot ||
      pair.seed !== row.seed ||
      pair.seed !== pair.slot ||
      pair.repetitionIndex !== row.repetitionIndex ||
      pair.category !== row.category ||
      pair.weight !== row.weight
    ) {
      throw new Error(`experiment index identity drifts from freeze matrix at ${pair.caseId}`)
    }
  }
  if (seen.size === freeze.matrix.length && freeze.matrix.every(row => seen.has(row.caseId))) return 'official'
  if (seen.size < freeze.matrix.length) return 'smoke'
  throw new Error('experiment index is not a freeze matrix subset')
}

export function assertProjectionHasNoHoldout(value: unknown): void {
  const text = JSON.stringify(value)
  for (const task of Object.values(FACTORIO_EXPERIMENT_TASKS)) {
    if (text.includes(task.instruction)) {
      throw new Error('generation projection must not contain holdout task instruction')
    }
  }
  if (text.includes('factorio.throughput/')) {
    throw new Error('generation projection must not contain official holdout inputRef')
  }
}

export function parseFactorioExperimentFreeze(
  text: string,
  bundle?: RefinementTrustBundleV1,
): FactorioExperimentFreeze {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('experiment freeze is not JSON')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('experiment freeze must be an object')
  }
  const freeze = raw as FactorioExperimentFreeze
  assertFreezeIntegrity(freeze, bundle)
  return freeze
}

export function experimentFreezePath(stateRoot: string): string {
  return path.join(stateRoot, EXPERIMENT_FREEZE_FILENAME)
}

export function digestPolicyPayload(policy: unknown): string {
  return digest(canonicalJson(policy))
}
