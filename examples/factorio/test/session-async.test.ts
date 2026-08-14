import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IIOPort } from 'milkie'
import {
  MAX_HANDLES,
  MAX_HANDLES_PER_SESSION,
  MAX_MSG_BYTES,
  MAX_SPAWN_COMPLETION_TOKENS,
  MIN_SPAWN_RESERVE_TOKENS,
  SESSION_ASYNC_VERSION,
  SESSION_CONTROL_MAILBOX_ID,
} from '../src/session-async-constants.js'
import {
  applySpawnReserve,
  assertSessionEffectsExclusive,
  computeSpawnDeclaredLimits,
  decideSpawnReserve,
  prepareSpawnAdmission,
  projectSessionAsyncCapability,
  refundSpawnReserve,
  settleSpawnReserve,
} from '../src/session-async.js'
import {
  CHILD_DEFAULT_PERMISSIONS,
  PARENT_PERMISSIONS,
  SessionCapabilityRegistry,
} from '../src/session-capability.js'
import {
  SessionStore,
  buildCanonicalProjection,
  handleTerminalMergeKey,
  isCommitMerged,
  mailboxMatrixAllows,
  materializeSessionView,
  projectionHashOf,
  sha256Hex,
} from '../src/session-store.js'
import {
  loadSessionFromDiskSync,
  writeCrashWindowTmpCheckpointSync,
} from '../src/session-persistence.js'
import { SessionAsyncHost } from '../src/session-async-host.js'
import { pinsSessionAsync, pinsV4 } from '../src/cli-common.js'
import {
  pinsGateCheck,
  pinsGateCheckV4,
  rejectLegacyPins,
  sessionEvidenceChecks,
  singleEffectMutualExclusionCheck,
} from '../src/verification.js'
import type { CellExecutionRecord, RunPins } from '../src/types.js'
import { assertEffectsExclusive } from '../src/recursive-model.js'

// ---------- fixtures ----------

function v5Pins(model = 'test-model'): RunPins {
  return pinsSessionAsync(model)
}

function occupyNever() {
  throw new Error('occupy must not be called')
}

function makeHost(opts?: ConstructorParameters<typeof SessionAsyncHost>[0]) {
  return new SessionAsyncHost({
    enabled: true,
    principalId: 'principal-a',
    sessionTokenPool: 16_384,
    // Unit seam: explicit mock runner (production uses childPortFactory).
    childRunner:
      opts?.childRunner ??
      (async () => ({
        status: 'completed' as const,
        preview: 'child-done',
        actualUsageTokens: 32,
      })),
    ...opts,
  })
}

async function createParentSession(host: SessionAsyncHost) {
  const token = host.getCreationToken()
  assert.ok(token)
  let occupied = false
  const result = await host.handle(
    'session.create',
    { capabilityToken: token },
    {
      hostEffectOccupied: false,
      occupy: () => {
        occupied = true
      },
      parentRunId: 'run-parent',
    },
  )
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(occupied, true)
  assert.equal(typeof result.result['session_id'], 'string')
  assert.equal(typeof result.result['session_capability_token'], 'string')
  return {
    sessionId: String(result.result['session_id']),
    sessionToken: String(result.result['session_capability_token']),
    view: result.result,
  }
}

// ---------- S5 pins ----------

test('S5.1/S5.2 pins v5 factory is complete and gates', () => {
  const p = v5Pins()
  assert.equal(p.harness, 'factorio-rlm/v5')
  assert.equal(p.bindingSet, 'factorio/v4')
  assert.equal(p.kernelProtocol, '2')
  assert.equal(p.sessionAsyncVersion, SESSION_ASYNC_VERSION)
  assert.equal(p.fle, '0.4.3')
  assert.equal(p.factorioServer, '2.0.73')
  assert.equal(p.taskId, 'iron_ore_throughput')
  assert.equal(typeof p.taskDigest, 'string')
  assert.equal(typeof p.kernelMemoryBytes, 'number')
  assert.equal(typeof p.kernelCpuSeconds, 'number')
  assert.equal(pinsGateCheck(p).passed, true)
  assert.equal(rejectLegacyPins(p).passed, true)
})

test('S5.3 rejectLegacy rejects only pre-v4; v4 remains accepted for #5 path', () => {
  const legacy = pinsV4('m')
  assert.equal(pinsGateCheckV4(legacy).passed, true)
  assert.equal(pinsGateCheck(legacy).passed, false) // v5 gate rejects bare v4
  assert.equal(rejectLegacyPins(legacy).passed, true) // v4 is current #5 path
  assert.equal(
    rejectLegacyPins({
      harness: 'factorio-rlm/v3',
      bindingSet: 'factorio/v2',
      kernelProtocol: '2',
    }).passed,
    false,
  )
  assert.equal(rejectLegacyPins(v5Pins()).passed, true)
})

// ---------- S1 session store ----------

test('S1.7 sessionVersion monotonic + projectionHash stable', () => {
  const store = new SessionStore({
    newSessionId: () => 'sess_fixed',
  })
  const created = store.create({ principalId: 'p1' })
  assert.equal(created.view.session_version, 1)
  const h1 = created.view.projection_hash
  assert.equal(typeof h1, 'string')
  assert.equal(h1.length, 64)

  // enqueue then checkpoint → V=2
  store.enqueue({
    sessionId: created.sessionId,
    mailboxId: SESSION_CONTROL_MAILBOX_ID,
    from: 'parent',
    payload: { hello: 'world' },
  })
  const cp = store.checkpoint({ sessionId: created.sessionId })
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  assert.equal(cp.noop, false)
  assert.equal(cp.committedVersion, 2)
  assert.notEqual(cp.view.projection_hash, h1)

  // noop checkpoint keeps version
  const cp2 = store.checkpoint({ sessionId: created.sessionId })
  assert.equal(cp2.ok, true)
  if (!cp2.ok) return
  assert.equal(cp2.noop, true)
  assert.equal(cp2.committedVersion, 2)
})

test('S1.1 create → checkpoint → dropLive → resume restores projection hash', () => {
  const store = new SessionStore()
  const created = store.create({ principalId: 'p1' })
  store.enqueue({
    sessionId: created.sessionId,
    mailboxId: SESSION_CONTROL_MAILBOX_ID,
    from: 'parent',
    payload: { n: 1 },
  })
  const cp = store.checkpoint({ sessionId: created.sessionId })
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  const hashAtV = cp.view.projection_hash
  const version = cp.committedVersion

  store.dropLive(created.sessionId)
  assert.equal(store.getLive(created.sessionId), undefined)

  const resumed = store.resume({ sessionId: created.sessionId, version })
  assert.equal(resumed.ok, true)
  if (!resumed.ok) return
  assert.equal(resumed.view.session_version, version)
  assert.equal(resumed.view.projection_hash, hashAtV)
  assert.equal(resumed.view.mailboxes.length >= 1, true)
})

