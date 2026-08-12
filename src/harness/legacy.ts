/**
 * Global append-only LegacySelectionRegistry and immutable manifest provenance view.
 * Optional durable root keeps registered entries across process boundaries.
 */

import { cloneJson, deepFreezeJson } from './canonical.js'
import { requireHarnessStateRef, refsEqual } from './document.js'
import { harnessError } from './errors.js'
import {
  atomicWriteJsonSync,
  durableLegacyRegistryLockPath,
  durableLegacyRegistryPath,
  readDurableJsonSync,
  withDurableLockSync,
} from './persist.js'
import type { HarnessStateStore } from './store.js'
import type {
  HarnessStateRef,
  LegacySelectionManifest,
  LegacySelectionRegistry,
  LegacySelectionRegistryEntry,
  LegacySelectionRegistryIdentity,
} from './types.js'


export const LEGACY_SELECTION_REGISTRY_IDENTITY: LegacySelectionRegistryIdentity = {
  id: 'helix.harness-legacy-selection-registry',
  schemaVersion: 'v1',
}

function identityEqual(
  a: LegacySelectionRegistryIdentity,
  b: LegacySelectionRegistryIdentity,
): boolean {
  return a.id === b.id && a.schemaVersion === b.schemaVersion
}

export class LegacySelectionRegistryStore {
  private readonly entries = new Map<string, LegacySelectionRegistryEntry>()
  private readonly harnessStore: HarnessStateStore
  private readonly rootDir: string | undefined
  private readonly durableWriter:
    | ((targetPath: string, value: unknown) => void)
    | undefined

  constructor(
    harnessStore: HarnessStateStore,
    options: {
      rootDir?: string
      /** Test seam: override durable registry write. */
      durableWriter?: (targetPath: string, value: unknown) => void
    } = {},
  ) {
    this.harnessStore = harnessStore
    this.rootDir =
      typeof options.rootDir === 'string' && options.rootDir.length > 0
        ? options.rootDir
        : harnessStore.durableRootDir
    this.durableWriter = options.durableWriter
    if (this.rootDir !== undefined) {
      this.hydrateFromDisk(this.rootDir)
    }
  }


  /**
   * Migration-time registration. First successful registration permanently
   * determines the unique selection for a codeProtocolPin. Identical re-submit
   * returns the existing entry; conflicting re-register is rejected.
   */
  registerLegacySelection(
    entryInput: unknown,
  ): LegacySelectionRegistryEntry {
    return this.withRegisterLock(() => {
      this.reloadFromDurableRoot()
      return this.registerLegacySelectionUnlocked(entryInput, true)
    })
  }

