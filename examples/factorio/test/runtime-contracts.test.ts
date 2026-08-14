import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from 'milkie/dist/trace/types.js'
import { preflightLive, type CommandRunner } from '../src/cli-common.js'
import { JsonLineProcess } from '../src/line-process.js'
import { LiveCellExecutor } from '../src/live-executor.js'
import { boundedObservation } from '../src/live-executor.js'
import {
  decideFinalOutcome,
  episodeContinuityCheck,
  traceChecksBeforeFinalization,
} from '../src/verification.js'
import { canonicalJson, digest } from '../src/canonical.js'
import { MemoryTraceObjectStore } from 'milkie'
import type { CellExecutionRecord, RunPins } from '../src/types.js'

test('子进程请求到达硬超时后终止，而不是永久等待', async () => {
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', 'process.stdin.resume()'],
    process.env,
    'hanging-worker',
  )
  await assert.rejects(
    child.receive({ timeoutMs: 30, code: 'TEST_TIMEOUT' }),
    error => error instanceof Error && 'code' in error && error.code === 'TEST_TIMEOUT',
  )
  await child.close({ type: 'close' })
})

test('caller cancellation 会终止在途子进程等待', async () => {
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', 'process.stdin.resume()'],
    process.env,
    'cancelled-worker',
  )
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    child.receive({
      timeoutMs: 2_000,
      code: 'TEST_TIMEOUT',
      stateCertainty: 'uncertain',
      signal: controller.signal,
    }),
    error =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROCESS_ABORTED' &&
      'stateCertainty' in error &&
      error.stateCertainty === 'uncertain',
  )
  await child.close({ type: 'close' })
})

test('子进程超过 RSS 硬预算后以资源错误终止', async () => {
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', 'process.stdin.resume()'],
    process.env,
    'memory-hog',
    { memoryBytes: 1 },
  )
  await assert.rejects(
    child.receive({ timeoutMs: 2_000, code: 'TEST_TIMEOUT' }),
    error =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'KERNEL_RESOURCE_EXHAUSTED',
  )
  await child.close({ type: 'close' })
})

test('preflight 校验精确容器身份、镜像、握手和任务固定版本', () => {
  const calls: string[][] = []
  const runner: CommandRunner = (file, args) => {
    calls.push([file, ...args])
    if (file === 'docker') {
      return JSON.stringify({
        running: true,
        image: 'factoriotools/factorio:2.0.73',
        label: 'true',
      })
    }
    return JSON.stringify({
      fle: '0.4.3',
      taskId: 'iron_ore_throughput',
      taskDigest: 'sha256:c50497c8548123494e48376e51ace2dd4f66717421de3a9f930d5833b6572f44',
      rconReachable: true,
    })
  }
  preflightLive(runner, { ANTHROPIC_API_KEY: 'test-key' })
  assert.equal(calls.length, 2)

  const wrongImage: CommandRunner = file =>
    file === 'docker'
      ? JSON.stringify({ running: true, image: 'factorio:latest', label: 'true' })
      : '{}'
  assert.throws(
    () => preflightLive(wrongImage, { ANTHROPIC_API_KEY: 'test-key' }),
    /image mismatch/,
  )
})

test('Trace 前置断言失败时绝不能封账 success Outcome', () => {
  const events = [
    { type: 'llm.requested' },
    { type: 'llm.responded' },
    { type: 'tool.requested' },
  ] as Event[]
  const checks = traceChecksBeforeFinalization(events, 1, 1)
  assert.equal(checks.every(check => check.passed), false)
  assert.equal(decideFinalOutcome(checks, 'verifier_succeeded'), 'failure')
  assert.equal(decideFinalOutcome([{ id: 'ok', passed: true }], 'cancelled'), 'unknown')
  assert.equal(decideFinalOutcome([{ id: 'ok', passed: true }], 'wall_budget_exhausted'), 'failure')
  assert.equal(decideFinalOutcome([{ id: 'ok', passed: true }], 'environment_failed'), 'failure')
})

