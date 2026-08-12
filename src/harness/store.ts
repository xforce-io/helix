/**
 * Immutable HarnessStateStore (Host control-plane internal).
 * Optional durable root keeps published baselines/overlays across process boundaries.
 */


import type { CapabilityCatalogRegistry } from '../catalog/registry.js'
import { getDefaultRegistry } from '../catalog/registry.js'
import {
  baselineContentHash,
  mergeOverlayOntoBaseline,
  overlayContentHash,
  refsEqual,
  requireHarnessDocument,
  requireHarnessOverlay,
  requireHarnessStateRef,
  assertCardsAvailable,
  assertDocumentAcceptsPin,
  assertAgentSpecCatalogClosure,
  resolveCatalogCardsInRegistry,
  dedupeCatalogRefs,
  validateHarnessStateRef,
} from './document.js'
import { harnessContentHash, cloneJson, deepFreezeJson } from './canonical.js'
import { harnessError } from './errors.js'
import {
  atomicWriteJsonSync,
  durableStoreLockPath,
  durableStoreSnapshotPath,
  readDurableJsonSync,
  withDurableLockSync,
} from './persist.js'
import type {
  CatalogCardRef,
  HarnessDocument,
  HarnessOverlay,
  HarnessSelection,
  HarnessSelectionInput,
  HarnessStateRef,
  ResolvedHarness,
  StoredHarnessState,
} from './types.js'


type BaselineRecord = {
  ref: HarnessStateRef
  document: HarnessDocument
}

type OverlayRecord = {
  ref: HarnessStateRef
  overlay: HarnessOverlay
}

export type PublishBaselineOptions = {
  id?: string
  revision?: number
}

export type PublishOverlayOptions = {
  id?: string
  revision?: number
}

export type HarnessStateStoreOptions = {
  registry?: CapabilityCatalogRegistry
  /** Test-only: allow synthetic catalog cards not in production registry. */
  skipRegistryLookup?: boolean
  /**
   * Durable immutable root. When set, every successful publish is flushed and
   * a later process can open the same root and read recorded refs exactly.
   */
  rootDir?: string
  /**
   * Test seam: override durable snapshot write. Must throw to simulate I/O
   * failure; publish then leaves no half-written ref in memory or on disk.
   */
  durableWriter?: (targetPath: string, value: unknown) => void
}

/** On-disk snapshot schema for cross-process replay of published state. */
export type DurableHarnessStoreSnapshot = {
  format: 'helix.harness-store/v1'
  baselines: Array<{ ref: HarnessStateRef; document: HarnessDocument }>
  overlays: Array<{ ref: HarnessStateRef; overlay: HarnessOverlay }>
  autoIdCounter: number
}


function refKey(ref: Pick<HarnessStateRef, 'kind' | 'id' | 'revision'>): string {
  return `${ref.kind}:${ref.id}@${ref.revision}`
}

export class HarnessStateStore {
  private readonly baselines = new Map<string, BaselineRecord>()
  private readonly overlays = new Map<string, OverlayRecord>()
  private readonly registry: CapabilityCatalogRegistry
  private readonly skipRegistryLookup: boolean
  private readonly rootDir: string | undefined
  private readonly durableWriter:
    | ((targetPath: string, value: unknown) => void)
    | undefined
  private autoIdCounter = 0

  constructor(options: HarnessStateStoreOptions = {}) {
    this.registry = options.registry ?? getDefaultRegistry()
    this.skipRegistryLookup = options.skipRegistryLookup === true
    this.rootDir =
      typeof options.rootDir === 'string' && options.rootDir.length > 0
        ? options.rootDir
        : undefined
    this.durableWriter = options.durableWriter
    if (this.rootDir !== undefined) {
      this.hydrateFromDisk(this.rootDir)
    }
  }


