/**
 * Durable immutable snapshot I/O for Host-held harness state.
 * Atomic write via tmp + fsync + rename (same crash window as session store).
 * Cross-process publish uses an exclusive lock file (O_EXCL) around
 * reload → validate → commit so concurrent stores cannot clobber revisions.
 * Reads go through strict harness JSON text parsing before materialization.
 */

import fs from 'node:fs'
import path from 'node:path'
import { harnessError } from './errors.js'
import { parseHarnessJsonText, type JsonTextValue } from './json-text.js'

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function fsyncDirSync(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // some platforms disallow directory fsync; ignore
  }
}

/**
 * Atomic write: write tmp → fsync file → rename → fsync parent dir.
 * Crash before rename leaves only tmp (ignored on load).
 */
export function atomicWriteJsonSync(targetPath: string, value: unknown): void {
  const dir = path.dirname(targetPath)
  ensureDirSync(dir)
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const body = `${JSON.stringify(value)}\n`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, body, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, targetPath)
  fsyncDirSync(dir)
}

/**
 * Read a durable snapshot with strict JSON text rules.
 * Missing file returns undefined (empty store / empty registry).
 */
export function readDurableJsonSync(targetPath: string): JsonTextValue | undefined {
  let text: string
  try {
    text = fs.readFileSync(targetPath, 'utf8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return undefined
    throw harnessError(
      'HARNESS_JSON_INVALID',
      `failed to read durable harness snapshot: ${targetPath}`,
      { cause: String(error) },
    )
  }
  const parsed = parseHarnessJsonText(text)
  return parsed.value
}

export function durableStoreSnapshotPath(rootDir: string): string {
  return path.join(rootDir, 'store.json')
}

export function durableLegacyRegistryPath(rootDir: string): string {
  return path.join(rootDir, 'legacy-registry.json')
}

export function durableStoreLockPath(rootDir: string): string {
  return path.join(rootDir, 'store.lock')
}

export function durableLegacyRegistryLockPath(rootDir: string): string {
  return path.join(rootDir, 'legacy-registry.lock')
}

export type DurableLockHandle = {
  lockPath: string
  fd: number
  /** Owner token written into the lock file; release only unlinks matching token. */
  token: string
}

const LOCK_RETRY_MS = 15
const DEFAULT_LOCK_MAX_WAIT_MS = 15_000

/**
 * Acquire an exclusive cross-process lock via O_EXCL lock file.
 * Only confirmed-dead owners are reclaimed. Live or unknown owners are never
 * unlinked merely because the lock file is old — waiters time out instead.
 */
export function acquireDurableLockSync(lockPath: string): DurableLockHandle {
  const dir = path.dirname(lockPath)
  ensureDirSync(dir)
  const started = Date.now()
  const rawMax = process.env.HELIX_HARNESS_LOCK_MAX_WAIT_MS
  let maxWait = DEFAULT_LOCK_MAX_WAIT_MS
  if (rawMax !== undefined && rawMax.length > 0) {
    const n = Number(rawMax)
    if (Number.isFinite(n) && n > 0) {
      maxWait = Math.min(Math.floor(n), DEFAULT_LOCK_MAX_WAIT_MS)
    }
  }
  let attempt = 0
  while (Date.now() - started < maxWait) {
    attempt += 1
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
      const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`
      try {
        // Line 1 remains a PID for liveness probes; line 3 is the owner token.
        fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n${token}\n`, 'utf8')
        fs.fsyncSync(fd)
      } catch (error) {
        try {
          fs.closeSync(fd)
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // ignore
        }
        throw error
      }
      return { lockPath, fd, token }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw error
      maybeBreakDeadOwnerLock(lockPath)
      // Exponential-ish backoff capped so concurrent publishers serialize cleanly.
      const delay = Math.min(LOCK_RETRY_MS * Math.min(attempt, 20), 100)
      sleepMs(delay)
    }
  }
  throw harnessError(
    'HARNESS_REF_INVALID',
    `timed out acquiring durable harness lock: ${lockPath}`,
  )
}

export function releaseDurableLockSync(handle: DurableLockHandle): void {
  try {
    if (typeof handle.fd === 'number' && handle.fd >= 0) {
      fs.closeSync(handle.fd)
    }
  } catch {
    // ignore close races
  }

  // Owner-token safe release: never unlink a lock we no longer own.
  // Missing token (legacy handle shape) falls back to PID-only check.
  try {
    const body = fs.readFileSync(handle.lockPath, 'utf8')
    const lines = body.split('\n')
    const pidLine = lines[0] ?? ''
    const tokenLine = (lines[2] ?? '').trim()
    const expectedToken = typeof handle.token === 'string' ? handle.token : ''
    if (expectedToken.length > 0) {
      if (tokenLine !== expectedToken) {
        return
      }
    } else {
      // No token on handle: only unlink if PID still matches this process.
      const pid = Number(pidLine)
      if (!(Number.isSafeInteger(pid) && pid === process.pid)) {
        return
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return
    // Unreadable lock → do not guess; leave it for dead-owner reclaim.
    return
  }

  try {
    fs.unlinkSync(handle.lockPath)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw error
  }
}

/**
 * Run `fn` under an exclusive durable lock. Always releases the lock.
 */
export function withDurableLockSync<T>(lockPath: string, fn: () => T): T {
  const handle = acquireDurableLockSync(lockPath)
  try {
    return fn()
  } finally {
    releaseDurableLockSync(handle)
  }
}

/**
 * Break a lock only when its owner is confirmed dead.
 * Live owners (any age) and unknown/unparseable owners are left alone.
 */
function maybeBreakDeadOwnerLock(lockPath: string): void {
  let body: string
  try {
    body = fs.readFileSync(lockPath, 'utf8')
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return
    // Unreadable → unknown owner; do not reclaim.
    return
  }

  const first = body.split('\n')[0]
  if (first === undefined || first.length === 0) {
    // Missing PID → unknown owner; do not reclaim.
    return
  }
  const pid = Number(first)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // Unparseable PID → unknown owner; do not reclaim.
    return
  }

  let ownerAlive = false
  try {
    process.kill(pid, 0)
    ownerAlive = true
  } catch {
    ownerAlive = false
  }

  // Live owner of any age: never unlink. Waiter will time out if needed.
  if (ownerAlive) return

  // Confirmed dead owner: reclaim. Concurrent breakers race on unlink.
  try {
    fs.unlinkSync(lockPath)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') throw error
  }
}

function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4)
  const view = new Int32Array(sab)
  Atomics.wait(view, 0, 0, ms)
}
