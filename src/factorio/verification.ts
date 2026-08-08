import type { TaskOutcomeValue } from 'milkie'
import type { Event } from 'milkie/dist/trace/types.js'
import type { CellExecutionRecord } from './types.js'

export interface VerificationCheck {
  id: string
  passed: boolean
  detail?: string
}

function count(events: Event[], type: string): number {
  return events.filter(event => event.type === type).length
}

export function traceChecksBeforeOutcome(
  events: Event[],
  modelCallCount: number,
  cellCount: number,
): VerificationCheck[] {
  return [
    {
      id: 'S1.milkie-trace-before-outcome',
      passed:
        count(events, 'llm.requested') === modelCallCount &&
        count(events, 'llm.responded') === modelCallCount &&
        count(events, 'tool.requested') === cellCount &&
        count(events, 'tool.responded') === cellCount &&
        count(events, 'task.outcome.recorded') === 0,
      detail: `${events.length} events before outcome`,
    },
  ]
}

export function decideOutcome(
  checks: VerificationCheck[],
  uncertain: boolean,
): TaskOutcomeValue {
  if (uncertain) return 'unknown'
  return checks.every(check => check.passed) ? 'success' : 'failure'
}

export function episodeContinuityCheck(records: CellExecutionRecord[]): VerificationCheck {
  const effects = records.flatMap(record => (record.factorioEffect ? [record.factorioEffect] : []))
  let previousStateHash: string | undefined
  let expectedStep = 0
  let passed = effects.length > 0
  for (const effect of effects) {
    passed =
      passed &&
      effect.stepIndex === expectedStep &&
      effect.commandId === `${effect.episodeId}:${effect.stepIndex}` &&
      (expectedStep === 0
        ? effect.method === 'reset' && effect.inputStateRef === undefined
        : effect.method === 'step' && effect.inputStateRef?.hash === previousStateHash)
    previousStateHash = effect.outputStateRef.hash
    expectedStep += 1
  }
  return {
    id: 'S1.episode-continuity',
    passed,
    detail: `${effects.length} effects, nextStep=${expectedStep}`,
  }
}
