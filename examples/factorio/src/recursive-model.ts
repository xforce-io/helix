import { createHash } from 'node:crypto'
import type {
  ModelEffect,
  ModelEffectReservation,
  RecursiveModelErrorCode,
  RecursiveModelResult,
  RecursiveModelStatus,
} from './types.js'

/** L2 §9.1 — versioned acceptance constants (must not be redefined in tests). */
export const MAX_RECURSIVE_CALLS_PER_RUN = 4
export const MAX_RECURSIVE_INSTRUCTIONS_BYTES = 8_000
export const MAX_RECURSIVE_INPUT_BYTES = 8_000
export const MAX_RECURSIVE_PROMPT_TOKENS = 4_096
export const MAX_RECURSIVE_COMPLETION_TOKENS = 2_048
export const MAX_RECURSIVE_RESULT_TEXT_CHARS = 4_096
export const MAX_RECURSIVE_GOAL_CHARS = 512
export const DEFAULT_PARENT_RECURSIVE_TOKEN_POOL = 16_384
export const MIN_RESERVE_TOKENS = 1
export const CONTROL_SETTLE_TOLERANCE_MS = 100
export const CHILD_REPLAY_SAFETY_WALL_MS = 300_000
export const RECURSIVE_TEMPERATURE = 0
export const PROMPT_TOKEN_ESTIMATE_DIVISOR = 4
export const PROMPT_FRAMING_BYTES = 64
export const MAX_CANONICAL_JSON_DEPTH = 8
export const MAX_CANONICAL_JSON_NODES = 1_024
export const KERNEL_PROTOCOL = '2' as const
export const RECURSIVE_MODEL_RESULT_SCHEMA = 'helix.recursive-model-result/v1' as const
export const MODEL_RESPONSE_KIND = 'helix.model-response' as const
export const MODEL_RESPONSE_SCHEMA = 'helix.model-response/v1' as const
export const RECURSIVE_CHILD_AGENT_ID = 'helix.factorio.recursive-model' as const

export type CanonicalInputFailure =
  | { ok: false; code: 'RECURSIVE_PARAM_INVALID'; message: string }
  | { ok: true; bytes: Uint8Array; byteLength: number }

export interface DeclaredLimits {
  estimatedPromptTokens: number
  declaredPromptTokens: number
  requestedCompletionTokens: number
  availableCompletionTokens: number
  declaredCompletionTokens: number
  reserve: number
}

export interface ReserveDecision {
  ok: boolean
  reason?: 'prompt_exceeds_pool' | 'min_reserve'
  declared: DeclaredLimits
}

export interface Settlement {
  actualUsageTokens: number
  chargedTokens: number
  overflowTokens: number
  remainingAfter: number
}

export interface RecursiveAdmissionInput {
  instructions: unknown
  input: unknown
  maxOutputTokens: unknown
  remainingTokens: number
  model: string
}

export interface PreparedRecursiveAdmission {
  ok: true
  instructions: string
  instructionsBytes: Uint8Array
  inputCanonicalBytes: Uint8Array
  inputByteLength: number
  declared: DeclaredLimits
  requestDigest: string
  userContent: string
}

export type RecursiveAdmissionOutcome =
  | {
      ok: false
      code: 'RECURSIVE_PARAM_INVALID'
      message: string
      result: RecursiveModelResult
      modelEffect: ModelEffect
    }
  | PreparedRecursiveAdmission

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function sha256Hex(bytes: Uint8Array | string): string {
  const hash = createHash('sha256')
  if (typeof bytes === 'string') hash.update(bytes, 'utf8')
  else hash.update(bytes)
  return hash.digest('hex')
}

function sha256Digest(bytes: Uint8Array | string): string {
  return `sha256:${sha256Hex(bytes)}`
}

/**
 * Decode-layer missing/null normalization (IMP-2).
 * Omitted / JSON null / Python None → missing → empty canonical bytes.
 * Never encodes root null as b"null".
 */
export function isMissingRecursiveInput(value: unknown): boolean {
  return value === undefined || value === null
}

/**
 * Canonicalize a valued recursive-model input root.
 * Root types: boolean | number | string | array | object (no root null).
 */
