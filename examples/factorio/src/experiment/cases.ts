/** Closed task and FLE-slot registry for the Factorio self-evolution experiment. */

import { canonicalJson, digest } from '../canonical.js'

export type FactorioExperimentTask = {
  taskId: string
  taskDigest: string
  category: string
  instruction: string
}

function task(taskId: string, category: string, taskDigest: string): FactorioExperimentTask {
  return {
    taskId,
    category,
    taskDigest,
    instruction: `Solve the FLE ${taskId} task through model-owned persistent IPython cells.`,
  }
}

/**
 * Closed set of FLE tasks whose registry definition has been independently
 * fingerprinted in the pinned FLE 0.4.3 environment.  Listing a task here is
 * an identity contract, not a best-effort Gym discovery result.
 */
export const FACTORIO_EXPERIMENT_TASKS: Record<string, FactorioExperimentTask> = {
  'factorio.throughput/iron-ore/v1': task(
    'iron_ore_throughput', 'raw-material',
    'sha256:c50497c8548123494e48376e51ace2dd4f66717421de3a9f930d5833b6572f44',
  ),
  'factorio.throughput/iron-plate/v1': task(
    'iron_plate_throughput', 'raw-material',
    'sha256:0e111447aae5e5d6ba9430a0219b70f632ac4f99b63c2f25101b8663b072aee2',
  ),
  'factorio.throughput/steel-plate/v1': task(
    'steel_plate_throughput', 'intermediate',
    'sha256:400afd8c4f5682d1f37eeab296d7c30db1f9dde86b6bd0f91860c871715db0a4',
  ),
  'factorio.throughput/iron-gear-wheel/v1': task(
    'iron_gear_wheel_throughput', 'intermediate',
    'sha256:940eacfd19e445c9c263cb4d9574503b4a5aa26fa41f936bb4b68325c980fed4',
  ),
  'factorio.throughput/electronic-circuit/v1': task(
    'electronic_circuit_throughput', 'circuit',
    'sha256:8545de22fd179a544f28758dddb35561d9f1f0d8daff72a103421c75df44fb9e',
  ),
  'factorio.throughput/inserter/v1': task(
    'inserter_throughput', 'intermediate',
    'sha256:327e7fe71bfef355a06bf8c473ecdb0d9e407f02110c7e3da52621c8ec2b05e4',
  ),
  'factorio.throughput/automation-science-pack/v1': task(
    'automation_science_pack_throughput', 'science',
    'sha256:7155384ed5f17c36252724b3d05b3373646b30b103883777df08297da04866f1',
  ),
  'factorio.throughput/logistics-science-pack/v1': task(
    'logistics_science_pack_throughput', 'science',
    'sha256:5b172e2f7a533cc3d5639e60ce844826ab0027e5b5426494b8ae4e9182b3e287',
  ),
  'factorio.throughput/stone-wall/v1': task(
    'stone_wall_throughput', 'structure',
    'sha256:f377930fa5456ed6a0350b4fe52fc7a945a63e05676a029612ed1ac833319818',
  ),
  'factorio.throughput/plastic-bar/v1': task(
    'plastic_bar_throughput', 'oil',
    'sha256:5c5d8c8c8f2e23d117a8ce3edad12d00f0f55ddb3eff6ef5ddf5ce4d36edfef0',
  ),
}
export const OFFICIAL_EXPERIMENT_INPUT_REFS = [
  'factorio.throughput/iron-ore/v1',
  'factorio.throughput/iron-plate/v1',
  'factorio.throughput/steel-plate/v1',
  'factorio.throughput/iron-gear-wheel/v1',
  'factorio.throughput/electronic-circuit/v1',
  'factorio.throughput/inserter/v1',
  'factorio.throughput/automation-science-pack/v1',
  'factorio.throughput/logistics-science-pack/v1',
  'factorio.throughput/stone-wall/v1',
  'factorio.throughput/plastic-bar/v1',
] as const

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

function optionalSlot(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) throw new Error('Factorio experiment slot must be a safe integer')
  return value as number
}

/**
 * Suite seed is intentionally restricted to a configured pool slot.  This
 * makes FLE's actual run_idx semantics explicit and rejects phantom samples.
 * `seed` is only accepted as an alias of `slot` and must equal it.
 */
export function resolveFactorioExperimentCase(
  value: unknown,
  options: { slots: number } = { slots: 4 },
): FactorioExperimentProfile {
  const entry = asRecord(value)
  if (entry === undefined) throw new Error('Factorio experiment case must be an object')
  const task = typeof entry.inputRef === 'string' ? FACTORIO_EXPERIMENT_TASKS[entry.inputRef] : undefined
  if (task === undefined) throw new Error('Factorio experiment inputRef is not registered')
  const seed = optionalSlot(entry.seed)
  const slot = optionalSlot(entry.slot)
  if (seed !== undefined && slot !== undefined && seed !== slot) {
    throw new Error('Factorio experiment seed must equal slot')
  }
  const resolved = slot ?? seed
  if (resolved === undefined || resolved < 0 || resolved >= options.slots) {
    throw new Error(`Factorio experiment seed must select a configured slot [0, ${options.slots})`)
  }
  const stable = {
    schemaVersion: 'helix.factorio.experiment-profile/v2' as const,
    inputRef: entry.inputRef as string,
    taskId: task.taskId,
    taskDigest: task.taskDigest,
    category: task.category,
    instruction: task.instruction,
    slot: resolved,
    seed: resolved,
  }
  return { ...stable, digest: digest(canonicalJson(stable)) }
}
