import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'
import {
  CATALOG_BINDING_SET_MAPPING_VERSION,
  CapabilityCatalogRegistry,
  CatalogError,
  RUNTIME_CAPABILITY_SETS,
  defaultOccupies,
  deriveEffectClasses,
  getProductionCard,
  listProductionCards,
  registerCard,
  renderCardDoc,
  resolveCapabilitySet,
  resolveCardRefs,
  resolveOccupies,
  setDefaultRegistryForTests,
  validateCardStructure,
  validateFixtureCard,
  validateProductionAdmission,
  type CapabilityCard,
  type EffectClass,
  type SurfaceEntry,
} from '../../src/catalog/index.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const CARDS_DIR = join(REPO_ROOT, 'src/catalog/cards')

function baseSurface(
  overrides: Partial<SurfaceEntry> & Pick<SurfaceEntry, 'name' | 'effectClass'>,
): SurfaceEntry {
  const entry: SurfaceEntry = {
    name: overrides.name,
    effectClass: overrides.effectClass,
    signature: overrides.signature ?? `${overrides.name}()`,
  }
  if (overrides.occupiesHostEffectSlot !== undefined) {
    entry.occupiesHostEffectSlot = overrides.occupiesHostEffectSlot
  }
  return entry
}

function minimalRuntimeCard(
  overrides: Partial<CapabilityCard> = {},
): CapabilityCard {
  const surface = overrides.surface ?? [
    baseSurface({
      name: 'helix.models.call',
      effectClass: 'model_effect',
      occupiesHostEffectSlot: true,
    }),
  ]
  const card: CapabilityCard = {
    id: overrides.id ?? 'helix.models',
    version: overrides.version ?? '9.9.9',
    kind: overrides.kind ?? 'runtime',
    surface,
    effect: overrides.effect ?? {
      hostSlotSummary: 'occupies host single-effect slot after admission',
    },
    budgetAndAuth: overrides.budgetAndAuth ?? {
      capabilityGate: 'capabilities.recursiveModel.enabled',
      unauthorized: 'reject',
    },
    doc: overrides.doc ?? {
      format: 'markdown/v1',
      title: 'test',
      body: 'body',
    },
    replay: overrides.replay ?? {
      recordingAnchor: 'anchor',
      zeroLiveFallback: true,
    },
    nonGoals: overrides.nonGoals ?? [],
  }
  if (overrides.registrationScope !== undefined) {
    card.registrationScope = overrides.registrationScope
  }
  if (overrides.injectionTarget !== undefined) {
    card.injectionTarget = overrides.injectionTarget
  }
  if (overrides.provider !== undefined) {
    card.provider = overrides.provider
  }
  if (overrides.capabilityDiscoveryKeys !== undefined) {
    card.capabilityDiscoveryKeys = overrides.capabilityDiscoveryKeys
  }
  if (overrides.pinsTouch !== undefined) {
    card.pinsTouch = overrides.pinsTouch
  }
  if (overrides.contentHash !== undefined) {
    card.contentHash = overrides.contentHash
  }
  return card
}

function minimalEnvCard(): CapabilityCard {
  return minimalRuntimeCard({
    id: 'example.env',
    version: '1.0.0',
    kind: 'env',
    surface: [
      baseSurface({
        name: 'example.env.step',
        effectClass: 'env_effect',
        occupiesHostEffectSlot: true,
      }),
    ],
    budgetAndAuth: {
      capabilityGate: 'n/a',
      unauthorized: 'reject',
    },
    doc: { format: 'markdown/v1', title: 'env fixture', body: 'env body' },
  })
}

// ---------------------------------------------------------------------------
// S1 — schema / classification / occupancy / effectClasses
// ---------------------------------------------------------------------------

