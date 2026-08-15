/**
 * Strict JSON text parser for harness payloads.
 *
 * Requirements (Issue #10 L2 §4.1):
 * - Reject duplicate object keys before any object materialization.
 * - Reject non-canonical numeric tokens (01, 1.0, 1e0, -0).
 * - Never call JSON.parse / first-wins / last-wins materialization paths.
 */

import { harnessError } from './errors.js'

export type JsonTextValue =
  | null
  | boolean
  | number
  | string
  | JsonTextValue[]
  | { [key: string]: JsonTextValue }

export type ParsedJsonText = {
  value: JsonTextValue
  /** Original source with BOM stripped, used only for diagnostics. */
  source: string
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER

function isHexDigit(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

type JsonTextParseOptions = {
  /**
   * Harness documents only admit canonical non-negative safe integers. Recorded
   * runtime evidence may legitimately contain signed/fractional observations.
   */
  allowStandardJsonNumbers?: boolean
}

class JsonTextScanner {
  readonly source: string
  private i = 0
  private readonly allowStandardJsonNumbers: boolean

  constructor(source: string, options: JsonTextParseOptions = {}) {
    // Strip a single leading UTF-8 BOM if present; output canonical never emits BOM.
    this.source = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
    this.allowStandardJsonNumbers = options.allowStandardJsonNumbers === true
  }

  parse(): JsonTextValue {
    this.skipWs()
    if (this.eof()) {
      throw harnessError('HARNESS_JSON_INVALID', 'empty JSON text')
    }
    const value = this.parseValue()
    this.skipWs()
    if (!this.eof()) {
      throw harnessError('HARNESS_JSON_INVALID', 'trailing content after JSON value', {
        at: this.i,
      })
    }
    return value
  }

  private eof(): boolean {
    return this.i >= this.source.length
  }

  private peek(): string {
    return this.source[this.i] ?? ''
  }

  private advance(): string {
    const ch = this.source[this.i] ?? ''
    this.i += 1
    return ch
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) {
      throw harnessError('HARNESS_JSON_INVALID', `expected '${ch}'`, { at: this.i })
    }
    this.advance()
  }

  private skipWs(): void {
    while (!this.eof()) {
      const ch = this.peek()
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.advance()
        continue
      }
      break
    }
  }

  private parseValue(): JsonTextValue {
    this.skipWs()
    const ch = this.peek()
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '"') return this.parseString()
    if (ch === 't') return this.parseLiteral('true', true)
    if (ch === 'f') return this.parseLiteral('false', false)
    if (ch === 'n') return this.parseLiteral('null', null)
    if (ch === '-' || isDigit(ch)) return this.parseNumber()
    throw harnessError('HARNESS_JSON_INVALID', 'unexpected token', {
      at: this.i,
      ch,
    })
  }

  private parseLiteral(literal: string, value: JsonTextValue): JsonTextValue {
    for (let k = 0; k < literal.length; k += 1) {
      if (this.advance() !== literal[k]) {
        throw harnessError('HARNESS_JSON_INVALID', `invalid literal, expected ${literal}`, {
          at: this.i,
        })
      }
    }
    return value
  }

  private parseObject(): { [key: string]: JsonTextValue } {
    this.expect('{')
    this.skipWs()
    const out: { [key: string]: JsonTextValue } = Object.create(null)
    const seen = new Set<string>()
    if (this.peek() === '}') {
      this.advance()
      return out
    }
    while (true) {
      this.skipWs()
      if (this.peek() !== '"') {
        throw harnessError('HARNESS_JSON_INVALID', 'object key must be string', {
          at: this.i,
        })
      }
      const key = this.parseString()
      if (seen.has(key)) {
        throw harnessError('HARNESS_JSON_INVALID', `duplicate object key: ${key}`, {
          key,
          at: this.i,
        })
      }
      seen.add(key)
      this.skipWs()
      this.expect(':')
      const value = this.parseValue()
      out[key] = value
      this.skipWs()
      const next = this.peek()
      if (next === ',') {
        this.advance()
        continue
      }
      if (next === '}') {
        this.advance()
        break
      }
      throw harnessError('HARNESS_JSON_INVALID', 'expected , or } in object', {
        at: this.i,
      })
    }
    return out
  }

  private parseArray(): JsonTextValue[] {
    this.expect('[')
    this.skipWs()
    const out: JsonTextValue[] = []
    if (this.peek() === ']') {
      this.advance()
      return out
    }
    while (true) {
      out.push(this.parseValue())
      this.skipWs()
      const next = this.peek()
      if (next === ',') {
        this.advance()
        continue
      }
      if (next === ']') {
        this.advance()
        break
      }
      throw harnessError('HARNESS_JSON_INVALID', 'expected , or ] in array', {
        at: this.i,
      })
    }
    return out
  }

  private parseString(): string {
    this.expect('"')
    let result = ''
    while (!this.eof()) {
      const ch = this.advance()
      if (ch === '"') return result
      if (ch === '\\') {
        const esc = this.advance()
        switch (esc) {
          case '"':
            result += '"'
            break
          case '\\':
            result += '\\'
            break
          case '/':
            result += '/'
            break
          case 'b':
            result += '\b'
            break
          case 'f':
            result += '\f'
            break
          case 'n':
            result += '\n'
            break
          case 'r':
            result += '\r'
            break
          case 't':
            result += '\t'
            break
          case 'u': {
            let hex = ''
            for (let k = 0; k < 4; k += 1) {
              const h = this.advance()
              if (!isHexDigit(h)) {
                throw harnessError('HARNESS_JSON_INVALID', 'invalid unicode escape', {
                  at: this.i,
                })
              }
              hex += h
            }
            const code = Number.parseInt(hex, 16)
            // Reject lone surrogates in decoded string values.
            if (code >= 0xd800 && code <= 0xdfff) {
              // Allow well-formed surrogate pairs only.
              if (code >= 0xdc00) {
                throw harnessError(
                  'HARNESS_JSON_INVALID',
                  'lone low surrogate in string',
                  { code },
                )
              }
              // Expect immediately following \uDC00-\uDFFF
              if (this.peek() !== '\\') {
                throw harnessError(
                  'HARNESS_JSON_INVALID',
                  'lone high surrogate in string',
                  { code },
                )
              }
              this.advance()
              if (this.advance() !== 'u') {
                throw harnessError(
                  'HARNESS_JSON_INVALID',
                  'lone high surrogate in string',
                  { code },
                )
              }
              let hex2 = ''
              for (let k = 0; k < 4; k += 1) {
                const h = this.advance()
                if (!isHexDigit(h)) {
                  throw harnessError('HARNESS_JSON_INVALID', 'invalid unicode escape', {
                    at: this.i,
                  })
                }
                hex2 += h
              }
              const low = Number.parseInt(hex2, 16)
              if (low < 0xdc00 || low > 0xdfff) {
                throw harnessError(
                  'HARNESS_JSON_INVALID',
                  'invalid surrogate pair in string',
                  { high: code, low },
                )
              }
              const cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
              result += String.fromCodePoint(cp)
            } else {
              result += String.fromCharCode(code)
            }
            break
          }
          default:
            throw harnessError('HARNESS_JSON_INVALID', `invalid escape \\${esc}`, {
              at: this.i,
            })
        }
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        throw harnessError(
          'HARNESS_JSON_INVALID',
          'unescaped control character in string',
          { at: this.i, code },
        )
      }
      // Reject lone surrogates appearing as raw UTF-16 code units in source.
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = this.peek()
        const nextCode = next.charCodeAt(0)
        if (!(nextCode >= 0xdc00 && nextCode <= 0xdfff)) {
          throw harnessError('HARNESS_JSON_INVALID', 'lone high surrogate in string', {
            code,
          })
        }
        result += ch + this.advance()
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        throw harnessError('HARNESS_JSON_INVALID', 'lone low surrogate in string', {
          code,
        })
      }
      result += ch
    }
    throw harnessError('HARNESS_JSON_INVALID', 'unterminated string', { at: this.i })
  }

  /**
   * Accept only non-negative safe integers in shortest decimal lexical form:
   * `0` or `[1-9][0-9]*`. Reject `01`, `1.0`, `1e0`, `-0`, negatives, floats.
   */
  private parseNumber(): number {
    if (this.allowStandardJsonNumbers) {
      return this.parseStandardJsonNumber()
    }
    const start = this.i
    if (this.peek() === '-') {
      // Negative numbers are never valid for harness numeric fields; reject at
      // the JSON text boundary so lexical form is never lost.
      throw harnessError(
        'HARNESS_JSON_INVALID',
        'negative numeric token is not allowed in harness JSON',
        { at: this.i },
      )
    }
    if (this.peek() === '0') {
      this.advance()
      const next = this.peek()
      if (isDigit(next)) {
        throw harnessError(
          'HARNESS_JSON_INVALID',
          'leading zero in numeric token',
          { token: this.source.slice(start, this.i + 1) },
        )
      }
      if (next === '.' || next === 'e' || next === 'E') {
        throw harnessError(
          'HARNESS_JSON_INVALID',
          'non-integer numeric token',
          { tokenPreview: this.source.slice(start, Math.min(this.source.length, start + 16)) },
        )
      }
      return 0
    }
    if (!isDigit(this.peek()) || this.peek() === '0') {
      throw harnessError('HARNESS_JSON_INVALID', 'invalid numeric token', { at: this.i })
    }
    while (isDigit(this.peek())) {
      this.advance()
    }
    const next = this.peek()
    if (next === '.' || next === 'e' || next === 'E') {
      throw harnessError(
        'HARNESS_JSON_INVALID',
        'non-integer numeric token',
        { tokenPreview: this.source.slice(start, Math.min(this.source.length, start + 16)) },
      )
    }
    const token = this.source.slice(start, this.i)
    // token is [1-9][0-9]*
    if (token.length > 16) {
      // Definitely beyond max safe integer decimal length (16 digits max for 2^53-1).
      throw harnessError(
        'HARNESS_JSON_INVALID',
        'numeric token exceeds max safe integer',
        { token },
      )
    }
    const value = Number(token)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw harnessError(
        'HARNESS_JSON_INVALID',
        'numeric token is not a non-negative safe integer',
        { token },
      )
    }
    // Guard against precision loss for long digit strings within 16 chars.
    if (String(value) !== token) {
      throw harnessError(
        'HARNESS_JSON_INVALID',
        'numeric token is not a non-negative safe integer',
        { token },
      )
    }
    if (value > MAX_SAFE) {
      throw harnessError(
        'HARNESS_JSON_INVALID',
        'numeric token exceeds max safe integer',
        { token },
      )
    }
    return value
  }

  /** Parse a JSON number without weakening object-key duplicate detection. */
  private parseStandardJsonNumber(): number {
    const start = this.i
    if (this.peek() === '-') this.advance()
    if (this.peek() === '0') {
      this.advance()
      if (isDigit(this.peek())) {
        throw harnessError('HARNESS_JSON_INVALID', 'leading zero in numeric token', { at: this.i })
      }
    } else {
      if (!isDigit(this.peek())) {
        throw harnessError('HARNESS_JSON_INVALID', 'invalid numeric token', { at: this.i })
      }
      while (isDigit(this.peek())) this.advance()
    }
    if (this.peek() === '.') {
      this.advance()
      if (!isDigit(this.peek())) {
        throw harnessError('HARNESS_JSON_INVALID', 'fraction must contain a digit', { at: this.i })
      }
      while (isDigit(this.peek())) this.advance()
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.advance()
      if (this.peek() === '+' || this.peek() === '-') this.advance()
      if (!isDigit(this.peek())) {
        throw harnessError('HARNESS_JSON_INVALID', 'exponent must contain a digit', { at: this.i })
      }
      while (isDigit(this.peek())) this.advance()
    }
    const token = this.source.slice(start, this.i)
    const value = Number(token)
    if (!Number.isFinite(value)) {
      throw harnessError('HARNESS_JSON_INVALID', 'numeric token must be finite', { token })
    }
    return value
  }
}

