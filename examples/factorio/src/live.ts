import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FileTaskOutcomeFinalizationStore,
  MemoryStore,
  Milkie,
  type IModelGateway,
  type ITraceObjectStore,
} from 'milkie'
import { DefaultIOPort } from 'milkie/dist/runtime/IOPort.js'
import { JsonlEventStore } from 'milkie/dist/trace/JsonlEventStore.js'
import { RecordingIOPort } from 'milkie/dist/trace/RecordingIOPort.js'
import { CausalCursor } from 'milkie/dist/trace/CausalCursor.js'
import type { Event } from 'milkie/dist/trace/types.js'
import { digest } from './canonical.js'
import {
  argument,
  attachEvidenceRef,
  FINALIZATION_ROOT,
  HARNESS_STATE_ROOT,
  LIVE_WALL_TIMEOUT_MS,
  objectStore,
  OBJECT_ROOT,
  pins,
  pinsSessionAsync,
  preflightLive,
  SESSION_STORE_ROOT,
  summarizeFinalization,
  TRACE_ROOT,
  writeEvidence,
} from './cli-common.js'
import { connectModel } from './model-connection.js'
import {
  assembleFactorioRun,
  type AssembledFactorioRun,
  createFactorioHostBundle,
  parseHarnessStateRef,
} from './harness-host.js'

import { runHarness } from './harness.js'
import { LiveCellExecutor, type ChildPortHandle } from './live-executor.js'
import { LIVE_EVIDENCE_SCHEMA } from './session-async-constants.js'
import type {
  CellExecutionRecord,
  LiveEvidence,
  ObjectRef,
  TerminationReason,
} from './types.js'
import {
  buildChildRunIds,
  decideFinalOutcome,
  episodeContinuityCheck,
  finalizationEvidenceEventIds,
  liveRecursiveChecks,
  pinsGateFor,
  scanRecursiveResultWitness,
  traceChecksBeforeFinalization,
} from './verification.js'
function allObjectRefs(records: CellExecutionRecord[]): ObjectRef[] {
  return records.flatMap(record => record.managedObjects)
}

async function refsExist(store: ITraceObjectStore, refs: ObjectRef[]): Promise<boolean> {
  return (await Promise.all(refs.map(ref => store.has(ref.hash)))).every(Boolean)
}

function completionStatus(
  termination: TerminationReason,
): 'completed' | 'interrupted' | 'error' {
  if (termination === 'cancelled') return 'interrupted'
  if (
    termination === 'verifier_succeeded' ||
    termination === 'model_budget_exhausted' ||
    termination === 'cell_budget_exhausted' ||
    termination === 'wall_budget_exhausted'
  ) {
    return 'completed'
  }
  return 'error'
}

/** Milkie caps finalization IDs at 128 characters; evaluator run refs are longer. */
export function factorioFinalizationId(runId: string): string {
  const suffix = ':eval:fle:v2'
  const direct = `${runId}${suffix}`
  if (direct.length <= 128) return direct
  return `factorio-eval-${createHash('sha256').update(runId).digest('hex')}`
}

export type RunAssembledFactorioLiveInput = {
  /** Fully selected/frozen harness; evaluator arms must pass their issued pins. */
  assembled: AssembledFactorioRun
  model: string
  runId: string
  /** Evaluation arms persist separately from normal P1 recorded runs. */
  evidencePath?: string
  /** Optional injected gateway (tests); default path uses connectModel generate. */
  gateway?: IModelGateway
}

export type RunAssembledFactorioLiveResult = {
  evidence: LiveEvidence
  evidencePath: string
}

/**
 * Execute one real FLE run from already assembled pins. Both normal P1 and
 * refinement evaluation arms share this path; only the caller decides where
 * the immutable evidence is written.
 */
