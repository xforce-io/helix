/**
 * Host control-plane: availableCatalogRefs bootstrap + select→validate→resolve→freeze.
 */

import { cloneJson, deepFreezeJson, harnessContentHash } from './canonical.js'
import {
  assertCardsAvailable,
  dedupeCatalogRefs,
  refsEqual,
  requireHarnessStateRef,
  validateCatalogCardRef,
} from './document.js'
import { harnessError, throwFail } from './errors.js'
import {
  assertLegacyReplaySelectionOnly,
  LegacySelectionRegistryStore,
  LEGACY_SELECTION_REGISTRY_IDENTITY,
} from './legacy.js'
import type { HarnessStateStore } from './store.js'
import type {
  CatalogCardRef,
  FrozenHarnessSlice,
  HarnessEvidenceSlice,
  HarnessPinsV1,
  HarnessSelectionInput,
  HarnessStateRef,
  ResolvedHarness,
} from './types.js'

export type HostRunBootstrap = {
  store: HarnessStateStore
  /** Formed before any select/validate/resolve; immutable for the run. */
  availableCatalogRefs: readonly CatalogCardRef[]
  codeProtocolPin: string
  selection: HarnessSelectionInput
  legacyRegistry?: LegacySelectionRegistryStore
}

export type FreezeResult = {
  frozen: FrozenHarnessSlice
  pins: HarnessPinsV1
  evidence: HarnessEvidenceSlice
  contextHarness: HarnessPinsV1
}

/**
 * Form the run-local immutable availableCatalogRefs set.
 * Formation policy is owned by Host bootstrap (not #10); this helper only
 * validates each exact closed CatalogCardRef, then freezes/dedupes.
 */
export function freezeAvailableCatalogRefs(
  refs: readonly unknown[],
): readonly CatalogCardRef[] {
  if (!Array.isArray(refs)) {
    throw harnessError(
      'HARNESS_CATALOG_UNRESOLVED',
      'availableCatalogRefs must be an array',
    )
  }
  const validated: CatalogCardRef[] = []
  for (let i = 0; i < refs.length; i += 1) {
    const result = validateCatalogCardRef(refs[i], `availableCatalogRefs[${i}]`)
    if (!result.ok) throwFail(result)
    validated.push(result.value)
  }
  return deepFreezeJson(cloneJson(dedupeCatalogRefs(validated)))
}

/**
 * Live run path: select → validate → resolve → freeze.
 * Any failure throws before model/Kernel/scenario effects.
 */
export function selectValidateResolveFreeze(input: HostRunBootstrap): FreezeResult {
  const availableCatalogRefs = freezeAvailableCatalogRefs(input.availableCatalogRefs)
  if (typeof input.codeProtocolPin !== 'string' || input.codeProtocolPin.length === 0) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      'codeProtocolPin must be a non-empty string',
    )
  }
  if (
    input.selection === null ||
    typeof input.selection !== 'object' ||
    Array.isArray(input.selection)
  ) {
    throw harnessError('HARNESS_SELECTION_REQUIRED', 'selection is required')
  }

  // Closed schema at host boundary: only { baselineRef, overlayRef? }.
  const selRaw = input.selection as unknown as Record<string, unknown>
  const allowedSelectionKeys: Record<string, true> = {
    baselineRef: true,
    overlayRef: true,
  }
  for (const key of Object.keys(selRaw)) {
    if (allowedSelectionKeys[key] !== true) {
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        `selection must not include '${key}'; only baselineRef and optional overlayRef are allowed`,
      )
    }
  }
  if (selRaw['baselineRef'] === undefined) {
    throw harnessError(
      'HARNESS_SELECTION_REQUIRED',
      'new-format runs require baselineRef; codeProtocolPin is not a state ref',
    )
  }

  const selection = input.store.select(
    {
      baselineRef: input.selection.baselineRef,
      ...(input.selection.overlayRef !== undefined
        ? { overlayRef: input.selection.overlayRef }
        : {}),
    },
    availableCatalogRefs,
  )

  const resolved = input.store.resolve(
    selection,
    input.codeProtocolPin,
    availableCatalogRefs,
  )

  return freezeResolved(resolved, 'recorded')
}