test('S1.schema-required-fields', () => {
  const missingId = validateCardStructure({ version: '1.0.0', kind: 'runtime' })
  assert.equal(missingId.ok, false)
  if (!missingId.ok) {
    assert.equal(missingId.code, 'CATALOG_REJECT_IDENTITY')
  }

  const missingVersion = validateCardStructure({ id: 'x', kind: 'runtime' })
  assert.equal(missingVersion.ok, false)
  if (!missingVersion.ok) {
    assert.equal(missingVersion.code, 'CATALOG_REJECT_IDENTITY')
  }

  const missingDoc = validateCardStructure({
    id: 'x',
    version: '1',
    kind: 'runtime',
    surface: [],
    effect: { hostSlotSummary: 's' },
    budgetAndAuth: { capabilityGate: 'g', unauthorized: 'u' },
    replay: { recordingAnchor: 'a', zeroLiveFallback: true },
    nonGoals: [],
  })
  assert.equal(missingDoc.ok, false)
  if (!missingDoc.ok) {
    assert.equal(missingDoc.code, 'CATALOG_SCHEMA_INVALID')
  }

  assert.equal(validateCardStructure(minimalRuntimeCard()).ok, true)
})

test('S1.kind-enum', () => {
  const bad = validateCardStructure(minimalRuntimeCard({ kind: 'harness' as 'runtime' }))
  // Force invalid kind via plain object
  const invalid = validateCardStructure({
    ...minimalRuntimeCard(),
    kind: 'harness',
  })
  assert.equal(invalid.ok, false)

  const env = validateCardStructure(minimalEnvCard())
  assert.equal(env.ok, true)
  const runtime = validateCardStructure(minimalRuntimeCard())
  assert.equal(runtime.ok, true)
  void bad
})

test('S1.effectclass-closed-seven', () => {
  const card = minimalRuntimeCard({
    surface: [
      {
        name: 'helix.models.call',
        signature: 'call()',
        effectClass: 'teleport' as EffectClass,
      },
    ],
  })
  const result = validateCardStructure(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_EFFECT_CLASS')
  }
})

test('S1.observe-vs-commit-occupancy', () => {
  assert.equal(defaultOccupies('observe'), false)
  assert.equal(defaultOccupies('commit'), true)
  assert.equal(
    resolveOccupies(baseSurface({ name: 'helix.mailbox.peek', effectClass: 'observe' })),
    false,
  )
  assert.equal(
    resolveOccupies(
      baseSurface({
        name: 'helix.mailbox.send',
        effectClass: 'commit',
        occupiesHostEffectSlot: true,
      }),
    ),
    true,
  )
})

test('S1.admin-requires-occupies', () => {
  const card = minimalRuntimeCard({
    surface: [
      baseSurface({
        name: 'helix.session.create',
        effectClass: 'admin',
      }),
    ],
  })
  const result = validateCardStructure(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_OCCUPANCY')
  }
})

test('S1.b9-observe-true', () => {
  const card = minimalRuntimeCard({
    surface: [
      baseSurface({
        name: 'helix.session.lookup',
        effectClass: 'observe',
        occupiesHostEffectSlot: true,
      }),
    ],
  })
  const result = validateCardStructure(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_OCCUPANCY')
  }
})

test('S1.b9-commit-false', () => {
  const card = minimalRuntimeCard({
    surface: [
      baseSurface({
        name: 'helix.mailbox.send',
        effectClass: 'commit',
        occupiesHostEffectSlot: false,
      }),
    ],
  })
  const result = validateCardStructure(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_OCCUPANCY')
  }
})

test('S1.fixture-R-pass', () => {
  const card = minimalRuntimeCard({
    id: 'helix.models',
    version: '1.0.0-test',
    registrationScope: 'runtime-catalog',
    injectionTarget: 'kernel-binding',
  })
  assert.equal(validateProductionAdmission(card).ok, true)
})

test('S1.fixture-H1-B1', () => {
  const card = minimalRuntimeCard({
    injectionTarget: 'harness-control',
  })
  const result = validateProductionAdmission(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_HARNESS_CONTROL')
  }
})

