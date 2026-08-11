import { catalogError, CatalogError } from './errors.js'
import { getDefaultRegistry } from './registry.js'
import type { CapabilityCard, CardRef } from './types.js'

export const CATALOG_BINDING_SET_MAPPING_VERSION = '1' as const

export type RuntimeCapabilitySetId =
  | 'helix.runtime.recursive-model/v1'
  | 'helix.runtime.session-async/v1'
  | 'helix.runtime.core/v1'

export const RUNTIME_CAPABILITY_SETS: Record<
  RuntimeCapabilitySetId,
  readonly CardRef[]
> = {
  'helix.runtime.recursive-model/v1': [
    { id: 'helix.models', version: '1.0.0' },
  ],
  'helix.runtime.session-async/v1': [
    { id: 'helix.session', version: '1.0.0' },
  ],
  'helix.runtime.core/v1': [
    { id: 'helix.models', version: '1.0.0' },
    { id: 'helix.session', version: '1.0.0' },
  ],
}

export interface CapabilityCardResolved {
  ref: CardRef
  card: CapabilityCard
}

export function isRuntimeCapabilitySetId(
  value: string,
): value is RuntimeCapabilitySetId {
  return Object.prototype.hasOwnProperty.call(RUNTIME_CAPABILITY_SETS, value)
}

/**
 * Resolve an abstract runtime capability set to CardRef[].
 * Unknown set id → CATALOG_BINDING_SET_UNRESOLVABLE.
 */
export function resolveCapabilitySet(setId: string): CardRef[] {
  if (!isRuntimeCapabilitySetId(setId)) {
    throw catalogError(
      'CATALOG_BINDING_SET_UNRESOLVABLE',
      `unknown runtime capability set: ${setId}`,
      { setId },
    )
  }
  return RUNTIME_CAPABILITY_SETS[setId].map((ref) => ({ ...ref }))
}

/**
 * Resolve CardRef[] against the production catalog (fail-closed).
 * Missing id/version → CATALOG_REF_IDENTITY_INVALID.
 * Unknown production card → CATALOG_REF_NOT_IN_PRODUCTION.
 */
export function resolveCardRefs(
  refs: readonly CardRef[],
): CapabilityCardResolved[] {
  const registry = getDefaultRegistry()
  const out: CapabilityCardResolved[] = []
  for (const ref of refs) {
    if (
      ref == null ||
      typeof ref !== 'object' ||
      typeof ref.id !== 'string' ||
      ref.id.length === 0 ||
      typeof ref.version !== 'string' ||
      ref.version.length === 0
    ) {
      throw catalogError(
        'CATALOG_REF_IDENTITY_INVALID',
        'card reference requires non-empty id and version',
        { ref },
      )
    }
    try {
      const card = registry.getProductionCard(ref.id, ref.version)
      out.push({ ref: { id: ref.id, version: ref.version }, card })
    } catch (error) {
      if (error instanceof CatalogError && error.code === 'CATALOG_REF_UNKNOWN') {
        throw catalogError(
          'CATALOG_REF_NOT_IN_PRODUCTION',
          `card ${ref.id}@${ref.version} is not in the production catalog`,
          { id: ref.id, version: ref.version },
        )
      }
      throw error
    }
  }
  return out
}
