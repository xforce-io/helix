import {
  validationFail,
  validationOk,
  type CatalogValidationResult,
} from './errors.js'
import { checkOccupancy } from './occupancy.js'
import {
  ALLOWED_KERNEL_NS_PREFIXES,
  EFFECT_CLASSES,
  HARNESS_CONTROL_NAMESPACES,
  type CapabilityCard,
  type CardEffectSummary,
  type CardKind,
  type EffectClass,
  type NormativePayload,
  type SurfaceEntry,
} from './types.js'

const EFFECT_CLASS_SET = new Set<string>(EFFECT_CLASSES)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Card payloads are JSON-shaped only (no Map/Set/Date/etc.). */
function isJsonValue(
  value: unknown,
  path: string,
  seen: Set<object> = new Set(),
): CatalogValidationResult | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return null
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        `${path} must be a finite number`,
      )
    }
    return null
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        `${path} must not contain cyclic references`,
      )
    }
  }
  if (Array.isArray(value)) {
    seen.add(value)
    for (let i = 0; i < value.length; i++) {
      const inner = isJsonValue(value[i], `${path}[${i}]`, seen)
      if (inner) return inner
    }
    seen.delete(value)
    return null
  }
  if (isPlainObject(value)) {
    seen.add(value)
    for (const key of Object.keys(value)) {
      const inner = isJsonValue(value[key], `${path}.${key}`, seen)
      if (inner) return inner
    }
    seen.delete(value)
    return null
  }
  return validationFail(
    'CATALOG_SCHEMA_INVALID',
    `${path} must be JSON-compatible (plain object/array/primitive); exotic objects rejected`,
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isEffectClass(value: unknown): value is EffectClass {
  return typeof value === 'string' && EFFECT_CLASS_SET.has(value)
}

function isCardKind(value: unknown): value is CardKind {
  return value === 'env' || value === 'runtime'
}

function primaryNamespace(entryName: string): string {
  const parts = entryName.split('.')
  if (parts.length < 2) return entryName
  return `${parts[0]}.${parts[1]}`
}

function hasAllowedKernelPrefix(name: string): boolean {
  return ALLOWED_KERNEL_NS_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function isHarnessControlNamespace(name: string): boolean {
  const ns = primaryNamespace(name)
  return (HARNESS_CONTROL_NAMESPACES as readonly string[]).includes(ns)
}

/**
 * unique(surface[].effectClass) in first-seen order.
 * If handwritten effect.effectClasses is present, must match as a set
 * (no duplicates, every element ∈ EffectClass).
 */
export function deriveEffectClasses(
  surface: SurfaceEntry[],
  effect?: CardEffectSummary,
): EffectClass[] {
  const fromSurface: EffectClass[] = []
  const seen = new Set<EffectClass>()
  for (const entry of surface) {
    if (!seen.has(entry.effectClass)) {
      seen.add(entry.effectClass)
      fromSurface.push(entry.effectClass)
    }
  }

  if (effect?.effectClasses != null) {
    assertEffectClassesMatchSurface(effect.effectClasses, fromSurface)
  }
  // Identity uses surface first-seen order; handwritten order is non-identity.
  return fromSurface
}

export function assertEffectClassesMatchSurface(
  handwritten: EffectClass[],
  fromSurface: EffectClass[],
): void {
  if (!Array.isArray(handwritten)) {
    throw new Error('effect.effectClasses must be an array')
  }
  const seen = new Set<string>()
  for (const value of handwritten) {
    if (!isEffectClass(value)) {
      throw new Error(`unknown effectClass in effect.effectClasses: ${String(value)}`)
    }
    if (seen.has(value)) {
      throw new Error(`duplicate effectClass in effect.effectClasses: ${value}`)
    }
    seen.add(value)
  }
  const surfaceSet = new Set(fromSurface)
  if (seen.size !== surfaceSet.size) {
    throw new Error('effect.effectClasses set does not match unique(surface[].effectClass)')
  }
  for (const value of seen) {
    if (!surfaceSet.has(value as EffectClass)) {
      throw new Error(
        `effect.effectClasses contains ${value} not present on surface`,
      )
    }
  }
}

export function extractNormativePayload(card: CapabilityCard): NormativePayload {
  const effectClasses = deriveEffectClasses(card.surface, card.effect)
  return {
    kind: card.kind,
    surface: card.surface,
    effect: { ...card.effect, effectClasses },
    budgetAndAuth: card.budgetAndAuth,
    doc: card.doc,
    replay: card.replay,
    nonGoals: card.nonGoals,
  }
}

/** Stable JSON of normative payload for immutability comparison (not contentHash). */
export function normativePayloadKey(card: CapabilityCard): string {
  const payload = extractNormativePayload(card)
  return JSON.stringify(payload)
}

/** Channel metadata that must not silently drift under the same id+version. */
export function channelMetaKey(card: CapabilityCard): string {
  return JSON.stringify({
    registrationScope: card.registrationScope ?? null,
    injectionTarget: card.injectionTarget ?? null,
    provider: card.provider ?? null,
    capabilityDiscoveryKeys: card.capabilityDiscoveryKeys ?? null,
    pinsTouch: card.pinsTouch ?? null,
  })
}

function validateSurfaceEntry(
  raw: unknown,
  index: number,
): CatalogValidationResult | SurfaceEntry {
  if (!isPlainObject(raw)) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      `surface[${index}] must be an object`,
    )
  }
  if (!isNonEmptyString(raw['name'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      `surface[${index}].name is required`,
    )
  }
  if (!isNonEmptyString(raw['signature'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      `surface[${index}].signature is required`,
    )
  }
  if (raw['effectClass'] === undefined || raw['effectClass'] === null) {
    return validationFail(
      'CATALOG_REJECT_EFFECT_CLASS',
      `surface[${index}].effectClass is required`,
      { name: raw['name'] },
    )
  }
  if (!isEffectClass(raw['effectClass'])) {
    return validationFail(
      'CATALOG_REJECT_EFFECT_CLASS',
      `surface[${index}].effectClass is not in the closed set of 7`,
      { name: raw['name'], effectClass: raw['effectClass'] },
    )
  }

  const entry: SurfaceEntry = {
    name: raw['name'],
    effectClass: raw['effectClass'],
    signature: raw['signature'],
  }
  if (typeof raw['occupiesHostEffectSlot'] === 'boolean') {
    entry.occupiesHostEffectSlot = raw['occupiesHostEffectSlot']
  } else if (raw['occupiesHostEffectSlot'] !== undefined) {
    return validationFail(
      'CATALOG_REJECT_OCCUPANCY',
      `surface[${index}].occupiesHostEffectSlot must be boolean when present`,
      { name: raw['name'] },
    )
  }

  const occ = checkOccupancy(entry)
  if (!occ.ok) {
    return validationFail('CATALOG_REJECT_OCCUPANCY', occ.message, {
      name: entry.name,
    })
  }
  return entry
}

function validateEffectSummary(
  raw: unknown,
  surface: SurfaceEntry[],
): CatalogValidationResult | CardEffectSummary {
  if (!isPlainObject(raw)) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'effect must be an object')
  }
  if (!isNonEmptyString(raw['hostSlotSummary'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'effect.hostSlotSummary is required',
    )
  }

  const summary: CardEffectSummary = {
    hostSlotSummary: raw['hostSlotSummary'],
  }
  if (raw['effectClasses'] !== undefined) {
    if (!Array.isArray(raw['effectClasses'])) {
      return validationFail(
        'CATALOG_REJECT_EFFECT_CLASS',
        'effect.effectClasses must be an array when present',
      )
    }
    const classes: EffectClass[] = []
    for (const value of raw['effectClasses']) {
      if (!isEffectClass(value)) {
        return validationFail(
          'CATALOG_REJECT_EFFECT_CLASS',
          `effect.effectClasses contains unknown value: ${String(value)}`,
        )
      }
      classes.push(value)
    }
    try {
      const derived = deriveEffectClasses(surface)
      assertEffectClassesMatchSurface(classes, derived)
    } catch (error) {
      return validationFail(
        'CATALOG_REJECT_EFFECT_CLASS',
        error instanceof Error ? error.message : 'effectClasses mismatch',
      )
    }
    summary.effectClasses = classes
  }
  if (raw['mutualExclusionWith'] !== undefined) {
    if (
      !Array.isArray(raw['mutualExclusionWith']) ||
      !raw['mutualExclusionWith'].every((x) => typeof x === 'string')
    ) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'effect.mutualExclusionWith must be string[] when present',
      )
    }
    summary.mutualExclusionWith = raw['mutualExclusionWith'] as string[]
  }
  if (raw['actorModel'] !== undefined) {
    if (typeof raw['actorModel'] !== 'string') {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'effect.actorModel must be a string when present',
      )
    }
    summary.actorModel = raw['actorModel']
  }
  if (raw['opaqueCapability'] !== undefined) {
    if (typeof raw['opaqueCapability'] !== 'boolean') {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'effect.opaqueCapability must be boolean when present',
      )
    }
    summary.opaqueCapability = raw['opaqueCapability']
  }
  return summary
}

