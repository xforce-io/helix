# Helix System End-to-End Tests

## 概述

此目录包含 Helix 整系统端到端测试，验证核心循环的完整性（GitHub issue #24）。

## 测试文件

### `system.e2e.test.ts`

完整的系统端到端测试，验证以下核心路径：

1. **Catalog**：加载生产卡片，resolveCapabilitySet / resolveCardRefs，fail-closed
2. **Harness**：selectValidateResolveFreeze，fixture scenario adapter
3. **Replay**：replayFromRecordedPins，stable harnessContentHash
4. **Refinement**：propose → evaluate → request → promote
5. **Authority**：模型不能提升
6. **Evolution**：overlay 生命周期（unpromoted fail-closed，promoted succeed）

### `system-command-host.ts`

系统级 RefinementCommandHost fixture：

- 加载生产 catalog cards
- 使用 `createFixtureScenarioAdapter` 实现确定性执行
- 集成 `selectValidateResolveFreeze` 和 `replayFromRecordedPins`
- 验证 freeze 和 replay 的 hash 一致性

## 特性

- **确定性**：无需真实 LLM、Docker 或 Factorio cluster
- **无需凭据**：完全基于 fixture，可作为默认 CI gate
- **完整验证**：覆盖 catalog + harness + refinement 完整流程
- **结构化报告**：输出 JSON 格式的测试结果

## 运行测试

```bash
# 运行完整测试套件（包括 e2e）
npm test

# 仅运行系统 e2e
npm run test:e2e
```

## Live LLM Gate

通过 `HELIX_E2E_LIVE=1` 环境变量控制：

```bash
# 启用 live LLM gate（需要凭据）
HELIX_E2E_LIVE=1 npm run test:e2e
```

如果 `HELIX_E2E_LIVE=1` 但凭据缺失，测试将**明确 skip**，而不是通过或失败。

**注意**：live LLM 测试不在默认 `npm test` 中运行。

## 范围外

此系统 e2e 不涉及：

- Factorio FLE / iron_ore / import policy
- 真实 Docker cluster
- Auto-promotion
- Public Runtime API
- P2 session/async
- default/latest 重写

这些功能由其他测试或示例覆盖（如 `examples/factorio/`）。

## 设计原则

1. **Fail fast**：不使用无休止的 fallback 逻辑
2. **组合现有 API**：不改变 refinement/harness 语义
3. **确定性优先**：fixture 作为默认，live 作为可选
4. **清晰边界**：系统测试验证核心，示例验证集成