export async function runAssembledFactorioLive(
  input: RunAssembledFactorioLiveInput,
): Promise<RunAssembledFactorioLiveResult> {
  const { assembled, model, runId } = input
  const episodeId = `${runId}:episode:0`
  const budget = { deadlineAt: Date.now() + LIVE_WALL_TIMEOUT_MS }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const runPins = assembled.pins
  const sessionAsyncEnabled = runPins.sessionAsyncVersion === '1'

  const traceStore = new JsonlEventStore(TRACE_ROOT)
  const objects = objectStore()
  const gateway = input.gateway ?? createLiveGateway().gateway
  const basePort = new DefaultIOPort(gateway)
  const port = new RecordingIOPort(
    basePort,
    traceStore,
    runId,
    'helix.factorio',
    objects,
    new CausalCursor(),
  )
  const control = { deadlineAt: budget.deadlineAt, signal: controller.signal }
  /**
   * Issue #7 session/async opt-in:
   * Set HELIX_SESSION_ASYNC=1 (or true/yes) to enable durable SessionAsyncHost
   * with childPortFactory attach/parentId/invoke path and file-backed SessionStore.
   * Default remains off so #5 recursive-model path is unchanged.
   */
  // sessionAsyncEnabled already resolved above for pins/evidence schema.
  const childPortFactory = async (args: {
    childRunId: string
    parentRunId: string
    episodeId: string
    goal: string
    input: string
    agentId: string
    frozenHarness?: (typeof assembled)['frozen']
    harnessState?: (typeof assembled)['pins']['harnessState']
    sessionBootstrap?: {
      sessionId: string
      handleId: string
      capabilityToken: string
    }
  }): Promise<ChildPortHandle> => {
    // Host-private bootstrap stays in-process only — never attach/trace/LLM.
    // Inherited harness slice is identity for child record/metadata, not attach payload.
    void args.sessionBootstrap
    void args.frozenHarness
    void args.harnessState
    const childBase = new DefaultIOPort(gateway)
    const childPort = new RecordingIOPort(
      childBase,
      traceStore,
      args.childRunId,
      'helix.factorio.recursive-model',
      objects,
      new CausalCursor(),
    )
    let attached = false
    try {
      await childPort.attach({
        agentId: args.agentId,
        goal: args.goal,
        input: args.input,
        contextId: args.episodeId,
        parentId: args.parentRunId,
      })
      attached = true
    } catch (error) {
      const handle: ChildPortHandle = {
        port: childPort,
        attached: false,
        detach: async () => undefined,
      }
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { handle },
      )
    }
    let detached = false
    return {
      port: childPort,
      attached,
      detach: async payload => {
        if (detached) return
        detached = true
        await childPort.detach(payload)
      },
    }
  }
  const executor = new LiveCellExecutor(runId, episodeId, runPins, objects, {
    recursiveModelEnabled: true,
    frozenHarness: assembled.frozen,
    control,
    childPortFactory,
    ...(sessionAsyncEnabled
      ? {
          sessionAsync: {
            enabled: true,
            principalId: 'factorio-live',
            sessionStoreRoot: SESSION_STORE_ROOT,
            childPortFactory,
            model,
            control,
          },
        }
      : {}),
  })
  if (sessionAsyncEnabled) {
    executor.sessionAsync?.setParentRunId(runId)
  }
  const finalizationStore = new FileTaskOutcomeFinalizationStore(FINALIZATION_ROOT)
  const milkie = new Milkie({
    stateStore: new MemoryStore(),
    gateway,
    eventStore: traceStore,
    traceObjectStore: objects,
    outcomeFinalizationStore: finalizationStore,
  })

  await port.attach({
    agentId: 'helix.factorio.rlm',
    goal: 'Solve iron_ore_throughput through model-owned persistent IPython cells',
    input: 'ContextEnvelope only; no fixed action program',
    contextId: episodeId,
  })

  let harnessResult: Awaited<ReturnType<typeof runHarness>> | undefined
  let detached = false
  const detachOnce = async (
    payload: Parameters<typeof port.detach>[0],
  ): Promise<void> => {
    if (detached) return
    detached = true
    await port.detach(payload)
  }
  try {
    harnessResult = await runHarness({
      runId,
      episodeId,
      pins: runPins,
      port,
      budget,
      control,
      execute: (input, signal) => executor.execute(input, signal),
      frozenHarness: assembled.frozen,
      controlPlaneText: assembled.controlPlaneText,
      controlPlaneContentHash: assembled.controlPlaneContentHash,
      recursiveModel: { enabled: true },
      getRecursiveBudget: () => {
        const pool = executor.getBudgetPool()
        return {
          remainingTokens: pool.remainingTokens,
          recursiveCallCount: pool.recursiveCallCount,
        }
      },
    })
    await detachOnce({
      status: completionStatus(harnessResult.termination),
      lastTextOutput: harnessResult.projection.verification.success
        ? 'FLE verifier succeeded'
        : `FLE verifier did not succeed (${harnessResult.termination})`,
    })
  } catch (error) {
    await detachOnce({ status: 'error', error: String(error) })
    throw error
  } finally {
    await executor.close()
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }

  if (!harnessResult) throw new Error('harness did not produce a result')


  const projection = harnessResult.projection
  const refs = allObjectRefs(projection.cells)
  const pool = executor.getBudgetPool()
  const { childRunIds, nonReplayableChildRunIds } = buildChildRunIds(projection.cells)
  // Prefer executor-observed started set when available (authoritative attach path).
  const evidenceChildRunIds =
    executor.childRunIds.length > 0 ? [...executor.childRunIds] : childRunIds
  const evidenceNonReplayable =
    executor.nonReplayableChildRunIds.length > 0
      ? [...executor.nonReplayableChildRunIds]
      : nonReplayableChildRunIds

  // I3: witness scans recorded CellExecutionRecord.source/code (not stdout proxy).
  const cellSources = projection.cells.map((cell, cellIndex) => ({
    cellIndex,
    source: cell.source ?? '',
  }))
  const recursiveResultWitness = scanRecursiveResultWitness(
    projection.cells,
    cellSources,
  )
  const baseChecks = [
    pinsGateFor(runPins),
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
    episodeContinuityCheck(projection.cells),
    {
      id: 'S1.child-run-unique',
      passed: new Set(evidenceChildRunIds).size === evidenceChildRunIds.length,
      detail: JSON.stringify(evidenceChildRunIds),
    },
  ]
  const recursiveChecks = liveRecursiveChecks({
    evidence: {
      childRunIds: evidenceChildRunIds,
      nonReplayableChildRunIds: evidenceNonReplayable,
      ...(recursiveResultWitness ? { recursiveResultWitness } : {}),
      pins: runPins,
    },
    records: projection.cells,
    cellSources,
    termination: harnessResult.termination,
  })
  const eventsBeforeFinalization = (await traceStore.readByRunId(runId)) as Event[]
  const preFinalizationTraceChecks = traceChecksBeforeFinalization(
    eventsBeforeFinalization,
    projection.modelCallCount,
    harnessResult.toolCallCount,
  )
  const preFinalizationChecks = [
    ...baseChecks,
    ...recursiveChecks,
    ...preFinalizationTraceChecks,
  ]
  const outcomeValue = decideFinalOutcome(
    preFinalizationChecks,
    harnessResult.termination,
  )
  const finalObservationHash = projection.lastObservationRef?.hash ?? 'none'
  const [terminalEventId, completionEventId] = finalizationEvidenceEventIds(
    eventsBeforeFinalization,
    projection,
    harnessResult.termination,
  )
  const finalizationAttempt = await milkie.finalizeTaskOutcome({
    runId,
    expectedState: 'unfinalized',
    finalizationId: factorioFinalizationId(runId),
    value: outcomeValue,
    verifierClaim: { type: 'eval', id: 'helix.factorio.fle/v2' },
    evidence: [
      { kind: 'event', eventId: terminalEventId },
      { kind: 'event', eventId: completionEventId },
    ],
    note: `Deterministic Helix Factorio live verifier; finalObservationRef=${finalObservationHash}`,
    scores: [
      { name: 'modelCalls', value: projection.modelCallCount },
      { name: 'cells', value: projection.cells.length },
      { name: 'steps', value: projection.stepCount },
      { name: 'recursiveCalls', value: pool.recursiveCallCount },
    ],
  })
  if (finalizationAttempt.status === 'conflict') {
    throw new Error(
      `task outcome finalization conflict: ${finalizationAttempt.conflict.kind}`,
    )
  }
  const finalization = summarizeFinalization(
    finalizationAttempt.status,
    finalizationAttempt.final,
  )
  const finalizationCheck = {
    id: 'S2.milkie-finalization',
    passed:
      finalization.value === outcomeValue &&
      finalization.verifierId === 'helix.factorio.fle/v2' &&
      (finalization.status === 'finalized' || finalization.status === 'idempotent'),
    detail: `${finalization.status}/${finalization.value}/${finalization.recordHash}`,
  }
  const checks = [...preFinalizationChecks, finalizationCheck]
  const sessionSlice = executor.sessionAsync?.evidenceSlice()
  const evidenceCore: LiveEvidence = {
    schema: sessionAsyncEnabled ? LIVE_EVIDENCE_SCHEMA : 'helix.factorio.live/v3',
    verdict:
      checks.every(check => check.passed) && finalization.value === 'success'
        ? 'pass'
        : 'fail',
    runId,
    pins: runPins,
    harness: assembled.freeze.evidence,
    budget: {
      ...budget,
      remainingWallMsAtEnd: Math.max(0, budget.deadlineAt - Date.now()),
      remainingRecursiveModelTokensAtEnd: pool.remainingTokens,
      ...(executor.sessionAsync
        ? {
            remainingSessionTokensAtEnd:
              executor.sessionAsync.getSessionPoolRemaining(),
          }
        : {}),
    },
    termination: harnessResult.termination,
    projectionDigest: digest(projection),
    traceFile: path.join(TRACE_ROOT, `${runId}.jsonl`),
    objectStore: OBJECT_ROOT,
    finalProjection: projection,
    finalization,
    childRunIds: evidenceChildRunIds,
    ...(evidenceNonReplayable.length > 0
      ? { nonReplayableChildRunIds: evidenceNonReplayable }
      : {}),
    recursiveModel: {
      calls: pool.recursiveCallCount,
      settlements: pool.settlements,
    },
    ...(recursiveResultWitness ? { recursiveResultWitness } : {}),
    ...(sessionSlice?.session ? { session: sessionSlice.session } : {}),
    ...(sessionSlice
      ? {
          sessionMergeEvents: sessionSlice.sessionMergeEvents,
          sessionMergeCommits: sessionSlice.sessionMergeCommits,
          sessionBudgetSettlements: sessionSlice.sessionBudgetSettlements,
        }
      : {}),
    checks,
  }
  const evidence = await attachEvidenceRef(objects, evidenceCore)
  const evidencePath = await writeEvidence(runId, 'live', evidence, input.evidencePath)
  return { evidence, evidencePath }
}