/**
 * Structural schema validation (required fields, enums, occupancy, effectClasses).
 * Does not apply production admission predicates.
 */
export function validateCardStructure(card: unknown): CatalogValidationResult {
  if (!isPlainObject(card)) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'card must be an object')
  }
  const jsonShape = isJsonValue(card, 'card')
  if (jsonShape) return jsonShape

  if (!isNonEmptyString(card['id'])) {
    return validationFail('CATALOG_REJECT_IDENTITY', 'id is required')
  }
  if (!isNonEmptyString(card['version'])) {
    return validationFail(
      'CATALOG_REJECT_IDENTITY',
      'version is required and must be non-empty',
    )
  }
  if (!isCardKind(card['kind'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      `kind must be "env" or "runtime", got ${String(card['kind'])}`,
    )
  }
  if (!Array.isArray(card['surface'])) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'surface must be an array')
  }
  if (!isPlainObject(card['effect'])) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'effect is required')
  }
  if (!isPlainObject(card['budgetAndAuth'])) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'budgetAndAuth is required')
  }
  if (!isPlainObject(card['doc'])) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'doc is required')
  }
  if (!isPlainObject(card['replay'])) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'replay is required')
  }
  if (!Array.isArray(card['nonGoals'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'nonGoals is required (may be empty array)',
    )
  }
  if (!card['nonGoals'].every((x) => typeof x === 'string')) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'nonGoals must be string[]',
    )
  }

  const budget = card['budgetAndAuth']
  if (!isNonEmptyString(budget['capabilityGate'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'budgetAndAuth.capabilityGate is required',
    )
  }
  if (!isNonEmptyString(budget['unauthorized'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'budgetAndAuth.unauthorized is required',
    )
  }

  const doc = card['doc']
  if (doc['format'] !== 'markdown/v1') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'doc.format must be "markdown/v1"',
    )
  }
  if (!isNonEmptyString(doc['title'])) {
    return validationFail('CATALOG_SCHEMA_INVALID', 'doc.title is required')
  }
  if (typeof doc['body'] !== 'string') {
    return validationFail('CATALOG_SCHEMA_INVALID', 'doc.body is required')
  }

  const replay = card['replay']
  if (!isNonEmptyString(replay['recordingAnchor'])) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'replay.recordingAnchor is required',
    )
  }
  if (typeof replay['zeroLiveFallback'] !== 'boolean') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'replay.zeroLiveFallback must be boolean',
    )
  }

  // Optional top-level channel / discovery / integrity fields
  if (card['provider'] !== undefined && typeof card['provider'] !== 'string') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'provider must be a string when present',
    )
  }
  if (card['pinsTouch'] !== undefined && typeof card['pinsTouch'] !== 'string') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'pinsTouch must be a string when present',
    )
  }
  if (card['contentHash'] !== undefined) {
    if (typeof card['contentHash'] !== 'string') {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'contentHash must be a string when present',
      )
    }
  }
  if (card['capabilityDiscoveryKeys'] !== undefined) {
    if (
      !Array.isArray(card['capabilityDiscoveryKeys']) ||
      !card['capabilityDiscoveryKeys'].every((x) => typeof x === 'string')
    ) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'capabilityDiscoveryKeys must be string[] when present',
      )
    }
  }

  // Optional budgetAndAuth fields
  if (budget['tokenPool'] !== undefined && typeof budget['tokenPool'] !== 'string') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'budgetAndAuth.tokenPool must be a string when present',
    )
  }
  if (
    budget['countBudget'] !== undefined &&
    typeof budget['countBudget'] !== 'string'
  ) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'budgetAndAuth.countBudget must be a string when present',
    )
  }
  if (budget['auth'] !== undefined && typeof budget['auth'] !== 'string') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'budgetAndAuth.auth must be a string when present',
    )
  }
  if (budget['limits'] !== undefined) {
    if (!isPlainObject(budget['limits'])) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'budgetAndAuth.limits must be a plain object when present',
      )
    }
  }

  // Optional replay fields
  if (replay['isolation'] !== undefined && typeof replay['isolation'] !== 'string') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'replay.isolation must be a string when present',
    )
  }
  if (
    replay['exactlyOnceMerge'] !== undefined &&
    typeof replay['exactlyOnceMerge'] !== 'boolean'
  ) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'replay.exactlyOnceMerge must be boolean when present',
    )
  }
  if (
    replay['checkpointBounds'] !== undefined &&
    typeof replay['checkpointBounds'] !== 'string'
  ) {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'replay.checkpointBounds must be a string when present',
    )
  }
  if (replay['notes'] !== undefined && typeof replay['notes'] !== 'string') {
    return validationFail(
      'CATALOG_SCHEMA_INVALID',
      'replay.notes must be a string when present',
    )
  }

  if (card['registrationScope'] !== undefined) {
    if (
      card['registrationScope'] !== 'runtime-catalog' &&
      card['registrationScope'] !== 'fixture-extension'
    ) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'registrationScope must be runtime-catalog | fixture-extension',
      )
    }
  }
  if (card['injectionTarget'] !== undefined) {
    if (
      card['injectionTarget'] !== 'kernel-binding' &&
      card['injectionTarget'] !== 'harness-control'
    ) {
      return validationFail(
        'CATALOG_SCHEMA_INVALID',
        'injectionTarget must be kernel-binding | harness-control',
      )
    }
  }

  const surface: SurfaceEntry[] = []
  for (let i = 0; i < card['surface'].length; i++) {
    const entryResult = validateSurfaceEntry(card['surface'][i], i)
    if ('ok' in entryResult && entryResult.ok === false) {
      return entryResult
    }
    surface.push(entryResult as SurfaceEntry)
  }

  const effectResult = validateEffectSummary(card['effect'], surface)
  if ('ok' in effectResult && effectResult.ok === false) {
    return effectResult
  }

  return validationOk()
}

