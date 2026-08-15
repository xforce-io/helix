#!/usr/bin/env tsx
/**
 * Factorio operator path: publish live policy/suite to artifacts/factorio/harness-state
 * and mint human assertions (Issue #22 P3).
 *
 * Usage:
 *   tsx examples/factorio/publish-config.ts --policy policy.json
 *   tsx examples/factorio/publish-config.ts --suite suite.json
 *
 * Requires ANTHROPIC_MODEL environment variable for policy generation.model validation.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { signConfiguration } from '../../src/refinement/trust.js'
import type { RefinementPolicyV1, EvaluationSuiteV1 } from '../../src/refinement/workflow.js'
import { FACTORIO_REFINEMENT_FIXTURE, HARNESS_STATE_ROOT } from './src/cli-common.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function requireArg(name: string): string {
  const value = argument(name)
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function readJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch (error) {
    throw new Error(`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validatePolicy(policy: RefinementPolicyV1, expectedModel: string): void {
  if (policy.schemaVersion !== 'helix.refinement-policy/v1') {
    throw new Error('policy must have schemaVersion: helix.refinement-policy/v1')
  }
  if (policy.generation.model !== expectedModel) {
    throw new Error(
      `policy generation.model must equal ANTHROPIC_MODEL (${expectedModel}), got ${policy.generation.model}`
    )
  }
  if (!Number.isSafeInteger(policy.generation.maxOutputTokens) || policy.generation.maxOutputTokens <= 0) {
    throw new Error('policy generation.maxOutputTokens must be positive integer')
  }
  if (policy.extractorDigest.length !== 64) {
    throw new Error('policy extractorDigest must be 64-character hex hash')
  }
  if (!Array.isArray(policy.authority.manualApprovers) || policy.authority.manualApprovers.length === 0) {
    throw new Error('policy authority.manualApprovers must be non-empty array')
  }
}

function validateSuite(suite: EvaluationSuiteV1): void {
  if (suite.schemaVersion !== 'helix.refinement-suite/v1') {
    throw new Error('suite must have schemaVersion: helix.refinement-suite/v1')
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error('suite.cases must be non-empty array')
  }
  for (const c of suite.cases) {
    if (!c.caseId || !c.inputRef) {
      throw new Error('each suite case requires caseId and inputRef')
    }
    if (!Number.isSafeInteger(c.seed) || c.seed < 0) {
      throw new Error('each suite case seed must be non-negative integer')
    }
    if (!Number.isFinite(c.weight) || c.weight <= 0) {
      throw new Error('each suite case weight must be positive number')
    }
  }
}

async function main(): Promise<void> {
  const policyFile = argument('--policy')
  const suiteFile = argument('--suite')
  const id = argument('--id')

  if (!policyFile && !suiteFile) {
    console.error('Usage: tsx publish-config.ts --policy <file> | --suite <file> [--id <id>]')
    console.error('Publishes signed policy or suite to artifacts/factorio/harness-state')
    console.error('Requires ANTHROPIC_MODEL environment variable')
    process.exitCode = 1
    return
  }

  const model = process.env['ANTHROPIC_MODEL']
  if (!model || model.length === 0) {
    throw new Error('ANTHROPIC_MODEL environment variable is required')
  }

  // Use fixture keys for this example (production would use real HRCA)
  const issuer = FACTORIO_REFINEMENT_FIXTURE.publisherIssuer
  const keyId = FACTORIO_REFINEMENT_FIXTURE.publisherKeyId
  const secret = FACTORIO_REFINEMENT_FIXTURE.publisherSecret

  if (policyFile) {
    const policy = readJsonFile<RefinementPolicyV1>(policyFile)
    validatePolicy(policy, model)

    const policyId = id ?? `factorio-policy-${Date.now()}`
    const signature = signConfiguration(policy, secret)

    console.log(`Publishing policy ${policyId}...`)
    console.log(`  generation.model: ${policy.generation.model}`)
    console.log(`  extractorDigest: ${policy.extractorDigest}`)

    const result = execSync(
      `node --import tsx src/refinement/cli.ts refinement-admin publish-policy ` +
      `--host-module examples/factorio/src/refinement-host.ts ` +
      `--id ${JSON.stringify(policyId)} ` +
      `--policy ${JSON.stringify(policyFile)} ` +
      `--issuer ${JSON.stringify(issuer)} ` +
      `--key-id ${JSON.stringify(keyId)} ` +
      `--signature ${JSON.stringify(signature)}`,
      { encoding: 'utf8', cwd: path.resolve(__dirname, '../..') }
    )

    const published = JSON.parse(result)
    console.log(`✓ Published policy: ${JSON.stringify(published)}`)
    console.log(`✓ Stored in: ${HARNESS_STATE_ROOT}/refinement-control.json`)
  }

  if (suiteFile) {
    const suite = readJsonFile<EvaluationSuiteV1>(suiteFile)
    validateSuite(suite)

    const suiteId = id ?? `factorio-suite-${Date.now()}`
    const signature = signConfiguration(suite, secret)

    console.log(`Publishing suite ${suiteId}...`)
    console.log(`  cases: ${suite.cases.length}`)

    const result = execSync(
      `node --import tsx src/refinement/cli.ts refinement-admin publish-suite ` +
      `--host-module examples/factorio/src/refinement-host.ts ` +
      `--id ${JSON.stringify(suiteId)} ` +
      `--suite ${JSON.stringify(suiteFile)} ` +
      `--issuer ${JSON.stringify(issuer)} ` +
      `--key-id ${JSON.stringify(keyId)} ` +
      `--signature ${JSON.stringify(signature)}`,
      { encoding: 'utf8', cwd: path.resolve(__dirname, '../..') }
    )

    const published = JSON.parse(result)
    console.log(`✓ Published suite: ${JSON.stringify(published)}`)
    console.log(`✓ Stored in: ${HARNESS_STATE_ROOT}/refinement-control.json`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
