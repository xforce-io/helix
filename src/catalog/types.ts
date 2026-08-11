/**
 * Issue #11 — Capability Catalog card schema (Helix-level, runtime-only v1).
 */

export type CardKind = 'env' | 'runtime'

/** Closed set of exactly 7 values. Unknown => reject. L2 MUST NOT extend. */
export type EffectClass =
  | 'observe'
  | 'commit'
  | 'env_effect'
  | 'model_effect'
  | 'spawn'
  | 'wait_external'
  | 'admin'

/** Full-contract optional labels; v1 may omit and use path-based admission. */
export type RegistrationScope = 'runtime-catalog' | 'fixture-extension'
export type InjectionTarget = 'kernel-binding' | 'harness-control'

export interface SurfaceEntry {
  /** Fully-qualified entry name, e.g. "helix.models.call" */
  name: string
  /** Required. Must be one of EffectClass. */
  effectClass: EffectClass
  /** Design-level call shape summary (not a full OpenAPI). */
  signature: string
  /**
   * Optional for non-admin; REQUIRED for admin.
   * If present for non-admin, MUST equal default occupancy for effectClass.
   */
  occupiesHostEffectSlot?: boolean
}

export interface CardEffectSummary {
  /**
   * Derived projection of unique(surface[].effectClass).
   * v1: MAY omit on disk and derive at load; if present MUST equal that set
   * (no duplicates; every element ∈ EffectClass; set equality).
   */
  effectClasses?: EffectClass[]
  /** REQUIRED. Human-readable mutual-exclusion / admission-failure summary. */
  hostSlotSummary: string
  mutualExclusionWith?: string[]
  actorModel?: string
  opaqueCapability?: boolean
}

export interface BudgetAndAuth {
  capabilityGate: string
  tokenPool?: string
  countBudget?: string
  auth?: string
  limits?: Record<string, unknown>
  unauthorized: string
}

export interface CardDoc {
  format: 'markdown/v1'
  title: string
  /** Model-visible authoritative body (SSOT). */
  body: string
}

export interface CardReplay {
  recordingAnchor: string
  zeroLiveFallback: boolean
  isolation?: string
  exactlyOnceMerge?: boolean
  checkpointBounds?: string
  notes?: string
}

/** Normative payload — identity-immutable under id+version. */
export interface NormativePayload {
  kind: CardKind
  surface: SurfaceEntry[]
  effect: CardEffectSummary
  budgetAndAuth: BudgetAndAuth
  doc: CardDoc
  replay: CardReplay
  nonGoals: string[]
}

export interface CapabilityCard {
  id: string
  version: string
  /** Optional in v1 file cards when path implies production. */
  registrationScope?: RegistrationScope
  injectionTarget?: InjectionTarget
  provider?: string
  capabilityDiscoveryKeys?: string[]
  pinsTouch?: string
  /** Optional integrity hash. NOT reference identity. v1 MAY omit. */
  contentHash?: string
  kind: CardKind
  surface: SurfaceEntry[]
  effect: CardEffectSummary
  budgetAndAuth: BudgetAndAuth
  doc: CardDoc
  replay: CardReplay
  nonGoals: string[]
}

export interface CardRef {
  id: string
  version: string
  contentHash?: string
}

export interface BindingSetCardMapping {
  mappingVersion: string
  bindingSet?: string
  cards: CardRef[]
}

/** pins slice consumed by #10 (semantics only; field placement deferred). */
export interface CatalogPinsSlice {
  catalogMappingVersion?: string
  catalogCards: CardRef[]
}

export const EFFECT_CLASSES: readonly EffectClass[] = [
  'observe',
  'commit',
  'env_effect',
  'model_effect',
  'spawn',
  'wait_external',
  'admin',
] as const

export const ALLOWED_KERNEL_NS_PREFIXES = ['helix.'] as const
export const HARNESS_CONTROL_NAMESPACES = ['helix.harness'] as const
