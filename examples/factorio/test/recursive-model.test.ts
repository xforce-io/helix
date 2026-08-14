import assert from 'node:assert/strict'
import test from 'node:test'
import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import type { ModelRequest, ModelResponse } from 'milkie'
import { MemoryEventStore, MemoryTraceObjectStore } from 'milkie'
import type { Event } from 'milkie/dist/trace/types.js'
import { hashModelRequest } from 'milkie/dist/trace/hash.js'
import {
  allocateChildRunId,
  applyReserve,
  assertEffectsExclusive,
  buildRecursiveUserContent,
  canonicalizeRecursiveInput,
  computeDeclaredLimits,
  computeRequestDigest,
  decideReserve,
  DEFAULT_PARENT_RECURSIVE_TOKEN_POOL,
  emptyReservation,
  mapProviderError,
  MAX_RECURSIVE_CALLS_PER_RUN,
  MAX_RECURSIVE_COMPLETION_TOKENS,
  MAX_RECURSIVE_INSTRUCTIONS_BYTES,
  MAX_RECURSIVE_PROMPT_TOKENS,
  MIN_RESERVE_TOKENS,
  parentTerminationFromRecursive,
  prepareRecursiveAdmission,
  refundReserve,
  settleReserve,
  recomputeRequestDigestFromEffect,
  verifyRequestDigestPartition,
} from '../src/recursive-model.js'
import {
  buildChildRunIds,
  c1NeverStartedEventCheck,
  c1SettlementRefundCheck,
  collectC1Effects,
  liveRecursiveChecks,
  pinsGateCheck,
  pinsGateCheckV4,
  rejectLegacyPins,
  recursiveWitnessCheck,
  scanRecursiveResultWitness,
  parentTerminationMapCheck,
  requestDigestReplayChecks,
  singleEffectMutualExclusionCheck,
  successfulRecursiveCallCheck,
} from '../src/verification.js'
import type {
  CellExecutionRecord,
  ModelEffect,
  RunPins,
} from '../src/types.js'
import {
  LiveCellExecutor,
  type ChildPortFactory,
  type ChildPortHandle,
} from '../src/live-executor.js'
import { digest } from '../src/canonical.js'
import { childLlmResponseHashCheck, replayChildRun } from '../src/replay.js'


const pins: RunPins = {
  model: 'test-model',
  harness: 'factorio-rlm/v4',
  kernelProtocol: '2',
  bindingSet: 'factorio/v3',
  renderer: 'markdown-json/v1',
  isolationProfile: 'local-process-ast/v2',
  milkie: 'test-milkie',
  fle: '0.4.3',
  factorioServer: '2.0.73',
  taskId: 'iron_ore_throughput',
  taskDigest: 'sha256:test-task',
  kernelMemoryBytes: 1_073_741_824,
  kernelCpuSeconds: 600,
}

// ---------- Unit: canonicalize (IMP-2 + I1) ----------

test('canonicalize: missing/null → empty bytes (not b"null")', () => {
  for (const value of [undefined, null]) {
    const result = canonicalizeRecursiveInput(value)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.byteLength, 0)
      assert.equal(result.bytes.byteLength, 0)
    }
  }
})

test('canonicalize: valued 0/false/"" are distinguishable from missing', () => {
  const missing = canonicalizeRecursiveInput(null)
  const zero = canonicalizeRecursiveInput(0)
  const falsy = canonicalizeRecursiveInput(false)
  const empty = canonicalizeRecursiveInput('')
  assert.ok(missing.ok && zero.ok && falsy.ok && empty.ok)
  if (missing.ok && zero.ok && falsy.ok && empty.ok) {
    assert.equal(Buffer.from(missing.bytes).toString('utf8'), '')
    assert.equal(Buffer.from(zero.bytes).toString('utf8'), '0')
    assert.equal(Buffer.from(falsy.bytes).toString('utf8'), 'false')
    assert.equal(Buffer.from(empty.bytes).toString('utf8'), '""')
    const digests = new Set([
      computeRequestDigest({
        instructionsBytes: new TextEncoder().encode('x'),
        inputCanonicalBytes: missing.bytes,
        declaredCompletionTokens: 1,
        model: 'm',
      }),
      computeRequestDigest({
        instructionsBytes: new TextEncoder().encode('x'),
        inputCanonicalBytes: zero.bytes,
        declaredCompletionTokens: 1,
        model: 'm',
      }),
      computeRequestDigest({
        instructionsBytes: new TextEncoder().encode('x'),
        inputCanonicalBytes: falsy.bytes,
        declaredCompletionTokens: 1,
        model: 'm',
      }),
      computeRequestDigest({
        instructionsBytes: new TextEncoder().encode('x'),
        inputCanonicalBytes: empty.bytes,
        declaredCompletionTokens: 1,
        model: 'm',
      }),
    ])
    assert.equal(digests.size, 4)
  }
})

test('canonicalize: object keys sorted UTF-16; nested null allowed; NaN rejected', () => {
  const ok = canonicalizeRecursiveInput({ b: 1, a: [null, true] })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(Buffer.from(ok.bytes).toString('utf8'), '{"a":[null,true],"b":1}')
  }
  const bad = canonicalizeRecursiveInput(Number.NaN)
  assert.equal(bad.ok, false)
  const inf = canonicalizeRecursiveInput(Number.POSITIVE_INFINITY)
  assert.equal(inf.ok, false)
})

test('canonicalize: depth and node limits', () => {
  let deep: unknown = 1
  for (let i = 0; i < 10; i += 1) deep = [deep]
  const deepResult = canonicalizeRecursiveInput(deep)
  assert.equal(deepResult.ok, false)

  const wide = Array.from({ length: 2000 }, (_, i) => i)
  const wideResult = canonicalizeRecursiveInput(wide)
  assert.equal(wideResult.ok, false)
})

// ---------- Unit: reserve / settle / clamp (B4 / I3) ----------

test('clamp-to-available: parent pool smaller than requested completion still admits', () => {
  const decision = decideReserve({
    instructionsByteLength: 40,
    inputByteLength: 0,
    maxOutputTokens: 2048,
    remainingTokens: 200,
  })
  assert.equal(decision.ok, true)
  assert.ok(decision.declared.declaredCompletionTokens < 2048)
  assert.ok(decision.declared.declaredCompletionTokens <= 200)
  assert.equal(
    decision.declared.reserve,
    decision.declared.declaredPromptTokens + decision.declared.declaredCompletionTokens,
  )
  assert.ok(decision.declared.reserve >= MIN_RESERVE_TOKENS)
  assert.ok(decision.declared.reserve <= 200)
})

test('budget reject: remainingTokens=0 → RECURSIVE_BUDGET_INSUFFICIENT shape', () => {
  const decision = decideReserve({
    instructionsByteLength: 40,
    inputByteLength: 0,
    maxOutputTokens: 100,
    remainingTokens: 0,
  })
  assert.equal(decision.ok, false)
  // With framing bytes, declared prompt is always > 0 when remaining is 0.
  assert.equal(decision.reason, 'prompt_exceeds_pool')
  assert.ok(decision.declared.declaredPromptTokens > 0)
  assert.equal(decision.declared.reserve, decision.declared.declaredPromptTokens)
})

