import { catalogError } from './errors.js'
import type { EffectClass, SurfaceEntry } from './types.js'

/**
 * Default Host effect-slot occupancy for each effectClass.
 * admin has no default — entry MUST declare occupiesHostEffectSlot explicitly.
 */
export function defaultOccupies(
  effectClass: EffectClass,
): boolean | 'explicit-required' {
  switch (effectClass) {
    case 'observe':
      return false
    case 'commit':
    case 'env_effect':
    case 'model_effect':
    case 'spawn':
    case 'wait_external':
      return true
    case 'admin':
      return 'explicit-required'
  }
}

/**
 * Resolve effective occupiesHostEffectSlot for a surface entry.
 * Throws CatalogError with CATALOG_REJECT_OCCUPANCY (B9) on conflict / undeclared admin.
 */
export function resolveOccupies(entry: SurfaceEntry): boolean {
  const d = defaultOccupies(entry.effectClass)
  if (d === 'explicit-required') {
    if (typeof entry.occupiesHostEffectSlot !== 'boolean') {
      throw catalogError(
        'CATALOG_REJECT_OCCUPANCY',
        `admin entry "${entry.name}" requires explicit occupiesHostEffectSlot`,
        { name: entry.name },
      )
    }
    return entry.occupiesHostEffectSlot
  }
  if (
    entry.occupiesHostEffectSlot !== undefined &&
    entry.occupiesHostEffectSlot !== d
  ) {
    throw catalogError(
      'CATALOG_REJECT_OCCUPANCY',
      `entry "${entry.name}" occupiesHostEffectSlot=${String(entry.occupiesHostEffectSlot)} conflicts with default ${String(d)} for ${entry.effectClass}`,
      { name: entry.name, effectClass: entry.effectClass, default: d },
    )
  }
  return d
}

/** Non-throwing occupancy check for validators. */
export function checkOccupancy(
  entry: SurfaceEntry,
): { ok: true; occupies: boolean } | { ok: false; message: string } {
  try {
    return { ok: true, occupies: resolveOccupies(entry) }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'occupancy check failed'
    return { ok: false, message }
  }
}
