# Factorio self-evolution success-rate experiment

This directory is the immutable-input template for Issue #29.  It does not
contain credentials or private holdout content.  The suite has 160 paired
cases: ten registered task profiles, four configured FLE slots, and four
independent model repetitions per profile/slot.  `seed` always means the
pre-provisioned FLE slot (0–3); it is never forwarded as an arbitrary FLE
`run_idx`.

1. Start four matching FLE containers: `npm run factorio:cluster:start -- --count 4`.
2. Publish a signed policy and `suite.json` through the existing refinement
   control plane; use a fresh `HELIX_FACTORIO_HARNESS_STATE_ROOT` for an
   experiment instead of touching the default durable state.
3. Run the signed propose/evaluate flow.  Keep every live and replay evidence
   file, then build `index.json` with their absolute paths and exact RCS refs.
4. Analyze it: `npm run factorio:experiment -- analyze --index <index.json>`.
   A non-zero exit is expected unless every quality, replay, statistic,
   category, cost, and latency gate passes.
5. Only after a `passed` `analysis.json` binds the exact candidate and overlay
   may a human make the separate existing RCS manual-promotion decision.

`index.json` uses this closed shape (all paths are existing immutable
evidence, never summaries invented by the operator):

```json
{
  "schemaVersion": "helix.factorio.experiment-index/v1",
  "experimentId": "success-rate-v1",
  "reportRef": "evaluation-report:...",
  "candidateRef": "candidate:...",
  "overlayRef": "overlay:...",
  "pairs": [{
    "caseId": "iron-plate-slot-0-rep-0",
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
