# Harness refinement

Issue #13 的 refinement control plane 是 Host 内部能力。它不向 Kernel 或模型暴露 Store、Provider、promotion 或配置发布写入接口。

## 边界

- Candidate 仅能由已记录的 milkie generation run 输出的单一原始 JSON overlay 准入；文件、stdin、人工 payload 都不是 Candidate 写入入口。
- Candidate 在 RCS 中是普通 #10 overlay，但在 approval 前只允许 evaluator route 用原有 `{baselineRef, overlayRef}` 选择；普通未来 run 被拒绝。
- 评估的 baseline/candidate 都是独立 recorded runs；共享 execution pins 必须一致。门禁是确定性的，不调用 LLM。
- Policy/Suite 只能由 HRCA 发布：当前 deployment trust bundle 验证 publisher 签名、key window 与 revocation；无 unsigned publish API。manual promotion 需要 Policy 中的人工主体；auto promotion 需要精确绑定 Request/Report/Candidate、当前 trust-bundle generation、过期前的一次性 sealed grant。promotion 不改变 baseline、alias、历史 run 或 replay。
- 每个副作用 command 的 actor assertion 都必须含 issuer/key、audience、operation、时间和 nonce；RCS 对 nonce 建立耐久 receipt：**首次 assertion transaction 只写 receipt + Proposal/GenerationJob（或 EvaluationJob）+ 不可变 ACK**；generation/evaluation 在 ACK 之后由幂等 worker 完成。相同 fingerprint 重试返回首次 ACK 字节；改变 intent fail closed。
- `propose` 成功机器输出仅为 `{proposalRef,generationJobRef}`；`evaluate` 仅为 `{evaluationJobRef}`。`candidateRef` / `reportRef` 只在 terminal job 的 `show` 中出现。

## 生产 Host 接入

生产 Host 必须导出 `createRefinementCommandHost()`，返回：

- `rcs`：RCS 实例（#10 Store + refinement control）
- `trustBundle`：当前 deployment trust bundle
- `adapter`：milkie-recorded `RefinementRunAdapter`（推荐 `createMilkieRefinementAdapter`）
- 可选 `now`：可信时钟

Factorio example Host：`examples/factorio/src/refinement-host.ts`（`createRefinementCommandHost`）。P3 路径见 `examples/factorio/README.md`。

```bash
# 副作用命令（需 --host-module + --assertion）
helix refine propose --host-module ./host.mjs --assertion assertion.json \
  --proposal-id p1 --source-runs run-a,run-b --baseline baseline:…@0#… --policy policy:…@0#…

helix refine evaluate --host-module ./host.mjs --assertion assertion.json \
  --candidate candidate:…@0#… --policy policy:…@0#… --suite suite:…@0#…

helix refine request --host-module ./host.mjs --assertion assertion.json --report report.json
helix refine promote --manual --host-module ./host.mjs --assertion assertion.json --request … --policy …
helix refine reject --manual --host-module ./host.mjs --assertion assertion.json --request … --policy …
helix refine promote --auto --host-module ./host.mjs --request … --policy … --grant grant.json

helix refine show generation-job --ref generation-job:…@0#… --host-module ./host.mjs
helix refine show evaluation-job --ref evaluation-job:…@0#… --host-module ./host.mjs
helix refine explain report --ref evaluation-report:…@0#… --root <rcs-root>

# HRCA 配置发布
helix refinement-admin publish-policy --host-module ./host.mjs --id policy-v1 \
  --policy policy.json --issuer hrca --key-id k1 --signature <hex>
helix refinement-admin publish-suite --host-module ./host.mjs --id suite-v1 \
  --suite suite.json --issuer hrca --key-id k1 --signature <hex>

# 原始 command JSON（与上列等价）
helix refine command --host-module ./host.mjs --input command.json
```

CLI 不会在没有 Host composition 时伪造 Provider、权限或 assertion 输入。

## 可执行 fixture smoke

下列命令覆盖 `propose → evaluate → request → manual promote`。它使用仓库内的确定性**已记录 run adapter fixture**，不访问 Provider，因此是 CLI/持久化/可见性 smoke，而不是真实模型质量证明：

```bash
npm run build
node dist/refinement/cli.js refine fixture-smoke --root /tmp/helix-refinement-smoke
```

成功输出 JSON，含 proposal ACK、generation show（含 candidateRef）、通过的 report、request 与被 promotion 的普通 overlay ref。

模型 skill 仅可发起 proposal、evaluation、request 和读取解释；不得签发 policy/suite、提交 payload、批准或自动 promotion。见 [`skills/helix-harness-refinement/SKILL.md`](../skills/helix-harness-refinement/SKILL.md)。
