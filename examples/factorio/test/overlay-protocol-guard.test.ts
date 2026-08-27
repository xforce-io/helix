import assert from 'node:assert/strict'
import test from 'node:test'
import type { HarnessOverlay, HarnessStateRef } from '../../../src/harness/index.js'
import {
  FACTORIO_IMMUTABLE_PROTOCOL_RULES,
  validateFactorioOverlayProtocol,
  validateFactorioOverlayTaskAgnostic,
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

test('task-agnostic guard accepts a recipe-discovery narrative', () => {
  const error = validateFactorioOverlayTaskAgnostic(
    overlay({
      taskNarrativeTemplate:
        'Build a fully automatic factory for the current reset task. Call nearest() for each recipe ingredient, move_to within 10 tiles, then place machines chosen from get_prototype_recipe.',
    }),
  )
  assert.equal(error, undefined)
})

test('task-agnostic guard allows generic machine kinds such as inserter', () => {
  const error = validateFactorioOverlayTaskAgnostic(
    overlay({
      taskNarrativeTemplate:
        'Lay out extractor, converter, and an inserter into a chest. Fuel every burner inserter. Do not assume a mine-to-furnace line.',
    }),
  )
  assert.equal(error, undefined)
})

test('task-agnostic guard rejects a coordinate walkthrough', () => {
  const error = validateFactorioOverlayTaskAgnostic(
    overlay({
      taskNarrativeTemplate:
        'Before any placement, move the player to tile (17, 72) and reuse the exact action sequence that previously passed verification.',
    }),
  )
  assert.match(error ?? '', /map coordinate|source-run-specific/)
})

test('task-agnostic guard rejects a named development or holdout product', () => {
  const development = validateFactorioOverlayTaskAgnostic(
    overlay({
      taskNarrativeTemplate: 'Establish a burner-based iron plate production line.',
    }),
  )
  assert.match(development ?? '', /fixed target|product|recipe/)
  const holdout = validateFactorioOverlayTaskAgnostic(
    overlay({
      taskNarrativeTemplate: 'Create an automatic advanced-circuit factory using Prototype.AdvancedCircuit.',
    }),
  )
  assert.match(holdout ?? '', /fixed target|product|recipe/)
})
