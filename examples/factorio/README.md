# Factorio live example

This example targets the real Factorio Learning Environment task
`iron_ore_throughput` (FLE 0.4.3: 60 游戏秒内自动生产 16 个铁矿石)。It never treats a fake adapter as live
evidence.

## Prerequisites

- Docker with Compose;
- `uv`;
- enough resources to run one `factoriotools/factorio:2.0.73` container.

FLE uses a headless Factorio server; the graphical Factorio client is not
required for this text-only example.

## Run the real-game gates

Start one FLE instance:

```bash
npm run factorio:cluster:start
```

Layer 0 adapter smoke uses a fixed mining program:

```bash
npm run verify:factorio:live-smoke
```

Evidence is written to `artifacts/factorio/live-smoke.json`. A pass requires a
real FLE adapter, an advancing game tick, at least two burner mining drills,
no action error, the 10,000-character/120-second limits, and
`task_verification.success=true`.

Stop the cluster when finished:

```bash
npm run factorio:cluster:stop
```

The cluster wrapper uses a Helix-labelled container and works around two FLE
0.4.3 packaging incompatibilities found by this smoke test: its unbounded
`a2a-sdk` dependency and its Apple Silicon compose launch. `stop` refuses to
remove a container unless that Helix label is present.

This smoke gate proves only that Helix can reach and change a real video-game
environment. It does not satisfy Issue #1; the Agent gate additionally
requires model-generated cells, milkie Trace/Outcome, and a zero-live-effect
Replay.

For the Agent gate, configure an Anthropic-compatible model endpoint without
placing credentials in repository files:

```bash
export ANTHROPIC_AUTH_TOKEN='<token>'
export ANTHROPIC_BASE_URL='<endpoint>'
export ANTHROPIC_MODEL='<model-ref>'
npm run verify:factorio:live
```

The harness contains no gold/fixed action. The model must generate the reset
cell and every later `factorio.step` program, then react to bounded real FLE
feedback until the environment verifier succeeds. The command prints a
`runId` and writes canonical live evidence under
`artifacts/factorio/runs/<runId>/live.json`.

Live preflight verifies the exact Helix-labelled container, pinned Factorio
image, FLE package version, task digest, and RCON reachability before the first
model request. The v2 local capability profile enforces a 120-second FLE wall
timeout, Kernel CPU/RSS budgets, an 8 KiB preview ceiling, and terminal
handling for uncertain actions; it is not a production multi-tenant OS sandbox.

Replay that exact run:

```bash
npm run verify:factorio:replay -- --run <runId>
```

Replay uses milkie's recorded model/tool I/O, refuses live fallback, never
starts the Kernel or Bridge, verifies every object ref and projection digest,
and writes `artifacts/factorio/runs/<runId>/replay.json`. Only a passing Live
and Replay for the same `runId` satisfy Issue #1 S1.

`npm test` covers dynamic-builtins/IPython escapes, action allowlisting,
bounded projection and output, retry capability retention, wall/RSS limits,
uncertain termination, command idempotency, stale revisions, preflight pins,
Trace-before-Outcome ordering, and State Ref continuity without requiring
Factorio.
