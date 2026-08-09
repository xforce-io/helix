import {
  FileTaskOutcomeFinalizationStore,
  FileTraceObjectStore,
  MemoryStore,
  Milkie,
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
import type { CellExecutionRecord, ObjectRef, ReplayEvidence } from './types.js'

class DenyLivePort implements IIOPort {
  calls = 0
  async invokeLLM(): Promise<never> {
    this.calls += 1
    throw new Error('live LLM access is forbidden during replay')
  }
  async invokeTool(): Promise<never> {
    this.calls += 1
    throw new Error('live tool access is forbidden during replay')
  }
  now(): never {
    this.calls += 1
    throw new Error('live clock access is forbidden during replay')
  }
  uuid(): never {
    this.calls += 1
    throw new Error('live UUID access is forbidden during replay')
  }
}

function refs(records: CellExecutionRecord[]): ObjectRef[] {
  return records.flatMap(record => record.managedObjects)
}

async function main(): Promise<void> {
  const runId = argument('--run')
  if (!runId) throw new Error('missing --run <run-id>')
  const live = await readLiveEvidence(runId)
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
  const checks = [
    {
      id: 'S3.replay-zero-live-effects',
      passed: liveEffectCount === 0 && denied.calls === 0,
      detail: `handler=${liveEffectCount} deniedPort=${denied.calls}`,
    },
    {
      id: 'S3.replay-io-consumed',
      passed: Object.values(remainingIO).every(value => value === 0),
      detail: JSON.stringify(remainingIO),
    },
    {
      id: 'S3.replay-projection',
      passed:
        digest(result.projection) === live.projectionDigest &&
        result.termination === live.termination,
    },
    {
      id: 'S3.replay-model-owned',
      passed: result.modelOwned && result.feedbackLinked,
    },
    {
      id: 'S3.replay-object-refs',
      passed: objectRefsValid,
      detail: `${objectRefs.length} refs verified`,
    },
    {
      id: 'S3.replay-finalization',
      passed:
        finalization.value === live.finalization.value &&
        finalization.finalizationId === live.finalization.finalizationId &&
        finalization.intentHash === live.finalization.intentHash &&
        finalization.recordHash === live.finalization.recordHash,
    },
    {
      id: 'S3.live-success',
      passed: live.verdict === 'pass' && finalization.value === 'success',
    },
  ]
  const evidenceCore: ReplayEvidence = {
    schema: 'helix.factorio.replay/v2',
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
    checks,
  }
  const evidence = await attachEvidenceRef(objects, evidenceCore)
  const output = await writeEvidence(runId, 'replay', evidence, argument('--evidence'))
  console.log(JSON.stringify(evidence, null, 2))
  console.log(`evidence=${output}`)
  process.exitCode = evidence.verdict === 'pass' ? 0 : 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 2
})