test('S1.fixture-H2-B2', () => {
  const card = minimalRuntimeCard({
    surface: [
      baseSurface({
        name: 'helix.harness.pin',
        effectClass: 'admin',
        occupiesHostEffectSlot: false,
      }),
    ],
  })
  const result = validateProductionAdmission(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_HARNESS_NAMESPACE')
  }
})

test('S1.fixture-E-channel-split', () => {
  const env = minimalEnvCard()
  assert.equal(validateFixtureCard(env).ok, true)
  const prod = validateProductionAdmission(env)
  assert.equal(prod.ok, false)
  if (!prod.ok) {
    assert.equal(prod.code, 'CATALOG_REJECT_ENV_IN_RUNTIME_CATALOG')
  }
})

test('S1.effect-classes-derived', () => {
  const surface: SurfaceEntry[] = [
    baseSurface({ name: 'helix.a', effectClass: 'observe', occupiesHostEffectSlot: false }),
    baseSurface({ name: 'helix.b', effectClass: 'commit', occupiesHostEffectSlot: true }),
    baseSurface({ name: 'helix.c', effectClass: 'observe', occupiesHostEffectSlot: false }),
  ]
  assert.deepEqual(deriveEffectClasses(surface), ['observe', 'commit'])
})

test('S1.effect-classes-mismatch', () => {
  const card = minimalRuntimeCard({
    surface: [
      baseSurface({
        name: 'helix.models.call',
        effectClass: 'model_effect',
        occupiesHostEffectSlot: true,
      }),
    ],
    effect: {
      hostSlotSummary: 's',
      effectClasses: ['model_effect', 'observe'],
    },
  })
  const result = validateCardStructure(card)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_REJECT_EFFECT_CLASS')
  }

  const dup = minimalRuntimeCard({
    effect: {
      hostSlotSummary: 's',
      effectClasses: ['model_effect', 'model_effect'],
    },
  })
  const dupResult = validateCardStructure(dup)
  assert.equal(dupResult.ok, false)
  if (!dupResult.ok) {
    assert.equal(dupResult.code, 'CATALOG_REJECT_EFFECT_CLASS')
  }

  const eighth = minimalRuntimeCard({
    effect: {
      hostSlotSummary: 's',
      effectClasses: ['teleport' as EffectClass],
    },
  })
  const eighthResult = validateCardStructure(eighth)
  assert.equal(eighthResult.ok, false)
  if (!eighthResult.ok) {
    assert.equal(eighthResult.code, 'CATALOG_REJECT_EFFECT_CLASS')
  }
})

test('S1.effect-classes-match', () => {
  const card = minimalRuntimeCard({
    effect: {
      hostSlotSummary: 's',
      effectClasses: ['model_effect'],
    },
  })
  assert.equal(validateCardStructure(card).ok, true)
})

// ---------------------------------------------------------------------------
// S2 — SSOT / immutability / render stability
// ---------------------------------------------------------------------------

test('S2.render-stable', () => {
  const a = renderCardDoc('helix.models', '1.0.0')
  const b = renderCardDoc('helix.models', '1.0.0')
  assert.equal(a, b)
  assert.ok(a.includes('helix.models'))
  assert.ok(a.endsWith('\n'))
})

test('S2.bump-required-on-doc', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({ id: 'helix.t', version: '1.0.0' })
  assert.equal(reg.registerCard(base).ok, true)
  const drifted = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    doc: { format: 'markdown/v1', title: 'test', body: 'CHANGED' },
  })
  const result = reg.registerCard(drifted)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_IMMUTABLE_VERSION_DRIFT')
  }
})

