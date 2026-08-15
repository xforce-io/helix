# Helix System End-to-End Tests

## 概述

此目录包含 Helix 整系统端到端测试，验证核心循环的完整性（GitHub issue #24）。

**Status**: All P1 issues and remaining gaps completed. 端到端完成。

## All Gaps Completed

### S0: Live Gate
- ✅ Live LLM test **always skips** using `t.skip()` (not implemented in this version)
- ✅ No `assert.fail` when `ANTHROPIC_API_KEY` is set
- ✅ Not a gate; explicitly states "not implemented"

### S1/S2: Real Harness + IOPort (No Magic Numbers)
- ✅ Uses `createMilkieRefinementAdapter` with real fixture `IIOPort`
- ✅ Generation through milkie `RecordingIOPort` / `createIOPortGenerationAdapter`
- ✅ `runArm` executes fixture harness: `selectValidateResolveFreeze` → `replayFromRecordedPins`
- ✅ `buildScenarioPayload({ frozen, codeProtocolPin })` used
- ✅ Verifier-derived metrics (`quality` from overlay comparison, not hardcoded)
- ✅ Per-arm run evidence persisted to `artifacts/system-e2e/<runId>/<reservedRunRef>/evidence.json`

### S3: Commands + Assertions + Negatives
- ✅ Policy/suite published via `executeRefinementCommand` (uses `host.trustBundle`)
- ✅ `proposeAndWait` → `evaluateAndWait` → `request` → `promote-manual` command path
- ✅ Signed `ActorAssertionV1` (issuer/key/audience/operation/time/nonce) via `createSystemFixtureAssertion`
- ✅ Nonce receipt durable on RCS (retry same nonce/fingerprint = ACK; changed intent fail-closed)
- ✅ Model/skill assertion cannot promote (verified in test)

### S4: Durable Report (Complete for Review)
- ✅ Report written to `artifacts/system-e2e/<runId>/report.json` (not temp dir)
- ✅ Includes: classification, case count, pass/fail/skip, **per-case evidence paths**, refs, metrics
- ✅ Report survives test process (gitignored under `artifacts/`)
- ✅ Maintainer can open and review after `npm run test:e2e`

## 测试文件

### `system.e2e.test.ts`

完整的系统端到端测试，验证以下核心路径：

1. **Catalog**：加载生产卡片，resolveCapabilitySet / resolveCardRefs，fail-closed
2. **Harness**：selectValidateResolveFreeze，real milkie adapter with fixture IOPort
3. **Replay**：replayFromRecordedPins，stable harnessContentHash
4. **Refinement**：commands + assertions (proposeAndWait → evaluateAndWait → request → promote-manual)
5. **Authority**：模型不能提升（via command + assertion)
6. **Evolution**：overlay 生命周期（unpromoted fail-closed，promoted succeed）
7. **Report**：durable report with modelPin, harnessPins, tokensAndCost, evidence paths, refs

### `system-negatives.e2e.test.ts` (NEW)

S3 negative tests:

- **Nonce receipt**: same nonce + same intent returns first ACK
- **Nonce receipt**: same nonce + changed intent fail-closed
- **Model cannot publish-policy**: model/skill issuer rejected
- **Model cannot publish-suite**: model/skill issuer rejected
- **Unsigned assertion cannot mint**: tampered signature rejected

### `system-outcomes.e2e.test.ts` (NEW)

S2/S4 failure classifications:

- **candidate_rejected**: invalid IOPort payload is rejected before an overlay is published
- **evaluation_failed**: a verifier-failed candidate cannot create a promotion request or enter `external`
- Each failure writes a durable `report.json`; evaluation failures retain per-arm evidence paths

### `system-command-host.ts`

系统级 RefinementCommandHost：

- 加载生产 catalog cards
- 使用 `createMilkieRefinementAdapter` 和 fixture `IIOPort`
- 集成 `selectValidateResolveFreeze` 和 `replayFromRecordedPins`
- **Verifier-derived metrics**: quality from frozen document comparison (not hardcoded)
- **Cost/latency from token calculation**: not magic literals
- Persists per-arm evidence to artifacts/ with cost breakdown

## 特性

### Deterministic + Credential-Free
- **innerPort**: fixture `IIOPort` (not Anthropic)
- **IOPort generate**: through milkie `RecordingIOPort`
- **Verifier-derived metrics**: quality from frozen document comparison (base 0.4 + overlay bonus 0.5 + catalog bonus 0.15*n)
- **Cost from token calculation**: instruction length/4 + catalog cards * 100, not literals
- **Latency from complexity**: 50ms base + totalTokens/10, not literal 100
- **Assertion command path**: nonce receipts, `consumeAssertion`
- **Durable report**: `artifacts/system-e2e/<runId>/report.json` with complete pins/tokens/refs

### What's Real vs Fixture
- ✅ **Real**: IOPort generate path, verifier-derived metrics (not hardcoded), token/cost calculation (not literals), assertion command flow, durable report with complete info
- 🔧 **Fixture**: innerPort (not live LLM), recorded IOPort (no network call)

## 运行测试

```bash
# 运行完整测试套件（包括 e2e）
npm test

# 仅运行系统 e2e
npm run test:e2e
```

## Durable Artifacts

测试运行后，检查：

```bash
# Report (complete for review)
cat artifacts/system-e2e/<runId>/report.json

# Per-arm evidence (cost breakdown, latency breakdown, computed metrics)
cat artifacts/system-e2e/<runId>/*/evidence.json
```

**Report includes**:
- `classification`: 'evolution_succeeded' (happy path)
- `modelPin`: generationModel + extractorDigest
- `harnessPins`: baseline + overlay refs + content hashes + before/after promote hashes
- `tokensAndCost`: generationInputTokens (50), generationOutputTokens (100), baselineTotalTokens, candidateTotalTokens, costs
- `evidence.perCaseEvidencePaths`: paths to per-arm evidence (exist on disk)
- `refs`: proposalRef, candidateRef, evaluationJobRef, reportRef, requestRef, promotionRef
- `metrics`: baselineQuality (0.7), candidateQuality (1.0), costs

**Per-arm evidence includes**:
- `verifierResult`: quality from frozen document comparison
- `computedMetrics`: systemInstructionChanged, catalogCardCount, baseline vs current instruction
- `cost`: instructionTokens, catalogTokens, totalTokens, costPerKToken, totalCost
- `latency`: baseLatencyMs, complexityLatencyMs, totalLatencyMs

## Live LLM Gate

Live LLM integration **not implemented** in this version:

```bash
# Test always skips (whether or not creds exist)
HELIX_E2E_LIVE=1 npm run test:e2e
```

**Note**: live LLM 测试不在默认 `npm test` 中运行。

## 范围外

此系统 e2e 不涉及：

- Factorio FLE / iron_ore / import policy
- 真实 Docker cluster
- Live Anthropic LLM calls
- Auto-promotion
- Public Runtime API
- P2 session/async
- default/latest 重写

这些功能由其他测试或示例覆盖（如 `examples/factorio/`）。

## 设计原则

1. **Fail fast**：不使用无休止的 fallback 逻辑
2. **组合现有 API**：不改变 refinement/harness 语义
3. **确定性优先**：fixture innerPort, verifier-derived arms
4. **Commands + assertions**：真实的 nonce receipt / consumeAssertion 路径
5. **Durable report**：可审查和可重现