test('budget reject: prompt exceeds remaining', () => {
  const decision = decideReserve({
    instructionsByteLength: 8000,
    inputByteLength: 8000,
    maxOutputTokens: 10,
    remainingTokens: 1,
  })
  assert.equal(decision.ok, false)
  // either prompt_exceeds or min_reserve depending on estimate
  assert.ok(decision.reason === 'prompt_exceeds_pool' || decision.reason === 'min_reserve')
})

test('settle: actual <= reserve charges actual; overflow=0', () => {
  const remainingBefore = 1000
  const reserve = 300
  const afterReserve = applyReserve(remainingBefore, reserve)
  const settlement = settleReserve({
    remainingBeforeSettle: afterReserve,
    reserve,
    inputTokens: 50,
    outputTokens: 70,
  })
  assert.equal(settlement.actualUsageTokens, 120)
  assert.equal(settlement.chargedTokens, 120)
  assert.equal(settlement.overflowTokens, 0)
  assert.equal(settlement.remainingAfter, remainingBefore - 120)
})

test('settle overflow mock: actual > reserve → overflow=diff, charged=reserve', () => {
  const remainingBefore = 500
  const reserve = 100
  const afterReserve = applyReserve(remainingBefore, reserve)
  const settlement = settleReserve({
    remainingBeforeSettle: afterReserve,
    reserve,
    inputTokens: 80,
    outputTokens: 90,
  })
  assert.equal(settlement.actualUsageTokens, 170)
  assert.equal(settlement.chargedTokens, 100)
  assert.equal(settlement.overflowTokens, 70)
  assert.equal(settlement.remainingAfter, remainingBefore - 100)
})

test('refund path restores full reserve (C1/C2 pre-LLM)', () => {
  const remainingBefore = 800
  const reserve = 250
  const after = applyReserve(remainingBefore, reserve)
  const refund = refundReserve(after, reserve)
  assert.equal(refund.remainingAfter, remainingBefore)
  assert.equal(refund.chargedTokens, 0)
  assert.equal(refund.overflowTokens, 0)
})

test('missing usage settles as 0', () => {
  const settlement = settleReserve({
    remainingBeforeSettle: 100,
    reserve: 50,
  })
  assert.equal(settlement.actualUsageTokens, 0)
  assert.equal(settlement.chargedTokens, 0)
  assert.equal(settlement.remainingAfter, 150)
})

// ---------- Unit: requestDigest I4 ----------

test('requestDigest stable; control not in digest; uses declaredCompletion', () => {
  const instructionsBytes = new TextEncoder().encode('hello')
  const input = canonicalizeRecursiveInput({ z: 1, a: 2 })
  assert.ok(input.ok)
  if (!input.ok) return
  const d1 = computeRequestDigest({
    instructionsBytes,
    inputCanonicalBytes: input.bytes,
    declaredCompletionTokens: 100,
    model: 'test-model',
  })
  const d2 = computeRequestDigest({
    instructionsBytes,
    inputCanonicalBytes: input.bytes,
    declaredCompletionTokens: 100,
    model: 'test-model',
  })
  assert.equal(d1, d2)
  const d3 = computeRequestDigest({
    instructionsBytes,
    inputCanonicalBytes: input.bytes,
    declaredCompletionTokens: 101,
    model: 'test-model',
  })
  assert.notEqual(d1, d3)
})

test('prepareRecursiveAdmission: param fail has no digest; budget path has digest', () => {
  const paramFail = prepareRecursiveAdmission({
    instructions: 123 as unknown as string,
    input: null,
    maxOutputTokens: null,
    remainingTokens: 1000,
    model: 'test-model',
  })
  assert.equal(paramFail.ok, false)
  if (!paramFail.ok) {
    assert.equal(paramFail.result.requestDigest, undefined)
    assert.equal(paramFail.result.reservation?.declaredPromptTokens, 0)
  }

  const okPrep = prepareRecursiveAdmission({
    instructions: 'summarize inventory',
    input: null,
    maxOutputTokens: 2048,
    remainingTokens: 0,
    model: 'test-model',
  })
  assert.equal(okPrep.ok, true)
  if (okPrep.ok) {
    assert.ok(okPrep.requestDigest.startsWith('sha256:'))
    assert.equal(okPrep.declared.declaredCompletionTokens, 0)
  }
})

test('I4 partition verify: missing digest requires rejected+zeros', () => {
  const okMissing: ModelEffect = {
    method: 'models.call',
    status: 'rejected',
    textPreview: '',
    textTruncated: false,
    reservation: emptyReservation(),
    error: { code: 'RECURSIVE_PARAM_INVALID', message: 'x' },
  }
  assert.equal(verifyRequestDigestPartition(okMissing).ok, true)

  const badMissing: ModelEffect = {
    ...okMissing,
    reservation: emptyReservation({ declaredPromptTokens: 10 }),
  }
  assert.equal(verifyRequestDigestPartition(badMissing).ok, false)

  for (const code of [
    'RECURSIVE_BUDGET_INSUFFICIENT',
    'RECURSIVE_CALL_LIMIT_EXCEEDED',
    'RECURSIVE_MODEL_NOT_ENABLED',
    'MULTIPLE_EFFECTS_IN_CELL',
  ] as const) {
    const forged: ModelEffect = {
      ...okMissing,
      error: { code, message: 'forged no-digest admission reject' },
    }
    assert.equal(
      verifyRequestDigestPartition(forged).ok,
      false,
      `missing digest must fail for ${code}`,
    )
  }

  const prep = prepareRecursiveAdmission({
    instructions: 'budget path',
    input: null,
    maxOutputTokens: 10,
    remainingTokens: 0,
    model: 'test-model',
  })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const withDigest: ModelEffect = {
    method: 'models.call',
    status: 'rejected',
    requestDigest: prep.requestDigest,
    request: {
      instructions: 'budget path',
      model: 'test-model',
    },
    textPreview: '',
    textTruncated: false,
    reservation: emptyReservation({
      declaredPromptTokens: prep.declared.declaredPromptTokens,
      declaredCompletionTokens: prep.declared.declaredCompletionTokens,
    }),
    error: { code: 'RECURSIVE_BUDGET_INSUFFICIENT', message: 'x' },
  }
  assert.equal(verifyRequestDigestPartition(withDigest).ok, true)
  const recomputed = recomputeRequestDigestFromEffect({ effect: withDigest })
  assert.equal(recomputed, prep.requestDigest)
  const digestChecks = requestDigestReplayChecks([withDigest], { model: 'test-model' })
  assert.equal(digestChecks.every(c => c.passed), true)
})

test('prompt assembly omits Input-JSON for empty canonical; keeps it for ""', () => {
  const empty = buildRecursiveUserContent('go', new Uint8Array(0))
  assert.equal(empty.includes('Input-JSON'), false)
  const valuedEmpty = canonicalizeRecursiveInput('')
  assert.ok(valuedEmpty.ok)
  if (valuedEmpty.ok) {
    const withEmpty = buildRecursiveUserContent('go', valuedEmpty.bytes)
    assert.ok(withEmpty.includes('Input-JSON:\n""\n'))
  }
})

// ---------- Unit: error / termination map ----------

