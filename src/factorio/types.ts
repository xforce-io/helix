export interface ObjectRef {
  hash: string
  kind: 'fle.observation' | 'fle.game-state' | 'fle.action-program' | 'helix.output'
  schema: string
  mediaType: 'application/json' | 'text/plain'
  bytes: number
  preview?: unknown
  truncated: boolean
}

export interface TaskVerification {
  success: boolean
  meta: Array<{ key: string; value: unknown }>
}

export interface FactorioEffect {
  method: 'reset' | 'step'
  episodeId: string
  stepIndex: number
  commandId: string
  programRef?: ObjectRef
  inputStateRef?: ObjectRef
  observationRef: ObjectRef
  outputStateRef: ObjectRef
  actionCapabilities: string[]
  observation: Record<string, unknown>
  reward: number
  terminated: boolean
  truncated: boolean
  verification: TaskVerification
  metrics: {
    stepSeconds: number
    tick: number
    productionScore: number
    automatedProductionScore: number
    actionHadError: boolean
  }
}

export interface CellExecutionRecord {
  schema: 'helix.cell-execution/v1'
  cellId: string
  sourceDigest: string
  startRevision: number
  endRevision: number
  status: 'success' | 'error'
  stdoutPreview: string
  stderrPreview: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  namespace: Array<{ name: string; type: string; length?: number }>
  managedObjects: ObjectRef[]
  factorioEffect?: FactorioEffect
  error?: {
    code: string
    type?: string
    message: string
    stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
  }
}

export interface RunPins {
  model: string
  harness: 'factorio-rlm/v2'
  kernelProtocol: '2'
  bindingSet: 'factorio/v2'
  renderer: 'markdown-json/v1'
  isolationProfile: 'local-process-ast/v2'
  milkie: string
  fle: '0.4.3'
  factorioServer: '2.0.73'
  taskId: 'iron_ore_throughput'
  taskDigest: string
  kernelMemoryBytes: number
  kernelCpuSeconds: number
}

export interface EpisodeProjection {
  runId: string
  episodeId: string
  kernelRevision: number
  resetCount: number
  stepCount: number
  modelCallCount: number
  cells: CellExecutionRecord[]
  lastObservationRef?: ObjectRef
  lastStateRef?: ObjectRef
  actionCapabilities?: string[]
  verification: TaskVerification
  terminated: boolean
  truncated: boolean
}

export interface LiveEvidence {
  schema: 'helix.factorio.live/v1'
  verdict: 'pass' | 'fail'
  runId: string
  pins: RunPins
  projectionDigest: string
  traceFile: string
  objectStore: string
  finalProjection: EpisodeProjection
  outcome: { value: string; source: string }
  checks: Array<{ id: string; passed: boolean; detail?: string }>
  evidenceRef?: string
}

export interface ReplayEvidence {
  schema: 'helix.factorio.replay/v1'
  verdict: 'pass' | 'fail'
  runId: string
  projectionDigest: string
  liveEffectCount: number
  remainingIO: { llm: number; tool: number; clock: number; uuid: number }
  checks: Array<{ id: string; passed: boolean; detail?: string }>
  evidenceRef?: string
}
