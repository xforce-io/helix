# Factorio self-evolution success-rate experiment v2

`success-rate-v2` is the next official freeze defined by Issue #29's approved
design. It is intentionally separate from the failed historical
`success-rate-v1` matrix: the v1 identities and all r4 screen evidence are
development history only and must not enter a v2 candidate prompt or index.

The workflow is ordered and fail-closed:

1. Run and retain terminal, replayable source evidence only on the certified
   development catalog. A formal candidate generation rejects source evidence
   without a matching development `experimentProfile`.
2. Generate and admission-check one candidate. Its task narrative must remain
   task-agnostic and derive recipe, machines, resources, placement, and scale
   from the current FLE reset.
3. After that candidate is terminal, publish the new signed policy, 160-case
   suite, and `experiment-freeze.json` in an isolated
   `HELIX_FACTORIO_HARNESS_STATE_ROOT`. The freeze ID is `success-rate-v2`.
4. Run every frozen pair (10 certified v2 holdout tasks × 4 slots × 4 repeats),
   then replay every baseline and candidate arm. Keep immutable absolute paths
   in `index.json`.
5. Run `npm run factorio:experiment -- analyze --index <index.json>`. Only an
   exact 160-pair matrix can be official; all gates still apply. A failed or
   indeterminate analysis is evidence, not a promotion input.

The full closed index shape and evidence requirements are unchanged from v1;
copy its field structure only, never its task identities, freeze digest, or
evidence paths. The approved fact source is
`docs/design/29-factorio-evolution-experiment.md`.
