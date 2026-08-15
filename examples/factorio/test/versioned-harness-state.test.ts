import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ModelRequest, ModelResponse } from 'milkie'
import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import {
  CapabilityCatalogRegistry,
  setDefaultRegistryForTests,
  type CapabilityCard,
} from '../../../src/catalog/index.js'
import {
  assertManifestProvenance,
  baselineContentHash,
  bindControlPlaneText,
  canonicalizeHarnessValue,
  canonicalizeHarnessValueAlt,
  createFixtureScenarioAdapter,
  freezeAvailableCatalogRefs,
  harnessCanonicalBytes,
  harnessCanonicalBytesAlt,
  harnessContentHash,
  harnessContentHashAlt,
  HarnessError,
  HarnessStateStore,
  inheritFrozenHarnessSlice,
  childRecordedFromFrozen,
  normalizePinsV1,
  normalizeEvidenceHarness,
  LEGACY_SELECTION_REGISTRY_IDENTITY,
  LegacySelectionRegistryStore,
  materializeHarnessRecord,
  mergeOverlayOntoBaseline,
  parseHarnessJsonText,
  parseHarnessJsonTextAlt,
  replayFromLegacyPin,
  replayFromRecordedPins,
  renderControlPlane,
  selectValidateResolveFreeze,
  validateHarnessDocument,
  acquireDurableLockSync,
  releaseDurableLockSync,
  durableStoreLockPath,
  durableLegacyRegistryLockPath,
  type CatalogCardRef,
  type HarnessDocument,
  type HarnessOverlay,
  type HarnessStateRef,
} from '../../../src/harness/index.js'
import {
  assembleFactorioRun,
  createFactorioHostBundle,
  formFactorioAvailableCatalogRefs,
  openFactorioReplayHost,
} from '../src/harness-host.js'
import {
  FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
  FACTORIO_V4_HARNESS_DOCUMENT,
  FACTORIO_V5_HARNESS_DOCUMENT,
  createFactorioScenarioAdapter,
} from '../src/harness-document.js'
import {
  parseLiveEvidenceText,
  pinsV4,
  pinsSessionAsync,
} from '../src/cli-common.js'
import { runHarness } from '../src/harness.js'
import { reconstructFactorioReplayHarness } from '../src/replay.js'
import {
  LiveCellExecutor,
  type ChildPortFactory,
  type ChildPortHandle,
} from '../src/live-executor.js'
import { MemoryTraceObjectStore } from 'milkie'


const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const HARNESS_SRC = join(REPO_ROOT, 'src/harness')

const CARD_A1: CatalogCardRef = { id: 'helix.models', version: '1.0.0' }
const CARD_A2: CatalogCardRef = { id: 'helix.models', version: '2.0.0' }
const CARD_B1: CatalogCardRef = { id: 'helix.session', version: '1.0.0' }

function installTestRegistry(): CapabilityCatalogRegistry {
  // Use default production loader; then register an extra helix.models@2.0.0.
  const registry = new CapabilityCatalogRegistry()
  // Force load packaged cards.
  void registry.listProductionCards()
  const models2Raw = {
    id: 'helix.models',
    version: '2.0.0',
    kind: 'runtime' as const,
    registrationScope: 'runtime-catalog' as const,
    injectionTarget: 'kernel-binding' as const,
    provider: 'helix-runtime',
    capabilityDiscoveryKeys: ['recursiveModel'],
    pinsTouch: 'test only',
    surface: [
      {
        name: 'helix.models.call',
        signature: 'call(instructions, input=None, max_output_tokens=None) -> RecursiveModelResult',
        effectClass: 'model_effect' as const,
        occupiesHostEffectSlot: true,
      },
    ],
    effect: {
      effectClasses: ['model_effect' as const],
      hostSlotSummary: 'test',
      mutualExclusionWith: ['env_effect'],
    },
    budgetAndAuth: {
      capabilityGate: 'capabilities.recursiveModel.enabled',
      tokenPool: 'parent',
      countBudget: 'calls',
      unauthorized: 'reject',
    },
    doc: {
      format: 'markdown/v1',
      title: 'helix.models',
      body: 'v2 test card',
    },
    replay: {
      recordingAnchor: 'test',
      zeroLiveFallback: true,
      isolation: 'test',
      notes: 'test',
    },
    nonGoals: ['none'],
  }
  const registered = registry.registerCard(models2Raw as CapabilityCard)
  assert.equal(registered.ok, true, JSON.stringify(registered))
  setDefaultRegistryForTests(registry)
  return registry
}



function makeDocument(
  overrides: Partial<HarnessDocument> & {
    control?: Partial<HarnessDocument['control']>
    compatibility?: Partial<HarnessDocument['compatibility']>
  } = {},
): HarnessDocument {
  const base: HarnessDocument = {
    schemaVersion: 'helix.harness/v1',
    control: {
      systemInstructionTemplate: 'SYS-V1',
      taskNarrativeTemplate: 'TASK-V1',
      protocolRules: ['rule-a'],
      termination: {
        successSource: 'scenario-verifier',
        stopConditions: ['done'],
      },
    },
    catalogCards: [CARD_A1],
    compatibility: {
      codeProtocolPins: ['test-pin/v1'],
    },
  }
  return {
    schemaVersion: 'helix.harness/v1',
    control: {
      ...base.control,
      ...overrides.control,
      termination: {
        ...base.control.termination,
        ...overrides.control?.termination,
      },
    },
    catalogCards: overrides.catalogCards ?? base.catalogCards,
    compatibility: {
      ...base.compatibility,
      ...overrides.compatibility,
    },
    ...(overrides.agentSpecs !== undefined ? { agentSpecs: overrides.agentSpecs } : {}),
  }
}

