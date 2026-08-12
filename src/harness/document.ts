/**
 * HarnessDocument / HarnessOverlay closed-set validation, merge, and hashing.
 */

import { getDefaultRegistry } from '../catalog/registry.js'
import type { CapabilityCatalogRegistry } from '../catalog/registry.js'
import {
  harnessContentHash,
  isContentHash,
  cloneJson,
  deepFreezeJson,
} from './canonical.js'
import {
  harnessError,
  throwFail,
  validationFail,
  validationOk,
  type HarnessValidationResult,
} from './errors.js'
import type {
  AgentSpec,
  CatalogCardRef,
  HarnessDocument,
  HarnessOverlay,
  HarnessOverlayChanges,
  HarnessStateRef,
} from './types.js'

const DOCUMENT_SCHEMA = 'helix.harness/v1' as const
const OVERLAY_SCHEMA = 'helix.harness-overlay/v1' as const
const SUCCESS_SOURCE = 'scenario-verifier' as const

const OVERLAY_CHANGE_KEYS = [
  'systemInstructionTemplate',
  'taskNarrativeTemplate',
  'protocolRules',
  'stopConditions',
  'catalogCards',
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function fail(
  code: Parameters<typeof validationFail>[0],
  message: string,
  details?: unknown,
): HarnessValidationResult<never> {
  return validationFail(code, message, details)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function assertNoLoneSurrogate(text: string, path: string): HarnessValidationResult<true> {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return fail('HARNESS_DOCUMENT_INVALID', 'string contains lone high surrogate', {
          path,
          index: i,
        })
      }
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return fail('HARNESS_DOCUMENT_INVALID', 'string contains lone low surrogate', {
        path,
        index: i,
      })
    }
  }
  return validationOk(true)
}

function validateNonNegSafeInt(
  value: unknown,
  path: string,
): HarnessValidationResult<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path} must be a non-negative safe integer`, {
      path,
      value,
    })
  }
  if (Object.is(value, -0)) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path} must not be negative zero`, { path })
  }
  return validationOk(value)
}

function closedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: Parameters<typeof validationFail>[0] = 'HARNESS_DOCUMENT_INVALID',
): HarnessValidationResult<true> {
  const allowedSet: Record<string, true> = Object.create(null)
  for (const key of allowed) allowedSet[key] = true
  for (const key of Object.keys(value)) {
    if (allowedSet[key] !== true) {
      return fail(code, `${path} has unknown field '${key}'`, { path, key })
    }
  }
  return validationOk(true)
}

export function validateCatalogCardRef(
  raw: unknown,
  path: string,
): HarnessValidationResult<CatalogCardRef> {
  if (!isPlainObject(raw)) {
    return fail('HARNESS_CATALOG_UNRESOLVED', `${path} must be an object`, { path })
  }
  const keys = closedKeys(raw, ['id', 'version'], path, 'HARNESS_CATALOG_UNRESOLVED')
  if (!keys.ok) return keys
  if (!isNonEmptyString(raw['id']) || !isNonEmptyString(raw['version'])) {
    return fail(
      'HARNESS_CATALOG_UNRESOLVED',
      `${path} requires non-empty id and version`,
      { path, raw },
    )
  }
  const idCheck = assertNoLoneSurrogate(raw['id'], `${path}.id`)
  if (!idCheck.ok) return idCheck
  const verCheck = assertNoLoneSurrogate(raw['version'], `${path}.version`)
  if (!verCheck.ok) return verCheck
  return validationOk({ id: raw['id'], version: raw['version'] })
}

