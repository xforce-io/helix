/**
 * Formal refinement command dispatcher.
 *
 * Hosts inject RCS, trust bundle, and a milkie-recorded run adapter.
 * Side-effect commands claim the actor-assertion nonce in the same RCS
 * transaction as the immutable ACK (Proposal/GenerationJob or EvaluationJob).
 * Async generation/evaluation work runs only after that ACK is durable.
 */

import { createHash } from 'node:crypto'

import { RefinementControlStore } from './control-store.js'
import {
  verifyActorAssertion,
  type ActorAssertionV1,
  type RefinementTrustBundleV1,
} from './trust.js'
import {
  type AutoPromotionGrantV1,
  type EvaluationAck,
  type EvaluationReport,
  type ProposalAck,
  type RefinementArtifactRef,
  type RefinementRunAdapter,
  RefinementWorkflow,
} from './workflow.js'

export type RefinementCommand =
  | { command: 'propose'; assertion: ActorAssertionV1; proposal: Parameters<RefinementWorkflow['beginPropose']>[0] }
  | { command: 'evaluate'; assertion: ActorAssertionV1; evaluation: Parameters<RefinementWorkflow['beginEvaluate']>[0] }
  | { command: 'request'; assertion: ActorAssertionV1; report: EvaluationReport }
  | { command: 'promote-manual'; assertion: ActorAssertionV1; requestRef: RefinementArtifactRef; policyRef: RefinementArtifactRef }
  | { command: 'reject-manual'; assertion: ActorAssertionV1; requestRef: RefinementArtifactRef; policyRef: RefinementArtifactRef }
  | { command: 'promote-auto'; requestRef: RefinementArtifactRef; policyRef: RefinementArtifactRef; grant: AutoPromotionGrantV1 }
  | { command: 'show-generation-job'; ref: RefinementArtifactRef }
  | { command: 'show-evaluation-job'; ref: RefinementArtifactRef }
  | { command: 'explain-report'; ref: RefinementArtifactRef }
  | { command: 'publish-policy'; id: string; policy: Parameters<RefinementWorkflow['publishPolicy']>[0]['policy']; issuer: string; keyId: string; signature: string }
  | { command: 'publish-suite'; id: string; suite: Parameters<RefinementWorkflow['publishSuite']>[0]['suite']; issuer: string; keyId: string; signature: string }

export type RefinementCommandHost = {
  rcs: RefinementControlStore
  adapter: RefinementRunAdapter
  trustBundle: RefinementTrustBundleV1
  now?: () => Date
}

/** Per-RCS in-flight completion workers so concurrent show/retry share one run. */
const generationWorkers = new WeakMap<RefinementControlStore, Map<string, Promise<{ candidateRef: RefinementArtifactRef }>>>()
const evaluationWorkers = new WeakMap<RefinementControlStore, Map<string, Promise<EvaluationReport>>>()

export async function executeRefinementCommand(
  host: RefinementCommandHost,
  command: RefinementCommand,
): Promise<unknown> {
  const workflow = new RefinementWorkflow(
    host.rcs,
    host.adapter,
    host.now === undefined ? {} : { now: host.now },
  )
  switch (command.command) {
    case 'propose': {
      const ack = assertedSync(host, command.assertion, 'refine.propose', command.proposal, () =>
        workflow.beginPropose(command.proposal),
      )
      scheduleGeneration(host, workflow, ack.generationJobRef)
      return ack
    }
    case 'evaluate': {
      const ack = assertedSync(host, command.assertion, 'refine.evaluate', command.evaluation, () =>
        workflow.beginEvaluate(command.evaluation),
      )
      scheduleEvaluation(host, workflow, ack.evaluationJobRef)
      return ack
    }
    case 'request':
      return assertedSync(host, command.assertion, 'refine.request', command.report, () =>
        workflow.request(command.report),
      )
    case 'promote-manual':
      return assertedSync(host, command.assertion, 'refine.promote.manual', {
        requestRef: command.requestRef,
        policyRef: command.policyRef,
      }, assertion =>
        workflow.manualPromote({
          requestRef: command.requestRef,
          policyRef: command.policyRef,
          subject: assertion.subject,
        }),
      )
    case 'reject-manual':
      return assertedSync(host, command.assertion, 'refine.reject.manual', {
        requestRef: command.requestRef,
        policyRef: command.policyRef,
      }, assertion =>
        workflow.manualReject({
          requestRef: command.requestRef,
          policyRef: command.policyRef,
          subject: assertion.subject,
        }),
      )
    case 'promote-auto':
      return workflow.autoPromote({
        requestRef: command.requestRef,
        policyRef: command.policyRef,
        grant: command.grant,
        bundle: host.trustBundle,
      })
    case 'show-generation-job': {
      await ensureGeneration(host, workflow, command.ref)
      return workflow.showGenerationJob(command.ref)
    }
    case 'show-evaluation-job': {
      await ensureEvaluation(host, workflow, command.ref)
      return workflow.showEvaluationJob(command.ref)
    }
    case 'explain-report': {
      const report = workflow.readReport(command.ref)
      return {
        reportRef: report.reportRef,
        verdict: report.verdict,
        baseline: report.baseline,
        candidate: report.candidate,
      }
    }
    case 'publish-policy':
      return workflow.publishPolicy({
        id: command.id,
        policy: command.policy,
        issuer: command.issuer,
        keyId: command.keyId,
        signature: command.signature,
        bundle: host.trustBundle,
      })
    case 'publish-suite':
      return workflow.publishSuite({
        id: command.id,
        suite: command.suite,
        issuer: command.issuer,
        keyId: command.keyId,
        signature: command.signature,
        bundle: host.trustBundle,
      })
  }
}

