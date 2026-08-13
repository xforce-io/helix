/**
 * Production-shaped refinement run adapter over milkie IOPort + #10 Host path.
 *
 * Generation always goes through RecordingIOPort (or any IIOPort the Host
 * supplies). Evaluation freezes ordinary #10 pins via select→resolve→freeze
 * on the evaluator route, then verifies recorded-pin replay with zero live
 * selection drift. Host `runArm` supplies the recorded milkie run and outcome
 * metrics; core never invents `eval-arm-…` run refs.
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

export type EvaluationArmResult = {
  runRef: string
  quality: number
  cost: number
  latencyMs: number
  failed: boolean
}

export type CreateMilkieRefinementAdapterInput = {
  rcs: RefinementControlStore
  availableCatalogRefs: readonly CatalogCardRef[]
  codeProtocolPin: string
  generationPort?: IIOPort
  innerPort?: IIOPort
  generationRunRef: string
  generationModel: string
  projectGenerationInput: (sourceRunRefs: string[]) => unknown
  runArm: (input: {
    arm: 'baseline' | 'candidate'
    case: EvaluationSuiteV1['cases'][number]
    reservedRunRef: string
    pins: HarnessPinsV1
    replayPassed: boolean
  }) => EvaluationArmResult | Promise<EvaluationArmResult>
  extractorDigest: string
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
    projectGenerationInput: input.projectGenerationInput,
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
        runArm: input.runArm,
        extractorDigest: input.extractorDigest,
        reservedRunRef: args.reservedRunRef,
        policy: args.policy,
      })
    },
  }
}

async function evaluateArmWithHarness(input: {
  rcs: RefinementControlStore
  arm: 'baseline' | 'candidate'
  case: EvaluationSuiteV1['cases'][number]
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
  availableCatalogRefs: readonly CatalogCardRef[]
  codeProtocolPin: string
  sharedPins: Record<string, string>
  runArm: CreateMilkieRefinementAdapterInput['runArm']
  extractorDigest: string
  reservedRunRef: string
  policy: RefinementPolicyV1
}): Promise<EvaluationMetric> {
  if (input.extractorDigest !== input.policy.extractorDigest) {
    throw refinementError('REFINEMENT_CANDIDATE_INVALID', 'Host extractorDigest does not match policy')
  }
  const selection = input.rcs.select(
    input.arm === 'candidate' ? 'evaluator' : 'external',
    {
      baselineRef: input.baselineRef,
      ...(input.overlayRef !== undefined ? { overlayRef: input.overlayRef } : {}),
    },
    input.availableCatalogRefs,
  )

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

  const metrics = await input.runArm({
    arm: input.arm,
    case: input.case,
    reservedRunRef: input.reservedRunRef,
    pins: harnessPins,
    replayPassed,
  })

  return {
    quality: metrics.quality,
    cost: metrics.cost,
    latencyMs: metrics.latencyMs,
    failed: metrics.failed,
    replayPassed,
    sharedPins: input.sharedPins,
    harnessPins,
    runRef: metrics.runRef,
    extractorDigest: input.extractorDigest,
  }
}
