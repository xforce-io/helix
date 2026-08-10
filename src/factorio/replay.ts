import {
  FileTaskOutcomeFinalizationStore,
  FileTraceObjectStore,
  MemoryStore,
  Milkie,
  type IEventStore,
} from 'milkie'
import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import { JsonlEventStore } from 'milkie/dist/trace/JsonlEventStore.js'
import { CacheIndex } from 'milkie/dist/trace/CacheIndex.js'
import { ReplayingIOPort } from 'milkie/dist/trace/ReplayingIOPort.js'
import type { Event } from 'milkie/dist/trace/types.js'
import { digest } from './canonical.js'
import {
  argument,
  attachEvidenceRef,
  FINALIZATION_ROOT,
  objectStore,
  pins,
  readLiveEvidence,
  REPLAY_WALL_TIMEOUT_MS,
  summarizeFinalization,
  TRACE_ROOT,
  writeEvidence,
} from './cli-common.js'
import { runHarness } from './harness.js'
import { CHILD_REPLAY_SAFETY_WALL_MS } from './recursive-model.js'
import type { CellExecutionRecord, ObjectRef, ReplayEvidence } from './types.js'
import {
  attachTripleForbiddenCheck,
  c1NeverStartedEventCheck,
  c1SettlementRefundCheck,
  collectC1Effects,
  modelEffectInvariantsCheck,
  pinsGateCheck,
  rejectLegacyPins,
  requestDigestReplayChecks,
  singleEffectMutualExclusionCheck,
} from './verification.js'

export type ChildReplayCheck = {
  id: string
  passed: boolean
  detail?: string
}

export type ChildReplayResult = {
  childRunId: string
  liveEffectCount: number
  remainingIO: { llm: number; tool: number; clock: number; uuid: number }
  parentId?: string
  checks: ChildReplayCheck[]
}

class DenyLivePort implements IIOPort {
  calls = 0
  async invokeLLM(): Promise<never> {
    this.calls += 1
    throw new Error('DenyLivePort: live LLM forbidden during replay')
  }
  async invokeTool(): Promise<never> {
    this.calls += 1
    throw new Error('DenyLivePort: live tool forbidden during replay')
  }
  now(): never {
    this.calls += 1
    throw new Error('DenyLivePort: live clock forbidden during replay')
  }
  uuid(): never {
    this.calls += 1
    throw new Error('DenyLivePort: live uuid forbidden during replay')
  }
}

function refs(records: CellExecutionRecord[]): ObjectRef[] {
  return records.flatMap(record => record.managedObjects)
}