/** Test helper: run propose and wait for generation completion. */
export async function proposeAndWait(
  host: RefinementCommandHost,
  command: Extract<RefinementCommand, { command: 'propose' }>,
): Promise<{ ack: ProposalAck; candidateRef: RefinementArtifactRef }> {
  const ack = (await executeRefinementCommand(host, command)) as ProposalAck
  const workflow = new RefinementWorkflow(host.rcs, host.adapter, host.now === undefined ? {} : { now: host.now })
  const completed = await ensureGeneration(host, workflow, ack.generationJobRef)
  return { ack, candidateRef: completed.candidateRef }
}

/** Test helper: run evaluate and wait for report. */
export async function evaluateAndWait(
  host: RefinementCommandHost,
  command: Extract<RefinementCommand, { command: 'evaluate' }>,
): Promise<{ ack: EvaluationAck; report: EvaluationReport }> {
  const ack = (await executeRefinementCommand(host, command)) as EvaluationAck
  const workflow = new RefinementWorkflow(host.rcs, host.adapter, host.now === undefined ? {} : { now: host.now })
  const report = await ensureEvaluation(host, workflow, ack.evaluationJobRef)
  return { ack, report }
}

function assertedSync<T>(
  host: RefinementCommandHost,
  assertion: ActorAssertionV1,
  operation: ActorAssertionV1['operation'],
  intent: unknown,
  execute: (assertion: Omit<ActorAssertionV1, 'signature'>) => T,
): T {
  const now = host.now?.()
  const verified = verifyActorAssertion({
    assertion,
    bundle: host.trustBundle,
    expectedOperation: operation,
    ...(now === undefined ? {} : { now }),
  })
  const fingerprint = createHash('sha256').update(JSON.stringify(intent)).digest('hex')
  // Receipt + ACK/state change share one RCS transaction (fail closed on conflict).
  return host.rcs.consumeAssertion({
    issuer: verified.issuer,
    keyId: verified.keyId,
    nonce: verified.nonce,
    fingerprint,
    expiresAt: verified.expiresAt,
    operation: () => execute(verified),
  })
}

function scheduleGeneration(
  host: RefinementCommandHost,
  workflow: RefinementWorkflow,
  jobRef: RefinementArtifactRef,
): void {
  void ensureGeneration(host, workflow, jobRef)
}

function scheduleEvaluation(
  host: RefinementCommandHost,
  workflow: RefinementWorkflow,
  jobRef: RefinementArtifactRef,
): void {
  void ensureEvaluation(host, workflow, jobRef)
}

function ensureGeneration(
  host: RefinementCommandHost,
  workflow: RefinementWorkflow,
  jobRef: RefinementArtifactRef,
): Promise<{ candidateRef: RefinementArtifactRef }> {
  const key = `${jobRef.kind}:${jobRef.id}@${jobRef.revision}#${jobRef.contentHash}`
  const map = generationWorkers.get(host.rcs) ?? new Map()
  generationWorkers.set(host.rcs, map)
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const started = workflow.completeGenerationJob(jobRef).finally(() => {
    map.delete(key)
  })
  map.set(key, started)
  return started
}

function ensureEvaluation(
  host: RefinementCommandHost,
  workflow: RefinementWorkflow,
  jobRef: RefinementArtifactRef,
): Promise<EvaluationReport> {
  const key = `${jobRef.kind}:${jobRef.id}@${jobRef.revision}#${jobRef.contentHash}`
  const map = evaluationWorkers.get(host.rcs) ?? new Map()
  evaluationWorkers.set(host.rcs, map)
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const started = workflow.completeEvaluationJob(jobRef).finally(() => {
    map.delete(key)
  })
  map.set(key, started)
  return started
}
