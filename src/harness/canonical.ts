/**
 * Canonical JSON encoding and content hashing for harness payloads.
 *
 * Encoding rules (Issue #10 L2 §4.1):
 * - UTF-8 bytes, no BOM
 * - object keys sorted by UTF-16 code unit ascending
 * - arrays keep declaration order
 * - no whitespace outside string content
 * - strings: direct UTF-8 for non-ASCII (incl. U+2028/U+2029); solidus `/` is
 *   raw 0x2f (never `\/`); only `"`, `\`, and the standard short escapes /
 *   `\u00xx` for remaining C0 controls
 * - numbers: non-negative safe integers in shortest decimal form
 */

import { createHash } from 'node:crypto'
import { harnessError } from './errors.js'

const HASH_RE = /^[0-9a-f]{64}$/

export function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}

function fail(message: string, details?: unknown): never {
  throw harnessError('HARNESS_DOCUMENT_INVALID', message, details)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertNoLoneSurrogate(text: string, path: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('string contains lone high surrogate', { path, index: i })
      }
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      fail('string contains lone low surrogate', { path, index: i })
    }
  }
}

function encodeString(text: string): string {
  assertNoLoneSurrogate(text, 'string')
  let out = '"'
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      // Well-formed surrogate pair: emit as UTF-16 code units; Buffer/UTF-8 encoder
      // will turn the pair into a single scalar. Keep both units in the JS string.
      const low = text.charCodeAt(i + 1)
      out += text[i]! + text[i + 1]!
      i += 1
      void low
      continue
    }
    switch (code) {
      case 0x22: // "
        out += '\\"'
        break
      case 0x5c: // \
        out += '\\\\'
        break
      case 0x08:
        out += '\\b'
        break
      case 0x09:
        out += '\\t'
        break
      case 0x0a:
        out += '\\n'
        break
      case 0x0c:
        out += '\\f'
        break
      case 0x0d:
        out += '\\r'
        break
      default: {
        if (code < 0x20) {
          out += `\\u00${code.toString(16).padStart(2, '0')}`
        } else {
          // Including U+002F solidus as raw `/`, U+2028, U+2029, and all non-ASCII.
          out += text[i]!
        }
      }
    }
  }
  out += '"'
  return out
}

function encodeNumber(value: number, path: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('number must be a non-negative safe integer', { path, value })
  }
  if (Object.is(value, -0)) {
    fail('negative zero is not allowed', { path })
  }
  return String(value)
}

function compareUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const d = a.charCodeAt(i) - b.charCodeAt(i)
    if (d !== 0) return d
  }
  return a.length - b.length
}

/**
 * Primary canonicalizer: produce canonical JSON text (no BOM) for a validated
 * JSON-shaped value. Does not reorder arrays. Sorts object keys by UTF-16.
 */