test('mapProviderError: cancel and deadline map to parent termination', () => {
  const cancel = mapProviderError({ code: 'IO_CANCELLED', message: 'cancelled' })
  assert.equal(cancel.status, 'cancelled')
  assert.equal(cancel.code, 'RECURSIVE_MODEL_CANCELLED')
  assert.equal(cancel.parentTermination, 'cancelled')
  assert.equal(parentTerminationFromRecursive('RECURSIVE_MODEL_CANCELLED'), 'cancelled')

  const deadline = mapProviderError({ code: 'IO_DEADLINE_EXCEEDED', message: 'deadline' })
  assert.equal(deadline.status, 'failed')
  assert.equal(deadline.code, 'RECURSIVE_MODEL_DEADLINE')
  assert.equal(deadline.parentTermination, 'wall_budget_exhausted')
  assert.equal(
    parentTerminationFromRecursive('RECURSIVE_MODEL_DEADLINE'),
    'wall_budget_exhausted',
  )

  const other = mapProviderError({ code: 'MODEL_UNKNOWN_ERROR', message: 'boom' })
  assert.equal(other.status, 'failed')
  assert.equal(other.code, 'RECURSIVE_MODEL_FAILED')
  assert.equal(other.parentTermination, undefined)
  assert.equal(parentTerminationFromRecursive('RECURSIVE_BUDGET_INSUFFICIENT'), undefined)
})

test('childRunId format and call limit constant', () => {
  assert.equal(allocateChildRunId('parent-1', 0), 'parent-1:rmc:0')
  assert.equal(MAX_RECURSIVE_CALLS_PER_RUN, 4)
  assert.equal(DEFAULT_PARENT_RECURSIVE_TOKEN_POOL, 16_384)
  assert.equal(MAX_RECURSIVE_COMPLETION_TOKENS, 2048)
  assert.equal(MAX_RECURSIVE_PROMPT_TOKENS, 4096)
  assert.ok(MAX_RECURSIVE_INSTRUCTIONS_BYTES === 8000)
})

test('factorioEffect and modelEffect are mutually exclusive', () => {
  assert.equal(assertEffectsExclusive({}), true)
  assert.equal(assertEffectsExclusive({ factorioEffect: {} }), true)
  assert.equal(assertEffectsExclusive({ modelEffect: {} }), true)
  assert.equal(assertEffectsExclusive({ factorioEffect: {}, modelEffect: {} }), false)
})

test('pins gate rejects legacy v3; v4 gate still accepts #5 pins', () => {
  assert.equal(pinsGateCheckV4(pins).passed, true)
  assert.equal(pinsGateCheck(pins).passed, false) // v5 runner rejects bare v4
  assert.equal(
    rejectLegacyPins({ harness: 'factorio-rlm/v3', bindingSet: 'factorio/v2', kernelProtocol: '2' })
      .passed,
    false,
  )
  assert.equal(rejectLegacyPins(pins).passed, true)
})

// ---------- Unit: childRunIds builder + witness ----------

test('childRunIds excludes C1 attachFailed and includes C2/success', () => {
  const records: CellExecutionRecord[] = [
    {
      schema: 'helix.cell-execution/v2',
      cellId: 'c0',
      source: 'cell-source',
      sourceDigest: 'x',
      startRevision: 0,
      endRevision: 1,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      modelEffect: {
        method: 'models.call',
        childRunId: 'run:rmc:0',
        status: 'failed',
        attachFailed: true,
        requestDigest: 'sha256:a',
        textPreview: '',
        textTruncated: false,
        reservation: emptyReservation({ declaredPromptTokens: 1 }),
        error: { code: 'RECURSIVE_CHILD_ATTACH_FAILED', message: 'c1' },
      },
    },
    {
      schema: 'helix.cell-execution/v2',
      cellId: 'c1',
      source: 'cell-source',
      sourceDigest: 'y',
      startRevision: 1,
      endRevision: 2,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      modelEffect: {
        method: 'models.call',
        childRunId: 'run:rmc:1',
        status: 'failed',
        requestDigest: 'sha256:b',
        textPreview: '',
        textTruncated: false,
        reservation: emptyReservation({ declaredPromptTokens: 1 }),
        error: { code: 'RECURSIVE_CHILD_POST_ATTACH_FAILED', message: 'c2' },
      },
    },
    {
      schema: 'helix.cell-execution/v2',
      cellId: 'c2',
      source: 'cell-source',
      sourceDigest: 'z',
      startRevision: 2,
      endRevision: 3,
      status: 'success',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      modelEffect: {
        method: 'models.call',
        childRunId: 'run:rmc:2',
        status: 'succeeded',
        requestDigest: 'sha256:c',
        textPreview: 'hello world from model',
        textTruncated: false,
        reservation: emptyReservation({
          reservedTokens: 10,
          declaredPromptTokens: 5,
          declaredCompletionTokens: 5,
          actualUsageTokens: 8,
          chargedTokens: 8,
        }),
      },
    },
  ]
  const { childRunIds, nonReplayableChildRunIds } = buildChildRunIds(records)
  assert.deepEqual(nonReplayableChildRunIds, ['run:rmc:0'])
  assert.deepEqual(childRunIds, ['run:rmc:1', 'run:rmc:2'])
  assert.equal(singleEffectMutualExclusionCheck(records).passed, true)

  const witness = scanRecursiveResultWitness(records, [
    { cellIndex: 0, source: 'pass' },
    { cellIndex: 1, source: 'pass' },
    { cellIndex: 2, source: 'pass' },
    { cellIndex: 3, source: 'print(result.child_run_id)  # run:rmc:2' },
  ])
  assert.ok(witness)
  assert.equal(witness?.matchedField, 'childRunId')
  assert.equal(witness?.cellIndex, 3)
})

// ---------- Integration: LiveCellExecutor models.call with mock child port ----------

class MockChildPort implements IIOPort {
  lastRequest: ModelRequest | undefined
  constructor(
    private readonly response: ModelResponse | Error,
    private readonly usageOverride?: { inputTokens: number; outputTokens: number },
  ) {}
  async invokeLLM(request: ModelRequest): Promise<ModelResponse> {
    this.lastRequest = request
    if (this.response instanceof Error) {
      if (this.usageOverride) {
        Object.assign(this.response, { usage: this.usageOverride })
      }
      throw this.response
    }
    return this.response
  }
  async invokeTool(): Promise<unknown> {
    throw new Error('not used')
  }
  now(): number {
    return Date.now()
  }
  uuid(): string {
    return '00000000-0000-4000-8000-000000000001'
  }
}

function mockFactory(
  response: ModelResponse | Error,
  opts?: {
    attachFault?: 'never-started' | 'post-started'
    usageOverride?: { inputTokens: number; outputTokens: number }
  },
): ChildPortFactory {
  return async args => {
    if (opts?.attachFault === 'never-started') {
      throw new Error('attach refused')
    }
    const port = new MockChildPort(response, opts?.usageOverride)
    const handle: ChildPortHandle = {
      port,
      attached: true,
      detach: async () => undefined,
    }
    if (opts?.attachFault === 'post-started') {
      // Caller (executor) will see attached=true then hit attachFault path via options.
      void args
    }
    return handle
  }
}

/** Drive models.call admission without a real Kernel by calling private path via execute mock is heavy.
 *  Instead we unit-test prepare + a thin harness around handleModelsCall through a test subclass.
 */
class TestableExecutor extends LiveCellExecutor {
  async callModels(
    params: Record<string, unknown>,
    cellId = 'cell-0',
  ) {
    // Access private method via bracket for integration coverage.
    const handle = (
      this as unknown as {
        handleModelsCall: (
          frame: Record<string, unknown>,
          cellId: string,
        ) => Promise<{ result: unknown; modelEffect: ModelEffect }>
      }
    ).handleModelsCall.bind(this)
    return handle({ method: 'models.call', params }, cellId)
  }

