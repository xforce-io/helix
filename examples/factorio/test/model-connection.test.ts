import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ConnectionConfigError } from 'milkie'
import {
  connectModel,
  type ConnectionConfig,
} from '../src/model-connection.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const FACTORIO_ROOT = path.join(REPO_ROOT, 'examples/factorio')

const SENTINEL_KEY = 'sk-test'
const SENTINEL_BASE = 'https://example.invalid/v1'
const PROVIDER = 'acme-cloud'

function apiFields(protocol: 'anthropic-messages' | 'openai-chat-completions'): Record<string, string> {
  return {
    transport: 'api',
    protocol,
    model: `model-for-${protocol}`,
    apiKey: SENTINEL_KEY,
    baseUrl: SENTINEL_BASE,
    provider: PROVIDER,
  }
}

function apiEnv(protocol: 'anthropic-messages' | 'openai-chat-completions'): Record<string, string> {
  const fields = apiFields(protocol)
  return {
    HELIX_LLM_TRANSPORT: fields.transport,
    HELIX_LLM_PROTOCOL: fields.protocol,
    HELIX_LLM_MODEL: fields.model,
    HELIX_LLM_API_KEY: fields.apiKey,
    HELIX_LLM_BASE_URL: fields.baseUrl,
    HELIX_LLM_PROVIDER: fields.provider,
  }
}

function assertNoSentinels(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  assert.doesNotMatch(text, new RegExp(SENTINEL_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(text, /example\.invalid/)
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listFilesRecursive(full))
    else out.push(full)
  }
  return out
}

test('S1 generate api succeeds for both protocols with distinct adapter families', () => {
  const anthropic = connectModel({
    purpose: 'generate',
    config: { fields: apiFields('anthropic-messages') },
  })
  const openai = connectModel({
    purpose: 'generate',
    config: { fields: apiFields('openai-chat-completions') },
  })

  assert.ok(anthropic.gateway)
  assert.ok(openai.gateway)
  assert.equal(anthropic.adapterFamily, 'anthropic')
  assert.equal(openai.adapterFamily, 'openai-compatible')
  assert.notEqual(anthropic.adapterFamily, openai.adapterFamily)
  assert.equal(anthropic.projection.protocol, 'anthropic-messages')
  assert.equal(openai.projection.protocol, 'openai-chat-completions')
  assert.equal(anthropic.projection.provider, PROVIDER)
  assert.equal(openai.projection.provider, PROVIDER)
  assert.equal(anthropic.projection.contractVersion, 2)
  assert.equal(openai.projection.contractVersion, 2)
})

test('S1 same provider still switches adapterFamily when protocol changes', () => {
  const a = connectModel({
    purpose: 'generate',
    config: { fields: { ...apiFields('anthropic-messages'), provider: 'same-provider' } },
  })
  const b = connectModel({
    purpose: 'generate',
    config: { fields: { ...apiFields('openai-chat-completions'), provider: 'same-provider' } },
  })
  assert.equal(a.projection.provider, 'same-provider')
  assert.equal(b.projection.provider, 'same-provider')
  assert.equal(a.adapterFamily, 'anthropic')
  assert.equal(b.adapterFamily, 'openai-compatible')
})

test('S1 projection and errors never leak apiKey or full baseUrl sentinels', () => {
  const connected = connectModel({
    purpose: 'generate',
    config: { fields: apiFields('anthropic-messages') },
  })
  assert.equal(connected.projection.hasApiKey, true)
  assert.equal(connected.projection.hasBaseUrl, true)
  assertNoSentinels(connected.projection)
  assertNoSentinels(JSON.stringify(connected.projection))
  assertNoSentinels({
    projection: connected.projection,
    adapterFamily: connected.adapterFamily,
  })

  try {
    connectModel({
      purpose: 'generate',
      config: {
        fields: {
          transport: 'api',
          protocol: 'anthropic-messages',
          model: 'm',
          // missing apiKey
          baseUrl: SENTINEL_BASE,
        },
      },
    })
    assert.fail('expected missing apiKey to fail')
  } catch (error) {
    assert.ok(error instanceof ConnectionConfigError)
    assertNoSentinels(error)
    assertNoSentinels(error.message)
    assertNoSentinels(JSON.stringify(error))
  }
})

test('S2 only legacy ANTHROPIC_* fails before assemble', () => {
  assert.throws(
    () =>
      connectModel({
        purpose: 'generate',
        config: {
          env: {
            ANTHROPIC_API_KEY: SENTINEL_KEY,
            ANTHROPIC_MODEL: 'legacy-model',
            ANTHROPIC_BASE_URL: SENTINEL_BASE,
            ANTHROPIC_AUTH_TOKEN: 'legacy-token',
          },
        },
      }),
    (error: unknown) =>
      error instanceof ConnectionConfigError &&
      error.code === 'CONNECTION_CONFIG_MISSING_FIELD',
  )
})

test('S2 residual legacy env does not change canonical success', () => {
  const cleanEnv = apiEnv('anthropic-messages')
  const dirtyEnv = {
    ...cleanEnv,
    ANTHROPIC_API_KEY: 'legacy-should-be-ignored',
    ANTHROPIC_MODEL: 'legacy-model',
    ANTHROPIC_BASE_URL: 'https://legacy.invalid',
    ANTHROPIC_AUTH_TOKEN: 'legacy-token',
    UNRELATED: 'noise',
  }
  const clean = connectModel({ purpose: 'generate', config: { env: cleanEnv } })
  const dirty = connectModel({ purpose: 'generate', config: { env: dirtyEnv } })
  assert.deepEqual(clean.projection, dirty.projection)
  assert.equal(clean.adapterFamily, dirty.adapterFamily)
  assert.equal(clean.adapterFamily, 'anthropic')
})