  publishBaseline(
    documentInput: unknown,
    options: PublishBaselineOptions = {},
  ): HarnessStateRef {
    const document = requireHarnessDocument(documentInput, {
      registry: this.registry,
      skipRegistryLookup: this.skipRegistryLookup,
    })
    if (!this.skipRegistryLookup) {
      const resolved = resolveCatalogCardsInRegistry(document.catalogCards, this.registry)
      if (!resolved.ok) {
        throw harnessError(resolved.code, resolved.message, resolved.details)
      }
    }
    const contentHash = baselineContentHash(document)
    const id =
      options.id ??
      `baseline-${(this.autoIdCounter + 1).toString(10).padStart(4, '0')}`
    const revision = options.revision ?? 1
    if (typeof id !== 'string' || id.length === 0) {
      throw harnessError('HARNESS_REF_INVALID', 'baseline id must be non-empty string')
    }
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw harnessError('HARNESS_REF_INVALID', 'baseline revision must be non-negative safe integer')
    }
    const ref: HarnessStateRef = {
      kind: 'baseline',
      id,
      revision,
      contentHash,
    }
    return this.commitPublish({
      kind: 'baseline',
      ref,
      document,
      consumesAutoId: options.id === undefined,
    })
  }

  publishOverlay(
    overlayInput: unknown,
    options: PublishOverlayOptions = {},
  ): HarnessStateRef {
    // Structural validation + merge checks happen under the durable lock so
    // concurrent publishers observe a consistent baseline set.
    return this.withPublishLock(() => {
      this.reloadFromDurableRoot()
      const overlay = requireHarnessOverlay(overlayInput, {
        registry: this.registry,
        skipRegistryLookup: this.skipRegistryLookup,
      })
      let base: BaselineRecord
      try {
        base = this.readBaselineRecord(overlay.baseBaselineRef)
      } catch (error) {
        if (error instanceof Error && 'code' in error) throw error
        throw harnessError(
          'HARNESS_REF_INVALID',
          'overlay baseBaselineRef does not exist in store',
          { baseBaselineRef: overlay.baseBaselineRef },
        )
      }
      if (!refsEqual(base.ref, overlay.baseBaselineRef)) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'overlay baseBaselineRef does not match store baseline',
          { expected: base.ref, got: overlay.baseBaselineRef },
        )
      }
      const merged = mergeOverlayOntoBaseline(base.document, overlay)
      if (!merged.ok) {
        throw harnessError(merged.code, merged.message, merged.details)
      }
      if (!this.skipRegistryLookup) {
        const resolved = resolveCatalogCardsInRegistry(
          merged.value.catalogCards,
          this.registry,
        )
        if (!resolved.ok) {
          throw harnessError(resolved.code, resolved.message, resolved.details)
        }
      }
      const contentHash = overlayContentHash(overlay)
      const id =
        options.id ??
        `overlay-${(this.autoIdCounter + 1).toString(10).padStart(4, '0')}`
      const revision = options.revision ?? 1
      if (typeof id !== 'string' || id.length === 0) {
        throw harnessError('HARNESS_REF_INVALID', 'overlay id must be non-empty string')
      }
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'overlay revision must be non-negative safe integer',
        )
      }
      const ref: HarnessStateRef = {
        kind: 'overlay',
        id,
        revision,
        contentHash,
      }
      return this.commitPublishUnlocked({
        kind: 'overlay',
        ref,
        overlay,
        consumesAutoId: options.id === undefined,
      })
    })
  }

  read(refInput: unknown): StoredHarnessState {
    const ref = requireHarnessStateRef(refInput, 'ref')
    if (ref.kind === 'baseline') {
      const record = this.readBaselineRecord(ref)
      return deepFreezeJson(
        cloneJson({
          kind: 'baseline' as const,
          ref: record.ref,
          document: record.document,
        }),
      )
    }
    const record = this.readOverlayRecord(ref)
    return deepFreezeJson(
      cloneJson({
        kind: 'overlay' as const,
        ref: record.ref,
        overlay: record.overlay,
      }),
    )
  }

  /**
   * Select published baseline (+ optional overlay) and verify catalog membership
   * against the run's frozen availableCatalogRefs.
   */
  select(
    input: HarnessSelectionInput | unknown,
    availableCatalogRefsInput: readonly CatalogCardRef[],
  ): HarnessSelection {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw harnessError('HARNESS_SELECTION_REQUIRED', 'selection input must be an object')
    }
    const raw = input as Record<string, unknown>
    // Closed schema: only { baselineRef, overlayRef? }.
    const allowedKeys: Record<string, true> = {
      baselineRef: true,
      overlayRef: true,
    }
    for (const key of Object.keys(raw)) {
      if (allowedKeys[key] !== true) {
        // Bare pin / latest / source / hash / inline selectors are nondeterministic.
        throw harnessError(
          'HARNESS_NONDETERMINISTIC_SELECTION',
          `selection must not include '${key}'; only baselineRef and optional overlayRef are allowed`,
        )
      }
    }
    if (!('baselineRef' in raw) || raw['baselineRef'] === undefined) {
      throw harnessError(
        'HARNESS_SELECTION_REQUIRED',
        'selection requires baselineRef',
      )
    }
    const baselineRef = requireHarnessStateRef(raw['baselineRef'], 'baselineRef')
    if (baselineRef.kind !== 'baseline') {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'baselineRef.kind must be baseline',
        { baselineRef },
      )
    }
    let overlayRef: HarnessStateRef | undefined
    if ('overlayRef' in raw && raw['overlayRef'] !== undefined) {
      overlayRef = requireHarnessStateRef(raw['overlayRef'], 'overlayRef')
      if (overlayRef.kind !== 'overlay') {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'overlayRef.kind must be overlay',
          { overlayRef },
        )
      }
    }

    const availableCatalogRefs = deepFreezeJson(
      cloneJson(dedupeCatalogRefs(availableCatalogRefsInput)),
    )

    const baselineRecord = this.readBaselineRecord(baselineRef)
    const baselineCardsCheck = assertCardsAvailable(
      baselineRecord.document.catalogCards,
      availableCatalogRefs,
      'baseline.catalogCards',
    )
    if (!baselineCardsCheck.ok) {
      throw harnessError(
        baselineCardsCheck.code,
        baselineCardsCheck.message,
        baselineCardsCheck.details,
      )
    }

    let overlay: HarnessOverlay | undefined
    if (overlayRef !== undefined) {
      const overlayRecord = this.readOverlayRecord(overlayRef)
      overlay = overlayRecord.overlay
      if (!refsEqual(overlay.baseBaselineRef, baselineRecord.ref)) {
        throw harnessError(
          'HARNESS_OVERLAY_BASE_MISMATCH',
          'overlay.baseBaselineRef does not match selection baselineRef',
          {
            baseBaselineRef: overlay.baseBaselineRef,
            baselineRef: baselineRecord.ref,
          },
        )
      }
      if (overlay.changes.catalogCards !== undefined) {
        const overlayCardsCheck = assertCardsAvailable(
          overlay.changes.catalogCards,
          availableCatalogRefs,
          'overlay.changes.catalogCards',
        )
        if (!overlayCardsCheck.ok) {
          throw harnessError(
            overlayCardsCheck.code,
            overlayCardsCheck.message,
            overlayCardsCheck.details,
          )
        }
      }
    }

    const selection: HarnessSelection = {
      baselineRef: baselineRecord.ref,
      baseline: baselineRecord.document,
      availableCatalogRefs,
    }
    if (overlayRef !== undefined && overlay !== undefined) {
      selection.overlayRef = overlayRef
      selection.overlay = overlay
    }
    return deepFreezeJson(cloneJson(selection))
  }

  /**
   * Resolve a selection into a full document + harnessContentHash.
   * Fail-closed: never returns partial documents.
   */
  resolve(
    selection: HarnessSelection,
    codeProtocolPin: string,
    availableCatalogRefsInput: readonly CatalogCardRef[],
  ): ResolvedHarness {
    // available set must be the same frozen membership used at select time.
    const availableCatalogRefs = dedupeCatalogRefs(availableCatalogRefsInput)
    if (
      !sameCatalogSet(selection.availableCatalogRefs, availableCatalogRefs)
    ) {
      throw harnessError(
        'HARNESS_CATALOG_NOT_AVAILABLE',
        'availableCatalogRefs changed between select and resolve',
      )
    }

    // Re-read from store to ensure refs still match exact payloads.
    const baselineRecord = this.readBaselineRecord(selection.baselineRef)
    let document = baselineRecord.document
    let overlayRef: HarnessStateRef | undefined

    if (selection.overlayRef !== undefined) {
      const overlayRecord = this.readOverlayRecord(selection.overlayRef)
      if (!refsEqual(overlayRecord.overlay.baseBaselineRef, baselineRecord.ref)) {
        throw harnessError(
          'HARNESS_OVERLAY_BASE_MISMATCH',
          'overlay.baseBaselineRef does not match selection baselineRef',
        )
      }
      const merged = mergeOverlayOntoBaseline(
        baselineRecord.document,
        overlayRecord.overlay,
      )
      if (!merged.ok) {
        throw harnessError(merged.code, merged.message, merged.details)
      }
      document = merged.value
      overlayRef = overlayRecord.ref
    }

    // Registry resolution (structural).
    if (!this.skipRegistryLookup) {
      const resolved = resolveCatalogCardsInRegistry(document.catalogCards, this.registry)
      if (!resolved.ok) {
        throw harnessError(resolved.code, resolved.message, resolved.details)
      }
    }

    // availableCatalogRefs membership on resolved cards.
    const availableCheck = assertCardsAvailable(
      document.catalogCards,
      availableCatalogRefs,
      'resolved.catalogCards',
    )
    if (!availableCheck.ok) {
      throw harnessError(availableCheck.code, availableCheck.message, availableCheck.details)
    }

    const closure = assertAgentSpecCatalogClosure(document.agentSpecs, document.catalogCards)
    if (!closure.ok) {
      throw harnessError(closure.code, closure.message, closure.details)
    }

    assertDocumentAcceptsPin(document, codeProtocolPin)

    const harnessHash = harnessContentHash(document)
    const resolved: ResolvedHarness = {
      document: deepFreezeJson(cloneJson(document)),
      selection: {
        baselineRef: baselineRecord.ref,
        ...(overlayRef !== undefined ? { overlayRef } : {}),
      },
      harnessContentHash: harnessHash,
      schemaVersion: 'helix.harness/v1',
      catalogCards: document.catalogCards.map((c) => ({ id: c.id, version: c.version })),
      compatibilityDecision: {
        documentAcceptsCodeProtocolPin: true,
        catalogResolved: true,
      },
      codeProtocolPin,
      availableCatalogRefs: deepFreezeJson(cloneJson(availableCatalogRefs)),
    }
    return deepFreezeJson(cloneJson(resolved))
  }

  /** Test/helper: drop a baseline (simulates missing store entry for legacy tests). */
  deleteForTests(ref: HarnessStateRef): void {
    const key = refKey(ref)
    if (ref.kind === 'baseline') this.baselines.delete(key)
    else this.overlays.delete(key)
  }

  /**
   * Export an immutable snapshot of all published baselines/overlays.
   * Used for durable flush and cross-process tests.
   */
  exportSnapshot(): DurableHarnessStoreSnapshot {
    return deepFreezeJson(
      cloneJson({
        format: 'helix.harness-store/v1' as const,
        baselines: [...this.baselines.values()].map((record) => ({
          ref: record.ref,
          document: record.document,
        })),
        overlays: [...this.overlays.values()].map((record) => ({
          ref: record.ref,
          overlay: record.overlay,
        })),
        autoIdCounter: this.autoIdCounter,
      }),
    )
  }

  /** Durable root when this store is backed by Host-held immutable state. */
  get durableRootDir(): string | undefined {
    return this.rootDir
  }

  private hydrateFromDisk(rootDir: string): void {
    this.loadSnapshotIntoMemory(readDurableJsonSync(durableStoreSnapshotPath(rootDir)))
  }

  /**
   * Under durable lock: re-read latest snapshot so concurrent publishers
   * cannot commit against a stale in-memory view.
   */
  private reloadFromDurableRoot(): void {
    if (this.rootDir === undefined) return
    this.baselines.clear()
    this.overlays.clear()
    this.autoIdCounter = 0
    this.loadSnapshotIntoMemory(
      readDurableJsonSync(durableStoreSnapshotPath(this.rootDir)),
    )
  }

  private withPublishLock<T>(fn: () => T): T {
    if (this.rootDir === undefined) return fn()
    return withDurableLockSync(durableStoreLockPath(this.rootDir), fn)
  }

  private commitPublish(
    entry:
      | {
          kind: 'baseline'
          ref: HarnessStateRef
          document: HarnessDocument
          consumesAutoId: boolean
        }
      | {
          kind: 'overlay'
          ref: HarnessStateRef
          overlay: HarnessOverlay
          consumesAutoId: boolean
        },
  ): HarnessStateRef {
    return this.withPublishLock(() => {
      this.reloadFromDurableRoot()
      return this.commitPublishUnlocked(entry)
    })
  }

  private commitPublishUnlocked(
    entry:
      | {
          kind: 'baseline'
          ref: HarnessStateRef
          document: HarnessDocument
          consumesAutoId: boolean
        }
      | {
          kind: 'overlay'
          ref: HarnessStateRef
          overlay: HarnessOverlay
          consumesAutoId: boolean
        },
  ): HarnessStateRef {
    const key = refKey(entry.ref)
    if (entry.kind === 'baseline') {
      if (this.baselines.has(key)) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          `baseline ${entry.ref.id}@${entry.ref.revision} already exists and is immutable`,
          { id: entry.ref.id, revision: entry.ref.revision },
        )
      }
    } else if (this.overlays.has(key)) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        `overlay ${entry.ref.id}@${entry.ref.revision} already exists and is immutable`,
        { id: entry.ref.id, revision: entry.ref.revision },
      )
    }

    // Prepare the candidate record without mutating visible maps until durable
    // commit succeeds (or pure in-memory publish commits).
    const frozenRef = deepFreezeJson(cloneJson(entry.ref))
    const baselineRecord =
      entry.kind === 'baseline'
        ? {
            ref: frozenRef,
            document: deepFreezeJson(cloneJson(entry.document)),
          }
        : undefined
    const overlayRecord =
      entry.kind === 'overlay'
        ? {
            ref: frozenRef,
            overlay: deepFreezeJson(cloneJson(entry.overlay)),
          }
        : undefined

    const nextAutoId = entry.consumesAutoId
      ? this.autoIdCounter + 1
      : this.autoIdCounter

    if (this.rootDir !== undefined) {
      // Build the post-commit snapshot without touching live maps first.
      const pendingBaselines = [...this.baselines.values()]
      const pendingOverlays = [...this.overlays.values()]
      if (baselineRecord !== undefined) pendingBaselines.push(baselineRecord)
      if (overlayRecord !== undefined) pendingOverlays.push(overlayRecord)
      const pendingSnapshot: DurableHarnessStoreSnapshot = {
        format: 'helix.harness-store/v1',
        baselines: pendingBaselines.map((record) => ({
          ref: record.ref,
          document: record.document,
        })),
        overlays: pendingOverlays.map((record) => ({
          ref: record.ref,
          overlay: record.overlay,
        })),
        autoIdCounter: nextAutoId,
      }
      const target = durableStoreSnapshotPath(this.rootDir)
      try {
        if (this.durableWriter !== undefined) {
          this.durableWriter(target, pendingSnapshot)
        } else {
          atomicWriteJsonSync(target, pendingSnapshot)
        }
      } catch (error) {
        // Failed durable commit must leave this instance and disk without the ref.
        throw error
      }
    }

    // Commit memory only after durable success (or when ephemeral).
    if (baselineRecord !== undefined) this.baselines.set(key, baselineRecord)
    if (overlayRecord !== undefined) this.overlays.set(key, overlayRecord)
    this.autoIdCounter = nextAutoId
    return deepFreezeJson(cloneJson(entry.ref))
  }

  private loadSnapshotIntoMemory(raw: unknown): void {
    if (raw === undefined) return
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable harness store snapshot must be an object',
      )
    }
    const snap = raw as Record<string, unknown>
    if (snap['format'] !== 'helix.harness-store/v1') {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable harness store snapshot format must be helix.harness-store/v1',
      )
    }
    if (!Array.isArray(snap['baselines']) || !Array.isArray(snap['overlays'])) {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable harness store snapshot requires baselines and overlays arrays',
      )
    }
    if (
      typeof snap['autoIdCounter'] !== 'number' ||
      !Number.isSafeInteger(snap['autoIdCounter']) ||
      snap['autoIdCounter'] < 0
    ) {
      throw harnessError(
        'HARNESS_SCHEMA_INVALID',
        'durable harness store autoIdCounter must be a non-negative safe integer',
      )
    }
    for (const item of snap['baselines']) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw harnessError(
          'HARNESS_SCHEMA_INVALID',
          'durable baseline entry must be an object',
        )
      }
      const entry = item as Record<string, unknown>
      const document = requireHarnessDocument(entry['document'], {
        registry: this.registry,
        skipRegistryLookup: this.skipRegistryLookup,
      })
      const ref = requireHarnessStateRef(entry['ref'], 'baseline.ref')
      if (ref.kind !== 'baseline') {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'durable baseline entry kind must be baseline',
        )
      }
      const contentHash = baselineContentHash(document)
      if (contentHash !== ref.contentHash) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'durable baseline contentHash does not match payload',
          { ref, contentHash },
        )
      }
      const key = refKey(ref)
      if (this.baselines.has(key)) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          `duplicate durable baseline ${ref.id}@${ref.revision}`,
        )
      }
      this.baselines.set(key, {
        ref: deepFreezeJson(cloneJson(ref)),
        document: deepFreezeJson(cloneJson(document)),
      })
    }
    for (const item of snap['overlays']) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw harnessError(
          'HARNESS_SCHEMA_INVALID',
          'durable overlay entry must be an object',
        )
      }
      const entry = item as Record<string, unknown>
      const overlay = requireHarnessOverlay(entry['overlay'], {
        registry: this.registry,
        skipRegistryLookup: this.skipRegistryLookup,
      })
      const ref = requireHarnessStateRef(entry['ref'], 'overlay.ref')
      if (ref.kind !== 'overlay') {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'durable overlay entry kind must be overlay',
        )
      }
      const contentHash = overlayContentHash(overlay)
      if (contentHash !== ref.contentHash) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          'durable overlay contentHash does not match payload',
          { ref, contentHash },
        )
      }
      this.readBaselineRecord(overlay.baseBaselineRef)
      const key = refKey(ref)
      if (this.overlays.has(key)) {
        throw harnessError(
          'HARNESS_REF_INVALID',
          `duplicate durable overlay ${ref.id}@${ref.revision}`,
        )
      }
      this.overlays.set(key, {
        ref: deepFreezeJson(cloneJson(ref)),
        overlay: deepFreezeJson(cloneJson(overlay)),
      })
    }
    this.autoIdCounter = snap['autoIdCounter']
  }



  private readBaselineRecord(ref: HarnessStateRef): BaselineRecord {
    const parsed = validateHarnessStateRef(ref, 'baselineRef')
    if (!parsed.ok) {
      throw harnessError(parsed.code, parsed.message, parsed.details)
    }
    if (parsed.value.kind !== 'baseline') {
      throw harnessError('HARNESS_REF_INVALID', 'expected baseline ref', { ref })
    }
    const record = this.baselines.get(refKey(parsed.value))
    if (!record) {
      throw harnessError('HARNESS_REF_INVALID', 'baseline ref not found in store', {
        ref: parsed.value,
      })
    }
    if (!refsEqual(record.ref, parsed.value)) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'baseline ref does not match store record',
        { expected: record.ref, got: parsed.value },
      )
    }
    if (baselineContentHash(record.document) !== record.ref.contentHash) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'stored baseline content hash mismatch',
        { ref: record.ref },
      )
    }
    if (record.ref.contentHash !== parsed.value.contentHash) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'baseline contentHash does not match store',
        { expected: record.ref.contentHash, got: parsed.value.contentHash },
      )
    }
    return record
  }

  private readOverlayRecord(ref: HarnessStateRef): OverlayRecord {
    const parsed = validateHarnessStateRef(ref, 'overlayRef')
    if (!parsed.ok) {
      throw harnessError(parsed.code, parsed.message, parsed.details)
    }
    if (parsed.value.kind !== 'overlay') {
      throw harnessError('HARNESS_REF_INVALID', 'expected overlay ref', { ref })
    }
    const record = this.overlays.get(refKey(parsed.value))
    if (!record) {
      throw harnessError('HARNESS_REF_INVALID', 'overlay ref not found in store', {
        ref: parsed.value,
      })
    }
    if (!refsEqual(record.ref, parsed.value)) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'overlay ref does not match store record',
        { expected: record.ref, got: parsed.value },
      )
    }
    if (overlayContentHash(record.overlay) !== record.ref.contentHash) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'stored overlay content hash mismatch',
        { ref: record.ref },
      )
    }
    if (record.ref.contentHash !== parsed.value.contentHash) {
      throw harnessError(
        'HARNESS_REF_INVALID',
        'overlay contentHash does not match store',
        { expected: record.ref.contentHash, got: parsed.value.contentHash },
      )
    }
    return record
  }
}

function sameCatalogSet(
  a: readonly CatalogCardRef[],
  b: readonly CatalogCardRef[],
): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a.map((c) => `${c.id}@${c.version}`))
  for (const c of b) {
    if (!set.has(`${c.id}@${c.version}`)) return false
  }
  return true
}
