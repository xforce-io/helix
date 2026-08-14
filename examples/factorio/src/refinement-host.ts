/**
 * Factorio example Host composition for refinement CLI (#18/#17/#16).
 * Scenario-only: projection and FLE outcome extraction stay out of src/refinement.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { IIOPort } from 'milkie'
import type { HarnessStateRef } from '../../../src/harness/index.js'
import type { RefinementControlStore } from '../../../src/refinement/control-store.js'
import type { RefinementCommandHost } from '../../../src/refinement/commands.js'
import { createMilkieRefinementAdapter } from '../../../src/refinement/milkie-adapter.js'
import type { RefinementTrustBundleV1 } from '../../../src/refinement/trust.js'
import { ARTIFACT_ROOT, LIVE_WALL_TIMEOUT_MS, parseLiveEvidenceText } from './cli-common.js'
import {
  createFactorioHostBundle,
  formFactorioAvailableCatalogRefs,
} from './harness-host.js'
import type { LiveEvidence } from './types.js'

export const FACTORIO_EXTRACTOR_DIGEST = createHash('sha256')
  .update('helix.factorio.extractor/v1')
  .digest('hex')

const EXAMPLE_BUNDLE: RefinementTrustBundleV1 = {
  schemaVersion: 'helix.refinement-trust-bundle/v1',
  generation: 'fixture-generation',
  audience: 'fixture-deployment',
  assertionKeys: [],
  autoGrantKeys: [],
  policyPublisherKeys: [{
    issuer: 'fixture-hrca',
    keyId: 'fixture-key',
    secret: 'fixture-hrca-secret',
    notBefore: '2026-01-01T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
  }],
}

export type FactorioGenerationProjection = {
  sourceRunRefs: string[]
  outcomes: Array<{
    runId: string
    verificationSuccess: boolean
    termination: LiveEvidence['termination']
    modelCallCount: number
    harnessContentHash?: string
  }>
}

export function parseHarnessStateRef(value: string): HarnessStateRef {
  const match = /^(baseline|overlay):(.+)@(\d+)#([0-9a-f]{64})$/.exec(value)
  if (match === null) {
    throw new Error('overlay/baseline ref must be kind:id@revision#64-lowercase-hex-hash')
  }
  return {
    kind: match[1] as 'baseline' | 'overlay',
    id: match[2]!,
    revision: Number(match[3]),
    contentHash: match[4]!,
  }
}

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
  return { sourceRunRefs: [...sourceRunRefs], outcomes }
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
  return createFactorioRefinementCommandHost()
}

export function createFactorioRefinementCommandHost(options: {
  rcs?: RefinementControlStore
  rootDir?: string
} = {}): RefinementCommandHost {
  const created = options.rcs === undefined
    ? createFactorioHostBundle(options.rootDir === undefined ? {} : { rootDir: options.rootDir })
    : undefined
  const rcs = options.rcs ?? created!.rcs
  const baselines = rcs.exportSnapshot().baselines
  const defaultPublished = baselines.find(entry => entry.ref.id === 'factorio.default-p1') ?? baselines[0]
  if (defaultPublished === undefined) {
    throw new Error('Factorio refinement Host requires a published baseline')
  }
  const baselineRef = defaultPublished.ref
  const overlayText = JSON.stringify({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: baselineRef,
    changes: { systemInstructionTemplate: 'refined factorio control' },
  })
  const innerPort: IIOPort = {
    async invokeLLM() {
      return {
        content: [{ type: 'text', text: overlayText }],
        toolCalls: [],
        usage: { inputTokens: 8, outputTokens: 8 },
      }
    },
    async invokeTool(_name, _input, execute) {
      return execute(new AbortController().signal)
    },
    now: () => Date.now(),
    uuid: () => 'factorio-refinement',
  }
  const adapter = createMilkieRefinementAdapter({
    rcs,
    availableCatalogRefs: formFactorioAvailableCatalogRefs('factorio-rlm/v4'),
    codeProtocolPin: 'factorio-rlm/v4',
    innerPort,
    generationRunRef: 'factorio-refinement-generation',
    generationModel: 'fixture-recorded-model',
    projectGenerationInput: (sourceRunRefs) => {
      try {
        return projectFactorioGenerationInput(sourceRunRefs)
      } catch {
        return { sourceRunRefs, outcomes: [] }
      }
    },
    extractorDigest: FACTORIO_EXTRACTOR_DIGEST,
    sharedPins: { runner: 'factorio', model: 'fixture-recorded-model' },
    runArm: ({ arm, reservedRunRef }) => {
      const recorded = readRecordedEvalEvidence(reservedRunRef)
      if (recorded !== undefined) {
        return { runRef: reservedRunRef, ...extractFactorioEvaluationMetrics(recorded) }
      }
      return {
        runRef: reservedRunRef,
        quality: arm === 'candidate' ? 1 : 0.5,
        cost: 10,
        latencyMs: 10,
        failed: false,
      }
    },
  })
  return {
    rcs,
    adapter,
    trustBundle: EXAMPLE_BUNDLE,
  }
}

function readRecordedLiveEvidence(runId: string): LiveEvidence | undefined {
  const file = path.join(ARTIFACT_ROOT, 'runs', runId, 'live.json')
  try {
    return parseLiveEvidenceText(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function readRecordedEvalEvidence(runRef: string): LiveEvidence | undefined {
  const file = path.join(ARTIFACT_ROOT, 'evals', runRef, 'live.json')
  try {
    return parseLiveEvidenceText(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
