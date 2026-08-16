# Factorio P3 操作员路径：发布策略和评估套件

本文档描述如何将实时策略（policy）和评估套件（suite）发布到 `artifacts/factorio/harness-state` 中。

## 前置条件

1. 设置模型连接环境（`HELIX_LLM_*`）：
   ```bash
   export HELIX_LLM_TRANSPORT=api
   export HELIX_LLM_PROTOCOL=anthropic-messages
   export HELIX_LLM_MODEL='claude-3-7-sonnet-20250219'
   export HELIX_LLM_API_KEY='<token>'
   ```

2. 确保 `artifacts/factorio/harness-state` 目录存在（首次运行 Host 会自动创建）

## 发布策略（Policy）

策略定义了：
- 生成模型（必须与连接投影 `model` / `HELIX_LLM_MODEL` 一致）
- 最大输出 token 数
- 评估门控阈值（质量、成本、延迟、失败率）
- 人工审批者列表

### 步骤 1：创建策略文件

从模板开始：
```bash
cp examples/factorio/config-templates/example-policy.json my-policy.json
```

编辑 `my-policy.json`：
- 将 `"model"` 设置为 `$HELIX_LLM_MODEL` 的值
- 将 `"extractorDigest"` 设置为当前提取器的 64 字符 hex hash
  （可从 `examples/factorio/src/refinement-host.ts` 中的 `FACTORIO_EXTRACTOR_DIGEST` 获取）
- 调整 `gate` 参数和 `manualApprovers` 列表

### 步骤 2：发布策略

```bash
tsx examples/factorio/publish-config.ts \
  --policy my-policy.json \
  --id factorio-policy-v1
```

成功后会输出：
```
✓ Published policy: {"kind":"policy","id":"factorio-policy-v1","revision":0,"contentHash":"..."}
✓ Stored in: artifacts/factorio/harness-state/refinement-control.json
```

## 发布评估套件（Suite）

评估套件定义了一组测试用例，每个用例包括：
- `caseId`: 唯一标识符
- `inputRef`: 输入数据引用
- `seed`: 随机种子（确保可重现性）
- `weight`: 权重（用于加权聚合）

### 步骤 1：创建套件文件

从模板开始：
```bash
cp examples/factorio/config-templates/example-suite.json my-suite.json
```

编辑 `my-suite.json`，添加或修改测试用例。

### 步骤 2：发布套件

```bash
tsx examples/factorio/publish-config.ts \
  --suite my-suite.json \
  --id factorio-suite-v1
```

## 验证发布

检查发布的配置：
```bash
cat artifacts/factorio/harness-state/refinement-control.json | jq '.artifacts[] | select(.ref | contains("policy") or contains("suite"))'
```

## 协议保护

生成的 overlay 会被自动验证，确保不会丢失 Factorio 关键协议：

1. **first-reset 协议**：第一个环境效应必须调用 `factorio.reset()`
2. **no-import 协议**：禁止在 action string 中添加 import 语句

如果生成的 overlay 违反这些协议，admission 会 fail-closed。

为避免以新的 prompt 覆盖完整协议，Factorio Host 不接受对
`systemInstructionTemplate` 的 overlay 修改；修改 `protocolRules` 时必须逐字保留
first-reset 和 no-import 两条不可变规则，其余规则可以扩展。

## 提取器摘要（Extractor Digest）

当前 Factorio 提取器摘要：
```typescript
// examples/factorio/src/refinement-host.ts
export const FACTORIO_EXTRACTOR_DIGEST = createHash('sha256')
  .update('helix.factorio.extractor/v1')
  .digest('hex')
```

获取值：
```bash
node -e "console.log(require('crypto').createHash('sha256').update('helix.factorio.extractor/v1').digest('hex'))"
```

## 人工断言（Human Assertions）

操作员可以通过 refinement workflow 铸造人工断言：

```bash
# 创建断言（示例）
node --import tsx src/refinement/cli.ts propose \
  --host-module examples/factorio/src/refinement-host.ts \
  --assertion assertion.json \
  --proposal-id proposal-1 \
  --source-runs run-1,run-2 \
  --baseline baseline:factorio.default-p1@1#... \
  --policy policy:factorio-policy-v1@0#...
```

断言文件格式见 `src/refinement/trust.ts` 中的 `ActorAssertionV1`。

## 注意事项

- **模型一致性**：policy 的 `generation.model` 必须与连接投影 `model` 完全一致，否则会在运行时被拒绝
- **不可变性**：发布的 policy 和 suite 是不可变的，修改需要发布新版本（新的 id 或 revision）
- **签名验证**：所有配置都使用 HMAC-SHA256 签名（当前使用 fixture 密钥，生产环境应使用真实 HRCA）
