/**
 * Factorio scenario historical harness payloads and adapter.
 *
 * These documents are scenario fixtures consumed by Host composition and the
 * legacy selection registry. They are NOT part of generic harness core.
 */

import type {
  ExampleScenarioAdapter,
  HarnessDocument,
} from '../../../src/harness/index.js'

/** Historical v4 strategy payload (code/protocol pin factorio-rlm/v4). */
export const FACTORIO_V4_HARNESS_DOCUMENT: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: `You are the model that owns a persistent IPython execution session.
Your task is to solve the real Factorio Learning Environment task shown in the ContextEnvelope.

You have exactly one external tool: execute_cell(code). Every call runs one Python cell in the same persistent IPython namespace. You—not the harness—must write every cell and every Factorio action program.

Protocol:
1. Your first environment effect must be a cell containing factorio.reset(). Read its returned task information, inventory, positions, and verification state.
2. On later turns, use the actual prior cell result to decide the next cell. Submit at most one external effect per cell: either factorio.reset()/factorio.step(program) OR helix.models.call(...), never both in the same cell.
3. factorio.step accepts a Python source string executed in FLE's public namespace. Resource, Prototype, Direction, Position, and BuildingBox are already defined there—NEVER add import statements inside the action string. After reset, factorioEffect.actionCapabilities is the canonical allowlist. Call only names in that list; never guess an API name. Useful signatures include nearest(Resource.IronOre), move_to(Position(...)), place_entity(Prototype.X, direction=Direction.DOWN, position=Position(...)), place_entity_next_to(Prototype.X, reference_position, Direction.DOWN), insert_item(Prototype.Coal, target_entity, quantity=50), get_entities(), pickup_entity(entity), and nearest_buildable(prototype, BuildingBox(width=..., height=...), center_position).
4. When capabilities.recursiveModel.enabled is true, you may call helix.models.call(instructions, input=None, max_output_tokens=None) in its own cell to run a bounded recursive model query. It returns a RecursiveModelResult with status/text/usage/child_run_id/response_ref. Read those fields in later cells; do not expect the full response to be expanded into outer context automatically. Recursive calls share the parent remainingRecursiveModelTokens pool and remainingRecursiveModelCalls count.
5. Imports in either the outer cell or action string, files, shell/process/network APIs, dynamic execution, private attributes, and raw RCON are forbidden. A policy violation terminates the run. Keep an action program below 10,000 characters.
6. Inspect errors and observations and correct your program. Continue until task_verification.success is true. Do not claim success yourself; only the environment verifier decides.

Call factorio.reset() exactly once, in the first cell. Never reset again after it succeeds.

Use execute_cell for action, not prose. Never ask the harness to provide a solution.
Every response must contain exactly one non-empty execute_cell call. Do not emit analysis, planning, or prose outside that call. Keep each cell and any factorio.step program concise (under 4,000 characters), and print only compact metrics rather than full observations.`,
    taskNarrativeTemplate:
      'Create an automatic iron-ore factory that produces at least 16 iron-ore per 60 in-game seconds.',
    protocolRules: [
      'First environment effect must call factorio.reset() exactly once.',
      'Never use import statements in outer cells or Factorio action strings.',
      'At most one external effect per cell.',
      'Only call Factorio action APIs listed in actionCapabilities after reset.',
      'Do not claim success; only the environment verifier decides.',
    ],
    termination: {
      successSource: 'scenario-verifier',
      stopConditions: [
        'task_verification.success is true',
        'policy violation',
        'uncertain environment effect',
        'model or cell budget exhausted',
      ],
    },
  },
  catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
  compatibility: {
    codeProtocolPins: ['factorio-rlm/v4'],
  },
}

/** Historical v5 strategy payload (code/protocol pin factorio-rlm/v5, session-async). */
export const FACTORIO_V5_HARNESS_DOCUMENT: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: FACTORIO_V4_HARNESS_DOCUMENT.control.systemInstructionTemplate,
    taskNarrativeTemplate: FACTORIO_V4_HARNESS_DOCUMENT.control.taskNarrativeTemplate,
    protocolRules: [
      ...FACTORIO_V4_HARNESS_DOCUMENT.control.protocolRules,
      'When session-async is enabled, agents.spawn/mailbox follow helix.session card contracts.',
    ],
    termination: {
      successSource: 'scenario-verifier',
      stopConditions: [
        ...FACTORIO_V4_HARNESS_DOCUMENT.control.termination.stopConditions,
      ],
    },
  },
  catalogCards: [
    { id: 'helix.models', version: '1.0.0' },
    { id: 'helix.session', version: '1.0.0' },
  ],
  compatibility: {
    codeProtocolPins: ['factorio-rlm/v5'],
  },
}

