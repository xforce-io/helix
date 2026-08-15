import assert from 'node:assert/strict'
import test from 'node:test'
import type { HarnessOverlay, HarnessStateRef } from '../../../src/harness/index.js'
import { validateFactorioOverlayProtocol } from '../src/overlay-protocol-guard.js'

const baseBaselineRef: HarnessStateRef = {
  kind: 'baseline',
  id: 'factorio.test',
  revision: 1,
  contentHash: '0'.repeat(64),
}

test('protocol guard allows overlay without protocolRules changes', () => {
  const overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes: {
      systemInstructionTemplate: 'improved instructions',
    },
  }
  const error = validateFactorioOverlayProtocol(overlay)
  assert.equal(error, undefined, 'should allow overlay without protocol changes')
})

test('protocol guard allows overlay with valid protocolRules', () => {
  const overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes: {
      protocolRules: [
        'First environment effect must call factorio.reset() exactly once.',
        'Never add import statements inside the action string.',
        'Submit at most one external effect per cell.',
      ],
    },
  }
  const error = validateFactorioOverlayProtocol(overlay)
  assert.equal(error, undefined, 'should allow valid protocol rules')
})

test('protocol guard rejects overlay dropping factorio.reset fragment', () => {
  const overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes: {
      protocolRules: [
        'Call the environment setup function first.',
        'Never add import statements.',
      ],
    },
  }
  const error = validateFactorioOverlayProtocol(overlay)
  assert.ok(error, 'should reject overlay missing reset fragment')
  assert.match(error!, /first-reset/, 'error should mention first-reset protocol')
})

test('protocol guard rejects overlay dropping import fragment', () => {
  const overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes: {
      protocolRules: [
        'First environment effect must call factorio.reset().',
        'Follow the action protocol.',
      ],
    },
  }
  const error = validateFactorioOverlayProtocol(overlay)
  assert.ok(error, 'should reject overlay missing import fragment')
  assert.match(error!, /import/, 'error should mention missing fragment')
})

test('protocol guard rejects overlay dropping First environment effect fragment', () => {
  const overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes: {
      protocolRules: [
        'Always call factorio.reset() before other actions.',
        'Never add import statements.',
      ],
    },
  }
  const error = validateFactorioOverlayProtocol(overlay)
  assert.ok(error, 'should reject overlay missing first-reset rule')
  assert.match(error!, /first-reset protocol/, 'error should mention first-reset')
})

test('protocol guard rejects overlay with weak no-import rule', () => {
  const overlay: HarnessOverlay = {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes: {
      protocolRules: [
        'First environment effect must call factorio.reset().',
        'Prefer not using import statements.',
      ],
    },
  }
  const error = validateFactorioOverlayProtocol(overlay)
  assert.ok(error, 'should reject weak no-import rule')
  assert.match(error!, /no-import protocol/, 'error should mention no-import')
})

test('protocol guard accepts variations of first-reset rule', () => {
  const variations = [
    'First cell must call factorio.reset()',
    'The first environment effect should reset the environment',
    'Your initial action must be factorio.reset()',
  ]

  for (const rule of variations) {
    const overlay: HarnessOverlay = {
      schemaVersion: 'helix.harness-overlay/v1',
      baseBaselineRef,
      changes: {
        protocolRules: [
          rule,
          'Never add import statements in action strings.',
        ],
      },
    }
    const error = validateFactorioOverlayProtocol(overlay)
    assert.equal(error, undefined, `should accept rule: ${rule}`)
  }
})

test('protocol guard accepts variations of no-import rule', () => {
  const variations = [
    'Never add import statements.',
    'Imports are forbidden in action strings.',
    'Do not use import statements.',
  ]

  for (const rule of variations) {
    const overlay: HarnessOverlay = {
      schemaVersion: 'helix.harness-overlay/v1',
      baseBaselineRef,
      changes: {
        protocolRules: [
          'First environment effect must call factorio.reset().',
          rule,
        ],
      },
    }
    const error = validateFactorioOverlayProtocol(overlay)
    assert.equal(error, undefined, `should accept rule: ${rule}`)
  }
})
