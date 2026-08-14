import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  IIOPort,
  LLMInvocationOptions,
  ToolInvocationOptions,
} from 'milkie/dist/runtime/IOPort.js'
import type { ModelRequest, ModelResponse } from 'milkie'
import { digest } from '../src/canonical.js'
import { runHarness } from '../src/harness.js'
import {
  assembleFactorioRun,
  createFactorioHostBundle,
} from '../src/harness-host.js'
import type {
  CellExecutionRecord,
  FactorioEffect,
  ObjectRef,
  RunPins,
} from '../src/types.js'

const basePins: RunPins = {
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

function assembleTestRun() {
  const bundle = createFactorioHostBundle()
  return assembleFactorioRun({
    bundle,
    basePins,
    baselineRef:
      basePins.harness === 'factorio-rlm/v5'
        ? bundle.legacyV5BaselineRef
        : bundle.defaultBaselineRef,
  })
}


function ref(kind: ObjectRef['kind'], hash: string): ObjectRef {
  return {
    hash,
    kind,
    schema: `${kind}/v1`,
    mediaType: kind === 'fle.action-program' ? 'text/plain' : 'application/json',
    bytes: 128,
    preview: { hiddenLargeValue: 'x'.repeat(100_000) },
    truncated: true,
  }
}

function record(
  code: string,
  cellId: string,
  revision: number,
  method: FactorioEffect['method'],
  success: boolean,
): CellExecutionRecord {
  const observationRef = ref('fle.observation', `sha256:observation-${revision}`)
  const stateRef = ref('fle.game-state', `sha256:state-${revision}`)
  const programRef = method === 'step' ? ref('fle.action-program', `sha256:program-${revision}`) : undefined
  const effect: FactorioEffect = {
    method,
    episodeId: 'run:episode:0',
    stepIndex: method === 'reset' ? 0 : revision,
    commandId: `command:${revision}`,
    ...(programRef ? { programRef } : {}),
    observationRef,
    outputStateRef: stateRef,
    actionCapabilities: ['nearest', 'place_entity'],
    observation: {
      rawText: success ? 'verifier passed' : 'throughput 2 of 16',
      entities: [{ name: 'burner-mining-drill', privateNoise: 'y'.repeat(100_000) }],
      inventory: [{ type: 'coal', quantity: '50' }],
      taskVerification: { success: success ? 1 : 0, meta: [] },
    },
    reward: success ? 16 : 2,
    terminated: success,
    truncated: false,
    verification: { success, meta: [] },
    metrics: {
      stepSeconds: 1,
      tick: revision * 60,
      productionScore: success ? 16 : 2,
      automatedProductionScore: success ? 16 : 2,
      actionHadError: false,
    },
  }
  return {
    schema: 'helix.cell-execution/v2',
    cellId,
    source: code,
    sourceDigest: digest(code),
    startRevision: revision - 1,
    endRevision: revision,
    status: 'success',
    stdoutPreview: 'z'.repeat(100_000),
    stderrPreview: '',
    stdoutTruncated: true,
    stderrTruncated: false,
    namespace: [{ name: 'factorio', type: 'FactorioBinding' }],
    managedObjects: [...(programRef ? [programRef] : []), observationRef, stateRef],
    factorioEffect: effect,
  }

}

function toolResponse(id: string, code: string): ModelResponse {
  const call = { id, name: 'execute_cell', input: { code } }
  return {
    content: [{ type: 'tool_use', ...call }],
    toolCalls: [call],
    finishReason: 'tool_use',
  }
}

class FakePort implements IIOPort {
  readonly requests: ModelRequest[] = []
  readonly llmOptions: Array<LLMInvocationOptions | undefined> = []
  readonly toolOptions: Array<ToolInvocationOptions | undefined> = []

  constructor(private readonly responses: ModelResponse[]) {}

  async invokeLLM(
    request: ModelRequest,
    options?: LLMInvocationOptions,
  ): Promise<ModelResponse> {
    this.requests.push(request)
    this.llmOptions.push(options)
    const response = this.responses.shift()
    if (!response) throw new Error('unexpected model request')
    return response
  }

  async invokeTool(
    _toolName: string,
    _input: unknown,
    execute: () => Promise<unknown>,
    opts?: ToolInvocationOptions,
  ): Promise<unknown> {
    this.toolOptions.push(opts)
    return execute()
  }

  now(): number {
    return 0
  }

  uuid(): string {
    return 'uuid'
  }
}

test('模型重试仍保留最近真实反馈，且大对象不进入模型上下文', async () => {
  const resetCode = 'factorio.reset()'
  const stepCode = 'factorio.step("print(1)")'
  const port = new FakePort([
    toolResponse('reset-call', resetCode),
    { content: [{ type: 'text', text: 'thinking only' }], toolCalls: [], finishReason: 'max_tokens' },
    toolResponse('step-call', stepCode),
  ])
  let execution = 0
  const assembled = assembleTestRun()
  const result = await runHarness({
    runId: 'run',
    episodeId: 'run:episode:0',
    pins: assembled.pins,
    port,
    budget: { deadlineAt: 10_000 },
    control: { deadlineAt: 10_000 },
    frozenHarness: assembled.frozen,
    controlPlaneText: assembled.controlPlaneText,
    controlPlaneContentHash: assembled.controlPlaneContentHash,
    execute: async input => {
      execution += 1
      return record(
        input.code,
        input.cellId,
        execution,
        execution === 1 ? 'reset' : 'step',
        execution === 2,
      )
    },
  })

  assert.equal(result.projection.verification.success, true)
  assert.equal(result.feedbackLinked, true)
  assert.equal(result.modelOwned, true)
  assert.equal(result.termination, 'verifier_succeeded')
  assert.equal(port.llmOptions.every(options => options?.control?.deadlineAt === 10_000), true)
  assert.equal(port.toolOptions.every(options => options?.control?.deadlineAt === 10_000), true)
  assert.equal(port.requests.length, 3)
  const retryContext = JSON.stringify(port.requests[2])
  assert.match(retryContext, /run:cell:0/)
  assert.match(retryContext, /throughput 2 of 16/)
  assert.match(retryContext, /remainingWallMs/)
  assert.doesNotMatch(retryContext, /hiddenLargeValue/)
  assert.ok(retryContext.length < 25_000, `retry context was ${retryContext.length} bytes`)
})

test('真正的策略越权会立即终止模型循环', async () => {
  const code = 'factorio.step("eval(1)")'
  const port = new FakePort([toolResponse('policy-call', code)])
  const assembled = assembleTestRun()
  const result = await runHarness({
    runId: 'run',
    episodeId: 'run:episode:0',
    pins: assembled.pins,
    port,
    budget: { deadlineAt: 10_000 },
    control: { deadlineAt: 10_000 },
    frozenHarness: assembled.frozen,
    controlPlaneText: assembled.controlPlaneText,
    controlPlaneContentHash: assembled.controlPlaneContentHash,
    execute: async input => ({
      schema: 'helix.cell-execution/v2',
      cellId: input.cellId,
      source: input.code,
      sourceDigest: digest(input.code),
      startRevision: 0,
      endRevision: 1,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      error: {
        code: 'CELL_EXECUTION_ERROR',
        message: 'POLICY_VIOLATION: eval is forbidden',
      },
    }),
  })

  assert.equal(port.requests.length, 1)
  assert.equal(result.projection.cells.length, 1)
  assert.equal(result.projection.verification.success, false)
  assert.equal(result.termination, 'policy_violation')
})

test('不确定环境动作立即终止模型循环且不会盲重试', async () => {
  const code = 'factorio.step("move_to(nearest(Resource.IronOre))")'
  const port = new FakePort([toolResponse('uncertain-call', code)])
  const assembled = assembleTestRun()
  const result = await runHarness({
    runId: 'run',
    episodeId: 'run:episode:0',
    pins: assembled.pins,
    port,
    budget: { deadlineAt: 10_000 },
    control: { deadlineAt: 10_000 },
    frozenHarness: assembled.frozen,
    controlPlaneText: assembled.controlPlaneText,
    controlPlaneContentHash: assembled.controlPlaneContentHash,
    execute: async input => ({
      schema: 'helix.cell-execution/v2',
      cellId: input.cellId,
      source: input.code,
      sourceDigest: digest(input.code),
      startRevision: 0,
      endRevision: 1,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      error: {
        code: 'FLE_TIMEOUT_UNCERTAIN',
        message: 'step may have executed',
        stateCertainty: 'uncertain',
      },
    }),
  })

  assert.equal(port.requests.length, 1)
  assert.equal(result.projection.cells.length, 1)
  assert.equal(result.uncertain, true)
  assert.equal(result.termination, 'uncertain_effect')
})

test('Bridge 校验错误后下一轮仍保留最近确认的 action capabilities', async () => {
  const resetCode = 'factorio.reset()'
  const rejectedCode = 'factorio.step("dir()")'
  const finalCode = 'factorio.step("print(1)")'
  const port = new FakePort([
    toolResponse('reset-call', resetCode),
    toolResponse('rejected-call', rejectedCode),
    toolResponse('final-call', finalCode),
  ])
  let execution = 0
  const assembled = assembleTestRun()
  await runHarness({
    runId: 'run',
    episodeId: 'run:episode:0',
    pins: assembled.pins,
    port,
    budget: { deadlineAt: 10_000 },
    control: { deadlineAt: 10_000 },
    frozenHarness: assembled.frozen,
    controlPlaneText: assembled.controlPlaneText,
    controlPlaneContentHash: assembled.controlPlaneContentHash,
    execute: async input => {
      execution += 1
      if (execution === 2) {
        return {
          schema: 'helix.cell-execution/v2', cellId: input.cellId,
          source: input.code,
          sourceDigest: digest(input.code), startRevision: 1, endRevision: 2,
          status: 'error', stdoutPreview: '', stderrPreview: '', stdoutTruncated: false,
          stderrTruncated: false, namespace: [], managedObjects: [],
          error: { code: 'ACTION_CALL_NOT_ALLOWED', message: "call 'dir' is not registered" },
        }
      }
      return record(
        input.code,
        input.cellId,
        execution,
        execution === 1 ? 'reset' : 'step',
        execution === 3,
      )
    },
  })

  const thirdRequest = JSON.stringify(port.requests[2])
  assert.match(thirdRequest, /factorioActionCalls/)
  assert.match(thirdRequest, /nearest/)
  assert.match(thirdRequest, /place_entity/)
})