/**
 * New-format replay: reconstruct solely from recorded HarnessPinsV1.
 * Does not consult LegacySelectionRegistry / manifest / defaults / latest.
 */
export function replayFromRecordedPins(input: {
  store: HarnessStateStore
  pins: HarnessPinsV1
  availableCatalogRefs: readonly CatalogCardRef[]
}): FreezeResult {
  const pins = normalizePinsV1(input.pins)
  const availableCatalogRefs = freezeAvailableCatalogRefs(input.availableCatalogRefs)

  const selection = input.store.select(
    {
      baselineRef: pins.baselineRef,
      ...(pins.overlayRef !== undefined ? { overlayRef: pins.overlayRef } : {}),
    },
    availableCatalogRefs,
  )
  const resolved = input.store.resolve(
    selection,
    pins.codeProtocolPin,
    availableCatalogRefs,
  )

  assertResolvedMatchesRecorded(resolved, pins)

  return freezeResolved(resolved, 'recorded')
}

/**
 * Legacy artifact replay: look up global registry by recorded codeProtocolPin,
 * resolve empty-overlay baseline, mark evidence selectionSource=legacy-registry.
 */
export function replayFromLegacyPin(input: {
  store: HarnessStateStore
  legacyRegistry: LegacySelectionRegistryStore
  codeProtocolPin: string
  availableCatalogRefs: readonly CatalogCardRef[]
  /** Reject if caller tries to force a different baseline/overlay. */
  attemptedSelection?: { baselineRef?: HarnessStateRef; overlayRef?: HarnessStateRef }
}): FreezeResult {
  const entry = input.legacyRegistry.resolveLegacySelection(input.codeProtocolPin)
  if (input.attemptedSelection) {
    assertLegacyReplaySelectionOnly(
      input.codeProtocolPin,
      input.attemptedSelection,
      entry,
    )
  }
  const availableCatalogRefs = freezeAvailableCatalogRefs(input.availableCatalogRefs)
  const selection = input.store.select(
    { baselineRef: entry.baselineRef },
    availableCatalogRefs,
  )
  const resolved = input.store.resolve(
    selection,
    input.codeProtocolPin,
    availableCatalogRefs,
  )
  return freezeResolved(resolved, 'legacy-registry', {
    registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
  })
}

/**
 * Child runs inherit the parent frozen slice verbatim.
 * Any drift in selection or resolved hash is HARNESS_CHILD_SELECTION_DRIFT.
 */
export function inheritFrozenHarnessSlice(input: {
  parent: FrozenHarnessSlice
  childRecorded: {
    selection: FrozenHarnessSlice['selection']
    harnessContentHash: string
    schemaVersion: FrozenHarnessSlice['schemaVersion']
    catalogCards: FrozenHarnessSlice['catalogCards']
    compatibilityDecision: FrozenHarnessSlice['compatibilityDecision']
    codeProtocolPin: string
  }
}): FrozenHarnessSlice {
  const parent = input.parent
  const child = input.childRecorded
  const selectionMatches =
    refsEqual(parent.selection.baselineRef, child.selection.baselineRef) &&
    ((parent.selection.overlayRef === undefined &&
      child.selection.overlayRef === undefined) ||
      (parent.selection.overlayRef !== undefined &&
        child.selection.overlayRef !== undefined &&
        refsEqual(parent.selection.overlayRef, child.selection.overlayRef)))

  const cardsMatch =
    parent.catalogCards.length === child.catalogCards.length &&
    parent.catalogCards.every(
      (c, i) =>
        c.id === child.catalogCards[i]?.id &&
        c.version === child.catalogCards[i]?.version,
    )

  if (
    !selectionMatches ||
    parent.harnessContentHash !== child.harnessContentHash ||
    parent.schemaVersion !== child.schemaVersion ||
    parent.codeProtocolPin !== child.codeProtocolPin ||
    !cardsMatch ||
    parent.compatibilityDecision.documentAcceptsCodeProtocolPin !==
      child.compatibilityDecision.documentAcceptsCodeProtocolPin ||
    parent.compatibilityDecision.catalogResolved !==
      child.compatibilityDecision.catalogResolved
  ) {
    throw harnessError(
      'HARNESS_CHILD_SELECTION_DRIFT',
      'child harness slice differs from parent frozen slice',
      { parent, child },
    )
  }
  return deepFreezeJson(cloneJson(parent))
}

