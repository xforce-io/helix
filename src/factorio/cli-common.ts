import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FileTraceObjectStore } from 'milkie'
import { canonicalJson } from './canonical.js'
import type { LiveEvidence, ReplayEvidence, RunPins } from './types.js'

export const ARTIFACT_ROOT = path.resolve('artifacts/factorio')
export const TRACE_ROOT = path.join(ARTIFACT_ROOT, 'traces')
export const OBJECT_ROOT = path.join(ARTIFACT_ROOT, 'objects')
export const MILKIE_COMMIT = 'fc73bfa3fa6c2d7a1e5bb4fd81ea2b2da1997b5a'
export const TASK_DIGEST =
  'sha256:c50497c8548123494e48376e51ace2dd4f66717421de3a9f930d5833b6572f44'

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

export function requireModel(): string {
  const model = argument('--model') ?? process.env['ANTHROPIC_MODEL']
  if (!model) throw new Error('missing --model and ANTHROPIC_MODEL')
  return model
}

export function pins(model: string): RunPins {
  return {
    model,
    harness: 'factorio-rlm/v1',
    kernelProtocol: '1',
    bindingSet: 'factorio/v1',
    renderer: 'markdown-json/v1',
    isolationProfile: 'local-process-ast/v1',
    milkie: MILKIE_COMMIT,
    fle: '0.4.3',
    factorioServer: '2.0.73',
    taskId: 'iron_ore_throughput',
    taskDigest: TASK_DIGEST,
  }
}

export function preflightLive(): void {
  if (!process.env['ANTHROPIC_AUTH_TOKEN'] && !process.env['ANTHROPIC_API_KEY']) {
    throw new Error('missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY')
  }
  const names = execFileSync(
    'docker',
    ['ps', '--filter', 'name=factorio_', '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  )
  if (!names.trim()) {
    throw new Error('no running Factorio container; run npm run factorio:cluster:start')
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

export async function attachEvidenceRef<T extends LiveEvidence | ReplayEvidence>(
  store: FileTraceObjectStore,
  evidence: T,
): Promise<T> {
  const evidenceRef = await store.putCanonical(canonicalJson(evidence))
  return { ...evidence, evidenceRef }
}

export async function readLiveEvidence(runId: string): Promise<LiveEvidence> {
  const file = path.join(ARTIFACT_ROOT, 'runs', runId, 'live.json')
  return JSON.parse(await fs.readFile(file, 'utf8')) as LiveEvidence
}
