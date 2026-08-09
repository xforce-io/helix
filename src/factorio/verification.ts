import type { TaskOutcomeValue } from 'milkie'
import type { Event } from 'milkie/dist/trace/types.js'
import type {
  CellExecutionRecord,
  EpisodeProjection,
  TerminationReason,
} from './types.js'

export interface VerificationCheck {
  id: string
  passed: boolean
  detail?: string
}

function count(events: Event[], type: string): number {
  return events.filter(event => event.type === type).length
}

export function traceChecksBeforeFinalization(
  events: Event[],
  modelCallCount: number,
  toolCallCount: number,
): VerificationCheck[] {
  return [
    {
      id: 'S1.milkie-trace-before-finalization',
      passed:
        count(events, 'llm.requested') === modelCallCount &&
        count(events, 'llm.responded') === modelCallCount &&
        count(events, 'tool.requested') === toolCallCount &&
        count(events, 'tool.responded') === toolCallCount &&
        count(events, 'agent.run.completed') === 1 &&
        count(events, 'task.outcome.recorded') === 0,
      detail: `${events.length} events before finalization`,
    },
  ]
}

export function decideFinalOutcome(
  checks: VerificationCheck[],
  termination: TerminationReason,
): TaskOutcomeValue {
  if (
    termination === 'cancelled' ||
    termination === 'uncertain_effect' ||
    termination === 'kernel_resource_exhausted'
  ) {
    return 'unknown'
  }
  if (termination === 'verifier_succeeded') {
    return checks.every(check => check.passed) ? 'success' : 'failure'
  }
  return 'failure'
}

export function finalizationEvidenceEventIds(
  events: Event[],
  projection: EpisodeProjection,
  termination: TerminationReason,
): [string, string] {
  const completions = events.filter(event => event.type === 'agent.run.completed')
  if (completions.length !== 1) {
    throw new Error(`expected exactly one agent.run.completed, got ${completions.length}`)
  }
  const lastCell = projection.cells.at(-1)
  const verifierTerminal = [...events].reverse().find(event => {
    if (event.type !== 'tool.responded') return false
    const payload = event.payload as { status?: unknown; output?: unknown }
    if (payload.status !== 'ok' || !lastCell) return false
    const output = payload.output as { cellId?: unknown; factorioEffect?: { verification?: { success?: unknown } } }
    if (output?.cellId !== lastCell.cellId) return false
    return !projection.verification.success || output.factorioEffect?.verification?.success === true
  })
  const latestTerminal = [...events]
    .reverse()
    .find(event => event.type === 'llm.responded' || event.type === 'tool.responded')
  const terminal =
    termination === 'verifier_succeeded' ? verifierTerminal : latestTerminal
  if (!terminal) throw new Error('no terminal event is available as finalization evidence')
  return [terminal.id, completions[0]!.id]
}

export function episodeContinuityCheck(records: CellExecutionRecord[]): VerificationCheck {
  const effects = records.flatMap(record => (record.factorioEffect ? [record.factorioEffect] : []))
  let previousStateHash: string | undefined
  let expectedStep = 0
  const commandIds = new Set<string>()
  let passed = effects.length > 0
  for (const effect of effects) {
    passed =
      passed &&
      effect.stepIndex === expectedStep &&
      effect.commandId.startsWith(`${effect.episodeId}:command:`) &&
      !commandIds.has(effect.commandId) &&
      (expectedStep === 0
        ? effect.method === 'reset' && effect.inputStateRef === undefined
        : effect.method === 'step' && effect.inputStateRef?.hash === previousStateHash)
    commandIds.add(effect.commandId)
    previousStateHash = effect.outputStateRef.hash
    expectedStep += 1
  }
  return {
    id: 'S1.episode-continuity',
    passed,
    detail: `${effects.length} effects, nextStep=${expectedStep}`,
  }
}