export function validateHarnessStateRef(
  raw: unknown,
  path = 'ref',
): HarnessValidationResult<HarnessStateRef> {
  if (!isPlainObject(raw)) {
    return fail('HARNESS_REF_INVALID', `${path} must be an object`, { path })
  }
  const keys = closedKeys(raw, ['kind', 'id', 'revision', 'contentHash'], path, 'HARNESS_REF_INVALID')
  if (!keys.ok) return keys
  const kind = raw['kind']
  if (kind !== 'baseline' && kind !== 'overlay') {
    return fail('HARNESS_REF_INVALID', `${path}.kind must be baseline|overlay`, {
      path,
      kind,
    })
  }
  if (!isNonEmptyString(raw['id'])) {
    return fail('HARNESS_REF_INVALID', `${path}.id must be a non-empty string`, { path })
  }
  const idCheck = assertNoLoneSurrogate(raw['id'], `${path}.id`)
  if (!idCheck.ok) {
    return fail('HARNESS_REF_INVALID', idCheck.message, idCheck.details)
  }
  const rev = validateNonNegSafeInt(raw['revision'], `${path}.revision`)
  if (!rev.ok) {
    return fail('HARNESS_REF_INVALID', rev.message, rev.details)
  }
  if (!isContentHash(raw['contentHash'])) {
    return fail(
      'HARNESS_REF_INVALID',
      `${path}.contentHash must be 64 lowercase hex chars`,
      { path, contentHash: raw['contentHash'] },
    )
  }
  return validationOk({
    kind,
    id: raw['id'],
    revision: rev.value,
    contentHash: raw['contentHash'],
  })
}

function validateStringList(
  raw: unknown,
  path: string,
  options: { allowEmpty: boolean; unique?: boolean },
): HarnessValidationResult<string[]> {
  if (!Array.isArray(raw)) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path} must be an array`, { path })
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!isNonEmptyString(item)) {
      return fail(
        'HARNESS_DOCUMENT_INVALID',
        `${path}[${i}] must be a non-empty string`,
        { path, index: i },
      )
    }
    const sCheck = assertNoLoneSurrogate(item, `${path}[${i}]`)
    if (!sCheck.ok) return sCheck
    if (options.unique) {
      if (seen.has(item)) {
        return fail(
          'HARNESS_DOCUMENT_INVALID',
          `${path} contains duplicate entry`,
          { path, item },
        )
      }
      seen.add(item)
    }
    out.push(item)
  }
  if (!options.allowEmpty && out.length === 0) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path} must not be empty`, { path })
  }
  return validationOk(out)
}

function validateCatalogCardRefList(
  raw: unknown,
  path: string,
): HarnessValidationResult<CatalogCardRef[]> {
  if (!Array.isArray(raw)) {
    return fail('HARNESS_CATALOG_UNRESOLVED', `${path} must be an array`, { path })
  }
  const out: CatalogCardRef[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 1) {
    const ref = validateCatalogCardRef(raw[i], `${path}[${i}]`)
    if (!ref.ok) return ref
    const key = `${ref.value.id}@${ref.value.version}`
    if (seen.has(key)) {
      return fail(
        'HARNESS_CATALOG_UNRESOLVED',
        `${path} contains duplicate (id, version)`,
        { path, ref: ref.value },
      )
    }
    seen.add(key)
    out.push(ref.value)
  }
  return validationOk(out)
}