function expectHarnessError(fn: () => unknown, code: string): HarnessError {
  try {
    fn()
    assert.fail(`expected HarnessError ${code}`)
  } catch (error) {
    assert.ok(error instanceof HarnessError, `expected HarnessError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

installTestRegistry()

test.after(() => {
  setDefaultRegistryForTests(undefined)
})


// ---------------------------------------------------------------------------
// S1 — generic core boundary
// ---------------------------------------------------------------------------

test('S1.core-has-no-factorio-imports', () => {
  const files = [
    'index.ts',
    'types.ts',
    'errors.ts',
    'canonical.ts',
    'json-text.ts',
    'document.ts',
    'store.ts',
    'legacy.ts',
    'host.ts',
    'renderer.ts',
    'record.ts',
    'adapter.ts',
    'persist.ts',
    'control-plane-binding.ts',
  ]
  for (const file of files) {
    const text = readFileSync(join(HARNESS_SRC, file), 'utf8')
    assert.equal(
      /factorio|fle|iron_ore|bindingSet|factorio-rlm/i.test(text),
      false,
      `${file} must not reference Factorio scenario details`,
    )
  }
})

test('S1.core-has-no-example-imports-or-scenario-directory', () => {
  assert.equal(existsSync(join(REPO_ROOT, 'src/factorio')), false)
  const roots = ['catalog', 'harness', 'refinement'].map(name => join(REPO_ROOT, 'src', name))
  const files: string[] = [join(REPO_ROOT, 'src/index.ts')]
  while (roots.length > 0) {
    const current = roots.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) roots.push(child)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child)
    }
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(
      text,
      /(?:\bfrom\s*|\bimport\s*\()\s*['"][^'"]*(?:^|\/)examples\//,
      `${file} must not import an example`,
    )
  }
})


test('S1.fixture-adapter-host-assembly', () => {
  const store = new HarnessStateStore()
  const doc = makeDocument()
  const baselineRef = store.publishBaseline(doc, { id: 's1', revision: 1 })
  const available = freezeAvailableCatalogRefs([CARD_A1])
  const freeze = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef },
  })
  const adapter = createFixtureScenarioAdapter({
    taskNarrative: 'Adapter-only task payload',
    environmentNarrative: 'Adapter-only env payload',
  })
  const scenario = adapter.buildScenarioPayload({
    frozen: freeze.frozen,
    codeProtocolPin: 'test-pin/v1',
  })
  const rendered = renderControlPlane({
    document: freeze.frozen.document,
    catalogDocs: [],
    scenario,
  })
  assert.match(rendered, /Adapter-only task payload/)
  assert.match(rendered, /SYS-V1/)
  assert.equal(freeze.pins.format, 'harness/v1')
  // Store / pins / evidence owned by core/host, not adapter.
  assert.equal('publishBaseline' in adapter, false)
})

test('S1.factorio-adapter-e2e-composition', () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('test-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  assert.equal(assembled.pins.harness, 'factorio-rlm/v4')
  assert.ok(assembled.pins.harnessState)
  assert.equal(assembled.pins.harnessState.format, 'harness/v1')
  assert.equal(
    assembled.pins.harnessState.harnessContentHash,
    assembled.frozen.harnessContentHash,
  )
  assert.match(assembled.controlPlaneText, /iron-ore/)
  assert.match(assembled.controlPlaneText, /Factorio Learning Environment/)
  assert.equal(assembled.record.pins.harness.harnessContentHash, assembled.frozen.harnessContentHash)
  // Default P1 uses an explicit Store baseline ref.
  assert.equal(assembled.frozen.selection.baselineRef.id, 'factorio.default-p1')
})

// ---------------------------------------------------------------------------
// S2 — stable load / freeze / read-back / child / replay
// ---------------------------------------------------------------------------

test('S2.same-baseline-two-runs-stable-identity', () => {
  const store = new HarnessStateStore()
  const doc = makeDocument()
  const baselineRef = store.publishBaseline(doc, { id: 's2-v1', revision: 1 })
  const available = freezeAvailableCatalogRefs([CARD_A1])

  const runA1 = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef },
  })
  const runA2 = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef },
  })

  assert.equal(runA1.frozen.harnessContentHash, runA2.frozen.harnessContentHash)
  assert.deepEqual(runA1.frozen.selection.baselineRef, runA2.frozen.selection.baselineRef)
  assert.equal(runA1.frozen.selection.overlayRef, undefined)
  assert.equal(runA2.frozen.selection.overlayRef, undefined)
  assert.deepEqual(runA1.pins, runA2.pins)

  const recordA1 = materializeHarnessRecord(runA1)
  const recordA2 = materializeHarnessRecord(runA2)
  assert.deepEqual(recordA1.context.runtime.harness, recordA1.pins.harness)
  assert.deepEqual(recordA1.pins.harness.harnessContentHash, recordA1.evidence.harness.harnessContentHash)
  assert.deepEqual(recordA1.pins.harness, recordA2.pins.harness)
  assert.equal(recordA1.evidence.harness.selectionSource, 'recorded')

  // Control plane from V1.
  const rendered = renderControlPlane({
    document: runA1.frozen.document,
    catalogDocs: [],
    scenario: createFixtureScenarioAdapter().buildScenarioPayload({
      frozen: runA1.frozen,
      codeProtocolPin: 'test-pin/v1',
    }),
  })
  assert.match(rendered, /SYS-V1/)
  assert.match(rendered, /TASK-V1/)
})

test('S2.child-inherits-parent-slice-and-drift-rejects', () => {
  const store = new HarnessStateStore()
  const baselineRef = store.publishBaseline(makeDocument(), { id: 's2-child', revision: 1 })
  const available = freezeAvailableCatalogRefs([CARD_A1])
  const parent = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef },
  }).frozen

  const childOk = inheritFrozenHarnessSlice({
    parent,
    childRecorded: {
      selection: parent.selection,
      harnessContentHash: parent.harnessContentHash,
      schemaVersion: parent.schemaVersion,
      catalogCards: parent.catalogCards,
      compatibilityDecision: parent.compatibilityDecision,
      codeProtocolPin: parent.codeProtocolPin,
    },
  })
  assert.equal(childOk.harnessContentHash, parent.harnessContentHash)

  expectHarnessError(
    () =>
      inheritFrozenHarnessSlice({
        parent,
        childRecorded: {
          selection: parent.selection,
          harnessContentHash: '0'.repeat(64),
          schemaVersion: parent.schemaVersion,
          catalogCards: parent.catalogCards,
          compatibilityDecision: parent.compatibilityDecision,
          codeProtocolPin: parent.codeProtocolPin,
        },
      }),
    'HARNESS_CHILD_SELECTION_DRIFT',
  )
})

test('S2.replay-uses-recorded-refs-only', () => {
  const store = new HarnessStateStore()
  const baselineRef = store.publishBaseline(makeDocument(), { id: 's2-replay', revision: 1 })
  const available = freezeAvailableCatalogRefs([CARD_A1])
  const live = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef },
  })
  // Publish a later revision that must not affect replay.
  store.publishBaseline(makeDocument({ control: { taskNarrativeTemplate: 'LATER' } }), {
    id: 's2-replay',
    revision: 2,
  })
  const replayed = replayFromRecordedPins({
    store,
    pins: live.pins,
    availableCatalogRefs: available,
  })
  assert.equal(replayed.frozen.harnessContentHash, live.frozen.harnessContentHash)
  assert.equal(replayed.frozen.document.control.taskNarrativeTemplate, 'TASK-V1')
  assert.equal(replayed.evidence.selectionSource, 'recorded')
})

// ---------------------------------------------------------------------------
// S3 — V1/V2/V3 publish/select/run/replay + canonical + fail-closed
// ---------------------------------------------------------------------------

test('S3.v1-v2-v3-publish-select-run-replay', () => {
  const store = new HarnessStateStore()
  const available = freezeAvailableCatalogRefs([CARD_A1])

  // V1 baseline
  const v1Doc = makeDocument()
  const v1Ref = store.publishBaseline(v1Doc, { id: 's3-base', revision: 1 })
  const runA = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef: v1Ref },
  })
  const recordA = materializeHarnessRecord(runA)
  assert.equal(runA.frozen.document.control.taskNarrativeTemplate, 'TASK-V1')
  assert.equal(recordA.context.runtime.harness.baselineRef.revision, 1)

  // V2 baseline — only taskNarrativeTemplate changes (via Store, not source edit)
  const v2Doc = makeDocument({ control: { taskNarrativeTemplate: 'TASK-V2' } })
  const v2Ref = store.publishBaseline(v2Doc, { id: 's3-base', revision: 2 })
  const runB = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef: v2Ref },
  })
  assert.notEqual(runB.frozen.harnessContentHash, runA.frozen.harnessContentHash)
  assert.notDeepEqual(runB.frozen.selection.baselineRef, runA.frozen.selection.baselineRef)
  const renderedB = renderControlPlane({
    document: runB.frozen.document,
    catalogDocs: [],
    scenario: { taskNarrative: 'scenario' },
  })
  assert.match(renderedB, /TASK-V2/)
  assert.doesNotMatch(renderedB, /TASK-V1/)

  // V3 overlay on V2 — only protocolRules
  const v3Overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: v2Ref,
    changes: { protocolRules: ['rule-v3-only'] },
  }
  const v3Ref = store.publishOverlay(v3Overlay, { id: 's3-overlay', revision: 1 })
  const runC = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef: v2Ref, overlayRef: v3Ref },
  })
  assert.notEqual(runC.frozen.harnessContentHash, runB.frozen.harnessContentHash)
  assert.notEqual(runC.frozen.harnessContentHash, runA.frozen.harnessContentHash)
  assert.deepEqual(runC.frozen.document.control.protocolRules, ['rule-v3-only'])
  assert.equal(runC.frozen.document.control.taskNarrativeTemplate, 'TASK-V2')
  assert.ok(runC.pins.overlayRef)

  // Publish more revisions after runs — must not affect replay
  store.publishBaseline(makeDocument({ control: { taskNarrativeTemplate: 'TASK-FUTURE' } }), {
    id: 's3-base',
    revision: 99,
  })

  const replayA = replayFromRecordedPins({
    store,
    pins: runA.pins,
    availableCatalogRefs: available,
  })
  const replayB = replayFromRecordedPins({
    store,
    pins: runB.pins,
    availableCatalogRefs: available,
  })
  const replayC = replayFromRecordedPins({
    store,
    pins: runC.pins,
    availableCatalogRefs: available,
  })
  assert.equal(replayA.frozen.harnessContentHash, runA.frozen.harnessContentHash)
  assert.equal(replayA.frozen.document.control.taskNarrativeTemplate, 'TASK-V1')
  assert.equal(replayB.frozen.harnessContentHash, runB.frozen.harnessContentHash)
  assert.equal(replayB.frozen.document.control.taskNarrativeTemplate, 'TASK-V2')
  assert.equal(replayC.frozen.harnessContentHash, runC.frozen.harnessContentHash)
  assert.deepEqual(replayC.frozen.document.control.protocolRules, ['rule-v3-only'])
  assert.equal(replayC.evidence.selectionSource, 'recorded')
})

test('S3.dual-canonicalizer-cross-check', () => {
  const weirdKeys = {
    schemaVersion: 'helix.harness/v1',
    // Intentionally odd key order and characters
    'z-key': 'tail',
    'a-key': 'head',
    solidus: 'a/b',
    quote: 'he said "hi"',
    backslash: 'path\\x',
    accented: 'café',
    cjk: '中文',
    lineSep: 'a\u2028b',
    paraSep: 'a\u2029b',
    controls: '\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f',
    zero: 0,
    maxSafe: Number.MAX_SAFE_INTEGER,
    nested: {
      baseBaselineRef: {
        kind: 'baseline',
        id: 'x',
        revision: 0,
        contentHash: 'ab'.repeat(32),
      },
      budget: { maxCalls: 0, maxOutputTokens: Number.MAX_SAFE_INTEGER },
    },
    list: ['keep-order-2', 'keep-order-1'],
  }

  const primary = harnessCanonicalBytes(weirdKeys)
  const alt = harnessCanonicalBytesAlt(weirdKeys)
  assert.deepEqual(primary, alt)
  assert.equal(harnessContentHash(weirdKeys), harnessContentHashAlt(weirdKeys))
  // solidus must be raw 0x2f, never \/
  const text = primary.toString('utf8')
  assert.match(text, /a\/b/)
  assert.equal(text.includes('\\/'), false)
  assert.equal(primary.includes(0xef) && primary[0] === 0xef, false) // no BOM

  // Changing budget changes identity.
  const doc1 = makeDocument({
    agentSpecs: [
      {
        id: 'agent-1',
        defaultInstruction: 'do work',
        catalogCards: [CARD_A1],
        budget: { maxCalls: 1, maxOutputTokens: 10 },
      },
    ],
  })
  const doc2 = makeDocument({
    agentSpecs: [
      {
        id: 'agent-1',
        defaultInstruction: 'do work',
        catalogCards: [CARD_A1],
        budget: { maxCalls: 2, maxOutputTokens: 10 },
      },
    ],
  })
  assert.notEqual(harnessContentHash(doc1), harnessContentHash(doc2))
  const rendered = renderControlPlane({
    document: doc1,
    catalogDocs: [],
    scenario: {},
  })
  assert.match(rendered, /agent-1/)
  assert.match(rendered, /maxCalls=1/)
})

test('S3.fail-closed-schema-ref-overlay-pin-latest', () => {
  const store = new HarnessStateStore()
  const baselineRef = store.publishBaseline(makeDocument(), { id: 's3-fc', revision: 1 })
  const available = freezeAvailableCatalogRefs([CARD_A1])

  // Illegal schema
  expectHarnessError(
    () =>
      store.publishBaseline({
        ...makeDocument(),
        schemaVersion: 'helix.harness/v0',
      }),
    'HARNESS_SCHEMA_INVALID',
  )

  // Unknown ref
  expectHarnessError(
    () =>
      store.read({
        kind: 'baseline',
        id: 'missing',
        revision: 1,
        contentHash: 'ab'.repeat(32),
      }),
    'HARNESS_REF_INVALID',
  )

  // Hash mismatch
  expectHarnessError(
    () =>
      store.read({
        ...baselineRef,
        contentHash: 'cd'.repeat(32),
      }),
    'HARNESS_REF_INVALID',
  )

  // Missing/extra/wrong-type ref fields
  expectHarnessError(
    () => store.read({ kind: 'baseline', id: 'x', revision: 1 }),
    'HARNESS_REF_INVALID',
  )
  expectHarnessError(
    () =>
      store.read({
        kind: 'baseline',
        id: 'x',
        revision: 1,
        contentHash: 'ab'.repeat(32),
        extra: true,
      }),
    'HARNESS_REF_INVALID',
  )
  expectHarnessError(
    () =>
      store.read({
        kind: 'baseline',
        id: 'x',
        revision: -1,
        contentHash: 'ab'.repeat(32),
      }),
    'HARNESS_REF_INVALID',
  )

  // Non-safe / negative budget
  expectHarnessError(
    () =>
      store.publishBaseline(
        makeDocument({
          agentSpecs: [
            {
              id: 'a',
              defaultInstruction: 'x',
              catalogCards: [CARD_A1],
              budget: { maxCalls: -1 },
            },
          ],
        }),
      ),
    'HARNESS_DOCUMENT_INVALID',
  )
  expectHarnessError(
    () =>
      store.publishBaseline(
        makeDocument({
          agentSpecs: [
            {
              id: 'a',
              defaultInstruction: 'x',
              catalogCards: [CARD_A1],
              budget: { maxCalls: 1.5 as unknown as number },
            },
          ],
        }),
      ),
    'HARNESS_DOCUMENT_INVALID',
  )

  // Unknown card
  expectHarnessError(
    () =>
      store.publishBaseline(
        makeDocument({ catalogCards: [{ id: 'no.such', version: '1.0.0' }] }),
      ),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Overlay base mismatch
  const other = store.publishBaseline(makeDocument({ control: { systemInstructionTemplate: 'OTHER' } }), {
    id: 'other',
    revision: 1,
  })
  const overlay = store.publishOverlay({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: other,
    changes: { protocolRules: ['x'] },
  })
  expectHarnessError(
    () =>
      selectValidateResolveFreeze({
        store,
        availableCatalogRefs: available,
        codeProtocolPin: 'test-pin/v1',
        selection: { baselineRef, overlayRef: overlay },
      }),
    'HARNESS_OVERLAY_BASE_MISMATCH',
  )

  // Unlisted overlay field
  expectHarnessError(
    () =>
      store.publishOverlay({
        schemaVersion: 'helix.harness-overlay/v1',
        baseBaselineRef: baselineRef,
        changes: { agentSpecs: [] },
      }),
    'HARNESS_OVERLAY_INVALID',
  )

  // Empty changes
  expectHarnessError(
    () =>
      store.publishOverlay({
        schemaVersion: 'helix.harness-overlay/v1',
        baseBaselineRef: baselineRef,
        changes: {},
      }),
    'HARNESS_OVERLAY_INVALID',
  )

  // Incompatible pin
  expectHarnessError(
    () =>
      selectValidateResolveFreeze({
        store,
        availableCatalogRefs: available,
        codeProtocolPin: 'unknown-pin',
        selection: { baselineRef },
      }),
    'HARNESS_PROTOCOL_INCOMPATIBLE',
  )

  // latest / nondeterministic
  expectHarnessError(
    () =>
      store.select({ baselineRef, latest: true } as never, available),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )

  // Closed selection keys: extras, codeProtocolPin, bare hash, source, latest
  expectHarnessError(
    () =>
      store.select({ baselineRef, arbitrary: true } as never, available),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )
  expectHarnessError(
    () =>
      store.select(
        { baselineRef, codeProtocolPin: 'test-pin/v1' } as never,
        available,
      ),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )
  expectHarnessError(
    () =>
      store.select(
        { baselineRef, contentHash: baselineRef.contentHash } as never,
        available,
      ),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )
  expectHarnessError(
    () =>
      store.select(
        { baselineRef, sourcePath: 'examples/factorio/src/harness.ts' } as never,
        available,
      ),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )
  expectHarnessError(
    () =>
      selectValidateResolveFreeze({
        store,
        availableCatalogRefs: available,
        codeProtocolPin: 'test-pin/v1',
        selection: { baselineRef, latest: true } as never,
      }),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )
  expectHarnessError(
    () =>
      selectValidateResolveFreeze({
        store,
        availableCatalogRefs: available,
        codeProtocolPin: 'test-pin/v1',
        selection: {
          baselineRef,
          codeProtocolPin: 'test-pin/v1',
        } as never,
      }),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )

  // Missing baseline selection
  expectHarnessError(
    () =>
      selectValidateResolveFreeze({
        store,
        availableCatalogRefs: available,
        codeProtocolPin: 'test-pin/v1',
        selection: {} as never,
      }),
    'HARNESS_SELECTION_REQUIRED',
  )
})

test('S3.duplicate-key-json-text-dual-parser', () => {
  const fixtures = [
    // top-level HarnessDocument duplicate schemaVersion
    '{"schemaVersion":"helix.harness/v1","schemaVersion":"helix.harness/v1","control":{},"catalogCards":[],"compatibility":{"codeProtocolPins":[]}}',
    // nested baseBaselineRef duplicate id
    '{"schemaVersion":"helix.harness-overlay/v1","baseBaselineRef":{"kind":"baseline","id":"a","id":"b","revision":1,"contentHash":"' +
      'ab'.repeat(32) +
      '"},"changes":{"protocolRules":[]}}',
    // overlay changes duplicate protocolRules
    '{"schemaVersion":"helix.harness-overlay/v1","baseBaselineRef":{"kind":"baseline","id":"a","revision":1,"contentHash":"' +
      'ab'.repeat(32) +
      '"},"changes":{"protocolRules":["a"],"protocolRules":["b"]}}',
  ]

  for (const text of fixtures) {
    expectHarnessError(() => parseHarnessJsonText(text), 'HARNESS_JSON_INVALID')
    expectHarnessError(() => parseHarnessJsonTextAlt(text), 'HARNESS_JSON_INVALID')
  }

  // Non-canonical numeric tokens
  for (const token of ['01', '1.0', '1e0', '-0']) {
    expectHarnessError(
      () => parseHarnessJsonText(`{"n":${token}}`),
      'HARNESS_JSON_INVALID',
    )
    expectHarnessError(
      () => parseHarnessJsonTextAlt(`{"n":${token}}`),
      'HARNESS_JSON_INVALID',
    )
  }
})

test('S3.agent-spec-catalog-closure-on-overlay', () => {
  const store = new HarnessStateStore()
  const doc = makeDocument({
    catalogCards: [CARD_A1],
    agentSpecs: [
      {
        id: 'worker',
        defaultInstruction: 'work',
        catalogCards: [CARD_A1],
        budget: {},
      },
    ],
  })
  const baselineRef = store.publishBaseline(doc, { id: 'closure', revision: 1 })

  // Replace catalog with only B1 → must reject with unique error, no ref.
  expectHarnessError(
    () =>
      store.publishOverlay({
        schemaVersion: 'helix.harness-overlay/v1',
        baseBaselineRef: baselineRef,
        changes: { catalogCards: [CARD_B1] },
      }),
    'HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED',
  )
  expectHarnessError(
    () =>
      store.publishOverlay({
        schemaVersion: 'helix.harness-overlay/v1',
        baseBaselineRef: baselineRef,
        changes: { catalogCards: [] },
      }),
    'HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED',
  )

  // Construct equivalent published inputs for resolve by temporarily skipping
  // closure at publish via skipRegistry store is not enough; simulate by
  // merging manually and resolving through store path that still checks.
  const badOverlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: baselineRef,
    changes: { catalogCards: [CARD_B1] },
  }
  const merged = mergeOverlayOntoBaseline(
    (store.read(baselineRef) as { document: HarnessDocument }).document,
    badOverlay,
  )
  assert.equal(merged.ok, false)
  if (!merged.ok) {
    assert.equal(merged.code, 'HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED')
  }

  // Keeping A1 is allowed.
  const okOverlay = store.publishOverlay({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: baselineRef,
    changes: { catalogCards: [CARD_A1], protocolRules: ['kept'] },
  })
  assert.equal(okOverlay.kind, 'overlay')
})

test('S3.availableCatalogRefs-membership-select-and-resolve', () => {
  const store = new HarnessStateStore()
  // available fixed to {A,1}; registry also has A2 and B1.
  const available = freezeAvailableCatalogRefs([CARD_A1])

  // Baseline with extra B1 can be published (structural), but select rejects.
  const withB = store.publishBaseline(
    makeDocument({
      catalogCards: [CARD_A1, CARD_B1],
      compatibility: { codeProtocolPins: ['test-pin/v1'] },
    }),
    { id: 'avail-b', revision: 1 },
  )
  expectHarnessError(
    () =>
      store.select({ baselineRef: withB }, available),
    'HARNESS_CATALOG_NOT_AVAILABLE',
  )

  // Overlay replacing with out-of-set B1 rejected at select.
  const base = store.publishBaseline(makeDocument(), { id: 'avail-base', revision: 1 })
  // Publish overlay that keeps A1 structurally first, then we need an overlay
  // with B1 only — that fails agent-spec-less publish if cards resolve in registry.
  const overlayB = store.publishOverlay({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: base,
    changes: { catalogCards: [CARD_B1] },
  })
  expectHarnessError(
    () => store.select({ baselineRef: base, overlayRef: overlayB }, available),
    'HARNESS_CATALOG_NOT_AVAILABLE',
  )

  // Baseline referencing A2 while available only has A1.
  const withA2 = store.publishBaseline(
    makeDocument({
      catalogCards: [CARD_A2],
      compatibility: { codeProtocolPins: ['test-pin/v1'] },
    }),
    { id: 'avail-a2', revision: 1 },
  )
  expectHarnessError(
    () => store.select({ baselineRef: withA2 }, available),
    'HARNESS_CATALOG_NOT_AVAILABLE',
  )

  // resolve path also rejects (re-check).
  // Build a selection object that somehow bypassed — call resolve with mismatched set.
  const okSel = store.select({ baselineRef: base }, available)
  expectHarnessError(
    () => store.resolve(okSel, 'test-pin/v1', [CARD_B1]),
    'HARNESS_CATALOG_NOT_AVAILABLE',
  )
})

// ---------------------------------------------------------------------------
// S4 — legacy registry / manifest / factorio regression
// ---------------------------------------------------------------------------

test('S4.legacy-registry-replay-and-manifest-provenance', () => {
  const store = new HarnessStateStore()
  const v4Ref = store.publishBaseline(FACTORIO_V4_HARNESS_DOCUMENT, {
    id: 'legacy-v4',
    revision: 1,
  })
  const v5Ref = store.publishBaseline(FACTORIO_V5_HARNESS_DOCUMENT, {
    id: 'legacy-v5',
    revision: 1,
  })
  const registry = new LegacySelectionRegistryStore(store)
  registry.registerLegacySelection({
    registryIdentity: LEGACY_SELECTION_REGISTRY_IDENTITY,
    codeProtocolPin: 'factorio-rlm/v4',
    baselineRef: v4Ref,
    baselineContentHash: v4Ref.contentHash,
    schemaVersion: 'helix.harness/v1',
  })
  registry.registerLegacySelection({
    registryIdentity: LEGACY_SELECTION_REGISTRY_IDENTITY,
    codeProtocolPin: 'factorio-rlm/v5',
    baselineRef: v5Ref,
    baselineContentHash: v5Ref.contentHash,
    schemaVersion: 'helix.harness/v1',
  })

  // Identical re-register is idempotent.
  const again = registry.registerLegacySelection({
    registryIdentity: LEGACY_SELECTION_REGISTRY_IDENTITY,
    codeProtocolPin: 'factorio-rlm/v4',
    baselineRef: v4Ref,
    baselineContentHash: v4Ref.contentHash,
    schemaVersion: 'helix.harness/v1',
  })
  assert.deepEqual(again.baselineRef, v4Ref)

  const availableV4 = formFactorioAvailableCatalogRefs('factorio-rlm/v4')
  const availableV5 = formFactorioAvailableCatalogRefs('factorio-rlm/v5')

  const legacyV4 = replayFromLegacyPin({
    store,
    legacyRegistry: registry,
    codeProtocolPin: 'factorio-rlm/v4',
    availableCatalogRefs: availableV4,
  })
  assert.equal(legacyV4.evidence.selectionSource, 'legacy-registry')
  assert.deepEqual(legacyV4.evidence.registryIdentity, LEGACY_SELECTION_REGISTRY_IDENTITY)
  assert.equal(legacyV4.frozen.selection.overlayRef, undefined)
  assert.equal(legacyV4.frozen.selection.baselineRef.contentHash, v4Ref.contentHash)

  const legacyV5 = replayFromLegacyPin({
    store,
    legacyRegistry: registry,
    codeProtocolPin: 'factorio-rlm/v5',
    availableCatalogRefs: availableV5,
  })
  assert.equal(legacyV5.evidence.selectionSource, 'legacy-registry')
  assert.equal(legacyV5.frozen.selection.baselineRef.contentHash, v5Ref.contentHash)

  // Legacy replay cannot attach overlay or alternate baseline.
  expectHarnessError(
    () =>
      replayFromLegacyPin({
        store,
        legacyRegistry: registry,
        codeProtocolPin: 'factorio-rlm/v4',
        availableCatalogRefs: availableV4,
        attemptedSelection: { overlayRef: { ...v4Ref, kind: 'overlay' } },
      }),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )
  expectHarnessError(
    () =>
      replayFromLegacyPin({
        store,
        legacyRegistry: registry,
        codeProtocolPin: 'factorio-rlm/v4',
        availableCatalogRefs: availableV4,
        attemptedSelection: { baselineRef: v5Ref },
      }),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )

  // New-format artifact does not consult registry.
  const newRun = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: availableV4,
    codeProtocolPin: 'factorio-rlm/v4',
    selection: { baselineRef: v4Ref },
  })
  const newReplay = replayFromRecordedPins({
    store,
    pins: newRun.pins,
    availableCatalogRefs: availableV4,
  })
  assert.equal(newReplay.evidence.selectionSource, 'recorded')
  assert.equal(newReplay.evidence.registryIdentity, undefined)

  // Two manifest provenance views from same registry.
  const manifest1 = registry.exportManifest()
  const manifest2 = registry.exportManifest()
  assertManifestProvenance(manifest1, registry)
  assertManifestProvenance(manifest2, registry)

  // Attempt to re-point pin via crafted manifest → NONDETERMINISTIC.
  expectHarnessError(
    () =>
      assertManifestProvenance(
        {
          ...manifest2,
          exportedEntries: [
            {
              ...manifest2.exportedEntries[0],
              baselineRef: v5Ref,
              baselineContentHash: v5Ref.contentHash,
            },
          ],
        },
        registry,
      ),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )

  // Conflicting re-register.
  expectHarnessError(
    () =>
      registry.registerLegacySelection({
        registryIdentity: LEGACY_SELECTION_REGISTRY_IDENTITY,
        codeProtocolPin: 'factorio-rlm/v4',
        baselineRef: v5Ref,
        baselineContentHash: v5Ref.contentHash,
        schemaVersion: 'helix.harness/v1',
      }),
    'HARNESS_NONDETERMINISTIC_SELECTION',
  )

  // Missing entry / missing baseline / hash mismatch → LEGACY_SELECTION_UNAVAILABLE only.
  expectHarnessError(
    () => registry.resolveLegacySelection('factorio-rlm/v9'),
    'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
  )

  const orphanStore = new HarnessStateStore()
  const orphanRegistry = new LegacySelectionRegistryStore(orphanStore)
  // Can't register without baseline in store.
  expectHarnessError(
    () =>
      orphanRegistry.registerLegacySelection({
        registryIdentity: LEGACY_SELECTION_REGISTRY_IDENTITY,
        codeProtocolPin: 'factorio-rlm/v4',
        baselineRef: v4Ref,
        baselineContentHash: v4Ref.contentHash,
        schemaVersion: 'helix.harness/v1',
      }),
    'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
  )

  // Delete baseline after registration.
  const store2 = new HarnessStateStore()
  const ref2 = store2.publishBaseline(FACTORIO_V4_HARNESS_DOCUMENT, {
    id: 'del',
    revision: 1,
  })
  const reg2 = new LegacySelectionRegistryStore(store2)
  reg2.registerLegacySelection({
    registryIdentity: LEGACY_SELECTION_REGISTRY_IDENTITY,
    codeProtocolPin: 'factorio-rlm/v4',
    baselineRef: ref2,
    baselineContentHash: ref2.contentHash,
    schemaVersion: 'helix.harness/v1',
  })
  store2.deleteForTests(ref2)
  expectHarnessError(
    () => reg2.resolveLegacySelection('factorio-rlm/v4'),
    'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
  )
})

test('S4.factorio-default-p1-uses-store-baseline', () => {
  const bundle = createFactorioHostBundle()
  const v4 = assembleFactorioRun({
    bundle,
    basePins: pinsV4('m'),
    baselineRef: bundle.defaultBaselineRef,
  })
  const v5 = assembleFactorioRun({
    bundle,
    basePins: pinsSessionAsync('m'),
    baselineRef: bundle.legacyV5BaselineRef,
  })
  assert.equal(v4.frozen.selection.baselineRef.id, 'factorio.default-p1')
  assert.equal(v5.frozen.selection.baselineRef.id, 'factorio.legacy-v5')
  assert.ok(v4.pins.harnessState)
  assert.ok(v5.pins.harnessState)
  assert.equal(v4.pins.harnessState.codeProtocolPin, 'factorio-rlm/v4')
  assert.equal(v5.pins.harnessState.codeProtocolPin, 'factorio-rlm/v5')
  // Content identity is independent of code protocol pin field name on RunPins.
  assert.equal(typeof v4.pins.harnessState.harnessContentHash, 'string')
  assert.equal(v4.pins.harnessState.harnessContentHash.length, 64)
  // Adapter is scenario consumer only.
  const adapter = createFactorioScenarioAdapter()
  assert.equal(adapter.scenarioId, 'factorio.iron_ore_throughput')
  assert.equal(
    baselineContentHash(FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT),
    v4.frozen.selection.baselineRef.contentHash,
  )
  assert.equal(
    baselineContentHash(FACTORIO_V5_HARNESS_DOCUMENT),
    v5.frozen.selection.baselineRef.contentHash,
  )
})

test('S4.validate-document-accepts-factorio-payloads', () => {
  const v4 = validateHarnessDocument(FACTORIO_V4_HARNESS_DOCUMENT)
  const v5 = validateHarnessDocument(FACTORIO_V5_HARNESS_DOCUMENT)
  const p1 = validateHarnessDocument(FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT)
  assert.equal(v4.ok, true)
  assert.equal(v5.ok, true)
  assert.equal(p1.ok, true)
})

test('canonicalizers agree on sorted keys and solidus bytes', () => {
  const payload = { b: 1, a: 'x/y', nested: { z: 0, m: 'ok' } }
  assert.equal(canonicalizeHarnessValue(payload), canonicalizeHarnessValueAlt(payload))
  const bytes = harnessCanonicalBytes(payload)
  // Find the solidus byte directly.
  const slashIndex = bytes.indexOf(0x2f)
  assert.ok(slashIndex >= 0)
  assert.notEqual(bytes[slashIndex - 1], 0x5c) // not preceded by backslash
})

// ---------------------------------------------------------------------------
// Reviewer findings — live/replay path, control-plane injection, dual-canon
// ---------------------------------------------------------------------------

test('review.factorio-live-evidence-shaped-replay-from-recorded-pins', () => {
  // Live bootstrap publishes into a durable root; replay only hydrates it.
  const root = mkdtempSync(join(tmpdir(), 'helix-factorio-replay-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const liveAssembled = assembleFactorioRun({
      bundle,
      basePins: pinsV4('replay-model'),
      baselineRef: bundle.defaultBaselineRef,
    })
    // Shape a live evidence artifact as produced by live.ts (pins + harness evidence).
    const liveEvidenceShaped = {
      pins: liveAssembled.pins,
      harness: liveAssembled.freeze.evidence,
    }
    const reconstructed = reconstructFactorioReplayHarness(liveEvidenceShaped, {
      rootDir: root,
    })
    assert.equal(reconstructed.freeze.evidence.selectionSource, 'recorded')
    assert.equal(
      reconstructed.freeze.frozen.harnessContentHash,
      liveAssembled.frozen.harnessContentHash,
    )
    assert.deepEqual(
      reconstructed.freeze.frozen.selection.baselineRef,
      liveAssembled.frozen.selection.baselineRef,
    )
    assert.equal(
      reconstructed.pins.harnessState?.harnessContentHash,
      liveAssembled.pins.harnessState?.harnessContentHash,
    )
    // Control plane is rebuilt from recorded frozen document + scenario adapter.
    assert.match(reconstructed.controlPlaneText, /iron-ore/)
    assert.match(reconstructed.controlPlaneText, /Factorio Learning Environment/)
    assert.equal(
      reconstructed.controlPlaneText.includes(
        liveAssembled.frozen.document.control.systemInstructionTemplate.slice(0, 40),
      ),
      true,
    )
    // Replay open must not re-publish missing defaults into an empty root either.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'helix-factorio-empty-replay-'))
    try {
      const emptyOpen = openFactorioReplayHost({ rootDir: emptyRoot })
      assert.equal(emptyOpen.store.exportSnapshot().baselines.length, 0)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('review.runHarness-model-request-receives-full-control-plane', async () => {
  class CapturePort implements IIOPort {
    requests: ModelRequest[] = []
    async invokeLLM(request: ModelRequest): Promise<ModelResponse> {
      this.requests.push(request)
      const call = {
        id: 'cell-1',
        name: 'execute_cell',
        input: { code: 'factorio.reset()' },
      }
      return {
        content: [{ type: 'tool_use', ...call }],
        toolCalls: [call],
        finishReason: 'tool_use',
      }
    }
    async invokeTool(
      _toolName: string,
      _input: unknown,
      execute: () => Promise<unknown>,
    ): Promise<unknown> {
      return execute()
    }
    now(): number {
      return 0
    }
    uuid(): string {
      return 'uuid'
    }
  }
  const store = new HarnessStateStore()
  const available = freezeAvailableCatalogRefs([CARD_A1, CARD_B1])
  const baseDoc = makeDocument({
    control: {
      systemInstructionTemplate: 'SYS-BASE-CONTROL',
      taskNarrativeTemplate: 'TASK-BASE-CONTROL',
      protocolRules: ['base-rule-keep'],
      termination: {
        successSource: 'scenario-verifier',
        stopConditions: ['stop-base'],
      },
    },
    catalogCards: [CARD_A1],
    agentSpecs: [
      {
        id: 'spec-alpha',
        defaultInstruction: 'SPEC-INSTRUCTION-ALPHA',
        catalogCards: [CARD_A1],
        budget: { maxCalls: 2, maxOutputTokens: 128 },
      },
    ],
    compatibility: { codeProtocolPins: ['test-pin/v1'] },
  })
  const baselineRef = store.publishBaseline(baseDoc, {
    id: 'control-plane-base',
    revision: 1,
  })
  const overlay = store.publishOverlay(
    {
      schemaVersion: 'helix.harness-overlay/v1',
      baseBaselineRef: baselineRef,
      changes: {
        protocolRules: ['overlay-protocol-rule-UNIQUE'],
        stopConditions: ['overlay-stop-UNIQUE'],
      },
    },
    { id: 'control-plane-overlay', revision: 1 },
  )
  const freeze = selectValidateResolveFreeze({
    store,
    availableCatalogRefs: available,
    codeProtocolPin: 'test-pin/v1',
    selection: { baselineRef, overlayRef: overlay },
  })
  const catalogDocs = freeze.frozen.catalogCards.map((ref) => ({
    ref,
    doc: `CARD-DOC-${ref.id}@${ref.version}`,
  }))
  const scenario = {
    taskNarrative: 'SCENARIO-TASK-PAYLOAD',
    environmentNarrative: 'SCENARIO-ENV-PAYLOAD',
  }
  const controlPlaneText = renderControlPlane({
    document: freeze.frozen.document,
    catalogDocs,
    scenario,
  })
  const controlPlaneContentHash = bindControlPlaneText(
    freeze.frozen,
    controlPlaneText,
  )
  const pins = {
    model: 'test-model',
    harness: 'factorio-rlm/v4' as const,
    harnessState: freeze.pins,
    kernelProtocol: '2' as const,
    bindingSet: 'factorio/v3' as const,
    renderer: 'markdown-json/v1' as const,
    isolationProfile: 'local-process-ast/v2' as const,
    milkie: 'test',
    fle: '0.4.3' as const,
    factorioServer: '2.0.73' as const,
    taskId: 'iron_ore_throughput' as const,
    taskDigest: 'sha256:test',
    kernelMemoryBytes: 1,
    kernelCpuSeconds: 1,
  }
  const port = new CapturePort()
  await runHarness({
    runId: 'control-plane-run',
    episodeId: 'control-plane-run:episode:0',
    pins,
    port,
    budget: { deadlineAt: 10_000 },
    control: { deadlineAt: 10_000 },
    frozenHarness: freeze.frozen,
    controlPlaneText,
    controlPlaneContentHash,
    execute: async input => ({
      schema: 'helix.cell-execution/v2',
      cellId: input.cellId,
      source: input.code,
      sourceDigest: 'sha256:cell',
      startRevision: 0,
      endRevision: 1,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      error: {
        code: 'CELL_EXECUTION_ERROR',
        message: 'POLICY_VIOLATION: stop after observing model request',
      },
    }),
  })
  // First model request is enough to observe control-plane injection.
  assert.equal(port.requests.length, 1)
  const observed = port.requests[0]!
  assert.equal(observed.system, controlPlaneText)
  assert.match(String(observed.system), /SYS-BASE-CONTROL/)
  assert.match(String(observed.system), /TASK-BASE-CONTROL/)
  assert.match(String(observed.system), /overlay-protocol-rule-UNIQUE/)
  assert.match(String(observed.system), /overlay-stop-UNIQUE/)
  assert.match(String(observed.system), /CARD-DOC-helix\.models@1\.0\.0/)
  assert.match(String(observed.system), /SPEC-INSTRUCTION-ALPHA/)
  assert.match(String(observed.system), /SCENARIO-TASK-PAYLOAD/)
  assert.match(String(observed.system), /SCENARIO-ENV-PAYLOAD/)
  // Context envelope also carries frozen harness identity.
  const messagesText = JSON.stringify(observed.messages)
  assert.match(messagesText, /harnessContentHash/)
  assert.match(messagesText, new RegExp(freeze.frozen.harnessContentHash))
})

test('review.runHarness-rejects-missing-frozen-selection', async () => {
  await assert.rejects(
    () =>
      runHarness({
        runId: 'no-freeze',
        episodeId: 'no-freeze:episode:0',
        pins: pinsV4('m'),
        port: {
          async invokeLLM() {
            throw new Error('unreachable')
          },
          async invokeTool() {
            throw new Error('unreachable')
          },
          now: () => 0,
          uuid: () => 'u',
        },
        budget: { deadlineAt: 1 },
        control: { deadlineAt: 1 },
        // @ts-expect-error intentional missing freeze
        frozenHarness: undefined,
        // @ts-expect-error intentional missing control plane
        controlPlaneText: undefined,
        execute: async () => {
          throw new Error('unreachable')
        },
      }),
    /frozenHarness|controlPlaneText|source-prompt fallback/,
  )
})

test('review.dual-canonicalizer-independent-encoders-agree', () => {
  const controlChars: Record<string, string> = {}
  for (let c = 0; c < 0x20; c += 1) {
    controlChars[`c${c.toString(16).padStart(2, '0')}`] = String.fromCharCode(c)
  }
  const payload = {
    z: 'solidus/path',
    a: 'café',
    中文: '汉字',
    line: 'a\u2028b\u2029c',
    quote: 'he said "hi"',
    slashBack: 'a\\b',
    ...controlChars,
    nested: {
      m: 0,
      maxSafe: Number.MAX_SAFE_INTEGER,
      budget: { maxCalls: 3, maxOutputTokens: 4096 },
      baseBaselineRef: {
        kind: 'baseline',
        id: 'x',
        revision: 1,
        contentHash: 'ab'.repeat(32),
      },
    },
    arr: [0, 1, Number.MAX_SAFE_INTEGER],
  }
  const primary = canonicalizeHarnessValue(payload)
  const alt = canonicalizeHarnessValueAlt(payload)
  assert.equal(primary, alt)
  assert.equal(harnessContentHash(payload), harnessContentHashAlt(payload))
  const bytes = harnessCanonicalBytes(payload)
  const bytesAlt = harnessCanonicalBytesAlt(payload)
  assert.deepEqual(Array.from(bytes), Array.from(bytesAlt))
  // Solidus is raw 0x2f, never escaped as \/
  const solidusIdx = bytes.indexOf(0x2f)
  assert.ok(solidusIdx >= 0)
  assert.notEqual(bytes[solidusIdx - 1], 0x5c)
  // Independent implementations: alt source must not call primary encode helpers.
  const canonicalSrc = readFileSync(join(HARNESS_SRC, 'canonical.ts'), 'utf8')
  const altFnStart = canonicalSrc.indexOf('export function canonicalizeHarnessValueAlt')
  assert.ok(altFnStart > 0)
  const altFnBody = canonicalSrc.slice(altFnStart, altFnStart + 4500)
  assert.doesNotMatch(altFnBody, /\bencodeString\(/)
  assert.doesNotMatch(altFnBody, /\bencodeNumber\(/)
  assert.match(altFnBody, /encodeStringAlt/)
  assert.match(altFnBody, /encodeNumberAlt/)
})

// ---------------------------------------------------------------------------
// Final review HIGH findings — strict artifact parse, pin identity, durable store
// ---------------------------------------------------------------------------

test('review.readLiveEvidence-strict-json-rejects-duplicate-keys', () => {
  // Top-level duplicate harness key must fail before materialization.
  const topDup = [
    '{',
    '"schema":"helix.factorio.live/v3",',
    '"harness":{"format":"harness/v1"},',
    '"harness":{"format":"harness/v1"},',
    '"pins":{}',
    '}',
  ].join('')
  expectHarnessError(() => parseLiveEvidenceText(topDup), 'HARNESS_JSON_INVALID')

  // Nested ref duplicate id inside baselineRef.
  const nestedRefDup = [
    '{',
    '"schema":"helix.factorio.live/v3",',
    '"pins":{"harnessState":{"baselineRef":{"kind":"baseline","id":"a","id":"b","revision":1,"contentHash":"',
    'ab'.repeat(32),
    '"}}},',
    '"harness":{"format":"harness/v1"}',
    '}',
  ].join('')
  expectHarnessError(() => parseLiveEvidenceText(nestedRefDup), 'HARNESS_JSON_INVALID')

  // Nested overlay changes duplicate protocolRules key.
  const overlayChangesDup = [
    '{',
    '"schema":"helix.factorio.live/v3",',
    '"pins":{"harnessState":{"overlay":{"changes":{"protocolRules":["a"],"protocolRules":["b"]}}}},',
    '"harness":{"format":"harness/v1"}',
    '}',
  ].join('')
  expectHarnessError(
    () => parseLiveEvidenceText(overlayChangesDup),
    'HARNESS_JSON_INVALID',
  )

  // Non-canonical number token on the real CLI parse path.
  expectHarnessError(
    () => parseLiveEvidenceText('{"schema":"helix.factorio.live/v3","n":01}'),
    'HARNESS_JSON_INVALID',
  )

  assert.equal(
    (parseLiveEvidenceText('{"schema":"helix.factorio.live/v3","position":-1.5}') as { position: number }).position,
    -1.5,
  )
})

test('review.replay-rejects-evidence-pins-outer-code-pin-inconsistency', () => {
  const bundle = createFactorioHostBundle()
  const liveAssembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('identity-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  assert.ok(liveAssembled.pins.harnessState)

  // Tamper evidence.harnessContentHash while keeping pins.harnessState intact.
  const tamperedHash = {
    pins: liveAssembled.pins,
    harness: {
      ...liveAssembled.freeze.evidence,
      harnessContentHash: 'ff'.repeat(32),
    },
  }
  expectHarnessError(
    () => reconstructFactorioReplayHarness(tamperedHash, { rootDir: null }),
    'HARNESS_REF_INVALID',
  )

  // Tamper catalogCards order/content on evidence only.
  const tamperedCards = {
    pins: liveAssembled.pins,
    harness: {
      ...liveAssembled.freeze.evidence,
      catalogCards: [
        ...liveAssembled.freeze.evidence.catalogCards,
        { id: 'extra.card', version: '9.9.9' },
      ],
    },
  }
  expectHarnessError(
    () => reconstructFactorioReplayHarness(tamperedCards, { rootDir: null }),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Outer pins.harness codeProtocolPin disagrees with recorded harnessState.
  const outerMismatch = {
    pins: {
      ...liveAssembled.pins,
      harness: 'factorio-rlm/v5' as const,
      harnessState: liveAssembled.pins.harnessState,
    },
    harness: liveAssembled.freeze.evidence,
  }
  expectHarnessError(
    () => reconstructFactorioReplayHarness(outerMismatch, { rootDir: null }),
    'HARNESS_PROTOCOL_INCOMPATIBLE',
  )

  // Only one of evidence / pins.harnessState present is also rejected.
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        { pins: liveAssembled.pins, harness: undefined },
        { rootDir: null },
      ),
    'HARNESS_REF_INVALID',
  )
})

test('review.replay-rejects-legacy-registry-provenance-on-new-format', () => {
  // New-format recorded-pins path must declare selectionSource=recorded.
  // legacy-registry + registryIdentity is legacy-only provenance and must fail
  // closed before Store resolve/effect (L2 §10.1).
  const root = mkdtempSync(join(tmpdir(), 'helix-factorio-legacy-prov-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const liveAssembled = assembleFactorioRun({
      bundle,
      basePins: pinsV4('legacy-prov-model'),
      baselineRef: bundle.defaultBaselineRef,
    })
    assert.ok(liveAssembled.pins.harnessState)
    assert.equal(liveAssembled.freeze.evidence.selectionSource, 'recorded')

    const forgedLegacyProvenance = {
      pins: liveAssembled.pins,
      harness: {
        ...liveAssembled.freeze.evidence,
        selectionSource: 'legacy-registry' as const,
        registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
      },
    }
    expectHarnessError(
      () =>
        reconstructFactorioReplayHarness(forgedLegacyProvenance, {
          rootDir: root,
        }),
      'HARNESS_REF_INVALID',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('review.durable-store-process-boundary-v1-v2-v3-replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-durable-'))
  try {
    const available = freezeAvailableCatalogRefs([CARD_A1])

    // Process / store instance 1: publish V1, V2, V3 and record runs A/B/C.
    const storeLive = new HarnessStateStore({ rootDir: root })
    const v1Ref = storeLive.publishBaseline(makeDocument(), {
      id: 'durable-base',
      revision: 1,
    })
    const runA = selectValidateResolveFreeze({
      store: storeLive,
      availableCatalogRefs: available,
      codeProtocolPin: 'test-pin/v1',
      selection: { baselineRef: v1Ref },
    })
    const v2Ref = storeLive.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'TASK-V2-DURABLE' } }),
      { id: 'durable-base', revision: 2 },
    )
    const runB = selectValidateResolveFreeze({
      store: storeLive,
      availableCatalogRefs: available,
      codeProtocolPin: 'test-pin/v1',
      selection: { baselineRef: v2Ref },
    })
    const v3OverlayRef = storeLive.publishOverlay(
      {
        schemaVersion: 'helix.harness-overlay/v1',
        baseBaselineRef: v2Ref,
        changes: { protocolRules: ['rule-v3-durable'] },
      },
      { id: 'durable-overlay', revision: 1 },
    )
    const runC = selectValidateResolveFreeze({
      store: storeLive,
      availableCatalogRefs: available,
      codeProtocolPin: 'test-pin/v1',
      selection: { baselineRef: v2Ref, overlayRef: v3OverlayRef },
    })

    // Also register a legacy pin into the durable registry.
    const legacyRegistryLive = new LegacySelectionRegistryStore(storeLive, {
      rootDir: root,
    })
    const legacyBase = storeLive.publishBaseline(
      makeDocument({
        control: { taskNarrativeTemplate: 'LEGACY-DURABLE' },
        compatibility: { codeProtocolPins: ['legacy-durable/v1'] },
      }),
      { id: 'legacy-durable', revision: 1 },
    )
    legacyRegistryLive.registerLegacySelection({
      registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
      codeProtocolPin: 'legacy-durable/v1',
      baselineRef: legacyBase,
      baselineContentHash: legacyBase.contentHash,
      schemaVersion: 'helix.harness/v1',
    })

    // Future publish after recording — must not affect historical replay.
    storeLive.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'TASK-FUTURE-DURABLE' } }),
      { id: 'durable-base', revision: 99 },
    )

    // Process / store instance 2: reopen the same durable root only.
    const storeReplay = new HarnessStateStore({ rootDir: root })
    const legacyRegistryReplay = new LegacySelectionRegistryStore(storeReplay, {
      rootDir: root,
    })

    const replayA = replayFromRecordedPins({
      store: storeReplay,
      pins: runA.pins,
      availableCatalogRefs: available,
    })
    const replayB = replayFromRecordedPins({
      store: storeReplay,
      pins: runB.pins,
      availableCatalogRefs: available,
    })
    const replayC = replayFromRecordedPins({
      store: storeReplay,
      pins: runC.pins,
      availableCatalogRefs: available,
    })

    assert.equal(replayA.frozen.harnessContentHash, runA.frozen.harnessContentHash)
    assert.equal(
      replayA.frozen.document.control.taskNarrativeTemplate,
      'TASK-V1',
    )
    assert.equal(replayB.frozen.harnessContentHash, runB.frozen.harnessContentHash)
    assert.equal(
      replayB.frozen.document.control.taskNarrativeTemplate,
      'TASK-V2-DURABLE',
    )
    assert.equal(replayC.frozen.harnessContentHash, runC.frozen.harnessContentHash)
    assert.deepEqual(replayC.frozen.document.control.protocolRules, [
      'rule-v3-durable',
    ])
    assert.equal(replayC.evidence.selectionSource, 'recorded')

    // Legacy registry survives the process boundary without default/source fallback.
    const legacyReplay = replayFromLegacyPin({
      store: storeReplay,
      legacyRegistry: legacyRegistryReplay,
      codeProtocolPin: 'legacy-durable/v1',
      availableCatalogRefs: available,
    })
    assert.equal(
      legacyReplay.frozen.document.control.taskNarrativeTemplate,
      'LEGACY-DURABLE',
    )
    assert.equal(legacyReplay.evidence.selectionSource, 'legacy-registry')

    // Factorio host: live bootstrap publishes custom baseline; replay hydrates only.
    const hostRoot = join(root, 'factorio-host')
    mkdirSync(hostRoot, { recursive: true })
    const hostLive = createFactorioHostBundle({ rootDir: hostRoot })
    const customDoc: HarnessDocument = {
      ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
      control: {
        ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.control,
        taskNarrativeTemplate: 'FACTORIO-CUSTOM-V2',
      },
    }
    const customRef = hostLive.store.publishBaseline(customDoc, {
      id: 'factorio.custom-v2',
      revision: 1,
    })
    const liveCustom = assembleFactorioRun({
      bundle: hostLive,
      basePins: pinsV4('durable-factorio'),
      baselineRef: customRef,
    })
    // Snapshot baseline count after live so replay cannot silently add defaults.
    const liveBaselineCount = hostLive.store.exportSnapshot().baselines.length

    // Reopen via hydrate-only replay host — must not publish current source defaults.
    const hostReplay = openFactorioReplayHost({ rootDir: hostRoot })
    assert.equal(hostReplay.store.exportSnapshot().baselines.length, liveBaselineCount)
    const reconstructed = reconstructFactorioReplayHarness(
      {
        pins: liveCustom.pins,
        harness: liveCustom.freeze.evidence,
      },
      { rootDir: hostRoot },
    )
    assert.equal(
      reconstructed.freeze.frozen.harnessContentHash,
      liveCustom.frozen.harnessContentHash,
    )
    assert.equal(
      reconstructed.freeze.frozen.document.control.taskNarrativeTemplate,
      'FACTORIO-CUSTOM-V2',
    )
    assert.equal(hostReplay.store.read(customRef).kind, 'baseline')
    // Still no extra baselines after reconstruct (no default publish side-effect).
    assert.equal(
      openFactorioReplayHost({ rootDir: hostRoot }).store.exportSnapshot().baselines
        .length,
      liveBaselineCount,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


// ---------------------------------------------------------------------------
// Last-review HIGH/MEDIUM findings — replay hydrate-only + frozen/pins gate
// ---------------------------------------------------------------------------

test('review.replay-hydrate-only-survives-current-default-drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-replay-default-drift-'))
  try {
    // Live process: publish ONLY a custom baseline (no Factorio defaults required).
    const liveStore = new HarnessStateStore({ rootDir: root })
    const customDoc: HarnessDocument = {
      ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
      control: {
        ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.control,
        taskNarrativeTemplate: 'CUSTOM-ONLY-REPLAY',
        systemInstructionTemplate: 'CUSTOM-SYS-ONLY',
      },
    }
    const customRef = liveStore.publishBaseline(customDoc, {
      id: 'factorio.custom-only',
      revision: 1,
    })
    const available = formFactorioAvailableCatalogRefs('factorio-rlm/v4')
    const liveFreeze = selectValidateResolveFreeze({
      store: liveStore,
      availableCatalogRefs: available,
      codeProtocolPin: 'factorio-rlm/v4',
      selection: { baselineRef: customRef },
    })
    const livePins = {
      ...pinsV4('drift-model'),
      harnessState: liveFreeze.pins,
    }
    const liveBaselineIds = liveStore
      .exportSnapshot()
      .baselines.map((b) => `${b.ref.id}@${b.ref.revision}`)
    assert.deepEqual(liveBaselineIds, ['factorio.custom-only@1'])

    // Only custom exists — deliberately do NOT publish current source defaults.
    // openFactorioReplayHost must succeed and reconstruct from recorded custom refs.
    const opened = openFactorioReplayHost({ rootDir: root })
    assert.deepEqual(
      opened.store.exportSnapshot().baselines.map((b) => `${b.ref.id}@${b.ref.revision}`),
      ['factorio.custom-only@1'],
    )
    // createFactorioHostBundle (live bootstrap) would publish defaults — replay must not.
    assert.equal(
      opened.store.exportSnapshot().baselines.some((b) => b.ref.id === 'factorio.default-p1'),
      false,
    )

    const reconstructed = reconstructFactorioReplayHarness(
      {
        pins: livePins,
        harness: liveFreeze.evidence,
      },
      { rootDir: root },
    )
    assert.equal(
      reconstructed.freeze.frozen.document.control.taskNarrativeTemplate,
      'CUSTOM-ONLY-REPLAY',
    )
    assert.equal(
      reconstructed.freeze.frozen.harnessContentHash,
      liveFreeze.frozen.harnessContentHash,
    )
    // Still no default/legacy baselines written by replay.
    const after = openFactorioReplayHost({ rootDir: root }).store.exportSnapshot()
    assert.deepEqual(
      after.baselines.map((b) => `${b.ref.id}@${b.ref.revision}`),
      ['factorio.custom-only@1'],
    )
    assert.equal(after.baselines.some((b) => b.ref.id.startsWith('factorio.legacy-')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.replay-hydrate-only-ignores-poisoned-default-slots', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-replay-poison-default-'))
  try {
    const liveStore = new HarnessStateStore({ rootDir: root })
    const customDoc: HarnessDocument = {
      ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
      control: {
        ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.control,
        taskNarrativeTemplate: 'CUSTOM-BESIDE-POISON',
      },
    }
    const customRef = liveStore.publishBaseline(customDoc, {
      id: 'factorio.custom-beside-poison',
      revision: 1,
    })
    // Poison default-p1 slot with a payload that differs from current source
    // FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT — live bootstrap would drift-throw.
    const poisonedDefault: HarnessDocument = {
      ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
      control: {
        ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.control,
        taskNarrativeTemplate: 'POISONED-CURRENT-DEFAULT',
      },
    }
    liveStore.publishBaseline(poisonedDefault, {
      id: 'factorio.default-p1',
      revision: 1,
    })
    const available = formFactorioAvailableCatalogRefs('factorio-rlm/v4')
    const liveFreeze = selectValidateResolveFreeze({
      store: liveStore,
      availableCatalogRefs: available,
      codeProtocolPin: 'factorio-rlm/v4',
      selection: { baselineRef: customRef },
    })
    const livePins = {
      ...pinsV4('poison-model'),
      harnessState: liveFreeze.pins,
    }

    // Live bootstrap path must refuse the poisoned default slot (hash drift).
    assert.throws(
      () => createFactorioHostBundle({ rootDir: root }),
      /contentHash drift|factorio\.default-p1/,
    )

    // Replay hydrate-only path still reconstructs the recorded custom selection.
    const reconstructed = reconstructFactorioReplayHarness(
      {
        pins: livePins,
        harness: liveFreeze.evidence,
      },
      { rootDir: root },
    )
    assert.equal(
      reconstructed.freeze.frozen.document.control.taskNarrativeTemplate,
      'CUSTOM-BESIDE-POISON',
    )
    assert.equal(
      reconstructed.freeze.frozen.selection.baselineRef.id,
      'factorio.custom-beside-poison',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.runHarness-rejects-frozenHarness-pins-harnessState-mismatch', async () => {
  const bundle = createFactorioHostBundle()
  const assembledA = assembleFactorioRun({
    bundle,
    basePins: pinsV4('gate-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  // Second freeze with a different baseline content → different harnessState.
  const altDoc: HarnessDocument = {
    ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
    control: {
      ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.control,
      taskNarrativeTemplate: 'ALT-SLICE-FOR-MISMATCH',
    },
  }
  const altRef = bundle.store.publishBaseline(altDoc, {
    id: 'factorio.alt-mismatch',
    revision: 1,
  })
  const assembledB = assembleFactorioRun({
    bundle,
    basePins: pinsV4('gate-model'),
    baselineRef: altRef,
  })
  assert.notEqual(
    assembledA.frozen.harnessContentHash,
    assembledB.frozen.harnessContentHash,
  )

  let invoked = false
  await assert.rejects(
    () =>
      runHarness({
        runId: 'mismatch-run',
        episodeId: 'mismatch-run:episode:0',
        // pins from B, frozen slice from A — must fail before model request.
        pins: assembledB.pins,
        frozenHarness: assembledA.frozen,
        controlPlaneText: assembledA.controlPlaneText,
        controlPlaneContentHash: assembledA.controlPlaneContentHash,
        port: {
          async invokeLLM() {
            invoked = true
            throw new Error('model must not be invoked on pin mismatch')
          },
          async invokeTool() {
            throw new Error('unreachable')
          },
          now: () => 0,
          uuid: () => 'u',
        },
        budget: { deadlineAt: 1 },
        control: { deadlineAt: 1 },
        execute: async () => {
          throw new Error('unreachable')
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, String(error))
      assert.equal(error.code, 'HARNESS_REF_INVALID')
      assert.match(error.message, /harnessContentHash mismatch|frozenHarness-vs-pins/)
      return true
    },
  )
  assert.equal(invoked, false)
})

// ---------------------------------------------------------------------------
// Approval-review findings — pin-bound available cards + closed freeze schema
// ---------------------------------------------------------------------------

test('review.formFactorioAvailableCatalogRefs-v4-excludes-session', () => {
  const v4 = formFactorioAvailableCatalogRefs('factorio-rlm/v4')
  const v5 = formFactorioAvailableCatalogRefs('factorio-rlm/v5')
  assert.deepEqual(
    v4.map((c) => `${c.id}@${c.version}`),
    ['helix.models@1.0.0'],
  )
  assert.deepEqual(
    [...v5.map((c) => `${c.id}@${c.version}`)].sort(),
    ['helix.models@1.0.0', 'helix.session@1.0.0'],
  )
  assert.equal(
    v4.some((c) => c.id === 'helix.session'),
    false,
    'v4 must not admit helix.session',
  )
})

test('review.v4-default-baseline-has-no-session-card', () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('m'),
    baselineRef: bundle.defaultBaselineRef,
  })
  assert.deepEqual(
    assembled.frozen.catalogCards.map((c) => `${c.id}@${c.version}`),
    ['helix.models@1.0.0'],
  )
  assert.deepEqual(
    assembled.frozen.availableCatalogRefs.map((c) => `${c.id}@${c.version}`),
    ['helix.models@1.0.0'],
  )
  assert.equal(assembled.controlPlaneText.includes('helix.session'), false)
  assert.equal(
    FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.compatibility.codeProtocolPins.includes(
      'factorio-rlm/v5',
    ),
    false,
  )
})

test('review.v4-rejects-session-card-baseline', () => {
  const bundle = createFactorioHostBundle()
  // v4 available set excludes helix.session, so the v5 session baseline is rejected.
  expectHarnessError(
    () =>
      assembleFactorioRun({
        bundle,
        basePins: pinsV4('m'),
        baselineRef: bundle.legacyV5BaselineRef,
      }),
    'HARNESS_CATALOG_NOT_AVAILABLE',
  )
  // default-p1 is models-only / v4-compatible; v5 pin is protocol-incompatible.
  expectHarnessError(
    () =>
      assembleFactorioRun({
        bundle,
        basePins: pinsSessionAsync('m'),
        baselineRef: bundle.defaultBaselineRef,
      }),
    'HARNESS_PROTOCOL_INCOMPATIBLE',
  )
})

test('review.v5-available-admits-session-and-renders-card', () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsSessionAsync('m'),
    baselineRef: bundle.legacyV5BaselineRef,
  })
  assert.deepEqual(
    [...assembled.frozen.availableCatalogRefs.map((c) => `${c.id}@${c.version}`)].sort(),
    ['helix.models@1.0.0', 'helix.session@1.0.0'],
  )
  assert.ok(
    assembled.frozen.catalogCards.some(
      (c) => c.id === 'helix.session' && c.version === '1.0.0',
    ),
  )
  assert.match(assembled.controlPlaneText, /helix\.session/)
})

test('review.freezeAvailableCatalogRefs-closed-schema-and-dedupe', () => {
  // Valid closed refs freeze + dedupe by (id, version).
  const frozen = freezeAvailableCatalogRefs([
    CARD_A1,
    { id: 'helix.models', version: '1.0.0' },
    CARD_B1,
    CARD_A1,
  ])
  assert.deepEqual(
    frozen.map((c) => `${c.id}@${c.version}`),
    ['helix.models@1.0.0', 'helix.session@1.0.0'],
  )
  assert.equal(Object.isFrozen(frozen), true)

  // Extra field is rejected before dedupe.
  expectHarnessError(
    () =>
      freezeAvailableCatalogRefs([
        { id: 'helix.models', version: '1.0.0', unexpected: true } as unknown as CatalogCardRef,
      ]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  // Empty id/version rejected.
  expectHarnessError(
    () => freezeAvailableCatalogRefs([{ id: '', version: '1.0.0' }]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  expectHarnessError(
    () => freezeAvailableCatalogRefs([{ id: 'helix.models', version: '' }]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  // Wrong types rejected.
  expectHarnessError(
    () => freezeAvailableCatalogRefs([{ id: 1, version: '1.0.0' } as unknown as CatalogCardRef]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  expectHarnessError(
    () => freezeAvailableCatalogRefs(['helix.models@1.0.0'] as unknown as CatalogCardRef[]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  expectHarnessError(
    () => freezeAvailableCatalogRefs(null as unknown as CatalogCardRef[]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  // Missing fields rejected.
  expectHarnessError(
    () => freezeAvailableCatalogRefs([{ id: 'helix.models' } as unknown as CatalogCardRef]),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  // selectValidateResolveFreeze inherits the same gate.
  const store = new HarnessStateStore()
  const baselineRef = store.publishBaseline(makeDocument(), {
    id: 'freeze-gate',
    revision: 1,
  })
  expectHarnessError(
    () =>
      selectValidateResolveFreeze({
        store,
        availableCatalogRefs: [
          { id: 'helix.models', version: '1.0.0', extra: 'nope' } as unknown as CatalogCardRef,
        ],
        codeProtocolPin: 'test-pin/v1',
        selection: { baselineRef },
      }),
    'HARNESS_CATALOG_UNRESOLVED',
  )
})

// ---------------------------------------------------------------------------
// Ship-review findings — durable atomic publish + control-plane binding
// ---------------------------------------------------------------------------

test('review.durable-store-concurrent-same-key-one-winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-cas-same-'))
  try {
    const script = `
import { HarnessStateStore } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/store.ts'))};
import { harnessError, HarnessError } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/errors.ts'))};
const root = process.env.HARNESS_ROOT;
const tag = process.env.PUBLISH_TAG;
const store = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true });
const doc = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: 'SYS-' + tag,
    taskNarrativeTemplate: 'TASK-' + tag,
    protocolRules: ['rule-' + tag],
    termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
  },
  catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
  compatibility: { codeProtocolPins: ['test-pin/v1'] },
};
try {
  const ref = store.publishBaseline(doc, { id: 'cas-same', revision: 1 });
  process.stdout.write(JSON.stringify({ ok: true, ref, tag }));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
  process.stdout.write(JSON.stringify({ ok: false, code: String(code), message: String(error && error.message || error), tag }));
  process.exitCode = 0;
}
`
    const runChild = (tag: string) =>
      new Promise<{
        ok: boolean
        code?: string
        tag: string
        ref?: HarnessStateRef
        message?: string
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '-e', script],
          {
            env: { ...process.env, HARNESS_ROOT: root, PUBLISH_TAG: tag },
            cwd: REPO_ROOT,
          },
        )
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
          out += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          err += String(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (!out.trim()) {
            reject(new Error(`child ${tag} empty stdout (exit ${code}): ${err}`))
            return
          }
          try {
            resolve(JSON.parse(out.trim()))
          } catch (error) {
            reject(
              new Error(`child ${tag} bad json: ${out} / ${err} / ${String(error)}`),
            )
          }
        })
      })

    const [a, b] = await Promise.all([runChild('ALPHA'), runChild('BETA')])
    const winners = [a, b].filter((r) => r.ok)
    const losers = [a, b].filter((r) => !r.ok)
    assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify([a, b])}`)
    assert.equal(losers.length, 1, `expected exactly one loser, got ${JSON.stringify([a, b])}`)
    assert.equal(losers[0]!.code, 'HARNESS_REF_INVALID')
    assert.match(String(losers[0]!.message ?? ''), /immutable|already exists/i)

    const reopened = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const stored = reopened.read({
      kind: 'baseline',
      id: 'cas-same',
      revision: 1,
      contentHash: winners[0]!.ref!.contentHash,
    })
    assert.equal(stored.kind, 'baseline')
    if (stored.kind === 'baseline') {
      assert.equal(
        stored.document.control.taskNarrativeTemplate,
        `TASK-${winners[0]!.tag}`,
      )
    }
    // Loser payload must not be readable under any contentHash guess from loser tag.
    const loserDoc = makeDocument({
      control: {
        systemInstructionTemplate: `SYS-${losers[0]!.tag}`,
        taskNarrativeTemplate: `TASK-${losers[0]!.tag}`,
        protocolRules: [`rule-${losers[0]!.tag}`],
      },
    })
    const loserHash = baselineContentHash(loserDoc)
    assert.notEqual(loserHash, winners[0]!.ref!.contentHash)
    expectHarnessError(
      () =>
        reopened.read({
          kind: 'baseline',
          id: 'cas-same',
          revision: 1,
          contentHash: loserHash,
        }),
      'HARNESS_REF_INVALID',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.durable-store-concurrent-different-keys-both-persist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-cas-diff-'))
  try {
    const script = `
import { HarnessStateStore } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/store.ts'))};
const root = process.env.HARNESS_ROOT;
const id = process.env.PUBLISH_ID;
const store = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true });
const doc = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: 'SYS-' + id,
    taskNarrativeTemplate: 'TASK-' + id,
    protocolRules: ['rule'],
    termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
  },
  catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
  compatibility: { codeProtocolPins: ['test-pin/v1'] },
};
const ref = store.publishBaseline(doc, { id, revision: 1 });
process.stdout.write(JSON.stringify({ ok: true, ref }));
`
    const runChild = (id: string) =>
      new Promise<{ ok: boolean; ref: HarnessStateRef }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '-e', script],
          {
            env: { ...process.env, HARNESS_ROOT: root, PUBLISH_ID: id },
            cwd: REPO_ROOT,
          },
        )
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
          out += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          err += String(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (!out.trim()) {
            reject(new Error(`child ${id} empty stdout (exit ${code}): ${err}`))
            return
          }
          resolve(JSON.parse(out.trim()))
        })
      })

    const [a, b] = await Promise.all([runChild('key-a'), runChild('key-b')])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)

    const reopened = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    assert.equal(reopened.read(a.ref).kind, 'baseline')
    assert.equal(reopened.read(b.ref).kind, 'baseline')
    const snap = reopened.exportSnapshot()
    assert.equal(
      snap.baselines.some((e) => e.ref.id === 'key-a' && e.ref.revision === 1),
      true,
    )
    assert.equal(
      snap.baselines.some((e) => e.ref.id === 'key-b' && e.ref.revision === 1),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.durable-store-persist-failure-leaves-no-ref', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-cas-fail-'))
  try {
    const store = new HarnessStateStore({
      rootDir: root,
      skipRegistryLookup: true,
      durableWriter: () => {
        throw new Error('simulated durable write failure')
      },
    })
    const doc = makeDocument({
      control: { taskNarrativeTemplate: 'TASK-FAIL-PERSIST' },
    })
    assert.throws(
      () => store.publishBaseline(doc, { id: 'fail-persist', revision: 1 }),
      /simulated durable write failure/,
    )
    // Current instance must not expose the half-written ref.
    const contentHash = baselineContentHash(doc)
    expectHarnessError(
      () =>
        store.read({
          kind: 'baseline',
          id: 'fail-persist',
          revision: 1,
          contentHash,
        }),
      'HARNESS_REF_INVALID',
    )
    assert.equal(
      store.exportSnapshot().baselines.some(
        (e) => e.ref.id === 'fail-persist' && e.ref.revision === 1,
      ),
      false,
    )
    // Reopened store must also lack the ref.
    const reopened = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    expectHarnessError(
      () =>
        reopened.read({
          kind: 'baseline',
          id: 'fail-persist',
          revision: 1,
          contentHash,
        }),
      'HARNESS_REF_INVALID',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.legacy-registry-concurrent-same-pin-one-winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-legacy-cas-'))
  try {
    // Seed two different baselines first (sequential) so registry race is isolated.
    const seed = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const baseA = seed.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'LEG-A' } }),
      { id: 'leg-a', revision: 1 },
    )
    const baseB = seed.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'LEG-B' } }),
      { id: 'leg-b', revision: 1 },
    )

    const script = `
import { HarnessStateStore } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/store.ts'))};
import { LegacySelectionRegistryStore, LEGACY_SELECTION_REGISTRY_IDENTITY } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/legacy.ts'))};
const root = process.env.HARNESS_ROOT;
const baselineRef = JSON.parse(process.env.BASELINE_REF);
const store = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true });
const registry = new LegacySelectionRegistryStore(store, { rootDir: root });
try {
  const entry = registry.registerLegacySelection({
    registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
    codeProtocolPin: 'legacy-race/v1',
    baselineRef,
    baselineContentHash: baselineRef.contentHash,
    schemaVersion: 'helix.harness/v1',
  });
  process.stdout.write(JSON.stringify({ ok: true, baselineId: entry.baselineRef.id }));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
  process.stdout.write(JSON.stringify({ ok: false, code: String(code), message: String(error && error.message || error) }));
}
`
    const runChild = (baselineRef: HarnessStateRef) =>
      new Promise<{ ok: boolean; code?: string; baselineId?: string; message?: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '-e', script],
            {
              env: {
                ...process.env,
                HARNESS_ROOT: root,
                BASELINE_REF: JSON.stringify(baselineRef),
              },
              cwd: REPO_ROOT,
            },
          )
          let out = ''
          let err = ''
          child.stdout.on('data', (chunk) => {
            out += String(chunk)
          })
          child.stderr.on('data', (chunk) => {
            err += String(chunk)
          })
          child.on('error', reject)
          child.on('close', (code) => {
            if (!out.trim()) {
              reject(new Error(`legacy child empty stdout (exit ${code}): ${err}`))
              return
            }
            resolve(JSON.parse(out.trim()))
          })
        },
      )

    const [a, b] = await Promise.all([runChild(baseA), runChild(baseB)])
    const winners = [a, b].filter((r) => r.ok)
    const losers = [a, b].filter((r) => !r.ok)
    assert.equal(winners.length, 1, JSON.stringify([a, b]))
    assert.equal(losers.length, 1, JSON.stringify([a, b]))
    assert.equal(losers[0]!.code, 'HARNESS_NONDETERMINISTIC_SELECTION')

    const reopenedStore = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const reopenedReg = new LegacySelectionRegistryStore(reopenedStore, { rootDir: root })
    const entry = reopenedReg.resolveLegacySelection('legacy-race/v1')
    assert.equal(entry.baselineRef.id, winners[0]!.baselineId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.runHarness-rejects-forged-controlPlaneText-before-llm', async () => {
  const bundle = createFactorioHostBundle()
  const assembledA = assembleFactorioRun({
    bundle,
    basePins: pinsV4('gate-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  const altDoc: HarnessDocument = {
    ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT,
    control: {
      ...FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT.control,
      taskNarrativeTemplate: 'FORGED-CONTROL-PLANE-BASELINE',
    },
  }
  const altRef = bundle.store.publishBaseline(altDoc, {
    id: 'factorio.forged-control-plane',
    revision: 1,
  })
  const assembledB = assembleFactorioRun({
    bundle,
    basePins: pinsV4('gate-model'),
    baselineRef: altRef,
  })
  assert.notEqual(assembledA.controlPlaneText, assembledB.controlPlaneText)
  assert.equal(
    assembledA.frozen.harnessContentHash !== assembledB.frozen.harnessContentHash,
    true,
  )

  // Valid bound path: host assembly bundle is accepted and reaches the model.
  let validInvoked = false
  const validPort = {
    async invokeLLM(request: ModelRequest) {
      validInvoked = true
      assert.equal(request.system, assembledA.controlPlaneText)
      return {
        content: [{ type: 'text', text: 'stop' }],
        toolCalls: [],
        finishReason: 'end_turn' as const,
      }
    },
    async invokeTool() {
      throw new Error('unreachable')
    },
    now: () => 0,
    uuid: () => 'u',
  }
  await runHarness({
    runId: 'bound-valid',
    episodeId: 'bound-valid:episode:0',
    pins: assembledA.pins,
    frozenHarness: assembledA.frozen,
    controlPlaneText: assembledA.controlPlaneText,
    controlPlaneContentHash: assembledA.controlPlaneContentHash,
    port: validPort,
    budget: { deadlineAt: 1 },
    control: { deadlineAt: 1 },
    execute: async () => {
      throw new Error('unreachable')
    },
  })
  assert.equal(validInvoked, true)

  // Forged / swapped control plane with matching frozen+pins must fail before LLM.
  let forgedInvoked = false
  await assert.rejects(
    () =>
      runHarness({
        runId: 'bound-forged',
        episodeId: 'bound-forged:episode:0',
        pins: assembledA.pins,
        frozenHarness: assembledA.frozen,
        // Text from another baseline (or arbitrary) while freeze/pins stay on A.
        controlPlaneText: assembledB.controlPlaneText,
        controlPlaneContentHash: assembledA.controlPlaneContentHash,
        port: {
          async invokeLLM() {
            forgedInvoked = true
            throw new Error('model must not be invoked on forged control plane')
          },
          async invokeTool() {
            throw new Error('unreachable')
          },
          now: () => 0,
          uuid: () => 'u',
        },
        budget: { deadlineAt: 1 },
        control: { deadlineAt: 1 },
        execute: async () => {
          throw new Error('unreachable')
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, String(error))
      assert.equal(error.code, 'HARNESS_REF_INVALID')
      assert.match(error.message, /controlPlane|control-plane|binding/i)
      return true
    },
  )
  assert.equal(forgedInvoked, false)

  // Arbitrary attacker text with a self-consistent hash still fails when it is not
  // the host-bound hash for this frozen slice.
  const arbitrary = 'ARBITRARY-FORGED-SYSTEM-POLICY'
  const arbitraryHash = createHash('sha256').update(arbitrary, 'utf8').digest('hex')
  let arbitraryInvoked = false
  await assert.rejects(
    () =>
      runHarness({
        runId: 'bound-arbitrary',
        episodeId: 'bound-arbitrary:episode:0',
        pins: assembledA.pins,
        frozenHarness: assembledA.frozen,
        controlPlaneText: arbitrary,
        controlPlaneContentHash: arbitraryHash,
        port: {
          async invokeLLM() {
            arbitraryInvoked = true
            throw new Error('model must not be invoked on arbitrary control plane')
          },
          async invokeTool() {
            throw new Error('unreachable')
          },
          now: () => 0,
          uuid: () => 'u',
        },
        budget: { deadlineAt: 1 },
        control: { deadlineAt: 1 },
        execute: async () => {
          throw new Error('unreachable')
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, String(error))
      assert.equal(error.code, 'HARNESS_REF_INVALID')
      return true
    },
  )
  assert.equal(arbitraryInvoked, false)
})

// ---------------------------------------------------------------------------
// Final HIGH findings — lock safety + control-plane write-once binding
// ---------------------------------------------------------------------------

test('review.live-lock-older-than-stale-threshold-not-reclaimed-store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-live-lock-store-'))
  try {
    // Seed a durable entry that must survive a competing publisher.
    const seed = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const seeded = seed.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'SEED-LIVE-LOCK' } }),
      { id: 'seed-live', revision: 1 },
    )

    const lockPath = durableStoreLockPath(root)
    mkdirSync(root, { recursive: true })
    // Live owner (this process) with mtime older than the historical 30s stale window.
    writeFileSync(lockPath, `${process.pid}\n${Date.now() - 120_000}\n`, 'utf8')
    const aged = (Date.now() - 120_000) / 1000
    utimesSync(lockPath, aged, aged)
    assert.equal(existsSync(lockPath), true)

    const script = `
import { HarnessStateStore } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/store.ts'))};
const root = process.env.HARNESS_ROOT;
const store = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true });
try {
  const ref = store.publishBaseline({
    schemaVersion: 'helix.harness/v1',
    control: {
      systemInstructionTemplate: 'SYS',
      taskNarrativeTemplate: 'COMPETE-LIVE-LOCK',
      protocolRules: ['rule'],
      termination: { successSource: 'scenario-verifier', stopConditions: ['done'] },
    },
    catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
    compatibility: { codeProtocolPins: ['test-pin/v1'] },
  }, { id: 'compete-live', revision: 1 });
  process.stdout.write(JSON.stringify({ ok: true, ref }));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
  process.stdout.write(JSON.stringify({
    ok: false,
    code: String(code),
    message: String(error && error.message || error),
  }));
}
`
    const childResult = await new Promise<{
      ok: boolean
      code?: string
      message?: string
      ref?: HarnessStateRef
    }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
        env: {
          ...process.env,
          HARNESS_ROOT: root,
          HELIX_HARNESS_LOCK_MAX_WAIT_MS: '400',
        },
        cwd: REPO_ROOT,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        err += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (!out.trim()) {
          reject(new Error(`live-lock child empty stdout (exit ${code}): ${err}`))
          return
        }
        resolve(JSON.parse(out.trim()))
      })
    })

    assert.equal(childResult.ok, false, JSON.stringify(childResult))
    assert.equal(childResult.code, 'HARNESS_REF_INVALID')
    assert.match(String(childResult.message ?? ''), /timed out acquiring durable harness lock/i)

    // Live lock must still be present (not unlinked merely for age).
    assert.equal(existsSync(lockPath), true)
    const lockBody = readFileSync(lockPath, 'utf8')
    assert.match(lockBody, new RegExp(`^${process.pid}\\n`))

    // Existing successful entry must remain readable and unaltered.
    const reopened = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const stored = reopened.read(seeded)
    assert.equal(stored.kind, 'baseline')
    if (stored.kind === 'baseline') {
      assert.equal(stored.document.control.taskNarrativeTemplate, 'SEED-LIVE-LOCK')
    }
    assert.equal(
      reopened.exportSnapshot().baselines.some(
        (e) => e.ref.id === 'compete-live' && e.ref.revision === 1,
      ),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.live-lock-older-than-stale-threshold-not-reclaimed-registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-live-lock-reg-'))
  try {
    const seedStore = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const baselineRef = seedStore.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'REG-SEED' } }),
      { id: 'reg-seed', revision: 1 },
    )
    const seedReg = new LegacySelectionRegistryStore(seedStore, { rootDir: root })
    seedReg.registerLegacySelection({
      registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
      codeProtocolPin: 'live-lock-reg/v1',
      baselineRef,
      baselineContentHash: baselineRef.contentHash,
      schemaVersion: 'helix.harness/v1',
    })

    const lockPath = durableLegacyRegistryLockPath(root)
    writeFileSync(lockPath, `${process.pid}\n${Date.now() - 120_000}\n`, 'utf8')
    const aged = (Date.now() - 120_000) / 1000
    utimesSync(lockPath, aged, aged)

    const alt = seedStore.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'REG-ALT' } }),
      { id: 'reg-alt', revision: 1 },
    )

    const script = `
import { HarnessStateStore } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/store.ts'))};
import { LegacySelectionRegistryStore, LEGACY_SELECTION_REGISTRY_IDENTITY } from ${JSON.stringify(join(REPO_ROOT, 'src/harness/legacy.ts'))};
const root = process.env.HARNESS_ROOT;
const baselineRef = JSON.parse(process.env.BASELINE_REF);
const store = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true });
const registry = new LegacySelectionRegistryStore(store, { rootDir: root });
try {
  const entry = registry.registerLegacySelection({
    registryIdentity: { ...LEGACY_SELECTION_REGISTRY_IDENTITY },
    codeProtocolPin: 'live-lock-reg-compete/v1',
    baselineRef,
    baselineContentHash: baselineRef.contentHash,
    schemaVersion: 'helix.harness/v1',
  });
  process.stdout.write(JSON.stringify({ ok: true, pin: entry.codeProtocolPin }));
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN';
  process.stdout.write(JSON.stringify({
    ok: false,
    code: String(code),
    message: String(error && error.message || error),
  }));
}
`
    const childResult = await new Promise<{
      ok: boolean
      code?: string
      message?: string
    }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
        env: {
          ...process.env,
          HARNESS_ROOT: root,
          BASELINE_REF: JSON.stringify(alt),
          HELIX_HARNESS_LOCK_MAX_WAIT_MS: '400',
        },
        cwd: REPO_ROOT,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        err += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (!out.trim()) {
          reject(new Error(`live-lock registry child empty stdout (exit ${code}): ${err}`))
          return
        }
        resolve(JSON.parse(out.trim()))
      })
    })

    assert.equal(childResult.ok, false, JSON.stringify(childResult))
    assert.equal(childResult.code, 'HARNESS_REF_INVALID')
    assert.match(String(childResult.message ?? ''), /timed out acquiring durable harness lock/i)
    assert.equal(existsSync(lockPath), true)

    const reopenedStore = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const reopenedReg = new LegacySelectionRegistryStore(reopenedStore, { rootDir: root })
    const entry = reopenedReg.resolveLegacySelection('live-lock-reg/v1')
    assert.equal(entry.baselineRef.id, 'reg-seed')
    expectHarnessError(
      () => reopenedReg.resolveLegacySelection('live-lock-reg-compete/v1'),
      'HARNESS_LEGACY_SELECTION_UNAVAILABLE',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.dead-owner-lock-is-reclaimed-for-publish', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-dead-lock-'))
  try {
    const seed = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    seed.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'BEFORE-DEAD-RECLAIM' } }),
      { id: 'before-dead', revision: 1 },
    )

    const lockPath = durableStoreLockPath(root)
    // PID 2^22+ is extremely unlikely to be alive; kill(pid,0) should fail.
    const deadPid = 4_000_000 + ((process.pid + 17) % 1000)
    writeFileSync(lockPath, `${deadPid}\n${Date.now() - 5_000}\n`, 'utf8')

    const store = new HarnessStateStore({ rootDir: root, skipRegistryLookup: true })
    const ref = store.publishBaseline(
      makeDocument({ control: { taskNarrativeTemplate: 'AFTER-DEAD-RECLAIM' } }),
      { id: 'after-dead', revision: 1 },
    )
    assert.equal(ref.id, 'after-dead')
    assert.equal(store.read(ref).kind, 'baseline')
    assert.equal(existsSync(lockPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.release-durable-lock-is-owner-token-safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-harness-lock-token-'))
  try {
    const lockPath = durableStoreLockPath(root)
    const first = acquireDurableLockSync(lockPath)
    releaseDurableLockSync(first)
    assert.equal(existsSync(lockPath), false)

    const second = acquireDurableLockSync(lockPath)
    // Foreign/stale handle with wrong owner token must not unlink the live lock.
    const staleClone = {
      lockPath: second.lockPath,
      fd: -1,
      token: `${process.pid}-foreign-${Date.now()}`,
    }
    releaseDurableLockSync(staleClone as typeof second)
    assert.equal(existsSync(lockPath), true)
    assert.match(readFileSync(lockPath, 'utf8'), new RegExp(`^${process.pid}\\n`))

    releaseDurableLockSync(second)
    assert.equal(existsSync(lockPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review.control-plane-binding-write-once-rejects-forged-rebind', async () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('gate-model'),
    baselineRef: bundle.defaultBaselineRef,
  })

  // Idempotent re-bind of the same Host text is allowed.
  const again = bindControlPlaneText(assembled.frozen, assembled.controlPlaneText)
  assert.equal(again, assembled.controlPlaneContentHash)

  const forgedText = `${assembled.controlPlaneText}\n# FORGED-REBIND`
  assert.notEqual(forgedText, assembled.controlPlaneText)
  assert.throws(
    () => bindControlPlaneText(assembled.frozen, forgedText),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, String(error))
      assert.equal(error.code, 'HARNESS_REF_INVALID')
      assert.match(error.message, /write-once|already bound|control-plane binding/i)
      return true
    },
  )

  // Original binding must remain; forged text + matching forged hash still fails before LLM.
  const forgedHash = createHash('sha256').update(forgedText, 'utf8').digest('hex')
  let forgedInvoked = false
  await assert.rejects(
    () =>
      runHarness({
        runId: 'write-once-forged',
        episodeId: 'write-once-forged:episode:0',
        pins: assembled.pins,
        frozenHarness: assembled.frozen,
        controlPlaneText: forgedText,
        controlPlaneContentHash: forgedHash,
        port: {
          async invokeLLM() {
            forgedInvoked = true
            throw new Error('model must not be invoked after forged rebind attempt')
          },
          async invokeTool() {
            throw new Error('unreachable')
          },
          now: () => 0,
          uuid: () => 'u',
        },
        budget: { deadlineAt: 1 },
        control: { deadlineAt: 1 },
        execute: async () => {
          throw new Error('unreachable')
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, String(error))
      assert.equal(error.code, 'HARNESS_REF_INVALID')
      assert.match(error.message, /controlPlane|control-plane|binding/i)
      return true
    },
  )
  assert.equal(forgedInvoked, false)

  // Honest Host binding still works after the rejected rebind attempt.
  let validInvoked = false
  await runHarness({
    runId: 'write-once-valid',
    episodeId: 'write-once-valid:episode:0',
    pins: assembled.pins,
    frozenHarness: assembled.frozen,
    controlPlaneText: assembled.controlPlaneText,
    controlPlaneContentHash: assembled.controlPlaneContentHash,
    port: {
      async invokeLLM(request: ModelRequest) {
        validInvoked = true
        assert.equal(request.system, assembled.controlPlaneText)
        return {
          content: [{ type: 'text', text: 'stop' }],
          toolCalls: [],
          finishReason: 'end_turn' as const,
        }
      },
      async invokeTool() {
        throw new Error('unreachable')
      },
      now: () => 0,
      uuid: () => 'u',
    },
    budget: { deadlineAt: 1 },
    control: { deadlineAt: 1 },
    execute: async () => {
      throw new Error('unreachable')
    },
  })
  assert.equal(validInvoked, true)
})


