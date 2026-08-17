import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { pins } from '../src/cli-common.js'
import {
  assembleFactorioRun,
  createFactorioHostBundle,
  openFactorioReplayHost,
} from '../src/harness-host.js'
import {
  createFactorioRefinementCommandHost,
  createFactorioFixtureAssertion,
  EXAMPLE_BUNDLE,
  extractGeneratedOverlayJson,
  extractFactorioEvaluationMetrics,
  factorioArmMetrics,
  FACTORIO_EXTRACTOR_DIGEST,
  parseHarnessStateRef,
  parseRecordedFactorioLiveEvidence,
  projectFactorioGenerationInput,
} from '../src/refinement-host.js'
import { reconstructFactorioReplayHarness } from '../src/replay.js'
import { factorioFinalizationId } from '../src/live.js'
import type { LiveEvidence } from '../src/types.js'
import type { IIOPort } from 'milkie/dist/runtime/IOPort.js'
import { RefinementError } from '../../../src/refinement/errors.js'
import {
  evaluateAndWait,
  executeRefinementCommand,
  proposeAndWait,
} from '../../../src/refinement/commands.js'
import { RefinementWorkflow } from '../../../src/refinement/workflow.js'
import { signConfiguration } from '../../../src/refinement/trust.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function recordedLive(runId: string, success: boolean): LiveEvidence {
  return {
    schema: 'helix.factorio.live/v3',
    verdict: success ? 'pass' : 'fail',
    runId,
    pins: pins('test-model'),
    budget: { deadlineAt: 1, remainingWallMsAtEnd: 1_000 },
    termination: success ? 'verifier_succeeded' : 'environment_failed',
    projectionDigest: 'd'.repeat(64),
    traceFile: 'trace.jsonl',
    objectStore: 'objects',
    finalProjection: {
      runId,
      episodeId: `${runId}:episode:0`,
      kernelRevision: 1,
      resetCount: 1,
      stepCount: 4,
      modelCallCount: 3,
      recursiveCallCount: 0,
      remainingRecursiveModelTokens: 0,
      cells: [{
        schema: 'helix.cell-execution/v3',
        cellId: `${runId}:cell:0`,
        source: 'x'.repeat(5_000),
        sourceDigest: 'c'.repeat(64),
        startRevision: 0,
        endRevision: 1,
        status: 'error',
        stdoutPreview: '',
        stderrPreview: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        namespace: [],
        managedObjects: [],
        error: { code: 'FIXTURE', message: 'm'.repeat(1_000) },
      }],
      verification: { success, meta: [] },
      terminated: true,
      truncated: false,
    },
    finalization: {
      status: 'finalized',
      value: success ? 'success' : 'failure',
      verifierId: 'fle',
      finalizationId: 'fin',
      intentHash: 'i'.repeat(64),
      recordHash: 'r'.repeat(64),
    },
    childRunIds: [],
    checks: [],
  }
}

const policy = {
  schemaVersion: 'helix.refinement-policy/v1' as const,
  generation: { model: 'fixture-recorded-model', maxOutputTokens: 64 },
  extractorDigest: FACTORIO_EXTRACTOR_DIGEST,
  gate: { minQualityDelta: 0.1, maxCostRatio: 2, maxLatencyRatio: 2, maxFailureRateDelta: 0 },
  authority: { manualApprovers: ['factorio-fixture-researcher'] },
}

const suite = {
  schemaVersion: 'helix.refinement-suite/v1' as const,
  cases: [{ caseId: 'holdout', inputRef: 'in', seed: 0, weight: 1 }],
}

function stubPort(overlayText: string): IIOPort {
  return {
    async invokeLLM() {
      return {
        content: [{ type: 'text', text: overlayText }],
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 8 },
      }
    },
    async invokeTool(_name, _input, execute) {
      return execute(new AbortController().signal)
    },
    now: () => 1,
    uuid: () => 'factorio-refinement-test',
  }
}

