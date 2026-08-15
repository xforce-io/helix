/**
 * Factorio example Host composition for refinement CLI (#18/#17/#16).
 * Scenario-only: projection and FLE outcome extraction stay out of src/refinement.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { AnthropicAdapter } from 'milkie'
import { DefaultIOPort, type IIOPort } from 'milkie/dist/runtime/IOPort.js'
import type { HarnessPinsV1 } from '../../../src/harness/index.js'
import type { RefinementControlStore } from '../../../src/refinement/control-store.js'
import type { RefinementCommandHost } from '../../../src/refinement/commands.js'
import {
  createMilkieRefinementAdapter,
  type EvaluationArmResult,
} from '../../../src/refinement/milkie-adapter.js'
import { signActorAssertion, type ActorAssertionV1, type RefinementTrustBundleV1 } from '../../../src/refinement/trust.js'
import {
  ARTIFACT_ROOT,
  HARNESS_STATE_ROOT,
  LIVE_WALL_TIMEOUT_MS,
  pins,
  preflightLive,
} from './cli-common.js'
import {
  assembleFactorioRunFromFrozenPins,
  createFactorioHostBundle,
  formFactorioAvailableCatalogRefs,
  parseHarnessStateRef as parseFactorioHarnessStateRef,
  type FactorioHostBundle,
} from './harness-host.js'
import { runAssembledFactorioLive } from './live.js'
import type { LiveEvidence } from './types.js'

export const FACTORIO_EXTRACTOR_DIGEST = createHash('sha256')
  .update('helix.factorio.extractor/v1')
  .digest('hex')

export const FACTORIO_REFINEMENT_FIXTURE = {
  assertionIssuer: 'factorio-fixture-idp',
  assertionKeyId: 'factorio-fixture-assertion-key',
  assertionSecret: 'factorio-fixture-assertion-secret',
  publisherIssuer: 'factorio-fixture-hrca',
  publisherKeyId: 'factorio-fixture-policy-key',
  publisherSecret: 'factorio-fixture-policy-secret',
  audience: 'factorio-example',
} as const

export const EXAMPLE_BUNDLE: RefinementTrustBundleV1 = {
  schemaVersion: 'helix.refinement-trust-bundle/v1',
  generation: 'fixture-generation',
  audience: FACTORIO_REFINEMENT_FIXTURE.audience,
  assertionKeys: [{
    issuer: FACTORIO_REFINEMENT_FIXTURE.assertionIssuer,
    keyId: FACTORIO_REFINEMENT_FIXTURE.assertionKeyId,
    secret: FACTORIO_REFINEMENT_FIXTURE.assertionSecret,
    notBefore: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
  }],
  autoGrantKeys: [],
  policyPublisherKeys: [{
    issuer: FACTORIO_REFINEMENT_FIXTURE.publisherIssuer,
    keyId: FACTORIO_REFINEMENT_FIXTURE.publisherKeyId,
    secret: FACTORIO_REFINEMENT_FIXTURE.publisherSecret,
    notBefore: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
  }],
}

export type FactorioGenerationProjection = {
  /** Fixed Host instruction; candidate content remains entirely model-authored. */
  generationInstruction: string
  sourceRunRefs: string[]
  outcomes: Array<{
    runId: string
    verificationSuccess: boolean
    termination: LiveEvidence['termination']
    modelCallCount: number
    harnessContentHash?: string
  }>
}

export const parseHarnessStateRef = parseFactorioHarnessStateRef

