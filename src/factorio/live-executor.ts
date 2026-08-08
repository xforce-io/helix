import path from 'node:path'
import type { ITraceObjectStore } from 'milkie'
import { byteLength, canonicalJson, digest } from './canonical.js'
import { JsonLineProcess } from './line-process.js'
import type {
  CellExecutionRecord,
  FactorioEffect,
  ObjectRef,
  RunPins,
  TaskVerification,
} from './types.js'

interface ExecuteCellInput {
  cellId: string
  code: string
  expectedKernelRevision: number
  expectedEpisodeRevision: number
  pinsDigest: string
}

interface BridgeResult {
  observation: Record<string, unknown>
  stateRaw: string
  reward: number
  terminated: boolean
  truncated: boolean
  stepSeconds: number
  verification: TaskVerification
  info: Record<string, unknown>
  actionCapabilities: string[]
}

const FLE_STEP_TIMEOUT_MS = 120_000
const KERNEL_CELL_TIMEOUT_MS = 130_000

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'PORT_OFFSET', 'FLE_STATE_DIR'] as const
  const env: NodeJS.ProcessEnv = {
    PYTHONUNBUFFERED: '1',
    HELIX_KERNEL_MEMORY_BYTES: '1073741824',
    HELIX_KERNEL_CPU_SECONDS: '600',
  }
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, 512)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 2) return String(value).slice(0, 512)
  if (Array.isArray(value)) return value.slice(0, 16).map(item => boundedValue(item, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 24)
      .map(([key, item]) => [key, boundedValue(item, depth + 1)]),
  )
}

export function boundedObservation(
  observation: Record<string, unknown>,
): Record<string, unknown> {
  const rawText = String(observation['raw_text'] ?? '')
  const entities = Array.isArray(observation['entities'])
    ? observation['entities'].slice(0, 24).map(item => boundedValue(item))
    : []
  const inventory = Array.isArray(observation['inventory'])
    ? observation['inventory'].slice(0, 64).map(item => boundedValue(item))
    : []
  const gameInfo = asRecord(observation['game_info'])
  const taskInfo = asRecord(observation['task_info'])
  const taskVerification = asRecord(observation['task_verification'])
  const verificationMeta = Array.isArray(taskVerification['meta'])
    ? taskVerification['meta'].slice(0, 8).map(item => {
        const entry = asRecord(item)
        return {
          key: String(entry['key'] ?? '').slice(0, 256),
          value: String(entry['value'] ?? '').slice(0, 256),
        }
      })
    : []
  const preview: Record<string, unknown> = {
    rawText: rawText.slice(0, 4_096),
    rawTextTruncated: rawText.length > 4_096,
    entities,
    entityCount: Array.isArray(observation['entities']) ? observation['entities'].length : 0,
    inventory,
    gameInfo: {
      tick: gameInfo['tick'] ?? 0,
      time: gameInfo['time'] ?? 0,
      speed: gameInfo['speed'] ?? 0,
    },
    taskInfo: {
      goal_description: String(taskInfo['goal_description'] ?? '').slice(0, 1_024),
      agent_instructions: String(taskInfo['agent_instructions'] ?? '').slice(0, 512),
      task_key: String(taskInfo['task_key'] ?? '').slice(0, 256),
      trajectory_length: taskInfo['trajectory_length'] ?? 0,
    },
    taskVerification: {
      success: taskVerification['success'] ?? false,
      meta: verificationMeta,
    },
    score: observation['score'] ?? 0,
    automatedScore: observation['automated_score'] ?? 0,
    characterPositions: Array.isArray(observation['character_positions'])
      ? observation['character_positions'].slice(0, 4).map(item => boundedValue(item))
      : [],
  }
  while (byteLength(canonicalJson(preview)) > 8_192) {
    if (entities.length > 0) entities.pop()
    else if (inventory.length > 0) inventory.pop()
    else {
      const current = String(preview['rawText'] ?? '')
      if (current.length === 0) break
      preview['rawText'] = current.slice(0, Math.floor(current.length / 2))
      preview['rawTextTruncated'] = true
    }
  }
  return preview
}