function validateAgentSpec(
  raw: unknown,
  path: string,
  documentCards: CatalogCardRef[],
): HarnessValidationResult<AgentSpec> {
  if (!isPlainObject(raw)) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path} must be an object`, { path })
  }
  const keys = closedKeys(
    raw,
    ['id', 'defaultInstruction', 'catalogCards', 'budget'],
    path,
  )
  if (!keys.ok) return keys
  if (!isNonEmptyString(raw['id'])) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path}.id must be non-empty string`, {
      path,
    })
  }
  const idCheck = assertNoLoneSurrogate(raw['id'], `${path}.id`)
  if (!idCheck.ok) return idCheck
  if (!isNonEmptyString(raw['defaultInstruction'])) {
    return fail(
      'HARNESS_DOCUMENT_INVALID',
      `${path}.defaultInstruction must be non-empty string`,
      { path },
    )
  }
  const instrCheck = assertNoLoneSurrogate(
    raw['defaultInstruction'],
    `${path}.defaultInstruction`,
  )
  if (!instrCheck.ok) return instrCheck
  const cards = validateCatalogCardRefList(raw['catalogCards'], `${path}.catalogCards`)
  if (!cards.ok) return cards
  // Each agent catalog card must be a subset of document catalogCards.
  const docSet = new Set(documentCards.map((c) => `${c.id}@${c.version}`))
  for (const card of cards.value) {
    if (!docSet.has(`${card.id}@${card.version}`)) {
      return fail(
        'HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED',
        `${path}.catalogCards entry is not in document.catalogCards`,
        { path, card },
      )
    }
  }
  if (!isPlainObject(raw['budget'])) {
    return fail('HARNESS_DOCUMENT_INVALID', `${path}.budget must be an object`, { path })
  }
  const budgetKeys = closedKeys(
    raw['budget'],
    ['maxCalls', 'maxOutputTokens'],
    `${path}.budget`,
  )
  if (!budgetKeys.ok) return budgetKeys
  const budget: AgentSpec['budget'] = {}
  if ('maxCalls' in raw['budget']) {
    const n = validateNonNegSafeInt(raw['budget']['maxCalls'], `${path}.budget.maxCalls`)
    if (!n.ok) return n
    budget.maxCalls = n.value
  }
  if ('maxOutputTokens' in raw['budget']) {
    const n = validateNonNegSafeInt(
      raw['budget']['maxOutputTokens'],
      `${path}.budget.maxOutputTokens`,
    )
    if (!n.ok) return n
    budget.maxOutputTokens = n.value
  }
  return validationOk({
    id: raw['id'],
    defaultInstruction: raw['defaultInstruction'],
    catalogCards: cards.value,
    budget,
  })
}

/**
 * Resolve each catalog card against the #11 production registry (exact id+version).
 * Does NOT consult run-local availableCatalogRefs.
 */
export function resolveCatalogCardsInRegistry(
  cards: readonly CatalogCardRef[],
  registry: CapabilityCatalogRegistry = getDefaultRegistry(),
): HarnessValidationResult<CatalogCardRef[]> {
  for (const card of cards) {
    try {
      registry.getProductionCard(card.id, card.version)
    } catch {
      return fail(
        'HARNESS_CATALOG_UNRESOLVED',
        `catalog card ${card.id}@${card.version} is unresolved`,
        { card },
      )
    }
  }
  return validationOk(cards.map((c) => ({ id: c.id, version: c.version })))
}

/**
 * Exact membership of cards in a frozen availableCatalogRefs set.
 */
export function assertCardsAvailable(
  cards: readonly CatalogCardRef[],
  availableCatalogRefs: readonly CatalogCardRef[],
  path: string,
): HarnessValidationResult<true> {
  const available = new Set(
    availableCatalogRefs.map((c) => `${c.id}@${c.version}`),
  )
  for (const card of cards) {
    if (!available.has(`${card.id}@${card.version}`)) {
      return fail(
        'HARNESS_CATALOG_NOT_AVAILABLE',
        `${path} card ${card.id}@${card.version} is outside availableCatalogRefs`,
        { path, card, availableCatalogRefs },
      )
    }
  }
  return validationOk(true)
}

export function assertAgentSpecCatalogClosure(
  agentSpecs: readonly AgentSpec[] | undefined,
  catalogCards: readonly CatalogCardRef[],
): HarnessValidationResult<true> {
  if (agentSpecs === undefined || agentSpecs.length === 0) return validationOk(true)
  const set = new Set(catalogCards.map((c) => `${c.id}@${c.version}`))
  for (const spec of agentSpecs) {
    for (const card of spec.catalogCards) {
      if (!set.has(`${card.id}@${card.version}`)) {
        return fail(
          'HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED',
          `agentSpec ${spec.id} requires catalog card missing from resolved catalogCards`,
          { specId: spec.id, card },
        )
      }
    }
  }
  return validationOk(true)
}