test('S2.bump-required-on-effectclass', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    surface: [
      baseSurface({
        name: 'helix.t.x',
        effectClass: 'observe',
        occupiesHostEffectSlot: false,
      }),
    ],
  })
  assert.equal(reg.registerCard(base).ok, true)
  const drifted = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    surface: [
      baseSurface({
        name: 'helix.t.x',
        effectClass: 'commit',
        occupiesHostEffectSlot: true,
      }),
    ],
  })
  const result = reg.registerCard(drifted)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_IMMUTABLE_VERSION_DRIFT')
  }
})

test('S2.bump-required-on-budget', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({ id: 'helix.t', version: '1.0.0' })
  assert.equal(reg.registerCard(base).ok, true)
  const drifted = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    budgetAndAuth: {
      capabilityGate: 'CHANGED',
      unauthorized: 'reject',
    },
  })
  const result = reg.registerCard(drifted)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_IMMUTABLE_VERSION_DRIFT')
  }
})

test('S2.bump-required-on-replay', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({ id: 'helix.t', version: '1.0.0' })
  assert.equal(reg.registerCard(base).ok, true)
  const drifted = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    replay: { recordingAnchor: 'CHANGED', zeroLiveFallback: true },
  })
  const result = reg.registerCard(drifted)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_IMMUTABLE_VERSION_DRIFT')
  }
})

test('S2.no-hash-only-identity', () => {
  assert.throws(
    () => resolveCardRefs([{ id: 'helix.models', version: '' }]),
    (error: unknown) =>
      error instanceof CatalogError && error.code === 'CATALOG_REF_IDENTITY_INVALID',
  )
  assert.throws(
    () =>
      resolveCardRefs([
        { id: 'helix.models', version: undefined as unknown as string },
      ]),
    (error: unknown) =>
      error instanceof CatalogError && error.code === 'CATALOG_REF_IDENTITY_INVALID',
  )
})

test('S2.channel-meta-no-silent-drift', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    registrationScope: 'runtime-catalog',
    provider: 'helix-runtime',
  })
  assert.equal(reg.registerCard(base).ok, true)
  const drifted = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    registrationScope: 'runtime-catalog',
    provider: 'other-provider',
  })
  const result = reg.registerCard(drifted)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'CATALOG_CHANNEL_META_DRIFT')
  }
})

test('S2.channel-meta-idempotent', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({
    id: 'helix.t',
    version: '1.0.0',
    registrationScope: 'runtime-catalog',
    injectionTarget: 'kernel-binding',
    provider: 'helix-runtime',
  })
  assert.equal(reg.registerCard(base).ok, true)
  assert.equal(reg.registerCard({ ...base }).ok, true)
})

// ---------------------------------------------------------------------------
// S3 — production cards
// ---------------------------------------------------------------------------

test('S3.production-count-2', () => {
  const list = listProductionCards()
  assert.equal(list.length, 2)
  const keys = list.map((c) => `${c.id}@${c.version}`).sort()
  assert.deepEqual(keys, ['helix.models@1.0.0', 'helix.session@1.0.0'])
})

test('S3.models-surface-model-effect', () => {
  const card = getProductionCard('helix.models', '1.0.0')
  assert.equal(card.kind, 'runtime')
  assert.equal(card.surface.length, 1)
  assert.equal(card.surface[0]?.name, 'helix.models.call')
  assert.equal(card.surface[0]?.effectClass, 'model_effect')
  assert.equal(resolveOccupies(card.surface[0]!), true)
})