  private registerLegacySelectionUnlocked(
    entryInput: unknown,
    persist: boolean,
  ): LegacySelectionRegistryEntry {
    if (entryInput === null || typeof entryInput !== 'object' || Array.isArray(entryInput)) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy selection entry must be an object',
      )
    }
    const raw = entryInput as Record<string, unknown>
    if (!isPlainObject(raw['registryIdentity'])) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'registryIdentity is required',
      )
    }
    const identity = raw['registryIdentity'] as Record<string, unknown>
    if (
      identity['id'] !== LEGACY_SELECTION_REGISTRY_IDENTITY.id ||
      identity['schemaVersion'] !== LEGACY_SELECTION_REGISTRY_IDENTITY.schemaVersion
    ) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'registryIdentity does not match global registry',
        { registryIdentity: identity },
      )
    }
    if (typeof raw['codeProtocolPin'] !== 'string' || raw['codeProtocolPin'].length === 0) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'codeProtocolPin must be a non-empty string',
      )
    }
    if (raw['schemaVersion'] !== 'helix.harness/v1') {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy entry schemaVersion must be helix.harness/v1',
      )
    }
    const baselineRef = requireHarnessStateRef(raw['baselineRef'], 'baselineRef')
    if (baselineRef.kind !== 'baseline') {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy baselineRef.kind must be baseline',
      )
    }
    if (
      typeof raw['baselineContentHash'] !== 'string' ||
      raw['baselineContentHash'] !== baselineRef.contentHash
    ) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'baselineContentHash must equal baselineRef.contentHash',
      )
    }

    let stored
    try {
      stored = this.harnessStore.read(baselineRef)
    } catch {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy baseline ref is missing from store',
        { baselineRef },
      )
    }
    if (stored.kind !== 'baseline') {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy baseline ref does not point to a baseline',
      )
    }
    if (stored.document.schemaVersion !== 'helix.harness/v1') {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy baseline schemaVersion mismatch',
      )
    }
    if (stored.ref.contentHash !== baselineRef.contentHash) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy baseline hash mismatch against store',
      )
    }

    const entry: LegacySelectionRegistryEntry = {
      registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
      codeProtocolPin: raw['codeProtocolPin'],
      baselineRef: cloneJson(baselineRef),
      baselineContentHash: baselineRef.contentHash,
      schemaVersion: 'helix.harness/v1',
    }

    const existing = this.entries.get(entry.codeProtocolPin)
    if (existing) {
      if (
        identityEqual(existing.registryIdentity, entry.registryIdentity) &&
        refsEqual(existing.baselineRef, entry.baselineRef) &&
        existing.baselineContentHash === entry.baselineContentHash &&
        existing.schemaVersion === entry.schemaVersion
      ) {
        return deepFreezeJson(cloneJson(existing))
      }
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        `codeProtocolPin ${entry.codeProtocolPin} is already registered with a different selection`,
        { existing, attempted: entry },
      )
    }

    const frozen = deepFreezeJson(cloneJson(entry))
    if (persist && this.rootDir !== undefined) {
      const pendingEntries = [...this.entries.values(), frozen].map((e) => cloneJson(e))
      const pending = {
        format: 'helix.harness-legacy-registry/v1' as const,
        registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
        entries: pendingEntries,
      }
      const target = durableLegacyRegistryPath(this.rootDir)
      if (this.durableWriter !== undefined) {
        this.durableWriter(target, pending)
      } else {
        atomicWriteJsonSync(target, pending)
      }
    }
    this.entries.set(entry.codeProtocolPin, frozen)
    return frozen
  }


  resolveLegacySelection(codeProtocolPin: string): LegacySelectionRegistryEntry {
    if (typeof codeProtocolPin !== 'string' || codeProtocolPin.length === 0) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'codeProtocolPin must be a non-empty string',
      )
    }
    const entry = this.entries.get(codeProtocolPin)
    if (!entry) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        `no legacy registry entry for pin ${codeProtocolPin}`,
        { codeProtocolPin },
      )
    }
    // Re-validate baseline still present and hash matches.
    let stored
    try {
      stored = this.harnessStore.read(entry.baselineRef)
    } catch {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy registry baseline missing from store',
        { baselineRef: entry.baselineRef },
      )
    }
    if (stored.kind !== 'baseline') {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy registry baseline kind mismatch',
      )
    }
    if (
      stored.ref.contentHash !== entry.baselineContentHash ||
      stored.ref.contentHash !== entry.baselineRef.contentHash ||
      stored.document.schemaVersion !== entry.schemaVersion
    ) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'legacy registry entry hash/schema mismatch against store',
        { entry, storeRef: stored.ref },
      )
    }
    return deepFreezeJson(cloneJson(entry))
  }

  snapshot(): LegacySelectionRegistry {
    return deepFreezeJson(
      cloneJson({
        registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
        entries: [...this.entries.values()].map((e) => cloneJson(e)),
      }),
    )
  }

  /**
   * Export an immutable provenance view. Not a selection authority.
   * Attempting to encode a different baseline for an already-registered pin
   * via a crafted view is a caller error checked by `assertManifestProvenance`.
   */
  exportManifest(): LegacySelectionManifest {
    const snap = this.snapshot()
    return deepFreezeJson(
      cloneJson({
        manifestVersion: 'helix.harness-legacy-selection/v1' as const,
        registryIdentity: snap.registryIdentity,
        exportedEntries: snap.entries,
      }),
    )
  }

  private hydrateFromDisk(rootDir: string): void {
    this.loadRegistryIntoMemory(readDurableJsonSync(durableLegacyRegistryPath(rootDir)))
  }

  private reloadFromDurableRoot(): void {
    if (this.rootDir === undefined) return
    this.entries.clear()
    this.loadRegistryIntoMemory(
      readDurableJsonSync(durableLegacyRegistryPath(this.rootDir)),
    )
  }

  private withRegisterLock<T>(fn: () => T): T {
    if (this.rootDir === undefined) return fn()
    return withDurableLockSync(durableLegacyRegistryLockPath(this.rootDir), fn)
  }

  private loadRegistryIntoMemory(raw: unknown): void {
    if (raw === undefined) return
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable legacy registry snapshot must be an object',
      )
    }
    const snap = raw as Record<string, unknown>
    if (snap['format'] !== 'helix.harness-legacy-registry/v1') {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable legacy registry format must be helix.harness-legacy-registry/v1',
      )
    }
    if (
      !isPlainObject(snap['registryIdentity']) ||
      (snap['registryIdentity'] as Record<string, unknown>)['id'] !==
        LEGACY_SELECTION_REGISTRY_IDENTITY.id ||
      (snap['registryIdentity'] as Record<string, unknown>)['schemaVersion'] !==
        LEGACY_SELECTION_REGISTRY_IDENTITY.schemaVersion
    ) {
      throw harnessError(
        'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
        'durable legacy registry identity mismatch',
      )
    }
    if (!Array.isArray(snap['entries'])) {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable legacy registry entries must be an array',
      )
    }
    for (const item of snap['entries']) {
      // Validate against store but do not re-persist during hydrate.
      this.registerLegacySelectionUnlocked(item, false)
    }
  }


}

