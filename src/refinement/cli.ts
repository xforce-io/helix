#!/usr/bin/env node
/** Internal `helix refine fixture-smoke` CLI; production Host supplies its own recorded-run adapter. */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { baselineContentHash, type HarnessDocument, type HarnessPinsV1, type HarnessStateRef } from '../harness/index.js'
import { RefinementControlStore } from './control-store.js'
import { signConfiguration, type RefinementTrustBundleV1 } from './trust.js'
import { executeRefinementCommand, type RefinementCommand, type RefinementCommandHost } from './commands.js'
import {
  type EvaluationMetric,
  type EvaluationSuiteV1,
  type RefinementPolicyV1,
  type RefinementRunAdapter,
  RefinementWorkflow,
  type RefinementArtifactRef,
} from './workflow.js'

const DOCUMENT: HarnessDocument = {
  schemaVersion: 'helix.harness/v1',
  control: { systemInstructionTemplate: 'baseline', taskNarrativeTemplate: 'fixture', protocolRules: ['record'], termination: { successSource: 'scenario-verifier', stopConditions: ['done'] } },
  catalogCards: [], compatibility: { codeProtocolPins: ['refinement-fixture/v1'] },
}

function pins(base: ReturnType<RefinementControlStore['publishBaseline']>, overlay?: ReturnType<RefinementControlStore['publishBaseline']>): HarnessPinsV1 {
  return {
    format: 'harness/v1', codeProtocolPin: 'refinement-fixture/v1', baselineRef: base,
    ...(overlay === undefined ? {} : { overlayRef: overlay }), harnessContentHash: 'f'.repeat(64),
    schemaVersion: 'helix.harness/v1', catalogCards: [], compatibilityDecision: { documentAcceptsCodeProtocolPin: true, catalogResolved: true },
  }
}