function fixtureHost(bundle: ReturnType<typeof createFactorioHostBundle>) {
  return createFactorioRefinementCommandHost({
    rcs: bundle.rcs,
    generationModel: 'fixture-recorded-model',
    innerPort: stubPort(JSON.stringify({
      schemaVersion: 'helix.harness-overlay/v1',
      baseBaselineRef: bundle.defaultBaselineRef,
      changes: { taskNarrativeTemplate: 'refined factorio task narrative' },
    })),
    readLive: runId => recordedLive(runId, false),
    runArm: ({ arm, reservedRunRef }) => ({
      runRef: reservedRunRef,
      quality: arm === 'candidate' ? 1 : 0.5,
      cost: 10,
      latencyMs: 10,
      failed: false,
    }),
  })
}

function publishFactorioFixtureConfiguration(
  workflow: RefinementWorkflow,
  id: string,
  key: 'policy' | 'suite',
  value: typeof policy | typeof suite,
) {
  return key === 'policy'
    ? workflow.publishPolicy({
        id,
        policy: value as typeof policy,
        issuer: 'factorio-fixture-hrca',
        keyId: 'factorio-fixture-policy-key',
        signature: signConfiguration(value, 'factorio-fixture-policy-secret'),
        bundle: EXAMPLE_BUNDLE,
      })
    : workflow.publishSuite({
        id,
        suite: value as typeof suite,
        issuer: 'factorio-fixture-hrca',
        keyId: 'factorio-fixture-policy-key',
        signature: signConfiguration(value, 'factorio-fixture-policy-secret'),
        bundle: EXAMPLE_BUNDLE,
      })
}

test('S1 live and replay Host share one RCS snapshot', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-rcs-'))
  try {
    const live = createFactorioHostBundle({ rootDir: root })
    const replay = openFactorioReplayHost({ rootDir: root })
    assert.equal(live.rcs.exportSnapshot().baselines.length, replay.store.exportSnapshot().baselines.length)
    assert.equal(live.defaultBaselineRef.contentHash, replay.store.read(live.defaultBaselineRef).ref.contentHash)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S2 Factorio exports a loadable refinement command host', () => {
  const host = fixtureHost(createFactorioHostBundle())
  assert.equal(typeof host.adapter.generate, 'function')
  assert.ok(host.rcs)
  assert.equal(host.trustBundle.schemaVersion, 'helix.refinement-trust-bundle/v1')
})

