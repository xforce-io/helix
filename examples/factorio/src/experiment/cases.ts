/** Closed task and FLE-slot registry for the Factorio self-evolution experiment. */

import { canonicalJson, digest } from '../canonical.js'

type TaskDefinition = { taskId: string; category: string; instruction: string }

export const FACTORIO_EXPERIMENT_TASKS: Record<string, TaskDefinition> = {
  'factorio.throughput/iron-ore/v1': {
    taskId: 'iron_ore_throughput', category: 'raw-material',
    instruction: 'Solve the FLE iron_ore_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/iron-plate/v1': {
    taskId: 'iron_plate_throughput', category: 'raw-material',
    instruction: 'Solve the FLE iron_plate_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/iron-gear-wheel/v1': {
    taskId: 'iron_gear_wheel_throughput', category: 'intermediate',
    instruction: 'Solve the FLE iron_gear_wheel_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/inserter/v1': {
    taskId: 'inserter_throughput', category: 'intermediate',
    instruction: 'Solve the FLE inserter_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/electronic-circuit/v1': {
    taskId: 'electronic_circuit_throughput', category: 'intermediate',
    instruction: 'Solve the FLE electronic_circuit_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/steel-plate/v1': {
    taskId: 'steel_plate_throughput', category: 'advanced',
    instruction: 'Solve the FLE steel_plate_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/advanced-circuit/v1': {
    taskId: 'advanced_circuit_throughput', category: 'advanced',
    instruction: 'Solve the FLE advanced_circuit_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/engine-unit/v1': {
    taskId: 'engine_unit_throughput', category: 'advanced',
    instruction: 'Solve the FLE engine_unit_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/automation-science-pack/v1': {
    taskId: 'automation_science_pack_throughput', category: 'science',
    instruction: 'Solve the FLE automation_science_pack_throughput task through model-owned persistent IPython cells.',
  },
  'factorio.throughput/logistics-science-pack/v1': {
    taskId: 'logistics_science_pack_throughput', category: 'science',
    instruction: 'Solve the FLE logistics_science_pack_throughput task through model-owned persistent IPython cells.',
  },
}

export type FactorioExperimentProfile = {
  schemaVersion: 'helix.factorio.experiment-profile/v2'
  inputRef: string
  taskId: string
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
    category: task.category,
    instruction: task.instruction,
    slot: entry.seed as number,
    seed: entry.seed as number,
  }
  return { ...stable, digest: digest(canonicalJson(stable)) }
}