test('S1.4 checkpoint cutoff includes prior events excludes later', () => {
  const store = new SessionStore()
  const created = store.create({ principalId: 'p1' })
  const sid = created.sessionId

  store.enqueue({
    sessionId: sid,
    mailboxId: SESSION_CONTROL_MAILBOX_ID,
    from: 'parent',
    payload: { phase: 'before' },
  })
  const cp = store.checkpoint({ sessionId: sid })
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  const cutoff = cp.view.cutoff_causal_seq
  const hashV = cp.view.projection_hash

  store.enqueue({
    sessionId: sid,
    mailboxId: SESSION_CONTROL_MAILBOX_ID,
    from: 'parent',
    payload: { phase: 'after' },
  })
  // committed projection must not include post-cutoff msg
  const committed = store.getCommitted(sid, cp.committedVersion)
  assert.ok(committed)
  assert.equal(committed!.projectionHash, hashV)
  const control = committed!.projection.mailboxes.find(
    m => m.mailboxId === SESSION_CONTROL_MAILBOX_ID,
  )
  assert.ok(control)
  assert.equal(control!.msgs.length, 1)
  assert.equal(control!.msgs[0]!.msgSeq, 1)

  // live has 2
  const live = store.getLive(sid)!
  assert.equal(live.mailboxes.get(SESSION_CONTROL_MAILBOX_ID)!.messages.length, 2)
  assert.ok(cutoff >= 1)
})

test('S1.10 resume live apply then dropLive re-applies unmerged (exactly-once)', () => {
  const store = new SessionStore()
  const created = store.create({ principalId: 'p1' })
  const sid = created.sessionId
  // commit empty-ish V=1 already from create
  store.enqueue({
    sessionId: sid,
    mailboxId: SESSION_CONTROL_MAILBOX_ID,
    from: 'parent',
    payload: { x: 1 },
  })
  // do NOT checkpoint — event is post-cutoff relative to V=1? 
  // create committed cutoff=1; enqueue allocates causalSeq>=2 so post-cutoff
  store.dropLive(sid)
  const r1 = store.resume({ sessionId: sid })
  assert.equal(r1.ok, true)
  if (!r1.ok) return
  assert.equal(r1.view.live_applied_merge_keys_count, 1)
  assert.equal(
    r1.state.mailboxes.get(SESSION_CONTROL_MAILBOX_ID)!.messages.length,
    1,
  )

  // crash before checkpoint
  store.dropLive(sid)
  const r2 = store.resume({ sessionId: sid })
  assert.equal(r2.ok, true)
  if (!r2.ok) return
  // still exactly one message
  assert.equal(
    r2.state.mailboxes.get(SESSION_CONTROL_MAILBOX_ID)!.messages.length,
    1,
  )
  assert.equal(r2.view.live_applied_merge_keys_count, 1)

  // ledger domain rows never rewritten
  const ledger = store.getLedger(sid)
  const domain = ledger.filter(r => r.recordType === 'domain')
  assert.equal(domain.length, 1)
  assert.equal('merged' in domain[0]!, false)
})

test('S1.11 isCommitMerged only via dedupeSnapshot or merge.commit', () => {
  const commits = [
    {
      recordType: 'merge.commit' as const,
      causalSeq: 2,
      sessionVersion: 2,
      cutoffCausalSeq: 3,
      committedMergeKeys: ['k1'],
      projectionHash: 'p',
      dedupeSnapshotHash: 'd',
      recordedAt: 0,
    },
  ]
  assert.equal(
    isCommitMerged('k1', {
      dedupeSnapshot: new Set(),
      mergeCommits: commits,
      asOfVersion: 2,
    }),
    true,
  )
  assert.equal(
    isCommitMerged('k1', {
      dedupeSnapshot: new Set(),
      mergeCommits: commits,
      asOfVersion: 1,
    }),
    false,
  )
  assert.equal(
    isCommitMerged('k2', {
      dedupeSnapshot: new Set(['k2']),
      mergeCommits: [],
      asOfVersion: 1,
    }),
    true,
  )
})

// ---------- S4 auth ----------

test('S4.4 cross-principal resume → SESSION_AUTH_DENIED, no side effects', async () => {
  const hostA = makeHost({ principalId: 'alice' })
  const created = await createParentSession(hostA)
  const versionBefore = hostA.store.latestCommittedVersion(created.sessionId)

  const hostB = new SessionAsyncHost({
    enabled: true,
    principalId: 'bob',
    capabilityRegistry: hostA.capabilities, // same registry, wrong principal
    sessionStore: hostA.store,
  })
  // bob issues own creation token but tries alice session token
  const denied = await hostB.handle(
    'session.resume',
    {
      sessionId: created.sessionId,
      capabilityToken: created.sessionToken,
    },
    {
      hostEffectOccupied: false,
      occupy: occupyNever,
      parentRunId: 'run-b',
    },
  )
  assert.equal(denied.ok, true)
  if (!denied.ok) return
  assert.equal(denied.businessError?.code, 'SESSION_AUTH_DENIED')
  assert.equal(denied.occupied, false)
  assert.equal(hostA.store.latestCommittedVersion(created.sessionId), versionBefore)
})

test('S4.5 create requires SessionCreationCapability; failure leaves no session', async () => {
  const host = makeHost()
  const bad = await host.handle(
    'session.create',
    { capabilityToken: 'not-a-real-token' },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(bad.ok, true)
  if (!bad.ok) return
  assert.equal(bad.businessError?.code, 'SESSION_AUTH_DENIED')
  assert.equal(host.getBoundSessionId(), null)
})

// ---------- S2 spawn / barrier / double effect ----------

test('S2.2 barrier fixture: spawn returns before child terminal', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  const order: string[] = []
  const host = makeHost({
    childBarrier: {
      wait: async () => {
        order.push('barrier_wait')
        await barrier
        order.push('barrier_release')
      },
    },
    childRunner: async () => {
      order.push('child_terminal')
      return { status: 'completed', preview: 'done', actualUsageTokens: 10 }
    },
  })
  await createParentSession(host)

  let occupied = false
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'do work' },
    {
      hostEffectOccupied: false,
      occupy: () => {
        occupied = true
      },
      parentRunId: 'run-1',
    },
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  order.push('spawn_returned')
  assert.equal(occupied, true)
  assert.ok(
    spawn.result['status'] === 'pending' || spawn.result['status'] === 'running',
    `expected pending|running, got ${String(spawn.result['status'])}`,
  )
  const handleId = String(spawn.result['handle_id'])

  // parent follow-up while barrier held (poll is non-blocking)
  const poll = await host.handle(
    'agents.poll',
    { handleId },
    { hostEffectOccupied: true, occupy: occupyNever, parentRunId: 'run-1' },
  )
  assert.equal(poll.ok, true)
  order.push('parent_followup')

  release()
  await host.drain()
  order.push('parent_observes_ready')

  const poll2 = await host.handle(
    'agents.poll',
    { handleId },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'run-1' },
  )
  assert.equal(poll2.ok, true)
  if (!poll2.ok) return
  assert.equal(poll2.result['status'], 'completed')
  order.push('parent_observes_terminal')

  const si = order.indexOf('spawn_returned')
  const pf = order.indexOf('parent_followup')
  const br = order.indexOf('barrier_release')
  const ct = order.indexOf('child_terminal')
  const po = order.indexOf('parent_observes_terminal')
  assert.ok(si >= 0 && pf >= 0 && br >= 0 && ct >= 0 && po >= 0)
  assert.ok(si <= pf)
  assert.ok(pf <= br)
  assert.ok(br <= ct)
  assert.ok(ct <= po)
})