  occupy(): void {
    ;(this as unknown as { hostEffectOccupied: boolean }).hostEffectOccupied = true
  }

  get occupied(): boolean {
    return (this as unknown as { hostEffectOccupied: boolean }).hostEffectOccupied
  }
}

test('integration: successful models.call reserves, settles, and records childRunId', async () => {
  const store = new MemoryTraceObjectStore()
  const response: ModelResponse = {
    content: [{ type: 'text', text: 'place a miner near iron ore' }],
    toolCalls: [],
    usage: { inputTokens: 40, outputTokens: 20 },
    finishReason: 'end_turn',
  }
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveModelEnabled: true,
    recursiveTokenPool: 2000,
    childPortFactory: mockFactory(response),
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result, modelEffect } = await executor.callModels({
    instructions: 'advise next FLE action',
    input: { inventory: ['coal'] },
    maxOutputTokens: 2048,
  })
  const wire = result as {
    status: string
    childRunId: string
    requestDigest: string
    reservation: {
      reservedTokens: number
      chargedTokens: number
      actualUsageTokens: number
      overflowTokens: number
      declaredCompletionTokens: number
      requestedCompletionTokens: number
    }
  }
  assert.equal(wire.status, 'succeeded')
  assert.equal(wire.childRunId, 'parent:rmc:0')
  assert.ok(wire.requestDigest.startsWith('sha256:'))
  assert.equal(wire.reservation.actualUsageTokens, 60)
  assert.equal(wire.reservation.chargedTokens, 60)
  assert.equal(wire.reservation.overflowTokens, 0)
  assert.ok(wire.reservation.declaredCompletionTokens < 2048 || wire.reservation.declaredCompletionTokens === 2048)
  assert.equal(wire.reservation.requestedCompletionTokens, 2048)
  assert.equal(modelEffect.status, 'succeeded')
  assert.deepEqual(executor.childRunIds, ['parent:rmc:0'])
  assert.equal(executor.recursiveProviderCalls, 1)
  assert.equal(executor.getBudgetPool().remainingTokens, before - 60)
  assert.equal(executor.getBudgetPool().recursiveCallCount, 1)
  assert.equal(executor.occupied, true)
})

test('integration: overflow mock charges reserve only', async () => {
  const store = new MemoryTraceObjectStore()
  const response: ModelResponse = {
    content: [{ type: 'text', text: 'x' }],
    toolCalls: [],
    usage: { inputTokens: 500, outputTokens: 500 },
    finishReason: 'end_turn',
  }
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 300,
    childPortFactory: mockFactory(response),
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result } = await executor.callModels({
    instructions: 'short',
    maxOutputTokens: 50,
  })
  const reservation = (result as { reservation: {
    reservedTokens: number
    chargedTokens: number
    actualUsageTokens: number
    overflowTokens: number
  } }).reservation
  assert.ok(reservation.actualUsageTokens > reservation.reservedTokens)
  assert.equal(reservation.chargedTokens, reservation.reservedTokens)
  assert.equal(
    reservation.overflowTokens,
    reservation.actualUsageTokens - reservation.reservedTokens,
  )
  assert.equal(
    executor.getBudgetPool().remainingTokens,
    before - reservation.chargedTokens,
  )
})

test('integration: budget reject does not occupy slot or touch provider', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 0,
    childPortFactory: mockFactory({
      content: [],
      toolCalls: [],
    }),
  })
  const { result, modelEffect } = await executor.callModels({
    instructions: 'anything',
  })
  const wire = result as {
    status: string
    error: { code: string }
    requestDigest?: string
    reservation: { reservedTokens: number; declaredPromptTokens: number }
  }
  assert.equal(wire.status, 'rejected')
  assert.equal(wire.error.code, 'RECURSIVE_BUDGET_INSUFFICIENT')
  assert.ok(wire.requestDigest) // I4: param ok → digest present
  assert.equal(wire.reservation.reservedTokens, 0)
  assert.equal(executor.occupied, false)
  assert.equal(executor.recursiveProviderCalls, 0)
  assert.equal(executor.childRunIds.length, 0)
  assert.equal(modelEffect.requestDigest, wire.requestDigest)
})

test('integration: not enabled rejects without provider', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveModelEnabled: false,
    childPortFactory: mockFactory({ content: [], toolCalls: [] }),
  })
  const { result } = await executor.callModels({ instructions: 'x' })
  assert.equal((result as { error: { code: string } }).error.code, 'RECURSIVE_MODEL_NOT_ENABLED')
  assert.equal(executor.recursiveProviderCalls, 0)
  assert.equal(executor.occupied, false)
})

test('integration: MULTIPLE_EFFECTS_IN_CELL returns ok-path rejected result (IMP-B)', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    childPortFactory: mockFactory({
      content: [{ type: 'text', text: 'ok' }],
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  })
  // First call occupies
  await executor.callModels({ instructions: 'first' })
  assert.equal(executor.occupied, true)
  const second = await executor.callModels({ instructions: 'second' })
  const wire = second.result as {
    status: string
    error: { code: string }
    requestDigest?: string
    childRunId: string | null
  }
  assert.equal(wire.status, 'rejected')
  assert.equal(wire.error.code, 'MULTIPLE_EFFECTS_IN_CELL')
  assert.ok(wire.requestDigest)
  assert.equal(wire.childRunId, null)
  // provider only called once (first)
  assert.equal(executor.recursiveProviderCalls, 1)
})

test('integration: call limit after MAX admissions', async () => {
  const store = new MemoryTraceObjectStore()
  const mk = () =>
    mockFactory({
      content: [{ type: 'text', text: 'ok' }],
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    })
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    maxRecursiveCalls: 2,
    recursiveTokenPool: 10_000,
    childPortFactory: mk(),
  })
  // Manually reset occupied between cells (new cell boundary).
  await executor.callModels({ instructions: 'one' })
  executor.resetHostEffectOccupied()
  executor.setChildPortFactory(mk())
  await executor.callModels({ instructions: 'two' })
  executor.resetHostEffectOccupied()
  executor.setChildPortFactory(mk())
  const third = await executor.callModels({ instructions: 'three' })
  assert.equal(
    (third.result as { error: { code: string } }).error.code,
    'RECURSIVE_CALL_LIMIT_EXCEEDED',
  )
  assert.equal(executor.getBudgetPool().recursiveCallCount, 2)
})

test('integration: C1 attachFailed never-started — refund, not in childRunIds', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 5000,
    attachFault: 'never-started',
    childPortFactory: mockFactory({ content: [], toolCalls: [] }, { attachFault: 'never-started' }),
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result, modelEffect } = await executor.callModels({ instructions: 'attach me' })
  const wire = result as {
    status: string
    error: { code: string }
    childRunId: string
    attachFailed: boolean
    reservation: { reservedTokens: number; chargedTokens: number }
  }
  assert.equal(wire.status, 'failed')
  assert.equal(wire.error.code, 'RECURSIVE_CHILD_ATTACH_FAILED')
  assert.equal(wire.attachFailed, true)
  assert.equal(wire.childRunId, 'parent:rmc:0')
  assert.equal(wire.reservation.reservedTokens, 0)
  assert.equal(wire.reservation.chargedTokens, 0)
  assert.equal(executor.getBudgetPool().remainingTokens, before)
  assert.equal(executor.getBudgetPool().recursiveCallCount, 1) // not rolled back
  assert.equal(executor.occupied, true)
  assert.deepEqual(executor.childRunIds, [])
  assert.deepEqual(executor.nonReplayableChildRunIds, ['parent:rmc:0'])
  assert.equal(modelEffect.attachFailed, true)
  assert.equal(executor.recursiveProviderCalls, 0)
})

