/**
 * System-level RefinementCommandHost that exercises catalog + harness + refinement.
 * Unlike test/refinement/command-host.ts (minimal fixture), this one loads production
 * catalog cards and uses real selectValidateResolveFreeze + replayFromRecordedPins paths.
 */

import {
  createFixtureScenarioAdapter,
  type HarnessDocument,
  HarnessStateStore,
  type HarnessPinsV1,
  type HarnessStateRef,
  selectValidateResolveFreeze,
  replayFromRecordedPins,
  type CatalogCardRef,
} from '../../src/harness/index.js'
import { listProductionCards, resolveCapabilitySet, resolveCardRefs } from '../../src/catalog/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import type { RefinementCommandHost } from '../../src/refinement/commands.js'
import type { RefinementRunAdapter, EvaluationMetric } from '../../src/refinement/workflow.js'
import { HRCA_BUNDLE } from '../refinement/fixtures.js'

export const SYSTEM_EXTRACTOR_DIGEST = 'e'.repeat(64)

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
 * System-level command host that exercises the full stack:
 * - Production catalog cards loaded via listProductionCards / resolveCapabilitySet
 * - selectValidateResolveFreeze for live path
 * - replayFromRecordedPins for replay path
 * - Fixture scenario adapter for deterministic execution
 */
export function createSystemCommandHost(options: {
  rootDir?: string
} = {}): RefinementCommandHost {
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

  // Create fixture scenario adapter for deterministic runs
  const scenarioAdapter = createFixtureScenarioAdapter({
    scenarioId: 'system.e2e.scenario',
    taskNarrative: 'System e2e task narrative from fixture adapter',
    environmentNarrative: 'System e2e environment narrative',
  })

  const adapter: RefinementRunAdapter = {
    async generate(input) {
      // Fixture generation: propose a simple overlay
      return {
        generationRunRef: input.reservedGenerationRunRef,
        payloadText: JSON.stringify({
          schemaVersion: 'helix.harness-overlay/v1',
          baseBaselineRef: base,
          changes: { systemInstructionTemplate: 'system candidate instruction' },
        }),
        modelPins: { model: 'system-fixture-model', provider: 'system-recorded' },
        budget: { reserved: 128, charged: 16 },
      }
    },
    async evaluate(input): Promise<EvaluationMetric> {
      // Hydrate a fresh store from RCS snapshot to ensure we see all published state
      const snapshot = rcs.exportSnapshot()
      const store = new HarnessStateStore()
      
      // Manually republish baseline and overlays from snapshot
      for (const entry of snapshot.baselines) {
        store.publishBaseline(entry.document, { id: entry.ref.id, revision: entry.ref.revision })
      }
      for (const entry of snapshot.overlays) {
        store.publishOverlay(entry.overlay, { id: entry.ref.id, revision: entry.ref.revision })
      }

      const selection = {
        baselineRef: input.baselineRef,
        ...(input.overlayRef !== undefined ? { overlayRef: input.overlayRef } : {}),
      }

      // Live path: selectValidateResolveFreeze
      const freeze = selectValidateResolveFreeze({
        store,
        availableCatalogRefs,
        codeProtocolPin: 'system-fixture/v1',
        selection,
      })

      // Verify replay path: replayFromRecordedPins produces same hash
      const replayResult = replayFromRecordedPins({
        store,
        pins: freeze.pins,
        availableCatalogRefs,
      })

      if (freeze.pins.harnessContentHash !== replayResult.pins.harnessContentHash) {
        throw new Error(
          `Replay hash mismatch: freeze=${freeze.pins.harnessContentHash} vs replay=${replayResult.pins.harnessContentHash}`
        )
      }

      // Run fixture scenario adapter (no actual model call)
      const scenarioPayload = scenarioAdapter.buildScenarioPayload()

      const candidate = input.arm === 'candidate'
      return {
        quality: candidate ? 0.85 : 0.7,
        cost: candidate ? 12 : 10,
        latencyMs: candidate ? 110 : 100,
        failed: false,
        replayPassed: true,
        sharedPins: {
          model: 'system-fixture-model',
          seed: String(input.case.seed),
          runner: 'system-fixture',
          scenarioId: scenarioAdapter.scenarioId,
        },
        harnessPins: freeze.pins,
        runRef: input.reservedRunRef,
        extractorDigest: SYSTEM_EXTRACTOR_DIGEST,
      }
    },
  }

  return {
    rcs,
    trustBundle: {
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
    },
    now: () => new Date('2026-08-15T00:00:00Z'),
    adapter,
  }
}