/**
 * Default Factorio P1 baseline document used by new-format Host composition
 * for the #5-compatible (v4 / non-session-async) path.
 * Models card only — helix.session is not available under v4 bindings.
 * Explicitly published into HarnessStateStore; never loaded as a silent source fallback.
 */
export const FACTORIO_DEFAULT_P1_HARNESS_DOCUMENT: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate:
      FACTORIO_V4_HARNESS_DOCUMENT.control.systemInstructionTemplate,
    taskNarrativeTemplate:
      FACTORIO_V4_HARNESS_DOCUMENT.control.taskNarrativeTemplate,
    protocolRules: [...FACTORIO_V4_HARNESS_DOCUMENT.control.protocolRules],
    termination: {
      successSource: 'scenario-verifier',
      stopConditions: [
        ...FACTORIO_V4_HARNESS_DOCUMENT.control.termination.stopConditions,
      ],
    },
  },
  catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
  compatibility: {
    codeProtocolPins: ['factorio-rlm/v4'],
  },
}

/**
 * P2 keeps P1's task and immutable safety boundary, but makes the two runtime
 * representations that repeatedly caused real-run failures explicit.  It is a
 * new baseline rather than a mutation of P1 so old live evidence remains
 * replayable by its recorded content hash.
 */
export const FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: `${FACTORIO_V4_HARNESS_DOCUMENT.control.systemInstructionTemplate}

IPython/FLE result contract:
- factorio.reset() and factorio.step(program) return an EffectResult. Read it with result.observation, result.refs, result.metrics, result.get('observation'), or result['observation']. It has no factorioEffect, status, stdout, or rawText attribute.
- Keep result inspection in the outer IPython cell. The string passed to factorio.step is a separately restricted FLE action program: call only top-level names from actionCapabilities. Do not call any object method there (including append, get, keys, or attributes); use literals, comprehensions, indexing, and the listed top-level functions instead.
- Pass an actual Position(x=..., y=...) to place_entity. Do not pass an uninspected helper return value as a placement position. If a placement fails, print the compact observation, then make one small correction in the next cell.
- Do not dump inventories or all entities. Print only the few positions, statuses, warnings, quantities, and taskVerification fields needed for the next action.`,
    taskNarrativeTemplate:
      FACTORIO_V4_HARNESS_DOCUMENT.control.taskNarrativeTemplate,
    protocolRules: [...FACTORIO_V4_HARNESS_DOCUMENT.control.protocolRules],
    termination: {
      successSource: 'scenario-verifier',
      stopConditions: [
        ...FACTORIO_V4_HARNESS_DOCUMENT.control.termination.stopConditions,
      ],
    },
  },
  catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
  compatibility: {
    codeProtocolPins: ['factorio-rlm/v4'],
  },
}

/** P3 is the immutable follow-up to the real P2 allowlist-error evidence. */
export const FACTORIO_DEFAULT_P3_HARNESS_DOCUMENT: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: {
    systemInstructionTemplate: `${FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT.control.systemInstructionTemplate}

Action-program hard boundary:
- Before calling factorio.step, keep its program straight-line and make no dotted call at all. In particular, dict.get, list.append, get_resource_field, and every invented get_* helper are unavailable there.
- A rejected action has no environment effect. On ACTION_CALL_NOT_ALLOWED, remove that call and use only a known allowlisted top-level alternative in the next cell; do not probe more methods.`,
    taskNarrativeTemplate:
      FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT.control.taskNarrativeTemplate,
    protocolRules: [...FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT.control.protocolRules],
    termination: {
      successSource: 'scenario-verifier',
      stopConditions: [
        ...FACTORIO_DEFAULT_P2_HARNESS_DOCUMENT.control.termination.stopConditions,
      ],
    },
  },
  catalogCards: [{ id: 'helix.models', version: '1.0.0' }],
  compatibility: {
    codeProtocolPins: ['factorio-rlm/v4'],
  },
}

export const FACTORIO_TASK_NARRATIVE =
  'Create an automatic iron-ore factory that produces at least 16 iron-ore per 60 in-game seconds.'

export const FACTORIO_ENVIRONMENT_NARRATIVE = `Factorio Learning Environment (FLE) iron_ore_throughput task.
Persistent IPython kernel with factorio.reset()/factorio.step(program) bindings.
Environment verifier owns task_verification.success.`

export function createFactorioScenarioAdapter(): ExampleScenarioAdapter {
  return {
    scenarioId: 'factorio.iron_ore_throughput',
    buildScenarioPayload: () => ({
      taskNarrative: FACTORIO_TASK_NARRATIVE,
      environmentNarrative: FACTORIO_ENVIRONMENT_NARRATIVE,
      extraSections: [
        {
          title: 'Scenario acceptance',
          body: 'task_verification.success=true as decided by the FLE verifier.',
        },
      ],
    }),
  }
}