test('integration: C2 post-started — in childRunIds, not attachFailed', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 5000,
    attachFault: 'post-started',
    childPortFactory: mockFactory({ content: [], toolCalls: [] }),
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result, modelEffect } = await executor.callModels({ instructions: 'post attach' })
  const wire = result as {
    status: string
    error: { code: string }
    childRunId: string
    attachFailed?: boolean
  }
  assert.equal(wire.status, 'failed')
  assert.equal(wire.error.code, 'RECURSIVE_CHILD_POST_ATTACH_FAILED')
  assert.notEqual(wire.attachFailed, true)
  assert.equal(wire.childRunId, 'parent:rmc:0')
  assert.equal(executor.getBudgetPool().remainingTokens, before)
  assert.equal(executor.getBudgetPool().recursiveCallCount, 1)
  assert.equal(executor.occupied, true)
  assert.deepEqual(executor.childRunIds, ['parent:rmc:0'])
  assert.equal(modelEffect.attachFailed, undefined)
  assert.equal(executor.recursiveProviderCalls, 0)
})

test('integration: param invalid has no digest and does not occupy', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    childPortFactory: mockFactory({ content: [], toolCalls: [] }),
  })
  const { result } = await executor.callModels({
    instructions: 'x'.repeat(20_000),
  })
  const wire = result as {
    status: string
    error: { code: string }
    requestDigest?: string
  }
  assert.equal(wire.status, 'rejected')
  assert.equal(wire.error.code, 'RECURSIVE_PARAM_INVALID')
  assert.equal(wire.requestDigest, undefined)
  assert.equal(executor.occupied, false)
  assert.equal(executor.recursiveProviderCalls, 0)
})

test('integration: cancel maps to cancelled + parent termination latch', async () => {
  const store = new MemoryTraceObjectStore()
  const err = Object.assign(new Error('cancelled'), { code: 'IO_CANCELLED' })
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 5000,
    childPortFactory: mockFactory(err),
  })
  const { result } = await executor.callModels({ instructions: 'cancel me' })
  assert.equal((result as { status: string }).status, 'cancelled')
  assert.equal(
    (result as { error: { code: string } }).error.code,
    'RECURSIVE_MODEL_CANCELLED',
  )
  assert.equal(executor.getRecursiveControlTermination(), 'cancelled')
  assert.deepEqual(executor.childRunIds, ['parent:rmc:0'])
})

test('integration: deadline maps to failed + wall_budget_exhausted latch', async () => {
  const store = new MemoryTraceObjectStore()
  const err = Object.assign(new Error('deadline'), { code: 'IO_DEADLINE_EXCEEDED' })
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 5000,
    childPortFactory: mockFactory(err),
  })
  const { result } = await executor.callModels({ instructions: 'deadline me' })
  assert.equal((result as { status: string }).status, 'failed')
  assert.equal(
    (result as { error: { code: string } }).error.code,
    'RECURSIVE_MODEL_DEADLINE',
  )
  assert.equal(executor.getRecursiveControlTermination(), 'wall_budget_exhausted')
})

test('parentTerminationMapCheck rejects invented control termination', () => {
  const records: CellExecutionRecord[] = [
    {
      schema: 'helix.cell-execution/v2',
      cellId: 'c0',
      source: 'helix.models.call("x")',
      sourceDigest: 'x',
      startRevision: 0,
      endRevision: 1,
      status: 'success',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      modelEffect: {
        method: 'models.call',
        status: 'rejected',
        requestDigest: 'sha256:x',
        textPreview: '',
        textTruncated: false,
        reservation: emptyReservation(),
        error: { code: 'RECURSIVE_BUDGET_INSUFFICIENT', message: 'pool empty' },
      },
    },
  ]
  // Ordinary budget reject must not invent cancel/deadline termination.
  assert.equal(
    parentTerminationMapCheck('cancelled', records).passed,
    false,
  )
  assert.equal(
    parentTerminationMapCheck('wall_budget_exhausted', records).passed,
    false,
  )
  // Outer paths remain allowed; pool zero itself does not map to model_budget_exhausted
  // but outer model_budget_exhausted is still a valid non-control-class termination here.
  assert.equal(
    parentTerminationMapCheck('cell_budget_exhausted', records).passed,
    true,
  )
  assert.equal(
    parentTerminationMapCheck('verifier_succeeded', records).passed,
    true,
  )
})

test('integration: pool zero does not invent parent model_budget_exhausted', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 0,
    childPortFactory: mockFactory({ content: [], toolCalls: [] }),
  })
  await executor.callModels({ instructions: 'pool empty' })
  // No control termination latched from budget reject
  assert.equal(executor.getRecursiveControlTermination(), undefined)
  assert.equal(executor.occupied, false)
})

test('declared limits formula uses ceil(bytes/4) + framing', () => {
  const declared = computeDeclaredLimits({
    instructionsByteLength: 12,
    inputByteLength: 4,
    maxOutputTokens: 100,
    remainingTokens: 10_000,
  })
  // estimate = ceil((12+4+64)/4) = ceil(80/4) = 20
  assert.equal(declared.estimatedPromptTokens, 20)
  assert.equal(declared.declaredPromptTokens, 20)
  assert.equal(declared.requestedCompletionTokens, 100)
  assert.equal(declared.declaredCompletionTokens, 100)
  assert.equal(declared.reserve, 120)
})

test('pinsDigest still gates execute_cell before kernel start', async () => {
  const executor = new LiveCellExecutor(
    'run',
    'run:episode:0',
    pins,
    new MemoryTraceObjectStore(),
  )
  const stale = await executor.execute({
    cellId: 'run:cell:0',
    code: 'print(1)',
    expectedKernelRevision: 0,
    expectedEpisodeRevision: 0,
    pinsDigest: 'wrong',
  })
  assert.equal(stale.error?.code, 'PINS_DIGEST_MISMATCH')
  assert.equal(executor.kernelStartCount, 0)
  // Also ensure digest(pins) works with v4 pins
  assert.ok(digest(pins).startsWith('sha256:'))
})


// ---------- B1: child Replay response hash + lifecycle ----------

const LLM_OUTCOME_SCHEMA_VERSION = 2

function checkById(
  checks: Array<{ id: string; passed: boolean; detail?: string }>,
  id: string,
) {
  const found = checks.find(check => check.id === id)
  assert.ok(found, `missing check ${id}`)
  return found!
}

function baseModelRequest(text = 'advise next step') {
  return {
    model: 'test-model',
    temperature: 0,
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
      },
    ],
    metadata: {
      requestDigest: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
  }
}

