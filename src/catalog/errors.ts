/**
 * Catalog error codes (Issue #11 L2 §4.4.2).
 */

export type CatalogErrorCode =
  | 'CATALOG_REJECT_HARNESS_CONTROL'
  | 'CATALOG_REJECT_HARNESS_NAMESPACE'
  | 'CATALOG_REJECT_NO_KERNEL_INJECTION'
  | 'CATALOG_REJECT_ENV_IN_RUNTIME_CATALOG'
  | 'CATALOG_REJECT_NON_RUNTIME_KIND'
  | 'CATALOG_REJECT_ADMISSION_METADATA_MISSING'
  | 'CATALOG_REJECT_IDENTITY'
  | 'CATALOG_IMMUTABLE_VERSION_DRIFT'
  | 'CATALOG_REJECT_EFFECT_CLASS'
  | 'CATALOG_REJECT_OCCUPANCY'
  | 'CATALOG_CHANNEL_META_DRIFT'
  | 'CATALOG_CONTENT_HASH_MISMATCH'
  | 'CATALOG_BINDING_SET_UNRESOLVABLE'
  | 'CATALOG_REF_NOT_IN_PRODUCTION'
  | 'CATALOG_REF_UNKNOWN'
  | 'CATALOG_REF_IDENTITY_INVALID'
  | 'CATALOG_SCHEMA_INVALID'

export class CatalogError extends Error {
  readonly code: CatalogErrorCode
  readonly details?: unknown

  constructor(code: CatalogErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function catalogError(
  code: CatalogErrorCode,
  message: string,
  details?: unknown,
): CatalogError {
  return details === undefined
    ? new CatalogError(code, message)
    : new CatalogError(code, message, details)
}

export type CatalogValidationOk = { ok: true }
export type CatalogValidationFail = {
  ok: false
  code: CatalogErrorCode
  message: string
  details?: unknown
}
export type CatalogValidationResult = CatalogValidationOk | CatalogValidationFail

export function validationOk(): CatalogValidationOk {
  return { ok: true }
}

export function validationFail(
  code: CatalogErrorCode,
  message: string,
  details?: unknown,
): CatalogValidationFail {
  return details === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, details }
}