test('执行器在启动进程前拒绝 stale episode revision 和错误 pins', async () => {
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
  const executor = new LiveCellExecutor(
    'run',
    'run:episode:0',
    pins,
    new MemoryTraceObjectStore(),
  )
  const stale = await executor.execute({
    cellId: 'run:cell:0',
    code: 'factorio.reset()',
    expectedKernelRevision: 0,
    expectedEpisodeRevision: 1,
    pinsDigest: 'wrong',
  })
  assert.equal(stale.status, 'error')
  assert.equal(stale.error?.code, 'STALE_EPISODE_REVISION')
  assert.equal(executor.kernelStartCount, 0)
  assert.equal(executor.bridgeStartCount, 0)
})

test('真实形态 Observation preview 的 canonical JSON 永不超过 8 KiB', () => {
  const preview = boundedObservation({
    raw_text: 'x'.repeat(100_000),
    entities: Array.from({ length: 100 }, (_, index) => ({
      name: `entity-${index}`,
      inventory: 'ore='.repeat(10_000),
      nested: { noise: 'z'.repeat(100_000) },
    })),
    inventory: Array.from({ length: 100 }, () => ({ type: 'ore', value: 'y'.repeat(10_000) })),
    game_info: { tick: 60 },
    task_info: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field${index}`, 'q'.repeat(10_000)]),
    ),
    task_verification: { success: 0, meta: [] },
  })
  assert.ok(Buffer.byteLength(canonicalJson(preview), 'utf8') <= 8_192)
})

test('success gate 拒绝断裂的 stepIndex 和 State Ref 链', () => {
  const state0 = {
    hash: 'sha256:state-0', kind: 'fle.game-state' as const, schema: 'state/v1',
    mediaType: 'application/json' as const, bytes: 1, truncated: false,
  }
  const state2 = { ...state0, hash: 'sha256:state-2' }
  const observation = {
    ...state0, hash: 'sha256:observation', kind: 'fle.observation' as const,
  }
  const broken: CellExecutionRecord[] = [
    {
      schema: 'helix.cell-execution/v2', cellId: 'c0', source: '', sourceDigest: digest('reset'),
      startRevision: 0, endRevision: 1, status: 'success', stdoutPreview: '',
      stderrPreview: '', stdoutTruncated: false, stderrTruncated: false,
      namespace: [], managedObjects: [observation, state0],
      factorioEffect: {
        method: 'reset', episodeId: 'e', stepIndex: 0, commandId: 'e:command:0',
        observationRef: observation, outputStateRef: state0, actionCapabilities: [],
        observation: {}, reward: 0, terminated: false, truncated: false,
        verification: { success: false, meta: [] },
        metrics: { stepSeconds: 0, tick: 0, productionScore: 0,
          automatedProductionScore: 0, actionHadError: false },
      },
    },
    {
      schema: 'helix.cell-execution/v2', cellId: 'c1', source: '', sourceDigest: digest('step'),
      startRevision: 1, endRevision: 2, status: 'success', stdoutPreview: '',
      stderrPreview: '', stdoutTruncated: false, stderrTruncated: false,
      namespace: [], managedObjects: [observation, state2],
      factorioEffect: {
        method: 'step', episodeId: 'e', stepIndex: 2, commandId: 'e:command:1',
        inputStateRef: { ...state0, hash: 'sha256:wrong' }, observationRef: observation,
        outputStateRef: state2, actionCapabilities: [], observation: {}, reward: 0,
        terminated: false, truncated: false, verification: { success: false, meta: [] },
        metrics: { stepSeconds: 1, tick: 60, productionScore: 0,
          automatedProductionScore: 0, actionHadError: false },
      },
    },
  ]
  assert.equal(episodeContinuityCheck(broken).passed, false)
})