/**
 * Validate that a manifest is a pure provenance view of the registry.
 * Rejects any attempt to re-point a registered pin to a different baseline.
 */
export function assertManifestProvenance(
  manifest: unknown,
  registry: LegacySelectionRegistryStore,
): LegacySelectionManifest {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'manifest must be an object',
    )
  }
  const raw = manifest as Record<string, unknown>
  if (raw['manifestVersion'] !== 'helix.harness-legacy-selection/v1') {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'unsupported manifestVersion',
    )
  }
  if (!isPlainObject(raw['registryIdentity'])) {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'manifest.registryIdentity required',
    )
  }
  const identity = raw['registryIdentity'] as Record<string, unknown>
  if (
    identity['id'] !== LEGACY_SELECTION_REGISTRY_IDENTITY.id ||
    identity['schemaVersion'] !== LEGACY_SELECTION_REGISTRY_IDENTITY.schemaVersion
  ) {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'manifest registryIdentity mismatch',
    )
  }
  if (!Array.isArray(raw['exportedEntries'])) {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'manifest.exportedEntries must be an array',
    )
  }
  const snap = registry.snapshot()
  const byPin = new Map(snap.entries.map((e) => [e.codeProtocolPin, e]))
  for (const item of raw['exportedEntries']) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        'manifest entry must be an object',
      )
    }
    const entry = item as Record<string, unknown>
    if (typeof entry['codeProtocolPin'] !== 'string') {
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        'manifest entry missing codeProtocolPin',
      )
    }
    const pin = entry['codeProtocolPin']
    const registered = byPin.get(pin)
    if (!registered) {
      // Manifest cannot invent new selections.
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        `manifest entry for unregistered pin ${pin}`,
      )
    }
    const baselineRef = requireHarnessStateRef(entry['baselineRef'], 'baselineRef')
    if (!refsEqual(baselineRef, registered.baselineRef)) {
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        `manifest attempts to re-point pin ${pin} to a different baseline`,
        { registered: registered.baselineRef, attempted: baselineRef },
      )
    }
    if (entry['baselineContentHash'] !== registered.baselineContentHash) {
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        `manifest baselineContentHash drift for pin ${pin}`,
      )
    }
    if (entry['schemaVersion'] !== registered.schemaVersion) {
      throw harnessError(
        'HARNESS_NONDETERMINISTIC_SELECTION',
        `manifest schemaVersion drift for pin ${pin}`,
      )
    }
  }
  return deepFreezeJson(
    cloneJson({
      manifestVersion: 'helix.harness-legacy-selection/v1' as const,
      registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
      exportedEntries: raw['exportedEntries'] as LegacySelectionRegistryEntry[],
    }),
  )
}

/**
 * Reject attempts to select baseline/overlay outside the registry entry during
 * legacy replay.
 */
export function assertLegacyReplaySelectionOnly(
  codeProtocolPin: string,
  attempted: { baselineRef?: HarnessStateRef; overlayRef?: HarnessStateRef },
  entry: LegacySelectionRegistryEntry,
): void {
  if (attempted.overlayRef !== undefined) {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'legacy replay must not attach an overlay',
      { codeProtocolPin },
    )
  }
  if (
    attempted.baselineRef !== undefined &&
    !refsEqual(attempted.baselineRef, entry.baselineRef)
  ) {
    throw harnessError(
      'HARNESS_NONDETERMINISTIC_SELECTION',
      'legacy replay must not select a baseline outside the registry entry',
      {
        codeProtocolPin,
        registryBaseline: entry.baselineRef,
        attempted: attempted.baselineRef,
      },
    )
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