test('S2.4 double effect: spawn then spawn → MULTIPLE_EFFECTS_IN_CELL', async () => {
  const host = makeHost({
    childBarrier: { wait: () => new Promise(() => {}) }, // never complete
  })
  await createParentSession(host)
  let occupied = false
  const first = await host.handle(
    'agents.spawn',
    { instructions: 'one' },
    {
      hostEffectOccupied: false,
      occupy: () => {
        occupied = true
      },
      parentRunId: 'run-1',
    },
  )
  assert.equal(first.ok, true)
  assert.equal(occupied, true)

  const second = await host.handle(
    'agents.spawn',
    { instructions: 'two' },
    {
      hostEffectOccupied: true,
      occupy: occupyNever,
      parentRunId: 'run-1',
    },
  )
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.businessError?.code, 'MULTIPLE_EFFECTS_IN_CELL')
  assert.equal(second.occupied, false)
})

test('S2.5 single cell spawn succeeds and records agentEffect', async () => {
  const host = makeHost()
  await createParentSession(host)
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'solo' },
    {
      hostEffectOccupied: false,
      occupy: () => {},
      parentRunId: 'run-1',
    },
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.ok(spawn.agentEffect)
  assert.equal(spawn.agentEffect!.method, 'agents.spawn')
  assert.equal(typeof spawn.result['handle_id'], 'string')
  await host.drain()
})

test('effect exclusivity covers session/agent/mailbox', () => {
  assert.equal(assertEffectsExclusive({ agentEffect: {} }), true)
  assert.equal(
    assertEffectsExclusive({ agentEffect: {}, modelEffect: {} }),
    false,
  )
  assert.equal(
    assertSessionEffectsExclusive({
      sessionEffect: {},
      mailboxEffect: {},
    }),
    false,
  )
  const records: CellExecutionRecord[] = [
    {
      schema: 'helix.cell-execution/v3',
      cellId: 'c',
      source: 'x',
      sourceDigest: 'd',
      startRevision: 0,
      endRevision: 1,
      status: 'success',
      stdoutPreview: '',
      stderrPreview: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      namespace: [],
      managedObjects: [],
      agentEffect: {
        method: 'agents.spawn',
        handleId: 'h',
        status: 'pending',
      },
    },
  ]
  assert.equal(singleEffectMutualExclusionCheck(records).passed, true)
})

// ---------- S3 mailbox matrix ----------

test('S3.8 mailbox authorization matrix', () => {
  // parent allows all
  for (const op of ['send', 'receive', 'peek'] as const) {
    assert.equal(mailboxMatrixAllows('parent', op, SESSION_CONTROL_MAILBOX_ID), true)
    assert.equal(mailboxMatrixAllows('parent', op, 'h:other'), true)
  }
  // handle:H
  const H = 'handle:h1'
  assert.equal(mailboxMatrixAllows(H, 'send', SESSION_CONTROL_MAILBOX_ID), true)
  assert.equal(mailboxMatrixAllows(H, 'receive', SESSION_CONTROL_MAILBOX_ID), false)
  assert.equal(mailboxMatrixAllows(H, 'peek', SESSION_CONTROL_MAILBOX_ID), false)
  assert.equal(mailboxMatrixAllows(H, 'send', 'h:h1'), true)
  assert.equal(mailboxMatrixAllows(H, 'receive', 'h:h1'), true)
  assert.equal(mailboxMatrixAllows(H, 'send', 'h:other'), false)
  assert.equal(mailboxMatrixAllows(H, 'receive', 'h:other'), false)
  assert.equal(mailboxMatrixAllows('none', 'send', SESSION_CONTROL_MAILBOX_ID), false)
})

test('S3.1 authorized send + receive roundtrip', async () => {
  const host = makeHost()
  await createParentSession(host)
  let occupied = false
  const sent = await host.handle(
    'mailbox.send',
    { to: SESSION_CONTROL_MAILBOX_ID, payload: { hi: 1 } },
    {
      hostEffectOccupied: false,
      occupy: () => {
        occupied = true
      },
      parentRunId: 'r',
    },
  )
  assert.equal(sent.ok, true)
  if (!sent.ok) return
  assert.equal(occupied, true)
  assert.equal(typeof sent.result['msg_id'], 'string')

  // new cell
  occupied = false
  const recv = await host.handle(
    'mailbox.receive',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID, timeout_ms: 0 },
    {
      hostEffectOccupied: false,
      occupy: () => {
        occupied = true
      },
      parentRunId: 'r',
    },
  )
  assert.equal(recv.ok, true)
  if (!recv.ok) return
  assert.equal(occupied, true)
  assert.equal(recv.result['msg_seq'], 1)
})

