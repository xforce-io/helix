import assert from 'node:assert/strict'
import test from 'node:test'

import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { signActorAssertion, signConfiguration, verifyActorAssertion, verifyAutoGrant, type RefinementTrustBundleV1 } from '../../src/refinement/trust.js'

const bundle: RefinementTrustBundleV1 = {
  schemaVersion: 'helix.refinement-trust-bundle/v1', generation: '1', audience: 'helix-refinement',
  assertionKeys: [{ issuer: 'idp', keyId: 'kid', secret: 'secret', notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }],
  autoGrantKeys: [{ issuer: 'ci', keyId: 'auto', secret: 'auto-secret', notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }], policyPublisherKeys: [],
}

function assertion(nonce = 'nonce') {
  return signActorAssertion({
    schemaVersion: 'helix.refinement-actor-assertion/v1', subject: 'researcher', issuer: 'idp', keyId: 'kid', audience: 'helix-refinement',
    operation: 'refine.propose', issuedAt: '2026-08-12T00:00:00Z', expiresAt: '2026-08-13T00:00:00Z', nonce,
  }, 'secret')
}

test('trust verifies scoped signed actor assertions and rejects tampering', () => {
  const verified = verifyActorAssertion({ assertion: assertion(), bundle, expectedOperation: 'refine.propose', now: new Date('2026-08-12T01:00:00Z') })
  assert.equal(verified.subject, 'researcher')
  const bad = { ...assertion(), audience: 'wrong' }
  assert.throws(() => verifyActorAssertion({ assertion: bad, bundle, expectedOperation: 'refine.propose', now: new Date('2026-08-12T01:00:00Z') }), (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CONFIGURATION_UNTRUSTED')
})

test('auto grant verification requires the current bundle generation and trusted signer', () => {
  const payload = { request: 'exact-ref', trustBundleGeneration: '1' }
  const signature = signConfiguration(payload, 'auto-secret')
  verifyAutoGrant({ bundle, generation: '1', issuer: 'ci', keyId: 'auto', payload, signature, now: new Date('2026-08-12T01:00:00Z') })
  assert.throws(() => verifyAutoGrant({ bundle, generation: 'old', issuer: 'ci', keyId: 'auto', payload, signature, now: new Date('2026-08-12T01:00:00Z') }), (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_GRANT_INVALID')
})

test('RCS assertion nonce receipt returns same response and rejects changed fingerprint', () => {
  const rcs = new RefinementControlStore()
  const first = rcs.consumeAssertion({ issuer: 'idp', keyId: 'kid', nonce: 'n', fingerprint: 'first', expiresAt: '2026-08-13T00:00:00Z', operation: () => ({ ack: 1 }) })
  assert.deepEqual(first, { ack: 1 })
  const retry = rcs.consumeAssertion({ issuer: 'idp', keyId: 'kid', nonce: 'n', fingerprint: 'first', expiresAt: '2026-08-13T00:00:00Z', operation: () => ({ ack: 2 }) })
  assert.deepEqual(retry, { ack: 1 })
  assert.throws(() => rcs.consumeAssertion({ issuer: 'idp', keyId: 'kid', nonce: 'n', fingerprint: 'changed', expiresAt: '2026-08-13T00:00:00Z', operation: () => ({}) }), (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_ASSERTION_REPLAYED')
})
