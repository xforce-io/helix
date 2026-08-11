import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  catalogError,
  validationFail,
  validationOk,
  type CatalogValidationResult,
} from './errors.js'
import {
  channelMetaKey,
  normalizeCard,
  normativePayloadKey,
  validateProductionAdmission,
} from './validate.js'
import type { CapabilityCard } from './types.js'

type CardIndexEntry = {
  card: CapabilityCard
  normativeKey: string
  channelKey: string
}

export class CapabilityCatalogRegistry {
  /** Nested map avoids id/version '@' collision (id='a@b',version='c' vs id='a',version='b@c'). */
  private readonly byId = new Map<string, Map<string, CardIndexEntry>>()
  private loaded = false

  /** Register a production card with immutability gates. */
  registerCard(card: CapabilityCard): CatalogValidationResult {
    const admission = validateProductionAdmission(card)
    if (!admission.ok) return admission

    // Snapshot before any store/freeze so caller-owned graphs cannot alias in.
    const normalized = deepFreezeValue(structuredClone(normalizeCard(card)))
    const nextNorm = normativePayloadKey(normalized)
    const nextChannel = channelMetaKey(normalized)

    let versions = this.byId.get(normalized.id)
    if (!versions) {
      versions = new Map()
      this.byId.set(normalized.id, versions)
    }

    const existing = versions.get(normalized.version)
    if (existing) {
      if (existing.normativeKey !== nextNorm) {
        return validationFail(
          'CATALOG_IMMUTABLE_VERSION_DRIFT',
          `normative payload drift for ${normalized.id}@${normalized.version}; bump version`,
          { id: normalized.id, version: normalized.version },
        )
      }
      if (existing.channelKey !== nextChannel) {
        return validationFail(
          'CATALOG_CHANNEL_META_DRIFT',
          `channel metadata drift for ${normalized.id}@${normalized.version}; bump version or change path`,
          { id: normalized.id, version: normalized.version },
        )
      }
      // Fully identical — idempotent OK
      return validationOk()
    }

    versions.set(normalized.version, {
      card: normalized,
      normativeKey: nextNorm,
      channelKey: nextChannel,
    })
    return validationOk()
  }

  getProductionCard(id: string, version: string): CapabilityCard {
    if (!id || !version) {
      throw catalogError(
        'CATALOG_REF_IDENTITY_INVALID',
        'card reference requires non-empty id and version',
        { id, version },
      )
    }
    this.ensureLoaded()
    const card = this.byId.get(id)?.get(version)?.card
    if (!card) {
      throw catalogError(
        'CATALOG_REF_UNKNOWN',
        `unknown production card ${id}@${version}`,
        { id, version },
      )
    }
    return card
  }

  listProductionCards(): CapabilityCard[] {
    this.ensureLoaded()
    const out: CapabilityCard[] = []
    for (const versions of this.byId.values()) {
      for (const entry of versions.values()) {
        out.push(entry.card)
      }
    }
    return out.sort((a, b) => {
      const idCmp = a.id.localeCompare(b.id)
      if (idCmp !== 0) return idCmp
      return a.version.localeCompare(b.version)
    })
  }

  hasProductionCard(id: string, version: string): boolean {
    this.ensureLoaded()
    return this.byId.get(id)?.has(version) === true
  }

  /** Load all JSON cards from the packaged production cards directory. */
  loadProductionCardsDir(dirPath?: string): void {
    const dir = dirPath ?? defaultCardsDir()
    const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    for (const name of names) {
      const raw = readFileSync(join(dir, name), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch (error) {
        throw catalogError(
          'CATALOG_SCHEMA_INVALID',
          `invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const result = this.registerCard(parsed as CapabilityCard)
      if (!result.ok) {
        throw catalogError(
          result.code,
          `failed to register ${name}: ${result.message}`,
          result.details,
        )
      }
    }
    this.loaded = true
  }

  /** Test helper: empty registry without loading packaged cards. */
  static empty(): CapabilityCatalogRegistry {
    const reg = new CapabilityCatalogRegistry()
    reg.loaded = true
    return reg
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loadProductionCardsDir()
    }
  }
}

/** Recursively freeze plain objects/arrays; primitives pass through. */
function deepFreezeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = deepFreezeValue(value[i])
    }
  } else {
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      obj[key] = deepFreezeValue(obj[key])
    }
  }
  return Object.freeze(value)
}

function defaultCardsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, 'cards')
}

/** Process-wide default production registry (lazy-loaded). */
let defaultRegistry: CapabilityCatalogRegistry | undefined

export function getDefaultRegistry(): CapabilityCatalogRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new CapabilityCatalogRegistry()
  }
  return defaultRegistry
}

/** Test-only: replace default registry. */
export function setDefaultRegistryForTests(
  registry: CapabilityCatalogRegistry | undefined,
): void {
  defaultRegistry = registry
}

export function getProductionCard(id: string, version: string): CapabilityCard {
  return getDefaultRegistry().getProductionCard(id, version)
}

export function listProductionCards(): CapabilityCard[] {
  return getDefaultRegistry().listProductionCards()
}

export function registerCard(card: CapabilityCard): CatalogValidationResult {
  return getDefaultRegistry().registerCard(card)
}