/** CLI / default live path: assemble model gateway via the connection facade. */
export function createLiveGateway(env: NodeJS.ProcessEnv = process.env): {
  model: string
  gateway: IModelGateway
} {
  const connected = connectModel({
    purpose: 'generate',
    config: { env },
  })
  if (connected.gateway === undefined) {
    throw new Error(
      'Factorio live requires transport=api so connectModel can return an HTTP gateway',
    )
  }
  const model = connected.projection.model
  if (model === undefined || model.length === 0) {
    throw new Error('Factorio live connection projection is missing model')
  }
  return { model, gateway: connected.gateway }
}


async function main(): Promise<void> {
  preflightLive()
  const { model, gateway } = createLiveGateway()
  const runId = `factorio-${Date.now()}-${randomUUID().slice(0, 8)}`
  const sessionAsyncEnabled =
    process.env['HELIX_SESSION_ASYNC'] === '1' ||
    process.env['HELIX_SESSION_ASYNC'] === 'true' ||
    process.env['HELIX_SESSION_ASYNC'] === 'yes'
  const basePins = sessionAsyncEnabled ? pinsSessionAsync(model) : pins(model)
  const hostBundle = createFactorioHostBundle({ rootDir: HARNESS_STATE_ROOT })
  const overlayArg = argument('--overlay')
  const assembled = assembleFactorioRun({
    bundle: hostBundle,
    basePins,
    baselineRef: sessionAsyncEnabled
      ? hostBundle.legacyV5BaselineRef
      : hostBundle.defaultBaselineRef,
    ...(overlayArg === undefined ? {} : { overlayRef: parseHarnessStateRef(overlayArg) }),
  })
  const explicitEvidencePath = argument('--evidence')
  const { evidence, evidencePath } = await runAssembledFactorioLive({
    assembled,
    model,
    runId,
    gateway,
    ...(explicitEvidencePath === undefined ? {} : { evidencePath: explicitEvidencePath }),
  })
  console.log(JSON.stringify({
    schema: evidence.schema,
    verdict: evidence.verdict,
    runId: evidence.runId,
    pins: evidence.pins,
    budget: evidence.budget,
    projectionDigest: evidence.projectionDigest,
    termination: evidence.termination,
    childRunIds: evidence.childRunIds,
    recursiveModel: evidence.recursiveModel,
    recursiveResultWitness: evidence.recursiveResultWitness,
    finalization: evidence.finalization,
    checks: evidence.checks,
    evidenceRef: evidence.evidenceRef,
  }, null, 2))
  console.log(`runId=${runId}`)
  console.log(`evidence=${evidencePath}`)
  process.exitCode =
    evidence.verdict === 'pass'
      ? 0
      : evidence.termination === 'cancelled'
        ? 130
        : 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 2
  })
}
