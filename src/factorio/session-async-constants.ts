/**
 * Issue #7 — versioned acceptance constants (L2 §8.6).
 * Tests and Host must import these; no magic numbers in tests.
 */

export const KERNEL_PROTOCOL = '2' as const

export const MAX_MSG_BYTES = 16_384
export const MAILBOX_DEPTH = 32
export const MAX_IN_FLIGHT_MSGS = 64
export const MAX_HANDLES = 4
export const MAX_HANDLES_PER_SESSION = 16
export const MAX_PAYLOAD_PREVIEW_BYTES = 512
export const MAILBOX_MSG_TTL_MS = 3_600_000
export const WAIT_MAX_TIMEOUT_MS = 120_000
export const POLL_MIN_INTERVAL_MS = 20
export const MAX_SPAWN_INSTRUCTIONS_BYTES = 8_000
export const MAX_SPAWN_INPUT_BYTES = 8_000
export const MAX_SPAWN_PROMPT_TOKENS = 4_096
export const MAX_SPAWN_COMPLETION_TOKENS = 2_048
export const MIN_SPAWN_RESERVE_TOKENS = 16
export const CHILD_REPLAY_SAFETY_WALL_MS = 300_000
export const MAX_CHECKPOINT_NOTE_BYTES = 256
export const MAX_SESSION_LABEL_BYTES = 128

export const PROMPT_TOKEN_ESTIMATE_DIVISOR = 4
export const PROMPT_FRAMING_BYTES = 64
export const MAX_CANONICAL_JSON_DEPTH = 8
export const MAX_CANONICAL_JSON_NODES = 1_024

export const SESSION_PROJECTION_SCHEMA = 'helix.session-projection/v1' as const
export const SESSION_DOMAIN_EVENT_SCHEMA = 'helix.session-domain-event/v1' as const
export const CONTEXT_ENVELOPE_SCHEMA = 'helix.context/v4' as const
export const CELL_EXECUTION_SCHEMA = 'helix.cell-execution/v3' as const
export const LIVE_EVIDENCE_SCHEMA = 'helix.factorio.live/v4' as const
export const REPLAY_EVIDENCE_SCHEMA = 'helix.factorio.replay/v4' as const

export const HARNESS_V5 = 'factorio-rlm/v5' as const
export const HARNESS_V4 = 'factorio-rlm/v4' as const
export const BINDING_SET_V4 = 'factorio/v4' as const
export const BINDING_SET_V3 = 'factorio/v3' as const
export const SESSION_ASYNC_VERSION = '1' as const

export const SESSION_CONTROL_MAILBOX_ID = 'session.control' as const

export const MODEL_EFFECT_METHODS = [
  'factorio.reset',
  'factorio.step',
  'models.call',
  'session.create',
  'session.resume',
  'session.checkpoint',
  'session.lookup',
  'agents.spawn',
  'agents.wait',
  'agents.poll',
  'mailbox.send',
  'mailbox.receive',
  'mailbox.peek',
] as const

export type ModelEffectMethod = (typeof MODEL_EFFECT_METHODS)[number]

export const WRITE_PATH_METHODS = new Set<string>([
  'factorio.reset',
  'factorio.step',
  'models.call',
  'session.create',
  'session.resume',
  'session.checkpoint',
  'agents.spawn',
  'agents.wait',
  'mailbox.send',
  'mailbox.receive',
])

export const READ_PATH_METHODS = new Set<string>([
  'session.lookup',
  'agents.poll',
  'mailbox.peek',
])
