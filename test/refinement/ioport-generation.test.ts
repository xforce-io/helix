import assert from 'node:assert/strict'
import test from 'node:test'

import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import type { HarnessStateRef } from '../../src/harness/index.js'
import { RefinementError } from '../../src/refinement/errors.js'
import { createIOPortGenerationAdapter, type RefinementPolicyV1 } from '../../src/refinement/workflow.js'

const baselineRef: HarnessStateRef = { kind: 'baseline', id: 'base', revision: 0, contentHash: 'a'.repeat(64) }
const policy: RefinementPolicyV1 = {
  schemaVersion: 'helix.refinement-policy/v1', generation: { model: 'pinned-model', maxOutputTokens: 20 },
  gate: { minQualityDelta: 0, maxCostRatio: 1, maxLatencyRatio: 1, maxFailureRateDelta: 0 }, authority: { manualApprovers: ['human'] },
}

function port(content: Array<{ type: 'text'; text: string }>): IIOPort {
  return {
    async invokeLLM(request) {
      assert.equal(request.model, 'pinned-model')
      assert.equal(request.maxTokens, 20)
      return { content, toolCalls: [], usage: { inputTokens: 2, outputTokens: 3 } }
    },
    async invokeTool(_name, _input, execute) { return execute(new AbortController().signal) },
    now: () => 0,
    uuid: () => 'fixture',
  }
}

test('S1.generation adapter reaches the model only via injected milkie IOPort', async () => {
  const adapter = createIOPortGenerationAdapter({
    port: port([{ type: 'text', text: '{"overlay":"raw"}' }]), model: 'pinned-model', generationRunRef: 'recorded-run',
    evaluate: async () => { throw new Error('not used') },
  })
  const generated = await adapter.generate({ sourceRunRefs: ['source'], baselineRef, policy })
  assert.deepEqual(generated.budget, { reserved: 20, charged: 3 })
  assert.equal(generated.payloadText, '{"overlay":"raw"}')
})

test('S1.generation adapter rejects more than one model text output', async () => {
  const adapter = createIOPortGenerationAdapter({
    port: port([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), model: 'pinned-model', generationRunRef: 'recorded-run',
    evaluate: async () => { throw new Error('not used') },
  })
  await assert.rejects(
    adapter.generate({ sourceRunRefs: ['source'], baselineRef, policy }),
    (error: unknown) => error instanceof RefinementError && error.code === 'REFINEMENT_CANDIDATE_INVALID',
  )
})
