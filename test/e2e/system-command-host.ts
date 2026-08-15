/**
 * System-level RefinementCommandHost that exercises catalog + harness + refinement.
 * Unlike test/refinement/command-host.ts (minimal fixture), this one loads production
 * catalog cards and uses real selectValidateResolveFreeze + replayFromRecordedPins paths.
 *
 * P1 fixes:
 * - Uses createMilkieRefinementAdapter with real innerPort (fixture IIOPort)
 * - Generation goes through milkie RecordingIOPort / createIOPortGenerationAdapter
 * - runArm executes fixture harness with buildScenarioPayload, verifier-derived metrics
 * - Persists per-arm run evidence to artifacts/system-e2e/<runId>/
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IIOPort } from 'milkie'

import {
  createFixtureScenarioAdapter,
  type HarnessDocument,
  HarnessStateStore,
  type HarnessPinsV1,
  selectValidateResolveFreeze,
  replayFromRecordedPins,
  type CatalogCardRef,
  renderSystemInstruction,
} from '../../src/harness/index.js'
import { listProductionCards, resolveCapabilitySet, resolveCardRefs } from '../../src/catalog/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import type { RefinementCommandHost } from '../../src/refinement/commands.js'
import {
  createMilkieRefinementAdapter,
  type EvaluationArmResult,
} from '../../src/refinement/milkie-adapter.js'
import type { EvaluationSuiteV1 } from '../../src/refinement/workflow.js'
import { signActorAssertion, type ActorAssertionV1, type RefinementTrustBundleV1 } from '../../src/refinement/trust.js'
import { HRCA_BUNDLE } from '../refinement/fixtures.js'

export const SYSTEM_EXTRACTOR_DIGEST = 'e'.repeat(64)

// System e2e trust bundle and assertion secret
const SYSTEM_BUNDLE: RefinementTrustBundleV1 = {
  ...HRCA_BUNDLE,
  audience: 'system-e2e',
  assertionKeys: [
    {
      issuer: 'system-idp',
      keyId: 'system-key',
      secret: 'system-assertion-secret',
      notBefore: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    },
  ],
}

/**
 * Create a baseline document that references production catalog cards.
 */
function createSystemBaselineDocument(): HarnessDocument {
  // Use helix.runtime.core/v1 to exercise production catalog resolution
  const capabilitySet = 'helix.runtime.core/v1'
  const cardRefs = resolveCapabilitySet(capabilitySet)

  return {
    schemaVersion: 'helix.harness/v1',
    control: {
      systemInstructionTemplate: 'system baseline instruction',
      taskNarrativeTemplate: 'system task narrative',
      protocolRules: ['system-protocol'],
      termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
    },
    catalogCards: cardRefs,
    compatibility: { codeProtocolPins: ['system-fixture/v1'] },
  }
}

/**
 * Fixture scenario adapter with verifier that derives metrics from overlay changes.
 */
function createSystemScenarioAdapter(options: {
  baselineSystemInstruction: string
  taskNarrative: string
  codeProtocolPin: string
}) {
  const base = createFixtureScenarioAdapter({
    scenarioId: 'system.e2e.scenario',
    taskNarrative: options.taskNarrative,
    environmentNarrative: 'System e2e environment narrative',
  })

  return {
    ...base,
    verify: (output: { systemInstruction: string }): { success: boolean; quality: number } => {
      // Verifier: candidate succeeds if overlay changed system instruction
      const changed = output.systemInstruction !== options.baselineSystemInstruction
      return {
        success: true,
        quality: changed ? 0.85 : 0.7, // Candidate scores higher if overlay took effect
      }
    },
  }
}

/**
 * Create system assertion (fixture HMAC).
 */
export function createSystemFixtureAssertion(input: {
  operation: ActorAssertionV1['operation']
  nonce: string
  subject?: string
  now?: Date
}): ActorAssertionV1 {
  const now = input.now ?? new Date('2026-08-15T00:00:00Z')
  const issuedAt = new Date(now.getTime() - 1_000)
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000)
  return signActorAssertion(
    {
      schemaVersion: 'helix.refinement-actor-assertion/v1',
      subject: input.subject ?? 'system-researcher',
      issuer: 'system-idp',
      keyId: 'system-key',
      audience: 'system-e2e',
      operation: input.operation,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce: input.nonce,
    },
    'system-assertion-secret'
  )
}

/**
 * System-level command host that exercises the full stack:
 * - Production catalog cards loaded via listProductionCards / resolveCapabilitySet
 * - createMilkieRefinementAdapter with fixture IOPort
 * - selectValidateResolveFreeze for live path
 * - replayFromRecordedPins for replay path
 * - Fixture scenario adapter with verifier-derived metrics
 * - Per-arm run evidence persisted to artifacts/
 */
