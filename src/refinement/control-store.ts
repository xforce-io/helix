/**
 * Issue #13 RCS foundation: one durable snapshot owns both #10 state and the
 * refinement-only visibility/provenance records. This is internal Host control
 * plane code, not a public SDK.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  atomicWriteJsonSync,
  HarnessStateStore,
  refsEqual,
  type CatalogCardRef,
  type HarnessSelection,
  type HarnessSelectionInput,
  type HarnessStateRef,
  type ResolvedHarness,
  type StoredHarnessState,
  withDurableLockSync,
} from '../harness/index.js'
import type { DurableHarnessStoreSnapshot, HarnessStateStoreOptions } from '../harness/store.js'
import { admitGeneratedOverlayPayload } from './overlay-admission.js'
import { refinementError } from './errors.js'

const FORMAT = 'helix.refinement-control-store/v1' as const

export type RefinementCandidateRecord = {
  candidateId: string
  generationRunRef: string
  baseBaselineRef: HarnessStateRef
  overlayRef: HarnessStateRef
  payloadHash: string
}

type ReservedOverlayRecord = {
  candidateId: string
  externalSelectable: boolean
}

type Snapshot = {
  format: typeof FORMAT
  harness: DurableHarnessStoreSnapshot
  candidates: RefinementCandidateRecord[]
  reservedOverlays: Array<{ overlayRef: HarnessStateRef; value: ReservedOverlayRecord }>
  /** Immutable refinement-only artifacts keyed by their full canonical ref string. */
  artifacts: Array<{ ref: string; payload: unknown }>
  assertionReceipts: Array<{ nonceKey: string; fingerprint: string; response: unknown; expiresAt: string }>
  /** One terminal Decision per immutable promotion request. */
  terminalDecisions: string[]
}

export type RefinementControlStoreOptions = Partial<
  Pick<HarnessStateStoreOptions, 'registry' | 'skipRegistryLookup'>
> & {
  /** A durable RCS root. Omit only for isolated unit tests. */
  rootDir?: string
  /** Test seam: fail the single RCS commit before it becomes visible. */
  durableWriter?: (targetPath: string, value: unknown) => void
}

export type RefinementSelectionRoute = 'external' | 'evaluator' | 'replay'

/**
 * RCS is the only persistence boundary for a refinement-enabled deployment.
 * It reconstructs a regular #10 HarnessStateStore from its own single snapshot;
 * no reserved state is encoded in #10 refs, selections, pins, or payloads.
 */
export class RefinementControlStore {
  private readonly rootDir: string | undefined
  private readonly harnessOptions: Partial<Pick<HarnessStateStoreOptions, 'registry' | 'skipRegistryLookup'>>
  private readonly durableWriter: ((targetPath: string, value: unknown) => void) | undefined
  private harness: HarnessStateStore
  private snapshot: Snapshot
  private transactionDepth = 0

  constructor(options: RefinementControlStoreOptions = {}) {
    this.rootDir = options.rootDir
    this.durableWriter = options.durableWriter
    this.harnessOptions = {      ...(options.registry === undefined ? {} : { registry: options.registry }),
      ...(options.skipRegistryLookup === undefined
        ? {}
        : { skipRegistryLookup: options.skipRegistryLookup }),
    }
    this.snapshot = this.emptySnapshot()
    this.harness = this.hydrate(this.snapshot)
    this.reload()
  }

  publishBaseline(input: unknown, options?: { id?: string; revision?: number }): HarnessStateRef {
    return this.transaction(() => this.harness.publishBaseline(input, options))
  }

  publishOverlay(input: unknown, options?: { id?: string; revision?: number }): HarnessStateRef {
    return this.transaction(() => this.harness.publishOverlay(input, options))
  }

  read(ref: HarnessStateRef): StoredHarnessState {
    this.reload()
    return this.harness.read(ref)
  }

  exportSnapshot(): DurableHarnessStoreSnapshot {
    this.reload()
    return this.harness.exportSnapshot()
  }

  get durableRootDir(): string | undefined {
    return this.rootDir
  }

  /** Process-local #10 view of the current RCS harness snapshot. */
  materializeHarnessStore(): HarnessStateStore {
    this.reload()
    return this.hydrate(this.snapshot)
  }

  resolve(
    selection: HarnessSelection,
    codeProtocolPin: string,
    availableCatalogRefs: readonly CatalogCardRef[],
  ): ResolvedHarness {
    this.reload()
    return this.harness.resolve(selection, codeProtocolPin, availableCatalogRefs)
  }

