import assert from 'node:assert/strict'
import test from 'node:test'

import { RefinementControlStore } from '../../src/refinement/control-store.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { signConfiguration, type RefinementTrustBundleV1 } from '../../src/refinement/trust.js'
import { RefinementWorkflow, type RefinementPolicyV1 } from '../../src/refinement/workflow.js'
import { FIXTURE_EXTRACTOR_DIGEST } from './fixtures.js'

const policy: RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1', generation: { model: 'm', maxOutputTokens: 1 },
  extractorDigest: FIXTURE_EXTRACTOR_DIGEST,
  gate: { minQualityDelta: 0, maxCostRatio: 1, maxLatencyRatio: 1, maxFailureRateDelta: 0 }, authority: { manualApprovers: ['human'] },
}
const bundle: RefinementTrustBundleV1 = {
  schemaVersion: 'helix.refinement-trust-bundle/v1', generation: 'g1', audience: 'deployment', assertionKeys: [], autoGrantKeys: [],
  policyPublisherKeys: [{ issuer: 'hrca', keyId: 'key', secret: 'publisher-secret', notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }],
}

test('HRCA configuration publisher signature gates policy publication', () => {
  const workflow = new RefinementWorkflow(new RefinementControlStore(), { generate: async () => { throw new Error('unused') }, evaluate: async () => { throw new Error('unused') } })
  const signature = signConfiguration(policy, 'publisher-secret')
  assert.equal(workflow.publishPolicy({ id: 'trusted', policy, issuer: 'hrca', keyId: 'key', signature, bundle }).kind, 'policy')
  assert.throws(() => workflow.publishPolicy({ id: 'bad', policy, issuer: 'hrca', keyId: 'key', signature: '0'.repeat(64), bundle }), (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CONFIGURATION_UNTRUSTED')
})
