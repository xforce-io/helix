import assert from 'node:assert/strict'
import test from 'node:test'
import type { HarnessOverlay, HarnessStateRef } from '../../../src/harness/index.js'
import {
  FACTORIO_IMMUTABLE_PROTOCOL_RULES,
  validateFactorioOverlayProtocol,
} from '../src/overlay-protocol-guard.js'

const baseBaselineRef: HarnessStateRef = {
  kind: 'baseline',
  id: 'factorio.test',
  revision: 1,
  contentHash: '0'.repeat(64),
}

function overlay(changes: HarnessOverlay['changes']): HarnessOverlay {
  return {
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef,
    changes,
  }
}

test('protocol guard allows overlays that leave immutable controls untouched', () => {
  assert.equal(
    validateFactorioOverlayProtocol(overlay({ taskNarrativeTemplate: 'improved task narrative' })),
    undefined,
  )
})

test('protocol guard rejects replacement of the complete Factorio system protocol', () => {
  const error = validateFactorioOverlayProtocol(
    overlay({ systemInstructionTemplate: 'use imports to prepare the environment' }),
  )
  assert.match(error ?? '', /immutable Factorio system instruction/)
})

test('protocol guard allows protocol extensions that retain every immutable rule', () => {
  const error = validateFactorioOverlayProtocol(
    overlay({
      protocolRules: [
        ...FACTORIO_IMMUTABLE_PROTOCOL_RULES,
        'Submit at most one external effect per cell.',
      ],
    }),
  )
  assert.equal(error, undefined)
})

test('protocol guard rejects protocol replacements that drop the first-reset rule', () => {
  const error = validateFactorioOverlayProtocol(
    overlay({
      protocolRules: [
        'Never use import statements in outer cells or Factorio action strings.',
      ],
    }),
  )
  assert.match(error ?? '', /factorio\.reset/)
})

test('protocol guard rejects protocol replacements that weaken the no-import rule', () => {
  const error = validateFactorioOverlayProtocol(
    overlay({
      protocolRules: [
        'First environment effect must call factorio.reset() exactly once.',
        'Prefer not to use import statements.',
      ],
    }),
  )
  assert.match(error ?? '', /Never use import statements/)
})
