/**
 * Durable SessionStore backend (Issue #7 L2 §5.2).
 * - Append-only ledger JSONL with fsync
 * - Atomic checkpoint write via tmp + fsync + rename
 * - Crash window: un-renamed tmp is ignored; fsynced ledger rows survive
 *
 * Sync APIs keep SessionStore serial-boundary methods synchronous.
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  CommittedVersion,
  SessionBudgetSnapshot,
  SessionLedgerRecord,
  SessionProjection,
} from './session-store.js'

export type { SessionBudgetSnapshot }

export interface PersistedCheckpoint {
  sessionId: string
  principalId: string
  sessionVersion: number
  projection: SessionProjection
  projectionHash: string
  cutoffCausalSeq: number
  dedupeSnapshot: string[]
  dedupeSnapshotHash: string
  committedAt: number
  note?: string
  budget: SessionBudgetSnapshot
  nextCausalSeq: number
}

export interface LoadedSessionPersistence {
  principalId: string
  ledger: SessionLedgerRecord[]
  versions: Map<number, CommittedVersion>
  nextCausalSeq: number
  latestBudget: SessionBudgetSnapshot
}

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
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`
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

/** Append one JSON line to ledger and fsync. */
export function appendLedgerLineSync(
  ledgerFile: string,
  record: SessionLedgerRecord,
): void {
  const dir = path.dirname(ledgerFile)
  ensureDirSync(dir)
  const line = `${JSON.stringify(record)}\n`
  const fd = fs.openSync(ledgerFile, 'a')
  try {
    fs.writeFileSync(fd, line, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fsyncDirSync(dir)
}

export function sessionDir(rootDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(rootDir, safe)
}

export function ledgerPath(rootDir: string, sessionId: string): string {
  return path.join(sessionDir(rootDir, sessionId), 'ledger.jsonl')
}

export function checkpointPath(
  rootDir: string,
  sessionId: string,
  version: number,
): string {
  return path.join(sessionDir(rootDir, sessionId), `checkpoint-v${version}.json`)
}

export function latestPointerPath(rootDir: string, sessionId: string): string {
  return path.join(sessionDir(rootDir, sessionId), 'LATEST')
}

export function writeCheckpointAtomicSync(
  rootDir: string,
  checkpoint: PersistedCheckpoint,
): void {
  const cpPath = checkpointPath(
    rootDir,
    checkpoint.sessionId,
    checkpoint.sessionVersion,
  )
  atomicWriteJsonSync(cpPath, checkpoint)
  // pointer last — crash before pointer still has checkpoint file recoverable by scan
  atomicWriteJsonSync(latestPointerPath(rootDir, checkpoint.sessionId), {
    sessionId: checkpoint.sessionId,
    sessionVersion: checkpoint.sessionVersion,
    projectionHash: checkpoint.projectionHash,
  })
}

export function listSessionIdsSync(rootDir: string): string[] {
  try {
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return []
    throw error
  }
}

function readLedgerFileSync(filePath: string): SessionLedgerRecord[] {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const rows: SessionLedgerRecord[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed) as SessionLedgerRecord)
      } catch {
        // truncated last line from crash mid-write → ignore tail
        break
      }
    }
    return rows
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return []
    throw error
  }
}

function readCheckpointFileSync(
  filePath: string,
): PersistedCheckpoint | undefined {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(text) as PersistedCheckpoint
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return undefined
    // corrupt/partial → treat as missing (crash window)
    return undefined
  }
}

/**
 * Load one session from disk. Ignores crash-window tmp files.
 */
export function loadSessionFromDiskSync(
  rootDir: string,
  sessionId: string,
): LoadedSessionPersistence | undefined {
  const dir = sessionDir(rootDir, sessionId)
  let dirEntries: string[]
  try {
    dirEntries = fs.readdirSync(dir)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return undefined
    throw error
  }

  const ledger = readLedgerFileSync(ledgerPath(rootDir, sessionId))
  const versions = new Map<number, CommittedVersion>()

  for (const name of dirEntries) {
    if (!/^checkpoint-v\d+\.json$/.test(name)) continue
    const cp = readCheckpointFileSync(path.join(dir, name))
    if (!cp) continue
    versions.set(cp.sessionVersion, {
      sessionVersion: cp.sessionVersion,
      projection: cp.projection,
      projectionHash: cp.projectionHash,
      cutoffCausalSeq: cp.cutoffCausalSeq,
      dedupeSnapshot: new Set(cp.dedupeSnapshot),
      dedupeSnapshotHash: cp.dedupeSnapshotHash,
      committedAt: cp.committedAt,
      ...(cp.note === undefined ? {} : { note: cp.note }),
      budget: cp.budget,
    })
  }

  if (versions.size === 0 && ledger.length === 0) return undefined

  let latest: CommittedVersion | undefined
  for (const v of versions.values()) {
    if (!latest || v.sessionVersion > latest.sessionVersion) latest = v
  }
  if (!latest) return undefined

  const maxLedgerSeq = ledger.reduce((m, r) => Math.max(m, r.causalSeq), 0)
  const cpFile = readCheckpointFileSync(
    checkpointPath(rootDir, sessionId, latest.sessionVersion),
  )
  const nextCausalSeq = Math.max(
    maxLedgerSeq + 1,
    latest.cutoffCausalSeq,
    cpFile?.nextCausalSeq ?? 1,
  )

  const principalId = latest.projection.principalId
  if (!principalId) return undefined

  return {
    principalId,
    ledger,
    versions,
    nextCausalSeq,
    latestBudget: latest.budget,
  }
}

export function loadAllSessionsSync(
  rootDir: string,
): Map<string, LoadedSessionPersistence> {
  const out = new Map<string, LoadedSessionPersistence>()
  for (const id of listSessionIdsSync(rootDir)) {
    const loaded = loadSessionFromDiskSync(rootDir, id)
    if (loaded) out.set(id, loaded)
  }
  return out
}

/** Test helper: simulate crash by leaving a tmp checkpoint without rename. */
export function writeCrashWindowTmpCheckpointSync(
  rootDir: string,
  checkpoint: PersistedCheckpoint,
): string {
  const target = checkpointPath(
    rootDir,
    checkpoint.sessionId,
    checkpoint.sessionVersion,
  )
  const dir = path.dirname(target)
  ensureDirSync(dir)
  const tmp = `${target}.crash.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, 'utf8')
  // intentionally no rename / no LATEST update
  return tmp
}

export function defaultSessionStoreRoot(): string {
  return path.resolve('artifacts/factorio/sessions')
}