export function toHarnessPinsV1(resolved: ResolvedHarness): HarnessPinsV1 {
  const pins: HarnessPinsV1 = {
    format: 'harness/v1',
    codeProtocolPin: resolved.codeProtocolPin,
    baselineRef: resolved.selection.baselineRef,
    harnessContentHash: resolved.harnessContentHash,
    schemaVersion: 'helix.harness/v1',
    catalogCards: resolved.catalogCards.map((c) => ({ id: c.id, version: c.version })),
    compatibilityDecision: {
      documentAcceptsCodeProtocolPin: true,
      catalogResolved: true,
    },
  }
  if (resolved.selection.overlayRef !== undefined) {
    pins.overlayRef = resolved.selection.overlayRef
  }
  return deepFreezeJson(cloneJson(pins))
}

function freezeResolved(
  resolved: ResolvedHarness,
  selectionSource: HarnessEvidenceSlice['selectionSource'],
  extra?: { registryIdentity?: HarnessEvidenceSlice['registryIdentity'] },
): FreezeResult {
  // Integrity: hash must be recomputed from store payload, never trusted from outside.
  const recomputed = harnessContentHash(resolved.document)
  if (recomputed !== resolved.harnessContentHash) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      'resolved harnessContentHash does not match canonical document',
      { expected: recomputed, got: resolved.harnessContentHash },
    )
  }
  const availableCheck = assertCardsAvailable(
    resolved.catalogCards,
    resolved.availableCatalogRefs,
    'freeze.catalogCards',
  )
  if (!availableCheck.ok) {
    throw harnessError(availableCheck.code, availableCheck.message, availableCheck.details)
  }

  const frozen: FrozenHarnessSlice = {
    selection: {
      baselineRef: resolved.selection.baselineRef,
      ...(resolved.selection.overlayRef !== undefined
        ? { overlayRef: resolved.selection.overlayRef }
        : {}),
    },
    document: resolved.document,
    harnessContentHash: resolved.harnessContentHash,
    schemaVersion: 'helix.harness/v1',
    catalogCards: resolved.catalogCards.map((c) => ({ id: c.id, version: c.version })),
    compatibilityDecision: {
      documentAcceptsCodeProtocolPin: true,
      catalogResolved: true,
    },
    codeProtocolPin: resolved.codeProtocolPin,
    availableCatalogRefs: resolved.availableCatalogRefs.map((c) => ({
      id: c.id,
      version: c.version,
    })),
  }

  const pins = toHarnessPinsV1(resolved)
  const evidence: HarnessEvidenceSlice = {
    ...pins,
    selectionSource,
    ...(extra?.registryIdentity !== undefined
      ? { registryIdentity: extra.registryIdentity }
      : {}),
  }

  return deepFreezeJson(
    cloneJson({
      frozen,
      pins,
      evidence,
      contextHarness: pins,
    }),
  )
}