async function putJsonObject(
  store: ITraceObjectStore,
  value: unknown,
  kind: ObjectRef['kind'],
  schema: string,
  preview?: unknown,
): Promise<ObjectRef> {
  const canonical = canonicalJson(value)
  const hash = await store.putCanonical(canonical)
  return {
    hash,
    kind,
    schema,
    mediaType: 'application/json',
    bytes: byteLength(canonical),
    ...(preview === undefined ? {} : { preview }),
    truncated: preview !== undefined && canonicalJson(preview) !== canonical,
  }
}

async function putTextObject(
  store: ITraceObjectStore,
  value: string,
  kind: ObjectRef['kind'],
  schema: string,
): Promise<ObjectRef> {
  const hash = await store.putCanonical(value)
  return {
    hash,
    kind,
    schema,
    mediaType: 'text/plain',
    bytes: byteLength(value),
    preview: value.slice(0, 2_048),
    truncated: value.length > 2_048,
  }
}

export class LiveCellExecutor {
  private kernel: JsonLineProcess | undefined
  private bridge: JsonLineProcess | undefined
  private bridgeOrdinal = 0
  private stateRaw: string | undefined
  private stateRef: ObjectRef | undefined
  private resetCount = 0
  private stepCount = 0

  kernelStartCount = 0
  bridgeStartCount = 0
  effectCount = 0

  constructor(
    private readonly runId: string,
    private readonly episodeId: string,
    private readonly pins: RunPins,
    private readonly objectStore: ITraceObjectStore,
  ) {}

  private pythonExecutable(): string {
    return (
      process.env['HELIX_FACTORIO_PYTHON'] ??
      path.resolve('examples/factorio/.venv/bin/python')
    )
  }

  private ensureKernel(): JsonLineProcess {
    if (!this.kernel) {
      this.kernel = new JsonLineProcess(
        this.pythonExecutable(),
        [path.resolve('examples/factorio/workers/kernel_worker.py')],
        workerEnvironment(),
        'kernel-worker',
        { memoryBytes: this.pins.kernelMemoryBytes },
      )
      this.kernelStartCount += 1
    }
    return this.kernel
  }

  private ensureBridge(): JsonLineProcess {
    if (!this.bridge) {
      this.bridge = new JsonLineProcess(
        this.pythonExecutable(),
        [path.resolve('examples/factorio/workers/bridge_worker.py')],
        workerEnvironment(),
        'factorio-bridge',
      )
      this.bridgeStartCount += 1
    }
    return this.bridge
  }

  private async bridgeRequest(
    method: 'reset' | 'step',
    commandId: string,
    params: Record<string, unknown>,
  ): Promise<BridgeResult> {
    const bridge = this.ensureBridge()
    const id = `${this.runId}:bridge:${this.bridgeOrdinal++}`
    bridge.send({ protocolVersion: '2', id, commandId, method, params })
    const response = await bridge.receive({
      timeoutMs: FLE_STEP_TIMEOUT_MS,
      code: method === 'step' ? 'FLE_TIMEOUT_UNCERTAIN' : 'FLE_RESET_TIMEOUT',
      stateCertainty: method === 'step' ? 'uncertain' : 'unchanged',
    })
    if (response['id'] !== id) throw new Error(`bridge response id mismatch for ${id}`)
    if (response['ok'] !== true) {
      const error = asRecord(response['error'])
      throw Object.assign(new Error(String(error['message'] ?? 'FLE bridge failed')), {
        code: String(error['code'] ?? 'FLE_EXECUTION_ERROR'),
        stateCertainty:
          error['stateCertainty'] === 'uncertain'
            ? ('uncertain' as const)
            : error['stateCertainty'] === 'confirmed'
              ? ('confirmed' as const)
              : ('unchanged' as const),
      })
    }
    return response['result'] as unknown as BridgeResult
  }

