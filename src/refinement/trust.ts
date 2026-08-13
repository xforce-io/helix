/**
 * Refinement trust primitives.
 *
 * Assertions are deployment-issued, signed, audience-bound inputs to the RCS;
 * they are not model identities and never belong in a Candidate, Trace payload,
 * prompt, or public artifact projection. HMAC is the local/test implementation
 * of the verifier seam. Production deployments must supply their IdP/mTLS
 * verifier and keep its key material outside RCS.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

import { refinementError } from './errors.js'

export type TrustedKey = {
  issuer: string
  keyId: string
  secret: string
  notBefore: string
  expiresAt: string
  revoked?: boolean
}

export type RefinementTrustBundleV1 = {
  schemaVersion: 'helix.refinement-trust-bundle/v1'
  generation: string
  audience: string
  assertionKeys: TrustedKey[]
  autoGrantKeys: TrustedKey[]
  policyPublisherKeys: TrustedKey[]
}

export type ActorAssertionV1 = {
  schemaVersion: 'helix.refinement-actor-assertion/v1'
  subject: string
  issuer: string
  keyId: string
  audience: string
  operation: 'refine.propose' | 'refine.evaluate' | 'refine.request' | 'refine.promote.manual' | 'refine.reject.manual'
  issuedAt: string
  expiresAt: string
  nonce: string
  signature: string
}

export type VerifiedAssertion = Omit<ActorAssertionV1, 'signature'>

export function signActorAssertion(
  claims: Omit<ActorAssertionV1, 'signature'>,
  secret: string,
): ActorAssertionV1 {
  return { ...claims, signature: hmac(claims, secret) }
}

export function verifyActorAssertion(input: {
  assertion: ActorAssertionV1
  bundle: RefinementTrustBundleV1
  expectedOperation: ActorAssertionV1['operation']
  now?: Date
}): VerifiedAssertion {
  const { assertion, bundle, expectedOperation, now = new Date() } = input
  if (
    assertion.schemaVersion !== 'helix.refinement-actor-assertion/v1' ||
    !nonEmpty(assertion.subject) || !nonEmpty(assertion.issuer) || !nonEmpty(assertion.keyId) || !nonEmpty(assertion.nonce) ||
    assertion.audience !== bundle.audience || assertion.operation !== expectedOperation
  ) throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'actor assertion scope is invalid')
  const key = resolveKey(bundle.assertionKeys, assertion.issuer, assertion.keyId)
  if (key === undefined || !inWindow(now, key.notBefore, key.expiresAt) || !inWindow(now, assertion.issuedAt, assertion.expiresAt)) {
    throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'actor assertion issuer/key/time is untrusted')
  }
  const { signature, ...claims } = assertion
  if (!signatureMatches(signature, claims, key.secret)) {
    throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'actor assertion signature is invalid')
  }
  return claims
}

export function signConfiguration(payload: unknown, secret: string): string {
  return hmac(payload, secret)
}

/** Verify a sealed auto-promotion grant against the current bundle generation. */
export function verifyAutoGrant(input: {
  bundle: RefinementTrustBundleV1
  generation: string
  issuer: string
  keyId: string
  payload: unknown
  signature: string
  now?: Date
}): void {
  if (
    input.generation !== input.bundle.generation ||
    input.payload === null || typeof input.payload !== 'object' ||
    (input.payload as Record<string, unknown>)['trustBundleGeneration'] !== input.generation
  ) {
    throw refinementError('REFINEMENT_GRANT_INVALID', 'auto grant trust bundle generation is stale')
  }
  const key = resolveKey(input.bundle.autoGrantKeys, input.issuer, input.keyId)
  if (key === undefined || !inWindow(input.now ?? new Date(), key.notBefore, key.expiresAt) || !signatureMatches(input.signature, input.payload, key.secret)) {
    throw refinementError('REFINEMENT_GRANT_INVALID', 'auto grant issuer/key is untrusted')
  }
}

export function verifyPolicyPublisher(input: {
  bundle: RefinementTrustBundleV1
  issuer: string
  keyId: string
  payload: unknown
  signature: string
  now?: Date
}): void {
  const key = resolveKey(input.bundle.policyPublisherKeys, input.issuer, input.keyId)
  if (key === undefined || !inWindow(input.now ?? new Date(), key.notBefore, key.expiresAt) || !signatureMatches(input.signature, input.payload, key.secret)) {
    throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'policy/suite publisher is untrusted')
  }
}

function resolveKey(keys: TrustedKey[], issuer: string, keyId: string): TrustedKey | undefined {
  const matching = keys.filter(key => key.issuer === issuer && key.keyId === keyId && key.revoked !== true)
  return matching.length === 1 ? matching[0] : undefined
}

function inWindow(now: Date, notBefore: string, expiresAt: string): boolean {
  const lower = Date.parse(notBefore)
  const upper = Date.parse(expiresAt)
  return Number.isFinite(lower) && Number.isFinite(upper) && lower <= now.getTime() && now.getTime() <= upper
}

function signatureMatches(signature: string, value: unknown, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false
  const expected = hmac(value, secret)
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
}

function hmac(value: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value !== 'object' || value === undefined) throw refinementError('REFINEMENT_CONFIGURATION_UNTRUSTED', 'signed value is not JSON-shaped')
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}

function nonEmpty(value: string): boolean { return value.length > 0 }
