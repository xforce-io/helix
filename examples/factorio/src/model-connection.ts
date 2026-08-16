import {
  assembleApiGateway,
  ConnectionConfigError,
  resolveAndParseConnection,
  type AdapterFamily,
  type ConnectionProjection,
  type IModelGateway,
} from 'milkie'

export type ConnectionPurpose = 'generate' | 'identify'

export type ConnectionConfig =
  | { env: Record<string, string | undefined> }
  | { fields: Record<string, string | undefined> }

export type ConnectModelResult = {
  projection: ConnectionProjection
  gateway?: IModelGateway
  /** Present only when generate assembled an api gateway; tests may assert family. */
  adapterFamily?: AdapterFamily
}

const HELIX_LLM_PREFIX = 'HELIX_LLM_'

/** Closed-set HELIX_LLM_* suffixes accepted by entry A. */
const HELIX_LLM_SUFFIXES = [
  'TRANSPORT',
  'PROTOCOL',
  'RUNTIME',
  'MODEL',
  'BASE_URL',
  'API_KEY',
  'PROVIDER',
] as const

/**
 * Filter operator env to the HELIX_LLM_* closed set only.
 * Never forward the whole process.env — legacy provider keys would trip milkie.
 */
export function filterHelixLlmEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const suffix of HELIX_LLM_SUFFIXES) {
    const key = `${HELIX_LLM_PREFIX}${suffix}`
    if (Object.prototype.hasOwnProperty.call(env, key)) out[key] = env[key]
  }
  return out
}

function isEnvConfig(
  config: ConnectionConfig,
): config is { env: Record<string, string | undefined> } {
  return Object.prototype.hasOwnProperty.call(config, 'env')
}

function isFieldsConfig(
  config: ConnectionConfig,
): config is { fields: Record<string, string | undefined> } {
  return Object.prototype.hasOwnProperty.call(config, 'fields')
}

/**
 * Factorio model connection facade.
 * Callers supply A (HELIX_LLM_* env snapshot) or B (canonical fields) and a purpose.
 * milkie parse/assemble stay inside this module.
 */
export function connectModel(input: {
  purpose: ConnectionPurpose
  config: ConnectionConfig
}): ConnectModelResult {
  const config = input.config
  const envEntry = isEnvConfig(config)
  const fieldsEntry = isFieldsConfig(config)
  if (envEntry === fieldsEntry) {
    throw new ConnectionConfigError('CONNECTION_CONFIG_CONFLICT', ['entry'])
  }

  const parsed = envEntry
    ? resolveAndParseConnection({
        contractVersion: 2,
        prefix: HELIX_LLM_PREFIX,
        env: filterHelixLlmEnv(config.env),
      })
    : resolveAndParseConnection({
        contractVersion: 2,
        fields: config.fields,
      })

  if (input.purpose === 'identify') {
    return { projection: parsed.projection }
  }

  // generate
  if (parsed.projection.transport === 'api') {
    const assembled = assembleApiGateway(parsed)
    return {
      projection: parsed.projection,
      gateway: assembled.gateway,
      adapterFamily: assembled.adapterFamily,
    }
  }

  // agent-cli: projection only; no HTTP gateway, no spawn
  return { projection: parsed.projection }
}

export { ConnectionConfigError }
export type { ConnectionProjection, IModelGateway, AdapterFamily }
