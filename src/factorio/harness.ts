import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import {
  IOControlError,
  type IOInvocationControl,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from 'milkie'
import { canonicalJson, digest } from './canonical.js'
import type {
  CellExecutionRecord,
  EpisodeProjection,
  RunBudget,
  RunPins,
  TaskVerification,
  TerminationReason,
} from './types.js'
import type { ExecuteCellInput } from './live-executor.js'

export const EXECUTE_CELL_TOOL = 'execute_cell'
export const MAX_CELLS = 16
export const MAX_MODEL_CALLS = 16

const SYSTEM_PROMPT = `You are the model that owns a persistent IPython execution session.
Your task is to solve the real Factorio Learning Environment task shown in the ContextEnvelope.

You have exactly one external tool: execute_cell(code). Every call runs one Python cell in the same persistent IPython namespace. You—not the harness—must write every cell and every Factorio action program.

Protocol:
1. Your first environment effect must be a cell containing factorio.reset(). Read its returned task information, inventory, positions, and verification state.
2. On later turns, use the actual prior cell result to decide the next cell. Submit at most one factorio.reset() or factorio.step(program) per cell.
3. factorio.step accepts a Python source string executed in FLE's public namespace. Resource, Prototype, Direction, Position, and BuildingBox are already defined there—NEVER add import statements inside the action string. After reset, factorioEffect.actionCapabilities is the canonical allowlist. Call only names in that list; never guess an API name. Useful signatures include nearest(Resource.IronOre), move_to(Position(...)), place_entity(Prototype.X, direction=Direction.DOWN, position=Position(...)), place_entity_next_to(Prototype.X, reference_position, Direction.DOWN), insert_item(Prototype.Coal, target_entity, quantity=50), get_entities(), pickup_entity(entity), and nearest_buildable(prototype, BuildingBox(width=..., height=...), center_position).
4. Imports in either the outer cell or action string, files, shell/process/network APIs, dynamic execution, private attributes, and raw RCON are forbidden. A policy violation terminates the run. Keep an action program below 10,000 characters.
5. Inspect errors and observations and correct your program. Continue until task_verification.success is true. Do not claim success yourself; only the environment verifier decides.

Call factorio.reset() exactly once, in the first cell. Never reset again after it succeeds.

Use execute_cell for action, not prose. Never ask the harness to provide a solution.`

export interface HarnessOptions {
  runId: string
  episodeId: string
  pins: RunPins
  port: IIOPort
  budget: RunBudget
  control: IOInvocationControl
  execute: (input: ExecuteCellInput, signal?: AbortSignal) => Promise<CellExecutionRecord>
}

export interface HarnessResult {
  projection: EpisodeProjection
  modelResponses: ModelResponse[]
  modelOwned: boolean
  feedbackLinked: boolean
  uncertain: boolean
  termination: TerminationReason
  toolCallCount: number
}

function initialProjection(runId: string, episodeId: string): EpisodeProjection {
  return {
    runId,
    episodeId,
    kernelRevision: 0,
    resetCount: 0,
    stepCount: 0,
    modelCallCount: 0,
    cells: [],
    verification: { success: false, meta: [] },
    terminated: false,
    truncated: false,
  }
}

function foldRecord(
  projection: EpisodeProjection,
  record: CellExecutionRecord,
): EpisodeProjection {
  const effect = record.factorioEffect
  return {
    ...projection,
    kernelRevision: record.endRevision,
    resetCount: projection.resetCount + (effect?.method === 'reset' ? 1 : 0),
    stepCount: projection.stepCount + (effect?.method === 'step' ? 1 : 0),
    cells: [...projection.cells, record],
    ...(effect
      ? {
          lastObservationRef: effect.observationRef,
          lastStateRef: effect.outputStateRef,
          actionCapabilities: effect.actionCapabilities,
          verification: effect.verification,
          terminated: effect.terminated,
          truncated: effect.truncated,
        }
      : {}),
  }
}

function contextEnvelope(
  projection: EpisodeProjection,
  pins: RunPins,
  remainingWallMs: number,
): Record<string, unknown> {
  const lastCell = projection.cells.at(-1)
  return {
    schema: 'helix.context/v2',
    runtime: {
      runId: projection.runId,
      episodeId: projection.episodeId,
      kernelRevision: projection.kernelRevision,
      pins,
    },
    task: {
      id: pins.taskId,
      instruction:
        'Create an automatic iron-ore factory that produces at least 16 iron-ore per 60 in-game seconds.',
      acceptance: 'task_verification.success=true',
      trajectoryLength: 64,
    },
    capabilities: {
      executeCell: {
        tool: EXECUTE_CELL_TOOL,
        persistentNamespace: true,
        maxOneEnvironmentEffect: true,
      },
      bindings: ['helix', 'factorio'],
      factorioActionCalls: projection.actionCapabilities ?? [],
    },
    episode: {
      resetCount: projection.resetCount,
      stepCount: projection.stepCount,
      verification: projection.verification,
      terminated: projection.terminated,
      truncated: projection.truncated,
      lastObservationRef: refForModel(projection.lastObservationRef),
      lastStateRef: refForModel(projection.lastStateRef),
    },
    lastCell: lastCell
      ? {
          cellId: lastCell.cellId,
          status: lastCell.status,
          sourceDigest: lastCell.sourceDigest,
          error: lastCell.error,
          observationRef: lastCell.factorioEffect?.observationRef.hash,
          stateRef: lastCell.factorioEffect?.outputStateRef.hash,
        }
      : null,
    budget: {
      remainingCells: MAX_CELLS - projection.cells.length,
      remainingEnvironmentSteps: 64 - projection.stepCount,
      remainingModelCalls: MAX_MODEL_CALLS - projection.modelCallCount,
      remainingWallMs,
    },
  }
}

function refForModel(ref: CellExecutionRecord['managedObjects'][number] | undefined) {
  if (!ref) return undefined
  return {
    hash: ref.hash,
    kind: ref.kind,
    schema: ref.schema,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    truncated: ref.truncated,
  }
}

function entityForModel(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const entity = value as Record<string, unknown>
  const fields = [
    'name',
    'prototype',
    'position',
    'direction',
    'status',
    'warnings',
    'drop_position',
    'resources',
    'fuel',
    'inventory',
  ]
  return Object.fromEntries(fields.flatMap(field => (field in entity ? [[field, entity[field]]] : [])))
}

/**
 * The trace retains the full execution record. The model sees only the bounded
 * observation and content-addressed metadata; large values remain in the
 * kernel/object store and are never echoed recursively into later prompts.
 */
function recordForModel(record: CellExecutionRecord): Record<string, unknown> {
  const effect = record.factorioEffect
  const observation = effect?.observation ?? {}
  const rawText = String(observation['rawText'] ?? '')
  const entities = Array.isArray(observation['entities'])
    ? observation['entities'].slice(0, 24).map(entityForModel)
    : []
  return {
    schema: 'helix.cell-result-for-model/v1',
    cellId: record.cellId,
    sourceDigest: record.sourceDigest,
    startRevision: record.startRevision,
    endRevision: record.endRevision,
    status: record.status,
    stdoutPreview: effect ? undefined : record.stdoutPreview.slice(0, 2_048),
    stderrPreview: record.stderrPreview.slice(0, 2_048),
    error: record.error,
    namespace: record.namespace,
    factorioEffect: effect
      ? {
          method: effect.method,
          stepIndex: effect.stepIndex,
          programRef: refForModel(effect.programRef),
          observationRef: refForModel(effect.observationRef),
          outputStateRef: refForModel(effect.outputStateRef),
          actionCapabilities: effect.actionCapabilities,
          observation: {
            rawText: rawText.slice(0, 4_096),
            rawTextTruncated:
              observation['rawTextTruncated'] === true || rawText.length > 4_096,
            entities,
            entityCount: observation['entityCount'] ?? entities.length,
            inventory: Array.isArray(observation['inventory'])
              ? observation['inventory'].slice(0, 64)
              : [],
            gameInfo: observation['gameInfo'] ?? {},
            taskInfo: observation['taskInfo'] ?? {},
            taskVerification: observation['taskVerification'] ?? {},
            score: observation['score'] ?? 0,
            automatedScore: observation['automatedScore'] ?? 0,
            characterPositions: observation['characterPositions'] ?? [],
          },
          reward: effect.reward,
          terminated: effect.terminated,
          truncated: effect.truncated,
          verification: effect.verification,
          metrics: effect.metrics,
        }
      : undefined,
  }
}

function renderEnvelope(envelope: Record<string, unknown>): string {
  return `## Helix ContextEnvelope\n\nThe JSON block is the canonical model-visible state for this decision.\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\``
}

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

function codeFromToolResponse(response: ModelResponse): { id: string; code: string } | undefined {
  if (response.toolCalls.length === 0) return undefined
  if (response.toolCalls.length !== 1) {
    throw new Error(`model returned ${response.toolCalls.length} tool calls; exactly one is allowed`)
  }
  const call = response.toolCalls[0]!
  if (call.name !== EXECUTE_CELL_TOOL) {
    throw new Error(`model called unexpected tool ${call.name}`)
  }
  if (call.invalidArguments) {
    throw new Error(`${call.invalidArguments.code}: ${call.invalidArguments.message}`)
  }
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
    throw new Error('execute_cell input must be an object')
  }
  const code = (call.input as Record<string, unknown>)['code']
  if (typeof code !== 'string' || code.trim() === '') {
    throw new Error('execute_cell.code must be a non-empty string')
  }
  return { id: call.id, code }
}

