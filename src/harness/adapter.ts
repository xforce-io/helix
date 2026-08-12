/**
 * ExampleScenarioAdapter is the only scenario contact point for generic core.
 * Concrete scenarios implement this at the Host composition root.
 */

import type { ExampleScenarioAdapter, ScenarioPayload } from './types.js'

export type { ExampleScenarioAdapter, ScenarioPayload }

/**
 * Minimal fixture adapter used by core unit/integration tests.
 * Must not be imported by production scenario Host paths as a default.
 */
export function createFixtureScenarioAdapter(options: {
  scenarioId?: string
  taskNarrative?: string
  environmentNarrative?: string
} = {}): ExampleScenarioAdapter {
  const scenarioId = options.scenarioId ?? 'fixture.scenario'
  const taskNarrative =
    options.taskNarrative ?? 'Fixture task narrative from ExampleScenarioAdapter.'
  const environmentNarrative =
    options.environmentNarrative ?? 'Fixture environment narrative.'
  return {
    scenarioId,
    buildScenarioPayload: () => ({
      taskNarrative,
      environmentNarrative,
    }),
  }
}
