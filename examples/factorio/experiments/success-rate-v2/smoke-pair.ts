#!/usr/bin/env npx tsx
/** One-pair live smoke. Analysis of a subset is indeterminate, never official. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pins } from '../../src/cli-common.js'
import { resolveFactorioExperimentCase } from '../../src/experiment/cases.js'
import {
  EXAMPLE_BUNDLE,
} from '../../src/refinement-host.js'
import {
  assembleFactorioRun,
  createFactorioHostBundle,
} from '../../src/harness-host.js'
import { runAssembledFactorioLive } from '../../src/live.js'
import { connectModel } from '../../src/model-connection.js'
import {
  assertIsolatedExperimentStateRoot,
  experimentFreezePath,
  parseFactorioExperimentFreeze,
} from '../../src/experiment/freeze.js'
import { validateFactorioOverlayTaskAgnostic } from '../../src/overlay-protocol-guard.js'

const root = assertIsolatedExperimentStateRoot()
const caseId = process.argv[2]
const arm = process.argv[3]
if (caseId === undefined || (arm !== 'baseline' && arm !== 'candidate')) {
  throw new Error('usage: smoke-pair.ts <caseId> <baseline|candidate>')
}

const freeze = parseFactorioExperimentFreeze(
  readFileSync(experimentFreezePath(root), 'utf8'),
  EXAMPLE_BUNDLE,
)
const row = freeze.matrix.find(item => item.caseId === caseId)
if (row === undefined) throw new Error(`caseId is not in the freeze matrix: ${caseId}`)
const profile = resolveFactorioExperimentCase({ inputRef: row.inputRef, seed: row.slot })
const rcsPath = path.join(root, 'refinement-control.json')
let overlayRef:
  | { kind: 'overlay'; id: string; revision: number; contentHash: string }
  | undefined
if (arm === 'candidate') {
  if (!existsSync(rcsPath)) throw new Error('candidate overlay missing')
  const snapshot = JSON.parse(readFileSync(rcsPath, 'utf8')) as {
    candidates?: Array<{ overlayRef?: { kind: 'overlay'; id: string; revision: number; contentHash: string } }>
    harness?: {
      overlays?: Array<{
        ref: { contentHash: string }
        overlay: Parameters<typeof validateFactorioOverlayTaskAgnostic>[0]
      }>
    }
  }
  overlayRef = snapshot.candidates?.at(-1)?.overlayRef
  if (overlayRef === undefined) throw new Error('candidate overlay missing')
  const stored = snapshot.harness?.overlays?.find(item => item.ref.contentHash === overlayRef.contentHash)
  if (stored === undefined) throw new Error('candidate overlay payload missing')
  const leak = validateFactorioOverlayTaskAgnostic(stored.overlay)
  if (leak !== undefined) throw new Error(leak)
}

const connected = connectModel({ purpose: 'generate', config: { env: process.env } })
if (connected.projection.model === undefined || connected.gateway === undefined) {
  throw new Error('model gateway required')
}
const model = connected.projection.model
const bundle = createFactorioHostBundle({ rootDir: root })
const assembled = assembleFactorioRun({
  bundle,
  basePins: pins(model, profile),
  baselineRef: bundle.defaultBaselineRef,
  ...(arm === 'candidate' ? { overlayRef, admission: 'evaluator' as const } : {}),
})
const runId = `v2-smoke-${arm}-${caseId}`
const evidenceDir = path.join(root, 'evidence', caseId, arm)
mkdirSync(evidenceDir, { recursive: true })
const evidencePath = path.join(evidenceDir, 'live.json')
const started = Date.now()
const { evidence } = await runAssembledFactorioLive({
  assembled,
  model,
  runId,
  gateway: connected.gateway,
  evidencePath,
  experimentProfile: profile,
  freezeId: freeze.freezeId,
  contentDigest: freeze.contentDigest,
})
const summary = {
  caseId,
  arm,
  runId,
  verdict: evidence.verdict,
  success: evidence.finalProjection.verification.success,
  termination: evidence.termination,
  cost: evidence.finalProjection.modelCallCount,
  latencyMs: Date.now() - started,
  evidencePath,
}
writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
process.exitCode = 0
