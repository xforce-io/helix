# Factorio example（Helix）

这是 Helix 的 **Factorio 域 example 族**：与 Factorio / FLE 相关的能力、剧本和验收都内聚在这里（`examples/factorio` + `src/factorio`），不拆成多个平行 top-level example。

Helix 以后会有 **很多 examples**。和 Factorio **无关** 的场景应另开 example，不要硬塞进本目录。

本 example **不是** Helix 公共 Runtime API；契约以各 Issue 的 L2 为准，交付面为 example-internal。

## 设计与 Issue

| 能力 | Issue | L2 |
|---|---|---|
| RLM + 真实 FLE 纵切 | [#1](https://github.com/xforce-io/helix/issues/1) | [`docs/design/1-rlm-factorio-harness.md`](../../docs/design/1-rlm-factorio-harness.md) |
| 墙钟 deadline + finalization | [#3](https://github.com/xforce-io/helix/issues/3) | [`docs/design/3-factorio-milkie-runtime-contracts.md`](../../docs/design/3-factorio-milkie-runtime-contracts.md) |
| 同步递归 `helix.models.call` | [#5](https://github.com/xforce-io/helix/issues/5) | [`docs/design/5-kernel-recursive-model-call.md`](../../docs/design/5-kernel-recursive-model-call.md) |
| 持久 session / 异步 handle / mailbox | [#7](https://github.com/xforce-io/helix/issues/7) | [`docs/design/7-session-subagent-mailbox.md`](../../docs/design/7-session-subagent-mailbox.md) |

## 一个 example，多条路径

| 路径 | 入口 | 默认 | 证明什么 |
|---|---|---|---|
| **P0 环境 smoke** | `npm run verify:factorio:live-smoke` | 固定 mining 程序 | 真容器 + FLE 可改游戏状态 |
| **P1 Agent 主路径** | `npm run verify:factorio:live` | 模型写 cell；#5 `models.call` 可用 | model-owned RLM + Trace + finalization |
| **P1 Replay** | `npm run verify:factorio:replay -- --run <runId>` | 禁 live fallback | 与 Live 同 run 零 live Replay |
| **P2 Session / async** | `npm run verify:factorio:live:session`（`HELIX_SESSION_ASYNC=1`） | **opt-in**，非默认 | pins v5 + 持久 session Host；契约单测见 `test/session-async.test.ts` |

- **P1 是默认主路径**：不设 `HELIX_SESSION_ASYNC` 时行为与 pins 保持 #5 时代（harness `factorio-rlm/v4` 等），避免无声升级。
- **P2 仍属本 Factorio example**，不是第二个 top-level example；只是第二条剧本/开关。
- 单元测试 `npm test` **不需要** Factorio 容器，覆盖 #5/#7 大量契约。

## 前置

- Docker（Compose）
- `uv`
- 足够资源跑 `factoriotools/factorio:2.0.73`
- Agent 路径还需要 Anthropic 兼容端点（凭证只放环境变量，不入库）

FLE 使用 headless Factorio；本 text-only 路径不需要图形客户端。

## P0 — 环境 smoke

```bash
npm run factorio:cluster:start
npm run verify:factorio:live-smoke
npm run factorio:cluster:stop
```

证据：`artifacts/factorio/live-smoke.json`。

通过条件（摘要）：真 FLE adapter、tick 前进、≥2 burner drill、无 action error、程序/步时限、`task_verification.success=true`。

`cluster` 使用 Helix 标签容器；`stop` 无该标签则拒绝删除。smoke **不满足** Issue #1（无 model-owned cell / milkie Replay）。

## P1 — Agent live + replay（默认）

```bash
export ANTHROPIC_AUTH_TOKEN='<token>'
export ANTHROPIC_BASE_URL='<endpoint>'   # 如需要
export ANTHROPIC_MODEL='<model-ref>'     # 或 --model
npm run factorio:cluster:start
npm run verify:factorio:live
npm run verify:factorio:replay -- --run <runId>
npm run factorio:cluster:stop
```

- Live 证据：`artifacts/factorio/runs/<runId>/live.json`
- Replay 证据：`artifacts/factorio/runs/<runId>/replay.json`
- Finalization：`artifacts/factorio/final-outcomes/`（正式结果；observation Outcome 不作终裁）

Harness **无** gold/fixed action。模型必须自己写 reset 与后续 `factorio.step`，并消费有界 FLE 反馈直至 verifier success。

Preflight：Helix 标签容器、镜像 pin、FLE 版本、task digest、RCON。Run 级 30min deadline 经 milkie 传到 LLM/Tool；本地 profile 另有 FLE 步时限、Kernel CPU/RSS、8KiB preview、uncertain 终态等。**example profile，不是多租户生产沙箱。**

默认可使用 Kernel 内 **`helix.models.call`**（#5）：同步递归子查询、独立 child run、与 factorio effect 同 cell 互斥。大结果走对象 Ref，不强制进外层 context。

仅当 **同一 `runId` 的 Live + Replay 均 pass** 时，才视为 P1 纵切验收通过（对应 #1/#3/#5 主故事）。

## P2 — Session / async sub-agent / mailbox（opt-in）

```bash
export ANTHROPIC_AUTH_TOKEN='<token>'
export ANTHROPIC_MODEL='<model-ref>'
export HELIX_SESSION_ASYNC=1    # 或 true / yes
npm run factorio:cluster:start
npm run verify:factorio:live:session
# 若 Live 打印 runId：
npm run verify:factorio:replay -- --run <runId>
```

启用后：

- pins：`factorio-rlm/v5` + `bindingSet factorio/v4` + `sessionAsyncVersion: 1`
- live evidence schema：`helix.factorio.live/v4`（含 session merge/budget 切片）
- 持久 session 根目录：`artifacts/factorio/sessions/`
- Kernel 在 capability 打开时可暴露 `helix.session` / `helix.agents` / `helix.mailbox`（见 L2）

**不设 `HELIX_SESSION_ASYNC` 时 P2 关闭**，避免默认改变 P1 pins 与证据形态。

### P2 已知限制（residual）

下列为 **Factorio example 债**，不另开 top-level example；跟踪
[#9](https://github.com/xforce-io/helix/issues/9)：

1. **Child Kernel 完整 bootstrap**：生产路径上 child capability 不进 attach/LLM/trace；Host 侧 `runAsChild` 可测 child actor 权限。独立 child IPython 注入 `helix.session/*` binding 的端到端仍不完整。
2. **Capability registry** 主要在进程内；session **ledger / checkpoint / 预算尾** 已文件持久，跨 CLI 进程的 token 注册表未做完整产品化。
3. **真集群 E2E 绿条**：需本机 Docker Factorio + 模型；无容器时只能跑单测与（失败的）smoke。

## 布局

```text
examples/factorio/          # Python：cluster、smoke、workers、pytest
  workers/                 # kernel / bridge / preflight
  verify_live.py           # P0 smoke
src/factorio/               # TS：harness、live/replay、#5 recursive、#7 session
artifacts/factorio/         # traces、objects、runs、sessions、final-outcomes
test/*factorio* / session-async / recursive-model  # 无容器契约测试
```

## 测试

```bash
npm test
```

覆盖（无 Factorio）：IPython/builtins 逃逸、action allowlist、有界投影、retry capability、wall/RSS、uncertain、幂等 command、stale revision、preflight pins、Trace-before-finalization、deadline/cancel、finalization conflict、State Ref、#5 recursive 契约、#7 session/async 契约等。

## 非目标（本 example）

- Helix 公共 npm Runtime API / 稳定 SDK
- 把非 Factorio 场景塞进本目录
- 用 fixed action 冒充 model-owned P1 验收
- 在 Helix 复制 milkie lifecycle / Trace / Replay / lineage / outcomes
