/**
 * Host control-plane binding for runHarness.
 *
 * Host assembly (assemble / reconstruct) binds the exact control-plane text to
 * the frozen harness object identity. runHarness rejects any text that is not
 * the Host-bound payload for that frozen slice — even when pins match and the
 * caller supplies a self-consistent content hash.
 */

import { createHash } from 'node:crypto'
import { harnessError } from './errors.js'
import { assertFrozenHarnessMatchesPins } from './record.js'
import type { FrozenHarnessSlice, HarnessPinsV1 } from './types.js'

const controlPlaneBindings = new WeakMap<object, string>()

export function controlPlaneTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Bind rendered control-plane text to a frozen harness slice (write-once).
 * First bind records the Host payload hash. Re-binding the same text is
 * idempotent; a different text/hash is rejected before any LLM call.
 * Returns the content hash that callers must thread into runHarness.
 */
export function bindControlPlaneText(
  frozen: FrozenHarnessSlice,
  controlPlaneText: string,
): string {
  if (typeof controlPlaneText !== 'string' || controlPlaneText.length === 0) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      'controlPlaneText must be a non-empty string from Host render',
    )
  }
  const hash = controlPlaneTextHash(controlPlaneText)
  const key = frozen as object
  const existing = controlPlaneBindings.get(key)
  if (existing !== undefined) {
    if (existing === hash) {
      return existing
    }
    throw harnessError(
      'HARNESS_REF_INVALID',
      'control-plane binding is write-once for a frozen harness slice; already bound to a different payload',
    )
  }
  controlPlaneBindings.set(key, hash)
  return hash
}

/**
 * Fail-closed gate: control-plane text must be the Host-bound payload for this
 * frozen slice, and the provided content hash must match that binding.
 */
export function assertControlPlaneBinding(input: {
  frozen: FrozenHarnessSlice
  pins: HarnessPinsV1
  controlPlaneText: string
  controlPlaneContentHash: unknown
  label?: string
}): void {
  const label = input.label ?? 'runHarness.control-plane'
  assertFrozenHarnessMatchesPins(input.frozen, input.pins, `${label}.frozen-vs-pins`)

  if (typeof input.controlPlaneText !== 'string' || input.controlPlaneText.length === 0) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `controlPlaneText must be a non-empty Host-bound string (${label})`,
    )
  }
  if (
    typeof input.controlPlaneContentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.controlPlaneContentHash)
  ) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `controlPlaneContentHash binding missing or invalid (${label})`,
    )
  }

  const actualHash = controlPlaneTextHash(input.controlPlaneText)
  if (actualHash !== input.controlPlaneContentHash) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `controlPlaneText does not match controlPlaneContentHash binding (${label})`,
    )
  }

  const bound = controlPlaneBindings.get(input.frozen as object)
  if (bound === undefined) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `control-plane binding missing from Host assembly (${label})`,
    )
  }
  if (bound !== actualHash) {
    throw harnessError(
      'HARNESS_REF_INVALID',
      `controlPlaneText is not the Host-bound control plane for this frozen slice (${label})`,
    )
  }
}
