import { getProductionCard } from './registry.js'
import type { CapabilityCard } from './types.js'

/**
 * Render model-visible card documentation for a pinned id+version.
 * Stable bytes for the same identity; never auto-latest.
 */
export function renderCardDoc(id: string, version: string): string {
  const card = getProductionCard(id, version)
  return renderCardDocFromCard(card)
}

export function renderCardDocFromCard(card: CapabilityCard): string {
  const title = card.doc.title.trimEnd()
  const body = normalizeNewlines(card.doc.body)
  // Stable envelope: title heading + blank line + body, trailing single newline.
  const text = `# ${title}\n\n${body}`
  return normalizeNewlines(text).replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n')
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
