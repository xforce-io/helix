import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  FileTaskOutcomeFinalizationStore,
  JsonlEventStore,
  MemoryEventStore,
  MemoryStore,
  Milkie,
  type IModelGateway,
  type ModelEvent,
  type ModelRequest,
  type ModelResponse,
} from 'milkie'
import { DefaultIOPort } from 'milkie/dist/runtime/IOPort.js'
import { CausalCursor } from 'milkie/dist/trace/CausalCursor.js'
import { RecordingIOPort } from 'milkie/dist/trace/RecordingIOPort.js'
import type { Event } from 'milkie/dist/trace/types.js'
import { runHarness } from '../src/factorio/harness.js'
import {
  finalizationEvidenceEventIds,
  traceChecksBeforeFinalization,
} from '../src/factorio/verification.js'
import type { RunPins } from '../src/factorio/types.js'

const pins: RunPins = {
  model: 'test-model',
  harness: 'factorio-rlm/v3',
  kernelProtocol: '2',
  bindingSet: 'factorio/v2',
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

class HangingGateway implements IModelGateway {
  async complete(
    _request: ModelRequest,
  ): Promise<ModelResponse> {
    return new Promise<ModelResponse>(() => undefined)
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    await new Promise<never>(() => undefined)
  }
}

class ToolGateway implements IModelGateway {
  async complete(): Promise<ModelResponse> {
    const call = {
      id: 'tool-call',
      name: 'execute_cell',
      input: { code: 'factorio.reset()' },
    }
    return {
      content: [{ type: 'tool_use', ...call }],
      toolCalls: [call],
      finishReason: 'tool_use',
    }
  }

  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    throw new Error('not used')
  }
}

async function recordingPort(gateway: IModelGateway, runId: string) {
  const store = new MemoryEventStore()
  const port = new RecordingIOPort(
    new DefaultIOPort(gateway),
    store,
    runId,
    'test.factorio',
    undefined,
    new CausalCursor(),
  )
  await port.attach({
    agentId: 'test.factorio',
    goal: 'test runtime control',
    input: 'test',
    contextId: `${runId}:episode:0`,
  })
  return { port, store }
}

test('LLM deadline 在固定容差内结束并记录唯一失败 terminal', async () => {
  const runId = 'deadline-run'
  const { port, store } = await recordingPort(new HangingGateway(), runId)
  const deadlineAt = Date.now() + 40
  const startedAt = Date.now()
  const result = await runHarness({
    runId,
    episodeId: `${runId}:episode:0`,
    pins,
    port,
    budget: { deadlineAt },
    control: { deadlineAt },
    execute: async () => {
      throw new Error('tool must not execute')
    },
  })
  await port.detach({ status: 'completed', lastTextOutput: result.termination })
  const elapsedMs = Date.now() - startedAt
  const events = await store.readByRunId(runId)
  const requested = events.filter(event => event.type === 'llm.requested')
  const terminals = events.filter(event => event.type === 'llm.responded')

  assert.equal(result.termination, 'wall_budget_exhausted')
  assert.ok(elapsedMs < 300, `deadline settled after ${elapsedMs}ms`)
  assert.equal(requested.length, 1)
  assert.equal(terminals.length, 1)
  assert.equal((terminals[0]!.payload as { status: string }).status, 'error')
  assert.equal(
    (terminals[0]!.payload as { error: { code: string } }).error.code,
    'IO_DEADLINE_EXCEEDED',
  )
  assert.deepEqual(
    finalizationEvidenceEventIds(events, result.projection, result.termination),
    [terminals[0]!.id, events.find(event => event.type === 'agent.run.completed')!.id],
  )
})

test('caller cancellation 映射 unknown 终止语义且不等待 Provider', async () => {
  const runId = 'cancel-run'
  const { port } = await recordingPort(new HangingGateway(), runId)
  const controller = new AbortController()
  const deadlineAt = Date.now() + 2_000
  setTimeout(() => controller.abort(), 30)
  const result = await runHarness({
    runId,
    episodeId: `${runId}:episode:0`,
    pins,
    port,
    budget: { deadlineAt },
    control: { deadlineAt, signal: controller.signal },
    execute: async () => {
      throw new Error('tool must not execute')
    },
  })
  assert.equal(result.termination, 'cancelled')
})

