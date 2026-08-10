# Helix project overview

Status: Factorio acceptance vertical delivered through Issues #1, #3, and #5
(RLM harness, milkie runtime control/finalization, and Kernel recursive model
calls). Initial delivery sequence item 1 is complete in the Factorio example;
general public runtime contracts and sequence items 2–5 remain future work.

Approved designs:
[Issue #1 L2](./design/1-rlm-factorio-harness.md) ·
[Issue #3 L2](./design/3-factorio-milkie-runtime-contracts.md) ·
[Issue #5 L2](./design/5-kernel-recursive-model-call.md).

## Purpose

Helix provides a Prime Agent-style, model-owned execution harness on top of
milkie while preserving milkie's event-sourced and deterministic engineering
properties.

The defining architectural choice is that IPython is not one tool among many.
It is the model-facing runtime. Tools, recursive model calls, context objects,
sub-agents, memory, and harness operations are imported as programmatic
modules inside the kernel.

## Responsibility split

The model owns semantic policy:

- what part of a result to inspect;
- how to split and aggregate context;
- when and how to call models or sub-agents;
- which intermediate values to retain;
- which observations should become session memory or harness candidates.

The runtime owns hard invariants:

- budgets and admission control;
- permissions and sandboxing;
- durable object storage;
- process isolation and crash recovery;
- event recording and deterministic replay;
- immutable base instructions and policy guardrails.

## Target layers

```text
Task / User
    |
Helix RLM harness <-> milkie IOPort <-> external Model Provider
    |
Sandboxed IPython Kernel
    |
Kernel bindings -> milkie adapters -> milkie substrate

milkie Trace / Outcome -> Helix continual harness
    -> Harness Delta -> Admission Gate
    -> session overlay | global candidate -> milkie Evolution
```

The RLM harness and continual harness are peers with different authority. The
RLM harness drives the current turn inside a milkie run. The continual harness
observes recorded evidence and proposes future state changes; it does not own
the model loop or publish global versions. Refiner model calls also pass through
the same IOPort.

The model is an external, replaceable dependency reached through milkie's
IOPort. A sub-agent recursively uses the same RLM session shape rather than a
separate sub-agent runtime. Prompt notes, agent specifications, skills, and
memory policy begin as typed harness-state entries, not independent services.
Each run pins its model, harness baseline and overlay, kernel protocol, and
binding versions; refinements become visible only at the next run boundary.

## Refinement model

Harness changes have two scopes:

1. Session-local refinement may take effect immediately as an overlay, but it
   cannot mutate the globally active harness.
2. Global evolution creates a versioned candidate. Replay validates faithful
   reconstruction; candidate quality requires a fork or fresh suite run against
   task outcomes and hard guardrails. The promotion gate is deterministic and
   does not call an LLM.

## Initial delivery sequence

1. ~~Object-addressed context plus a sandboxed IPython kernel with programmatic
   tools and recursive model calls.~~ **Done** in the Factorio example
   ([#1](https://github.com/xforce-io/helix/issues/1),
   [#3](https://github.com/xforce-io/helix/issues/3),
   [#5](https://github.com/xforce-io/helix/issues/5)).
2. Persistent sessions, asynchronous sub-agent handles, and mailboxes.
3. Versioned harness state and session-local overlays.
4. Trace-driven refiner producing structured harness candidates.
5. Fork or fresh-suite evaluation and deterministic promotion or rollback.
