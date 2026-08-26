/**
 * Factorio-specific overlay admission guard (Issue #22 P3, Issue #29).
 *
 * Fail-closed if a generated overlay changes the Factorio safety protocol or
 * names a fixed factory. This is a Host-side admission check, not a generic
 * harness core rule.
 */

import type { HarnessOverlay } from '../../../src/harness/index.js'
import { FACTORIO_EXPERIMENT_TASKS } from './experiment/cases.js'

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

const COORDINATE = /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/
const POSITION_CALL = /\bposition\s*\(\s*-?\d/i
const WALKTHROUGH = /exact action sequence|previously passed verification|default p3 map/i

function overlayText(overlay: HarnessOverlay): string {
  return [
    overlay.changes.taskNarrativeTemplate ?? '',
    ...(overlay.changes.protocolRules ?? []),
    ...(overlay.changes.stopConditions ?? []),
    overlay.changes.systemInstructionTemplate ?? '',
  ].join('\n')
}

function catalogLeakTokens(): string[] {
  const tokens = new Set<string>()
  for (const [inputRef, task] of Object.entries(FACTORIO_EXPERIMENT_TASKS)) {
    tokens.add(inputRef.toLowerCase())
    tokens.add(task.taskId.toLowerCase())
    tokens.add(task.taskDigest.toLowerCase())
    const product = task.taskId.replace(/_throughput$/, '')
    if (product.includes('_')) tokens.add(product)
    const kebab = product.replaceAll('_', '-')
    const spaced = product.replaceAll('_', ' ')
    if (kebab.includes('-')) tokens.add(kebab)
    if (spaced.includes(' ')) tokens.add(spaced)
    const camel = product
      .split('_')
      .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join('')
    tokens.add(`prototype.${camel}`.toLowerCase())
    tokens.add(`resource.${camel}`.toLowerCase())
  }
  return [...tokens]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsCatalogToken(haystack: string, token: string): boolean {
  const compact = token.includes('-') || token.includes(' ') || token.includes('.') || token.includes('_')
  if (compact || token.length > 12) return haystack.includes(token)
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(haystack)
}

/**
 * Generated task narratives must stay methodological. Coordinates, catalog
 * products, and source-run walkthroughs are holdout contamination.
 */
export function validateFactorioOverlayTaskAgnostic(overlay: HarnessOverlay): string | undefined {
  const text = overlayText(overlay)
  const haystack = text.toLowerCase()
  if (COORDINATE.test(text) || POSITION_CALL.test(text)) {
    return 'generated overlay names a map coordinate'
  }
  if (WALKTHROUGH.test(text)) {
    return 'generated overlay names a source-run-specific factory layout'
  }
  for (const token of catalogLeakTokens()) {
    if (token.length > 0 && containsCatalogToken(haystack, token)) {
      return 'generated overlay names a fixed target product or recipe'
    }
  }
  return undefined
}