export function validateHarnessDocument(
  raw: unknown,
  options: {
    registry?: CapabilityCatalogRegistry
    /** When true, skip production registry lookup (tests with synthetic cards). */
    skipRegistryLookup?: boolean
  } = {},
): HarnessValidationResult<HarnessDocument> {
  if (!isPlainObject(raw)) {
    return fail('HARNESS_DOCUMENT_INVALID', 'document must be an object')
  }
  const topKeys = closedKeys(
    raw,
    ['schemaVersion', 'control', 'catalogCards', 'compatibility', 'agentSpecs'],
    'document',
  )
  if (!topKeys.ok) return topKeys
  if (raw['schemaVersion'] !== DOCUMENT_SCHEMA) {
    return fail(
      'HARNESS_SCHEMA_INVALID',
      `schemaVersion must be ${DOCUMENT_SCHEMA}`,
      { schemaVersion: raw['schemaVersion'] },
    )
  }
  if (!isPlainObject(raw['control'])) {
    return fail('HARNESS_DOCUMENT_INVALID', 'control must be an object')
  }
  const controlKeys = closedKeys(
    raw['control'],
    [
      'systemInstructionTemplate',
      'taskNarrativeTemplate',
      'protocolRules',
      'termination',
    ],
    'control',
  )
  if (!controlKeys.ok) return controlKeys
  if (!isNonEmptyString(raw['control']['systemInstructionTemplate'])) {
    return fail(
      'HARNESS_DOCUMENT_INVALID',
      'control.systemInstructionTemplate must be non-empty string',
    )
  }
  const sysCheck = assertNoLoneSurrogate(
    raw['control']['systemInstructionTemplate'],
    'control.systemInstructionTemplate',
  )
  if (!sysCheck.ok) return sysCheck
  if (!isNonEmptyString(raw['control']['taskNarrativeTemplate'])) {
    return fail(
      'HARNESS_DOCUMENT_INVALID',
      'control.taskNarrativeTemplate must be non-empty string',
    )
  }
  const taskCheck = assertNoLoneSurrogate(
    raw['control']['taskNarrativeTemplate'],
    'control.taskNarrativeTemplate',
  )
  if (!taskCheck.ok) return taskCheck
  const protocolRules = validateStringList(raw['control']['protocolRules'], 'control.protocolRules', {
    allowEmpty: true,
  })
  if (!protocolRules.ok) return protocolRules
  if (!isPlainObject(raw['control']['termination'])) {
    return fail('HARNESS_DOCUMENT_INVALID', 'control.termination must be an object')
  }
  const termKeys = closedKeys(
    raw['control']['termination'],
    ['successSource', 'stopConditions'],
    'control.termination',
  )
  if (!termKeys.ok) return termKeys
  if (raw['control']['termination']['successSource'] !== SUCCESS_SOURCE) {
    return fail(
      'HARNESS_DOCUMENT_INVALID',
      `control.termination.successSource must be ${SUCCESS_SOURCE}`,
    )
  }
  const stopConditions = validateStringList(
    raw['control']['termination']['stopConditions'],
    'control.termination.stopConditions',
    { allowEmpty: true },
  )
  if (!stopConditions.ok) return stopConditions

  const catalogCards = validateCatalogCardRefList(raw['catalogCards'], 'catalogCards')
  if (!catalogCards.ok) return catalogCards
  if (!options.skipRegistryLookup) {
    const resolved = resolveCatalogCardsInRegistry(
      catalogCards.value,
      options.registry ?? getDefaultRegistry(),
    )
    if (!resolved.ok) return resolved
  }

  if (!isPlainObject(raw['compatibility'])) {
    return fail('HARNESS_DOCUMENT_INVALID', 'compatibility must be an object')
  }
  const compatKeys = closedKeys(
    raw['compatibility'],
    ['codeProtocolPins'],
    'compatibility',
  )
  if (!compatKeys.ok) return compatKeys
  const pins = validateStringList(
    raw['compatibility']['codeProtocolPins'],
    'compatibility.codeProtocolPins',
    { allowEmpty: true, unique: true },
  )
  if (!pins.ok) return pins

  let agentSpecs: AgentSpec[] | undefined
  if ('agentSpecs' in raw) {
    if (!Array.isArray(raw['agentSpecs'])) {
      return fail('HARNESS_DOCUMENT_INVALID', 'agentSpecs must be an array')
    }
    agentSpecs = []
    const seenIds = new Set<string>()
    for (let i = 0; i < raw['agentSpecs'].length; i += 1) {
      const spec = validateAgentSpec(
        raw['agentSpecs'][i],
        `agentSpecs[${i}]`,
        catalogCards.value,
      )
      if (!spec.ok) return spec
      if (seenIds.has(spec.value.id)) {
        return fail(
          'HARNESS_DOCUMENT_INVALID',
          'agentSpecs ids must be unique',
          { id: spec.value.id },
        )
      }
      seenIds.add(spec.value.id)
      agentSpecs.push(spec.value)
    }
  }

  const closure = assertAgentSpecCatalogClosure(agentSpecs, catalogCards.value)
  if (!closure.ok) return closure

  const document: HarnessDocument = {
    schemaVersion: DOCUMENT_SCHEMA,
    control: {
      systemInstructionTemplate: raw['control']['systemInstructionTemplate'],
      taskNarrativeTemplate: raw['control']['taskNarrativeTemplate'],
      protocolRules: protocolRules.value,
      termination: {
        successSource: SUCCESS_SOURCE,
        stopConditions: stopConditions.value,
      },
    },
    catalogCards: catalogCards.value,
    compatibility: {
      codeProtocolPins: pins.value,
    },
  }
  if (agentSpecs !== undefined) {
    document.agentSpecs = agentSpecs
  }
  return validationOk(deepFreezeJson(cloneJson(document)))
}