// ---------------------------------------------------------------------------
// Review remediation B1/B2 — real child inheritance + closed replay pins
// ---------------------------------------------------------------------------

test('review.B1.recursive-child-inherits-parent-frozen-slice-before-llm', async () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('child-inherit-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  assert.ok(assembled.pins.harnessState)

  let factorySawHarness = false
  let llmInvoked = false
  let observedChildHash: string | undefined
  let observedChildStateHash: string | undefined

  const childPortFactory: ChildPortFactory = async args => {
    factorySawHarness = args.frozenHarness !== undefined && args.harnessState !== undefined
    assert.ok(args.frozenHarness)
    assert.ok(args.harnessState)
    assert.equal(args.frozenHarness.harnessContentHash, assembled.frozen.harnessContentHash)
    assert.equal(args.harnessState.harnessContentHash, assembled.frozen.harnessContentHash)
    assert.deepEqual(args.harnessState.baselineRef, assembled.frozen.selection.baselineRef)
    assert.deepEqual(args.harnessState.catalogCards, assembled.frozen.catalogCards)
    assert.deepEqual(
      args.harnessState.compatibilityDecision,
      assembled.frozen.compatibilityDecision,
    )
    observedChildHash = args.frozenHarness.harnessContentHash
    observedChildStateHash = args.harnessState.harnessContentHash
    const port = {
      async invokeLLM(request: ModelRequest): Promise<ModelResponse> {
        llmInvoked = true
        const meta = (request.metadata ?? {}) as Record<string, unknown>
        assert.equal(meta['harnessContentHash'], assembled.frozen.harnessContentHash)
        const hs = meta['harnessState'] as { harnessContentHash?: string } | undefined
        assert.equal(hs?.harnessContentHash, assembled.frozen.harnessContentHash)
        return {
          content: [{ type: 'text', text: 'child-ok' }],
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'end_turn',
        }
      },
      async invokeTool(): Promise<unknown> {
        throw new Error('not used')
      },
      now: () => Date.now(),
      uuid: () => '00000000-0000-4000-8000-000000000099',
    }
    const handle: ChildPortHandle = {
      port,
      attached: true,
      detach: async () => undefined,
    }
    return handle
  }

  class TestableExecutor extends LiveCellExecutor {
    async callModels(params: Record<string, unknown>, cellId = 'cell-0') {
      const handle = (
        this as unknown as {
          handleModelsCall: (
            frame: Record<string, unknown>,
            cellId: string,
          ) => Promise<{ result: unknown; modelEffect: unknown }>
        }
      ).handleModelsCall.bind(this)
      return handle({ method: 'models.call', params }, cellId)
    }
  }

  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor(
    'parent-b1',
    'parent-b1:episode:0',
    assembled.pins,
    store,
    {
      recursiveModelEnabled: true,
      recursiveTokenPool: 2000,
      frozenHarness: assembled.frozen,
      childPortFactory,
    },
  )
  const { result } = await executor.callModels({ instructions: 'advise next action' })
  assert.equal((result as { status: string }).status, 'succeeded')
  assert.equal(factorySawHarness, true)
  assert.equal(llmInvoked, true)
  assert.equal(observedChildHash, assembled.frozen.harnessContentHash)
  assert.equal(observedChildStateHash, assembled.frozen.harnessContentHash)
  assert.deepEqual(executor.childRunIds, ['parent-b1:rmc:0'])
})