async function seedChildLifecycle(
  store: MemoryEventStore,
  args: {
    childRunId: string
    parentRunId: string
    includeCompleted?: boolean
    extraCompleted?: boolean
  },
) {
  const includeCompleted = args.includeCompleted !== false
  await store.append({
    id: `${args.childRunId}:started`,
    runId: args.childRunId,
    type: 'agent.run.started',
    actor: 'runtime',
    timestamp: 1,
    payload: {
      agentId: 'recursive-model',
      input: '',
      parentId: args.parentRunId,
    },
  } as Event)
  if (includeCompleted) {
    await store.append({
      id: `${args.childRunId}:completed`,
      runId: args.childRunId,
      type: 'agent.run.completed',
      actor: 'runtime',
      timestamp: 3,
      payload: { status: 'completed', output: '' },
    } as Event)
  }
  if (args.extraCompleted) {
    await store.append({
      id: `${args.childRunId}:completed-extra`,
      runId: args.childRunId,
      type: 'agent.run.completed',
      actor: 'runtime',
      timestamp: 4,
      payload: { status: 'completed', output: 'dup' },
    } as Event)
  }
}

test('B1 child replay: successful LLM response hash matches', async () => {
  const store = new MemoryEventStore()
  const childRunId = 'parent:rmc:success'
  const parentRunId = 'parent'
  const responseText = 'place miner'
  const request = baseModelRequest('child prompt')
  const requestHash = hashModelRequest(request)
  const response = {
    content: [{ type: 'text' as const, text: responseText }],
    toolCalls: [],
    usage: { inputTokens: 3, outputTokens: 5 },
    finishReason: 'end_turn' as const,
  }
  await seedChildLifecycle(store, { childRunId, parentRunId })
  await store.append({
    id: `${childRunId}:llm-req`,
    runId: childRunId,
    type: 'llm.requested',
    actor: 'runtime',
    timestamp: 2,
    causedBy: `${childRunId}:started`,
    payload: {
      request,
      requestHash,
      outcomeSchemaVersion: LLM_OUTCOME_SCHEMA_VERSION,
    },
  } as Event)
  await store.append({
    id: `${childRunId}:llm-resp`,
    runId: childRunId,
    type: 'llm.responded',
    actor: 'runtime',
    timestamp: 2.5,
    causedBy: `${childRunId}:llm-req`,
    payload: {
      status: 'ok',
      response,
      requestHash,
    },
  } as Event)

  const result = await replayChildRun({ eventStore: store, childRunId, parentRunId })
  assert.equal(result.liveEffectCount, 0)
  assert.deepEqual(result.remainingIO, { llm: 0, tool: 0, clock: 0, uuid: 0 })
  assert.equal(result.parentId, parentRunId)
  assert.equal(checkById(result.checks, `S2.child-lifecycle.${childRunId}`).passed, true)
  assert.equal(
    checkById(result.checks, `S2.child-llm-response-hash.${childRunId}.0`).passed,
    true,
  )
  assert.equal(
    checkById(result.checks, `S2.child-empty-or-consumed-llm.${childRunId}`).passed,
    true,
  )
  assert.ok(result.checks.every(check => check.passed), JSON.stringify(result.checks.filter(c => !c.passed)))
})

test('B1 child replay: tampered response fails hash check', () => {
  const original = {
    content: [{ type: 'text' as const, text: 'original-answer' }],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'end_turn' as const,
  }
  const tampered = {
    content: [{ type: 'text' as const, text: 'tampered-answer' }],
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'end_turn' as const,
  }
  const ok = childLlmResponseHashCheck({
    childRunId: 'c',
    index: 0,
    replayed: original,
    recordedStatus: 'ok',
    recordedResponse: original,
    requestHash: 'abc',
  })
  assert.equal(ok.passed, true)
  const bad = childLlmResponseHashCheck({
    childRunId: 'c',
    index: 0,
    replayed: original,
    recordedStatus: 'ok',
    recordedResponse: tampered,
    requestHash: 'abc',
  })
  assert.equal(bad.passed, false)
  assert.match(bad.detail ?? '', /response hash mismatch/)
  const missing = childLlmResponseHashCheck({
    childRunId: 'c',
    index: 0,
    replayed: original,
    recordedStatus: 'ok',
    // recordedResponse intentionally absent
    requestHash: 'abc',
  })
  assert.equal(missing.passed, false)
})

test('B1 child replay: missing completed fails lifecycle', async () => {
  const store = new MemoryEventStore()
  const childRunId = 'parent:rmc:no-completed'
  const parentRunId = 'parent'
  await seedChildLifecycle(store, {
    childRunId,
    parentRunId,
    includeCompleted: false,
  })
  const result = await replayChildRun({ eventStore: store, childRunId, parentRunId })
  const life = checkById(result.checks, `S2.child-lifecycle.${childRunId}`)
  assert.equal(life.passed, false)
  assert.match(life.detail ?? '', /started=1 completed=0/)
  assert.equal(checkById(result.checks, `S2.child-empty-or-consumed-llm.${childRunId}`).passed, true)
  assert.deepEqual(result.remainingIO, { llm: 0, tool: 0, clock: 0, uuid: 0 })
})

test('B1 child replay: duplicate completed fails lifecycle', async () => {
  const store = new MemoryEventStore()
  const childRunId = 'parent:rmc:dup-completed'
  const parentRunId = 'parent'
  await seedChildLifecycle(store, {
    childRunId,
    parentRunId,
    includeCompleted: true,
    extraCompleted: true,
  })
  const result = await replayChildRun({ eventStore: store, childRunId, parentRunId })
  const life = checkById(result.checks, `S2.child-lifecycle.${childRunId}`)
  assert.equal(life.passed, false)
  assert.match(life.detail ?? '', /started=1 completed=2/)
})

test('B1 child replay: C2 empty LLM requires full lifecycle and remaining 0', async () => {
  const store = new MemoryEventStore()
  const childRunId = 'parent:rmc:c2-empty'
  const parentRunId = 'parent'
  await seedChildLifecycle(store, { childRunId, parentRunId })
  const result = await replayChildRun({ eventStore: store, childRunId, parentRunId })
  assert.equal(result.liveEffectCount, 0)
  assert.deepEqual(result.remainingIO, { llm: 0, tool: 0, clock: 0, uuid: 0 })
  assert.equal(checkById(result.checks, `S2.child-lifecycle.${childRunId}`).passed, true)
  assert.equal(checkById(result.checks, `S2.child-empty-or-consumed-llm.${childRunId}`).passed, true)
  assert.equal(checkById(result.checks, `S2.child-replay-io.${childRunId}`).passed, true)
  // No LLM response checks expected.
  assert.equal(
    result.checks.some(check => check.id.includes('child-llm-response-hash')),
    false,
  )
  assert.ok(result.checks.every(check => check.passed), JSON.stringify(result.checks.filter(c => !c.passed)))
})

test('I2 C1 attached=false does not call detach', async () => {
  const store = new MemoryTraceObjectStore()
  let detachCalls = 0
  const factory: ChildPortFactory = async () => ({
    port: new MockChildPort({ content: [], toolCalls: [] }),
    attached: false,
    detach: async () => {
      detachCalls += 1
    },
  })
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 5000,
    childPortFactory: factory,
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result, modelEffect } = await executor.callModels({ instructions: 'no attach' })
  const wire = result as {
    status: string
    error: { code: string }
    attachFailed?: boolean
    childRunId: string
  }
  assert.equal(wire.status, 'failed')
  assert.equal(wire.error.code, 'RECURSIVE_CHILD_ATTACH_FAILED')
  assert.equal(wire.attachFailed, true)
  assert.equal(detachCalls, 0)
  assert.deepEqual(executor.childRunIds, [])
  assert.deepEqual(executor.nonReplayableChildRunIds, ['parent:rmc:0'])
  assert.equal(modelEffect.attachFailed, true)
  assert.equal(executor.getBudgetPool().remainingTokens, before)
  assert.equal(executor.recursiveProviderCalls, 0)
})