export function baselineContentHash(document: HarnessDocument): string {
  return harnessContentHash(document)
}

export function validateHarnessOverlay(
  raw: unknown,
  options: {
    registry?: CapabilityCatalogRegistry
    skipRegistryLookup?: boolean
  } = {},
): HarnessValidationResult<HarnessOverlay> {
  if (!isPlainObject(raw)) {
    return fail('HARNESS_OVERLAY_INVALID', 'overlay must be an object')
  }
  const topKeys = closedKeys(
    raw,
    ['schemaVersion', 'baseBaselineRef', 'changes'],
    'overlay',
    'HARNESS_OVERLAY_INVALID',
  )
  if (!topKeys.ok) return topKeys
  if (raw['schemaVersion'] !== OVERLAY_SCHEMA) {
    return fail(
      'HARNESS_OVERLAY_INVALID',
      `overlay.schemaVersion must be ${OVERLAY_SCHEMA}`,
      { schemaVersion: raw['schemaVersion'] },
    )
  }
  const baseRef = validateHarnessStateRef(raw['baseBaselineRef'], 'baseBaselineRef')
  if (!baseRef.ok) return baseRef
  if (baseRef.value.kind !== 'baseline') {
    return fail(
      'HARNESS_OVERLAY_INVALID',
      'baseBaselineRef.kind must be baseline',
      { baseBaselineRef: baseRef.value },
    )
  }
  if (!isPlainObject(raw['changes'])) {
    return fail('HARNESS_OVERLAY_INVALID', 'changes must be an object')
  }
  const changeKeys = closedKeys(
    raw['changes'],
    OVERLAY_CHANGE_KEYS as unknown as string[],
    'changes',
    'HARNESS_OVERLAY_INVALID',
  )
  if (!changeKeys.ok) return changeKeys
  const present = Object.keys(raw['changes'])
  if (present.length === 0) {
    return fail('HARNESS_OVERLAY_INVALID', 'changes must contain at least one field')
  }

  const changes: HarnessOverlayChanges = {}
  if ('systemInstructionTemplate' in raw['changes']) {
    const v = raw['changes']['systemInstructionTemplate']
    if (!isNonEmptyString(v)) {
      return fail(
        'HARNESS_OVERLAY_INVALID',
        'changes.systemInstructionTemplate must be non-empty string',
      )
    }
    const c = assertNoLoneSurrogate(v, 'changes.systemInstructionTemplate')
    if (!c.ok) return fail('HARNESS_OVERLAY_INVALID', c.message, c.details)
    changes.systemInstructionTemplate = v
  }
  if ('taskNarrativeTemplate' in raw['changes']) {
    const v = raw['changes']['taskNarrativeTemplate']
    if (!isNonEmptyString(v)) {
      return fail(
        'HARNESS_OVERLAY_INVALID',
        'changes.taskNarrativeTemplate must be non-empty string',
      )
    }
    const c = assertNoLoneSurrogate(v, 'changes.taskNarrativeTemplate')
    if (!c.ok) return fail('HARNESS_OVERLAY_INVALID', c.message, c.details)
    changes.taskNarrativeTemplate = v
  }
  if ('protocolRules' in raw['changes']) {
    if (!Array.isArray(raw['changes']['protocolRules'])) {
      return fail('HARNESS_OVERLAY_INVALID', 'changes.protocolRules must be an array')
    }
    const list: string[] = []
    for (let i = 0; i < raw['changes']['protocolRules'].length; i += 1) {
      const item = raw['changes']['protocolRules'][i]
      if (!isNonEmptyString(item)) {
        return fail(
          'HARNESS_OVERLAY_INVALID',
          `changes.protocolRules[${i}] must be non-empty string`,
        )
      }
      const c = assertNoLoneSurrogate(item, `changes.protocolRules[${i}]`)
      if (!c.ok) return fail('HARNESS_OVERLAY_INVALID', c.message, c.details)
      list.push(item)
    }
    changes.protocolRules = list
  }
  if ('stopConditions' in raw['changes']) {
    if (!Array.isArray(raw['changes']['stopConditions'])) {
      return fail('HARNESS_OVERLAY_INVALID', 'changes.stopConditions must be an array')
    }
    const list: string[] = []
    for (let i = 0; i < raw['changes']['stopConditions'].length; i += 1) {
      const item = raw['changes']['stopConditions'][i]
      if (!isNonEmptyString(item)) {
        return fail(
          'HARNESS_OVERLAY_INVALID',
          `changes.stopConditions[${i}] must be non-empty string`,
        )
      }
      const c = assertNoLoneSurrogate(item, `changes.stopConditions[${i}]`)
      if (!c.ok) return fail('HARNESS_OVERLAY_INVALID', c.message, c.details)
      list.push(item)
    }
    changes.stopConditions = list
  }
  if ('catalogCards' in raw['changes']) {
    const cards = validateCatalogCardRefList(
      raw['changes']['catalogCards'],
      'changes.catalogCards',
    )
    if (!cards.ok) {
      // Map document-level catalog errors that are shape errors onto overlay invalid
      // only when they are not true unresolved cards; validateCatalogCardRefList already
      // uses HARNESS_CATALOG_UNRESOLVED for shape/dup/unknown-shape.
      return cards
    }
    if (!options.skipRegistryLookup) {
      const resolved = resolveCatalogCardsInRegistry(
        cards.value,
        options.registry ?? getDefaultRegistry(),
      )
      if (!resolved.ok) return resolved
    }
    changes.catalogCards = cards.value
  }

  // Reject null / deletion markers if sneaked in via unexpected types already handled.
  const overlay: HarnessOverlay = {
    schemaVersion: OVERLAY_SCHEMA,
    baseBaselineRef: baseRef.value,
    changes,
  }
  return validationOk(deepFreezeJson(cloneJson(overlay)))
}

