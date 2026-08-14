import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Permissions closed set (L2 §4.6.1). */
export type SessionPermission =
  | 'create'
  | 'resume'
  | 'lookup'
  | 'checkpoint'
  | 'spawn'
  | 'wait'
  | 'poll'
  | 'mailbox.send'
  | 'mailbox.receive'
  | 'mailbox.peek'

export type BoundActor = 'parent' | { handleId: string }

export type SessionActor = 'parent' | `handle:${string}` | 'none'

export interface SessionCreationCapability {
  kind: 'session_create'
  principalId: string
  secretHash: string
  issuedAt: number
  expiresAt: number
  permissions: ['create']
}

export interface SessionCapability {
  kind: 'session_bound'
  sessionId: string
  principalId: string
  secretHash: string
  issuedAt: number
  expiresAt: number
  permissions: SessionPermission[]
  boundActor: BoundActor
}

export type CapabilityRecord = SessionCreationCapability | SessionCapability

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000

export const PARENT_PERMISSIONS: SessionPermission[] = [
  'resume',
  'lookup',
  'checkpoint',
  'spawn',
  'wait',
  'poll',
  'mailbox.send',
  'mailbox.receive',
  'mailbox.peek',
]

/** Default child permissions — no lookup / create / resume / checkpoint (L2 §4.6.1). */
export const CHILD_DEFAULT_PERMISSIONS: SessionPermission[] = [
  'poll',
  'wait',
  'mailbox.send',
  'mailbox.receive',
  'mailbox.peek',
]

function sha256Hmac(secret: string, material: string): string {
  return createHmac('sha256', secret).update(material, 'utf8').digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'hex')
    const right = Buffer.from(b, 'hex')
    if (left.length !== right.length || left.length === 0) {
      // Constant-ish path: compare dummy buffers of equal length.
      const dummy = Buffer.alloc(32)
      timingSafeEqual(dummy, dummy)
      return false
    }
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

export class SessionCapabilityRegistry {
  private readonly byToken = new Map<string, CapabilityRecord>()
  private readonly harnessSecret: string

  constructor(harnessSecret?: string) {
    this.harnessSecret = harnessSecret ?? randomBytes(32).toString('hex')
  }

  /** Issue a create-scope capability for a principal (harness bootstrap). */
  issueCreationCapability(
    principalId: string,
    opts?: { ttlMs?: number; now?: number },
  ): { token: string; record: SessionCreationCapability } {
    const now = opts?.now ?? Date.now()
    const token = `sc_create_${randomBytes(24).toString('hex')}`
    const secretHash = sha256Hmac(this.harnessSecret, token)
    const record: SessionCreationCapability = {
      kind: 'session_create',
      principalId,
      secretHash,
      issuedAt: now,
      expiresAt: now + (opts?.ttlMs ?? DEFAULT_TTL_MS),
      permissions: ['create'],
    }
    this.byToken.set(token, record)
    return { token, record }
  }

  /** Issue a session-bound capability (create atomic path or child bootstrap). */
  issueSessionCapability(args: {
    sessionId: string
    principalId: string
    permissions: SessionPermission[]
    boundActor: BoundActor
    ttlMs?: number
    now?: number
  }): { token: string; record: SessionCapability } {
    const now = args.now ?? Date.now()
    const token = `sc_bound_${randomBytes(24).toString('hex')}`
    const secretHash = sha256Hmac(this.harnessSecret, token)
    const record: SessionCapability = {
      kind: 'session_bound',
      sessionId: args.sessionId,
      principalId: args.principalId,
      secretHash,
      issuedAt: now,
      expiresAt: now + (args.ttlMs ?? DEFAULT_TTL_MS),
      permissions: [...args.permissions],
      boundActor: args.boundActor,
    }
    this.byToken.set(token, record)
    return { token, record }
  }

  resolve(token: string | undefined | null): CapabilityRecord | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined
    return this.byToken.get(token)
  }

  /**
   * Validate creation capability for principal.
   * Fail-closed; no distinction leakage beyond boolean.
   */
  validateCreation(
    token: string | undefined | null,
    principalId: string,
    now = Date.now(),
  ): SessionCreationCapability | undefined {
    const record = this.resolve(token)
    if (!record || record.kind !== 'session_create') return undefined
    if (record.principalId !== principalId) return undefined
    if (now > record.expiresAt) return undefined
    if (typeof token !== 'string') return undefined
    const expected = sha256Hmac(this.harnessSecret, token)
    if (!safeEqualHex(expected, record.secretHash)) return undefined
    if (!record.permissions.includes('create')) return undefined
    return record
  }

  /**
   * Validate session-bound capability for principal + optional permission + session.
   */
  validateSessionBound(
    token: string | undefined | null,
    args: {
      principalId: string
      sessionId?: string
      permission?: SessionPermission
      now?: number
    },
  ): SessionCapability | undefined {
    const record = this.resolve(token)
    if (!record || record.kind !== 'session_bound') return undefined
    if (record.principalId !== args.principalId) return undefined
    const now = args.now ?? Date.now()
    if (now > record.expiresAt) return undefined
    if (typeof token !== 'string') return undefined
    const expected = sha256Hmac(this.harnessSecret, token)
    if (!safeEqualHex(expected, record.secretHash)) return undefined
    if (args.sessionId !== undefined && record.sessionId !== args.sessionId) {
      return undefined
    }
    if (args.permission !== undefined && !record.permissions.includes(args.permission)) {
      return undefined
    }
    return record
  }

  actorFromCapability(record: SessionCapability | undefined): SessionActor {
    if (!record) return 'none'
    if (record.boundActor === 'parent') return 'parent'
    return `handle:${record.boundActor.handleId}`
  }

  revoke(token: string): void {
    this.byToken.delete(token)
  }
}

export function handleIdFromActor(actor: SessionActor): string | undefined {
  if (actor.startsWith('handle:')) return actor.slice('handle:'.length)
  return undefined
}

export function mailboxIdForHandle(handleId: string): string {
  return `h:${handleId}`
}
