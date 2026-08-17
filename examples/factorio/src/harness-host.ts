/**
 * Factorio Host composition for Issue #10.
 * Owns Store + LegacySelectionRegistry and assembles run-boundary freeze.
 *
 * Live bootstrap (`createFactorioHostBundle`) may publish default baselines and
 * register legacy mappings. Replay open (`openFactorioReplayHost`) only hydrates
 * an existing durable Store/Registry — never publishes current source defaults.
 */

import fs from 'node:fs'
import path from 'node:path'
import { renderCardDoc } from '../../../src/catalog/render.js'
import { resolveCapabilitySet } from '../../../src/catalog/binding-set-map.js'
import {
  bindControlPlaneText,
  durableStoreSnapshotPath,
  freezeAvailableCatalogRefs,
  materializeHarnessRecord,
  replayFromRecordedPins,
  renderControlPlane,
  selectValidateResolveFreeze,
  type CatalogCardRef,
  type FreezeResult,
  type FrozenHarnessSlice,
  type HarnessDocument,
  type HarnessPinsV1,
  type HarnessRecordTriple,
  type HarnessStateRef,
  HarnessStateStore,
  LegacySelectionRegistryStore,
  baselineContentHash,
} from '../../../src/harness/index.js'
import { RefinementControlStore } from '../../../src/refinement/control-store.js'
import {
  FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
  FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT,
  FACTORIO_DEFAULT_P3_HARNESS_DOCUMENT,
  FACTORIO_V4_HARNESS_DOCUMENT,
  FACTORIO_V5_HARNESS_DOCUMENT,
  createFactorioScenarioAdapter,
} from './harness-document.js'
import type { RunPins } from './types.js'

export type FactorioHostBundle = {
  rcs: RefinementControlStore
  store: HarnessStateStore
  legacyRegistry: LegacySelectionRegistryStore
  defaultBaselineRef: HarnessStateRef
  legacyV4BaselineRef: HarnessStateRef
  legacyV5BaselineRef: HarnessStateRef
  rootDir?: string
}

/**
 * Replay-only Host view: hydrate durable Store + LegacySelectionRegistry.
 * Does not publish defaults or re-register legacy mappings from source.
 */
export type FactorioReplayHostBundle = {
  store: HarnessStateStore
  legacyRegistry: LegacySelectionRegistryStore
  rootDir?: string
}

export type CreateFactorioHostBundleOptions = {
  /**
   * Durable immutable state root shared by live and replay processes.
   * Omit / undefined → ephemeral in-memory store (unit tests).
   * Pass an absolute directory for Host-held cross-process immutability.
   */
  rootDir?: string
}

export type OpenFactorioReplayHostOptions = {
  /**
   * Durable Host state root to hydrate. Required for production replay.
   * Pass `null` for an empty ephemeral Store (unit tests that fail closed
   * before Store reads, or inject fixtures via a shared temp root instead).
   */
  rootDir?: string | null
}

/**
 * Live / migration bootstrap: publish default P1 + legacy v4/v5 baselines when
 * absent, and register legacy pin mappings. Idempotent under a durable root.
 *
 * Must not be used by new-format replay — use {@link openFactorioReplayHost}.
 */
