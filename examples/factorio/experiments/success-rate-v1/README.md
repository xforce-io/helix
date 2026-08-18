# Factorio self-evolution success-rate experiment

This directory is the immutable-input template for Issues #29 and #39.  It does
not contain credentials or private holdout content.  The official suite is
exactly 160 paired cases: ten certified FLE 0.4.3 task profiles, four
configured FLE slots, and four independent model repetitions per profile/slot.
`seed` is only an alias of the pre-provisioned FLE `slot` (0–3).  It is never
an arbitrary FLE `run_idx`.

The ten certified `inputRef` values and frozen categories are defined in
`docs/design/39-official-success-rate-matrix.md`.  Candidate generation must
reference a published Factorio freeze (`experiment-freeze.json`) whose
`suiteDigest` / `policyDigest` pin the signed RCS objects.

1. Start four matching FLE containers: `npm run factorio:cluster:start -- --count 4`.
2. Set a fresh `HELIX_FACTORIO_HARNESS_STATE_ROOT` whose real path does not
   equal or overlap `artifacts/factorio/harness-state`.
3. Publish a signed policy and the 160-case official suite through the existing
   refinement control plane.  Then write the matching freeze into that isolated
   root.  Do not generate a candidate before the freeze exists.
4. Run a declared dry-run subset first (at least one pair per key category and
   every slot at least once).  Keep every live and replay evidence file, then
   build `index.json` with absolute paths, pair identity fields, and the freeze
   `freezeId` / `contentDigest`.
5. Analyze it: `npm run factorio:experiment -- analyze --index <index.json>`.
   A subset index is smoke: `verdict` is `indeterminate` and includes
   `NOT_OFFICIAL_MATRIX`.  Only a complete 160-pair index that equals the freeze
   matrix is an official promotion input.  A non-zero exit is expected unless
   every quality, replay, statistic, category, cost, and latency gate passes.
6. Only after a `passed` official `analysis.json` binds the exact candidate and
   overlay may a human make the separate existing RCS manual-promotion decision.

`index.json` uses this closed shape (all paths are existing immutable
evidence, never summaries invented by the operator):

```json
{
  "schemaVersion": "helix.factorio.experiment-index/v1",
  "experimentId": "success-rate-v1",
  "freezeId": "success-rate-v1",
  "contentDigest": "sha256:...",
  "reportRef": "evaluation-report:...",
  "candidateRef": "candidate:...",
  "overlayRef": "overlay:...",
  "pairs": [{
    "caseId": "iron-plate-slot-0-rep-0",
    "inputRef": "factorio.throughput/iron-plate/v1",
    "taskId": "iron_plate_throughput",
    "taskDigest": "sha256:0e111447aae5e5d6ba9430a0219b70f632ac4f99b63c2f25101b8663b072aee2",
    "slot": 0,
    "seed": 0,
    "repetitionIndex": 0,
    "category": "raw-material",
    "weight": 1,
    "baseline": {"success": false, "replayPassed": true, "cost": 10, "latencyMs": 1000},
    "candidate": {"success": true, "replayPassed": true, "cost": 11, "latencyMs": 1100},
    "baselineEvidencePath": "/absolute/path/baseline-live.json",
    "candidateEvidencePath": "/absolute/path/candidate-live.json",
    "baselineReplayPath": "/absolute/path/baseline-replay.json",
    "candidateReplayPath": "/absolute/path/candidate-replay.json"
  }]
}
```
