/**
 * Fixed-order control-plane renderer (Issue #10 L2 §4.5).
 *
 * Order:
 * 1. systemInstructionTemplate
 * 2. taskNarrativeTemplate + protocolRules + termination
 * 3. resolved catalog card docs (#11)
 * 4. agentSpecs declarative render
 * 5. scenario adapter payload
 * 6. runtime observation / dynamic context
 */

import type {
  ControlPlaneRenderInput,
  HarnessDocument,
  ScenarioPayload,
} from './types.js'

export function renderControlPlane(input: ControlPlaneRenderInput): string {
  const sections: string[] = []
  const doc = input.document

  sections.push(doc.control.systemInstructionTemplate)

  const controlBody: string[] = [doc.control.taskNarrativeTemplate]
  if (doc.control.protocolRules.length > 0) {
    controlBody.push('Protocol rules:')
    for (const rule of doc.control.protocolRules) {
      controlBody.push(`- ${rule}`)
    }
  }
  controlBody.push(
    `Termination: successSource=${doc.control.termination.successSource}`,
  )
  if (doc.control.termination.stopConditions.length > 0) {
    controlBody.push('Stop conditions:')
    for (const stop of doc.control.termination.stopConditions) {
      controlBody.push(`- ${stop}`)
    }
  }
  sections.push(controlBody.join('\n'))

  if (input.catalogDocs.length > 0) {
    const cardParts: string[] = ['## Catalog']
    for (const entry of input.catalogDocs) {
      cardParts.push(`### ${entry.ref.id}@${entry.ref.version}`)
      cardParts.push(entry.doc)
    }
    sections.push(cardParts.join('\n'))
  }

  if (doc.agentSpecs !== undefined && doc.agentSpecs.length > 0) {
    const specParts: string[] = ['## Agent specs (declarative)']
    for (const spec of doc.agentSpecs) {
      specParts.push(`### ${spec.id}`)
      specParts.push(spec.defaultInstruction)
      if (spec.catalogCards.length > 0) {
        specParts.push(
          `Allowed cards: ${spec.catalogCards
            .map((c) => `${c.id}@${c.version}`)
            .join(', ')}`,
        )
      }
      const budgetBits: string[] = []
      if (spec.budget.maxCalls !== undefined) {
        budgetBits.push(`maxCalls=${spec.budget.maxCalls}`)
      }
      if (spec.budget.maxOutputTokens !== undefined) {
        budgetBits.push(`maxOutputTokens=${spec.budget.maxOutputTokens}`)
      }
      if (budgetBits.length > 0) {
        specParts.push(`Budget shape: ${budgetBits.join(', ')}`)
      }
    }
    sections.push(specParts.join('\n'))
  }

  const scenarioText = renderScenarioPayload(input.scenario)
  if (scenarioText.length > 0) {
    sections.push(scenarioText)
  }

  if (
    input.runtimeObservation !== undefined &&
    input.runtimeObservation.length > 0
  ) {
    sections.push(input.runtimeObservation)
  }

  return sections.join('\n\n')
}

export function renderSystemInstruction(document: HarnessDocument): string {
  return document.control.systemInstructionTemplate
}

function renderScenarioPayload(scenario: ScenarioPayload): string {
  const parts: string[] = []
  if (scenario.taskNarrative !== undefined && scenario.taskNarrative.length > 0) {
    parts.push('## Scenario task')
    parts.push(scenario.taskNarrative)
  }
  if (
    scenario.environmentNarrative !== undefined &&
    scenario.environmentNarrative.length > 0
  ) {
    parts.push('## Scenario environment')
    parts.push(scenario.environmentNarrative)
  }
  if (scenario.extraSections !== undefined) {
    for (const section of scenario.extraSections) {
      parts.push(`## ${section.title}`)
      parts.push(section.body)
    }
  }
  return parts.join('\n')
}
