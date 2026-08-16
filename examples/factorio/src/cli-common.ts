import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FileTraceObjectStore, type TaskOutcomeFinalization } from 'milkie'
import {
  HarnessError,
  type JsonTextValue,
} from '../../../src/harness/index.js'
import { canonicalJson } from './canonical.js'
import { parseFactorioEvidenceJsonText } from './evidence-json.js'
import type {
  FinalizationSummary,
  LiveEvidence,
  ReplayEvidence,
  RunPins,
} from './types.js'

export const ARTIFACT_ROOT = path.resolve('artifacts/factorio')
export const TRACE_ROOT = path.join(ARTIFACT_ROOT, 'traces')
export const OBJECT_ROOT = path.join(ARTIFACT_ROOT, 'objects')
export const FINALIZATION_ROOT = path.join(ARTIFACT_ROOT, 'final-outcomes')
/** Durable Helix session ledger/checkpoint root (Issue #7). */
export const SESSION_STORE_ROOT = path.join(ARTIFACT_ROOT, 'sessions')
/** Host-held immutable harness Store + legacy registry root (Issue #10). */
export const HARNESS_STATE_ROOT = path.join(ARTIFACT_ROOT, 'harness-state')
export const LIVE_WALL_TIMEOUT_MS = 30 * 60 * 1_000
export const REPLAY_WALL_TIMEOUT_MS = 5 * 60 * 1_000
export const MILKIE_COMMIT = 'fec0ebfb99f57e04a0812fc74fd01f85e9b81b57'

export {
  CHILD_REPLAY_SAFETY_WALL_MS,
  CONTROL_SETTLE_TOLERANCE_MS,
  DEFAULT_PARENT_RECURSIVE_TOKEN_POOL,
  MAX_RECURSIVE_CALLS_PER_RUN,
  MAX_RECURSIVE_COMPLETION_TOKENS,
  MAX_RECURSIVE_INSTRUCTIONS_BYTES,
  MAX_RECURSIVE_INPUT_BYTES,
  MAX_RECURSIVE_PROMPT_TOKENS,
  MIN_RESERVE_TOKENS,
} from './recursive-model.js'

export const TASK_DIGEST =
  'sha256:c50497c8548123494e48376e51ace2dd4f66717421de3a9f930d5833b6572f44'
const FACTORIO_CONTAINER = 'helix-factorio_0'
const FACTORIO_IMAGE = 'factoriotools/factorio:2.0.73'

export type CommandRunner = (file: string, args: string[]) => string

const defaultRunner: CommandRunner = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8' })

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

export function pins(model: string): RunPins {
  // Default #5-compatible path (no session-async pin).
  return pinsV4(model)
}

/** Issue #7 session-async pins (harness v5 + sessionAsyncVersion). */
export function pinsSessionAsync(model: string): RunPins {
  return {
    model,
    harness: 'factorio-rlm/v5',
    kernelProtocol: '2',
    bindingSet: 'factorio/v4',
    renderer: 'markdown-json/v1',
    isolationProfile: 'local-process-ast/v2',
    milkie: MILKIE_COMMIT,
    fle: '0.4.3',
    factorioServer: '2.0.73',
    taskId: 'iron_ore_throughput',
    taskDigest: TASK_DIGEST,
    kernelMemoryBytes: 1_073_741_824,
    kernelCpuSeconds: 600,
    sessionAsyncVersion: '1',
  }
}

/** v4 pins factory retained for legacy gate tests. */
export function pinsV4(model: string): RunPins {
  return {
    model,
    harness: 'factorio-rlm/v4',
    kernelProtocol: '2',
    bindingSet: 'factorio/v3',
    renderer: 'markdown-json/v1',
    isolationProfile: 'local-process-ast/v2',
    milkie: MILKIE_COMMIT,
    fle: '0.4.3',
    factorioServer: '2.0.73',
    taskId: 'iron_ore_throughput',
    taskDigest: TASK_DIGEST,
    kernelMemoryBytes: 1_073_741_824,
    kernelCpuSeconds: 600,
  }
}