test('review.B1.recursive-child-rejects-harnessState-drift-before-llm', async () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('child-drift-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  assert.ok(assembled.pins.harnessState)

  // Deliberately drift recorded pins.harnessState while keeping frozen parent slice.
  const driftedPins = {
    ...assembled.pins,
    harnessState: {
      ...assembled.pins.harnessState!,
      harnessContentHash: '0'.repeat(64),
    },
  }

  let llmInvoked = false
  let factoryCalled = false
  const childPortFactory: ChildPortFactory = async () => {
    factoryCalled = true
    return {
      port: {
        async invokeLLM() {
          llmInvoked = true
          throw new Error('child LLM must not run on harness drift')
        },
        async invokeTool() {
          throw new Error('not used')
        },
        now: () => 0,
        uuid: () => 'u',
      },
      attached: true,
      detach: async () => undefined,
    }
  }

  class TestableExecutor extends LiveCellExecutor {
    async callModels(params: Record<string, unknown>, cellId = 'cell-0') {
      const handle = (
        this as unknown as {
          handleModelsCall: (
            frame: Record<string, unknown>,
            cellId: string,
          ) => Promise<{ result: unknown; modelEffect: unknown }>
        }
      ).handleModelsCall.bind(this)
      return handle({ method: 'models.call', params }, cellId)
    }
  }

  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor(
    'parent-drift',
    'parent-drift:episode:0',
    driftedPins,
    store,
    {
      recursiveModelEnabled: true,
      recursiveTokenPool: 2000,
      frozenHarness: assembled.frozen,
      childPortFactory,
    },
  )

  await assert.rejects(
    () => executor.callModels({ instructions: 'should fail closed before child llm' }),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError, String(error))
      assert.equal(error.code, 'HARNESS_CHILD_SELECTION_DRIFT')
      return true
    },
  )
  assert.equal(factoryCalled, false)
  assert.equal(llmInvoked, false)
  assert.equal(executor.recursiveProviderCalls, 0)
  assert.deepEqual(executor.childRunIds, [])
})

