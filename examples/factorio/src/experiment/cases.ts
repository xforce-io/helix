/** Closed task and FLE-slot registry for the Factorio self-evolution experiment. */

import { canonicalJson, digest } from '../canonical.js'

export type FactorioExperimentTask = {
  taskId: string
  taskDigest: string
  category: string
  instruction: string
}

/**
 * Closed set of FLE tasks whose registry definition has been independently
 * fingerprinted in the pinned FLE 0.4.3 environment.  Listing a task here is
 * an identity contract, not a best-effort Gym discovery result.
 */
export const FACTORIO_EXPERIMENT_TASKS: Record<string, FactorioExperimentTask> = {
  'factorio.throughput/iron-ore/v1': {
    taskId: 'iron_ore_throughput', category: 'raw-material',
    taskDigest: 'sha256:c50497c8548123494e48376e51ace2dd4f66717421de3a9f930d5833b6572f44',
    instruction: 'Solve the FLE iron_ore_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/iron-plate/v1': {
    taskId: 'iron_plate_throughput', category: 'raw-material',
    taskDigest: 'sha256:0e111447aae5e5d6ba9430a0219b70f632ac4f99b63c2f25101b8663b072aee2',
    instruction: 'Solve the FLE iron_plate_throughput task through model-owned persistent IPython cells.',
  },
}

export const DEFAULT_FACTORIO_EXPERIMENT_TASK =
  FACTORIO_EXPERIMENT_TASKS['factorio.throughput/iron-ore/v1']!

export type FactorioExperimentProfile = {
  schemaVersion: 'helix.factorio.experiment-profile/v2'
  inputRef: string
  taskId: string
  taskDigest: string
  category: string
  instruction: string
  /** A pre-provisioned FLE container slot, never an invented random seed. */
  slot: number
  seed: number
  digest: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Suite seed is intentionally restricted to a configured pool slot.  This
 * makes FLE's actual run_idx semantics explicit and rejects phantom samples.
 */
export function resolveFactorioExperimentCase(
  value: unknown,
  options: { slots: number } = { slots: 4 },
): FactorioExperimentProfile {
  const entry = asRecord(value)
  if (entry === undefined) throw new Error('Factorio experiment case must be an object')
  const task = typeof entry.inputRef === 'string' ? FACTORIO_EXPERIMENT_TASKS[entry.inputRef] : undefined
  if (task === undefined) throw new Error('Factorio experiment inputRef is not registered')
  if (!Number.isSafeInteger(entry.seed) || (entry.seed as number) < 0 || (entry.seed as number) >= options.slots) {
    throw new Error(`Factorio experiment seed must select a configured slot [0, ${options.slots})`)
  }
  const stable = {
    schemaVersion: 'helix.factorio.experiment-profile/v2' as const,
    inputRef: entry.inputRef as string,
    taskId: task.taskId,
    taskDigest: task.taskDigest,
    category: task.category,
    instruction: task.instruction,
    slot: entry.seed as number,
    seed: entry.seed as number,
  }
  return { ...stable, digest: digest(canonicalJson(stable)) }
}
