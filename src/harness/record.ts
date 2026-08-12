/**
 * Bridge frozen harness slice into Context / RunPins.harnessState / evidence shapes.
 */

import { cloneJson, deepFreezeJson } from './canonical.js'
import { harnessError } from './errors.js'
import { refsEqual } from './document.js'
import type {
  FrozenHarnessSlice,
  HarnessEvidenceSlice,
  HarnessPinsV1,
} from './types.js'
import type { FreezeResult } from './host.js'

export type HarnessRecordTriple = {
  context: { runtime: { harness: HarnessPinsV1 } }
  pins: { harness: HarnessPinsV1 }
  evidence: { harness: HarnessEvidenceSlice }
}

/**
 * Materialize the three read-back locations required by L2 §10.1.
 * Same-named fields must be item-equal across Context, pins, and evidence.
 */
export function materializeHarnessRecord(freeze: FreezeResult): HarnessRecordTriple {
  const pinsHarness = deepFreezeJson(cloneJson(freeze.pins))
  const contextHarness = deepFreezeJson(cloneJson(freeze.contextHarness))
  const evidenceHarness = deepFreezeJson(cloneJson(freeze.evidence))
  assertHarnessSlicesEqual(pinsHarness, contextHarness, 'context')
  assertPinsEqualEvidence(pinsHarness, evidenceHarness)
  return deepFreezeJson(
    cloneJson({
      context: { runtime: { harness: contextHarness } },
      pins: { harness: pinsHarness },
      evidence: { harness: evidenceHarness },
    }),
  )
}

export function assertHarnessRecordConsistent(record: HarnessRecordTriple): void {
  assertHarnessPinsEqual(
    record.pins.harness,
    record.context.runtime.harness,
    'context',
  )
  assertPinsEqualEvidence(record.pins.harness, record.evidence.harness)
}

/**
 * Item-equal check for same-named harness pin fields (L2 §10.1).
 * Used by freeze materialization and scenario replay identity gates.
 */
export function assertHarnessPinsEqual(
  a: HarnessPinsV1,
  b: HarnessPinsV1,
  label: string,
): void {
  assertHarnessSlicesEqual(a, b, label)
}

/**
 * Fail-closed gate: FrozenHarnessSlice and RunPins.harnessState must describe
 * the same frozen selection before any model request (L2 §10.1).
 */
export function assertFrozenHarnessMatchesPins(
  frozen: FrozenHarnessSlice,
  pins: HarnessPinsV1,
  label = 'frozenHarness-vs-pins.harnessState',
): void {
  const fromFrozen: HarnessPinsV1 = {
    format: 'harness/v1',
    codeProtocolPin: frozen.codeProtocolPin,
    baselineRef: frozen.selection.baselineRef,
    harnessContentHash: frozen.harnessContentHash,
    schemaVersion: frozen.schemaVersion,
    catalogCards: frozen.catalogCards.map((c) => ({
      id: c.id,
      version: c.version,
    })),
    compatibilityDecision: frozen.compatibilityDecision,
    ...(frozen.selection.overlayRef !== undefined
      ? { overlayRef: frozen.selection.overlayRef }
      : {}),
  }
  assertHarnessSlicesEqual(pins, fromFrozen, label)
}


export function frozenSliceFromPins(
  pins: HarnessPinsV1,
  document: FrozenHarnessSlice['document'],
  availableCatalogRefs: FrozenHarnessSlice['availableCatalogRefs'],
): FrozenHarnessSlice {
  return deepFreezeJson(
    cloneJson({
      selection: {
        baselineRef: pins.baselineRef,
        ...(pins.overlayRef !== undefined ? { overlayRef: pins.overlayRef } : {}),
      },
      document,
      harnessContentHash: pins.harnessContentHash,
      schemaVersion: pins.schemaVersion,
      catalogCards: pins.catalogCards.map((c) => ({ id: c.id, version: c.version })),
      compatibilityDecision: pins.compatibilityDecision,
      codeProtocolPin: pins.codeProtocolPin,
      availableCatalogRefs: availableCatalogRefs.map((c) => ({
        id: c.id,
        version: c.version,
      })),
    }),
  )
}

function assertHarnessSlicesEqual(
  a: HarnessPinsV1,
  b: HarnessPinsV1,
  label: string,
): void {
  if (a.format !== b.format || a.schemaVersion !== b.schemaVersion) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `harness slice format/schema mismatch (${label})`,
    )
  }
  if (a.codeProtocolPin !== b.codeProtocolPin) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      `harness codeProtocolPin mismatch (${label})`,
    )
  }
  if (a.harnessContentHash !== b.harnessContentHash) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `harnessContentHash mismatch (${label})`,
    )
  }
  if (!refsEqual(a.baselineRef, b.baselineRef)) {
    throw harnessError('HARNESS_REF_INVALID', `baselineRef mismatch (${label})`)
  }
  const aOverlay = a.overlayRef
  const bOverlay = b.overlayRef
  if (
    (aOverlay === undefined) !== (bOverlay === undefined) ||
    (aOverlay !== undefined &&
      bOverlay !== undefined &&
      !refsEqual(aOverlay, bOverlay))
  ) {
    throw harnessError('HARNESS_REF_INVALID', `overlayRef mismatch (${label})`)
  }
  if (a.catalogCards.length !== b.catalogCards.length) {
    throw harnessError(
      'HARNESS_CATALOG_UNRESOLVED',
      `catalogCards length mismatch (${label})`,
    )
  }
  for (let i = 0; i < a.catalogCards.length; i += 1) {
    if (
      a.catalogCards[i]!.id !== b.catalogCards[i]!.id ||
      a.catalogCards[i]!.version !== b.catalogCards[i]!.version
    ) {
      throw harnessError(
        'HARNESS_CATALOG_UNRESOLVED',
        `catalogCards mismatch (${label})`,
        { index: i },
      )
    }
  }
  if (
    a.compatibilityDecision.documentAcceptsCodeProtocolPin !==
      b.compatibilityDecision.documentAcceptsCodeProtocolPin ||
    a.compatibilityDecision.catalogResolved !==
      b.compatibilityDecision.catalogResolved
  ) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      `compatibilityDecision mismatch (${label})`,
    )
  }
}


function assertPinsEqualEvidence(
  pins: HarnessPinsV1,
  evidence: HarnessEvidenceSlice,
): void {
  assertHarnessSlicesEqual(pins, evidence, 'evidence')
  if (
    evidence.selectionSource !== 'recorded' &&
    evidence.selectionSource !== 'legacy-registry'
  ) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      'evidence.selectionSource must be recorded|legacy-registry',
    )
  }
}