test('review.B2.normalizePinsV1-rejects-closed-schema-violations', () => {
  const bundle = createFactorioHostBundle()
  const assembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('pins-closed-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  const good = assembled.pins.harnessState!
  // Positive path still accepts honest pins.
  assert.equal(normalizePinsV1(good).harnessContentHash, good.harnessContentHash)

  // Unknown top-level key.
  expectHarnessError(
    () => normalizePinsV1({ ...good, extraTop: true }),
    'HARNESS_REF_INVALID',
  )

  // Nested unknown field on baselineRef.
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        baselineRef: { ...good.baselineRef, extra: 1 },
      }),
    'HARNESS_REF_INVALID',
  )

  // Nested unknown field on catalogCards entry.
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        catalogCards: good.catalogCards.map((c) => ({ ...c, extra: 'x' })),
      }),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Nested unknown field on compatibilityDecision.
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        compatibilityDecision: {
          ...good.compatibilityDecision,
          extraFlag: true,
        },
      }),
    'HARNESS_PROTOCOL_INCOMPATIBLE',
  )

  // Invalid harnessContentHash: uppercase hex / non-hex / wrong length.
  expectHarnessError(
    () => normalizePinsV1({ ...good, harnessContentHash: 'A'.repeat(64) }),
    'HARNESS_REF_INVALID',
  )
  expectHarnessError(
    () => normalizePinsV1({ ...good, harnessContentHash: 'g'.repeat(64) }),
    'HARNESS_REF_INVALID',
  )
  expectHarnessError(
    () => normalizePinsV1({ ...good, harnessContentHash: 'ab'.repeat(31) }),
    'HARNESS_REF_INVALID',
  )

  // Empty catalog ref id/version.
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        catalogCards: [{ id: '', version: '1.0.0' }],
      }),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        catalogCards: [{ id: 'helix.models', version: '' }],
      }),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Duplicate catalog refs.
  const card = good.catalogCards[0]!
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        catalogCards: [card, { ...card }],
      }),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Invalid compatibility field values (not true).
  expectHarnessError(
    () =>
      normalizePinsV1({
        ...good,
        compatibilityDecision: {
          documentAcceptsCodeProtocolPin: false,
          catalogResolved: true,
        },
      }),
    'HARNESS_PROTOCOL_INCOMPATIBLE',
  )
})