export function projectFactorioGenerationInput(
  sourceRunRefs: string[],
  options: { readLive?: (runId: string) => LiveEvidence | undefined } = {},
): FactorioGenerationProjection {
  if (sourceRunRefs.length === 0) {
    throw new Error('projectFactorioGenerationInput requires recorded Factorio run refs')
  }
  const readLive = options.readLive ?? readRecordedLiveEvidence
  const outcomes: FactorioGenerationProjection['outcomes'] = []
  for (const runId of sourceRunRefs) {
    const live = readLive(runId)
    if (live === undefined) {
      throw new Error(`recorded Factorio run is missing: ${runId}`)
    }
    if (!live.finalProjection.terminated) {
      throw new Error(`recorded Factorio run is not terminal: ${runId}`)
    }
    outcomes.push({
      runId,
      verificationSuccess: live.finalProjection.verification.success,
      termination: live.termination,
      modelCallCount: live.finalProjection.modelCallCount,
      ...(live.pins.harnessState === undefined
        ? {}
        : { harnessContentHash: live.pins.harnessState.harnessContentHash }),
    })
  }
  return {
    generationInstruction: [
      'Return exactly one JSON object and no Markdown, prose, code fence, or import.',
      'The object must be a helix.harness-overlay/v1 HarnessOverlay whose baseBaselineRef exactly equals the proposal baselineRef.',
      'Its changes must be non-empty and limited to systemInstructionTemplate, taskNarrativeTemplate, protocolRules, stopConditions, or catalogCards.',
      'Do not include policy, suite, source evidence, credentials, aliases, promotion requests, or a second overlay.',
    ].join(' '),
    sourceRunRefs: [...sourceRunRefs],
    outcomes,
  }
}

export function extractFactorioEvaluationMetrics(live: LiveEvidence): {
  quality: number
  cost: number
  latencyMs: number
  failed: boolean
} {
  const success = live.finalProjection.verification.success
  return {
    quality: success ? 1 : 0,
    cost: live.finalProjection.modelCallCount,
    latencyMs: Math.max(0, LIVE_WALL_TIMEOUT_MS - live.budget.remainingWallMsAtEnd),
    failed: !success,
  }
}

/** CLI entry: `createRefinementCommandHost` is the name helix refine --host-module loads. */
export function createRefinementCommandHost(): RefinementCommandHost {
  return createFactorioRefinementCommandHost({ rootDir: HARNESS_STATE_ROOT })
}

export type FactorioRunArm = (input: {
  arm: 'baseline' | 'candidate'
  case: { caseId: string; inputRef: string; seed: number; weight: number }
  reservedRunRef: string
  pins: HarnessPinsV1
  replayPassed: boolean
}) => EvaluationArmResult | Promise<EvaluationArmResult>

export function createFactorioRefinementCommandHost(options: {
  rcs?: RefinementControlStore
  rootDir?: string
  /** Unit tests inject a recorded IOPort; CLI always uses the live Anthropic port. */
  innerPort?: IIOPort
  generationModel?: string
  runArm?: FactorioRunArm
  readLive?: (runId: string) => LiveEvidence | undefined
} = {}): RefinementCommandHost {
  const bundle = options.rcs === undefined
    ? createFactorioHostBundle(options.rootDir === undefined ? {} : { rootDir: options.rootDir })
    : undefined
  const rcs = options.rcs ?? bundle!.rcs
  const baselines = rcs.exportSnapshot().baselines
  const defaultPublished = baselines.find(entry => entry.ref.id === 'factorio.default-p1') ?? baselines[0]
  if (defaultPublished === undefined) {
    throw new Error('Factorio refinement Host requires a published baseline')
  }
  const generationModel = options.generationModel ?? process.env['ANTHROPIC_MODEL']
  if (generationModel === undefined || generationModel.length === 0) {
    throw new Error('Factorio refinement Host requires ANTHROPIC_MODEL')
  }
  const innerPort = options.innerPort ?? createFactorioGenerationPort()
  const runArm = options.runArm ?? createLiveFactorioRunArm(bundle, generationModel)
  const adapter = createMilkieRefinementAdapter({
    rcs,
    availableCatalogRefs: formFactorioAvailableCatalogRefs('factorio-rlm/v4'),
    codeProtocolPin: 'factorio-rlm/v4',
    innerPort,
    generationRunRef: 'factorio-refinement-generation',
    generationModel,
    // Do not catch projection errors: an unreadable or non-terminal P1 run
    // must prevent the IOPort call rather than generate from empty evidence.
    projectGenerationInput: (sourceRunRefs) => projectFactorioGenerationInput(
      sourceRunRefs,
      options.readLive === undefined ? {} : { readLive: options.readLive },
    ),
    extractorDigest: FACTORIO_EXTRACTOR_DIGEST,
    sharedPins: { runner: 'factorio', model: generationModel },
    runArm,
  })
  return {
    rcs,
    adapter,
    trustBundle: EXAMPLE_BUNDLE,
  }
}