export function overlayContentHash(overlay: HarnessOverlay): string {
  // Normative overlay payload is the full { schemaVersion, baseBaselineRef, changes }.
  return harnessContentHash({
    schemaVersion: overlay.schemaVersion,
    baseBaselineRef: overlay.baseBaselineRef,
    changes: overlay.changes,
  })
}

export function mergeOverlayOntoBaseline(
  baseline: HarnessDocument,
  overlay: HarnessOverlay,
): HarnessValidationResult<HarnessDocument> {
  if (
    overlay.baseBaselineRef.kind !== 'baseline' ||
    // caller must also check store identity; here we only merge shapes
    false
  ) {
    return fail('HARNESS_OVERLAY_BASE_MISMATCH', 'overlay base is not a baseline ref')
  }
  const merged: HarnessDocument = cloneJson(baseline)
  const changes = overlay.changes
  if (changes.systemInstructionTemplate !== undefined) {
    merged.control.systemInstructionTemplate = changes.systemInstructionTemplate
  }
  if (changes.taskNarrativeTemplate !== undefined) {
    merged.control.taskNarrativeTemplate = changes.taskNarrativeTemplate
  }
  if (changes.protocolRules !== undefined) {
    merged.control.protocolRules = [...changes.protocolRules]
  }
  if (changes.stopConditions !== undefined) {
    merged.control.termination = {
      successSource: SUCCESS_SOURCE,
      stopConditions: [...changes.stopConditions],
    }
  }
  if (changes.catalogCards !== undefined) {
    merged.catalogCards = changes.catalogCards.map((c) => ({
      id: c.id,
      version: c.version,
    }))
  }
  // agentSpecs remain fixed from baseline; verify closure against merged catalog.
  const closure = assertAgentSpecCatalogClosure(merged.agentSpecs, merged.catalogCards)
  if (!closure.ok) return closure
  // Re-validate full document shape after merge.
  return validateHarnessDocument(merged, { skipRegistryLookup: true })
}