test('S3.session-surface-table', () => {
  const card = getProductionCard('helix.session', '1.0.0')
  const expected: Record<string, { effectClass: EffectClass; occupies: boolean }> = {
    'helix.session.create': { effectClass: 'admin', occupies: true },
    'helix.session.resume': { effectClass: 'admin', occupies: true },
    'helix.session.checkpoint': { effectClass: 'admin', occupies: true },
    'helix.session.lookup': { effectClass: 'observe', occupies: false },
    'helix.agents.spawn': { effectClass: 'spawn', occupies: true },
    'helix.agents.wait': { effectClass: 'wait_external', occupies: true },
    'helix.agents.poll': { effectClass: 'observe', occupies: false },
    'helix.mailbox.send': { effectClass: 'commit', occupies: true },
    'helix.mailbox.receive': { effectClass: 'commit', occupies: true },
    'helix.mailbox.peek': { effectClass: 'observe', occupies: false },
  }
  assert.equal(card.surface.length, 10)
  for (const entry of card.surface) {
    const exp = expected[entry.name]
    assert.ok(exp, `unexpected entry ${entry.name}`)
    assert.equal(entry.effectClass, exp.effectClass, entry.name)
    assert.equal(resolveOccupies(entry), exp.occupies, entry.name)
  }
  // receive dual-branch documented in SSOT doc
  const doc = renderCardDoc('helix.session', '1.0.0')
  assert.match(doc, /timeout_ms == 0/)
  assert.match(doc, /timeout_ms > 0/)
})

test('S3.effect-classes-consistent', () => {
  for (const card of listProductionCards()) {
    const derived = deriveEffectClasses(card.surface)
    const declared = card.effect.effectClasses
    assert.ok(declared)
    assert.deepEqual(new Set(declared), new Set(derived))
  }
})

test('S3.no-env-instance', () => {
  for (const card of listProductionCards()) {
    assert.notEqual(card.kind, 'env')
  }
})

test('S3.session-not-split', () => {
  const ids = listProductionCards().map((c) => c.id)
  assert.ok(!ids.includes('helix.agents'))
  assert.ok(!ids.includes('helix.mailbox'))
  assert.throws(
    () => getProductionCard('helix.agents', '1.0.0'),
    (error: unknown) =>
      error instanceof CatalogError && error.code === 'CATALOG_REF_UNKNOWN',
  )
})

test('S3.path-not-under-examples', () => {
  const rel = relative(REPO_ROOT, CARDS_DIR)
  assert.ok(!rel.split(sep).includes('examples'))
  assert.ok(rel.startsWith(join('src', 'catalog')) || rel.startsWith('src/catalog'))
})

// ---------------------------------------------------------------------------
// S4 — refs / binding sets / fail-closed
// ---------------------------------------------------------------------------

test('S4.resolve-core-set', () => {
  assert.equal(CATALOG_BINDING_SET_MAPPING_VERSION, '1')
  const refs = resolveCapabilitySet('helix.runtime.core/v1')
  assert.deepEqual(refs, [
    { id: 'helix.models', version: '1.0.0' },
    { id: 'helix.session', version: '1.0.0' },
  ])
  const resolved = resolveCardRefs(refs)
  assert.equal(resolved.length, 2)
  assert.deepEqual(
    RUNTIME_CAPABILITY_SETS['helix.runtime.recursive-model/v1'],
    [{ id: 'helix.models', version: '1.0.0' }],
  )
})

test('S4.unknown-ref', () => {
  assert.throws(
    () => resolveCardRefs([{ id: 'helix.nope', version: '1.0.0' }]),
    (error: unknown) =>
      error instanceof CatalogError &&
      (error.code === 'CATALOG_REF_NOT_IN_PRODUCTION' ||
        error.code === 'CATALOG_REF_UNKNOWN'),
  )
})

test('S4.missing-version', () => {
  assert.throws(
    () => resolveCardRefs([{ id: 'helix.models' } as { id: string; version: string }]),
    (error: unknown) =>
      error instanceof CatalogError && error.code === 'CATALOG_REF_IDENTITY_INVALID',
  )
})