/** HMAC fixture only: lets tests exercise the same human assertion boundary. */
export function createFactorioFixtureAssertion(input: {
  operation: ActorAssertionV1['operation']
  nonce: string
  subject?: string
}): ActorAssertionV1 {
  return signActorAssertion({
    schemaVersion: 'helix.refinement-actor-assertion/v1',
    subject: input.subject ?? 'factorio-fixture-researcher',
    issuer: FACTORIO_REFINEMENT_FIXTURE.assertionIssuer,
    keyId: FACTORIO_REFINEMENT_FIXTURE.assertionKeyId,
    audience: FACTORIO_REFINEMENT_FIXTURE.audience,
    operation: input.operation,
    issuedAt: '2026-08-14T00:00:00Z',
    expiresAt: '2026-08-15T00:00:00Z',
    nonce: input.nonce,
  }, FACTORIO_REFINEMENT_FIXTURE.assertionSecret)
}

function createFactorioGenerationPort(): IIOPort {
  const apiKey = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY']
  const baseUrl = process.env['ANTHROPIC_BASE_URL']
  return new DefaultIOPort(new AnthropicAdapter({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  }))
}

function createLiveFactorioRunArm(
  bundle: FactorioHostBundle | undefined,
  model: string,
): FactorioRunArm {
  return async ({ reservedRunRef, pins: harnessPins }) => {
    if (bundle === undefined) {
      throw new Error('live Factorio evaluation requires a Host-created RCS bundle')
    }
    // The evaluator route has already admitted the candidate pins. The actual
    // FLE execution replays exactly those frozen pins and never invokes the
    // ordinary external `live --overlay` route.
    preflightLive()
    const assembled = assembleFactorioRunFromFrozenPins({
      bundle,
      basePins: pins(model),
      harnessPins,
    })
    const result = await runAssembledFactorioLive({
      assembled,
      model,
      runId: reservedRunRef,
      evidencePath: path.join(ARTIFACT_ROOT, 'evals', reservedRunRef, 'live.json'),
    })
    return {
      runRef: reservedRunRef,
      ...extractFactorioEvaluationMetrics(result.evidence),
    }
  }
}

function readRecordedLiveEvidence(runId: string): LiveEvidence | undefined {
  const file = path.join(ARTIFACT_ROOT, 'runs', runId, 'live.json')
  try {
    return parseRecordedFactorioLiveEvidence(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Recorded live evidence is not a HarnessOverlay: FLE observations legitimately
 * contain negative coordinates and fractional metrics. Validate only the
 * projection contract consumed by generation, while malformed evidence remains
 * unreadable and therefore fail-closed.
 */
export function parseRecordedFactorioLiveEvidence(text: string): LiveEvidence {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('recorded Factorio live evidence is not JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recorded Factorio live evidence must be an object')
  }
  const evidence = value as Partial<LiveEvidence>
  const projection = evidence.finalProjection
  if (
    typeof evidence.runId !== 'string' || evidence.runId.length === 0 ||
    projection === undefined || typeof projection !== 'object' ||
    typeof projection.terminated !== 'boolean' ||
    projection.verification === undefined ||
    typeof projection.verification.success !== 'boolean' ||
    !Number.isSafeInteger(projection.modelCallCount) || projection.modelCallCount < 0
  ) {
    throw new Error('recorded Factorio live evidence projection is invalid')
  }
  return evidence as LiveEvidence
}
