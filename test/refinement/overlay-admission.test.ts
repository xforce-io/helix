import assert from 'node:assert/strict'
import test from 'node:test'

import { overlayContentHash, type HarnessStateRef } from '../../src/harness/index.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { admitGeneratedOverlayPayload } from '../../src/refinement/overlay-admission.js'

const baseBaselineRef: HarnessStateRef = {
  kind: 'baseline',
  id: 'baseline-fixture',
  revision: 0,
  contentHash: 'a'.repeat(64),
}

function payloadText(changes = '{"protocolRules":["use / directly","中文\\u2028line"]}'): string {
  return `{
    "changes": ${changes},
    "baseBaselineRef": {
      "contentHash": "${baseBaselineRef.contentHash}",
      "revision": 0,
      "id": "baseline-fixture",
      "kind": "baseline"
    },
    "schemaVersion": "helix.harness-overlay/v1"
  }`
}

function assertCandidateInvalid(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RefinementError)
    assert.equal(error.code, 'REFINEMENT_CANDIDATE_INVALID')
    return true
  })
}

test('S1.candidate admission uses raw #10 JSON parsing and canonical overlay identity', () => {
  const admitted = admitGeneratedOverlayPayload({
    payloadText: payloadText(),
    baseBaselineRef,
  })

  assert.equal(admitted.payloadHash, overlayContentHash(admitted.overlay))
  assert.ok(
    admitted.canonicalBytes
      .toString('utf8')
      .includes(`"protocolRules":["use / directly","中文${String.fromCharCode(0x2028)}line"]`),
  )
  assert.equal(admitted.canonicalBytes.includes(Buffer.from('\\/')), false)
  assert.ok(Object.isFrozen(admitted.overlay))
})

test('S1.candidate admission rejects duplicate keys before overlay materialization', () => {
  assertCandidateInvalid(() =>
    admitGeneratedOverlayPayload({
      payloadText: payloadText('{"protocolRules":["a"],"protocolRules":["b"]}'),
      baseBaselineRef,
    }),
  )

  assertCandidateInvalid(() =>
    admitGeneratedOverlayPayload({
      payloadText: payloadText().replace(
        '"kind": "baseline"',
        '"kind": "baseline", "kind": "baseline"',
      ),
      baseBaselineRef,
    }),
  )
})

test('S1.candidate admission rejects non-overlay payloads and base drift', () => {
  assertCandidateInvalid(() =>
    admitGeneratedOverlayPayload({
      payloadText: '{"schemaVersion":"helix.harness-overlay/v1","baseBaselineRef":{},"changes":{}}',
      baseBaselineRef,
    }),
  )

  assertCandidateInvalid(() =>
    admitGeneratedOverlayPayload({
      payloadText: payloadText().replace('"revision": 0', '"revision": 1'),
      baseBaselineRef,
    }),
  )
})

test('S1.candidate admission rejects non-canonical numeric tokens before validation', () => {
  for (const invalidRevision of ['01', '1.0', '1e0', '-0']) {
    assertCandidateInvalid(() =>
      admitGeneratedOverlayPayload({
        payloadText: payloadText().replace('"revision": 0', `"revision": ${invalidRevision}`),
        baseBaselineRef,
      }),
    )
  }
})
