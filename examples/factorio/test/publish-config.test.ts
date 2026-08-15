import assert from 'node:assert/strict'
import test from 'node:test'
import { refinementAdminArgs } from '../publish-config.js'

test('publish config passes operator values as child-process arguments', () => {
  const policyFile = 'configs/$(unexpected-shell-expansion).json'
  const id = 'policy;not-a-command'
  const args = refinementAdminArgs({
    command: 'publish-policy',
    id,
    configurationFlag: '--policy',
    configurationFile: policyFile,
    issuer: 'issuer',
    keyId: 'key-id',
    signature: 'signature',
  })

  assert.equal(args[8], id)
  assert.equal(args[10], policyFile)
  assert.deepEqual(args.slice(0, 7), [
    '--import',
    'tsx',
    'src/refinement/cli.ts',
    'refinement-admin',
    'publish-policy',
    '--host-module',
    'examples/factorio/src/refinement-host.ts',
  ])
})