export function canonicalizeHarnessValue(value: unknown, path = '$'): string {
  if (value === null) {
    // v1 closed schema disallows null field values; still encode if called.
    return 'null'
  }
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return encodeNumber(value, path)
  if (typeof value === 'string') return encodeString(value)
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let i = 0; i < value.length; i += 1) {
      parts.push(canonicalizeHarnessValue(value[i], `${path}[${i}]`))
    }
    return `[${parts.join(',')}]`
  }
  if (!isPlainObject(value)) {
    fail('value is not JSON-canonicalizable', { path, type: typeof value })
  }
  const keys = Object.keys(value).sort(compareUtf16)
  const parts: string[] = []
  for (const key of keys) {
    const encodedKey = encodeString(key)
    const encodedValue = canonicalizeHarnessValue(value[key], `${path}.${key}`)
    parts.push(`${encodedKey}:${encodedValue}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Independent second canonicalizer (different traversal, string builder, and
 * string/number encoders) used to cross-check primary output in tests and
 * dual-path admission. Must not call the primary encodeString/encodeNumber.
 */
export function canonicalizeHarnessValueAlt(value: unknown, path = '$'): string {
  const chunks: string[] = []
  const write = (s: string) => {
    chunks.push(s)
  }

  /** Alt string encoder: own surrogate gate + escape table; never shares primary helpers. */
  const encodeStringAlt = (text: string, p: string): string => {
    for (let i = 0; i < text.length; i += 1) {
      const cu = text.charCodeAt(i)
      if (cu >= 0xd800 && cu <= 0xdbff) {
        const low = i + 1 < text.length ? text.charCodeAt(i + 1) : -1
        if (!(low >= 0xdc00 && low <= 0xdfff)) {
          fail('string contains lone high surrogate', { path: p, index: i })
        }
        i += 1
        continue
      }
      if (cu >= 0xdc00 && cu <= 0xdfff) {
        fail('string contains lone low surrogate', { path: p, index: i })
      }
    }
    const parts: string[] = ['"']
    let i = 0
    while (i < text.length) {
      const cu = text.charCodeAt(i)
      if (cu >= 0xd800 && cu <= 0xdbff) {
        // Keep well-formed surrogate pair as two UTF-16 code units.
        parts.push(text.slice(i, i + 2))
        i += 2
        continue
      }
      if (cu === 0x22) {
        parts.push('\\"')
      } else if (cu === 0x5c) {
        parts.push('\\\\')
      } else if (cu === 0x08) {
        parts.push('\\b')
      } else if (cu === 0x09) {
        parts.push('\\t')
      } else if (cu === 0x0a) {
        parts.push('\\n')
      } else if (cu === 0x0c) {
        parts.push('\\f')
      } else if (cu === 0x0d) {
        parts.push('\\r')
      } else if (cu < 0x20) {
        const hex = cu.toString(16)
        parts.push(`\\u00${hex.length === 1 ? `0${hex}` : hex}`)
      } else {
        // Solidus U+002F and non-ASCII (incl. U+2028/U+2029) as raw code units.
        parts.push(String.fromCharCode(cu))
      }
      i += 1
    }
    parts.push('"')
    return parts.join('')
  }

  /** Alt number encoder: digit extraction, not String(n) / primary encodeNumber. */
  const encodeNumberAlt = (n: number, p: string): string => {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      fail('number must be a non-negative safe integer', { path: p, value: n })
    }
    if (Object.is(n, -0)) {
      fail('negative zero is not allowed', { path: p })
    }
    if (n === 0) return '0'
    const digits: number[] = []
    let rest = n
    while (rest > 0) {
      digits.push(rest % 10)
      rest = Math.floor(rest / 10)
    }
    let out = ''
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      out += String.fromCharCode(0x30 + digits[i]!)
    }
    return out
  }

  const compareKeysAlt = (a: string, b: string): number => {
    let i = 0
    const lim = a.length < b.length ? a.length : b.length
    while (i < lim) {
      const d = a.charCodeAt(i) - b.charCodeAt(i)
      if (d !== 0) return d
      i += 1
    }
    return a.length - b.length
  }

  const walk = (v: unknown, p: string): void => {
    if (v === null) {
      write('null')
      return
    }
    if (v === true) {
      write('true')
      return
    }
    if (v === false) {
      write('false')
      return
    }
    if (typeof v === 'number') {
      write(encodeNumberAlt(v, p))
      return
    }
    if (typeof v === 'string') {
      write(encodeStringAlt(v, p))
      return
    }
    if (Array.isArray(v)) {
      write('[')
      for (let i = 0; i < v.length; i += 1) {
        if (i > 0) write(',')
        walk(v[i], `${p}[${i}]`)
      }
      write(']')
      return
    }
    if (!isPlainObject(v)) {
      fail('value is not JSON-canonicalizable', { path: p, type: typeof v })
    }
    const keys = Object.keys(v).sort(compareKeysAlt)
    write('{')
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) write(',')
      const key = keys[i]!
      write(encodeStringAlt(key, `${p}.@key`))
      write(':')
      walk(v[key], `${p}.${key}`)
    }
    write('}')
  }

  walk(value, path)
  return chunks.join('')
}

export function harnessCanonicalBytes(value: unknown): Buffer {
  const text = canonicalizeHarnessValue(value)
  return Buffer.from(text, 'utf8')
}

export function harnessCanonicalBytesAlt(value: unknown): Buffer {
  const text = canonicalizeHarnessValueAlt(value)
  return Buffer.from(text, 'utf8')
}

export function sha256HexOfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function harnessContentHash(value: unknown): string {
  return sha256HexOfBytes(harnessCanonicalBytes(value))
}

export function harnessContentHashAlt(value: unknown): string {
  return sha256HexOfBytes(harnessCanonicalBytesAlt(value))
}

/** Deep-freeze a plain JSON value graph. */
export function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item)
    return Object.freeze(value)
  }
  for (const key of Object.keys(value as object)) {
    deepFreezeJson((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

export function cloneJson<T>(value: T): T {
  return value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T)
}