/**
 * Parse harness JSON text. Rejects duplicate keys and non-canonical numbers
 * before any consumer schema validation.
 */
export function parseHarnessJsonText(
  text: string,
  options: JsonTextParseOptions = {},
): ParsedJsonText {
  if (typeof text !== 'string') {
    throw harnessError('HARNESS_JSON_INVALID', 'JSON text must be a string')
  }
  const scanner = new JsonTextScanner(text, options)
  const value = scanner.parse()
  return { value, source: scanner.source }
}

/**
 * Independent second parser implementation used only for cross-checks in tests
 * and dual-path admission. Same acceptance criteria, separate code path.
 */
export function parseHarnessJsonTextAlt(text: string): ParsedJsonText {
  // Deliberately re-implements the same rules with a different structure so
  // tests can assert dual independent rejection of duplicate keys / bad numbers.
  if (typeof text !== 'string') {
    throw harnessError('HARNESS_JSON_INVALID', 'JSON text must be a string')
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let i = 0

  const fail = (message: string, details?: unknown): never => {
    throw harnessError('HARNESS_JSON_INVALID', message, details)
  }

  const eof = () => i >= source.length
  const peek = () => source[i] ?? ''
  const adv = () => {
    const ch = source[i] ?? ''
    i += 1
    return ch
  }
  const skipWs = () => {
    while (!eof()) {
      const ch = peek()
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        adv()
        continue
      }
      break
    }
  }

  const parseString = (): string => {
    if (adv() !== '"') fail('string must start with quote', { at: i })
    const chars: string[] = []
    while (!eof()) {
      const ch = adv()
      if (ch === '"') return chars.join('')
      if (ch === '\\') {
        const esc = adv()
        if (esc === '"' || esc === '\\' || esc === '/') chars.push(esc === '/' ? '/' : esc)
        else if (esc === 'b') chars.push('\b')
        else if (esc === 'f') chars.push('\f')
        else if (esc === 'n') chars.push('\n')
        else if (esc === 'r') chars.push('\r')
        else if (esc === 't') chars.push('\t')
        else if (esc === 'u') {
          let hex = ''
          for (let k = 0; k < 4; k += 1) {
            const h = adv()
            if (!isHexDigit(h)) fail('invalid unicode escape', { at: i })
            hex += h
          }
          const code = Number.parseInt(hex, 16)
          if (code >= 0xd800 && code <= 0xdbff) {
            if (peek() !== '\\') fail('lone high surrogate in string', { code })
            adv()
            if (adv() !== 'u') fail('lone high surrogate in string', { code })
            let hex2 = ''
            for (let k = 0; k < 4; k += 1) {
              const h = adv()
              if (!isHexDigit(h)) fail('invalid unicode escape', { at: i })
              hex2 += h
            }
            const low = Number.parseInt(hex2, 16)
            if (low < 0xdc00 || low > 0xdfff) {
              fail('invalid surrogate pair in string', { high: code, low })
            }
            const cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
            chars.push(String.fromCodePoint(cp))
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            fail('lone low surrogate in string', { code })
          } else {
            chars.push(String.fromCharCode(code))
          }
        } else fail(`invalid escape \\${esc}`, { at: i })
        continue
      }
      const code = ch.charCodeAt(0)
      if (code < 0x20) fail('unescaped control character in string', { code })
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = peek()
        const nextCode = next.charCodeAt(0)
        if (!(nextCode >= 0xdc00 && nextCode <= 0xdfff)) {
          fail('lone high surrogate in string', { code })
        }
        chars.push(ch, adv())
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) fail('lone low surrogate in string', { code })
      chars.push(ch)
    }
    return fail('unterminated string', { at: i })
  }

  const parseNumber = (): number => {
    const start = i
    if (peek() === '-') {
      fail('negative numeric token is not allowed in harness JSON', { at: i })
    }
    if (peek() === '0') {
      adv()
      const n = peek()
      if (isDigit(n)) fail('leading zero in numeric token')
      if (n === '.' || n === 'e' || n === 'E') fail('non-integer numeric token')
      return 0
    }
    if (!isDigit(peek())) fail('invalid numeric token', { at: i })
    while (isDigit(peek())) adv()
    const n = peek()
    if (n === '.' || n === 'e' || n === 'E') fail('non-integer numeric token')
    const token = source.slice(start, i)
    if (token.length > 16) fail('numeric token exceeds max safe integer', { token })
    const value = Number(token)
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== token) {
      fail('numeric token is not a non-negative safe integer', { token })
    }
    return value
  }

  const parseLiteral = (lit: string, value: JsonTextValue): JsonTextValue => {
    for (let k = 0; k < lit.length; k += 1) {
      if (adv() !== lit[k]) fail(`invalid literal, expected ${lit}`, { at: i })
    }
    return value
  }

  const parseValue = (): JsonTextValue => {
    skipWs()
    const ch = peek()
    if (ch === '{') {
      adv()
      skipWs()
      const obj: { [key: string]: JsonTextValue } = Object.create(null)
      const seen = new Set<string>()
      if (peek() === '}') {
        adv()
        return obj
      }
      while (true) {
        skipWs()
        if (peek() !== '"') fail('object key must be string', { at: i })
        const key = parseString()
        if (seen.has(key)) fail(`duplicate object key: ${key}`, { key })
        seen.add(key)
        skipWs()
        if (adv() !== ':') fail('expected : after key', { at: i })
        obj[key] = parseValue()
        skipWs()
        const next = peek()
        if (next === ',') {
          adv()
          continue
        }
        if (next === '}') {
          adv()
          break
        }
        fail('expected , or } in object', { at: i })
      }
      return obj
    }
    if (ch === '[') {
      adv()
      skipWs()
      const arr: JsonTextValue[] = []
      if (peek() === ']') {
        adv()
        return arr
      }
      while (true) {
        arr.push(parseValue())
        skipWs()
        const next = peek()
        if (next === ',') {
          adv()
          continue
        }
        if (next === ']') {
          adv()
          break
        }
        fail('expected , or ] in array', { at: i })
      }
      return arr
    }
    if (ch === '"') return parseString()
    if (ch === 't') return parseLiteral('true', true)
    if (ch === 'f') return parseLiteral('false', false)
    if (ch === 'n') return parseLiteral('null', null)
    if (ch === '-' || isDigit(ch)) return parseNumber()
    return fail('unexpected token', { at: i, ch })
  }

  skipWs()
  if (eof()) fail('empty JSON text')
  const value = parseValue()
  skipWs()
  if (!eof()) fail('trailing content after JSON value', { at: i })
  return { value, source }
}
