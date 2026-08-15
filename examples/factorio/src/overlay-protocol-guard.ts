/**
 * Factorio-specific overlay admission guard (Issue #22 P3).
 *
 * Fail-closed if a generated overlay changes the Factorio safety protocol. This
 * is a Host-side admission check, not a generic harness core rule.
 */

import type { HarnessOverlay } from '../../../src/harness/index.js'

/**
 * Required protocol rules are compared exactly, rather than heuristically
 * matching model-authored language. These rules are rendered after the task
 * narrative, while the complete protocol remains in the immutable system
 * instruction.
 */
export const FACTORIO_IMMUTABLE_PROTOCOL_RULES = [
  'First environment effect must call factorio.reset() exactly once.',
  'Never use import statements in outer cells or Factorio action strings.',
] as const

/**
 * Validate that a generated overlay does not drop critical Factorio protocol rules.
 * Returns an error message if validation fails, undefined if passes.
 */
export function validateFactorioOverlayProtocol(overlay: HarnessOverlay): string | undefined {
  if (overlay.changes.systemInstructionTemplate !== undefined) {
    return 'generated overlay changes immutable Factorio system instruction'
  }

  const newRules = overlay.changes.protocolRules
  if (newRules === undefined) return undefined

  for (const required of FACTORIO_IMMUTABLE_PROTOCOL_RULES) {
    if (!newRules.includes(required)) {
      return `generated overlay drops immutable protocol rule: ${required}`
    }
  }

  return undefined
}