test('S4.pinned-old-version', () => {
  // Old pin stays on 1.0.0 even if a newer version were registered elsewhere.
  const v1 = getProductionCard('helix.models', '1.0.0')
  const rendered = renderCardDoc('helix.models', '1.0.0')
  assert.equal(v1.version, '1.0.0')
  assert.ok(rendered.includes(v1.doc.body.slice(0, 40)) || rendered.includes('helix.models'))

  // Register a v2 on an isolated registry — default production path must not auto-lift.
  const iso = CapabilityCatalogRegistry.empty()
  const v2 = minimalRuntimeCard({
    id: 'helix.models',
    version: '2.0.0',
    doc: { format: 'markdown/v1', title: 'helix.models', body: 'V2 BODY ONLY' },
  })
  assert.equal(iso.registerCard(v2).ok, true)
  // Default registry still serves 1.0.0 body, not v2.
  const still = renderCardDoc('helix.models', '1.0.0')
  assert.ok(!still.includes('V2 BODY ONLY'))
  assert.throws(
    () => getProductionCard('helix.models', '2.0.0'),
    (error: unknown) =>
      error instanceof CatalogError && error.code === 'CATALOG_REF_UNKNOWN',
  )
})

test('S4.binding-set-unresolvable', () => {
  assert.throws(
    () => resolveCapabilitySet('helix.runtime.does-not-exist/v1'),
    (error: unknown) =>
      error instanceof CatalogError &&
      error.code === 'CATALOG_BINDING_SET_UNRESOLVABLE',
  )
})

test('S1.optional-fields-type-reject', () => {
  const base = minimalRuntimeCard({
    registrationScope: 'runtime-catalog',
    injectionTarget: 'kernel-binding',
  })

  const cases: Array<{ label: string; patch: Record<string, unknown> }> = [
    { label: 'provider number', patch: { provider: 17 } },
    {
      label: 'capabilityDiscoveryKeys number element',
      patch: { capabilityDiscoveryKeys: [17] },
    },
    { label: 'pinsTouch object', patch: { pinsTouch: {} } },
    { label: 'contentHash number', patch: { contentHash: 1 } },
    {
      label: 'tokenPool number',
      patch: {
        budgetAndAuth: { ...base.budgetAndAuth, tokenPool: 9 },
      },
    },
    {
      label: 'auth object',
      patch: {
        budgetAndAuth: { ...base.budgetAndAuth, auth: {} },
      },
    },
    {
      label: 'limits array',
      patch: {
        budgetAndAuth: { ...base.budgetAndAuth, limits: [] },
      },
    },
    {
      label: 'countBudget number',
      patch: {
        budgetAndAuth: { ...base.budgetAndAuth, countBudget: 3 },
      },
    },
    {
      label: 'replay.isolation number',
      patch: {
        replay: { ...base.replay, isolation: 3 },
      },
    },
    {
      label: 'replay.exactlyOnceMerge string',
      patch: {
        replay: { ...base.replay, exactlyOnceMerge: 'yes' },
      },
    },
    {
      label: 'replay.checkpointBounds number',
      patch: {
        replay: { ...base.replay, checkpointBounds: 1 },
      },
    },
    {
      label: 'replay.notes number',
      patch: {
        replay: { ...base.replay, notes: 0 },
      },
    },
  ]

  for (const { label, patch } of cases) {
    const malformed = { ...base, ...patch }
    const structure = validateCardStructure(malformed)
    assert.equal(structure.ok, false, `structure should reject ${label}`)
    if (!structure.ok) {
      assert.equal(structure.code, 'CATALOG_SCHEMA_INVALID', label)
    }
    const admission = validateProductionAdmission(
      malformed as unknown as CapabilityCard,
    )
    assert.equal(admission.ok, false, `admission should reject ${label}`)
    if (!admission.ok) {
      assert.equal(admission.code, 'CATALOG_SCHEMA_INVALID', label)
    }
  }

  // Well-typed optionals still pass.
  const ok = validateCardStructure(
    minimalRuntimeCard({
      provider: 'helix-runtime',
      capabilityDiscoveryKeys: ['recursiveModel'],
      pinsTouch: 'pins note',
      contentHash: 'abc',
      budgetAndAuth: {
        capabilityGate: 'g',
        unauthorized: 'u',
        tokenPool: 'pool',
        countBudget: 'count',
        auth: 'auth note',
        limits: { max: 1, nested: { depth: 2 } },
      },
      replay: {
        recordingAnchor: 'a',
        zeroLiveFallback: true,
        isolation: 'iso',
        exactlyOnceMerge: true,
        checkpointBounds: 'bounds',
        notes: 'n',
      },
    }),
  )
  assert.equal(ok.ok, true)
})