function normalizePinsV1(raw: unknown): HarnessPinsV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw harnessError('HARNESS_SELECTION_REQUIRED', 'recorded pins must be an object')
  }
  const p = raw as Record<string, unknown>
  if (p['format'] !== 'harness/v1') {
    throw harnessError('HARNESS_SELECTION_REQUIRED', 'recorded pins.format must be harness/v1')
  }
  if (p['schemaVersion'] !== 'helix.harness/v1') {
    throw harnessError(
      'HARNESS_SCHEMA_INVALID',
      'recorded pins.schemaVersion must be helix.harness/v1',
    )
  }
  if (typeof p['codeProtocolPin'] !== 'string' || p['codeProtocolPin'].length === 0) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      'recorded pins.codeProtocolPin missing',
    )
  }
  if (typeof p['harnessContentHash'] !== 'string' || p['harnessContentHash'].length !== 64) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      'recorded pins.harnessContentHash invalid',
    )
  }
  const baselineRef = requireHarnessStateRef(p['baselineRef'], 'pins.baselineRef')
  if (baselineRef.kind !== 'baseline') {
    throw harnessError('HARNESS_REF_INVALID', 'pins.baselineRef.kind must be baseline')
  }
  let overlayRef: HarnessStateRef | undefined
  if (p['overlayRef'] !== undefined) {
    overlayRef = requireHarnessStateRef(p['overlayRef'], 'pins.overlayRef')
    if (overlayRef.kind !== 'overlay') {
      throw harnessError('HARNESS_REF_INVALID', 'pins.overlayRef.kind must be overlay')
    }
  }
  if (!Array.isArray(p['catalogCards'])) {
    throw harnessError('HARNESS_CATALOG_UNRESOLVED', 'pins.catalogCards must be an array')
  }
  const catalogCards = p['catalogCards'].map((c, i) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw harnessError(
        'HARNESS_CATALOG_UNRESOLVED',
        `pins.catalogCards[${i}] invalid`,
      )
    }
    const card = c as Record<string, unknown>
    if (typeof card['id'] !== 'string' || typeof card['version'] !== 'string') {
      throw harnessError(
        'HARNESS_CATALOG_UNRESOLVED',
        `pins.catalogCards[${i}] requires id and version`,
      )
    }
    return { id: card['id'], version: card['version'] }
  })
  const decision = p['compatibilityDecision']
  if (
    decision === null ||
    typeof decision !== 'object' ||
    Array.isArray(decision) ||
    (decision as Record<string, unknown>)['documentAcceptsCodeProtocolPin'] !== true ||
    (decision as Record<string, unknown>)['catalogResolved'] !== true
  ) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      'pins.compatibilityDecision invalid',
    )
  }
  const pins: HarnessPinsV1 = {
    format: 'harness/v1',
    codeProtocolPin: p['codeProtocolPin'],
    baselineRef,
    harnessContentHash: p['harnessContentHash'],
    schemaVersion: 'helix.harness/v1',
    catalogCards,
    compatibilityDecision: {
      documentAcceptsCodeProtocolPin: true,
      catalogResolved: true,
    },
  }
  if (overlayRef !== undefined) pins.overlayRef = overlayRef
  return pins
}

function assertResolvedMatchesRecorded(
  resolved: ResolvedHarness,
  pins: HarnessPinsV1,
): void {
  if (resolved.harnessContentHash !== pins.harnessContentHash) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      'replay resolved harnessContentHash does not match recorded pins',
      {
        resolved: resolved.harnessContentHash,
        recorded: pins.harnessContentHash,
      },
    )
  }
  if (resolved.schemaVersion !== pins.schemaVersion) {
    throw harnessError(
      'HARNESS_SCHEMA_INVALID',
      'replay schemaVersion mismatch',
    )
  }
  if (resolved.codeProtocolPin !== pins.codeProtocolPin) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      'replay codeProtocolPin mismatch',
    )
  }
  if (!refsEqual(resolved.selection.baselineRef, pins.baselineRef)) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      'replay baselineRef mismatch',
    )
  }
  const resolvedOverlay = resolved.selection.overlayRef
  const pinsOverlay = pins.overlayRef
  if (
    (resolvedOverlay === undefined) !== (pinsOverlay === undefined) ||
    (resolvedOverlay !== undefined &&
      pinsOverlay !== undefined &&
      !refsEqual(resolvedOverlay, pinsOverlay))
  ) {
    throw harnessError('HARNESS_REF_INVALID', 'replay overlayRef mismatch')
  }
  if (resolved.catalogCards.length !== pins.catalogCards.length) {
    throw harnessError('HARNESS_CATALOG_UNRESOLVED', 'replay catalogCards length mismatch')
  }
  for (let i = 0; i < resolved.catalogCards.length; i += 1) {
    const a = resolved.catalogCards[i]!
    const b = pins.catalogCards[i]!
    if (a.id !== b.id || a.version !== b.version) {
      throw harnessError(
        'HARNESS_CATALOG_UNRESOLVED',
        'replay catalogCards mismatch',
        { index: i, resolved: a, recorded: b },
      )
    }
  }
}