  private async handleEffect(
    frame: Record<string, unknown>,
  ): Promise<{ result: Record<string, unknown>; effect: FactorioEffect }> {
    const method = frame['method']
    if (method !== 'reset' && method !== 'step') {
      throw Object.assign(new Error(`unknown Factorio effect: ${String(method)}`), {
        code: 'UNKNOWN_EFFECT',
      })
    }
    if (method === 'reset' && this.resetCount !== 0) {
      throw Object.assign(new Error('factorio.reset() may succeed only once per run'), {
        code: 'DUPLICATE_RESET',
      })
    }
    if (method === 'step' && this.resetCount !== 1) {
      throw Object.assign(new Error('call factorio.reset() before factorio.step()'), {
        code: 'EPISODE_NOT_RESET',
      })
    }
    const params = asRecord(frame['params'])
    const program = method === 'step' ? String(params['program'] ?? '') : undefined
    const inputStateRef = this.stateRef
    const stepIndex = method === 'reset' ? 0 : this.stepCount + 1
    const commandId = `${this.episodeId}:${stepIndex}`
    const bridgeResult = await this.bridgeRequest(method, commandId, {
      ...(program === undefined ? {} : { program }),
      ...(method === 'step' && this.stateRaw !== undefined
        ? { stateRaw: this.stateRaw }
        : {}),
    })
    this.effectCount += 1

    const preview = boundedObservation(bridgeResult.observation)
    const observationRef = await putJsonObject(
      this.objectStore,
      bridgeResult.observation,
      'fle.observation',
      'fle.observation/v1',
      preview,
    )
    let parsedState: unknown = bridgeResult.stateRaw
    try {
      parsedState = JSON.parse(bridgeResult.stateRaw)
    } catch {
      // FLE owns the state codec; an opaque string is still content-addressed.
    }
    const outputStateRef = await putJsonObject(
      this.objectStore,
      parsedState,
      'fle.game-state',
      'fle.game-state/v1',
    )
    const programRef =
      program === undefined
        ? undefined
        : await putTextObject(
            this.objectStore,
            program,
            'fle.action-program',
            'fle.action-program/v1',
          )
    this.stateRaw = bridgeResult.stateRaw
    this.stateRef = outputStateRef
    if (method === 'reset') this.resetCount += 1
    else this.stepCount += 1
    const info = asRecord(bridgeResult.info)
    const gameInfo = asRecord(bridgeResult.observation['game_info'])
    const effect: FactorioEffect = {
      method,
      episodeId: this.episodeId,
      stepIndex,
      commandId,
      ...(programRef === undefined ? {} : { programRef }),
      ...(inputStateRef === undefined ? {} : { inputStateRef }),
      observationRef,
      outputStateRef,
      actionCapabilities: bridgeResult.actionCapabilities,
      observation: preview,
      reward: numeric(bridgeResult.reward),
      terminated: bridgeResult.terminated === true,
      truncated: bridgeResult.truncated === true,
      verification: bridgeResult.verification,
      metrics: {
        stepSeconds: numeric(bridgeResult.stepSeconds),
        tick: numeric(gameInfo['tick']),
        productionScore: numeric(info['production_score']),
        automatedProductionScore: numeric(info['automated_production_score']),
        actionHadError: info['error_occurred'] === true,
      },
    }
    return {
      effect,
      result: {
        observation: preview,
        refs: { observation: observationRef, state: outputStateRef },
        metrics: {
          reward: effect.reward,
          terminated: effect.terminated,
          truncated: effect.truncated,
          verification: effect.verification,
          ...effect.metrics,
        },
      },
    }
  }