/**
 * Production runtime catalog admission (B1–B9 + identity).
 * Assumes structure has already been validated, or re-validates structure first.
 */
export function validateProductionAdmission(
  card: CapabilityCard,
): CatalogValidationResult {
  const structure = validateCardStructure(card)
  if (!structure.ok) return structure

  // B1 — harness-control injection target
  if (card.injectionTarget === 'harness-control') {
    return validationFail(
      'CATALOG_REJECT_HARNESS_CONTROL',
      'injectionTarget harness-control cannot enter production catalog',
      { id: card.id },
    )
  }

  // B4 / B5 — kind
  if (card.kind === 'env') {
    return validationFail(
      'CATALOG_REJECT_ENV_IN_RUNTIME_CATALOG',
      'kind=env cannot enter production runtime catalog',
      { id: card.id },
    )
  }
  if (card.kind !== 'runtime') {
    return validationFail(
      'CATALOG_REJECT_NON_RUNTIME_KIND',
      `kind must be runtime for production, got ${String(card.kind)}`,
      { id: card.id },
    )
  }

  // Explicit registrationScope if present must be production
  if (
    card.registrationScope !== undefined &&
    card.registrationScope !== 'runtime-catalog'
  ) {
    return validationFail(
      'CATALOG_REJECT_ADMISSION_METADATA_MISSING',
      'production admission requires registrationScope=runtime-catalog when set',
      { id: card.id, registrationScope: card.registrationScope },
    )
  }

  // Explicit injectionTarget if present must be kernel-binding
  if (
    card.injectionTarget !== undefined &&
    card.injectionTarget !== 'kernel-binding'
  ) {
    return validationFail(
      'CATALOG_REJECT_HARNESS_CONTROL',
      'production admission requires injectionTarget=kernel-binding when set',
      { id: card.id },
    )
  }

  if (!Array.isArray(card.surface) || card.surface.length === 0) {
    return validationFail(
      'CATALOG_REJECT_NO_KERNEL_INJECTION',
      'production runtime card requires non-empty surface with helix.* entries',
      { id: card.id },
    )
  }

  let helixEntryCount = 0
  for (const entry of card.surface) {
    if (isHarnessControlNamespace(entry.name)) {
      return validationFail(
        'CATALOG_REJECT_HARNESS_NAMESPACE',
        `surface entry "${entry.name}" uses harness control namespace`,
        { name: entry.name },
      )
    }
    if (!hasAllowedKernelPrefix(entry.name)) {
      return validationFail(
        'CATALOG_REJECT_NO_KERNEL_INJECTION',
        `surface entry "${entry.name}" is not under allowed kernel prefix`,
        { name: entry.name },
      )
    }
    helixEntryCount += 1

    if (!isEffectClass(entry.effectClass)) {
      return validationFail(
        'CATALOG_REJECT_EFFECT_CLASS',
        `invalid effectClass on ${entry.name}`,
        { name: entry.name },
      )
    }
    const occ = checkOccupancy(entry)
    if (!occ.ok) {
      return validationFail('CATALOG_REJECT_OCCUPANCY', occ.message, {
        name: entry.name,
      })
    }
  }

  if (helixEntryCount === 0) {
    return validationFail(
      'CATALOG_REJECT_NO_KERNEL_INJECTION',
      'no helix.* injectable surface entries',
      { id: card.id },
    )
  }

  try {
    deriveEffectClasses(card.surface, card.effect)
  } catch (error) {
    return validationFail(
      'CATALOG_REJECT_EFFECT_CLASS',
      error instanceof Error ? error.message : 'effectClasses invalid',
      { id: card.id },
    )
  }

  return validationOk()
}