  /**
   * Candidate admission is called only after the generation-run adapter proves
   * source provenance. It atomically creates/links an ordinary #10 overlay and
   * keeps it evaluator-only until promotion.
   */
  admitCandidate(input: {
    candidateId: string
    generationRunRef: string
    baseBaselineRef: HarnessStateRef
    payloadText: string
    /** Artifacts derived from the admitted ordinary overlay, committed atomically with it. */
    artifacts?: (candidate: RefinementCandidateRecord) => Array<{ ref: string; payload: unknown }>
  }): RefinementCandidateRecord {
    return this.transaction(() => {
      if (!isNonEmpty(input.candidateId) || !isNonEmpty(input.generationRunRef)) {
        throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'candidate identity and generation run ref are required')
      }
      const admitted = admitGeneratedOverlayPayload({
        payloadText: input.payloadText,
        baseBaselineRef: input.baseBaselineRef,
      })
      const existing = this.snapshot.candidates.find(c => c.candidateId === input.candidateId)
      if (existing !== undefined) {
        if (
          existing.generationRunRef === input.generationRunRef &&
          refsEqual(existing.baseBaselineRef, input.baseBaselineRef) &&
          existing.payloadHash === admitted.payloadHash
        ) return cloneCandidate(existing)
        throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'candidateId is immutable and already bound to different input')
      }

      const samePayload = this.snapshot.harness.overlays.find(
        entry => entry.ref.contentHash === admitted.payloadHash &&
          refsEqual(entry.overlay.baseBaselineRef, input.baseBaselineRef),
      )
      const overlayRef = samePayload === undefined
        ? this.harness.publishOverlay(admitted.overlay, {
            id: `refinement-${admitted.payloadHash}`,
            revision: 0,
          })
        : samePayload.ref
      if (overlayRef.contentHash !== admitted.payloadHash) {
        throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'ordinary overlay hash differs from admitted candidate payload')
      }
      const record: RefinementCandidateRecord = {
        candidateId: input.candidateId,
        generationRunRef: input.generationRunRef,
        baseBaselineRef: cloneRef(input.baseBaselineRef),
        overlayRef: cloneRef(overlayRef),
        payloadHash: admitted.payloadHash,
      }
      this.snapshot.candidates.push(record)
      this.snapshot.reservedOverlays.push({
        overlayRef: cloneRef(overlayRef),
        value: { candidateId: input.candidateId, externalSelectable: false },
      })
      const artifacts = input.artifacts?.(cloneCandidate(record)) ?? []
      for (const artifact of artifacts) {
        if (!isNonEmpty(artifact.ref) || this.snapshot.artifacts.some(entry => entry.ref === artifact.ref)) {
          throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'candidate admission artifact is missing or already exists')
        }
      }
      for (const artifact of artifacts) {
        this.snapshot.artifacts.push({ ref: artifact.ref, payload: structuredClone(artifact.payload) })
      }
      return cloneCandidate(record)
    })
  }

  /** Only a later promotion coordinator may call this after Request/Decision checks. */
  markCandidatePromoted(candidateId: string): HarnessStateRef {
    return this.transaction(() => {
      const candidate = this.requireCandidate(candidateId)
      const visibility = this.snapshot.reservedOverlays.find(
        entry => refsEqual(entry.overlayRef, candidate.overlayRef) && entry.value.candidateId === candidateId,
      )
      if (visibility === undefined) {
        throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'candidate overlay visibility provenance is missing')
      }
      visibility.value.externalSelectable = true
      return cloneRef(candidate.overlayRef)
    })
  }

  /** Existing #10 selection shape; RCS only gates visibility before delegation. */
  /** Write-once immutable control artifact. The caller owns schema/hash validation. */
  putArtifact(ref: string, payload: unknown): void {
    this.transaction(() => {
      if (!isNonEmpty(ref)) {
        throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'artifact ref is required')
      }
      const existing = this.snapshot.artifacts.find(entry => entry.ref === ref)
      const encoded = JSON.stringify(payload)
      if (existing !== undefined) {
        if (JSON.stringify(existing.payload) === encoded) return
        throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'artifact ref is immutable')
      }
      this.snapshot.artifacts.push({ ref, payload: structuredClone(payload) })
    })
  }

  /**
   * Atomically consume an assertion nonce with its state transition. Identical
   * retry returns the original response; changed intent fails closed.
   */
  consumeAssertion<T>(input: {
    issuer: string
    keyId: string
    nonce: string
    fingerprint: string
    expiresAt: string
    operation: () => T
  }): T {
    return this.transaction(() => {
      const nonceKey = `${input.issuer}:${input.keyId}:${input.nonce}`
      const prior = this.snapshot.assertionReceipts.find(entry => entry.nonceKey === nonceKey)
      if (prior !== undefined) {
        if (prior.fingerprint === input.fingerprint) return structuredClone(prior.response) as T
        throw refinementError('REFINEMENT_ASSERTION_REPLAYED', 'actor assertion nonce was already consumed by different intent')
      }
      const response = input.operation()
      this.snapshot.assertionReceipts.push({ nonceKey, fingerprint: input.fingerprint, response: structuredClone(response), expiresAt: input.expiresAt })
      return response
    })
  }

  getArtifact<T>(ref: string): T | undefined {
    this.reload()
    const found = this.snapshot.artifacts.find(entry => entry.ref === ref)
    return found === undefined ? undefined : structuredClone(found.payload) as T
  }

  /** Atomically append a closed set of immutable artifacts without publishing an overlay. */
  commitArtifacts(artifacts: Array<{ ref: string; payload: unknown }>): void {
    this.transaction(() => {
      for (const artifact of artifacts) {
        if (!isNonEmpty(artifact.ref) || this.snapshot.artifacts.some(entry => entry.ref === artifact.ref)) {
          throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'artifact is missing or already exists')
        }
      }
      for (const artifact of artifacts) {
        this.snapshot.artifacts.push({ ref: artifact.ref, payload: structuredClone(artifact.payload) })
      }
    })
  }

  /**
   * Promotion commit: Decision/Association records and external visibility move
   * together under the RCS lock, or none become durable.
   */
  promoteCandidateWithArtifacts(input: {
    requestKey: string
    candidateId: string
    artifacts: Array<{ ref: string; payload: unknown }>
  }): HarnessStateRef {
    return this.transaction(() => {
      if (this.snapshot.terminalDecisions.includes(input.requestKey)) {
        throw refinementError('REFINEMENT_ASSERTION_REPLAYED', 'promotion request already has a terminal decision')
      }
      const candidate = this.requireCandidate(input.candidateId)
      const visibility = this.snapshot.reservedOverlays.find(
        entry => refsEqual(entry.overlayRef, candidate.overlayRef) && entry.value.candidateId === input.candidateId,
      )
      if (visibility === undefined) {
        throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'candidate overlay visibility provenance is missing')
      }
      for (const artifact of input.artifacts) {
        if (!isNonEmpty(artifact.ref) || this.snapshot.artifacts.some(entry => entry.ref === artifact.ref)) {
          throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'promotion artifact is missing or already exists')
        }
      }
      visibility.value.externalSelectable = true
      for (const artifact of input.artifacts) {
        this.snapshot.artifacts.push({ ref: artifact.ref, payload: structuredClone(artifact.payload) })
      }
      this.snapshot.terminalDecisions.push(input.requestKey)
      return cloneRef(candidate.overlayRef)
    })
  }

  /** Write a rejected terminal Decision without changing overlay visibility. */
  rejectRequestWithArtifact(requestKey: string, artifact: { ref: string; payload: unknown }): void {
    this.transaction(() => {
      if (this.snapshot.terminalDecisions.includes(requestKey) || !isNonEmpty(artifact.ref) || this.snapshot.artifacts.some(entry => entry.ref === artifact.ref)) {
        throw refinementError('REFINEMENT_ASSERTION_REPLAYED', 'promotion request already has a terminal decision')
      }
      this.snapshot.artifacts.push({ ref: artifact.ref, payload: structuredClone(artifact.payload) })
      this.snapshot.terminalDecisions.push(requestKey)
    })
  }

  /** Read-only artifact projection for the workflow's deterministic id lookup. */
  listArtifacts(): Array<{ ref: string; payload: unknown }> {
    this.reload()
    return this.snapshot.artifacts.map(entry => ({ ref: entry.ref, payload: structuredClone(entry.payload) }))
  }

  /** Existing #10 selection shape; RCS only gates visibility before delegation. */
  select(
    route: RefinementSelectionRoute,
    input: HarnessSelectionInput,
    availableCatalogRefs: readonly CatalogCardRef[],
  ): HarnessSelection {
    this.reload()
    if (input.overlayRef !== undefined) this.assertRouteMaySelect(route, input.overlayRef)
    return this.harness.select(input, availableCatalogRefs)
  }

  private assertRouteMaySelect(route: RefinementSelectionRoute, overlayRef: HarnessStateRef): void {
    const reserved = this.snapshot.reservedOverlays.filter(entry => refsEqual(entry.overlayRef, overlayRef))
    if (
      reserved.length > 0 &&
      !reserved.some(entry => entry.value.externalSelectable) &&
      route === 'external'
    ) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'evaluation-reserved overlay is not selectable by external runs')
    }
  }

  private requireCandidate(candidateId: string): RefinementCandidateRecord {
    const candidate = this.snapshot.candidates.find(c => c.candidateId === candidateId)
    if (candidate === undefined) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'candidate does not exist')
    }
    return candidate
  }

  private transaction<T>(operation: () => T): T {
    // Nested RCS mutations join the outer serializable transaction. This lets
    // a nonce receipt and its request/decision/publication state change commit
    // together, instead of acquiring the durable lock recursively.
    if (this.transactionDepth > 0) return operation()
    const run = () => {
      this.reload()
      const before = structuredClone(this.snapshot)
      this.transactionDepth = 1
      try {
        const result = operation()
        this.snapshot.harness = this.harness.exportSnapshot()
        this.writeSnapshot(this.snapshot)
        return result
      } catch (error) {
        this.snapshot = before
        this.harness = this.hydrate(before)
        throw error
      } finally {
        this.transactionDepth = 0
      }
    }
    return this.rootDir === undefined ? run() : withDurableLockSync(this.lockPath(), run)
  }

  private reload(): void {
    if (this.rootDir === undefined) return
    const raw = readRefinementSnapshot(this.snapshotPath())
    if (raw === undefined) return
    this.snapshot = parseSnapshot(raw)
    this.harness = this.hydrate(this.snapshot)
  }

  private hydrate(snapshot: Snapshot): HarnessStateStore {
    const store = new HarnessStateStore(this.harnessOptions)
    for (const entry of snapshot.harness.baselines) {
      const ref = store.publishBaseline(entry.document, { id: entry.ref.id, revision: entry.ref.revision })
      if (!refsEqual(ref, entry.ref)) throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'stored baseline identity mismatch')
    }
    for (const entry of snapshot.harness.overlays) {
      const ref = store.publishOverlay(entry.overlay, { id: entry.ref.id, revision: entry.ref.revision })
      if (!refsEqual(ref, entry.ref)) throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'stored overlay identity mismatch')
    }
    return store
  }

  private writeSnapshot(snapshot: Snapshot): void {
    if (this.rootDir === undefined) return
    if (this.durableWriter !== undefined) this.durableWriter(this.snapshotPath(), snapshot)
    else atomicWriteJsonSync(this.snapshotPath(), snapshot)
  }

  private emptySnapshot(): Snapshot {
    return { format: FORMAT, harness: { format: 'helix.harness-store/v1', baselines: [], overlays: [], autoIdCounter: 0 }, candidates: [], reservedOverlays: [], artifacts: [], assertionReceipts: [], terminalDecisions: [] }
  }

  private snapshotPath(): string {
    return path.join(this.rootDir!, 'refinement-control.json')
  }

  private lockPath(): string {
    return path.join(this.rootDir!, 'refinement-control.lock')
  }
}

