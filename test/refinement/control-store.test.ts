import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { HarnessDocument } from '../../src/harness/index.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { RefinementControlStore } from '../../src/refinement/control-store.js'

const baselineDocument: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: 'system',
    taskNarrativeTemplate: 'task',
    protocolRules: ['record outcome'],
    termination: { successSource: 'scenario-verifier', stopConditions: ['verified'] },
  },
  catalogCards: [],
  compatibility: { codeProtocolPins: ['fixture/v1'] },
}

function candidatePayload(base: { kind: string; id: string; revision: number; contentHash: string }): string {
  return JSON.stringify({
    schemaVersion: 'helix.harness-overlay/v1',
    baseBaselineRef: base,
    changes: { systemInstructionTemplate: 'candidate system' },
  })
}

function assertRefinementError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RefinementError)
    return true
  })
}

test('S2.RCS keeps a candidate as an ordinary #10 overlay but gates external visibility', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-refinement-'))
  try {
    const rcs = new RefinementControlStore({ rootDir })
    const baselineRef = rcs.publishBaseline(baselineDocument, { id: 'fixture', revision: 0 })
    const candidate = rcs.admitCandidate({
      candidateId: 'candidate-1',
      generationRunRef: 'milkie-run-1',
      baseBaselineRef: baselineRef,
      payloadText: candidatePayload(baselineRef),
    })

    assert.equal(candidate.overlayRef.kind, 'overlay')
    assert.equal(candidate.overlayRef.contentHash, candidate.payloadHash)
    assertRefinementError(() =>
      rcs.select('external', { baselineRef, overlayRef: candidate.overlayRef }, []),
    )
    const evaluated = rcs.select('evaluator', { baselineRef, overlayRef: candidate.overlayRef }, [])
    assert.equal(evaluated.overlayRef?.contentHash, candidate.payloadHash)

    // A fresh process view preserves both the ordinary overlay and its private gate.
    const reopened = new RefinementControlStore({ rootDir })
    assertRefinementError(() =>
      reopened.select('external', { baselineRef, overlayRef: candidate.overlayRef }, []),
    )
    assert.equal(reopened.markCandidatePromoted('candidate-1').contentHash, candidate.payloadHash)
    const selectable = reopened.select('external', { baselineRef, overlayRef: candidate.overlayRef }, [])
    assert.equal(selectable.overlayRef?.contentHash, candidate.payloadHash)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('S3 RCS publish failure rolls back promotion visibility and terminal decision', () => {
  let fail = false
  const rootDir = mkdtempSync(path.join(tmpdir(), 'helix-refinement-atomic-'))
  const rcs = new RefinementControlStore({ rootDir, durableWriter: () => { if (fail) throw new Error('disk failure') } })
  const baselineRef = rcs.publishBaseline(baselineDocument, { id: 'atomic', revision: 0 })
  const candidate = rcs.admitCandidate({ candidateId: 'atomic-candidate', generationRunRef: 'run', baseBaselineRef: baselineRef, payloadText: candidatePayload(baselineRef) })
  fail = true
  assert.throws(() => rcs.promoteCandidateWithArtifacts({ requestKey: 'request', candidateId: 'atomic-candidate', artifacts: [{ ref: 'decision', payload: {} }] }))
  assertRefinementError(() => rcs.select('external', { baselineRef, overlayRef: candidate.overlayRef }, []))
  fail = false
  assert.equal(rcs.promoteCandidateWithArtifacts({ requestKey: 'request', candidateId: 'atomic-candidate', artifacts: [{ ref: 'decision', payload: {} }] }).contentHash, candidate.payloadHash)
  rmSync(rootDir, { recursive: true, force: true })
})

test('S1.RCS candidate idempotency cannot replace its generation or payload identity', () => {
  const rcs = new RefinementControlStore()
  const baselineRef = rcs.publishBaseline(baselineDocument, { id: 'fixture', revision: 0 })
  const first = rcs.admitCandidate({
    candidateId: 'candidate-1',
    generationRunRef: 'milkie-run-1',
    baseBaselineRef: baselineRef,
    payloadText: candidatePayload(baselineRef),
  })
  const retry = rcs.admitCandidate({
    candidateId: 'candidate-1',
    generationRunRef: 'milkie-run-1',
    baseBaselineRef: baselineRef,
    payloadText: candidatePayload(baselineRef),
  })
  assert.deepEqual(retry, first)
  assertRefinementError(() =>
    rcs.admitCandidate({
      candidateId: 'candidate-1',
      generationRunRef: 'milkie-run-2',
      baseBaselineRef: baselineRef,
      payloadText: candidatePayload(baselineRef),
    }),
  )
})