test('review.B2.replay-rejects-corrupted-HarnessPinsV1-and-evidence-extensions', () => {
  const bundle = createFactorioHostBundle()
  const liveAssembled = assembleFactorioRun({
    bundle,
    basePins: pinsV4('replay-closed-model'),
    baselineRef: bundle.defaultBaselineRef,
  })
  assert.ok(liveAssembled.pins.harnessState)
  const evidence = liveAssembled.freeze.evidence

  // Unknown top-level key on pins.harnessState.
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: {
            ...liveAssembled.pins,
            harnessState: {
              ...liveAssembled.pins.harnessState!,
              forged: true,
            } as typeof liveAssembled.pins.harnessState,
          },
          harness: evidence,
        },
        { rootDir: null },
      ),
    'HARNESS_REF_INVALID',
  )

  // Invalid harnessContentHash shape on pins (non-hex).
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: {
            ...liveAssembled.pins,
            harnessState: {
              ...liveAssembled.pins.harnessState!,
              harnessContentHash: 'ZZ'.repeat(32),
            },
          },
          harness: {
            ...evidence,
            harnessContentHash: 'ZZ'.repeat(32),
          },
        },
        { rootDir: null },
      ),
    'HARNESS_REF_INVALID',
  )

  // Empty / duplicate catalog refs on pins.
  const card = liveAssembled.pins.harnessState!.catalogCards[0]!
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: {
            ...liveAssembled.pins,
            harnessState: {
              ...liveAssembled.pins.harnessState!,
              catalogCards: [{ id: '', version: '1.0.0' }],
            },
          },
          harness: {
            ...evidence,
            catalogCards: [{ id: '', version: '1.0.0' }],
          },
        },
        { rootDir: null },
      ),
    'HARNESS_CATALOG_UNRESOLVED',
  )
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: {
            ...liveAssembled.pins,
            harnessState: {
              ...liveAssembled.pins.harnessState!,
              catalogCards: [card, { ...card }],
            },
          },
          harness: {
            ...evidence,
            catalogCards: [card, { ...card }],
          },
        },
        { rootDir: null },
      ),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Extra nested key on catalog card.
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: {
            ...liveAssembled.pins,
            harnessState: {
              ...liveAssembled.pins.harnessState!,
              catalogCards: [{ ...card, extra: 'nope' } as typeof card],
            },
          },
          harness: {
            ...evidence,
            catalogCards: [{ ...card, extra: 'nope' } as typeof card],
          },
        },
        { rootDir: null },
      ),
    'HARNESS_CATALOG_UNRESOLVED',
  )

  // Invalid compatibilityDecision nested unknown field.
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: {
            ...liveAssembled.pins,
            harnessState: {
              ...liveAssembled.pins.harnessState!,
              compatibilityDecision: {
                ...liveAssembled.pins.harnessState!.compatibilityDecision,
                extra: true,
              } as typeof liveAssembled.pins.harnessState.compatibilityDecision,
            },
          },
          harness: {
            ...evidence,
            compatibilityDecision: {
              ...evidence.compatibilityDecision,
              extra: true,
            } as typeof evidence.compatibilityDecision,
          },
        },
        { rootDir: null },
      ),
    'HARNESS_PROTOCOL_INCOMPATIBLE',
  )

  // Evidence unknown extension beyond selectionSource/registryIdentity.
  expectHarnessError(
    () =>
      reconstructFactorioReplayHarness(
        {
          pins: liveAssembled.pins,
          harness: {
            ...evidence,
            unexpectedExt: 1,
          } as typeof evidence,
        },
        { rootDir: null },
      ),
    'HARNESS_REF_INVALID',
  )

  // normalizeEvidenceHarness positive + unknown key.
  const okEvidence = normalizeEvidenceHarness(evidence)
  assert.equal(okEvidence.selectionSource, 'recorded')
  expectHarnessError(
    () => normalizeEvidenceHarness({ ...evidence, nope: true }),
    'HARNESS_REF_INVALID',
  )
})