export function canonicalizeRecursiveInput(value: unknown): CanonicalInputFailure {
  if (isMissingRecursiveInput(value)) {
    return { ok: true, bytes: new Uint8Array(0), byteLength: 0 }
  }

  let nodes = 0
  const visit = (node: unknown, depth: number): string => {
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
      throw Object.assign(new Error('input exceeds canonical JSON depth limit'), {
        code: 'RECURSIVE_PARAM_INVALID' as const,
      })
    }
    nodes += 1
    if (nodes > MAX_CANONICAL_JSON_NODES) {
      throw Object.assign(new Error('input exceeds canonical JSON node limit'), {
        code: 'RECURSIVE_PARAM_INVALID' as const,
      })
    }
    if (node === null) return 'null'
    if (typeof node === 'boolean') return node ? 'true' : 'false'
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) {
        throw Object.assign(new Error('input number must be finite'), {
          code: 'RECURSIVE_PARAM_INVALID' as const,
        })
      }
      return JSON.stringify(node)
    }
    if (typeof node === 'string') return JSON.stringify(node)
    if (Array.isArray(node)) {
      const parts = node.map(item => visit(item, depth + 1))
      return `[${parts.join(',')}]`
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => {
          if (left < right) return -1
          if (left > right) return 1
          return 0
        })
      const parts = entries.map(([key, item]) => `${JSON.stringify(key)}:${visit(item, depth + 1)}`)
      return `{${parts.join(',')}}`
    }
    throw Object.assign(new Error(`unsupported input type: ${typeof node}`), {
      code: 'RECURSIVE_PARAM_INVALID' as const,
    })
  }

  try {
    // Root null is missing (handled above); valued root must not be null.
    if (value === null) {
      return {
        ok: false,
        code: 'RECURSIVE_PARAM_INVALID',
        message: 'valued input root must not be null',
      }
    }
    const text = visit(value, 1)
    const bytes = utf8Encode(text)
    return { ok: true, bytes, byteLength: bytes.byteLength }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'invalid recursive model input'
    return { ok: false, code: 'RECURSIVE_PARAM_INVALID', message }
  }
}

