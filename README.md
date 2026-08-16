# Helix

**Model-owned runtime, verifiable evolution.**

Helix is an RLM agent runtime and self-evolving harness built on
[milkie](https://github.com/xforce-io/milkie).

Its central idea is control inversion: the model receives a persistent
IPython runtime and programmatic access to context, tools, models, sub-agents,
memory, and harness state. The model decides how to inspect results, decompose
work, retain information, delegate tasks, and aggregate outputs. The runtime
keeps authority over budgets, permissions, isolation, persistence, tracing,
and recovery.

## Project boundary

Helix owns:

- persistent IPython/RLM execution;
- model-facing references and read policy for object-addressed context;
- programmatic model and tool calls;
- persistent asynchronous sub-agents and messaging;
- versioned prompt, agent, skill, and memory-policy state;
- session-local refinement and global harness candidates;
- autonomous goal and heartbeat policy.

milkie remains the shared deterministic substrate for:

- run lifecycle and checkpoints;
- non-deterministic I/O and model-provider boundaries;
- append-only Agent Trace;
- durable object facts and hard budget enforcement;
- replay, lineage, and task outcomes;
- fork/diff evaluation and deterministic evolution gates.

The model is an external, replaceable dependency reached through milkie's
IOPort. Helix does not train or modify foundation-model weights at runtime.

## Status

The first end-to-end vertical is implemented: an external model owns a
persistent IPython feedback loop, solves the real FLE
`iron_ore_throughput` task through model-authored cells, records all model and
cell I/O plus an immutable, evidence-bound task finalization through milkie,
and replays the same run with
zero live model, Kernel, Bridge, or Factorio effects.

This remains an example-level contract rather than a general public runtime
API. milkie is pinned to immutable commit
`d74128cf3ac976ebd68eb1b87f340574811c6366`; `postinstall` builds that source
dependency because the GitHub source archive does not contain generated
`dist` files.

The first real-environment gate lives in
[`examples/factorio`](./examples/factorio/README.md). It pins FLE 0.4.3 and
requires a real headless Factorio verifier; it does not count a fake adapter as
game evidence.

See the [project overview](./docs/overview.md) and
[Issue #1](https://github.com/xforce-io/helix/issues/1) for the initial
architecture. The approved L1 is expanded by the
[implemented Factorio L2 design](./docs/design/1-rlm-factorio-harness.md).
The v3 runtime/finalization contract is specified by
[Issue #3](https://github.com/xforce-io/helix/issues/3) and its
[L2 design](./docs/design/3-factorio-milkie-runtime-contracts.md). The controlled
cross-run refinement workflow is specified by
[Issue #13](https://github.com/xforce-io/helix/issues/13); its fixture smoke and
runtime boundaries are documented in [docs/refinement.md](./docs/refinement.md).

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test          # runs check + unit tests
npm run build
```

### System end-to-end test

The system e2e (`test/e2e/system.e2e.test.ts`) verifies the complete Helix core
loop in a **deterministic, credential-free** manner:

1. **Catalog**: loads production cards via `listProductionCards` /
   `resolveCapabilitySet` / `resolveCardRefs`; unknown/missing versions
   fail-closed.
2. **Harness**: `selectValidateResolveFreeze` with a fixture scenario adapter
   (no live LLM, no Docker, no Factorio cluster).
3. **Replay**: `replayFromRecordedPins` produces stable `harnessContentHash`.
4. **Refinement**: propose → two-arm evaluate → request → manual promote.
5. **Authority**: model/skill subjects cannot promote (0 promotions).
6. **Evolution**: unpromoted overlay fails on `external` route; promoted overlay
   succeeds on next-run selection; old replay hash unchanged after promotion.

The fixture E2E is deliberately excluded from `npm test`: E2E scope can grow
to include external environments and real-model cost. Run it explicitly:

```bash
npm run test:e2e:fixture
# `npm run test:e2e` remains a compatibility alias.
```

A future live-LLM suite will be a separate manual or scheduled CI job; it will
never be part of default `npm test`.

### Factorio example

The real Factorio gate additionally requires Docker, `uv`, a configured
model connection (`HELIX_LLM_TRANSPORT`, `HELIX_LLM_PROTOCOL`, `HELIX_LLM_MODEL`,
`HELIX_LLM_API_KEY`, optional `HELIX_LLM_BASE_URL` / `HELIX_LLM_PROVIDER`), and the commands documented in
[`examples/factorio`](./examples/factorio/README.md).