export function refsEqual(a: HarnessStateRef, b: HarnessStateRef): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.revision === b.revision &&
    a.contentHash === b.contentHash
  )
}

export function requireHarnessDocument(
  raw: unknown,
  options?: Parameters<typeof validateHarnessDocument>[1],
): HarnessDocument {
  const result = validateHarnessDocument(raw, options)
  if (!result.ok) throwFail(result)
  return result.value
}

export function requireHarnessOverlay(
  raw: unknown,
  options?: Parameters<typeof validateHarnessOverlay>[1],
): HarnessOverlay {
  const result = validateHarnessOverlay(raw, options)
  if (!result.ok) throwFail(result)
  return result.value
}

export function requireHarnessStateRef(raw: unknown, path = 'ref'): HarnessStateRef {
  const result = validateHarnessStateRef(raw, path)
  if (!result.ok) throwFail(result)
  return result.value
}

export function dedupeCatalogRefs(refs: readonly CatalogCardRef[]): CatalogCardRef[] {
  const seen = new Set<string>()
  const out: CatalogCardRef[] = []
  for (const ref of refs) {
    const key = `${ref.id}@${ref.version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: ref.id, version: ref.version })
  }
  return out
}

export function assertDocumentAcceptsPin(
  document: HarnessDocument,
  codeProtocolPin: string,
): void {
  if (!isNonEmptyString(codeProtocolPin)) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      'codeProtocolPin must be a non-empty string',
    )
  }
  if (!document.compatibility.codeProtocolPins.includes(codeProtocolPin)) {
    throw harnessError(
      'HARNESS_PROTOCOL_INCOMPATIBLE',
      `document does not accept codeProtocolPin ${codeProtocolPin}`,
      {
        codeProtocolPin,
        accepted: document.compatibility.codeProtocolPins,
      },
    )
  }
}