test('S2.registry-nested-limits-immutable', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const nested = { max: 1 }
  const input = minimalRuntimeCard({
    id: 'helix.mutable',
    version: '1.0.0',
    registrationScope: 'runtime-catalog',
    injectionTarget: 'kernel-binding',
    budgetAndAuth: {
      capabilityGate: 'capabilities.recursiveModel.enabled',
      unauthorized: 'reject',
      limits: { nested },
    },
  })

  assert.equal(reg.registerCard(input).ok, true)

  // Mutating the pre-register input graph must not pollute the registry.
  nested.max = 2
  const inputLimits = input.budgetAndAuth.limits
  assert.ok(
    inputLimits &&
      typeof inputLimits === 'object' &&
      !Array.isArray(inputLimits) &&
      'nested' in inputLimits,
  )
  const inputNested = inputLimits.nested
  assert.ok(
    inputNested &&
      typeof inputNested === 'object' &&
      !Array.isArray(inputNested) &&
      'max' in inputNested,
  )
  inputNested.max = 3

  const stored = reg.getProductionCard('helix.mutable', '1.0.0')
  const storedLimits = stored.budgetAndAuth.limits
  assert.ok(
    storedLimits &&
      typeof storedLimits === 'object' &&
      !Array.isArray(storedLimits) &&
      'nested' in storedLimits,
  )
  const storedNested = storedLimits.nested
  assert.ok(
    storedNested &&
      typeof storedNested === 'object' &&
      !Array.isArray(storedNested) &&
      'max' in storedNested &&
      typeof storedNested.max === 'number',
  )
  assert.equal(storedNested.max, 1)

  // Returned card is deeply frozen — nested writes must not stick.
  assert.throws(() => {
    storedNested.max = 99
  })
  const again = reg.getProductionCard('helix.mutable', '1.0.0')
  const againLimits = again.budgetAndAuth.limits
  assert.ok(
    againLimits &&
      typeof againLimits === 'object' &&
      !Array.isArray(againLimits) &&
      'nested' in againLimits,
  )
  const againNested = againLimits.nested
  assert.ok(
    againNested &&
      typeof againNested === 'object' &&
      !Array.isArray(againNested) &&
      'max' in againNested &&
      typeof againNested.max === 'number',
  )
  assert.equal(againNested.max, 1)
})


test('registerCard default registry immutability on production cards', () => {
  const models = getProductionCard('helix.models', '1.0.0')
  const again = registerCard({
    ...models,
    doc: { ...models.doc, body: models.doc.body + '\nCHANGED' },
  })
  assert.equal(again.ok, false)
  if (!again.ok) {
    assert.equal(again.code, 'CATALOG_IMMUTABLE_VERSION_DRIFT')
  }
  // idempotent same payload
  assert.equal(registerCard(models).ok, true)
})

// Ensure test helpers do not leak into default registry state across files.


test('S1.limits-reject-exotic-objects', () => {
  const base = minimalRuntimeCard({ id: 'helix.exotic' })
  const withMap = {
    ...base,
    budgetAndAuth: {
      ...base.budgetAndAuth,
      limits: { nested: new Map([['max', 1]]) },
    },
  }
  const r1 = validateProductionAdmission(withMap as never)
  assert.equal(r1.ok, false)
  if (!r1.ok) assert.equal(r1.code, 'CATALOG_SCHEMA_INVALID')

  const withDate = {
    ...base,
    budgetAndAuth: {
      ...base.budgetAndAuth,
      limits: { when: new Date() },
    },
  }
  const r2 = validateProductionAdmission(withDate as never)
  assert.equal(r2.ok, false)
  if (!r2.ok) assert.equal(r2.code, 'CATALOG_SCHEMA_INVALID')
})

