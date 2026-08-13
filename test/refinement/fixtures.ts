import { signConfiguration, type RefinementTrustBundleV1 } from '../../src/refinement/trust.js'

export const FIXTURE_EXTRACTOR_DIGEST = 'e'.repeat(64)

export const HRCA_BUNDLE: RefinementTrustBundleV1 = {
  schemaVersion: 'helix.refinement-trust-bundle/v1',
  generation: 'fixture-generation',
  audience: 'fixture-deployment',
  assertionKeys: [],
  autoGrantKeys: [],
  policyPublisherKeys: [{
    issuer: 'fixture-hrca', keyId: 'fixture-key', secret: 'fixture-hrca-secret',
    notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
  }],
}

export function signedConfiguration<T>(id: string, key: 'policy' | 'suite', value: T): {
  id: string
  [K in typeof key]: T
} & { issuer: string; keyId: string; signature: string; bundle: RefinementTrustBundleV1 } {
  return {
    id,
    [key]: value,
    issuer: 'fixture-hrca', keyId: 'fixture-key',
    signature: signConfiguration(value, 'fixture-hrca-secret'), bundle: HRCA_BUNDLE,
  } as {
    id: string
    [K in typeof key]: T
  } & { issuer: string; keyId: string; signature: string; bundle: RefinementTrustBundleV1 }
}