test('Tool deadline 保守映射 uncertain_effect 且 handler 不盲重试', async () => {
  const runId = 'tool-deadline-run'
  const { port, store } = await recordingPort(new ToolGateway(), runId)
  const deadlineAt = Date.now() + 50
  let executions = 0
  const result = await runHarness({
    runId,
    episodeId: `${runId}:episode:0`,
    pins,
    port,
    budget: { deadlineAt },
    control: { deadlineAt },
    execute: async (_input, _signal) => {
      executions += 1
      return new Promise(() => undefined)
    },
  })
  await port.detach({ status: 'error', error: result.termination })
  const events = await store.readByRunId(runId)
  const toolTerminals = events.filter(event => event.type === 'tool.responded')

  assert.equal(result.termination, 'uncertain_effect')
  assert.equal(result.uncertain, true)
  assert.equal(executions, 1)
  assert.equal(toolTerminals.length, 1)
  assert.equal(
    traceChecksBeforeFinalization(
      events,
      result.projection.modelCallCount,
      result.toolCallCount,
    ).every(check => check.passed),
    true,
  )
  assert.equal(
    (toolTerminals[0]!.payload as { error: { code: string } }).error.code,
    'IO_DEADLINE_EXCEEDED',
  )
})

test('File finalization 首次写入、幂等、冲突和跨实例读取均可判定', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'helix-finalization-'))
  try {
    const eventStore = new JsonlEventStore(path.join(root, 'events'))
    const finalRoot = path.join(root, 'final')
    const runId = 'finalization-run'
    const now = Date.now()
    const events: Event[] = [
      {
        id: 'started', runId, type: 'agent.run.started', actor: 'test', timestamp: now,
        payload: { agentId: 'test', goal: 'test', input: 'test', contextId: 'test' },
      },
      {
        id: 'verifier-terminal', runId, type: 'tool.responded', actor: 'test', timestamp: now + 1,
        payload: { toolName: 'execute_cell', status: 'ok', output: { verifier: true } },
      },
      {
        id: 'completed', runId, type: 'agent.run.completed', actor: 'test', timestamp: now + 2,
        payload: { status: 'completed' },
      },
    ]
    for (const event of events) await eventStore.append(event)

    const milkie = new Milkie({
      stateStore: new MemoryStore(),
      eventStore,
      outcomeFinalizationStore: new FileTaskOutcomeFinalizationStore(finalRoot),
    })
    const input = {
      runId,
      expectedState: 'unfinalized' as const,
      finalizationId: `${runId}:eval:fle:v2`,
      value: 'success' as const,
      verifierClaim: { type: 'eval' as const, id: 'helix.factorio.fle/v2' },
      evidence: [
        { kind: 'event' as const, eventId: 'verifier-terminal' },
        { kind: 'event' as const, eventId: 'completed' },
      ],
    }

    const first = await milkie.finalizeTaskOutcome(input)
    const second = await milkie.finalizeTaskOutcome(input)
    const conflict = await milkie.finalizeTaskOutcome({
      ...input,
      finalizationId: `${runId}:other`,
    })

    assert.equal(first.status, 'finalized')
    assert.equal(second.status, 'idempotent')
    assert.equal(conflict.status, 'conflict')
    if (conflict.status === 'conflict') {
      assert.equal(conflict.conflict.kind, 'already_finalized')
    }

    const reader = new Milkie({
      stateStore: new MemoryStore(),
      eventStore: new JsonlEventStore(path.join(root, 'events')),
      outcomeFinalizationStore: new FileTaskOutcomeFinalizationStore(finalRoot),
    })
    const stored = await reader.getFinalTaskOutcome(runId)
    assert.equal(stored?.value, 'success')
    assert.equal(stored?.recordHash, first.status === 'conflict' ? '' : first.final.recordHash)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
