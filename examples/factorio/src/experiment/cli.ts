#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExperimentEvidenceIndex, writeExperimentAnalysis } from './evidence.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

export async function analyzeExperimentCli(): Promise<void> {
  const indexPath = argument('--index')
  if (indexPath === undefined) throw new Error('usage: factorio:experiment -- analyze --index <experiment-index.json>')
  if (process.argv[2] !== 'analyze') throw new Error('only the analyze subcommand is supported')
  const index = parseExperimentEvidenceIndex(await fs.readFile(path.resolve(indexPath), 'utf8'))
  const result = await writeExperimentAnalysis({ index })
  console.log(JSON.stringify({
    experimentId: result.artifact.experimentId,
    analysisPath: result.path,
    verdict: result.artifact.analysis.verdict,
    successRateDelta: result.artifact.analysis.successRateDelta,
    confidenceInterval: result.artifact.analysis.confidenceInterval,
    mcnemarPValue: result.artifact.analysis.mcnemarPValue,
    failures: result.artifact.analysis.failures,
  }, null, 2))
  process.exitCode = result.artifact.analysis.verdict === 'passed' ? 0 : 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  analyzeExperimentCli().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 2
  })
}