export function estimateTokens(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0
  return Math.ceil(byteLength / PROMPT_TOKEN_ESTIMATE_DIVISOR)
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function computeDeclaredLimits(args: {
  instructionsByteLength: number
  inputByteLength: number
  maxOutputTokens: number | undefined
  remainingTokens: number
}): DeclaredLimits {
  const estimatedPromptTokens = estimateTokens(
    args.instructionsByteLength + args.inputByteLength + PROMPT_FRAMING_BYTES,
  )
  const declaredPromptTokens = Math.min(estimatedPromptTokens, MAX_RECURSIVE_PROMPT_TOKENS)
  const requestedCompletionTokens = clampInt(
    args.maxOutputTokens ?? MAX_RECURSIVE_COMPLETION_TOKENS,
    1,
    MAX_RECURSIVE_COMPLETION_TOKENS,
  )
  const availableCompletionTokens = Math.max(0, args.remainingTokens - declaredPromptTokens)
  const declaredCompletionTokens = Math.min(
    requestedCompletionTokens,
    MAX_RECURSIVE_COMPLETION_TOKENS,
    availableCompletionTokens,
  )
  const reserve = declaredPromptTokens + declaredCompletionTokens
  return {
    estimatedPromptTokens,
    declaredPromptTokens,
    requestedCompletionTokens,
    availableCompletionTokens,
    declaredCompletionTokens,
    reserve,
  }
}

/** Provider-front budget gate (B4). Does not mutate the pool. */
export function decideReserve(args: {
  instructionsByteLength: number
  inputByteLength: number
  maxOutputTokens: number | undefined
  remainingTokens: number
}): ReserveDecision {
  const declared = computeDeclaredLimits(args)
  if (declared.declaredPromptTokens > args.remainingTokens) {
    return { ok: false, reason: 'prompt_exceeds_pool', declared }
  }
  if (declared.reserve < MIN_RESERVE_TOKENS) {
    return { ok: false, reason: 'min_reserve', declared }
  }
  return { ok: true, declared }
}

/**
 * Apply reserve against remainingTokens (pure). Caller owns atomic commit.
 * remaining_after_reserve = remaining_before - reserve
 */
export function applyReserve(remainingTokens: number, reserve: number): number {
  const next = remainingTokens - reserve
  if (!Number.isFinite(next) || next < 0) {
    throw new Error('reserve would make remainingTokens negative')
  }
  return next
}

/**
 * Settle after the unique child LLM terminal.
 * remaining_after = remaining_before_settle + (reserve - charged)
 *                 = remaining_before_reserve - charged
 */
export function settleReserve(args: {
  remainingBeforeSettle: number
  reserve: number
  inputTokens?: number | null
  outputTokens?: number | null
}): Settlement {
  const actualUsageTokens =
    (args.inputTokens ?? 0) + (args.outputTokens ?? 0)
  const chargedTokens = Math.min(args.reserve, Math.max(0, actualUsageTokens))
  const overflowTokens = Math.max(0, actualUsageTokens - args.reserve)
  const remainingAfter = args.remainingBeforeSettle + (args.reserve - chargedTokens)
  if (!Number.isFinite(remainingAfter) || remainingAfter < 0) {
    throw new Error('settle produced invalid remainingTokens')
  }
  return { actualUsageTokens, chargedTokens, overflowTokens, remainingAfter }
}

/** Full refund path for C1/C2 pre-LLM failures. */
export function refundReserve(remainingBeforeSettle: number, reserve: number): Settlement {
  return settleReserve({
    remainingBeforeSettle,
    reserve,
    inputTokens: 0,
    outputTokens: 0,
  })
}

export function buildRecursiveUserContent(
  instructions: string,
  inputCanonicalBytes: Uint8Array,
): string {
  let content = `Instructions:\n${instructions}\n`
  if (inputCanonicalBytes.byteLength > 0) {
    content += `Input-JSON:\n${utf8Decode(inputCanonicalBytes)}\n`
  }
  return content
}

export function computeRequestDigest(args: {
  instructionsBytes: Uint8Array
  inputCanonicalBytes: Uint8Array
  declaredCompletionTokens: number
  model: string
}): string {
  const body =
    'helix.rmc.req/v1\n' +
    `instructions_utf8_sha256=${sha256Hex(args.instructionsBytes)}\n` +
    `input_canonical_sha256=${sha256Hex(args.inputCanonicalBytes)}\n` +
    `max_output_tokens=${args.declaredCompletionTokens}\n` +
    `model=${args.model}\n` +
    'temperature=0\n'
  return sha256Digest(body)
}

export function emptyReservation(partial?: Partial<ModelEffectReservation>): ModelEffectReservation {
  return {
    reservedTokens: 0,
    declaredPromptTokens: 0,
    declaredCompletionTokens: 0,
    actualUsageTokens: 0,
    chargedTokens: 0,
    overflowTokens: 0,
    ...partial,
  }
}

export function reservationFromDeclared(
  declared: DeclaredLimits,
  extras?: Partial<ModelEffectReservation>,
): ModelEffectReservation {
  return emptyReservation({
    reservedTokens: 0,
    declaredPromptTokens: declared.declaredPromptTokens,
    declaredCompletionTokens: declared.declaredCompletionTokens,
    requestedCompletionTokens: declared.requestedCompletionTokens,
    ...extras,
  })
}

export function truncatePreview(text: string, maxChars = MAX_RECURSIVE_RESULT_TEXT_CHARS): {
  text: string
  truncated: boolean
} {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

export function truncateGoal(text: string, maxChars = MAX_RECURSIVE_GOAL_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

export function allocateChildRunId(parentRunId: string, ordinal: number): string {
  return `${parentRunId}:rmc:${ordinal}`
}

export function buildRejectedResult(args: {
  code: RecursiveModelErrorCode
  message: string
  reservation?: ModelEffectReservation
  requestDigest?: string
  childRunId?: string | null
  attachFailed?: boolean
}): RecursiveModelResult {
  const status: RecursiveModelStatus =
    args.code === 'RECURSIVE_MODEL_CANCELLED' ? 'cancelled' : 'rejected'
  // C1/C2 and post-start failures use failed/cancelled; admission uses rejected.
  const resolvedStatus: RecursiveModelStatus =
    args.code === 'RECURSIVE_CHILD_ATTACH_FAILED' ||
    args.code === 'RECURSIVE_CHILD_POST_ATTACH_FAILED' ||
    args.code === 'RECURSIVE_MODEL_FAILED' ||
    args.code === 'RECURSIVE_MODEL_DEADLINE' ||
    args.code === 'RECURSIVE_MODEL_INTERNAL'
      ? 'failed'
      : args.code === 'RECURSIVE_MODEL_CANCELLED'
        ? 'cancelled'
        : 'rejected'
  void status
  return {
    schema: RECURSIVE_MODEL_RESULT_SCHEMA,
    status: resolvedStatus,
    text: '',
    textTruncated: false,
    childRunId: args.childRunId === undefined ? null : args.childRunId,
    usage: null,
    responseRef: null,
    reservation: args.reservation ?? emptyReservation(),
    ...(args.requestDigest === undefined ? {} : { requestDigest: args.requestDigest }),
    ...(args.attachFailed === true ? { attachFailed: true } : {}),
    error: { code: args.code, message: args.message },
  }
}

export function buildSucceededResult(args: {
  text: string
  textTruncated: boolean
  childRunId: string
  usage: { inputTokens: number; outputTokens: number }
  responseRef: RecursiveModelResult['responseRef']
  reservation: ModelEffectReservation
  requestDigest: string
}): RecursiveModelResult {
  return {
    schema: RECURSIVE_MODEL_RESULT_SCHEMA,
    status: 'succeeded',
    text: args.text,
    textTruncated: args.textTruncated,
    childRunId: args.childRunId,
    usage: args.usage,
    responseRef: args.responseRef,
    reservation: args.reservation,
    requestDigest: args.requestDigest,
    error: null,
  }
}

export function modelEffectFromResult(
  result: RecursiveModelResult,
  request?: { instructions: string; input?: unknown; model: string },
): ModelEffect {
  return {
    method: 'models.call',
    ...(result.childRunId ? { childRunId: result.childRunId } : {}),
    status: result.status,
    ...(result.requestDigest === undefined ? {} : { requestDigest: result.requestDigest }),
    ...(result.requestDigest !== undefined && request
      ? {
          request: {
            instructions: request.instructions,
            ...(request.input === undefined ? {} : { input: request.input }),
            model: request.model,
          },
        }
      : {}),
    ...(result.attachFailed === true ? { attachFailed: true } : {}),
    textPreview: result.text,
    textTruncated: result.textTruncated,
    ...(result.usage
      ? { usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }
      : {}),
    ...(result.responseRef ? { responseRef: result.responseRef } : {}),
    reservation: result.reservation ?? emptyReservation(),
    ...(result.error ? { error: result.error } : {}),
  }
}

export function resultToWire(result: RecursiveModelResult): Record<string, unknown> {
  return {
    schema: result.schema,
    status: result.status,
    text: result.text,
    textTruncated: result.textTruncated,
    childRunId: result.childRunId,
    usage: result.usage,
    responseRef: result.responseRef,
    reservation: result.reservation,
    ...(result.requestDigest === undefined ? {} : { requestDigest: result.requestDigest }),
    ...(result.attachFailed === true ? { attachFailed: true } : { attachFailed: false }),
    error: result.error,
  }
}

/**
 * Param + declared-star / digest phase of admission (I4 order steps 1-2).
 * Does not check occupied/enabled/count/budget commit.
 */
export function prepareRecursiveAdmission(
  input: RecursiveAdmissionInput,
): RecursiveAdmissionOutcome {
  if (typeof input.instructions !== 'string') {
    const result = buildRejectedResult({
      code: 'RECURSIVE_PARAM_INVALID',
      message: 'instructions must be a string',
    })
    return {
      ok: false,
      code: 'RECURSIVE_PARAM_INVALID',
      message: result.error!.message,
      result,
      modelEffect: modelEffectFromResult(result),
    }
  }
  const instructions = input.instructions
  const instructionsBytes = utf8Encode(instructions)
  if (instructionsBytes.byteLength > MAX_RECURSIVE_INSTRUCTIONS_BYTES) {
    const result = buildRejectedResult({
      code: 'RECURSIVE_PARAM_INVALID',
      message: 'instructions exceed byte limit',
    })
    return {
      ok: false,
      code: 'RECURSIVE_PARAM_INVALID',
      message: result.error!.message,
      result,
      modelEffect: modelEffectFromResult(result),
    }
  }
  if (instructions.length === 0) {
    const result = buildRejectedResult({
      code: 'RECURSIVE_PARAM_INVALID',
      message: 'instructions must be non-empty',
    })
    return {
      ok: false,
      code: 'RECURSIVE_PARAM_INVALID',
      message: result.error!.message,
      result,
      modelEffect: modelEffectFromResult(result),
    }
  }

  const canonical = canonicalizeRecursiveInput(input.input)
  if (!canonical.ok) {
    const result = buildRejectedResult({
      code: 'RECURSIVE_PARAM_INVALID',
      message: canonical.message,
    })
    return {
      ok: false,
      code: 'RECURSIVE_PARAM_INVALID',
      message: canonical.message,
      result,
      modelEffect: modelEffectFromResult(result),
    }
  }
  if (canonical.byteLength > MAX_RECURSIVE_INPUT_BYTES) {
    const result = buildRejectedResult({
      code: 'RECURSIVE_PARAM_INVALID',
      message: 'input exceeds byte limit',
    })
    return {
      ok: false,
      code: 'RECURSIVE_PARAM_INVALID',
      message: result.error!.message,
      result,
      modelEffect: modelEffectFromResult(result),
    }
  }

  let maxOutputTokens: number | undefined
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
    if (
      typeof input.maxOutputTokens !== 'number' ||
      !Number.isFinite(input.maxOutputTokens) ||
      !Number.isInteger(input.maxOutputTokens)
    ) {
      const result = buildRejectedResult({
        code: 'RECURSIVE_PARAM_INVALID',
        message: 'maxOutputTokens must be an integer',
      })
      return {
        ok: false,
        code: 'RECURSIVE_PARAM_INVALID',
        message: result.error!.message,
        result,
        modelEffect: modelEffectFromResult(result),
      }
    }
    maxOutputTokens = input.maxOutputTokens
  }

  const declared = computeDeclaredLimits({
    instructionsByteLength: instructionsBytes.byteLength,
    inputByteLength: canonical.byteLength,
    maxOutputTokens,
    remainingTokens: input.remainingTokens,
  })
  const requestDigest = computeRequestDigest({
    instructionsBytes,
    inputCanonicalBytes: canonical.bytes,
    declaredCompletionTokens: declared.declaredCompletionTokens,
    model: input.model,
  })
  const userContent = buildRecursiveUserContent(instructions, canonical.bytes)
  return {
    ok: true,
    instructions,
    instructionsBytes,
    inputCanonicalBytes: canonical.bytes,
    inputByteLength: canonical.byteLength,
    declared,
    requestDigest,
    userContent,
  }
}

export function mapProviderError(error: unknown): {
  status: RecursiveModelStatus
  code: RecursiveModelErrorCode
  message: string
  parentTermination?: 'cancelled' | 'wall_budget_exhausted'
} {
  const structured = error as { code?: string; message?: string; name?: string }
  const code = String(structured.code ?? '')
  const message = String(structured.message ?? (error instanceof Error ? error.message : 'model failed'))
  if (code === 'IO_CANCELLED' || /cancelled/i.test(message)) {
    return {
      status: 'cancelled',
      code: 'RECURSIVE_MODEL_CANCELLED',
      message: 'recursive model call cancelled',
      parentTermination: 'cancelled',
    }
  }
  if (code === 'IO_DEADLINE_EXCEEDED' || /deadline/i.test(message)) {
    return {
      status: 'failed',
      code: 'RECURSIVE_MODEL_DEADLINE',
      message: 'recursive model call deadline exceeded',
      parentTermination: 'wall_budget_exhausted',
    }
  }
  return {
    status: 'failed',
    code: 'RECURSIVE_MODEL_FAILED',
    message: message.slice(0, 512),
  }
}

/** I4 Replay: recompute digest when present; otherwise enforce rejected+all-zero. */
export function verifyRequestDigestPartition(
  effect: ModelEffect,
  opts?: { model?: string },
): {
  ok: boolean
  detail: string
} {
  const r = effect.reservation
  const allZero =
    r.reservedTokens === 0 &&
    r.declaredPromptTokens === 0 &&
    r.declaredCompletionTokens === 0 &&
    r.actualUsageTokens === 0 &&
    r.chargedTokens === 0 &&
    r.overflowTokens === 0

  if (effect.requestDigest === undefined || effect.requestDigest === '') {
    if (
      effect.status !== 'rejected' ||
      !allZero ||
      effect.error?.code !== 'RECURSIVE_PARAM_INVALID'
    ) {
      return {
        ok: false,
        detail:
          'missing requestDigest requires status=rejected, RECURSIVE_PARAM_INVALID, and zero reservation fields',
      }
    }
    return { ok: true, detail: 'param-fail partition (no digest)' }
  }

  // Digest present — charged/overflow/reserved may vary; declared* should be finite.
  if (
    !Number.isFinite(r.declaredPromptTokens) ||
    !Number.isFinite(r.declaredCompletionTokens) ||
    r.declaredPromptTokens < 0 ||
    r.declaredCompletionTokens < 0
  ) {
    return { ok: false, detail: 'invalid declared* with requestDigest' }
  }
  if (r.chargedTokens !== Math.min(r.reservedTokens, r.actualUsageTokens)) {
    return {
      ok: false,
      detail: `chargedTokens invariant broken: ${r.chargedTokens}`,
    }
  }
  if (r.overflowTokens !== Math.max(0, r.actualUsageTokens - r.reservedTokens)) {
    return {
      ok: false,
      detail: `overflowTokens invariant broken: ${r.overflowTokens}`,
    }
  }

  // B3: when digest is present, recompute from recorded request echo and compare.
  const modelForRecompute = opts?.model ?? effect.request?.model
  const recomputed = recomputeRequestDigestFromEffect(
    modelForRecompute === undefined
      ? { effect }
      : { effect, model: modelForRecompute },
  )
  if (recomputed === undefined) {
    return {
      ok: false,
      detail: 'requestDigest present but request echo missing/invalid for recompute',
    }
  }
  if (recomputed !== effect.requestDigest) {
    return {
      ok: false,
      detail: `requestDigest mismatch: recorded=${effect.requestDigest} recomputed=${recomputed}`,
    }
  }
  return { ok: true, detail: 'digest partition present and recomputed equal' }
}

/**
 * Recompute requestDigest from a recorded ModelEffect request echo (B3),
 * or from explicit admission inputs.
 */
export function recomputeRequestDigestFromEffect(
  args:
    | {
        effect: ModelEffect
        model?: string
      }
    | {
        instructions: string
        input: unknown
        declaredCompletionTokens: number
        model: string
      },
): string | undefined {
  if ('effect' in args) {
    const request = args.effect.request
    if (!request || typeof request.instructions !== 'string') return undefined
    const model = args.model ?? request.model
    if (typeof model !== 'string' || model.length === 0) return undefined
    const instructionsBytes = utf8Encode(request.instructions)
    const canonical = isMissingRecursiveInput(request.input)
      ? { ok: true as const, bytes: new Uint8Array(0), byteLength: 0 }
      : canonicalizeRecursiveInput(request.input)
    if (!canonical.ok) return undefined
    return computeRequestDigest({
      instructionsBytes,
      inputCanonicalBytes: canonical.bytes,
      declaredCompletionTokens: args.effect.reservation.declaredCompletionTokens,
      model,
    })
  }
  const instructionsBytes = utf8Encode(args.instructions)
  const canonical = isMissingRecursiveInput(args.input)
    ? { ok: true as const, bytes: new Uint8Array(0), byteLength: 0 }
    : canonicalizeRecursiveInput(args.input)
  if (!canonical.ok) return undefined
  return computeRequestDigest({
    instructionsBytes,
    inputCanonicalBytes: canonical.bytes,
    declaredCompletionTokens: args.declaredCompletionTokens,
    model: args.model,
  })
}

export function extractResponseText(response: {
  content?: Array<{ type: string; text?: string }>
  text?: string
}): string {
  if (typeof response.text === 'string') return response.text
  if (!Array.isArray(response.content)) return ''
  return response.content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
}

export function assertEffectsExclusive(record: {
  factorioEffect?: unknown
  modelEffect?: unknown
  sessionEffect?: unknown
  agentEffect?: unknown
  mailboxEffect?: unknown
}): boolean {
  let n = 0
  if (record.factorioEffect !== undefined) n += 1
  if (record.modelEffect !== undefined) n += 1
  if (record.sessionEffect !== undefined) n += 1
  if (record.agentEffect !== undefined) n += 1
  if (record.mailboxEffect !== undefined) n += 1
  return n <= 1
}

export function parentTerminationFromRecursive(
  code: RecursiveModelErrorCode | undefined,
): 'cancelled' | 'wall_budget_exhausted' | undefined {
  if (code === 'RECURSIVE_MODEL_CANCELLED') return 'cancelled'
  if (code === 'RECURSIVE_MODEL_DEADLINE') return 'wall_budget_exhausted'
  return undefined
}