function verificationFrom(projection: EpisodeProjection): TaskVerification {
  return projection.verification ?? { success: false, meta: [] }
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  let projection = initialProjection(options.runId, options.episodeId)
  let priorExchange: Message[] = []
  let retryMessage: Message | undefined
  const modelResponses: ModelResponse[] = []
  let feedbackLinked = true
  let modelOwned = true
  let uncertain = false
  let toolCallCount = 0

  const finish = (termination: TerminationReason): HarnessResult => ({
    projection,
    modelResponses,
    modelOwned,
    feedbackLinked,
    uncertain,
    termination,
    toolCallCount,
  })

  for (let modelOrdinal = 0; modelOrdinal < MAX_MODEL_CALLS; modelOrdinal += 1) {
    const remainingWallMs = Math.max(0, options.budget.deadlineAt - options.port.now())
    const envelope = contextEnvelope(projection, options.pins, remainingWallMs)
    const envelopeText = renderEnvelope(envelope)
    const messages = [
      ...priorExchange,
      ...(retryMessage ? [retryMessage] : []),
      textMessage('user', envelopeText),
    ]
    if (projection.cells.length > 0) {
      const priorCellId = projection.cells.at(-1)!.cellId
      feedbackLinked =
        feedbackLinked &&
        messages.some(
          message =>
            message.role === 'tool' &&
            message.content.some(
              content =>
                content.type === 'tool_result' && content.content.includes(priorCellId),
            ),
        )
    }

    const request: ModelRequest = {
      model: options.pins.model,
      system: SYSTEM_PROMPT,
      messages: [...messages],
      tools: [
        {
          name: EXECUTE_CELL_TOOL,
          description: 'Execute one Python cell in the persistent Helix IPython session.',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'The complete Python source for the next persistent cell.',
              },
            },
            required: ['code'],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { type: 'any' },
      temperature: 0,
      maxTokens: 8_096,
      metadata: {
        runId: options.runId,
        renderer: options.pins.renderer,
        contextEnvelopeDigest: digest(envelope),
        pinsDigest: digest(options.pins),
        modelOrdinal,
      },
    }
    let response: ModelResponse
    try {
      response = await options.port.invokeLLM(request, { control: options.control })
    } catch (error) {
      projection = { ...projection, modelCallCount: projection.modelCallCount + 1 }
      if (error instanceof IOControlError) {
        return finish(error.code === 'IO_CANCELLED' ? 'cancelled' : 'wall_budget_exhausted')
      }
      throw error
    }
    modelResponses.push(response)
    projection = { ...projection, modelCallCount: projection.modelCallCount + 1 }

    const authored = codeFromToolResponse(response)
    if (!authored) {
      retryMessage = textMessage(
        'user',
        'The previous response submitted no cell. Call execute_cell now; prose does not change the environment.',
      )
      continue
    }
    retryMessage = undefined
    const cellInput: ExecuteCellInput = {
      cellId: `${options.runId}:cell:${projection.cells.length}`,
      code: authored.code,
      expectedKernelRevision: projection.kernelRevision,
      expectedEpisodeRevision: projection.resetCount + projection.stepCount,
      pinsDigest: digest(options.pins),
    }
    let output: unknown
    toolCallCount += 1
    try {
      output = await options.port.invokeTool(
        'helix.kernel.execute_cell',
        cellInput,
        signal => options.execute(cellInput, signal),
        { toolCallId: authored.id, control: options.control },
      )
    } catch (error) {
      if (error instanceof IOControlError) {
        uncertain = error.code === 'IO_DEADLINE_EXCEEDED'
        return finish(error.code === 'IO_CANCELLED' ? 'cancelled' : 'uncertain_effect')
      }
      throw error
    }
    const record = output as CellExecutionRecord
    modelOwned =
      modelOwned &&
      record.cellId === cellInput.cellId &&
      record.sourceDigest === digest(authored.code)
    projection = foldRecord(projection, record)
    uncertain = uncertain || record.error?.stateCertainty === 'uncertain'
    priorExchange = [
      { role: 'assistant', content: response.content },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            tool_use_id: authored.id,
            content: canonicalJson(recordForModel(record)),
            is_error: record.status === 'error',
          },
        ],
      },
    ]

    if (`${record.error?.code ?? ''} ${record.error?.message ?? ''}`.includes('POLICY_VIOLATION')) {
      return finish('policy_violation')
    }
    if (record.error?.stateCertainty === 'uncertain') return finish('uncertain_effect')
    if (
      record.error?.code === 'KERNEL_TIMEOUT' ||
      record.error?.code === 'KERNEL_RESOURCE_EXHAUSTED'
    ) {
      return finish('kernel_resource_exhausted')
    }
    if (verificationFrom(projection).success) return finish('verifier_succeeded')
    if (projection.truncated) return finish('cell_budget_exhausted')
    if (projection.terminated) return finish('environment_failed')
    if (projection.cells.length >= MAX_CELLS) return finish('cell_budget_exhausted')
  }

  return finish('model_budget_exhausted')
}
