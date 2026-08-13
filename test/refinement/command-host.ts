import type { HarnessPinsV1 } from '../../src/harness/index.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'
import type { RefinementCommandHost } from '../../src/refinement/commands.js'
import { HRCA_BUNDLE } from './fixtures.js'

export function createRefinementCommandHost(): RefinementCommandHost {
  const rcs = new RefinementControlStore()
  const base = rcs.publishBaseline({
    schemaVersion: 'helix.harness/v1',
    control: { systemInstructionTemplate: 's', taskNarrativeTemplate: 't', protocolRules: ['p'], termination: { successSource: 'scenario-verifier', stopConditions: ['done'] } },
    catalogCards: [], compatibility: { codeProtocolPins: ['p'] },
  }, { id: 'command-base', revision: 0 })
  const pins = (overlay?: typeof base): HarnessPinsV1 => ({ format: 'harness/v1', codeProtocolPin: 'p', baselineRef: base, ...(overlay === undefined ? {} : { overlayRef: overlay }), harnessContentHash: 'a'.repeat(64), schemaVersion: 'helix.harness/v1', catalogCards: [], compatibilityDecision: { documentAcceptsCodeProtocolPin: true, catalogResolved: true } })
  return {
    rcs,
    trustBundle: { ...HRCA_BUNDLE, audience: 'command-cli', assertionKeys: [{ issuer: 'idp', keyId: 'key', secret: 'command-secret', notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }] },
    now: () => new Date('2026-08-12T01:00:00Z'),
    adapter: {
      async generate() { throw new Error('fixture command host does not publish policy; generate must not be invoked by malformed input') },
      async evaluate(input) { return { quality: 1, cost: 1, latencyMs: 1, failed: false, replayPassed: true, sharedPins: {}, harnessPins: pins(input.arm === 'candidate' ? input.overlayRef : undefined), runRef: input.arm } },
    },
  }
}