async function fixtureSmoke(rootDir: string): Promise<unknown> {
  const rcs = new RefinementControlStore({ rootDir })
  const expectedBaseline = {
    kind: 'baseline' as const, id: 'fixture-baseline', revision: 0,
    contentHash: baselineContentHash(DOCUMENT),
  }
  let baselineRef: HarnessStateRef = expectedBaseline
  try {
    rcs.read(expectedBaseline)
  } catch {
    baselineRef = rcs.publishBaseline(DOCUMENT, { id: 'fixture-baseline', revision: 0 })
  }
  const adapter: RefinementRunAdapter = {
    async generate() {
      return {
        generationRunRef: 'fixture-recorded-generation-run',
        payloadText: JSON.stringify({ schemaVersion: 'helix.harness-overlay/v1', baseBaselineRef: baselineRef, changes: { systemInstructionTemplate: 'improved fixture' } }),
        modelPins: { model: 'fixture-recorded-model' }, budget: { reserved: 64, charged: 8 },
      }
    },
    async evaluate(input): Promise<EvaluationMetric> {
      const candidate = input.arm === 'candidate'
      return {
        quality: candidate ? 0.9 : 0.7, cost: 10, latencyMs: 10, failed: false, replayPassed: true,
        sharedPins: { model: 'fixture-recorded-model', seed: String(input.case.seed) },
        harnessPins: pins(baselineRef, candidate ? input.overlayRef : undefined),
        runRef: `fixture-${input.arm}-${input.case.caseId}`,
      }
    },
  }
  const workflow = new RefinementWorkflow(rcs, adapter)
  const policy: RefinementPolicyV1 = {
    schemaVersion: 'helix.refinement-policy/v1', generation: { model: 'fixture-recorded-model', maxOutputTokens: 64 },
    gate: { minQualityDelta: 0.1, maxCostRatio: 1, maxLatencyRatio: 1, maxFailureRateDelta: 0 },
    authority: { manualApprovers: ['fixture-researcher'] },
  }
  const suite: EvaluationSuiteV1 = { schemaVersion: 'helix.refinement-suite/v1', cases: [{ caseId: 'fixture-holdout', inputRef: 'fixture-input', seed: 0, weight: 1 }] }
  const bundle: RefinementTrustBundleV1 = {
    schemaVersion: 'helix.refinement-trust-bundle/v1', generation: 'fixture-generation', audience: 'fixture-deployment', assertionKeys: [], autoGrantKeys: [],
    policyPublisherKeys: [{ issuer: 'fixture-hrca', keyId: 'fixture-key', secret: 'fixture-hrca-secret', notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }],
  }
  const policyRef = workflow.publishPolicy({ id: 'fixture-policy', policy, issuer: 'fixture-hrca', keyId: 'fixture-key', signature: signConfiguration(policy, 'fixture-hrca-secret'), bundle })
  const suiteRef = workflow.publishSuite({ id: 'fixture-suite', suite, issuer: 'fixture-hrca', keyId: 'fixture-key', signature: signConfiguration(suite, 'fixture-hrca-secret'), bundle })
  const proposal = await workflow.propose({ proposalId: 'fixture-proposal', sourceRunRefs: ['fixture-source-run'], baselineRef, policyRef })
  const generation = workflow.showGenerationJob(proposal.generationJobRef)
  if (generation.candidateRef === undefined) throw new Error('fixture generation did not admit a candidate')
  const report = await workflow.evaluate({ candidateRef: generation.candidateRef, policyRef, suiteRef })
  const requestRef = workflow.request(report)
  const promotion = workflow.manualPromote({ requestRef, subject: 'fixture-researcher', policyRef })
  return {
    proposal,
    generation,
    report: { reportRef: report.reportRef, verdict: report.verdict },
    requestRef,
    promotion,
  }
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function parseRef(value: string | undefined): RefinementArtifactRef {
  const match = value === undefined ? null : /^(.+):(.+)@(\d+)#([0-9a-f]{64})$/.exec(value)
  if (match === null) throw new Error('--ref requires kind:id@revision#64-lowercase-hex-hash')
  return { kind: match[1]!, id: match[2]!, revision: Number(match[3]), contentHash: match[4]! }
}

function parseHarnessRef(value: string | undefined): HarnessStateRef {
  const ref = parseRef(value)
  if (ref.kind !== 'baseline' && ref.kind !== 'overlay') {
    throw new Error('--baseline/--overlay requires kind baseline|overlay')
  }
  return { kind: ref.kind, id: ref.id, revision: ref.revision, contentHash: ref.contentHash }
}

async function loadCommandHost(modulePath: string): Promise<RefinementCommandHost> {
  const loaded = await import(pathToFileURL(path.resolve(modulePath)).href) as {
    createRefinementCommandHost?: () => RefinementCommandHost | Promise<RefinementCommandHost>
  }
  if (typeof loaded.createRefinementCommandHost !== 'function') {
    throw new Error('host module must export createRefinementCommandHost()')
  }
  return loaded.createRefinementCommandHost()
}

function readCommandInput(inputPath: string | undefined): RefinementCommand {
  if (inputPath === undefined || inputPath.length === 0) {
    throw new Error('--input requires a JSON command file')
  }
  try {
    return JSON.parse(fs.readFileSync(inputPath, 'utf8')) as RefinementCommand
  } catch (error) {
    throw new Error(`failed to read command input: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readOnlyWorkflow(rootDir: string): RefinementWorkflow {
  const unavailable: RefinementRunAdapter = {
    generate: async () => { throw new Error('show/explain must not execute a generation run') },
    evaluate: async () => { throw new Error('show/explain must not execute an evaluation run') },
  }
  return new RefinementWorkflow(new RefinementControlStore({ rootDir }), unavailable)
}

function requireArg(args: string[], name: string): string {
  const value = argument(args, name)
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
}

async function runHostCommand(args: string[], command: RefinementCommand): Promise<void> {
  const hostModule = requireArg(args, '--host-module')
  const result = await executeRefinementCommand(await loadCommandHost(hostModule), command)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

export async function runRefinementCli(argv: string[]): Promise<void> {
  // Support both `helix refine …` (bin) and direct `… refine …` invocation.
  const normalized = argv[0] === 'refine' ? argv.slice(1) : argv
  // Admin surface: helix refinement-admin publish-policy|publish-suite
  if (normalized[0] === 'refinement-admin' || argv[0] === 'refinement-admin') {
    const adminArgs = normalized[0] === 'refinement-admin' ? normalized.slice(1) : argv.slice(1)
    const [adminCommand, ...rest] = adminArgs
    if (adminCommand === 'publish-policy') {
      await runHostCommand(rest, {
        command: 'publish-policy',
        id: requireArg(rest, '--id'),
        policy: readJsonFile(requireArg(rest, '--policy')) as never,
        issuer: requireArg(rest, '--issuer'),
        keyId: requireArg(rest, '--key-id'),
        signature: requireArg(rest, '--signature'),
      })
      return
    }
    if (adminCommand === 'publish-suite') {
      await runHostCommand(rest, {
        command: 'publish-suite',
        id: requireArg(rest, '--id'),
        suite: readJsonFile(requireArg(rest, '--suite')) as never,
        issuer: requireArg(rest, '--issuer'),
        keyId: requireArg(rest, '--key-id'),
        signature: requireArg(rest, '--signature'),
      })
      return
    }
    throw new Error('usage: helix refinement-admin publish-policy|publish-suite --host-module <m> --id <id> --policy|--suite <file> --issuer --key-id --signature')
  }

  const [command, ...rest] = normalized
  const rootDir = argument(rest, '--root') ?? path.resolve('artifacts/refinement-fixture')
  if (command === 'command') {
    await runHostCommand(rest, readCommandInput(argument(rest, '--input')))
    return
  }
  if (command === 'propose') {
    await runHostCommand(rest, {
      command: 'propose',
      assertion: readJsonFile(requireArg(rest, '--assertion')) as never,
      proposal: {
        proposalId: requireArg(rest, '--proposal-id'),
        sourceRunRefs: requireArg(rest, '--source-runs').split(',').filter(Boolean),
        baselineRef: parseHarnessRef(requireArg(rest, '--baseline')),
        policyRef: parseRef(requireArg(rest, '--policy')),
      },
    })
    return
  }
  if (command === 'evaluate') {
    await runHostCommand(rest, {
      command: 'evaluate',
      assertion: readJsonFile(requireArg(rest, '--assertion')) as never,
      evaluation: {
        candidateRef: parseRef(requireArg(rest, '--candidate')),
        policyRef: parseRef(requireArg(rest, '--policy')),
        suiteRef: parseRef(requireArg(rest, '--suite')),
      },
    })
    return
  }
  if (command === 'request') {
    await runHostCommand(rest, {
      command: 'request',
      assertion: readJsonFile(requireArg(rest, '--assertion')) as never,
      report: readJsonFile(requireArg(rest, '--report')) as never,
    })
    return
  }
  if (command === 'promote' && rest.includes('--manual')) {
    await runHostCommand(rest, {
      command: 'promote-manual',
      assertion: readJsonFile(requireArg(rest, '--assertion')) as never,
      requestRef: parseRef(requireArg(rest, '--request')),
      policyRef: parseRef(requireArg(rest, '--policy')),
    })
    return
  }
  if (command === 'reject' && rest.includes('--manual')) {
    await runHostCommand(rest, {
      command: 'reject-manual',
      assertion: readJsonFile(requireArg(rest, '--assertion')) as never,
      requestRef: parseRef(requireArg(rest, '--request')),
      policyRef: parseRef(requireArg(rest, '--policy')),
    })
    return
  }
  if (command === 'promote' && rest.includes('--auto')) {
    await runHostCommand(rest, {
      command: 'promote-auto',
      requestRef: parseRef(requireArg(rest, '--request')),
      policyRef: parseRef(requireArg(rest, '--policy')),
      grant: readJsonFile(requireArg(rest, '--grant')) as never,
    })
    return
  }
  if (command === 'fixture-smoke') {
    process.stdout.write(`${JSON.stringify(await fixtureSmoke(rootDir))}\n`)
    return
  }
  if (command === 'show' && rest[0] === 'generation-job') {
    const hostModule = argument(rest, '--host-module')
    if (hostModule !== undefined) {
      await runHostCommand(rest, { command: 'show-generation-job', ref: parseRef(argument(rest, '--ref')) })
      return
    }
    process.stdout.write(`${JSON.stringify(readOnlyWorkflow(rootDir).showGenerationJob(parseRef(argument(rest, '--ref'))))}\n`)
    return
  }
  if (command === 'show' && rest[0] === 'evaluation-job') {
    const hostModule = argument(rest, '--host-module')
    if (hostModule !== undefined) {
      await runHostCommand(rest, { command: 'show-evaluation-job', ref: parseRef(argument(rest, '--ref')) })
      return
    }
    process.stdout.write(`${JSON.stringify(readOnlyWorkflow(rootDir).showEvaluationJob(parseRef(argument(rest, '--ref'))))}\n`)
    return
  }
  if (command === 'explain' && rest[0] === 'report') {
    const report = readOnlyWorkflow(rootDir).readReport(parseRef(argument(rest, '--ref')))
    process.stdout.write(`${JSON.stringify({ reportRef: report.reportRef, verdict: report.verdict, baseline: report.baseline, candidate: report.candidate })}\n`)
    return
  }
  throw new Error(
    'usage: helix refine propose|evaluate|request|promote --manual|--auto|reject --manual|show …|explain report|fixture-smoke|command --host-module <m> …; helix refinement-admin publish-policy|publish-suite …',
  )
}

const invoked = typeof process.argv[1] === 'string' && /(?:^|\/)refinement\/cli\.(?:ts|js)$/.test(process.argv[1])
if (invoked) {
  runRefinementCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
