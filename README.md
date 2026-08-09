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
[L2 design](./docs/design/3-factorio-milkie-runtime-contracts.md).

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test
npm run build
```

The real Factorio gate additionally requires Docker, `uv`, a configured
Anthropic-compatible endpoint (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_MODEL`), and the commands documented in
[`examples/factorio`](./examples/factorio/README.md).