// ---------- Approve-gate H1/H2/H3 ----------

function bareCell(
  cellId: string,
  extras: Partial<CellExecutionRecord> = {},
): CellExecutionRecord {
  return {
    schema: 'helix.cell-execution/v2',
    cellId,
    source: extras.source ?? 'pass',
    sourceDigest: extras.sourceDigest ?? `digest-${cellId}`,
    startRevision: extras.startRevision ?? 0,
    endRevision: extras.endRevision ?? 1,
    status: extras.status ?? 'success',
    stdoutPreview: extras.stdoutPreview ?? '',
    stderrPreview: extras.stderrPreview ?? '',
    stdoutTruncated: extras.stdoutTruncated ?? false,
    stderrTruncated: extras.stderrTruncated ?? false,
    namespace: extras.namespace ?? [],
    managedObjects: extras.managedObjects ?? [],
    ...(extras.modelEffect ? { modelEffect: extras.modelEffect } : {}),
    ...(extras.factorioEffect ? { factorioEffect: extras.factorioEffect } : {}),
    ...(extras.error ? { error: extras.error } : {}),
  }
}

test('H1 live: FLE-success-shaped run without models.call fails S1.call-once and witness', () => {
  // FLE-success-shaped: resets/steps/verifier success path without any recursive call.
  const records: CellExecutionRecord[] = [
    bareCell('c0', { source: 'factorio.reset()', startRevision: 0, endRevision: 1 }),
    bareCell('c1', {
      source: 'factorio.step("mine")',
      startRevision: 1,
      endRevision: 2,
    }),
    bareCell('c2', {
      source: 'print("verifier ok")',
      startRevision: 2,
      endRevision: 3,
    }),
  ]
  const callOnce = successfulRecursiveCallCheck(records, { required: true })
  assert.equal(callOnce.passed, false, 'must require >=1 successful recursive call')
  assert.match(callOnce.detail ?? '', /successful recursive calls=0/)

  const witness = recursiveWitnessCheck(undefined, false, { requireSuccessfulCall: true })
  assert.equal(witness.passed, false)
  assert.match(witness.detail ?? '', /required but missing/)

  const checks = liveRecursiveChecks({
    evidence: {
      childRunIds: [],
      nonReplayableChildRunIds: [],
      pins,
    },
    records,
    cellSources: records.map((r, cellIndex) => ({ cellIndex, source: r.source ?? '' })),
    termination: 'verifier_succeeded',
    requireSuccessfulRecursiveCall: true,
  })
  const byId = Object.fromEntries(checks.map(c => [c.id, c]))
  assert.equal(byId['S1.call-once']?.passed, false)
  assert.equal(byId['S1.recursive-result-witness']?.passed, false)
})

test('H1 live: succeeded call missing responseRef does not count', () => {
  const records: CellExecutionRecord[] = [
    bareCell('c0', {
      source: 'r = helix.models.call("x")',
      modelEffect: {
        method: 'models.call',
        childRunId: 'parent:rmc:0',
        status: 'succeeded',
        requestDigest: 'sha256:dead',
        textPreview: 'hello from recursive model!!',
        textTruncated: false,
        // responseRef intentionally absent
        reservation: emptyReservation({
          reservedTokens: 10,
          declaredPromptTokens: 5,
          declaredCompletionTokens: 5,
          actualUsageTokens: 8,
          chargedTokens: 8,
        }),
      },
    }),
    bareCell('c1', { source: 'print("parent:rmc:0")' }),
  ]
  const callOnce = successfulRecursiveCallCheck(records, { required: true })
  assert.equal(callOnce.passed, false)
})

test('H1 live: full success + witness passes S1 bounds', () => {
  const responseRef = {
    hash: 'resp-hash-001',
    bytes: 12,
    kind: 'helix.model-response' as const,
  }
  const records: CellExecutionRecord[] = [
    bareCell('c0', {
      source: 'r = helix.models.call("plan")',
      modelEffect: {
        method: 'models.call',
        childRunId: 'parent:rmc:0',
        status: 'succeeded',
        requestDigest: 'sha256:ok',
        textPreview: 'hello from recursive model!!',
        textTruncated: false,
        responseRef,
        reservation: emptyReservation({
          reservedTokens: 10,
          declaredPromptTokens: 5,
          declaredCompletionTokens: 5,
          actualUsageTokens: 8,
          chargedTokens: 8,
        }),
      },
      managedObjects: [responseRef],
    }),
    bareCell('c1', { source: 'print("parent:rmc:0")' }),
  ]
  assert.equal(successfulRecursiveCallCheck(records, { required: true }).passed, true)
  const witness = scanRecursiveResultWitness(records)
  assert.ok(witness)
  assert.equal(
    recursiveWitnessCheck(witness, true, { requireSuccessfulCall: true }).passed,
    true,
  )
  const checks = liveRecursiveChecks({
    evidence: {
      childRunIds: ['parent:rmc:0'],
      pins,
      recursiveResultWitness: witness,
    },
    records,
    termination: 'verifier_succeeded',
  })
  assert.equal(checks.find(c => c.id === 'S1.call-once')?.passed, true)
  assert.equal(checks.find(c => c.id === 'S1.recursive-result-witness')?.passed, true)
})

test('H2 C1: never-started event check fails when started/LLM present (negative)', () => {
  const childRunId = 'parent:rmc:forged-c1'
  const clean = c1NeverStartedEventCheck({ childRunId, events: [] })
  assert.equal(clean.passed, true)

  const forgedStarted: Event[] = [
    {
      id: `${childRunId}:started`,
      runId: childRunId,
      type: 'agent.run.started',
      actor: 'runtime',
      timestamp: 1,
      payload: { parentId: 'parent', agentId: 'helix.factorio.recursive-model' },
    } as Event,
  ]
  const badStarted = c1NeverStartedEventCheck({ childRunId, events: forgedStarted })
  assert.equal(badStarted.passed, false)
  assert.match(badStarted.detail ?? '', /started=1/)

  const forgedLlm: Event[] = [
    {
      id: `${childRunId}:llm-req`,
      runId: childRunId,
      type: 'llm.requested',
      actor: 'runtime',
      timestamp: 2,
      payload: { requestHash: 'x', request: {}, outcomeSchemaVersion: 2 },
    } as Event,
    {
      id: `${childRunId}:llm-resp`,
      runId: childRunId,
      type: 'llm.responded',
      actor: 'runtime',
      timestamp: 3,
      payload: { status: 'ok', requestHash: 'x', response: {} },
    } as Event,
  ]
  const badLlm = c1NeverStartedEventCheck({ childRunId, events: forgedLlm })
  assert.equal(badLlm.passed, false)
  assert.match(badLlm.detail ?? '', /llm\.requested=1/)
  assert.match(badLlm.detail ?? '', /llm\.responded=1/)
})

