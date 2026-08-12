/**
 * Issue #10 L2 §10.3 harness error codes.
 */

export type HarnessErrorCode =
  | 'HARNESS_SELECTION_REQUIRED'
  | 'HARNESS_NONDETERMINISTIC_SELECTION'
  | 'HARNESS_JSON_INVALID'
  | 'HARNESS_REF_INVALID'
  | 'HARNESS_OVERLAY_BASE_MISMATCH'
  | 'HARNESS_OVERLAY_INVALID'
  | 'HARNESS_CATALOG_UNRESOLVED'
  | 'HARNESS_CATALOG_NOT_AVAILABLE'
  | 'HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED'
  | 'HARNESS_PROTOCOL_INCOMPATIBLE'
  | 'HARNESS_CHILD_SELECTION_DRIFT'
  | 'HARNESS_LEGACY_SELECTION_UNAVAILABLE'
  | 'HARNESS_DOCUMENT_INVALID'
  | 'HARNESS_SCHEMA_INVALID'

export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly details?: unknown

  constructor(code: HarnessErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function harnessError(
  code: HarnessErrorCode,
  message: string,
  details?: unknown,
): HarnessError {
  return details === undefined
    ? new HarnessError(code, message)
    : new HarnessError(code, message, details)
}

export type HarnessValidationOk<T> = { ok: true; value: T }
export type HarnessValidationFail = {
  ok: false
  code: HarnessErrorCode
  message: string
  details?: unknown
}
export type HarnessValidationResult<T> = HarnessValidationOk<T> | HarnessValidationFail

export function validationOk<T>(value: T): HarnessValidationOk<T> {
  return { ok: true, value }
}

export function validationFail(
  code: HarnessErrorCode,
  message: string,
  details?: unknown,
): HarnessValidationFail {
  return details === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, details }
}

export function throwFail(fail: HarnessValidationFail): never {
  throw harnessError(fail.code, fail.message, fail.details)
}
