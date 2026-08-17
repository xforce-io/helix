export type ExperimentArm = {
  success: boolean
  replayPassed: boolean
  cost: number
  latencyMs: number
}

export type ExperimentPair = {
  caseId: string
  category: string
  weight: number
  baseline: ExperimentArm
  candidate: ExperimentArm
}

export type ExperimentThresholds = {
  minPairs: number
  minSuccessRateDelta: number
  maxCostRatio: number
  maxLatencyRatio: number
  maxCategoryRegression: number
  maxFailureRateDelta: number
  mcnemarPValue: number
  bootstrapSamples: number
}

export const DEFAULT_EXPERIMENT_THRESHOLDS: ExperimentThresholds = {
  minPairs: 160,
  minSuccessRateDelta: 0.1,
  maxCostRatio: 1.2,
  maxLatencyRatio: 1.5,
  maxCategoryRegression: 0.05,
  maxFailureRateDelta: 0,
  mcnemarPValue: 0.05,
  bootstrapSamples: 2_000,
}

export type ExperimentAnalysis = {
  verdict: 'passed' | 'failed' | 'indeterminate'
  pairCount: number
  baselineSuccessRate: number
  candidateSuccessRate: number
  successRateDelta: number
  confidenceInterval: { level: 0.95; lower: number; upper: number }
  discordantPairs: { candidateWins: number; candidateLosses: number }
  mcnemarPValue: number
  costRatio: number
  latencyRatio: number
  failureRateDelta: number
  categoryDeltas: Record<string, number>
  failures: string[]
}
export function oneSidedMcnemarPValue(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0 || wins === 0) return 1
  let term = 2 ** -n
  for (let k = 0; k < wins; k += 1) term *= (n - k) / (k + 1)
  let result = term
  for (let k = wins; k < n; k += 1) { term *= (n - k) / (k + 1); result += term }
  return Math.min(1, result)
}
function weightedRate(
  pairs: ExperimentPair[],
  arm: 'baseline' | 'candidate',
): number {
  const weight = pairs.reduce((total, pair) => total + pair.weight, 0)
  if (weight <= 0) return 0
  return pairs.reduce(
    (total, pair) => total + (pair[arm].success ? pair.weight : 0),
    0,
  ) / weight
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))]!
}

/** Deterministic PRNG makes the analysis artifact reproducible from pair order. */
function random(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    return (value >>> 0) / 0x1_0000_0000
  }
}

export function pairedBootstrapConfidenceInterval(
  pairs: ExperimentPair[],
  samples: number,
): { level: 0.95; lower: number; upper: number } {
  if (pairs.length === 0) return { level: 0.95, lower: 0, upper: 0 }
  const next = random(0x29f1a)
  const deltas: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const drawn = Array.from(
      { length: pairs.length },
      () => pairs[Math.floor(next() * pairs.length)]!,
    )
    deltas.push(weightedRate(drawn, 'candidate') - weightedRate(drawn, 'baseline'))
  }
  return { level: 0.95, lower: percentile(deltas, 0.025), upper: percentile(deltas, 0.975) }
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

export function analyzeFactorioExperiment(
  pairs: ExperimentPair[],
  overrides: Partial<ExperimentThresholds> = {},
): ExperimentAnalysis {
  const thresholds = { ...DEFAULT_EXPERIMENT_THRESHOLDS, ...overrides }
  const invalid = pairs.some(pair =>
    !pair.caseId || !pair.category || !Number.isFinite(pair.weight) || pair.weight <= 0 ||
    !finiteNonNegative(pair.baseline.cost) || !finiteNonNegative(pair.candidate.cost) ||
    !finiteNonNegative(pair.baseline.latencyMs) || !finiteNonNegative(pair.candidate.latencyMs),
  )
  const replayFailure = pairs.some(pair => !pair.baseline.replayPassed || !pair.candidate.replayPassed)
  const baselineSuccessRate = weightedRate(pairs, 'baseline')
  const candidateSuccessRate = weightedRate(pairs, 'candidate')
  const successRateDelta = candidateSuccessRate - baselineSuccessRate
  const wins = pairs.filter(pair => !pair.baseline.success && pair.candidate.success).length
  const losses = pairs.filter(pair => pair.baseline.success && !pair.candidate.success).length
  const baselineCost = pairs.reduce((total, pair) => total + pair.weight * pair.baseline.cost, 0)
  const candidateCost = pairs.reduce((total, pair) => total + pair.weight * pair.candidate.cost, 0)
  const baselineLatency = pairs.reduce((total, pair) => total + pair.weight * pair.baseline.latencyMs, 0)
  const candidateLatency = pairs.reduce((total, pair) => total + pair.weight * pair.candidate.latencyMs, 0)
  const costRatio = baselineCost === 0 ? (candidateCost === 0 ? 1 : Infinity) : candidateCost / baselineCost
  const latencyRatio = baselineLatency === 0 ? (candidateLatency === 0 ? 1 : Infinity) : candidateLatency / baselineLatency
  const failureRateDelta = (1 - candidateSuccessRate) - (1 - baselineSuccessRate)
  const categoryDeltas: Record<string, number> = {}
  for (const category of [...new Set(pairs.map(pair => pair.category))].sort()) {
    const grouped = pairs.filter(pair => pair.category === category)
    categoryDeltas[category] = weightedRate(grouped, 'candidate') - weightedRate(grouped, 'baseline')
  }
  const confidenceInterval = pairedBootstrapConfidenceInterval(pairs, thresholds.bootstrapSamples)
  const mcnemarPValue = oneSidedMcnemarPValue(wins, losses)
  const failures = [
    invalid ? 'PAIR_INVALID' : '',
    replayFailure ? 'REPLAY_NOT_PASSED' : '',
    pairs.length < thresholds.minPairs ? 'PAIR_COUNT_BELOW_MINIMUM' : '',
    successRateDelta < thresholds.minSuccessRateDelta ? 'SUCCESS_RATE_DELTA_TOO_SMALL' : '',
    confidenceInterval.lower <= 0 ? 'CONFIDENCE_INTERVAL_NOT_POSITIVE' : '',
    mcnemarPValue >= thresholds.mcnemarPValue ? 'MCNEMAR_NOT_SIGNIFICANT' : '',
    failureRateDelta > thresholds.maxFailureRateDelta ? 'FAILURE_RATE_INCREASED' : '',
    costRatio > thresholds.maxCostRatio ? 'COST_RATIO_EXCEEDED' : '',
    latencyRatio > thresholds.maxLatencyRatio ? 'LATENCY_RATIO_EXCEEDED' : '',
    Object.values(categoryDeltas).some(delta => delta < -thresholds.maxCategoryRegression)
      ? 'CATEGORY_REGRESSION_EXCEEDED'
      : '',
  ].filter(Boolean)
  return {
    verdict: invalid || replayFailure ? 'indeterminate' : failures.length === 0 ? 'passed' : 'failed',
    pairCount: pairs.length,
    baselineSuccessRate,
    candidateSuccessRate,
    successRateDelta,
    confidenceInterval,
    discordantPairs: { candidateWins: wins, candidateLosses: losses },
    mcnemarPValue,
    costRatio,
    latencyRatio,
    failureRateDelta,
    categoryDeltas,
    failures,
  }
}
