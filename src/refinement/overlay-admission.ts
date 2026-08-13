/**
 * Candidate-overlay admission primitive (Issue #13).
 *
 * This is intentionally not a CLI/import path: its caller must already have
 * proved that payloadText came from the single pinned milkie generation run.
 * It only preserves the #10 raw-text → validate → canonicalize identity chain
 * before an RCS transaction persists the ordinary overlay and Candidate link.
 */

import {
  harnessCanonicalBytes,
  harnessCanonicalBytesAlt,
  parseHarnessJsonText,
  parseHarnessJsonTextAlt,
  refsEqual,
  requireHarnessOverlay,
  sha256HexOfBytes,
  type HarnessOverlay,
  type HarnessStateRef,
} from '../harness/index.js'
import { RefinementError, refinementError } from './errors.js'

export type AdmittedOverlayPayload = {
  /** #10-validated immutable payload; never an inline Candidate artifact. */
  overlay: HarnessOverlay
  /** Exact #10 canonical UTF-8 payload bytes used for contentHash. */
  canonicalBytes: Buffer
  /** sha256(canonicalBytes), equal to the eventual ordinary overlay contentHash. */
  payloadHash: string
}

/**
 * Validate a generation-run overlay payload from raw JSON text.
 *
 * Both #10 parsers/canonicalizers must agree. Any parse, schema, base-binding,
 * or canonicalization failure is deliberately collapsed to the refinement
 * candidate boundary; callers must perform no durable write after failure.
 */
export function admitGeneratedOverlayPayload(input: {
  payloadText: string
  baseBaselineRef: HarnessStateRef
}): AdmittedOverlayPayload {
  try {
    const primary = parseHarnessJsonText(input.payloadText)
    const alternate = parseHarnessJsonTextAlt(input.payloadText)
    const overlay = requireHarnessOverlay(primary.value)
    const alternateOverlay = requireHarnessOverlay(alternate.value)

    if (!refsEqual(overlay.baseBaselineRef, input.baseBaselineRef)) {
      throw refinementError(
        'REFINEMENT_CANDIDATE_INVALID',
        'candidate overlay baseBaselineRef does not match proposal baseline',
        { expected: input.baseBaselineRef, got: overlay.baseBaselineRef },
      )
    }
    if (!refsEqual(overlay.baseBaselineRef, alternateOverlay.baseBaselineRef)) {
      throw refinementError(
        'REFINEMENT_CANDIDATE_INVALID',
        'independent #10 overlay parsers disagree on baseBaselineRef',
      )
    }

    const canonicalPayload = {
      schemaVersion: overlay.schemaVersion,
      baseBaselineRef: overlay.baseBaselineRef,
      changes: overlay.changes,
    }
    const canonicalBytes = harnessCanonicalBytes(canonicalPayload)
    const alternateBytes = harnessCanonicalBytesAlt({
      schemaVersion: alternateOverlay.schemaVersion,
      baseBaselineRef: alternateOverlay.baseBaselineRef,
      changes: alternateOverlay.changes,
    })
    if (!canonicalBytes.equals(alternateBytes)) {
      throw refinementError(
        'REFINEMENT_CANDIDATE_INVALID',
        'independent #10 overlay canonicalizers disagree',
      )
    }

    return Object.freeze({
      overlay,
      canonicalBytes: Buffer.from(canonicalBytes),
      payloadHash: sha256HexOfBytes(canonicalBytes),
    })
  } catch (error) {
    if (error instanceof RefinementError) throw error
    throw refinementError(
      'REFINEMENT_CANDIDATE_INVALID',
      'candidate payload is not a valid #10 HarnessOverlay JSON text',
      error instanceof Error ? { cause: error.message } : undefined,
    )
  }
}