export function createFactorioHostBundle(
  options: CreateFactorioHostBundleOptions = {},
): FactorioHostBundle {
  const rootDir =
    typeof options.rootDir === 'string' && options.rootDir.length > 0
      ? options.rootDir
      : undefined
  const rcs = new RefinementControlStore(rootDir === undefined ? {} : { rootDir })
  if (rootDir !== undefined) importLegacyHarnessStoreIfPresent(rcs, rootDir)
  const store = rcsHarnessView(rcs)
  // Keep P1 materialized for recorded selections and old candidates. New live
  // runs use P2, whose contract clarification is an immutable new baseline.
  publishBaselineIfAbsent(store, {
    id: 'factorio.default-p1',
    revision: 1,
    document: FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
  })
  const defaultBaselineRef = publishBaselineIfAbsent(store, {
    id: 'factorio.default-p3',
    revision: 1,
    document: FACTORIO_DEFAULT_P3_HARNESS_DOCUMENT,
  })
  publishBaselineIfAbsent(store, {
    id: 'factorio.default-p2',
    revision: 1,
    document: FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT,
  })
  const legacyV4BaselineRef = publishBaselineIfAbsent(store, {
    id: 'factorio.legacy-v4',
    revision: 1,
    document: FACTORIO_V4_HARNESS_DOCUMENT,
  })
  const legacyV5BaselineRef = publishBaselineIfAbsent(store, {
    id: 'factorio.legacy-v5',
    revision: 1,
    document: FACTORIO_V5_HARNESS_DOCUMENT,
  })
  const legacyRegistry = new LegacySelectionRegistryStore(
    rcs.materializeHarnessStore(),
    rootDir === undefined ? {} : { rootDir },
  )
  legacyRegistry.registerLegacySelection({
    registryIdentity: {
      id: 'helix.harness-legacy-selection-registry',
      schemaVersion: 'v1',
    },
    codeProtocolPin: 'factorio-rlm/v4',
    baselineRef: legacyV4BaselineRef,
    baselineContentHash: legacyV4BaselineRef.contentHash,
    schemaVersion: 'helix.harness/v1',
  })
  legacyRegistry.registerLegacySelection({
    registryIdentity: {
      id: 'helix.harness-legacy-selection-registry',
      schemaVersion: 'v1',
    },
    codeProtocolPin: 'factorio-rlm/v5',
    baselineRef: legacyV5BaselineRef,
    baselineContentHash: legacyV5BaselineRef.contentHash,
    schemaVersion: 'helix.harness/v1',
  })
  return {
    rcs,
    store,
    legacyRegistry,
    defaultBaselineRef,
    legacyV4BaselineRef,
    legacyV5BaselineRef,
    ...(rootDir === undefined ? {} : { rootDir }),
  }
}

export function openFactorioReplayHost(
  options: OpenFactorioReplayHostOptions = {},
): FactorioReplayHostBundle {
  if (options.rootDir === null) {
    const store = new HarnessStateStore()
    const legacyRegistry = new LegacySelectionRegistryStore(store)
    return { store, legacyRegistry }
  }
  const rootDir =
    typeof options.rootDir === 'string' && options.rootDir.length > 0
      ? options.rootDir
      : undefined
  if (rootDir !== undefined && fs.existsSync(path.join(rootDir, 'refinement-control.json'))) {
    const rcs = new RefinementControlStore({ rootDir })
    const store = rcsHarnessView(rcs)
    const legacyRegistry = new LegacySelectionRegistryStore(rcs.materializeHarnessStore(), { rootDir })
    return { store, legacyRegistry, rootDir }
  }
  const store = new HarnessStateStore(rootDir === undefined ? {} : { rootDir })
  const legacyRegistry = new LegacySelectionRegistryStore(
    store,
    rootDir === undefined ? {} : { rootDir },
  )
  return {
    store,
    legacyRegistry,
    ...(rootDir === undefined ? {} : { rootDir }),
  }
}

function rcsHarnessView(rcs: RefinementControlStore): HarnessStateStore {
  return {
    publishBaseline: (document: unknown, options?: { id?: string; revision?: number }) =>
      rcs.publishBaseline(document, options),
    publishOverlay: (overlay: unknown, options?: { id?: string; revision?: number }) =>
      rcs.publishOverlay(overlay, options),
    read: (ref: HarnessStateRef) => rcs.read(ref),
    exportSnapshot: () => rcs.exportSnapshot(),
    select: (input: unknown, catalog: readonly CatalogCardRef[]) =>
      rcs.materializeHarnessStore().select(input, catalog),
    resolve: (
      selection: Parameters<HarnessStateStore['resolve']>[0],
      codeProtocolPin: string,
      catalog: readonly CatalogCardRef[],
    ) => rcs.resolve(selection, codeProtocolPin, catalog),
    get durableRootDir() {
      return rcs.durableRootDir
    },
  } as HarnessStateStore
}
function importLegacyHarnessStoreIfPresent(rcs: RefinementControlStore, rootDir: string): void {
  if (fs.existsSync(path.join(rootDir, 'refinement-control.json'))) return
  if (!fs.existsSync(durableStoreSnapshotPath(rootDir))) return
  const legacy = new HarnessStateStore({ rootDir })
  const snapshot = legacy.exportSnapshot()
  for (const entry of snapshot.baselines) {
    rcs.publishBaseline(entry.document, { id: entry.ref.id, revision: entry.ref.revision })
  }
  for (const entry of snapshot.overlays) {
    rcs.publishOverlay(entry.overlay, { id: entry.ref.id, revision: entry.ref.revision })
  }
}

