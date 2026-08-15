# Factorio P3 自演化实现总结

本文档总结了 Issue #22 P3 自演化闭环的实现，特别是协议保护和操作员发布路径两个新功能。

## 已完成任务

### ✅ 任务 1：Fail-closed 协议保护

如果生成的 overlay 丢失 Factorio no-import / first-reset 协议，admission 会 fail-closed。

#### 实现文件
- `examples/factorio/src/overlay-protocol-guard.ts`：核心验证逻辑
- `examples/factorio/src/refinement-host.ts`：集成到 refinement host

#### 关键功能
1. **不可变 system instruction**
   - overlay 不得替换承载完整 Factorio 协议的 `systemInstructionTemplate`

2. **精确协议规则检查**
   - 修改 `protocolRules` 时，必须逐字保留 first-reset 与 no-import 两条规则
   - 不依赖模型生成文本的启发式关键词匹配

#### 测试覆盖
- `examples/factorio/test/overlay-protocol-guard.test.ts`
- 9 个单元测试，覆盖：
  - 允许不修改不可变控制项的 overlay
  - 拒绝覆盖 system instruction
  - 拒绝丢失或弱化 first-reset / no-import 规则

### ✅ 任务 2：操作员发布路径

操作员可以发布实时策略/套件（generation.model=ANTHROPIC_MODEL）到 `artifacts/factorio/harness-state` 并铸造人工断言。

#### 实现文件
- `examples/factorio/publish-config.ts`：发布脚本
- `examples/factorio/config-templates/example-policy.json`：策略模板
- `examples/factorio/config-templates/example-suite.json`：套件模板
- `examples/factorio/PUBLISH-CONFIG.md`：操作员文档

#### 关键功能
1. **策略发布**
   - 验证 `policy.generation.model` 与 `ANTHROPIC_MODEL` 一致
   - 验证策略 schema 和必需字段
   - HMAC-SHA256 签名（使用 fixture 密钥）
   - 发布到 RCS artifacts

2. **套件发布**
   - 验证套件 schema 和测试用例
   - 确保所有用例有效（caseId、inputRef、seed、weight）
   - HMAC-SHA256 签名
   - 发布到 RCS artifacts

3. **提取器摘要验证**
   - 策略必须包含正确的 extractorDigest
   - 当前值：`sha256('helix.factorio.extractor/v1')`

#### 使用方法

```bash
# 1. 设置环境变量
export ANTHROPIC_MODEL='claude-3-7-sonnet-20250219'

# 2. 准备配置文件（从模板开始）
cp examples/factorio/config-templates/example-policy.json my-policy.json
# 编辑 my-policy.json：
#   - 设置 "model" 为 $ANTHROPIC_MODEL
#   - 设置 "extractorDigest" 为当前值
#   - 调整 gate 参数和 manualApprovers

# 3. 发布策略
tsx examples/factorio/publish-config.ts \
  --policy my-policy.json \
  --id factorio-policy-v1

# 4. 准备套件文件
cp examples/factorio/config-templates/example-suite.json my-suite.json
# 编辑 my-suite.json：添加或修改测试用例

# 5. 发布套件
tsx examples/factorio/publish-config.ts \
  --suite my-suite.json \
  --id factorio-suite-v1

# 6. 验证发布
cat artifacts/factorio/harness-state/refinement-control.json | \
  jq '.artifacts[] | select(.ref | contains("policy") or contains("suite"))'
```

## 协议保护工作原理

### 场景 1：生成的 overlay 丢失 first-reset 协议

```json
// 模型生成的 overlay（会被拒绝）
{
  "schemaVersion": "helix.harness-overlay/v1",
  "baseBaselineRef": {...},
  "changes": {
    "protocolRules": [
      "Call the environment setup function first.",
      "Never add import statements."
    ]
  }
}
```

**结果**：
```
Error: generated overlay fails Factorio protocol guard: 
Factorio protocol violation: generated overlay drops first-reset protocol rule
```

### 场景 2：生成的 overlay 使用弱建议

```json
// 模型生成的 overlay（会被拒绝）
{
  "schemaVersion": "helix.harness-overlay/v1",
  "baseBaselineRef": {...},
  "changes": {
    "protocolRules": [
      "First environment effect must call factorio.reset().",
      "Prefer not using import statements."  // ❌ 太弱
    ]
  }
}
```