test('S2.id-version-at-sign-no-collision', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const a = minimalRuntimeCard({
    id: 'a@b',
    version: 'c',
    doc: { format: 'markdown/v1', title: 'A', body: 'body-a' },
  })
  const b = minimalRuntimeCard({
    id: 'a',
    version: 'b@c',
    doc: { format: 'markdown/v1', title: 'B', body: 'body-b' },
  })
  assert.equal(reg.registerCard(a).ok, true)
  assert.equal(reg.registerCard(b).ok, true)
  assert.equal(reg.getProductionCard('a@b', 'c').doc.body, 'body-a')
  assert.equal(reg.getProductionCard('a', 'b@c').doc.body, 'body-b')
  assert.equal(reg.listProductionCards().length, 2)
})



test('S2.effectclasses-reorder-idempotent', () => {
  const reg = CapabilityCatalogRegistry.empty()
  const base = minimalRuntimeCard({
    id: 'helix.reorder',
    version: '1.0.0',
    surface: [
      { name: 'helix.reorder.a', effectClass: 'observe', signature: 'a()' },
      { name: 'helix.reorder.b', effectClass: 'commit', signature: 'b()' },
    ],
    effect: {
      hostSlotSummary: 'x',
      effectClasses: ['observe', 'commit'],
    },
  })
  assert.equal(reg.registerCard(base).ok, true)
  const reordered = minimalRuntimeCard({
    id: 'helix.reorder',
    version: '1.0.0',
    surface: [
      { name: 'helix.reorder.a', effectClass: 'observe', signature: 'a()' },
      { name: 'helix.reorder.b', effectClass: 'commit', signature: 'b()' },
    ],
    effect: {
      hostSlotSummary: 'x',
      effectClasses: ['commit', 'observe'],
    },
  })
  assert.equal(reg.registerCard(reordered).ok, true)
})

test('S1.cycle-json-graph-reject', () => {
  const base = minimalRuntimeCard({ id: 'helix.cycle' }) as Record<string, unknown>
  const limits: Record<string, unknown> = {}
  limits['self'] = limits
  const cyclic = {
    ...base,
    budgetAndAuth: {
      ...(base.budgetAndAuth as object),
      limits,
    },
  }
  const r = validateCardStructure(cyclic)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'CATALOG_SCHEMA_INVALID')
})

test('S3.dist-cards-loadable-after-build-path', async () => {
  // Always assert src-path default registry under tsx.
  const cards = listProductionCards()
  assert.equal(cards.length, 2)
  assert.ok(cards.some((c) => c.id === 'helix.models' && c.version === '1.0.0'))
  assert.ok(cards.some((c) => c.id === 'helix.session' && c.version === '1.0.0'))

  // If dist build artifacts exist, also load from compiled module path.
  const distIndex = join(REPO_ROOT, 'dist/catalog/index.js')
  const distCardsDir = join(REPO_ROOT, 'dist/catalog/cards')
  const { access } = await import('node:fs/promises')
  try {
    await access(distIndex)
    await access(join(distCardsDir, 'helix.models.1.0.0.json'))
  } catch {
    return // dist not built in this invocation
  }
  const dist = await import(distIndex)
  const distList = dist.listProductionCards() as Array<{ id: string; version: string }>
  assert.equal(distList.length, 2)
  assert.equal(dist.getProductionCard('helix.models', '1.0.0').id, 'helix.models')
  assert.equal(dist.getProductionCard('helix.session', '1.0.0').id, 'helix.session')
})

test('teardown default registry isolation hook', () => {
  setDefaultRegistryForTests(undefined)
})
