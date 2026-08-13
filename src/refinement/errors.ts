/** Internal errors for the Issue #13 refinement control plane. */

export type RefinementErrorCode =
  | 'REFINEMENT_CANDIDATE_INVALID'
  | 'REFINEMENT_ASSERTION_REPLAYED'
  | 'REFINEMENT_CONFIGURATION_UNTRUSTED'
  | 'REFINEMENT_GRANT_INVALID'
  | 'REFINEMENT_GRANT_REPLAYED'
  | 'REFINEMENT_PUBLICATION_ATOMIC_FAILED'

export class RefinementError extends Error {
  readonly code: RefinementErrorCode
  readonly details?: unknown

  constructor(code: RefinementErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'RefinementError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function refinementError(
  code: RefinementErrorCode,
  message: string,
  details?: unknown,
): RefinementError {
  return details === undefined
    ? new RefinementError(code, message)
    : new RefinementError(code, message, details)
}