test('H2 C1: settlement refund zeros required; non-zero charged fails (negative)', () => {
  const okEffect: ModelEffect = {
    method: 'models.call',
    childRunId: 'parent:rmc:0',
    status: 'failed',
    attachFailed: true,
    requestDigest: 'sha256:c1',
    textPreview: '',
    textTruncated: false,
    reservation: emptyReservation({
      reservedTokens: 0,
      declaredPromptTokens: 4,
      declaredCompletionTokens: 8,
      actualUsageTokens: 0,
      chargedTokens: 0,
      overflowTokens: 0,
    }),
    error: { code: 'RECURSIVE_CHILD_ATTACH_FAILED', message: 'never started' },
  }
  assert.equal(c1SettlementRefundCheck(okEffect).passed, true)

  const forged: ModelEffect = {
    ...okEffect,
    reservation: {
      ...okEffect.reservation,
      chargedTokens: 3,
      reservedTokens: 3,
    },
  }
  const bad = c1SettlementRefundCheck(forged)
  assert.equal(bad.passed, false)
  assert.match(bad.detail ?? '', /chargedTokens=3|reservedTokens=3/)

  const records = [
    bareCell('c0', { modelEffect: okEffect, status: 'error' }),
  ]
  assert.deepEqual(collectC1Effects(records).map(e => e.childRunId), ['parent:rmc:0'])
})

test('H3 INTERNAL after prepare preserves digest and declared* (I4)', async () => {
  const store = new MemoryTraceObjectStore()
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 5000,
    internalFaultAfterPrepare: true,
    childPortFactory: mockFactory({ content: [], toolCalls: [] }),
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result, modelEffect } = await executor.callModels({
    instructions: 'will throw after prepare',
    input: { k: 1 },
  })
  const wire = result as {
    status: string
    error: { code: string }
    requestDigest?: string
    reservation: {
      reservedTokens: number
      declaredPromptTokens: number
      declaredCompletionTokens: number
      chargedTokens: number
      actualUsageTokens: number
      overflowTokens: number
    }
  }
  assert.equal(wire.status, 'failed')
  assert.equal(wire.error.code, 'RECURSIVE_MODEL_INTERNAL')
  assert.ok(wire.requestDigest, 'I4: digest required after prepare')
  assert.ok(wire.requestDigest!.startsWith('sha256:'))
  assert.equal(wire.reservation.reservedTokens, 0)
  assert.equal(wire.reservation.chargedTokens, 0)
  assert.equal(wire.reservation.actualUsageTokens, 0)
  assert.equal(wire.reservation.overflowTokens, 0)
  assert.ok(wire.reservation.declaredPromptTokens > 0 || wire.reservation.declaredCompletionTokens >= 0)
  assert.equal(modelEffect.requestDigest, wire.requestDigest)
  assert.ok(modelEffect.request, 'request echo required with digest')
  assert.equal(modelEffect.request?.instructions, 'will throw after prepare')
  assert.equal(modelEffect.reservation.declaredPromptTokens, wire.reservation.declaredPromptTokens)
  assert.equal(modelEffect.reservation.declaredCompletionTokens, wire.reservation.declaredCompletionTokens)
  assert.equal(verifyRequestDigestPartition(modelEffect).ok, true)
  // Fault before commit → pool unchanged, no provider, no child ids.
  assert.equal(executor.getBudgetPool().remainingTokens, before)
  assert.equal(executor.recursiveProviderCalls, 0)
  assert.deepEqual(executor.childRunIds, [])
  assert.equal(executor.occupied, false)
})

test('H3 INTERNAL after invokeLLM settles actual usage and detaches once', async () => {
  const store = new MemoryTraceObjectStore()
  let detachCount = 0
  let lastDetachStatus: string | undefined
  const response: ModelResponse = {
    content: [{ type: 'text', text: 'post-invoke should still settle' }],
    toolCalls: [],
    usage: { inputTokens: 500, outputTokens: 500 },
    finishReason: 'end_turn',
  }
  const factory: ChildPortFactory = async () => {
    const port = new MockChildPort(response)
    return {
      port,
      attached: true,
      detach: async payload => {
        detachCount += 1
        lastDetachStatus = payload.status
      },
    }
  }
  const executor = new TestableExecutor('parent', 'parent:episode:0', pins, store, {
    recursiveTokenPool: 300,
    internalFaultAfterInvoke: true,
    childPortFactory: factory,
  })
  const before = executor.getBudgetPool().remainingTokens
  const { result, modelEffect } = await executor.callModels({
    instructions: 'will throw after invokeLLM',
    input: { phase: 'post-invoke' },
    maxOutputTokens: 2048,
  })
  const wire = result as {
    status: string
    error: { code: string; message: string }
    childRunId: string | null
    requestDigest?: string
    usage: { inputTokens: number; outputTokens: number } | null
    reservation: {
      reservedTokens: number
      declaredPromptTokens: number
      declaredCompletionTokens: number
      chargedTokens: number
      actualUsageTokens: number
      overflowTokens: number
    }
  }
  assert.equal(wire.status, 'failed')
  assert.equal(wire.error.code, 'RECURSIVE_MODEL_INTERNAL')
  assert.match(wire.error.message, /after invokeLLM/)
  assert.ok(wire.requestDigest, 'I4: digest required after prepare')
  assert.ok(wire.requestDigest!.startsWith('sha256:'))
  assert.equal(wire.childRunId, 'parent:rmc:0')
  assert.deepEqual(wire.usage, { inputTokens: 500, outputTokens: 500 })
  // LLM terminal occurred → reserved kept; charged=min(reserve, actual); overflow correct.
  assert.ok(wire.reservation.reservedTokens > 0)
  assert.equal(wire.reservation.actualUsageTokens, 1000)
  assert.equal(
    wire.reservation.chargedTokens,
    Math.min(wire.reservation.reservedTokens, 1000),
  )
  assert.equal(
    wire.reservation.overflowTokens,
    Math.max(0, 1000 - wire.reservation.reservedTokens),
  )
  assert.ok(wire.reservation.actualUsageTokens > wire.reservation.reservedTokens)
  assert.ok(wire.reservation.declaredPromptTokens > 0)
  assert.equal(modelEffect.requestDigest, wire.requestDigest)
  assert.ok(modelEffect.request, 'request echo required with digest')
  assert.equal(modelEffect.request?.instructions, 'will throw after invokeLLM')
  assert.equal(modelEffect.reservation.chargedTokens, wire.reservation.chargedTokens)
  assert.equal(modelEffect.reservation.actualUsageTokens, 1000)
  assert.equal(modelEffect.reservation.overflowTokens, wire.reservation.overflowTokens)
  assert.equal(modelEffect.usage?.inputTokens, 500)
  assert.equal(modelEffect.usage?.outputTokens, 500)
  assert.equal(verifyRequestDigestPartition(modelEffect).ok, true)
  // Pool charged only chargedTokens (not full refund); open call removed; provider once.
  assert.equal(
    executor.getBudgetPool().remainingTokens,
    before - wire.reservation.chargedTokens,
  )
  assert.deepEqual(executor.getBudgetPool().openRecursiveCalls ?? [], [])
  assert.equal(executor.recursiveProviderCalls, 1)
  assert.deepEqual(executor.childRunIds, ['parent:rmc:0'])
  assert.equal(executor.occupied, true)
  assert.equal(detachCount, 1, 'detach once for started child')
  assert.equal(lastDetachStatus, 'error')
  const settlement = executor.getBudgetPool().settlements.at(-1)
  assert.ok(settlement)
  assert.equal(settlement!.childRunId, 'parent:rmc:0')
  assert.equal(settlement!.chargedTokens, wire.reservation.chargedTokens)
  assert.equal(settlement!.actualUsageTokens, 1000)
  assert.equal(settlement!.overflowTokens, wire.reservation.overflowTokens)
  assert.equal(settlement!.status, 'failed')
  assert.ok((settlement!.reservedTokens ?? 0) > 0)
})
