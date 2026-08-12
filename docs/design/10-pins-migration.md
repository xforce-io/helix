# Issue #10 — pins migration note

> **Revises approved L2** `docs/design/10-versioned-harness-state.md` clauses
> **§3.1 item 3**, **§10.1**, **§11.2** (and the matching S2 read-back language):
> the frozen harness content identity lives on **`RunPins.harnessState`**
> (`HarnessPinsV1`). Historical field **`RunPins.harness`** remains the
> code/protocol compatibility pin only. Where older L2 prose said
> “`RunPins.harness` 写入 HarnessPinsV1”, read **`RunPins.harnessState`**.

## Code/protocol pin vs harness state

| Field | Meaning |
|---|---|
| `RunPins.harness` (`factorio-rlm/v4` \| `factorio-rlm/v5`) | **Code/protocol compatibility pin** only. Selects runner/binding issuance. |
| `RunPins.harnessState` (`HarnessPinsV1`) | **Harness content identity**: baseline/overlay refs, `harnessContentHash`, schema, catalog refs, compatibility decision. |

These are not interchangeable. A new-format run must have an explicit Store baseline ref; the bare `factorio-rlm/v4|v5` string cannot act as a state selection.

## New-format path

1. Host publishes immutable baselines/overlays into `HarnessStateStore` (**live / migration bootstrap only**).
2. Host forms frozen `availableCatalogRefs` (before select).
3. Host runs `select → validate → resolve → freeze` with an **explicit**
   `{baselineRef, overlayRef?}` — no internal default baseline, no source prompt.
4. Host renders the complete control plane via `renderControlPlane` and injects it
   into `runHarness` as `controlPlaneText` (ModelRequest.system).
5. `RunPins.harnessState`, Context `runtime.harness`, and evidence `harness` all
   record the same `HarnessPinsV1` slice (`selectionSource: 'recorded'` on evidence).
   `runHarness` fail-closes if `frozenHarness` and `pins.harnessState` disagree on
   any pin field before the first model request.
6. Replay opens durable Store/Registry in **hydrate-only** mode
   (`openFactorioReplayHost`) and rebuilds only from recorded refs/hash via
   `replayFromRecordedPins` / `reconstructFactorioReplayHarness` — no registry for
   new-format, no `latest`, no source-prompt fallback, no current-pin-factory
   digest substitution, and **no publish/compare of current source default or
   legacy fixture documents**.

Default Factorio P1 live assembly passes Store baseline `factorio.default-p1@1`
explicitly through `assembleFactorioRun({ baselineRef: bundle.defaultBaselineRef })`
after `createFactorioHostBundle` (live bootstrap).

## Legacy path

Historical artifacts that only stored `factorio-rlm/v4` or `factorio-rlm/v5` resolve through the global append-only `LegacySelectionRegistry`:

| pin | legacy baseline id |
|---|---|
| `factorio-rlm/v4` | `factorio.legacy-v4` |
| `factorio-rlm/v5` | `factorio.legacy-v5` |

Evidence marks `selectionSource: 'legacy-registry'` and records `registryIdentity`. Manifests are provenance views only — never selection authority. Missing entry / missing baseline / hash or schema mismatch → `HARNESS_LEGACY_SELECTION_UNAVAILABLE`. Re-pointing a registered pin → `HARNESS_NONDETERMINISTIC_SELECTION`.

Legacy replay hydrates the already-persisted registry; it must not rebuild
legacy mappings from current source default payloads.

## Factorio role

Factorio remains a scenario adapter E2E consumer (`ExampleScenarioAdapter` + Host composition in `src/factorio/harness-host.ts`). It does not own Document schema, Store, selection, identity, or replay rules. Generic core under `src/harness/` has no Factorio/FLE imports.

### Live bootstrap vs replay open

| Entry | Purpose |
|---|---|
| `createFactorioHostBundle` | Live / first migration: may publish default P1 + legacy baselines when absent and register legacy pins. |
| `openFactorioReplayHost` | Replay only: hydrate durable Store + registry; never publish or re-register from source. |