function publishBaselineIfAbsent(
  store: HarnessStateStore,
  input: {
    id: string
    revision: number
    document: HarnessDocument
  },
): HarnessStateRef {
  const expectedHash = baselineContentHash(input.document)
  const existing = store
    .exportSnapshot()
    .baselines.find(
      (entry) =>
        entry.ref.id === input.id && entry.ref.revision === input.revision,
    )
  if (existing !== undefined) {
    if (existing.ref.contentHash !== expectedHash) {
      throw new Error(
        `factorio host baseline ${input.id}@${input.revision} contentHash drift under durable root`,
      )
    }
    return existing.ref
  }
  return store.publishBaseline(input.document, {
    id: input.id,
    revision: input.revision,
  })
}

/**
 * Form Factorio run availableCatalogRefs from the code/protocol pin / binding set.
 * Formation is Host-owned; #10 only consumes the frozen set.
 *
 * v4 (#5 recursive-model path) exposes models only.
 * v5 (session-async path) may also expose the session family card.
 */
export function formFactorioAvailableCatalogRefs(
  codeProtocolPin: 'factorio-rlm/v4' | 'factorio-rlm/v5',
): readonly CatalogCardRef[] {
  const setId =
    codeProtocolPin === 'factorio-rlm/v5'
      ? 'helix.runtime.core/v1'
      : 'helix.runtime.recursive-model/v1'
  return freezeAvailableCatalogRefs(resolveCapabilitySet(setId))
}

/** Parse the complete immutable ref syntax accepted by the Factorio CLI. */
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
export type AssembledFactorioRun = {
  freeze: FreezeResult
  frozen: FrozenHarnessSlice
  harnessPins: HarnessPinsV1
  pins: RunPins
  controlPlaneText: string
  /** Host-bound content hash of controlPlaneText for runHarness gate. */
  controlPlaneContentHash: string
  record: HarnessRecordTriple
}

/**
 * Assemble a Factorio run at the Host boundary: freeze harness state, attach
 * harnessState onto RunPins, and render the control plane with the adapter.
 * Callers must pass an explicit published baselineRef — no default selection.
 */
export function assembleFactorioRun(input: {
  bundle: FactorioHostBundle
  basePins: RunPins
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
}): AssembledFactorioRun {
  const codeProtocolPin = input.basePins.harness
  const availableCatalogRefs = formFactorioAvailableCatalogRefs(codeProtocolPin)
  if (input.overlayRef !== undefined) {
    input.bundle.rcs.select('external', {
      baselineRef: input.baselineRef,
      overlayRef: input.overlayRef,
    }, availableCatalogRefs)
  }
  const freeze = selectValidateResolveFreeze({
    store: input.bundle.store,
    availableCatalogRefs,
    codeProtocolPin,
    selection: {
      baselineRef: input.baselineRef,
      ...(input.overlayRef !== undefined ? { overlayRef: input.overlayRef } : {}),
    },
  })
  return assembleFrozenFactorioRun(input.basePins, freeze)
}

/**
 * Reconstruct a new Factorio run from the exact frozen pins issued to an
 * evaluator. This deliberately skips the external-overlay admission route:
 * evaluator admission was already checked before these pins were produced.
 */
export function assembleFactorioRunFromFrozenPins(input: {
  bundle: FactorioHostBundle
  basePins: RunPins
  harnessPins: HarnessPinsV1
}): AssembledFactorioRun {
  const availableCatalogRefs = formFactorioAvailableCatalogRefs(input.basePins.harness)
  const freeze = replayFromRecordedPins({
    store: input.bundle.store,
    pins: input.harnessPins,
    availableCatalogRefs,
  })
  return assembleFrozenFactorioRun(input.basePins, freeze)
}

function assembleFrozenFactorioRun(
  basePins: RunPins,
  freeze: FreezeResult,
): AssembledFactorioRun {
  const adapter = createFactorioScenarioAdapter()
  const scenario = adapter.buildScenarioPayload({
    frozen: freeze.frozen,
    codeProtocolPin: basePins.harness,
  })
  const catalogDocs = freeze.frozen.catalogCards.map((ref) => ({
    ref,
    doc: renderCardDoc(ref.id, ref.version),
  }))
  const controlPlaneText = renderControlPlane({
    document: freeze.frozen.document,
    catalogDocs,
    scenario,
  })
  const controlPlaneContentHash = bindControlPlaneText(
    freeze.frozen,
    controlPlaneText,
  )
  const pins: RunPins = {
    ...basePins,
    harnessState: freeze.pins,
  }
  const record = materializeHarnessRecord(freeze)
  return {
    freeze,
    frozen: freeze.frozen,
    harnessPins: freeze.pins,
    pins,
    controlPlaneText,
    controlPlaneContentHash,
    record,
  }
}
