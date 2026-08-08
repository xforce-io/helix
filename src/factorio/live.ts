import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AnthropicAdapter, MemoryStore, Milkie, type ITraceObjectStore } from 'milkie'
import { DefaultIOPort } from 'milkie/dist/runtime/IOPort.js'
import { JsonlEventStore } from 'milkie/dist/trace/JsonlEventStore.js'
import { RecordingIOPort } from 'milkie/dist/trace/RecordingIOPort.js'
import { CausalCursor } from 'milkie/dist/trace/CausalCursor.js'
import type { Event } from 'milkie/dist/trace/types.js'
import { digest } from './canonical.js'
import {
  argument,
  attachEvidenceRef,
  objectStore,
  OBJECT_ROOT,
  pins,
  preflightLive,
  requireModel,
  TRACE_ROOT,
  writeEvidence,
} from './cli-common.js'
import { runHarness } from './harness.js'
import { LiveCellExecutor } from './live-executor.js'
import type { CellExecutionRecord, LiveEvidence, ObjectRef } from './types.js'

function allObjectRefs(records: CellExecutionRecord[]): ObjectRef[] {
  return records.flatMap(record => record.managedObjects)
}

async function refsExist(store: ITraceObjectStore, refs: ObjectRef[]): Promise<boolean> {
  return (await Promise.all(refs.map(ref => store.has(ref.hash)))).every(Boolean)
}

function count(events: Event[], type: Event['type']): number {
  return events.filter(event => event.type === type).length
}

async function main(): Promise<void> {
  preflightLive()
  const model = requireModel()
  const runId = `factorio-${Date.now()}-${randomUUID().slice(0, 8)}`
  const episodeId = `${runId}:episode:0`
  const runPins = pins(model)
  const traceStore = new JsonlEventStore(TRACE_ROOT)
  const objects = objectStore()
  const apiKey = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY']
  const baseUrl = process.env['ANTHROPIC_BASE_URL']
  const gateway = new AnthropicAdapter({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  })
  const basePort = new DefaultIOPort(gateway)
  const port = new RecordingIOPort(
    basePort,
    traceStore,
    runId,
    'helix.factorio',
    objects,
    new CausalCursor(),
  )
  const executor = new LiveCellExecutor(runId, episodeId, runPins, objects)
  const milkie = new Milkie({
    stateStore: new MemoryStore(),
    gateway,
    eventStore: traceStore,
    traceObjectStore: objects,
  })

  await port.attach({
    agentId: 'helix.factorio.rlm',
    goal: 'Solve iron_ore_throughput through model-owned persistent IPython cells',
    input: 'ContextEnvelope only; no fixed action program',
    contextId: episodeId,
  })

  let harnessResult: Awaited<ReturnType<typeof runHarness>>
  try {
    harnessResult = await runHarness({
      runId,
      episodeId,
      pins: runPins,
      port,
      execute: input => executor.execute(input),
    })
    await port.detach({
      status: 'completed',
      lastTextOutput: harnessResult.projection.verification.success
        ? 'FLE verifier succeeded'
        : 'FLE verifier did not succeed',
    })
  } catch (error) {
    await port.detach({ status: 'error', error: String(error) })
    throw error
  } finally {
    await executor.close()
  }

  const projection = harnessResult.projection
  const refs = allObjectRefs(projection.cells)
  const baseChecks = [
    {
      id: 'S1.model-owned',
      passed: harnessResult.modelOwned && projection.cells.length >= 2,
      detail: `${projection.cells.length} model-authored cells`,
    },
    {
      id: 'S1.feedback-loop',
      passed: harnessResult.feedbackLinked && projection.modelCallCount >= 2,
      detail: `${projection.modelCallCount} model decisions with prior tool results`,
    },
    {
      id: 'S1.reset-once',
      passed: projection.resetCount === 1,
      detail: `resetCount=${projection.resetCount}`,
    },
    {
      id: 'S1.real-step',
      passed: projection.stepCount >= 1 && executor.effectCount >= 2,
      detail: `stepCount=${projection.stepCount} liveEffects=${executor.effectCount}`,
    },
    {
      id: 'S1.fle-verifier',
      passed: projection.verification.success,
      detail: JSON.stringify(projection.verification.meta),
    },
    {
      id: 'S1.action-policy',
      passed: projection.cells.every(
        cell =>
          !`${cell.error?.code ?? ''} ${cell.error?.message ?? ''}`.includes(
            'POLICY_VIOLATION',
          ) &&
          (!cell.factorioEffect?.programRef ||
            (cell.factorioEffect.programRef.bytes <= 10_000 &&
              cell.factorioEffect.metrics.stepSeconds <= 120)),
      ),
      detail:
        'policy violations, programs over 10k bytes, and steps over 120s are rejected; recoverable FLE errors remain valid feedback',
    },
    {
      id: 'S1.object-refs',
      passed: await refsExist(objects, refs),
      detail: `${refs.length} refs verified`,
    },
    {
      id: 'S1.process-boundary',
      passed: executor.kernelStartCount === 1 && executor.bridgeStartCount === 1,
      detail: `kernel=${executor.kernelStartCount} bridge=${executor.bridgeStartCount}`,
    },
  ]
  const livePassed = baseChecks.every(check => check.passed)
  const outcome = await milkie.recordTaskOutcome({
    runId,
    value: livePassed ? 'success' : 'failure',
    source: 'eval:fle',
    note: 'Deterministic Helix Factorio live verifier',
    scores: [
      { name: 'modelCalls', value: projection.modelCallCount },
      { name: 'cells', value: projection.cells.length },
      { name: 'steps', value: projection.stepCount },
    ],
  })
  const events = (await traceStore.readByRunId(runId)) as Event[]
  const traceCheck = {
    id: 'S1.milkie-trace',
    passed:
      count(events, 'llm.requested') === projection.modelCallCount &&
      count(events, 'llm.responded') === projection.modelCallCount &&
      count(events, 'tool.requested') === projection.cells.length &&
      count(events, 'tool.responded') === projection.cells.length &&
      count(events, 'task.outcome.recorded') === 1,
    detail: `${events.length} events`,
  }
  const outcomeCheck = {
    id: 'S1.milkie-outcome',
    passed: outcome.value === 'success' && outcome.source === 'eval:fle',
    detail: `${outcome.value}/${outcome.source}`,
  }
  const checks = [...baseChecks, traceCheck, outcomeCheck]
  const evidenceCore: LiveEvidence = {
    schema: 'helix.factorio.live/v1',
    verdict: checks.every(check => check.passed) ? 'pass' : 'fail',
    runId,
    pins: runPins,
    projectionDigest: digest(projection),
    traceFile: path.join(TRACE_ROOT, `${runId}.jsonl`),
    objectStore: OBJECT_ROOT,
    finalProjection: projection,
    outcome: { value: outcome.value, source: outcome.source },
    checks,
  }
  const evidence = await attachEvidenceRef(objects, evidenceCore)
  const output = await writeEvidence(runId, 'live', evidence, argument('--evidence'))
  console.log(JSON.stringify(evidence, null, 2))
  console.log(`runId=${runId}`)
  console.log(`evidence=${output}`)
  process.exitCode = evidence.verdict === 'pass' ? 0 : 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 2
})