**结果**：
```
Error: generated overlay fails Factorio protocol guard:
Factorio protocol violation: generated overlay drops no-import protocol rule
```

### 场景 3：合法的 overlay

```json
// 模型生成的 overlay（会被接受）
{
  "schemaVersion": "helix.harness-overlay/v1",
  "baseBaselineRef": {...},
  "changes": {
    "protocolRules": [
      "First environment effect must call factorio.reset() exactly once.",
      "Never use import statements in outer cells or Factorio action strings.",
      "Submit at most one external effect per cell."
    ]
  }
}
```

**结果**：✅ 成功 admitted，继续 refinement 流程

## 测试结果

```bash
$ npm test

> helix-agent@0.0.0 test
> npm run check && npm run test:unit

> helix-agent@0.0.0 check
> tsc -p tsconfig.json --noEmit && tsc -p examples/factorio/tsconfig.json

> helix-agent@0.0.0 test:unit
> tsx --test test/*.test.ts test/catalog/*.test.ts test/refinement/*.test.ts examples/factorio/test/*.test.ts && ...

# tests 252
# pass 252
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8487
```

## 集成点

### 1. refinement-host.ts 集成

```typescript
const adapter: RefinementCommandHost['adapter'] = {
  ...baseAdapter,
  async generate(input) {
    // 强制 model 一致性检查
    if (input.policy.generation.model !== generationModel) {
      throw new Error(
        `Factorio refinement policy model must equal ANTHROPIC_MODEL (${generationModel})`,
      )
    }
    
    const result = await baseAdapter.generate(input)
    
    // Fail-closed: 验证生成的 overlay 保留 Factorio 协议
    try {
      const admitted = admitGeneratedOverlayPayload({
        payloadText: result.payloadText,
        baseBaselineRef: input.baselineRef,
      })
      const protocolError = validateFactorioOverlayProtocol(admitted.overlay)
      if (protocolError !== undefined) {
        throw new Error(`Factorio protocol violation: ${protocolError}`)
      }
    } catch (error) {
      throw new Error(
        `generated overlay fails Factorio protocol guard: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    
    return result
  },
}
```

### 2. CLI 集成

Refinement admin CLI 已经支持 publish-policy / publish-suite 命令：

```bash
node --import tsx src/refinement/cli.ts refinement-admin publish-policy \
  --host-module examples/factorio/src/refinement-host.ts \
  --id <id> \
  --policy <file> \
  --issuer <issuer> \
  --key-id <keyId> \
  --signature <signature>
```

publish-config.ts 脚本封装了这个流程，自动处理签名和验证。

## 文件清单

### 新增文件
- `examples/factorio/src/overlay-protocol-guard.ts`：协议验证逻辑
- `examples/factorio/test/overlay-protocol-guard.test.ts`：协议验证测试
- `examples/factorio/publish-config.ts`：操作员发布脚本
- `examples/factorio/config-templates/example-policy.json`：策略模板
- `examples/factorio/config-templates/example-suite.json`：套件模板
- `examples/factorio/PUBLISH-CONFIG.md`：操作员文档
- `examples/factorio/P3-IMPLEMENTATION-SUMMARY.md`：本文档

### 修改文件
- `examples/factorio/src/refinement-host.ts`：集成协议验证

## 后续工作

### 建议增强
1. **更智能的协议推断**：可以从 baseline 推断必需协议，而不是硬编码
2. **协议版本化**：支持不同版本的 Factorio 协议（v4, v5, 等）
3. **自定义验证规则**：允许 Host 注入自定义协议验证器
4. **生产密钥管理**：从 fixture HMAC 密钥迁移到真实 HRCA PKI

### 已知限制
1. 当前使用 fixture HMAC 密钥签名，生产环境需要真实 HRCA
2. 协议验证规则是硬编码的，未来可能需要更灵活的配置
3. publish-config.ts 脚本假设本地环境有 tsx 和必要依赖

## 参考

- Issue #22: P3 自演化闭环
- PR #23: 完成 P3 Host 接线
- `docs/design/13-harness-refinement-toolchain.md`：Refinement 架构设计
- `examples/factorio/refinement/README.md`：Factorio refinement 文档
