/**
 * Factorio-specific overlay admission guard (Issue #22 P3).
 *
 * Fail-closed if a generated overlay drops the Factorio no-import / first-reset
 * protocol. This is a Host-side admission check, not a generic harness core rule.
 */

import type { HarnessOverlay } from '../../../src/harness/index.js'

/**
 * Required Factorio protocol rules that must not be dropped by any overlay.
 * These protect the first-reset and no-import contracts.
 */
export const FACTORIO_REQUIRED_PROTOCOL_FRAGMENTS = [
  'factorio.reset',
  'First environment effect',
  'import',
] as const

/**
 * Validate that a generated overlay does not drop critical Factorio protocol rules.
 * Returns an error message if validation fails, undefined if passes.
 */
export function validateFactorioOverlayProtocol(overlay: HarnessOverlay): string | undefined {
  // Only check if overlay modifies protocolRules
  if (overlay.changes.protocolRules === undefined) {
    return undefined
  }

  const newRules = overlay.changes.protocolRules

  // Specific validation: must have a rule about reset being first
  // Accept variations like "first", "First", "initial", etc. combined with "reset"
  const hasResetFirstRule = newRules.some((rule) => {
    const lower = rule.toLowerCase()
    return (
      (lower.includes('first') || lower.includes('initial')) &&
      (lower.includes('reset') || lower.includes('factorio.reset'))
    )
  })
  if (!hasResetFirstRule) {
    return 'generated overlay drops first-reset protocol rule'
  }

  // Specific validation: must have a rule forbidding imports
  // Require strong prohibitive language, reject weak suggestions like "prefer not"
  const hasNoImportRule = newRules.some((rule) => {
    const lower = rule.toLowerCase()
    // Reject weak suggestions
    if (lower.includes('prefer') || lower.includes('should')) {
      return false
    }
    // Accept strong prohibitions
    return (
      lower.includes('import') &&
      (lower.includes('never') ||
       lower.includes('forbidden') ||
       lower.includes('must not') ||
       lower.includes('do not'))
    )
  })
  if (!hasNoImportRule) {
    return 'generated overlay drops no-import protocol rule'
  }

  return undefined
}