function parseSnapshot(raw: unknown): Snapshot {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'RCS snapshot must be an object')
  }
  const value = raw as Partial<Snapshot>
  if (
    value.format !== FORMAT ||
    value.harness === undefined ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.reservedOverlays) ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.assertionReceipts) ||
    !Array.isArray(value.terminalDecisions)
  ) {
    throw refinementError('REFINEMENT_PUBLICATION_ATOMIC_FAILED', 'RCS snapshot schema is invalid')
  }
  return value as Snapshot
}

function readRefinementSnapshot(snapshotPath: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as unknown
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === 'ENOENT') return undefined
    throw refinementError(
      'REFINEMENT_PUBLICATION_ATOMIC_FAILED',
      'failed to parse RCS snapshot',
      error instanceof Error ? { cause: error.message } : undefined,
    )
  }
}

function isNonEmpty(value: string): boolean {
  return value.length > 0
}

function cloneRef(ref: HarnessStateRef): HarnessStateRef {
  return { kind: ref.kind, id: ref.id, revision: ref.revision, contentHash: ref.contentHash }
}

function cloneCandidate(candidate: RefinementCandidateRecord): RefinementCandidateRecord {
  return { ...candidate, baseBaselineRef: cloneRef(candidate.baseBaselineRef), overlayRef: cloneRef(candidate.overlayRef) }
}
