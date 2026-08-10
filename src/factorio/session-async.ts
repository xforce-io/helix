/**
 * Issue #7 — session/async/mailbox admission, budget, and Host effect helpers.
 * Pure functions + Host-facing types. Does not import Provider.
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import {
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_NODES,
  MAX_CHECKPOINT_NOTE_BYTES,
  MAX_HANDLES,
  MAX_HANDLES_PER_SESSION,
  MAX_PAYLOAD_PREVIEW_BYTES,
  MAX_SPAWN_COMPLETION_TOKENS,
  MAX_SPAWN_INPUT_BYTES,
  MAX_SPAWN_INSTRUCTIONS_BYTES,
  MAX_SPAWN_PROMPT_TOKENS,
  MAX_SESSION_LABEL_BYTES,
  MIN_SPAWN_RESERVE_TOKENS,
  PROMPT_FRAMING_BYTES,
  PROMPT_TOKEN_ESTIMATE_DIVISOR,
  WAIT_MAX_TIMEOUT_MS,
} from './session-async-constants.js'
import type {
  AgentEffect,
  MailboxEffect,
  SessionAsyncCapability,
  SessionEffect,
} from './types.js'
import type { HandleRecord, HandleView, SessionView } from './session-store.js'
import { handleRecordToView } from './session-store.js'

// ---------- Error codes ----------

export type SessionAsyncErrorCode =
  | 'SESSION_ASYNC_NOT_ENABLED'
  | 'SESSION_AUTH_DENIED'
  | 'SESSION_VERSION_NOT_FOUND'
  | 'SESSION_PARAM_INVALID'
  | 'AGENT_AUTH_DENIED'
  | 'AGENT_PARAM_INVALID'
  | 'AGENT_BUDGET_INSUFFICIENT'
  | 'AGENT_ACTIVE_HANDLE_LIMIT'
  | 'AGENT_HISTORICAL_HANDLE_LIMIT'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_WAIT_TIMEOUT'
  | 'AGENT_SPAWN_FAILED'
  | 'MAILBOX_AUTH_DENIED'
  | 'MAILBOX_PARAM_INVALID'
  | 'MAILBOX_MSG_TOO_LARGE'
  | 'MAILBOX_FULL'
  | 'MAILBOX_SESSION_BACKPRESSURE'
  | 'MAILBOX_NOT_FOUND'
  | 'MAILBOX_RECEIVE_TIMEOUT'
  | 'MULTIPLE_EFFECTS_IN_CELL'
  | 'UNKNOWN_METHOD'

export const ERROR_MESSAGES: Record<SessionAsyncErrorCode, string> = {
  SESSION_ASYNC_NOT_ENABLED: 'session async capability is not enabled',
  SESSION_AUTH_DENIED: 'session authorization denied',
  SESSION_VERSION_NOT_FOUND: 'session version not found',
  SESSION_PARAM_INVALID: 'session parameter invalid',
  AGENT_AUTH_DENIED: 'agent authorization denied',
  AGENT_PARAM_INVALID: 'agent parameter invalid',
  AGENT_BUDGET_INSUFFICIENT: 'agent budget insufficient',
  AGENT_ACTIVE_HANDLE_LIMIT: 'active handle limit reached',
  AGENT_HISTORICAL_HANDLE_LIMIT: 'historical handle limit reached',
  AGENT_NOT_FOUND: 'agent handle not found',
  AGENT_WAIT_TIMEOUT: 'agent wait timed out',
  AGENT_SPAWN_FAILED: 'agent spawn failed',
  MAILBOX_AUTH_DENIED: 'mailbox authorization denied',
  MAILBOX_PARAM_INVALID: 'mailbox parameter invalid',
  MAILBOX_MSG_TOO_LARGE: 'mailbox message too large',
  MAILBOX_FULL: 'mailbox full',
  MAILBOX_SESSION_BACKPRESSURE: 'session mailbox backpressure',
  MAILBOX_NOT_FOUND: 'mailbox not found',
  MAILBOX_RECEIVE_TIMEOUT: 'mailbox receive timed out',
  MULTIPLE_EFFECTS_IN_CELL: 'one external effect per cell',
  UNKNOWN_METHOD: 'unknown effect method',
}

export function errorBody(code: SessionAsyncErrorCode, message?: string): {
  code: SessionAsyncErrorCode
  message: string
} {
  return { code, message: message ?? ERROR_MESSAGES[code] }
}

// ---------- Budget (align design/5 §5.3 / L2 §5.6) ----------

export interface SpawnDeclaredLimits {
  estimatedPromptTokens: number
  declaredPromptTokens: number
  requestedCompletionTokens: number
  availableCompletionTokens: number
  declaredCompletionTokens: number
  reserve: number
}

export type SpawnReserveDecision =
  | { ok: true; declared: SpawnDeclaredLimits }
  | { ok: false; reason: 'prompt_exceeds_pool' | 'min_reserve'; declared: SpawnDeclaredLimits }

export interface SpawnSettlement {
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
  remainingAfter: number
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function estimateTokens(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / PROMPT_TOKEN_ESTIMATE_DIVISOR))
}

export type CanonicalFailure =
  | { ok: false; code: 'AGENT_PARAM_INVALID'; message: string }
  | { ok: true; bytes: Uint8Array; byteLength: number }

export function isMissingInput(value: unknown): boolean {
  return value === undefined || value === null
}

export function canonicalizeSpawnInput(value: unknown): CanonicalFailure {
  if (isMissingInput(value)) {
    return { ok: true, bytes: new Uint8Array(), byteLength: 0 }
  }
  let nodes = 0
  const walk = (v: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_CANONICAL_JSON_NODES) {
      throw Object.assign(new Error('canonical input too large'), { code: 'too_large' })
    }
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
      throw Object.assign(new Error('canonical input too deep'), { code: 'too_deep' })
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw Object.assign(new Error('non-finite number'), { code: 'non_finite' })
      }
      return v
    }
    if (Array.isArray(v)) return v.map(item => walk(item, depth + 1))
    if (typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, item]) => [k, walk(item, depth + 1)]),
      )
    }
    throw Object.assign(new Error('unsupported input type'), { code: 'type' })
  }
  try {
    const normalized = walk(value, 0)
    const text = JSON.stringify(normalized)
    const bytes = utf8Encode(text)
    if (bytes.byteLength > MAX_SPAWN_INPUT_BYTES) {
      return {
        ok: false,
        code: 'AGENT_PARAM_INVALID',
        message: 'spawn input exceeds byte limit',
      }
    }
    return { ok: true, bytes, byteLength: bytes.byteLength }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'type'
    return {
      ok: false,
      code: 'AGENT_PARAM_INVALID',
      message: `spawn input invalid (${code})`,
    }
  }
}

export function computeSpawnDeclaredLimits(args: {
  instructionsByteLength: number
  inputByteLength: number
  maxOutputTokens: number | undefined
  remainingTokens: number
}): SpawnDeclaredLimits {
  const estimatedPromptTokens = estimateTokens(
    args.instructionsByteLength + args.inputByteLength + PROMPT_FRAMING_BYTES,
  )
  const declaredPromptTokens = Math.min(estimatedPromptTokens, MAX_SPAWN_PROMPT_TOKENS)
  const requestedCompletionTokens = clampInt(
    args.maxOutputTokens ?? MAX_SPAWN_COMPLETION_TOKENS,
    1,
    MAX_SPAWN_COMPLETION_TOKENS,
  )
  const availableCompletionTokens = Math.max(0, args.remainingTokens - declaredPromptTokens)
  const declaredCompletionTokens = Math.min(
    requestedCompletionTokens,
    MAX_SPAWN_COMPLETION_TOKENS,
    availableCompletionTokens,
  )
  return {
    estimatedPromptTokens,
    declaredPromptTokens,
    requestedCompletionTokens,
    availableCompletionTokens,
    declaredCompletionTokens,
    reserve: declaredPromptTokens + declaredCompletionTokens,
  }
}

export function decideSpawnReserve(args: {
  instructionsByteLength: number
  inputByteLength: number
  maxOutputTokens: number | undefined
  remainingTokens: number
}): SpawnReserveDecision {
  const declared = computeSpawnDeclaredLimits(args)
  if (declared.declaredPromptTokens > args.remainingTokens) {
    return { ok: false, reason: 'prompt_exceeds_pool', declared }
  }
  if (declared.reserve < MIN_SPAWN_RESERVE_TOKENS) {
    return { ok: false, reason: 'min_reserve', declared }
  }
  return { ok: true, declared }
}

export function applySpawnReserve(remainingTokens: number, reserve: number): number {
  const next = remainingTokens - reserve
  if (!Number.isFinite(next) || next < 0) {
    throw new Error('spawn reserve would make remainingTokens negative')
  }
  return next
}

export function settleSpawnReserve(args: {
  remainingBeforeSettle: number
  reserve: number
  actualUsageTokens: number
}): SpawnSettlement {
  const actualUsageTokens = Math.max(0, args.actualUsageTokens)
  const chargedTokens = Math.min(args.reserve, actualUsageTokens)
  const overflowTokens = Math.max(0, actualUsageTokens - args.reserve)
  const remainingAfter = args.remainingBeforeSettle + (args.reserve - chargedTokens)
  if (!Number.isFinite(remainingAfter) || remainingAfter < 0) {
    throw new Error('spawn settle produced invalid remainingTokens')
  }
  return { actualUsageTokens, chargedTokens, overflowTokens, remainingAfter }
}

export function refundSpawnReserve(
  remainingBeforeSettle: number,
  reserve: number,
): SpawnSettlement {
  return settleSpawnReserve({
    remainingBeforeSettle,
    reserve,
    actualUsageTokens: 0,
  })
}

// ---------- Spawn param admission ----------

export interface PreparedSpawn {
  ok: true
  instructions: string
  instructionsBytes: Uint8Array
  inputByteLength: number
  inputCanonical: CanonicalFailure & { ok: true }
  maxOutputTokens: number | undefined
  mailbox: boolean
  requestDigest: string
  declared: SpawnDeclaredLimits
}

export type SpawnPrepareOutcome =
  | PreparedSpawn
  | { ok: false; code: SessionAsyncErrorCode; message: string }

export function prepareSpawnAdmission(input: {
  instructions: unknown
  input?: unknown
  maxOutputTokens?: unknown
  mailbox?: unknown
  remainingTokens: number
}): SpawnPrepareOutcome {
  if (typeof input.instructions !== 'string') {
    return {
      ok: false,
      code: 'AGENT_PARAM_INVALID',
      message: 'instructions must be a string',
    }
  }
  const instructionsBytes = utf8Encode(input.instructions)
  if (instructionsBytes.byteLength === 0) {
    return {
      ok: false,
      code: 'AGENT_PARAM_INVALID',
      message: 'instructions must be non-empty',
    }
  }
  if (instructionsBytes.byteLength > MAX_SPAWN_INSTRUCTIONS_BYTES) {
    return {
      ok: false,
      code: 'AGENT_PARAM_INVALID',
      message: 'instructions exceed byte limit',
    }
  }

  let maxOutputTokens: number | undefined
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
    if (
      typeof input.maxOutputTokens !== 'number' ||
      !Number.isFinite(input.maxOutputTokens) ||
      !Number.isInteger(input.maxOutputTokens) ||
      input.maxOutputTokens <= 0
    ) {
      return {
        ok: false,
        code: 'AGENT_PARAM_INVALID',
        message: 'max_output_tokens must be a positive integer',
      }
    }
    maxOutputTokens = input.maxOutputTokens
  }

  const mailbox =
    input.mailbox === undefined || input.mailbox === null ? true : input.mailbox === true
  if (
    input.mailbox !== undefined &&
    input.mailbox !== null &&
    typeof input.mailbox !== 'boolean'
  ) {
    return {
      ok: false,
      code: 'AGENT_PARAM_INVALID',
      message: 'mailbox must be a boolean',
    }
  }

  const inputCanonical = canonicalizeSpawnInput(input.input)
  if (!inputCanonical.ok) {
    return {
      ok: false,
      code: inputCanonical.code,
      message: inputCanonical.message,
    }
  }

  const declared = computeSpawnDeclaredLimits({
    instructionsByteLength: instructionsBytes.byteLength,
    inputByteLength: inputCanonical.byteLength,
    maxOutputTokens,
    remainingTokens: input.remainingTokens,
  })

  const requestDigest = `sha256:${createHash('sha256')
    .update(instructionsBytes)
    .update(new Uint8Array([0]))
    .update(inputCanonical.bytes)
    .update(new Uint8Array([0]))
    .update(String(declared.declaredCompletionTokens))
    .digest('hex')}`

  return {
    ok: true,
    instructions: input.instructions,
    instructionsBytes,
    inputByteLength: inputCanonical.byteLength,
    inputCanonical,
    maxOutputTokens,
    mailbox,
    requestDigest,
    declared,
  }
}

// ---------- Capability projection ----------

export function projectSessionAsyncCapability(args: {
  enabled: boolean
  sessionId: string | null
  sessionVersion: number | null
  remainingActiveHandleSlots: number
  remainingHistoricalHandleSlots: number
}): SessionAsyncCapability {
  return {
    enabled: args.enabled,
    maxActiveHandles: MAX_HANDLES,
    remainingActiveHandleSlots: Math.max(0, args.remainingActiveHandleSlots),
    maxHandlesPerSession: MAX_HANDLES_PER_SESSION,
    remainingHistoricalHandleSlots: Math.max(0, args.remainingHistoricalHandleSlots),
    maxMailboxDepth: 32,
    maxMailboxMsgBytes: 16_384,
    sessionId: args.sessionId,
    sessionVersion: args.sessionVersion,
  }
}

// ---------- Param validators ----------

export function validateSessionCreateParams(params: Record<string, unknown>):
  | { ok: true; capabilityToken: string; metadataLabel?: string }
  | { ok: false; code: 'SESSION_PARAM_INVALID'; message: string } {
  const token = params['capabilityToken']
  if (typeof token !== 'string' || token.length === 0) {
    return {
      ok: false,
      code: 'SESSION_PARAM_INVALID',
      message: 'capabilityToken is required',
    }
  }
  let metadataLabel: string | undefined
  if (params['metadata'] !== undefined && params['metadata'] !== null) {
    if (typeof params['metadata'] !== 'object' || Array.isArray(params['metadata'])) {
      return {
        ok: false,
        code: 'SESSION_PARAM_INVALID',
        message: 'metadata must be an object',
      }
    }
    const label = (params['metadata'] as Record<string, unknown>)['label']
    if (label !== undefined) {
      if (typeof label !== 'string') {
        return {
          ok: false,
          code: 'SESSION_PARAM_INVALID',
          message: 'metadata.label must be a string',
        }
      }
      if (Buffer.byteLength(label, 'utf8') > MAX_SESSION_LABEL_BYTES) {
        return {
          ok: false,
          code: 'SESSION_PARAM_INVALID',
          message: 'metadata.label too long',
        }
      }
      metadataLabel = label
    }
  }
  return {
    ok: true,
    capabilityToken: token,
    ...(metadataLabel === undefined ? {} : { metadataLabel }),
  }
}

export function validateSessionResumeParams(params: Record<string, unknown>):
  | { ok: true; sessionId: string; capabilityToken: string; version?: number }
  | { ok: false; code: 'SESSION_PARAM_INVALID'; message: string } {
  const sessionId = params['sessionId']
  const token = params['capabilityToken']
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return {
      ok: false,
      code: 'SESSION_PARAM_INVALID',
      message: 'sessionId is required',
    }
  }
  if (typeof token !== 'string' || token.length === 0) {
    return {
      ok: false,
      code: 'SESSION_PARAM_INVALID',
      message: 'capabilityToken is required',
    }
  }
  let version: number | undefined
  if (params['version'] !== undefined && params['version'] !== null) {
    if (
      typeof params['version'] !== 'number' ||
      !Number.isInteger(params['version']) ||
      params['version'] < 1
    ) {
      return {
        ok: false,
        code: 'SESSION_PARAM_INVALID',
        message: 'version must be a positive integer',
      }
    }
    version = params['version']
  }
  return {
    ok: true,
    sessionId,
    capabilityToken: token,
    ...(version === undefined ? {} : { version }),
  }
}

export function validateCheckpointParams(params: Record<string, unknown>):
  | { ok: true; note?: string }
  | { ok: false; code: 'SESSION_PARAM_INVALID'; message: string } {
  if (params['note'] === undefined || params['note'] === null) {
    return { ok: true }
  }
  if (typeof params['note'] !== 'string') {
    return {
      ok: false,
      code: 'SESSION_PARAM_INVALID',
      message: 'note must be a string',
    }
  }
  if (Buffer.byteLength(params['note'], 'utf8') > MAX_CHECKPOINT_NOTE_BYTES) {
    return {
      ok: false,
      code: 'SESSION_PARAM_INVALID',
      message: 'note too long',
    }
  }
  return { ok: true, note: params['note'] }
}

export function clampWaitTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return WAIT_MAX_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) return WAIT_MAX_TIMEOUT_MS
  return clampInt(value, 0, WAIT_MAX_TIMEOUT_MS)
}

export function clampReceiveTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return clampInt(value, 0, WAIT_MAX_TIMEOUT_MS)
}

// ---------- Effect record builders ----------

export function sessionEffectFromView(
  method: SessionEffect['method'],
  view: SessionView,
  noop?: boolean,
): SessionEffect {
  return {
    method,
    sessionId: view.session_id,
    sessionVersion: view.session_version,
    projectionHash: view.projection_hash,
    cutoffCausalSeq: view.cutoff_causal_seq,
    ...(noop === undefined ? {} : { noop }),
  }
}

export function agentEffectFromHandle(
  method: AgentEffect['method'],
  handle: HandleRecord | HandleView,
  extras?: Partial<AgentEffect>,
): AgentEffect {
  const view = 'handle_id' in handle ? handle : handleRecordToView(handle)
  const record = 'handleId' in handle ? (handle as HandleRecord) : undefined
  return {
    method,
    handleId: view.handle_id,
    ...(view.child_run_id ? { childRunId: view.child_run_id } : {}),
    status: view.status,
    ...(extras?.requestDigest ? { requestDigest: extras.requestDigest } : {}),
    ...(record
      ? {
          reservation: {
            reservedTokens: record.reservedTokens,
            declaredPromptTokens: record.declaredPromptTokens,
            declaredCompletionTokens: record.declaredCompletionTokens,
            requestedCompletionTokens: record.requestedCompletionTokens,
            actualUsageTokens: record.actualUsageTokens,
            chargedTokens: record.chargedTokens,
            overflowTokens: record.overflowTokens,
          },
        }
      : extras?.reservation
        ? { reservation: extras.reservation }
        : {}),
    ...(extras?.error ? { error: extras.error } : {}),
  }
}

export function mailboxEffectRecord(
  method: MailboxEffect['method'],
  fields: Omit<MailboxEffect, 'method'>,
): MailboxEffect {
  return { method, ...fields }
}

export function sessionViewToWire(view: SessionView): Record<string, unknown> {
  const out: Record<string, unknown> = {
    session_id: view.session_id,
    session_version: view.session_version,
    projection_hash: view.projection_hash,
    cutoff_causal_seq: view.cutoff_causal_seq,
    handles: view.handles,
    mailboxes: view.mailboxes,
    memory_summary_ref: view.memory_summary_ref,
    principal_id: view.principal_id,
    lifecycle: view.lifecycle,
  }
  if (view.live_applied_merge_keys_count !== undefined) {
    out['live_applied_merge_keys_count'] = view.live_applied_merge_keys_count
  }
  if (view.session_capability_token !== undefined) {
    out['session_capability_token'] = view.session_capability_token
  }
  if (view.noop !== undefined) out['noop'] = view.noop
  if (view.committed_version !== undefined) {
    out['committed_version'] = view.committed_version
  }
  return out
}

export function handleViewToWire(view: HandleView): Record<string, unknown> {
  return {
    handle_id: view.handle_id,
    child_run_id: view.child_run_id,
    status: view.status,
    preview: view.preview.slice(0, MAX_PAYLOAD_PREVIEW_BYTES),
    result_ref: view.result_ref,
    error: view.error,
    terminal_generation: view.terminal_generation,
  }
}

export function rejectedHandleView(
  handleId: string,
  code: SessionAsyncErrorCode,
  message?: string,
): HandleView {
  return {
    handle_id: handleId,
    child_run_id: null,
    status: 'rejected',
    preview: '',
    result_ref: null,
    error: errorBody(code, message),
    terminal_generation: 1,
  }
}

/** Count exclusive write-path effects on a cell record. */
export function countCellEffects(record: {
  factorioEffect?: unknown
  modelEffect?: unknown
  sessionEffect?: unknown
  agentEffect?: unknown
  mailboxEffect?: unknown
}): number {
  let n = 0
  if (record.factorioEffect !== undefined) n += 1
  if (record.modelEffect !== undefined) n += 1
  if (record.sessionEffect !== undefined) n += 1
  if (record.agentEffect !== undefined) n += 1
  if (record.mailboxEffect !== undefined) n += 1
  return n
}

export function assertSessionEffectsExclusive(record: {
  factorioEffect?: unknown
  modelEffect?: unknown
  sessionEffect?: unknown
  agentEffect?: unknown
  mailboxEffect?: unknown
}): boolean {
  return countCellEffects(record) <= 1
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}