export function preflightLive(
  runner: CommandRunner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Model credentials are resolved by connectModel (HELIX_LLM_*), not preflight.
  const inspected = JSON.parse(
    runner('docker', [
      'inspect',
      '--format',
      '{"running":{{.State.Running}},"image":{{json .Config.Image}},"label":{{json (index .Config.Labels "io.xforce.helix.factorio-smoke")}}}',
      FACTORIO_CONTAINER,
    ]),
  ) as Record<string, unknown>
  if (inspected['running'] !== true) {
    throw new Error(`${FACTORIO_CONTAINER} is not running`)
  }
  if (inspected['image'] !== FACTORIO_IMAGE) {
    throw new Error(
      `Factorio image mismatch: expected ${FACTORIO_IMAGE}, got ${String(inspected['image'])}`,
    )
  }
  if (inspected['label'] !== 'true') {
    throw new Error(`Factorio container label mismatch for ${FACTORIO_CONTAINER}`)
  }
  const python =
    env['HELIX_FACTORIO_PYTHON'] ?? path.resolve('examples/factorio/.venv/bin/python')
  const facts = JSON.parse(
    runner(python, [path.resolve('examples/factorio/workers/preflight_worker.py')]),
  ) as Record<string, unknown>
  if (facts['fle'] !== '0.4.3') {
    throw new Error(`FLE version mismatch: expected 0.4.3, got ${String(facts['fle'])}`)
  }
  if (facts['taskId'] !== 'iron_ore_throughput' || facts['taskDigest'] !== TASK_DIGEST) {
    throw new Error('FLE task identity or digest mismatch')
  }
  if (facts['rconReachable'] !== true) {
    throw new Error('Factorio RCON handshake endpoint is unreachable')
  }
}

export async function writeEvidence(
  runId: string,
  kind: 'live' | 'replay',
  evidence: LiveEvidence | ReplayEvidence,
  explicitPath?: string,
): Promise<string> {
  const target = path.resolve(
    explicitPath ?? path.join(ARTIFACT_ROOT, 'runs', runId, `${kind}.json`),
  )
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${canonicalJson(evidence)}\n`, 'utf8')
  return target
}

export function objectStore(): FileTraceObjectStore {
  return new FileTraceObjectStore(OBJECT_ROOT)
}

export function summarizeFinalization(
  status: 'finalized' | 'idempotent',
  final: TaskOutcomeFinalization,
): FinalizationSummary {
  return {
    status,
    value: final.value,
    verifierId: final.verifierClaim.id,
    finalizationId: final.finalizationId,
    intentHash: final.intentHash,
    recordHash: final.recordHash,
  }
}

export async function attachEvidenceRef<T extends LiveEvidence | ReplayEvidence>(
  store: FileTraceObjectStore,
  evidence: T,
): Promise<T> {
  const evidenceRef = await store.putCanonical(canonicalJson(evidence))
  return { ...evidence, evidenceRef }
}

/**
 * Read live evidence with strict harness JSON text rules before materialization.
 * Duplicate keys / non-canonical numbers fail closed as HARNESS_JSON_INVALID.
 */
export async function readLiveEvidence(runId: string): Promise<LiveEvidence> {
  const file = path.join(ARTIFACT_ROOT, 'runs', runId, 'live.json')
  const text = await fs.readFile(file, 'utf8')
  return parseLiveEvidenceText(text)
}

/**
 * Parse live evidence JSON text (exported for integration regressions that
 * exercise the same gate as the CLI path without touching disk).
 */
export function parseLiveEvidenceText(text: string): LiveEvidence {
  let value: JsonTextValue
  try {
    value = parseFactorioEvidenceJsonText(text)
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new HarnessError(
      'HARNESS_JSON_INVALID',
      `live evidence JSON text invalid: ${String(error)}`,
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError(
      'HARNESS_JSON_INVALID',
      'live evidence root must be a JSON object',
    )
  }
  // Strict text gate only; schema validation remains on consumers.
  return value as unknown as LiveEvidence
}