test('S2 refinement CLI loads the relocated Factorio Host', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-cli-'))
  try {
    const result = spawnSync(
      path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
      [
        path.join(REPO_ROOT, 'src/refinement/cli.ts'),
        'refine',
        'show',
        'generation-job',
        '--host-module', path.join(REPO_ROOT, 'examples/factorio/src/refinement-host.ts'),
        '--ref', `generation-job:missing@0#${'0'.repeat(64)}`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HELIX_LLM_TRANSPORT: 'api',
          HELIX_LLM_PROTOCOL: 'anthropic-messages',
          HELIX_LLM_MODEL: 'fixture-recorded-model',
          HELIX_LLM_API_KEY: 'sk-test-fixture',
        },
      },
    )
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, /unknown file extension|Cannot find module|host module must export/)
    assert.ok(existsSync(path.join(root, 'artifacts/factorio/harness-state/refinement-control.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P3 invalid recorded input fails closed before any generation IOPort call', async () => {
  const bundle = createFactorioHostBundle()
  let invocations = 0
  const host = createFactorioRefinementCommandHost({
    rcs: bundle.rcs,
    generationModel: 'fixture-recorded-model',
    innerPort: {
      ...stubPort('{}'),
      async invokeLLM() {
        invocations += 1
        return { content: [], toolCalls: [] }
      },
    },
    readLive: () => undefined,
    runArm: ({ reservedRunRef }) => ({
      runRef: reservedRunRef,
      quality: 0,
      cost: 0,
      latencyMs: 0,
      failed: true,
    }),
  })
  const workflow = new RefinementWorkflow(host.rcs, host.adapter)
  const policyRef = publishFactorioFixtureConfiguration(workflow, 'closed-policy', 'policy', policy)
  await assert.rejects(
    workflow.propose({
      proposalId: 'missing-recorded-run',
      sourceRunRefs: ['not-recorded'],
      baselineRef: bundle.defaultBaselineRef,
      policyRef,
    }),
    /recorded Factorio run is missing/,
  )
  assert.equal(invocations, 0)
})

test('P3 fixture assertion is human-scoped and does not grant auto-promotion', () => {
  const now = new Date('2030-01-01T00:00:00Z')
  const assertion = createFactorioFixtureAssertion({
    operation: 'refine.promote.manual',
    nonce: 'fixture-human-promotion',
    now,
  })
  assert.equal(assertion.subject, 'factorio-fixture-researcher')
  assert.equal(assertion.operation, 'refine.promote.manual')
  assert.equal(EXAMPLE_BUNDLE.autoGrantKeys.length, 0)
  assert.equal(EXAMPLE_BUNDLE.assertionKeys.length, 1)
  assert.ok(Date.parse(assertion.issuedAt) < now.getTime())
  assert.ok(Date.parse(assertion.expiresAt) > now.getTime())
})

test('P3 Factorio Host rejects a policy whose model pin differs from the live model', async () => {
  const bundle = createFactorioHostBundle()
  const host = fixtureHost(bundle)
  const workflow = new RefinementWorkflow(host.rcs, host.adapter)
  const policyRef = publishFactorioFixtureConfiguration(workflow, 'wrong-model', 'policy', {
    ...policy,
    generation: { ...policy.generation, model: 'another-model' },
  })
  await assert.rejects(
    workflow.propose({
      proposalId: 'wrong-model',
      sourceRunRefs: ['recorded-p1'],
      baselineRef: bundle.defaultBaselineRef,
      policyRef,
    }),
    /policy model must equal connected model/,
  )
})

test('P3 failed candidate cannot produce a promotable Factorio evaluation metric', () => {
  const failed = recordedLive('candidate-failed', false)
  assert.equal(factorioArmMetrics('baseline', failed).quality, 0)
  assert.throws(
    () => factorioArmMetrics('candidate', failed),
    /candidate FLE verification must succeed/,
  )
  assert.equal(factorioArmMetrics('candidate', recordedLive('candidate-passed', true)).quality, 1)
})

test('P3 fixture E2E: recorded P1 → propose → two arms → request → human promotion → next overlay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-p3-e2e-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const host = fixtureHost(bundle)
    const workflow = new RefinementWorkflow(host.rcs, host.adapter)
    const policyRef = publishFactorioFixtureConfiguration(workflow, 'p3-e2e-policy', 'policy', policy)
    const suiteRef = publishFactorioFixtureConfiguration(workflow, 'p3-e2e-suite', 'suite', suite)
    const proposed = await proposeAndWait(host, {
      command: 'propose',
      assertion: createFactorioFixtureAssertion({ operation: 'refine.propose', nonce: 'p3-e2e-propose' }),
      proposal: {
        proposalId: 'p3-e2e',
        sourceRunRefs: ['recorded-p1'],
        baselineRef: bundle.defaultBaselineRef,
        policyRef,
      },
    })
    const evaluated = await evaluateAndWait(host, {
      command: 'evaluate',
      assertion: createFactorioFixtureAssertion({ operation: 'refine.evaluate', nonce: 'p3-e2e-evaluate' }),
      evaluation: { candidateRef: proposed.candidateRef, policyRef, suiteRef },
    })
    assert.equal(evaluated.report.verdict, 'passed')
    assert.equal(evaluated.report.cases.length, 1)
    assert.notEqual(
      evaluated.report.cases[0]!.baseline.runRef,
      evaluated.report.cases[0]!.candidate.runRef,
    )
    const requestRef = await executeRefinementCommand(host, {
      command: 'request',
      assertion: createFactorioFixtureAssertion({ operation: 'refine.request', nonce: 'p3-e2e-request' }),
      report: evaluated.report,
    }) as typeof policyRef
    const promoted = await executeRefinementCommand(host, {
      command: 'promote-manual',
      assertion: createFactorioFixtureAssertion({ operation: 'refine.promote.manual', nonce: 'p3-e2e-promote' }),
      requestRef,
      policyRef,
    }) as { overlayRef: { kind: 'overlay'; id: string; revision: number; contentHash: string } }
    const nextRun = assembleFactorioRun({
      bundle,
      basePins: pins('fixture-recorded-model'),
      baselineRef: bundle.defaultBaselineRef,
      overlayRef: promoted.overlayRef,
    })
    assert.equal(nextRun.pins.harnessState?.overlayRef?.contentHash, promoted.overlayRef.contentHash)
    assert.equal(bundle.rcs.exportSnapshot().baselines.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S3 live overlay selection admits only promoted refs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-overlay-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const host = fixtureHost(bundle)
    const workflow = new RefinementWorkflow(host.rcs, host.adapter)
    const policyRef = publishFactorioFixtureConfiguration(workflow, 'factorio-policy', 'policy', policy)
    const suiteRef = publishFactorioFixtureConfiguration(workflow, 'factorio-suite', 'suite', suite)
    const ack = await workflow.propose({
      proposalId: 'factorio-proposal',
      sourceRunRefs: ['factorio-source'],
      baselineRef: bundle.defaultBaselineRef,
      policyRef,
    })
    const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef
    assert.ok(candidateRef)
    const report = await workflow.evaluate({ candidateRef, policyRef, suiteRef })
    assert.equal(report.cases.length, 1)
    assert.match(report.cases[0]!.baseline.runRef, /^recorded-evaluation:/)
    assert.match(report.cases[0]!.candidate.runRef, /^recorded-evaluation:/)
    assert.notEqual(report.cases[0]!.baseline.runRef, report.cases[0]!.candidate.runRef)
    const requestRef = workflow.request(report)
    const candidate = host.rcs.getArtifact<{ overlayRef: { kind: string; id: string; revision: number; contentHash: string } }>(
      `${candidateRef.kind}:${candidateRef.id}@${candidateRef.revision}#${candidateRef.contentHash}`,
    )!
    assert.throws(
      () => assembleFactorioRun({
        bundle,
        basePins: pins('m'),
        baselineRef: bundle.defaultBaselineRef,
        overlayRef: candidate.overlayRef,
      }),
      (error: unknown) => error instanceof RefinementError,
    )
    const promotion = workflow.manualPromote({
      requestRef,
      subject: 'factorio-fixture-researcher',
      policyRef,
    })
    const assembled = assembleFactorioRun({
      bundle,
      basePins: pins('m'),
      baselineRef: bundle.defaultBaselineRef,
      overlayRef: promotion.overlayRef,
    })
    assert.equal(assembled.pins.harnessState?.overlayRef?.contentHash, promotion.overlayRef.contentHash)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('S4 replay after promotion still uses recorded pins hash', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-factorio-replay-overlay-'))
  try {
    const bundle = createFactorioHostBundle({ rootDir: root })
    const liveAssembled = assembleFactorioRun({
      bundle,
      basePins: pins('replay-model'),
      baselineRef: bundle.defaultBaselineRef,
    })
    const recordedHash = liveAssembled.frozen.harnessContentHash
    const host = fixtureHost(bundle)
    const workflow = new RefinementWorkflow(host.rcs, host.adapter)
    const policyRef = publishFactorioFixtureConfiguration(workflow, 'replay-policy', 'policy', policy)
    const suiteRef = publishFactorioFixtureConfiguration(workflow, 'replay-suite', 'suite', suite)
    const ack = await workflow.propose({
      proposalId: 'replay-proposal',
      sourceRunRefs: ['source'],
      baselineRef: bundle.defaultBaselineRef,
      policyRef,
    })
    const candidateRef = workflow.showGenerationJob(ack.generationJobRef).candidateRef!
    const report = await workflow.evaluate({ candidateRef, policyRef, suiteRef })
    workflow.manualPromote({
      requestRef: workflow.request(report),
      subject: 'factorio-fixture-researcher',
      policyRef,
    })
    const reconstructed = reconstructFactorioReplayHarness(
      { pins: liveAssembled.pins, harness: liveAssembled.freeze.evidence },
      { rootDir: root },
    )
    assert.equal(reconstructed.freeze.frozen.harnessContentHash, recordedHash)
    assert.equal(reconstructed.pins.harnessState?.overlayRef, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('P3 extracts one model-authored overlay object from explanatory transport text', () => {
  const payload = extractGeneratedOverlayJson(
    'I will improve the task narrative.\n```json\n{"schemaVersion":"helix.harness-overlay/v1","baseBaselineRef":{"kind":"baseline"},"changes":{"taskNarrativeTemplate":"be concise"}}\n```',
  )
  assert.match(payload, /^\{"schemaVersion"/)
  assert.throws(
    () => extractGeneratedOverlayJson('{"schemaVersion":"helix.harness-overlay/v1"} and {"schemaVersion":"helix.harness-overlay/v1"}'),
    /exactly one complete/,
  )
})

test('P3 projection is a bounded summary and rejects unfinished runs', () => {
  const live = recordedLive('factorio-ok', false)
  const projection = projectFactorioGenerationInput(['factorio-ok'], {
    readLive: (runId) => runId === 'factorio-ok' ? live : undefined,
  })
  assert.equal(projection.sourceRunRefs[0], 'factorio-ok')
  assert.equal(projection.outcomes[0]?.verificationSuccess, false)
  assert.equal(projection.outcomes[0]?.recentFeedback.length, 1)
  assert.equal(projection.outcomes[0]?.recentFeedback[0]?.source.length, 4_000)
  assert.equal(projection.outcomes[0]?.recentFeedback[0]?.error?.message?.length, 512)
  assert.match(projection.generationInstruction, /recentFeedback/)
  assert.match(projection.generationInstruction, /exactly one JSON object/)
  assert.equal('cells' in projection, false)
  assert.throws(
    () => projectFactorioGenerationInput(['missing'], { readLive: () => undefined }),
    /recorded Factorio run/,
  )
  const unfinished = recordedLive('factorio-open', false)
  unfinished.termination = 'cancelled'
  unfinished.finalization.value = 'unknown'
  assert.throws(
    () => projectFactorioGenerationInput(['factorio-open'], { readLive: () => unfinished }),
    /not terminal/,
  )
})

test('P3 recorded-live parser accepts FLE coordinates while rejecting malformed projection', () => {
  const source = recordedLive('factorio-negative-coordinate', true) as LiveEvidence & {
    finalProjection: LiveEvidence['finalProjection'] & { cells: Array<{ observation?: { x: number } }> }
  }
  source.finalProjection.cells = [{ observation: { x: -12.5 } }]
  const parsed = parseRecordedFactorioLiveEvidence(JSON.stringify(source))
  assert.equal(parsed.finalProjection.modelCallCount, 3)
  assert.throws(
    () => parseRecordedFactorioLiveEvidence('{"runId":"broken"}'),
    /projection is invalid/,
  )
})

test('P3 extractor reads FLE outcome not handwritten constants', () => {
  const pass = extractFactorioEvaluationMetrics(recordedLive('win', true))
  const fail = extractFactorioEvaluationMetrics(recordedLive('lose', false))
  assert.equal(pass.quality, 1)
  assert.equal(pass.failed, false)
  assert.equal(fail.quality, 0)
  assert.equal(fail.failed, true)
  assert.equal(pass.cost, 3)
  assert.ok(pass.latencyMs > 0)
})

test('parseHarnessStateRef accepts a complete overlay ref', () => {
  const ref = parseHarnessStateRef(`overlay:o1@0#${'a'.repeat(64)}`)
  assert.equal(ref.kind, 'overlay')
  assert.equal(ref.id, 'o1')
})

test('P3 evaluator finalization ID is deterministic and bounded for reserved run refs', () => {
  const runRef = `recorded-evaluation:${'a'.repeat(180)}`
  const id = factorioFinalizationId(runRef)
  assert.equal(id.length, 78)
  assert.equal(id, factorioFinalizationId(runRef))
  assert.equal(factorioFinalizationId('factorio-p1'), 'factorio-p1:eval:fle:v2')
})