export function createSystemCommandHost(options: {
  rootDir?: string
  artifactsDir: string
  runId: string
}): RefinementCommandHost {
  // Verify production catalog is loaded
  const productionCards = listProductionCards()
  if (productionCards.length === 0) {
    throw new Error('System e2e requires production catalog cards to be loaded')
  }

  const rcs = new RefinementControlStore({ rootDir: options.rootDir })
  const document = createSystemBaselineDocument()

  // Try to find existing baseline first, publish only if not found
  const expectedBaselineId = 'system-baseline'
  const snapshot = rcs.exportSnapshot()
  let base = snapshot.baselines.find(b => b.ref.id === expectedBaselineId)?.ref
  if (!base) {
    base = rcs.publishBaseline(document, { id: expectedBaselineId, revision: 0 })
  }

  // Form availableCatalogRefs from production catalog
  const availableCatalogRefs: CatalogCardRef[] = resolveCardRefs(
    resolveCapabilitySet('helix.runtime.core/v1')
  ).map(resolved => ({ id: resolved.ref.id, version: resolved.ref.version }))

  const codeProtocolPin = 'system-fixture/v1'

  // Fixture IOPort that generates valid overlay
  const innerPort: IIOPort = {
    async invokeLLM() {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              schemaVersion: 'helix.harness-overlay/v1',
              baseBaselineRef: base,
              changes: { systemInstructionTemplate: 'system candidate instruction from IOPort' },
            }),
          },
        ],
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 100 },
      }
    },
    async invokeTool(_name, _input, execute) {
      return execute(new AbortController().signal)
    },
    now: () => Date.now(),
    uuid: () => 'system-fixture-uuid',
  }

  const adapter = createMilkieRefinementAdapter({
    rcs,
    availableCatalogRefs,
    codeProtocolPin,
    innerPort,
    generationRunRef: `${options.runId}:generation`,
    generationModel: 'system-fixture-model',
    projectGenerationInput: (sourceRunRefs: string[]) => ({
      sources: sourceRunRefs,
      baseline: base,
    }),
    extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
    sharedPins: { runner: 'system-fixture' },
    runArm: async (input: {
      arm: 'baseline' | 'candidate'
      case: EvaluationSuiteV1['cases'][number]
      reservedRunRef: string
      pins: HarnessPinsV1
      replayPassed: boolean
    }): Promise<EvaluationArmResult> => {
      // Hydrate store from RCS snapshot
      const armSnapshot = rcs.exportSnapshot()
      const store = new HarnessStateStore()
      for (const entry of armSnapshot.baselines) {
        store.publishBaseline(entry.document, { id: entry.ref.id, revision: entry.ref.revision })
      }
      for (const entry of armSnapshot.overlays) {
        store.publishOverlay(entry.overlay, { id: entry.ref.id, revision: entry.ref.revision })
      }

      // Freeze and verify replay
      const freeze = selectValidateResolveFreeze({
        store,
        availableCatalogRefs,
        codeProtocolPin,
        selection: {
          baselineRef: input.pins.baselineRef,
          ...(input.pins.overlayRef !== undefined ? { overlayRef: input.pins.overlayRef } : {}),
        },
      })

      const replayResult = replayFromRecordedPins({
        store,
        pins: input.pins,
        availableCatalogRefs,
      })

      if (freeze.pins.harnessContentHash !== replayResult.pins.harnessContentHash) {
        throw new Error(
          `Replay hash mismatch: freeze=${freeze.pins.harnessContentHash} vs replay=${replayResult.pins.harnessContentHash}`
        )
      }

      // Get baseline document for comparison
      const baselineDoc = store.read(input.pins.baselineRef).document
      const baselineSystemInstruction = renderSystemInstruction(baselineDoc)

      // Render system instruction from frozen document (may include overlay)
      const systemInstruction = renderSystemInstruction(freeze.frozen.document)

      // Create scenario adapter with verifier (uses baseline for comparison)
      const scenarioAdapter = createSystemScenarioAdapter({
        baselineSystemInstruction,
        taskNarrative: freeze.frozen.document.control.taskNarrativeTemplate,
        codeProtocolPin,
      })

      // Build scenario payload using frozen harness
      const scenarioPayload = scenarioAdapter.buildScenarioPayload({
        frozen: freeze.frozen,
        codeProtocolPin,
      })

      // Run verifier to derive metrics (pass current systemInstruction for comparison)
      const verifyResult = scenarioAdapter.verify({
        systemInstruction,
      })

      // Persist run evidence
      const evidenceDir = join(options.artifactsDir, input.reservedRunRef)
      mkdirSync(evidenceDir, { recursive: true })
      const evidencePath = join(evidenceDir, 'evidence.json')
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            runRef: input.reservedRunRef,
            arm: input.arm,
            caseId: input.case.caseId,
            pins: input.pins,
            replayPassed: input.replayPassed,
            verifierResult: verifyResult,
            scenarioId: scenarioAdapter.scenarioId,
            systemInstruction,
            taskNarrative: scenarioPayload.taskNarrative,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        )
      )

      return {
        runRef: input.reservedRunRef,
        quality: verifyResult.quality,
        cost: 10,
        latencyMs: 100,
        failed: !verifyResult.success,
      }
    },
  })

  return {
    rcs,
    trustBundle: SYSTEM_BUNDLE,
    now: () => new Date('2026-08-15T00:00:00Z'),
    adapter,
  }
}
