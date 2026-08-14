import { createHash } from 'node:crypto'

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value))
}

export function digest(value: unknown): string {
  const bytes = typeof value === 'string' ? value : canonicalJson(value)
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
