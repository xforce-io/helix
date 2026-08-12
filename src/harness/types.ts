/**
 * Issue #10 — versioned HarnessDocument and immutable run-boundary state.
 * Host control-plane internal contracts only; not a public Runtime API.
 */

export type CatalogCardRef = {
  id: string
  version: string
}

export type HarnessStateRef = {
  kind: 'baseline' | 'overlay'
  id: string
  revision: number
  contentHash: string
}

export type AgentSpec = {
  id: string
  defaultInstruction: string
  catalogCards: CatalogCardRef[]
  budget: {
    maxCalls?: number
    maxOutputTokens?: number
  }
}

export type HarnessDocument = {
  schemaVersion: 'helix.harness/v1'
  control: {
    systemInstructionTemplate: string
    taskNarrativeTemplate: string
    protocolRules: string[]
    termination: {
      successSource: 'scenario-verifier'
      stopConditions: string[]
    }
  }
  catalogCards: CatalogCardRef[]
  compatibility: {
    codeProtocolPins: string[]
  }
  agentSpecs?: AgentSpec[]
}

export type HarnessOverlayChanges = {
  systemInstructionTemplate?: string
  taskNarrativeTemplate?: string
  protocolRules?: string[]
  stopConditions?: string[]
  catalogCards?: CatalogCardRef[]
}

export type HarnessOverlay = {
  schemaVersion: 'helix.harness-overlay/v1'
  baseBaselineRef: HarnessStateRef
  changes: HarnessOverlayChanges
}

export type HarnessSelectionInput = {
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
}

export type HarnessSelection = {
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
  baseline: HarnessDocument
  overlay?: HarnessOverlay
  availableCatalogRefs: CatalogCardRef[]
}

export type CompatibilityDecision = {
  documentAcceptsCodeProtocolPin: true
  catalogResolved: true
}

export type ResolvedHarness = {
  document: HarnessDocument
  selection: {
    baselineRef: HarnessStateRef
    overlayRef?: HarnessStateRef
  }
  harnessContentHash: string
  schemaVersion: 'helix.harness/v1'
  catalogCards: CatalogCardRef[]
  compatibilityDecision: CompatibilityDecision
  codeProtocolPin: string
  availableCatalogRefs: CatalogCardRef[]
}

export type FrozenHarnessSlice = {
  selection: {
    baselineRef: HarnessStateRef
    overlayRef?: HarnessStateRef
  }
  document: HarnessDocument
  harnessContentHash: string
  schemaVersion: 'helix.harness/v1'
  catalogCards: CatalogCardRef[]
  compatibilityDecision: CompatibilityDecision
  codeProtocolPin: string
  availableCatalogRefs: CatalogCardRef[]
}

export type HarnessPinsV1 = {
  format: 'harness/v1'
  codeProtocolPin: string
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
  harnessContentHash: string
  schemaVersion: 'helix.harness/v1'
  catalogCards: Array<{ id: string; version: string }>
  compatibilityDecision: CompatibilityDecision
}

export type HarnessEvidenceSlice = HarnessPinsV1 & {
  selectionSource: 'recorded' | 'legacy-registry'
  registryIdentity?: LegacySelectionRegistryIdentity
}

export type StoredHarnessState =
  | {
      kind: 'baseline'
      ref: HarnessStateRef
      document: HarnessDocument
    }
  | {
      kind: 'overlay'
      ref: HarnessStateRef
      overlay: HarnessOverlay
    }

export type LegacySelectionRegistryIdentity = {
  id: 'helix.harness-legacy-selection-registry'
  schemaVersion: 'v1'
}

export type LegacySelectionRegistryEntry = {
  registryIdentity: LegacySelectionRegistryIdentity
  codeProtocolPin: string
  baselineRef: HarnessStateRef
  baselineContentHash: string
  schemaVersion: 'helix.harness/v1'
}

export type LegacySelectionRegistry = {
  registryIdentity: LegacySelectionRegistryIdentity
  entries: LegacySelectionRegistryEntry[]
}

export type LegacySelectionManifest = {
  manifestVersion: 'helix.harness-legacy-selection/v1'
  registryIdentity: LegacySelectionRegistryIdentity
  exportedEntries: LegacySelectionRegistryEntry[]
}

/** Scenario payload injected only into the control-plane renderer. */
export type ScenarioPayload = {
  taskNarrative?: string
  environmentNarrative?: string
  extraSections?: Array<{ title: string; body: string }>
}

export type ControlPlaneRenderInput = {
  document: HarnessDocument
  catalogDocs: Array<{ ref: CatalogCardRef; doc: string }>
  scenario: ScenarioPayload
  runtimeObservation?: string
}

export type ExampleScenarioAdapter = {
  readonly scenarioId: string
  buildScenarioPayload(input: {
    frozen: FrozenHarnessSlice
    codeProtocolPin: string
  }): ScenarioPayload
  verify?(input: unknown): { success: boolean; meta?: unknown }
  metrics?(input: unknown): Record<string, unknown>
}