test('S2 src and publish-config have no ANTHROPIC_ / AnthropicAdapter / createGateway assembly refs', () => {
  const roots = [
    path.join(FACTORIO_ROOT, 'src'),
    path.join(FACTORIO_ROOT, 'publish-config.ts'),
  ]
  const files: string[] = []
  for (const root of roots) {
    const st = statSync(root)
    if (st.isDirectory()) files.push(...listFilesRecursive(root))
    else files.push(root)
  }
  const banned = [
    /ANTHROPIC_/,
    /AnthropicAdapter/,
    /createGateway/,
    /legacyModelConfig/,
    /resolveAndParseConnection/,
    /assembleApiGateway/,
  ]
  // model-connection.ts is the only allowed milkie connection import site.
  const facade = path.join(FACTORIO_ROOT, 'src/model-connection.ts')
  for (const file of files) {
    if (file === facade) continue
    if (!/\.(ts|js|mjs|cjs)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const pattern of banned) {
      assert.equal(
        pattern.test(text),
        false,
        `${path.relative(REPO_ROOT, file)} must not match ${pattern}`,
      )
    }
  }
  const facadeText = readFileSync(facade, 'utf8')
  assert.match(facadeText, /resolveAndParseConnection/)
  assert.match(facadeText, /assembleApiGateway/)
  assert.doesNotMatch(facadeText, /ANTHROPIC_/)
  assert.doesNotMatch(facadeText, /legacyModelConfig/)
})

test('S3 generate agent-cli returns projection without gateway', () => {
  const connected = connectModel({
    purpose: 'generate',
    config: {
      fields: {
        transport: 'agent-cli',
        runtime: 'claude-code',
        model: 'cli-model',
      },
    },
  })
  assert.equal(connected.gateway, undefined)
  assert.equal(connected.adapterFamily, undefined)
  assert.equal(connected.projection.transport, 'agent-cli')
  assert.equal(connected.projection.runtime, 'claude-code')
  assert.equal(connected.projection.model, 'cli-model')
  assert.equal(connected.projection.contractVersion, 2)
})

test('S3 cross-field mixes are rejected without gateway', () => {
  assert.throws(
    () =>
      connectModel({
        purpose: 'generate',
        config: {
          fields: {
            transport: 'agent-cli',
            runtime: 'codex',
            protocol: 'anthropic-messages',
          },
        },
      }),
    (error: unknown) =>
      error instanceof ConnectionConfigError &&
      error.code === 'CONNECTION_CONFIG_CONFLICT' &&
      error.fields.includes('protocol'),
  )

  assert.throws(
    () =>
      connectModel({
        purpose: 'generate',
        config: {
          fields: {
            transport: 'agent-cli',
            runtime: 'codex',
            apiKey: SENTINEL_KEY,
          },
        },
      }),
    ConnectionConfigError,
  )

  assert.throws(
    () =>
      connectModel({
        purpose: 'generate',
        config: {
          fields: {
            transport: 'api',
            protocol: 'anthropic-messages',
            model: 'm',
            apiKey: SENTINEL_KEY,
            runtime: 'claude-code',
          },
        },
      }),
    (error: unknown) =>
      error instanceof ConnectionConfigError &&
      error.code === 'CONNECTION_CONFIG_CONFLICT' &&
      error.fields.includes('runtime'),
  )
})

test('Integration A and B agree on projection for the same canonical fields', () => {
  const fields = apiFields('openai-chat-completions')
  const fromFields = connectModel({ purpose: 'identify', config: { fields } })
  const fromEnv = connectModel({
    purpose: 'identify',
    config: {
      env: {
        ...apiEnv('openai-chat-completions'),
        NOISE_KEY: 'ignored',
        ANTHROPIC_API_KEY: 'ignored-legacy',
      },
    },
  })
  assert.deepEqual(fromFields.projection, fromEnv.projection)
  assert.equal(fromFields.gateway, undefined)
  assert.equal(fromEnv.gateway, undefined)
})

test('Integration entry XOR rejects A+B and neither', () => {
  function hasEntryField(error: unknown): boolean {
    if (!(error instanceof ConnectionConfigError)) return false
    return error.fields.includes('entry')
  }

  assert.throws(
    () =>
      connectModel({
        purpose: 'generate',
        // Intentionally invalid dual entry for XOR coverage.
        config: {
          env: apiEnv('anthropic-messages'),
          fields: apiFields('anthropic-messages'),
        } as ConnectionConfig,
      }),
    hasEntryField,
  )

  assert.throws(
    () =>
      connectModel({
        purpose: 'identify',
        config: {} as ConnectionConfig,
      }),
    hasEntryField,
  )
})

test('Integration identify returns model projection without gateway', () => {
  const connected = connectModel({
    purpose: 'identify',
    config: { fields: apiFields('anthropic-messages') },
  })
  assert.equal(connected.projection.model, 'model-for-anthropic-messages')
  assert.equal(connected.gateway, undefined)
  assert.equal(connected.adapterFamily, undefined)
  assert.equal(connected.projection.contractVersion, 2)
})

test('Unit contractVersion is fixed at 2 on success', () => {
  const connected = connectModel({
    purpose: 'identify',
    config: { fields: apiFields('anthropic-messages') },
  })
  assert.equal(connected.projection.contractVersion, 2)
})
