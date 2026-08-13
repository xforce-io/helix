/**
 * Production-shaped refinement run adapter over milkie IOPort + #10 Host path.
 *
 * Generation always goes through RecordingIOPort (or any IIOPort the Host
 * supplies). Evaluation freezes ordinary #10 pins via select→resolve→freeze
 * on the evaluator route, then verifies recorded-pin replay with zero live
 * selection drift. Metrics remain Host-supplied so scenario quality extractors
 * stay outside RCS.
 */

import type { IIOPort } from 'milkie'
import { MemoryEventStore } from 'milkie/dist/trace/MemoryEventStore.js'
import { RecordingIOPort } from 'milkie/dist/trace/RecordingIOPort.js'
import { CausalCursor } from 'milkie/dist/trace/CausalCursor.js'
import { MemoryTraceObjectStore } from 'milkie/dist/trace/TraceObjectStore.js'

import {
  HarnessStateStore,
  replayFromRecordedPins,
  selectValidateResolveFreeze,
  type CatalogCardRef,
  type HarnessPinsV1,
  type HarnessStateRef,
} from '../harness/index.js'
import { RefinementControlStore } from './control-store.js'
import { refinementError } from './errors.js'
import {
  createIOPortGenerationAdapter,
  type EvaluationMetric,
  type EvaluationSuiteV1,
  type RefinementPolicyV1,
  type RefinementRunAdapter,
} from './workflow.js'

export type MetricExtractor = (input: {
  arm: 'baseline' | 'candidate'
  case: EvaluationSuiteV1['cases'][number]
  pins: HarnessPinsV1
  frozenHash: string
  replayPassed: boolean
}) => Omit<EvaluationMetric, 'harnessPins' | 'runRef' | 'replayPassed' | 'sharedPins'>

export type CreateMilkieRefinementAdapterInput = {
  /** RCS used as the #10 store for evaluator selection/visibility. */
  rcs: RefinementControlStore
  /** Frozen available catalog membership for this Host deployment. */
  availableCatalogRefs: readonly CatalogCardRef[]
  codeProtocolPin: string
  /**
   * Live generation port. Prefer a Host-wrapped RecordingIOPort so Trace/budget
   * authority stays in milkie. When omitted, a memory RecordingIOPort is built
   * around `innerPort`.
   */
  generationPort?: IIOPort
  /** Required when generationPort is omitted. */
  innerPort?: IIOPort
  generationRunRef: string
  generationModel: string
  /** Deterministic quality/cost extractor; no LLM. */
  extractMetrics: MetricExtractor
  /** Shared execution pins identical on both arms (runner/model/seed…). */
  sharedPins: Record<string, string>
}

/**
 * Build a RefinementRunAdapter that uses milkie IOPort for generation and
 * ordinary #10 Host selection/replay for evaluation arms.
 */
export function createMilkieRefinementAdapter(
  input: CreateMilkieRefinementAdapterInput,
): RefinementRunAdapter {
  const port =
    input.generationPort ??
    (() => {
      if (input.innerPort === undefined) {
        throw refinementError(
          'REFINEMENT_CANDIDATE_INVALID',
          'milkie adapter requires generationPort or innerPort',
        )
      }
      return new RecordingIOPort(
        input.innerPort,
        new MemoryEventStore(),
        input.generationRunRef,
        'helix.refinement.generation',
        new MemoryTraceObjectStore(),
        new CausalCursor(),
      )
    })()

  const generation = createIOPortGenerationAdapter({
    port,
    model: input.generationModel,
    generationRunRef: input.generationRunRef,
    evaluate: async () => {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'generation-only adapter')
    },
  })

  return {
    generate: generation.generate,
    async evaluate(args): Promise<EvaluationMetric> {
      return evaluateArmWithHarness({
        rcs: input.rcs,
        arm: args.arm,
        case: args.case,
        baselineRef: args.baselineRef,
        ...(args.overlayRef === undefined ? {} : { overlayRef: args.overlayRef }),
        availableCatalogRefs: input.availableCatalogRefs,
        codeProtocolPin: input.codeProtocolPin,
        sharedPins: {
          ...input.sharedPins,
          seed: String(args.case.seed),
          caseId: args.case.caseId,
          inputRef: args.case.inputRef,
        },
        extractMetrics: input.extractMetrics,
        policy: args.policy,
      })
    },
  }
}

function evaluateArmWithHarness(input: {
  rcs: RefinementControlStore
  arm: 'baseline' | 'candidate'
  case: EvaluationSuiteV1['cases'][number]
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
  availableCatalogRefs: readonly CatalogCardRef[]
  codeProtocolPin: string
  sharedPins: Record<string, string>
  extractMetrics: MetricExtractor
  policy: RefinementPolicyV1
}): EvaluationMetric {
  void input.policy
  // Build an ephemeral #10 store view from RCS by re-reading published refs.
  // Selection still goes through RCS visibility gates first.
  const selection = input.rcs.select(
    input.arm === 'candidate' ? 'evaluator' : 'external',
    {
      baselineRef: input.baselineRef,
      ...(input.overlayRef !== undefined ? { overlayRef: input.overlayRef } : {}),
    },
    input.availableCatalogRefs,
  )

  // Reconstruct a HarnessStateStore-compatible bootstrap for freeze/replay by
  // publishing only the selected baseline/overlay into a process-local store.
  // The durable authority remains RCS; this is the Host evaluation view.
  const local = new HarnessStateStore({ skipRegistryLookup: true })
  const baselineStored = input.rcs.read(input.baselineRef)
  if (baselineStored.kind !== 'baseline') {
    throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'baseline ref does not read as baseline')
  }
  const publishedBaseline = local.publishBaseline(baselineStored.document, {
    id: baselineStored.ref.id,
    revision: baselineStored.ref.revision,
  })
  if (publishedBaseline.contentHash !== baselineStored.ref.contentHash) {
    throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'evaluation baseline hash drift')
  }
  let overlayRef: HarnessStateRef | undefined
  if (selection.overlayRef !== undefined) {
    const overlayStored = input.rcs.read(selection.overlayRef)
    if (overlayStored.kind !== 'overlay') {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'overlay ref does not read as overlay')
    }
    overlayRef = local.publishOverlay(overlayStored.overlay, {
      id: overlayStored.ref.id,
      revision: overlayStored.ref.revision,
    })
    if (overlayRef.contentHash !== overlayStored.ref.contentHash) {
      throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'evaluation overlay hash drift')
    }
  }

  const freeze = selectValidateResolveFreeze({
    store: local,
    availableCatalogRefs: input.availableCatalogRefs,
    codeProtocolPin: input.codeProtocolPin,
    selection: {
      baselineRef: publishedBaseline,
      ...(overlayRef !== undefined ? { overlayRef } : {}),
    },
  })
  const harnessPins = freeze.pins

  let replayPassed = true
  try {
    const replayed = replayFromRecordedPins({
      store: local,
      pins: harnessPins,
      availableCatalogRefs: input.availableCatalogRefs,
    })
    if (replayed.pins.harnessContentHash !== harnessPins.harnessContentHash) {
      replayPassed = false
    }
  } catch {
    replayPassed = false
  }

  const metrics = input.extractMetrics({
    arm: input.arm,
    case: input.case,
    pins: harnessPins,
    frozenHash: harnessPins.harnessContentHash,
    replayPassed,
  })

  return {
    ...metrics,
    replayPassed,
    sharedPins: input.sharedPins,
    harnessPins,
    runRef: `eval-${input.arm}-${input.case.caseId}-${harnessPins.harnessContentHash.slice(0, 12)}`,
  }
}
