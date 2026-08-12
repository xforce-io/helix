/**
 * Generic versioned harness state (Issue #10).
 *
 * Host control-plane internal contracts. Not a public Runtime API.
 * Concrete scenarios must only depend on ExampleScenarioAdapter — never the reverse.
 */

export type {
  AgentSpec,
  CatalogCardRef,
  CompatibilityDecision,
  ControlPlaneRenderInput,
  ExampleScenarioAdapter,
  FrozenHarnessSlice,
  HarnessDocument,
  HarnessEvidenceSlice,
  HarnessOverlay,
  HarnessOverlayChanges,
  HarnessPinsV1,
  HarnessSelection,
  HarnessSelectionInput,
  HarnessStateRef,
  LegacySelectionManifest,
  LegacySelectionRegistry,
  LegacySelectionRegistryEntry,
  LegacySelectionRegistryIdentity,
  ResolvedHarness,
  ScenarioPayload,
  StoredHarnessState,
} from './types.js'

export {
  HarnessError,
  harnessError,
  validationFail,
  validationOk,
  throwFail,
  type HarnessErrorCode,
  type HarnessValidationResult,
} from './errors.js'

export {
  canonicalizeHarnessValue,
  canonicalizeHarnessValueAlt,
  harnessCanonicalBytes,
  harnessCanonicalBytesAlt,
  harnessContentHash,
  harnessContentHashAlt,
  isContentHash,
  deepFreezeJson,
  cloneJson,
  sha256HexOfBytes,
} from './canonical.js'

export {
  parseHarnessJsonText,
  parseHarnessJsonTextAlt,
  type JsonTextValue,
  type ParsedJsonText,
} from './json-text.js'

export {
  validateHarnessDocument,
  validateHarnessOverlay,
  validateHarnessStateRef,
  validateCatalogCardRef,
  requireHarnessDocument,
  requireHarnessOverlay,
  requireHarnessStateRef,
  baselineContentHash,
  overlayContentHash,
  mergeOverlayOntoBaseline,
  resolveCatalogCardsInRegistry,
  assertCardsAvailable,
  assertAgentSpecCatalogClosure,
  assertDocumentAcceptsPin,
  refsEqual,
  dedupeCatalogRefs,
} from './document.js'

export { HarnessStateStore } from './store.js'

export {
  LegacySelectionRegistryStore,
  LEGACY_SELECTION_REGISTRY_IDENTITY,
  assertManifestProvenance,
  assertLegacyReplaySelectionOnly,
} from './legacy.js'

export {
  freezeAvailableCatalogRefs,
  selectValidateResolveFreeze,
  replayFromRecordedPins,
  replayFromLegacyPin,
  inheritFrozenHarnessSlice,
  toHarnessPinsV1,
  type HostRunBootstrap,
  type FreezeResult,
} from './host.js'

export { renderControlPlane, renderSystemInstruction } from './renderer.js'

export {
  assertControlPlaneBinding,
  bindControlPlaneText,
  controlPlaneTextHash,
} from './control-plane-binding.js'

export {
  acquireDurableLockSync,
  releaseDurableLockSync,
  withDurableLockSync,
  durableStoreLockPath,
  durableLegacyRegistryLockPath,
} from './persist.js'

export {
  materializeHarnessRecord,
  assertHarnessRecordConsistent,
  assertHarnessPinsEqual,
  assertFrozenHarnessMatchesPins,
  frozenSliceFromPins,
  type HarnessRecordTriple,
} from './record.js'


export {
  atomicWriteJsonSync,
  durableStoreSnapshotPath,
  durableLegacyRegistryPath,
  readDurableJsonSync,
} from './persist.js'

export { createFixtureScenarioAdapter } from './adapter.js'
