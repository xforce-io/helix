import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

test('S4 CLI fixture smoke completes propose → evaluate → request → manual promotion', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helix-refine-cli-'))
  try {
    const result = spawnSync('npx', ['tsx', 'src/refinement/cli.ts', 'refine', 'fixture-smoke', '--root', root], {
      cwd: repoRoot, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout) as {
      proposal: { proposalRef: unknown; generationJobRef: { kind: string; id: string; revision: number; contentHash: string } }
      generation: { candidateRef?: unknown }
      report: { verdict: string; reportRef: { kind: string; id: string; revision: number; contentHash: string } }
      promotion: { overlayRef: { kind: string } }
    }
    assert.equal(output.report.verdict, 'passed')
    assert.equal(output.promotion.overlayRef.kind, 'overlay')
    assert.ok(output.generation.candidateRef)
    assert.equal('candidateRef' in output.proposal, false)
    const retry = spawnSync('npx', ['tsx', 'src/refinement/cli.ts', 'refine', 'fixture-smoke', '--root', root], {
      cwd: repoRoot, encoding: 'utf8',
    })
    assert.equal(retry.status, 0, retry.stderr)
    const generationRef = output.proposal.generationJobRef
    const ref = `${generationRef.kind}:${generationRef.id}@${generationRef.revision}#${generationRef.contentHash}`
    const show = spawnSync('npx', ['tsx', 'src/refinement/cli.ts', 'refine', 'show', 'generation-job', '--ref', ref, '--root', root], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(show.status, 0, show.stderr)
    assert.ok(JSON.parse(show.stdout).candidateRef)
    const reportRef = output.report.reportRef
    const report = `${reportRef.kind}:${reportRef.id}@${reportRef.revision}#${reportRef.contentHash}`
    const explain = spawnSync('npx', ['tsx', 'src/refinement/cli.ts', 'refine', 'explain', 'report', '--ref', report, '--root', root], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(explain.status, 0, explain.stderr)
    assert.equal(JSON.parse(explain.stdout).verdict, 'passed')
    const forbidden = spawnSync('npx', ['tsx', 'src/refinement/cli.ts', 'refine', 'promote', '--root', root], { cwd: repoRoot, encoding: 'utf8' })
    assert.notEqual(forbidden.status, 0)
    assert.match(forbidden.stderr, /usage/)
    const commandInput = path.join(root, 'bad-command.json')
    writeFileSync(commandInput, JSON.stringify({ command: 'propose' }))
    const command = spawnSync('npx', ['tsx', 'src/refinement/cli.ts', 'refine', 'command', '--host-module', 'test/refinement/command-host.ts', '--input', commandInput], { cwd: repoRoot, encoding: 'utf8' })
    assert.notEqual(command.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