  async execute(input: ExecuteCellInput): Promise<CellExecutionRecord> {
    const contractError = (code: string, message: string): CellExecutionRecord => ({
      schema: 'helix.cell-execution/v1',
      cellId: input.cellId,
      sourceDigest: digest(input.code),
      startRevision: input.expectedKernelRevision,
      endRevision: input.expectedKernelRevision,
      status: 'error',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      error: { code, message, stateCertainty: 'unchanged' },
    })
    const episodeRevision = this.resetCount + this.stepCount
    if (input.expectedEpisodeRevision !== episodeRevision) {
      return contractError(
        'STALE_EPISODE_REVISION',
        `expected episode revision ${input.expectedEpisodeRevision}, current ${episodeRevision}`,
      )
    }
    if (input.pinsDigest !== digest(this.pins)) {
      return contractError('PINS_DIGEST_MISMATCH', 'execute_cell pins do not match this run')
    }
    const kernel = this.ensureKernel()
    kernel.send({
      protocolVersion: '2',
      type: 'execute',
      code: input.code,
      expectedRevision: input.expectedKernelRevision,
      bootstrap: {
        task: {
          id: this.pins.taskId,
          acceptance: 'task_verification.success=true',
        },
        runtime: {
          runId: this.runId,
          episodeId: this.episodeId,
          pins: this.pins,
        },
      },
    })
    let factorioEffect: FactorioEffect | undefined
    let effectError:
      | (Error & {
          code?: string
          stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
        })
      | undefined
    for (;;) {
      let frame: Record<string, unknown>
      try {
        frame = await kernel.receive({
          timeoutMs: KERNEL_CELL_TIMEOUT_MS,
          code: 'KERNEL_TIMEOUT',
          stateCertainty: factorioEffect ? 'confirmed' : 'unchanged',
        })
      } catch (error) {
        const structured = error as Error & {
          code?: string
          stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
        }
        return {
          schema: 'helix.cell-execution/v1',
          cellId: input.cellId,
          sourceDigest: digest(input.code),
          startRevision: input.expectedKernelRevision,
          endRevision: input.expectedKernelRevision,
          status: 'error',
          stdoutPreview: '',
          stderrPreview: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          namespace: [],
          managedObjects: factorioEffect
            ? [
                ...(factorioEffect.programRef ? [factorioEffect.programRef] : []),
                factorioEffect.observationRef,
                factorioEffect.outputStateRef,
              ]
            : [],
          ...(factorioEffect === undefined ? {} : { factorioEffect }),
          error: {
            code: structured.code ?? 'KERNEL_RESOURCE_EXHAUSTED',
            message: structured.message,
            stateCertainty:
              factorioEffect === undefined
                ? (structured.stateCertainty ?? 'unchanged')
                : 'confirmed',
          },
        }
      }
      if (frame['type'] === 'effect_request') {
        try {
          const handled = await this.handleEffect(frame)
          factorioEffect = handled.effect
          kernel.send({ type: 'effect_response', ok: true, result: handled.result })
        } catch (error) {
          const structured = error as Error & {
            code?: string
            stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
          }
          effectError = structured
          kernel.send({
            type: 'effect_response',
            ok: false,
            error: {
              code: structured.code ?? 'FLE_EXECUTION_ERROR',
              message: structured.message,
              stateCertainty: structured.stateCertainty ?? 'unchanged',
            },
          })
        }
        continue
      }
      if (frame['type'] !== 'execute_result') {
        throw new Error(`unexpected kernel frame: ${JSON.stringify(frame).slice(0, 500)}`)
      }
      const error = asRecord(frame['error'])
      const record: CellExecutionRecord = {
        schema: 'helix.cell-execution/v1',
        cellId: input.cellId,
        sourceDigest: digest(input.code),
        startRevision: numeric(frame['startRevision']),
        endRevision: numeric(frame['endRevision']),
        status: frame['ok'] === true ? 'success' : 'error',
        stdoutPreview: String(frame['stdout'] ?? ''),
        stderrPreview: String(frame['stderr'] ?? ''),
        stdoutTruncated: frame['stdoutTruncated'] === true,
        stderrTruncated: frame['stderrTruncated'] === true,
        namespace: Array.isArray(frame['namespace'])
          ? (frame['namespace'] as CellExecutionRecord['namespace'])
          : [],
        managedObjects: factorioEffect
          ? [
              ...(factorioEffect.programRef ? [factorioEffect.programRef] : []),
              factorioEffect.observationRef,
              factorioEffect.outputStateRef,
            ]
          : [],
        ...(factorioEffect === undefined ? {} : { factorioEffect }),
        ...(frame['ok'] === true && effectError === undefined
          ? {}
          : {
              error: {
                code: effectError?.code ?? String(error['code'] ?? 'CELL_EXECUTION_ERROR'),
                ...(error['type'] === undefined ? {} : { type: String(error['type']) }),
                message: effectError?.message ?? String(error['message'] ?? 'cell execution failed'),
                stateCertainty: effectError?.stateCertainty ?? 'unchanged',
              },
            }),
      }
      return record
    }
  }

  async close(): Promise<void> {
    await this.kernel?.close({ type: 'close', protocolVersion: '2' })
    await this.bridge?.close({
      protocolVersion: '2',
      id: `${this.runId}:bridge:close`,
      method: 'close',
      params: {},
    })
  }
}

export type { ExecuteCellInput }