test('S3.3/S3.10 child cannot lookup; child cannot receive control', async () => {
  const host = makeHost({
    childRunner: async () => ({ status: 'completed', preview: 'ok', actualUsageTokens: 4 }),
  })
  const created = await createParentSession(host)
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'child' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  const handleId = String(spawn.result['handle_id'])
  await host.drain()

  // Build child-bound host sharing store/caps
  // Find child token by issuing equivalent + binding via registry is internal;
  // use bindChild after minting child cap the same way spawn does — re-issue:
  const childTok = host.capabilities.issueSessionCapability({
    sessionId: created.sessionId,
    principalId: 'principal-a',
    permissions: CHILD_DEFAULT_PERMISSIONS,
    boundActor: { handleId },
  })
  host.bindChild({
    sessionId: created.sessionId,
    handleId,
    sessionToken: childTok.token,
  })

  const lookup = await host.handle(
    'session.lookup',
    {},
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(lookup.ok, true)
  if (!lookup.ok) return
  assert.equal(lookup.businessError?.code, 'SESSION_AUTH_DENIED')
  // no directory leakage
  assert.equal(lookup.result['handles'], undefined)

  const recvControl = await host.handle(
    'mailbox.receive',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID, timeout_ms: 0 },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(recvControl.ok, true)
  if (!recvControl.ok) return
  assert.equal(recvControl.businessError?.code, 'MAILBOX_AUTH_DENIED')
})

test('S3.11 child poll non-self → AGENT_AUTH_DENIED', async () => {
  const host = makeHost()
  const created = await createParentSession(host)
  // two handles
  const s1 = await host.handle(
    'agents.spawn',
    { instructions: 'a' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
  )
  assert.equal(s1.ok, true)
  if (!s1.ok) return
  const h1 = String(s1.result['handle_id'])
  await host.drain()

  // reset occupy for second cell
  const s2 = await host.handle(
    'agents.spawn',
    { instructions: 'b' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
  )
  assert.equal(s2.ok, true)
  if (!s2.ok) return
  const h2 = String(s2.result['handle_id'])
  await host.drain()

  const childTok = host.capabilities.issueSessionCapability({
    sessionId: created.sessionId,
    principalId: 'principal-a',
    permissions: CHILD_DEFAULT_PERMISSIONS,
    boundActor: { handleId: h1 },
  })
  host.bindChild({
    sessionId: created.sessionId,
    handleId: h1,
    sessionToken: childTok.token,
  })

  const denied = await host.handle(
    'agents.poll',
    { handleId: h2 },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(denied.ok, true)
  if (!denied.ok) return
  assert.equal(denied.businessError?.code, 'AGENT_AUTH_DENIED')
})

test('S3.6 peek does not advance cursor or occupy', async () => {
  const host = makeHost()
  await createParentSession(host)
  await host.handle(
    'mailbox.send',
    { to: SESSION_CONTROL_MAILBOX_ID, payload: 'x' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
  )
  const peek1 = await host.handle(
    'mailbox.peek',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(peek1.ok, true)
  if (!peek1.ok) return
  assert.equal(peek1.occupied, false)
  assert.equal(peek1.result['msg_seq'], 1)
  const peek2 = await host.handle(
    'mailbox.peek',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(peek2.ok, true)
  if (!peek2.ok) return
  assert.equal(peek2.result['msg_seq'], 1)
})

test('S3.5 mailbox too large / full reject without occupy', async () => {
  const host = makeHost()
  await createParentSession(host)
  const big = 'x'.repeat(MAX_MSG_BYTES + 1)
  const tooBig = await host.handle(
    'mailbox.send',
    { to: SESSION_CONTROL_MAILBOX_ID, payload: big },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(tooBig.ok, true)
  if (!tooBig.ok) return
  assert.equal(tooBig.businessError?.code, 'MAILBOX_MSG_TOO_LARGE')
  assert.equal(tooBig.occupied, false)
})

test('S3.13 actor-filtered SessionView for non-parent', () => {
  const store = new SessionStore()
  const created = store.create({ principalId: 'p' })
  const spawned = store.spawnHandle({
    sessionId: created.sessionId,
    parentRunId: 'run',
    mailbox: true,
    reserve: 32,
    declaredPromptTokens: 16,
    declaredCompletionTokens: 16,
    requestedCompletionTokens: 16,
  })
  assert.equal(spawned.ok, true)
  if (!spawned.ok) return
  const h = spawned.handle.handleId
  store.spawnHandle({
    sessionId: created.sessionId,
    parentRunId: 'run',
    mailbox: true,
    reserve: 32,
    declaredPromptTokens: 16,
    declaredCompletionTokens: 16,
    requestedCompletionTokens: 16,
  })
  const state = store.getLive(created.sessionId)!
  const parentView = materializeSessionView({
    state,
    actor: 'parent',
    committedVersion: 1,
    committedProjectionHash: state.committedProjectionHash,
    committedCutoff: 1,
  })
  assert.ok(parentView.handles.length >= 2)
  assert.ok(parentView.mailboxes.some(m => m.mailbox_id === SESSION_CONTROL_MAILBOX_ID))

  const childView = materializeSessionView({
    state,
    actor: `handle:${h}`,
    committedVersion: 1,
    committedProjectionHash: state.committedProjectionHash,
    committedCutoff: 1,
  })
  assert.equal(childView.handles.length, 1)
  assert.equal(childView.handles[0]!.handle_id, h)
  assert.equal(
    childView.mailboxes.every(m => m.mailbox_id === `h:${h}`),
    true,
  )
  assert.equal(
    childView.mailboxes.some(m => m.mailbox_id === SESSION_CONTROL_MAILBOX_ID),
    false,
  )
})

// ---------- S4 budget ----------

test('S4.8/S4.9 spawn budget clamp and min reserve', () => {
  // clamp success: request huge completion, pool small but enough for min
  const declared = computeSpawnDeclaredLimits({
    instructionsByteLength: 40,
    inputByteLength: 0,
    maxOutputTokens: 100_000,
    remainingTokens: 100,
  })
  assert.ok(declared.declaredCompletionTokens <= MAX_SPAWN_COMPLETION_TOKENS)
  assert.ok(declared.declaredCompletionTokens <= 100 - declared.declaredPromptTokens)
  const ok = decideSpawnReserve({
    instructionsByteLength: 40,
    inputByteLength: 0,
    maxOutputTokens: 100_000,
    remainingTokens: 100,
  })
  assert.equal(ok.ok, true)

  // min reserve fail
  const tiny = decideSpawnReserve({
    instructionsByteLength: 1,
    inputByteLength: 0,
    maxOutputTokens: 1,
    remainingTokens: 0,
  })
  assert.equal(tiny.ok, false)
})

test('S4.10 overflow tokens recorded; pool only charged', () => {
  let remaining = 1000
  const reserve = 100
  remaining = applySpawnReserve(remaining, reserve)
  assert.equal(remaining, 900)
  const settlement = settleSpawnReserve({
    remainingBeforeSettle: remaining,
    reserve,
    actualUsageTokens: 150,
  })
  assert.equal(settlement.chargedTokens, 100)
  assert.equal(settlement.overflowTokens, 50)
  assert.equal(settlement.remainingAfter, 900) // 900 + (100-100)
  // full cycle: remaining_after = remaining_before_reserve - charged
  assert.equal(settlement.remainingAfter, 1000 - 100)
})

test('S4.9 host rejects spawn when reserve below MIN', async () => {
  const host = makeHost({ sessionTokenPool: MIN_SPAWN_RESERVE_TOKENS - 1 })
  await createParentSession(host)
  // still may fail on prompt_exceeds or min_reserve
  const r = await host.handle(
    'agents.spawn',
    { instructions: 'x'.repeat(8000) },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.ok(
    r.businessError?.code === 'AGENT_BUDGET_INSUFFICIENT' ||
      r.businessError?.code === 'AGENT_PARAM_INVALID',
  )
})

test('S4.12 active vs historical handle limits distinct codes', async () => {
  const host = makeHost({
    childBarrier: { wait: () => new Promise(() => {}) }, // keep active
  })
  await createParentSession(host)
  for (let i = 0; i < MAX_HANDLES; i++) {
    const r = await host.handle(
      'agents.spawn',
      { instructions: `h${i}` },
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.businessError, undefined)
  }
  const overflow = await host.handle(
    'agents.spawn',
    { instructions: 'overflow' },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(overflow.ok, true)
  if (!overflow.ok) return
  assert.equal(overflow.businessError?.code, 'AGENT_ACTIVE_HANDLE_LIMIT')
})

test('S4.12 historical handle limit after terminals', async () => {
  const host = makeHost()
  await createParentSession(host)
  for (let i = 0; i < MAX_HANDLES_PER_SESSION; i++) {
    const r = await host.handle(
      'agents.spawn',
      { instructions: `hist-${i}` },
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
    )
    assert.equal(r.ok, true)
    await host.drain()
  }
  const overflow = await host.handle(
    'agents.spawn',
    { instructions: 'one-more' },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(overflow.ok, true)
  if (!overflow.ok) return
  assert.equal(overflow.businessError?.code, 'AGENT_HISTORICAL_HANDLE_LIMIT')
})

// ---------- capability projection ----------

test('capability projection splits active/historical slots', () => {
  const cap = projectSessionAsyncCapability({
    enabled: true,
    sessionId: 's',
    sessionVersion: 2,
    remainingActiveHandleSlots: 3,
    remainingHistoricalHandleSlots: 10,
  })
  assert.equal(cap.maxActiveHandles, MAX_HANDLES)
  assert.equal(cap.maxHandlesPerSession, MAX_HANDLES_PER_SESSION)
  assert.equal(cap.remainingActiveHandleSlots, 3)
  assert.equal(cap.remainingHistoricalHandleSlots, 10)
})

// ---------- capability registry ----------

test('capability registry: create scope cannot resume; child lacks lookup', () => {
  const reg = new SessionCapabilityRegistry('secret')
  const create = reg.issueCreationCapability('p')
  assert.equal(reg.validateCreation(create.token, 'p')?.kind, 'session_create')
  assert.equal(
    reg.validateSessionBound(create.token, { principalId: 'p', permission: 'resume' }),
    undefined,
  )

  const bound = reg.issueSessionCapability({
    sessionId: 's1',
    principalId: 'p',
    permissions: CHILD_DEFAULT_PERMISSIONS,
    boundActor: { handleId: 'h1' },
  })
  assert.equal(
    reg.validateSessionBound(bound.token, {
      principalId: 'p',
      sessionId: 's1',
      permission: 'lookup',
    }),
    undefined,
  )
  assert.ok(
    reg.validateSessionBound(bound.token, {
      principalId: 'p',
      sessionId: 's1',
      permission: 'poll',
    }),
  )
  assert.deepEqual(
    [...PARENT_PERMISSIONS].includes('lookup'),
    true,
  )
  assert.equal(CHILD_DEFAULT_PERMISSIONS.includes('lookup'), false)
})

// ---------- prepare spawn params ----------

test('prepareSpawnAdmission rejects bad max_output_tokens', () => {
  const bad = prepareSpawnAdmission({
    instructions: 'hi',
    maxOutputTokens: 0,
    remainingTokens: 10_000,
  })
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.equal(bad.code, 'AGENT_PARAM_INVALID')
})

test('SESSION_ASYNC_NOT_ENABLED when host disabled', async () => {
  const host = new SessionAsyncHost({ enabled: false, principalId: 'p' })
  const r = await host.handle(
    'session.create',
    { capabilityToken: 'x' },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'r' },
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.businessError?.code, 'SESSION_ASYNC_NOT_ENABLED')
})

// ---------- S1 interleaved spawn/checkpoint/merge ----------

test('S1.3 spawn → checkpoint → child completes+send → resume observes once', async () => {
  let release!: () => void
  const barrier = new Promise<void>(r => {
    release = r
  })
  const host = makeHost({
    childBarrier: { wait: () => barrier },
    childRunner: async ({ handleId }) => ({
      status: 'completed',
      preview: 'done',
      actualUsageTokens: 20,
      controlMessage: { fromChild: handleId, note: 'progress' },
    }),
  })
  const created = await createParentSession(host)

  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'work' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-1' },
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  const handleId = String(spawn.result['handle_id'])

  // parent checkpoint before child finishes
  const cp = await host.handle(
    'session.checkpoint',
    {},
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-1' },
  )
  assert.equal(cp.ok, true)
  if (!cp.ok) return
  const v = Number(cp.result['session_version'])
  const hashAtCheckpoint = String(cp.result['projection_hash'])

  // child completes + mailbox send after checkpoint
  release()
  await host.drain()

  // drop live (simulate new run) and resume
  host.store.dropLive(created.sessionId)
  const resumed = await host.handle(
    'session.resume',
    {
      sessionId: created.sessionId,
      capabilityToken: created.sessionToken,
      version: v,
    },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-2' },
  )
  assert.equal(resumed.ok, true)
  if (!resumed.ok) return
  // committed hash still V
  assert.equal(resumed.result['projection_hash'], hashAtCheckpoint)
  // live applied post-cutoff: handle terminal + mailbox enqueue
  assert.ok(Number(resumed.result['live_applied_merge_keys_count']) >= 1)

  // observe handle terminal once
  const poll = await host.handle(
    'agents.poll',
    { handleId },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'run-2' },
  )
  assert.equal(poll.ok, true)
  if (!poll.ok) return
  assert.equal(poll.result['status'], 'completed')

  // receive control message once
  const recv = await host.handle(
    'mailbox.receive',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID, timeout_ms: 0 },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-2' },
  )
  assert.equal(recv.ok, true)
  if (!recv.ok) return
  assert.equal(recv.result['msg_seq'], 1)

  // second receive empty
  const recv2 = await host.handle(
    'mailbox.receive',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID, timeout_ms: 0 },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'run-2' },
  )
  assert.equal(recv2.ok, true)
  if (!recv2.ok) return
  assert.equal(recv2.occupied, false)

  // merge keys unique
  const keys = host.store.mergeEvents.map(e => e.mergeKey)
  assert.equal(keys.length, new Set(keys).size)
  assert.ok(keys.includes(handleTerminalMergeKey(handleId, 1)))
})

test('canonical projection hash is deterministic', () => {
  const projection = buildCanonicalProjection({
    sessionId: 's',
    sessionVersion: 1,
    principalId: 'p',
    handles: [],
    mailboxes: [
      {
        mailboxId: SESSION_CONTROL_MAILBOX_ID,
        headSeq: 0,
        tailSeq: 0,
        messages: [],
      },
    ],
    memorySummaryRef: null,
    cutoffCausalSeq: 1,
    lifecycle: 'active',
    poolRemaining: 16_384,
    poolInitial: 16_384,
    openReserves: [],
    settlements: [],
  })
  assert.equal(projectionHashOf(projection), projectionHashOf(projection))
  assert.equal(sha256Hex('abc').length, 64)
})

// ---------- Formal path closures (B1–B4, I1) ----------

test('B1 durable SessionStore: checkpoint → new store instance same hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-session-'))
  try {
    const store1 = new SessionStore({
      rootDir: root,
      newSessionId: () => 'sess_durable_1',
    })
    const created = store1.create({ principalId: 'p1' })
    store1.enqueue({
      sessionId: created.sessionId,
      mailboxId: SESSION_CONTROL_MAILBOX_ID,
      from: 'parent',
      payload: { durable: true },
    })
    const cp = store1.checkpoint({ sessionId: created.sessionId })
    assert.equal(cp.ok, true)
    if (!cp.ok) return
    const hash = cp.view.projection_hash
    const version = cp.committedVersion

    // New process / Host: fresh store loads from disk
    const store2 = new SessionStore({ rootDir: root })
    assert.equal(store2.hasSession(created.sessionId), true)
    assert.equal(store2.getLive(created.sessionId), undefined)
    const resumed = store2.resume({ sessionId: created.sessionId, version })
    assert.equal(resumed.ok, true)
    if (!resumed.ok) return
    assert.equal(resumed.view.projection_hash, hash)
    assert.equal(resumed.view.session_version, version)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B1 crash window: tmp checkpoint without rename is ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-crash-'))
  try {
    const store = new SessionStore({
      rootDir: root,
      newSessionId: () => 'sess_crash',
    })
    const created = store.create({ principalId: 'p' })
    const v1 = store.getCommitted(created.sessionId, 1)
    assert.ok(v1)

    // Simulate crash: write only tmp for a fake V=2
    writeCrashWindowTmpCheckpointSync(root, {
      sessionId: created.sessionId,
      principalId: 'p',
      sessionVersion: 2,
      projection: v1!.projection,
      projectionHash: 'deadbeef'.repeat(8),
      cutoffCausalSeq: 99,
      dedupeSnapshot: [],
      dedupeSnapshotHash: 'x',
      committedAt: Date.now(),
      budget: v1!.budget,
      nextCausalSeq: 99,
    })

    const loaded = loadSessionFromDiskSync(root, created.sessionId)
    assert.ok(loaded)
    // V=2 never committed — only V=1 visible
    assert.equal(loaded!.versions.has(2), false)
    assert.equal(loaded!.versions.has(1), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B2 spawn uses childPortFactory attach/parentId/invoke path', async () => {
  const attached: Array<{ parentId?: string; childRunId: string }> = []
  let invoked = 0
  let detached = 0
  const host = new SessionAsyncHost({
    enabled: true,
    principalId: 'principal-a',
    sessionTokenPool: 16_384,
    // no childRunner — must use factory
    childPortFactory: async args => {
      attached.push({ parentId: args.parentRunId, childRunId: args.childRunId })
      return {
        port: {
          async invokeLLM() {
            invoked += 1
            return {
              content: [{ type: 'text', text: 'via-factory' }],
              toolCalls: [],
              usage: { inputTokens: 3, outputTokens: 5 },
            }
          },
          async invokeTool() {
            throw new Error('no tools')
          },
          async now() {
            return Date.now()
          },
          async uuid() {
            return 'u'
          },
        } as unknown as IIOPort,
        attached: true,
        detach: async () => {
          detached += 1
        },
      }
    },
    model: 'test-model',
  })
  host.setParentRunId('run-parent-1')
  await createParentSession(host)
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'factory child' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-parent-1' },
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  await host.drain()
  assert.equal(attached.length, 1)
  assert.equal(attached[0]?.parentId, 'run-parent-1')
  assert.ok(String(attached[0]?.childRunId).includes('run-parent-1'))
  assert.equal(invoked, 1)
  assert.equal(detached, 1)
  assert.ok(host.agentChildRunIds.length >= 1)
  const handleId = String(spawn.result['handle_id'])
  const poll = await host.handle(
    'agents.poll',
    { handleId },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'run-parent-1' },
  )
  assert.equal(poll.ok, true)
  if (!poll.ok) return
  assert.equal(poll.result['status'], 'completed')
})

test('B2 production path fails closed without childPortFactory (no instant mock)', async () => {
  const host = new SessionAsyncHost({
    enabled: true,
    principalId: 'principal-a',
    // deliberately no childRunner and no childPortFactory
  })
  await createParentSession(host)
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'should fail closed' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-x' },
  )
  assert.equal(spawn.ok, true)
  await host.drain()
  const handleId = String((spawn as { result: Record<string, unknown> }).result['handle_id'])
  const poll = await host.handle(
    'agents.poll',
    { handleId },
    { hostEffectOccupied: false, occupy: occupyNever, parentRunId: 'run-x' },
  )
  assert.equal(poll.ok, true)
  if (!poll.ok) return
  assert.equal(poll.result['status'], 'failed')
})

test('B3 evidenceSlice exposes session merge/budget fields', async () => {
  const host = makeHost()
  await createParentSession(host)
  await host.handle(
    'agents.spawn',
    { instructions: 'e' },
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
  )
  await host.drain()
  await host.handle(
    'session.checkpoint',
    {},
    { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'r' },
  )
  const slice = host.evidenceSlice()
  assert.ok(slice.session)
  assert.equal(typeof slice.session?.projectionHash, 'string')
  assert.equal(slice.session?.projectionHash.length, 64)
  assert.ok(Array.isArray(slice.sessionMergeEvents))
  assert.ok(Array.isArray(slice.sessionMergeCommits))
  assert.ok(Array.isArray(slice.sessionBudgetSettlements))
  assert.ok(slice.sessionBudgetSettlements.length >= 1)
})

test('B4 session budget survives checkpoint → new store resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-budget-'))
  try {
    const host1 = new SessionAsyncHost({
      enabled: true,
      principalId: 'p',
      sessionTokenPool: 1000,
      sessionStoreRoot: root,
      childRunner: async () => ({
        status: 'completed',
        preview: 'done',
        actualUsageTokens: 40,
      }),
    })
    const created = await createParentSession(host1)
    const before = host1.getSessionPoolRemaining()
    assert.equal(before, 1000)
    await host1.handle(
      'agents.spawn',
      { instructions: 'budget-work' },
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-1' },
    )
    await host1.drain()
    const afterSettle = host1.getSessionPoolRemaining()
    assert.ok(afterSettle < 1000)
    const cp = await host1.handle(
      'session.checkpoint',
      {},
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-1' },
    )
    assert.equal(cp.ok, true)
    if (!cp.ok) return
    const version = Number(cp.result['session_version'])

    // New Host + store from disk — pool must not reset to 1000
    const host2 = new SessionAsyncHost({
      enabled: true,
      principalId: 'p',
      sessionTokenPool: 1000, // constructor default must not swallow ledger
      sessionStoreRoot: root,
      capabilityRegistry: host1.capabilities,
    })
    const resumed = await host2.handle(
      'session.resume',
      {
        sessionId: created.sessionId,
        capabilityToken: created.sessionToken,
        version,
      },
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-2' },
    )
    assert.equal(resumed.ok, true)
    assert.equal(host2.getSessionPoolRemaining(), afterSettle)
    const committed = host2.store.getCommitted(created.sessionId, version)
    assert.ok(committed)
    assert.equal(committed!.budget.poolRemaining, afterSettle)
    assert.ok(committed!.projection.settlements.length >= 1)
    assert.ok(
      committed!.projection.handles.some(
        h => h.settled && h.actualUsageTokens === 40,
      ),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('I1 pinsGateCheck fails closed on missing model/renderer/milkie fields', () => {
  const full = v5Pins()
  assert.equal(pinsGateCheck(full).passed, true)

  const dropModel = { ...full, model: '' }
  assert.equal(pinsGateCheck(dropModel as RunPins).passed, false)

  const dropRenderer = { ...full } as RunPins
  // @ts-expect-error intentional missing field
  delete (dropRenderer as { renderer?: string }).renderer
  assert.equal(pinsGateCheck(dropRenderer).passed, false)

  const dropMilkie = { ...full } as RunPins
  // @ts-expect-error intentional
  delete (dropMilkie as { milkie?: string }).milkie
  assert.equal(pinsGateCheck(dropMilkie).passed, false)

  const wrongHarness = { ...full, harness: 'factorio-rlm/v4' as const }
  assert.equal(pinsGateCheck(wrongHarness).passed, false)

  // v4 gate also requires full shape
  const legacy = pinsV4('m')
  assert.equal(pinsGateCheckV4(legacy).passed, true)
  const bareV4 = {
    harness: 'factorio-rlm/v4' as const,
    kernelProtocol: '2' as const,
    bindingSet: 'factorio/v3' as const,
  }
  assert.equal(pinsGateCheckV4(bareV4 as RunPins).passed, false)
})

test('sessionEvidenceChecks fail-closed when session fields missing on v4', () => {
  const missing = sessionEvidenceChecks({
    live: {
      schema: 'helix.factorio.live/v4',
      session: undefined,
    },
    requireSession: true,
  })
  assert.ok(missing.some(c => c.id === 'S7.session-projection' && !c.passed))

  const ok = sessionEvidenceChecks({
    live: {
      schema: 'helix.factorio.live/v4',
      session: {
        id: 's',
        version: 2,
        projectionHash: 'a'.repeat(64),
        cutoffCausalSeq: 3,
      },
      sessionMergeEvents: [],
      sessionMergeCommits: [],
      sessionBudgetSettlements: [],
      budget: { remainingSessionTokensAtEnd: 100 },
      pins: v5Pins(),
    },
    requireSession: true,
  })
  assert.ok(ok.every(c => c.passed))
})

test('replay sessionEvidenceChecks requireSession from pins/schema even if session deleted', () => {
  // Mirrors replay.ts call site: requireSession derived from schema/pins, not live.session.
  const strippedLive = {
    schema: 'helix.factorio.live/v4' as const,
    // session intentionally omitted (deleted/stripped artifact)
    budget: { remainingRecursiveModelTokensAtEnd: 0 },
    pins: v5Pins(),
  }
  const requireSession =
    strippedLive.schema === 'helix.factorio.live/v4' ||
    strippedLive.pins.sessionAsyncVersion === '1' ||
    strippedLive.pins.harness === 'factorio-rlm/v5'
  assert.equal(requireSession, true)

  const checks = sessionEvidenceChecks({
    live: strippedLive,
    requireSession,
  })
  assert.ok(checks.some(c => c.id === 'S7.session-projection' && !c.passed))
  assert.ok(checks.some(c => c.id === 'S7.session-merge-events' && !c.passed))
  assert.ok(checks.some(c => c.id === 'S7.session-budget-settlements' && !c.passed))
  assert.ok(checks.some(c => c.id === 'S7.session-budget-remaining' && !c.passed))

  // Auto-require without explicit flag when pins declare session-async
  const auto = sessionEvidenceChecks({
    live: {
      schema: 'helix.factorio.live/v3',
      pins: v5Pins(),
    },
  })
  assert.ok(auto.some(c => c.id === 'S7.session-projection' && !c.passed))

  // Legacy v3 without session pins must not force session checks
  const legacy = sessionEvidenceChecks({
    live: {
      schema: 'helix.factorio.live/v3',
      pins: pinsV4('m'),
    },
  })
  assert.equal(
    legacy.some(c => c.id === 'S7.session-projection'),
    false,
  )
})

test('B2 child capability token never enters attach input or LLM request body', async () => {
  const captured: {
    factoryArgs?: {
      input: string
      sessionBootstrap?: {
        sessionId: string
        handleId: string
        capabilityToken: string
      }
    }
    llmRequest?: unknown
  } = {}
  const host = new SessionAsyncHost({
    enabled: true,
    principalId: 'principal-a',
    sessionTokenPool: 16_384,
    childPortFactory: async args => {
      captured.factoryArgs = {
        input: args.input,
        ...(args.sessionBootstrap
          ? { sessionBootstrap: args.sessionBootstrap }
          : {}),
      }
      return {
        port: {
          async invokeLLM(request: unknown) {
            captured.llmRequest = request
            return {
              content: [{ type: 'text', text: 'ok' }],
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async invokeTool() {
            throw new Error('no tools')
          },
          async now() {
            return Date.now()
          },
          async uuid() {
            return 'u'
          },
        } as unknown as IIOPort,
        attached: true,
        detach: async () => undefined,
      }
    },
    model: 'test-model',
  })
  host.setParentRunId('run-parent-sec')
  await createParentSession(host)
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'no token leak' },
    {
      hostEffectOccupied: false,
      occupy: () => {},
      parentRunId: 'run-parent-sec',
    },
  )
  assert.equal(spawn.ok, true)
  await host.drain()

  assert.ok(captured.factoryArgs)
  const token = captured.factoryArgs!.sessionBootstrap?.capabilityToken
  assert.equal(typeof token, 'string')
  assert.ok(token && token.length > 8)
  // attach input must not carry the capability token
  assert.notEqual(captured.factoryArgs!.input, token)
  assert.equal(captured.factoryArgs!.input.includes(token!), false)
  // LLM request body must not include the token either
  const llmJson = JSON.stringify(captured.llmRequest)
  assert.equal(llmJson.includes(token!), false)
  // Host-private bootstrap is available for non-recording child kernel bind
  assert.equal(
    typeof captured.factoryArgs!.sessionBootstrap?.handleId,
    'string',
  )
  assert.equal(
    typeof captured.factoryArgs!.sessionBootstrap?.sessionId,
    'string',
  )
})

test('B4 crash-tail: checkpoint then terminal then resume restores pool/openReserves/settlements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-budget-tail-'))
  try {
    let release!: () => void
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const host1 = new SessionAsyncHost({
      enabled: true,
      principalId: 'p',
      sessionTokenPool: 1000,
      sessionStoreRoot: root,
      childBarrier: {
        wait: () => barrier,
      },
      childRunner: async () => ({
        status: 'completed',
        preview: 'late-terminal',
        actualUsageTokens: 40,
      }),
    })
    const created = await createParentSession(host1)
    assert.equal(host1.getSessionPoolRemaining(), 1000)

    const spawn = await host1.handle(
      'agents.spawn',
      { instructions: 'hold-then-settle' },
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-1' },
    )
    assert.equal(spawn.ok, true)
    if (!spawn.ok) return
    const handleId = String(spawn.result['handle_id'])
    const afterReserve = host1.getSessionPoolRemaining()
    assert.ok(afterReserve < 1000)

    // Checkpoint while handle is still active with open reserve
    const cp = await host1.handle(
      'session.checkpoint',
      {},
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-1' },
    )
    assert.equal(cp.ok, true)
    if (!cp.ok) return
    const version = Number(cp.result['session_version'])
    const committedAtCp = host1.store.getCommitted(created.sessionId, version)
    assert.ok(committedAtCp)
    assert.equal(committedAtCp!.budget.poolRemaining, afterReserve)
    assert.ok(
      committedAtCp!.budget.openReserves.some(r => r.handleId === handleId),
    )

    // Child completes after checkpoint — settlement must land on domain ledger tail
    release()
    await host1.drain()
    const afterSettle = host1.getSessionPoolRemaining()
    assert.ok(afterSettle > afterReserve) // unspent reserve refunded
    assert.ok(afterSettle < 1000) // actual usage charged
    const liveAfter = host1.store.getLive(created.sessionId)
    assert.ok(liveAfter)
    assert.equal(liveAfter!.openReserves.has(handleId), false)
    assert.ok(liveAfter!.settlements.some(s => s.handleId === handleId))
    const terminalEvents = host1.store
      .getLedger(created.sessionId)
      .filter(r => r.recordType === 'domain' && r.kind === 'handle.terminal')
    assert.ok(terminalEvents.length >= 1)
    const terminal = terminalEvents[terminalEvents.length - 1]
    assert.ok(terminal && terminal.recordType === 'domain')
    assert.equal(terminal._actualUsageTokens, 40)
    assert.equal(terminal._poolRemainingAfter, afterSettle)

    // Crash: new Host + store from disk, resume applies post-cutoff domain tail
    const host2 = new SessionAsyncHost({
      enabled: true,
      principalId: 'p',
      sessionTokenPool: 1000,
      sessionStoreRoot: root,
      capabilityRegistry: host1.capabilities,
    })
    const resumed = await host2.handle(
      'session.resume',
      {
        sessionId: created.sessionId,
        capabilityToken: created.sessionToken,
        version,
      },
      { hostEffectOccupied: false, occupy: () => {}, parentRunId: 'run-2' },
    )
    assert.equal(resumed.ok, true)
    assert.equal(host2.getSessionPoolRemaining(), afterSettle)
    const live2 = host2.store.getLive(created.sessionId)
    assert.ok(live2)
    assert.equal(live2!.openReserves.has(handleId), false)
    assert.equal(live2!.poolRemaining, afterSettle)
    const settledHandle = live2!.handles.get(handleId)
    assert.ok(settledHandle)
    assert.equal(settledHandle!.status, 'completed')
    assert.equal(settledHandle!.settled, true)
    assert.equal(settledHandle!.actualUsageTokens, 40)
    assert.ok(live2!.settlements.some(s => s.handleId === handleId && s.actualUsageTokens === 40))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refundSpawnReserve returns full reserve', () => {
  const s = refundSpawnReserve(900, 100)
  assert.equal(s.chargedTokens, 0)
  assert.equal(s.remainingAfter, 1000)
  assert.equal(s.overflowTokens, 0)
})

test('B2 child actor bind: runAsChild enables self mailbox without token in trace', async () => {
  const host = new SessionAsyncHost({
    enabled: true,
    principalId: 'principal-a',
    sessionTokenPool: 16_384,
    childPortFactory: async () => ({
      port: {
        async invokeLLM() {
          return {
            content: [{ type: 'text', text: 'child-work' }],
            toolCalls: [],
            usage: { inputTokens: 2, outputTokens: 2 },
          }
        },
        async invokeTool() {
          throw new Error('no tools')
        },
        async now() {
          return Date.now()
        },
        async uuid() {
          return 'u'
        },
      } as unknown as IIOPort,
      attached: true,
      detach: async () => undefined,
    }),
    model: 'test-model',
  })
  host.setParentRunId('run-parent-bind')
  await createParentSession(host)

  // Spawn (occupies effect)
  const spawn = await host.handle(
    'agents.spawn',
    { instructions: 'bind child actor' },
    {
      hostEffectOccupied: false,
      occupy: () => {},
      parentRunId: 'run-parent-bind',
    },
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) throw new Error('unreachable')
  const handleId = String(spawn.result['handle_id'])
  const childRunId = String(spawn.result['child_run_id'])
  assert.equal(host.hasChildCapability(childRunId), true)

  // Parent binding must remain parent after spawn scheduling
  assert.equal(host.capabilityProjection().enabled, true)

  // As child: can send to session.control; cannot lookup (businessError deny)
  await host.runAsChild(childRunId, async () => {
    const lookup = await host.handle(
      'session.lookup',
      {},
      { hostEffectOccupied: false, occupy: () => {} },
    )
    assert.equal(lookup.ok, true)
    if (!lookup.ok) throw new Error('unreachable')
    assert.equal(lookup.businessError?.code, 'SESSION_AUTH_DENIED')
    assert.equal(lookup.result['handles'], undefined)

    const send = await host.handle(
      'mailbox.send',
      {
        to: SESSION_CONTROL_MAILBOX_ID,
        payload: { from_child: handleId, note: 'progress' },
      },
      {
        hostEffectOccupied: false,
        occupy: () => {},
      },
    )
    assert.equal(send.ok, true)
    if (!send.ok) throw new Error('unreachable')
    assert.equal(send.businessError, undefined)
  })

  // Parent can receive the control message after child send
  // Need a fresh cell (effect slot)
  await host.drain()
  const recv = await host.handle(
    'mailbox.receive',
    { mailbox_id: SESSION_CONTROL_MAILBOX_ID, timeout_ms: 0 },
    {
      hostEffectOccupied: false,
      occupy: () => {},
    },
  )
  assert.equal(recv.ok, true)
})