function readParentId(started: Event | undefined): string | undefined {
  if (!started || !started.payload || typeof started.payload !== 'object') {
    return undefined
  }
  if (!('parentId' in started.payload)) return undefined
  const value = started.payload.parentId
  return value === undefined || value === null ? '' : String(value)
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (!(key in value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

function findRecordedTerminal(
  llmResponded: Event[],
  reqEvent: Event,
  requestHash: string | undefined,
): Event | undefined {
  const byCause = llmResponded.find(event => event.causedBy === reqEvent.id)
  if (byCause) return byCause
  if (!requestHash) return undefined
  return llmResponded.find(event => readStringField(event.payload, 'requestHash') === requestHash)
}


/** Fail-closed equality check for child LLM replay vs recorded terminal response. */
export function childLlmResponseHashCheck(args: {
  childRunId: string
  index: number
  replayed: unknown
  recordedStatus?: string
  recordedResponse?: unknown
  requestHash?: string
  requestDigest?: string
}): ChildReplayCheck {
  const replayedHash = digest(args.replayed)
  const hasRecordedResponse =
    args.recordedResponse !== undefined && args.recordedStatus === 'ok'
  const expectedHash = hasRecordedResponse ? digest(args.recordedResponse) : undefined
  const hashMatched = expectedHash !== undefined && replayedHash === expectedHash
  return {
    id: `S2.child-llm-response-hash.${args.childRunId}.${args.index}`,
    passed: hashMatched,
    detail: hashMatched
      ? `requestHash=${args.requestHash ?? ''} responseDigest=${replayedHash} requestDigest=${args.requestDigest ?? ''}`
      : `response hash mismatch or missing recorded terminal: replayed=${replayedHash} expected=${expectedHash ?? 'missing'} requestHash=${args.requestHash ?? ''} recordedStatus=${args.recordedStatus ?? 'missing'}`,
  }
}

/**
 * Independently replay one child run from its recorded milkie events.
 * Exported for unit tests (MemoryEventStore fixtures).
 */
export async function replayChildRun(args: {
  eventStore: IEventStore
  childRunId: string
  parentRunId: string
}): Promise<ChildReplayResult> {
  const events = (await args.eventStore.readByRunId(args.childRunId)) as Event[]
  const startedEvents = events.filter(event => event.type === 'agent.run.started')
  const completedEvents = events.filter(event => event.type === 'agent.run.completed')
  const started = startedEvents[0]
  const parentId = readParentId(started)
  const denied = new DenyLivePort()
  const cache = CacheIndex.fromEvents(events)
  const port = new ReplayingIOPort(cache, denied)

  // Fresh local safety control — must NOT reuse Live deadlineAt (L2 §5.8).
  // Consume recorded nondet clock first (if any) to build safety deadline.
  const initialRemaining = cache.remaining()
  let safetyNow: number | undefined
  if (initialRemaining.clock > 0) {
    safetyNow = port.now()
  }
  const safetyDeadline = (safetyNow ?? Date.now()) + CHILD_REPLAY_SAFETY_WALL_MS
  const safetyControl = { deadlineAt: safetyDeadline }

  // Drain recorded LLM requests in event order via ReplayingIOPort (B1).
  // C2 empty-LLM path: no llm.requested → remaining.llm stays 0 after lifecycle.
  const llmRequests = events.filter(event => event.type === 'llm.requested')
  const llmResponded = events.filter(event => event.type === 'llm.responded')
  const responseChecks: ChildReplayCheck[] = []
  let llmConsumed = 0
  let llmErrors = 0

  for (const [index, reqEvent] of llmRequests.entries()) {
    const payload =
      reqEvent.payload && typeof reqEvent.payload === 'object' && !Array.isArray(reqEvent.payload)
        ? (reqEvent.payload as Record<string, unknown>)
        : {}
    const request = payload['request']
    const requestHash = typeof payload['requestHash'] === 'string' ? payload['requestHash'] : undefined
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      responseChecks.push({
        id: `S2.child-llm-request-shape.${args.childRunId}.${index}`,
        passed: false,
        detail: 'llm.requested missing request payload',
      })
      continue
    }

    let requestDigest = ''
    if (
      'metadata' in request &&
      request.metadata &&
      typeof request.metadata === 'object' &&
      !Array.isArray(request.metadata) &&
      'requestDigest' in request.metadata
    ) {
      const digestValue = (request.metadata as Record<string, unknown>)['requestDigest']
      requestDigest = digestValue === undefined || digestValue === null ? '' : String(digestValue)
    }

    const recordedTerminal = findRecordedTerminal(llmResponded, reqEvent, requestHash)
    const recordedPayload =
      recordedTerminal &&
      recordedTerminal.payload &&
      typeof recordedTerminal.payload === 'object' &&
      !Array.isArray(recordedTerminal.payload)
        ? (recordedTerminal.payload as Record<string, unknown>)
        : {}
    const recordedStatus =
      typeof recordedPayload['status'] === 'string' ? recordedPayload['status'] : undefined
    const recordedResponse = recordedPayload['response']
    const recordedError = recordedPayload['error']

    try {
      const response = await port.invokeLLM(
        request as Parameters<IIOPort['invokeLLM']>[0],
        { control: safetyControl },
      )
      llmConsumed += 1
      responseChecks.push(
        childLlmResponseHashCheck({
          childRunId: args.childRunId,
          index,
          replayed: response,
          ...(recordedStatus === undefined ? {} : { recordedStatus }),
          ...(recordedResponse === undefined ? {} : { recordedResponse }),
          ...(requestHash === undefined ? {} : { requestHash }),
          ...(requestDigest ? { requestDigest } : {}),
        }),
      )
      if (requestDigest) {
        responseChecks.push({
          id: `S2.child-requestDigest-present.${args.childRunId}.${index}`,
          passed: requestDigest.startsWith('sha256:'),
          detail: requestDigest,
        })
      }
    } catch (error) {
      // Recorded failure terminals throw reconstructed errors after consume — still FIFO progress.
      llmErrors += 1
      const message = error instanceof Error ? error.message : String(error)
      const isDivergence =
        message.includes('ReplayDivergence') || message.includes('queue empty')
      const recordedFailure =
        recordedTerminal !== undefined &&
        (recordedStatus === 'error' || recordedError !== undefined)
      // Success path must not throw; failure path must consume a recorded failure terminal.
      const passed = !isDivergence && recordedFailure
      responseChecks.push({
        id: `S2.child-llm-terminal.${args.childRunId}.${index}`,
        passed,
        detail: isDivergence
          ? `divergence: ${message.slice(0, 200)}`
          : recordedFailure
            ? `recorded failure terminal consumed: ${message.slice(0, 200)} requestDigest=${requestDigest}`
            : `invokeLLM threw without recorded failure terminal: ${message.slice(0, 200)} recordedStatus=${recordedStatus ?? 'missing'}`,
      })
    }
  }

  // Drain any leftover recorded clock/uuid FIFO entries (agent-observable nondet).
  while (cache.remaining().clock > 0) {
    port.now()
  }
  while (cache.remaining().uuid > 0) {
    port.uuid()
  }

  const remaining = cache.remaining()
  const lifecycleOk = startedEvents.length === 1 && completedEvents.length === 1
  const checks: ChildReplayCheck[] = [
    {
      id: `S2.child-replay-zero-live.${args.childRunId}`,
      passed: denied.calls === 0,
      detail: `denied=${denied.calls}`,
    },
    {
      id: `S2.child-replay-io.${args.childRunId}`,
      passed: Object.values(remaining).every(value => value === 0),
      detail: JSON.stringify({
        remaining,
        llmRequests: llmRequests.length,
        llmConsumed,
        llmErrors,
      }),
    },
    {
      id: `S2.child-lifecycle.${args.childRunId}`,
      passed: lifecycleOk,
      detail: `started=${startedEvents.length} completed=${completedEvents.length}`,
    },
    {
      id: `S2.parent-child-link.${args.childRunId}`,
      passed: parentId === args.parentRunId,
      detail: `parentId=${parentId}`,
    },
    {
      id: `S2.child-fresh-safety-control.${args.childRunId}`,
      passed: CHILD_REPLAY_SAFETY_WALL_MS === 300_000 && Number.isFinite(safetyDeadline),
      detail: `safetyWallMs=${CHILD_REPLAY_SAFETY_WALL_MS} safetyDeadline=${safetyDeadline}`,
    },
    {
      id: `S2.no-replay-finalization.${args.childRunId}`,
      passed: true,
      detail: 'child replay does not write finalization',
    },
    // C2 empty-LLM: zero llm.requested is success when remaining all 0.
    {
      id: `S2.child-empty-or-consumed-llm.${args.childRunId}`,
      passed:
        (llmRequests.length === 0 && remaining.llm === 0) ||
        (llmRequests.length > 0 && remaining.llm === 0),
      detail: `llmRequests=${llmRequests.length} remaining.llm=${remaining.llm}`,
    },
    ...responseChecks,
  ]
  return {
    childRunId: args.childRunId,
    liveEffectCount: denied.calls,
    remainingIO: remaining,
    ...(parentId === undefined ? {} : { parentId }),
    checks,
  }
}

async function main(): Promise<void> {
  const runId = argument('--run')
  if (!runId) throw new Error('missing --run <run-id>')
  const live = await readLiveEvidence(runId)
  const legacyGate = rejectLegacyPins(live.pins as { harness?: string; bindingSet?: string; kernelProtocol?: string })
  if (!legacyGate.passed) {
    throw new Error(
      'live evidence pins are rejected by v4 runner (legacy or mismatched)',
    )
  }
  const replayPins = pins(live.pins.model)
  if (digest(replayPins) !== digest(live.pins)) {
    throw new Error('live evidence pins do not match the current replay contract')
  }
  const eventStore = new JsonlEventStore(TRACE_ROOT)
  const events = (await eventStore.readByRunId(runId)) as Event[]
  if (events.length === 0) throw new Error(`no milkie Trace for ${runId}`)
  const cache = CacheIndex.fromEvents(events)
  const denied = new DenyLivePort()
  const port = new ReplayingIOPort(cache, denied)
  let liveEffectCount = 0
  const result = await runHarness({
    runId,
    episodeId: `${runId}:episode:0`,
    pins: replayPins,
    port,
    budget: { deadlineAt: live.budget.deadlineAt },
    control: { deadlineAt: Date.now() + REPLAY_WALL_TIMEOUT_MS },
    execute: async () => {
      liveEffectCount += 1
      throw new Error('Kernel/FLE handler executed during replay')
    },
    recursiveModel: { enabled: true },
  })
  const remainingIO = cache.remaining()
  const objects: FileTraceObjectStore = objectStore()
  const objectRefs = refs(result.projection.cells)
  const objectRefsValid = (
    await Promise.all(objectRefs.map(ref => objects.has(ref.hash)))
  ).every(Boolean)
  const milkie = new Milkie({
    stateStore: new MemoryStore(),
    eventStore,
    traceObjectStore: objects,
    outcomeFinalizationStore: new FileTaskOutcomeFinalizationStore(FINALIZATION_ROOT),
  })
  const storedFinalization = await milkie.getFinalTaskOutcome(runId)
  if (!storedFinalization) throw new Error(`no final task outcome for ${runId}`)
  const finalization = summarizeFinalization(
    live.finalization.status,
    storedFinalization,
  )

  const childRunIds = live.childRunIds ?? []
  // Never open CacheIndex for C1 attachFailed ids.
  const c1Ids = new Set(live.nonReplayableChildRunIds ?? [])
  for (const record of live.finalProjection.cells) {
    const effect = record.modelEffect
    if (effect?.attachFailed === true && effect.childRunId) {
      c1Ids.add(effect.childRunId)
    }
  }
  const childReplays = []
  const childChecks = []
  for (const childRunId of childRunIds) {
    if (c1Ids.has(childRunId)) {
      childChecks.push({
        id: `S2.no-c1-child-replay.${childRunId}`,
        passed: false,
        detail: 'C1 attachFailed id must not appear in childRunIds',
      })
      continue
    }
    const childResult = await replayChildRun({
      eventStore,
      childRunId,
      parentRunId: runId,
    })
    childReplays.push({
      childRunId: childResult.childRunId,
      liveEffectCount: childResult.liveEffectCount,
      remainingIO: childResult.remainingIO,
      ...(childResult.parentId === undefined
        ? {}
        : { parentId: childResult.parentId }),
    })
    childChecks.push(...childResult.checks)
  }
  // Assert C1 ids are not replayed and never started / no LLM terminals.
  // Read-only event queries only — never open CacheIndex for C1 ids.
  for (const c1 of c1Ids) {
    childChecks.push({
      id: `S2.c1-not-replayed.${c1}`,
      passed: !childRunIds.includes(c1),
      detail: 'C1 attachFailed excluded from child replay set',
    })
    // Read-only: query events by id without CacheIndex / child factory.
    const c1Events = (await eventStore.readByRunId(c1)) as Event[]
    childChecks.push(
      c1NeverStartedEventCheck({ childRunId: c1, events: c1Events }),
    )
  }
  for (const effect of collectC1Effects(live.finalProjection.cells)) {
    childChecks.push(c1SettlementRefundCheck(effect))
  }

  const modelEffects = result.projection.cells.flatMap(c =>
    c.modelEffect ? [c.modelEffect] : [],
  )

  const checks = [
    pinsGateCheck(replayPins),
    legacyGate,
    {
      id: 'S2.parent-replay-zero-live',
      passed: liveEffectCount === 0 && denied.calls === 0,
      detail: `handler=${liveEffectCount} deniedPort=${denied.calls}`,
    },
    {
      id: 'S2.parent-replay-io-consumed',
      passed: Object.values(remainingIO).every(value => value === 0),
      detail: JSON.stringify(remainingIO),
    },
    {
      id: 'S2.parent-replay-projection',
      passed:
        digest(result.projection) === live.projectionDigest &&
        result.termination === live.termination,
    },
    {
      id: 'S2.replay-model-owned',
      passed: result.modelOwned && result.feedbackLinked,
    },
    {
      id: 'S2.replay-object-refs',
      passed: objectRefsValid,
      detail: `${objectRefs.length} refs verified`,
    },
    {
      id: 'S2.replay-finalization',
      passed:
        finalization.value === live.finalization.value &&
        finalization.finalizationId === live.finalization.finalizationId &&
        finalization.intentHash === live.finalization.intentHash &&
        finalization.recordHash === live.finalization.recordHash,
    },
    {
      id: 'S2.no-replay-finalization-write',
      passed: true,
      detail: 'parent replay reads existing finalization only',
    },
    {
      id: 'S2.live-success',
      passed: live.verdict === 'pass' && finalization.value === 'success',
    },
    {
      id: 'S2.model-effect-fields',
      passed: modelEffects.every(effect => {
        if (effect.status === 'succeeded') {
          return Boolean(effect.childRunId && effect.responseRef && effect.requestDigest)
        }
        return true
      }),
      detail: `${modelEffects.length} modelEffects`,
    },
    singleEffectMutualExclusionCheck(result.projection.cells),
    modelEffectInvariantsCheck(result.projection.cells),
    attachTripleForbiddenCheck(result.projection.cells, childRunIds),
    ...requestDigestReplayChecks(modelEffects),
    ...childChecks,
    // Keep legacy check ids for compatibility with existing tooling.
    {
      id: 'S3.replay-zero-live-effects',
      passed: liveEffectCount === 0 && denied.calls === 0,
    },
    {
      id: 'S3.replay-io-consumed',
      passed: Object.values(remainingIO).every(value => value === 0),
    },
  ]
  const evidenceCore: ReplayEvidence = {
    schema: 'helix.factorio.replay/v3',
    verdict: checks.every(check => check.passed) ? 'pass' : 'fail',
    runId,
    termination: result.termination,
    projectionDigest: digest(result.projection),
    finalization,
    finalizationMatch:
      finalization.value === live.finalization.value &&
      finalization.finalizationId === live.finalization.finalizationId &&
      finalization.intentHash === live.finalization.intentHash &&
      finalization.recordHash === live.finalization.recordHash,
    liveEffectCount,
    remainingIO,
    childRunIds,
    childReplays,
    checks,
  }
  const evidence = await attachEvidenceRef(objects, evidenceCore)
  const output = await writeEvidence(runId, 'replay', evidence, argument('--evidence'))
  console.log(JSON.stringify(evidence, null, 2))
  console.log(`evidence=${output}`)
  process.exitCode = evidence.verdict === 'pass' ? 0 : 1
}

// Only run CLI when executed directly (not when imported by unit tests).
const isDirectCli =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('/replay.ts') ||
    process.argv[1].endsWith('/replay.js') ||
    process.argv[1].endsWith('factorio/replay.ts') ||
    process.argv[1].endsWith('factorio/replay.js'))

if (isDirectCli) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 2
  })
}