/**
 * Fixture / extension channel: structure + kind/effect rules only.
 * Passing does NOT admit the card into production.
 */
export function validateFixtureCard(
  card: CapabilityCard,
): CatalogValidationResult {
  const structure = validateCardStructure(card)
  if (!structure.ok) return structure

  if (card.injectionTarget === 'harness-control') {
    return validationFail(
      'CATALOG_REJECT_HARNESS_CONTROL',
      'fixture channel rejects harness-control cards',
      { id: card.id },
    )
  }

  for (const entry of card.surface) {
    if (isHarnessControlNamespace(entry.name)) {
      return validationFail(
        'CATALOG_REJECT_HARNESS_NAMESPACE',
        `surface entry "${entry.name}" uses harness control namespace`,
        { name: entry.name },
      )
    }
    if (!isEffectClass(entry.effectClass)) {
      return validationFail(
        'CATALOG_REJECT_EFFECT_CLASS',
        `invalid effectClass on ${entry.name}`,
      )
    }
    const occ = checkOccupancy(entry)
    if (!occ.ok) {
      return validationFail('CATALOG_REJECT_OCCUPANCY', occ.message)
    }
  }

  try {
    deriveEffectClasses(card.surface, card.effect)
  } catch (error) {
    return validationFail(
      'CATALOG_REJECT_EFFECT_CLASS',
      error instanceof Error ? error.message : 'effectClasses invalid',
    )
  }

  return validationOk()
}

/** Normalize a structurally-valid card by filling derived effectClasses. */
export function normalizeCard(card: CapabilityCard): CapabilityCard {
  const effectClasses = deriveEffectClasses(card.surface, card.effect)
  return {
    ...card,
    effect: {
      ...card.effect,
      effectClasses,
    },
  }
}
