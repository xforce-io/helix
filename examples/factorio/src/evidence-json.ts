/**
 * Strict JSON reader for runtime evidence, deliberately separate from the
 * Harness document parser. FLE observations may contain signed or fractional
 * numbers, while Harness documents intentionally do not.
 */

import { HarnessError, type JsonTextValue } from '../../../src/harness/index.js'

function invalid(message: string, details?: unknown): HarnessError {
  return new HarnessError('HARNESS_JSON_INVALID', message, details)
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isHex(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
}

/**
 * Validates complete standard JSON and rejects duplicate object keys before
 * JSON.parse materializes the value. This intentionally permits all finite
 * JSON numbers needed by FLE observations without changing Harness semantics.
 */
class EvidenceJsonScanner {
  private i = 0
  readonly source: string

  constructor(text: string) {
    this.source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }

  parse(): void {
    this.ws()
    if (this.eof()) throw invalid('empty JSON text')
    this.value()
    this.ws()
    if (!this.eof()) throw invalid('trailing content after JSON value', { at: this.i })
  }

  private eof(): boolean { return this.i >= this.source.length }
  private peek(): string { return this.source[this.i] ?? '' }
  private advance(): string { return this.source[this.i++] ?? '' }

  private ws(): void {
    while (/^[ \t\n\r]$/.test(this.peek())) this.advance()
  }

  private value(): void {
    this.ws()
    switch (this.peek()) {
      case '{': this.object(); return
      case '[': this.array(); return
      case '"': this.string(); return
      case 't': this.literal('true'); return
      case 'f': this.literal('false'); return
      case 'n': this.literal('null'); return
      default:
        if (this.peek() === '-' || isDigit(this.peek())) {
          this.number()
          return
        }
        throw invalid('unexpected token', { at: this.i, ch: this.peek() })
    }
  }

  private literal(expected: string): void {
    if (this.source.slice(this.i, this.i + expected.length) !== expected) {
      throw invalid(`invalid literal, expected ${expected}`, { at: this.i })
    }
    this.i += expected.length
  }

  private object(): void {
    this.advance()
    this.ws()
    const keys = new Set<string>()
    if (this.peek() === '}') {
      this.advance()
      return
    }
    while (true) {
      this.ws()
      if (this.peek() !== '"') throw invalid('object key must be string', { at: this.i })
      const key = this.string()
      if (keys.has(key)) throw invalid(`duplicate object key: ${key}`, { at: this.i, key })
      keys.add(key)
      this.ws()
      if (this.advance() !== ':') throw invalid("expected ':'", { at: this.i })
      this.value()
      this.ws()
      const next = this.advance()
      if (next === '}') return
      if (next !== ',') throw invalid('expected , or } in object', { at: this.i })
    }
  }

  private array(): void {
    this.advance()
    this.ws()
    if (this.peek() === ']') {
      this.advance()
      return
    }
    while (true) {
      this.value()
      this.ws()
      const next = this.advance()
      if (next === ']') return
      if (next !== ',') throw invalid('expected , or ] in array', { at: this.i })
    }
  }

  private string(): string {
    const start = this.i
    if (this.advance() !== '"') throw invalid("expected '\"'", { at: this.i })
    while (!this.eof()) {
      const ch = this.advance()
      if (ch === '"') {
        const raw = this.source.slice(start, this.i)
        try {
          return JSON.parse(raw) as string
        } catch {
          throw invalid('invalid JSON string', { at: start })
        }
      }
      if (ch === '\\') {
        const escape = this.advance()
        if ('"\\/bfnrt'.includes(escape)) continue
        if (escape === 'u') {
          for (let count = 0; count < 4; count += 1) {
            if (!isHex(this.advance())) throw invalid('invalid unicode escape', { at: this.i })
          }
          continue
        }
        throw invalid(`invalid escape \\${escape}`, { at: this.i })
      }
      if (ch.charCodeAt(0) < 0x20) throw invalid('unescaped control character in string', { at: this.i })
    }
    throw invalid('unterminated string', { at: start })
  }

  private number(): void {
    const start = this.i
    if (this.peek() === '-') this.advance()
    if (this.peek() === '0') {
      this.advance()
      if (isDigit(this.peek())) throw invalid('leading zero in numeric token', { at: this.i })
    } else {
      if (!isDigit(this.peek())) throw invalid('invalid numeric token', { at: this.i })
      while (isDigit(this.peek())) this.advance()
    }
    if (this.peek() === '.') {
      this.advance()
      if (!isDigit(this.peek())) throw invalid('fraction must contain a digit', { at: this.i })
      while (isDigit(this.peek())) this.advance()
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.advance()
      if (this.peek() === '+' || this.peek() === '-') this.advance()
      if (!isDigit(this.peek())) throw invalid('exponent must contain a digit', { at: this.i })
      while (isDigit(this.peek())) this.advance()
    }
    const value = Number(this.source.slice(start, this.i))
    if (!Number.isFinite(value)) throw invalid('numeric token must be finite', { at: start })
  }
}

export function parseFactorioEvidenceJsonText(text: string): JsonTextValue {
  if (typeof text !== 'string') throw invalid('JSON text must be a string')
  const scanner = new EvidenceJsonScanner(text)
  scanner.parse()
  try {
    return JSON.parse(scanner.source) as JsonTextValue
  } catch {
    throw invalid('runtime evidence JSON text invalid')
  }
}
