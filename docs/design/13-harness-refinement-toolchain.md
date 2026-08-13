# 【harness】受控跨 run Harness Refinement 工具链

- Issue: #13
- 状态: Approved
- 最后更新: 2026-08-12
- 前置: #10 Versioned Harness State、#11 Capability Catalog、既有 milkie IOPort / lifecycle / Trace / lineage / outcome / Replay
- 交付面: 内部 CLI、不可变 refinement artifacts/policy/suite、模型受限 skill、README 与用户文档；**不**提升公共 SDK、Kernel binding 或运行中热切换能力。
- 权威边界: **Refinement CLI 是 refinement workflow 的唯一状态机与执行入口；milkie 是模型 I/O、run 生命周期、Trace、lineage、outcome、预算与 Replay 的唯一权威；`RefinementControlStore`（RCS）是 refinement control 与 #10 overlay 可见性/发布的唯一持久控制面。**

---

## 1. 背景

#10 已将每次 run 的 harness 固定为 run boundary 上的 `{baselineRef, overlayRef?}`：Host 按 `select → validate → resolve → freeze` 使用不可变、可寻址状态；记录和 replay 只恢复当时的精确选择及 pins。#11 则独立拥有 runtime capability card。

研究人员需要一个受审计的跨 run 闭环：从已录制 evidence 生成**唯一**候选 overlay，隔离比较 baseline 与候选，并只在固定、可重算的 gate 与可信外部决策均满足时，让该候选可供后续新 run 显式选择：

`recorded runs → Proposal/GenerationJob → Candidate → EvaluationJob/EvaluationReport → PromotionRequest → PromotionDecision → future selectable overlay`。

候选不得藏在模型会话、skill、内存队列或第二运行时中。模型不得直接写 Store、替换 holdout、选择 alias、直连 Provider、调用未记录 Provider 或自行 promotion；否则被评估对象会同时成为执行者，预算、Trace、Replay、历史复现和审批边界都会失去权威。

所有转换验证精确 identity。任何无法证明的来源、绑定、权限、schema、pin、可见性或信任状态均 fail closed。成功 promotion 不修改 baseline、default/current/latest、旧 run、child run 或 replay；它只允许**之后**经批准的外部 run 路由显式选择同一个已存在的 overlay ref。

---

## 2. 名词解释

| 词 | 定义 |
|---|---|
| **RCS** | 一个具体、耐久、支持 serializable ACID transaction 的 Store。它是 refinement-enabled 部署的 #10 `HarnessStateStore` 实现，并物理拥有 #10 baseline/overlay records、RCS visibility/publication records、policy/suite、Proposal/Job/Event/Result、Candidate、Report、Request、Decision、Association、commit marker、grant nonce 与 assertion receipt。不存在独立 refinement artifact store 与 HarnessStateStore 间的跨库原子性假设。 |
| **recorded run** | 已终结、且经既有 artifact-read gate 可读取 `RunPins`、Trace、lineage、evidence 与 outcome 的 milkie run；只读且从不被评估改写。 |
| **baseline ref** | #10 完整 `HarnessStateRef(kind='baseline',id,revision,contentHash)`。 |
| **overlay ref** | #10 完整 `HarnessStateRef(kind='overlay',id,revision,contentHash)`；`kind` 只有 `baseline` 或 `overlay` 两种字面值。 |
| **#10 overlay payload** | 唯一可作为 candidate 的载荷：#10 `HarnessOverlay` 的完整 `{schemaVersion,baseBaselineRef,changes}`，遵守 #10 §4.1 与 §4.2 闭集、解析、canonical bytes、hash、base binding 和 Catalog closure 规则。 |
| **evaluation-reserved overlay** | 已按 #10 正常持久化的普通 `kind='overlay'` ref，其 RCS 私有可见性记录永久链接至 Candidate。它不是新 ref kind、不是新的 selection shape、不是 inline payload，也不进入普通 Host selection 或常规 list/default/current/latest projection；仅获认证的 evaluator route 可在 admission 后以既有 #10 `{baselineRef,overlayRef}` 选择它。 |
| **ProposalV1** | 稳定 `proposalId` 创建的不可变请求身份，持有 canonical source run refs、baseline ref、policy ref、generation profile 与发起主体摘要；同一 ID 只接受完全相同输入。 |
| **GenerationJobV1** | Proposal 的唯一不可变异步执行身份；生命周期是 append-only Event，成功 Candidate 是唯一 Result，状态只是只读投影。 |
| **CandidateV1** | 唯一合法来源是对应 Job 的 pinned、budgeted milkie generation run 所输出并成功 admission 的唯一 #10 overlay payload。Candidate artifact 不重复保存 inline overlay；它永久指向 admission 时创建的 evaluation-reserved ordinary overlay ref。 |
| **EvaluationJobV1** | Candidate/base/policy/suite 的唯一不可变异步评估身份；生命周期是 append-only Event，成功或 indeterminate Report 是唯一 Result。 |
| **Policy / Suite** | 经 HRCA 发布、可信签名、不可变的 `RefinementPolicyV1` / `EvaluationSuiteV1`。Policy 拥有 generation 限制、完整 execution spec、outcome extractor、aggregation、gate 与 authority；Suite 仅拥有有序 case、每 case immutable input refs、seed 和可选固定 fork parent。holdout 是 Suite 只读输入。 |
| **PromotionRequestV1** | 精确绑定 report/candidate/base/policy/suite 的永久不可变请求；不含 `status`。 |
| **PromotionDecisionV1** | 以 `requestRef` 为唯一键的唯一 append-only terminal record；`approved` 或 `rejected` 的存在就是 Request terminality。 |
| **ActorAssertionConsumptionV1** | RCS 私有耐久 assertion receipt，唯一键 `{issuer,keyId,nonce}`；保存首次 operation fingerprint、idempotency key、canonical ACK/response 与 expiry。它不进入公开 artifact、Trace 或模型上下文。 |
| **sealed auto grant** | 外部 CI/scheduler 签发并由 RCS 验证的不可变签名授权载荷；其 claims 和一次性消费规则见 §4.6。它不是模型、skill、Kernel 或 generation model 身份。 |

除 #10 baseline/overlay 外，refinement artifacts 使用 `RefinementArtifactCanonicalV1` 定义的、各 schema 专属 canonical payload 和 hash。它与 #10 overlay canonicalization 名称、输入类型和用途分离；**不得**把任意“通用 JSON canonicalization”用于 #10 `HarnessStateRef`、overlay payload 或其 `contentHash`。

---

## 3. 设计目标与非目标

### 3.1 目标

1. 提供 CLI 主导的 `propose → evaluate → request → manual/auto promote` 闭环，保存可寻址、不可变、可交叉验证 artifacts。
2. Candidate payload 只能来自一次 pinned、budgeted、经 Helix/milkie IOPort 执行并录制的 generation run；每个 GenerationJob 最多 admission 一个 Candidate。
3. Candidate admission 在同一 RCS transaction 内创建与 payload 完全相同的 #10 ordinary overlay；`payloadHash`、该 overlay ref 的 `contentHash` 与最终 promoted ref 的 `contentHash` 精确相等。
4. Candidate arm 只使用 #10 已有的 `{baselineRef,overlayRef}` selection、普通 `HarnessPinsV1` 和既有 resolve/replay；evaluation-reserved 是 RCS 的 admission/visibility 规则，不扩展 #10 schema、ref union、selection union、HarnessDocument 或 pins 格式。
5. 对固定 Suite 产生 baseline/candidate 各恰好一组 fresh/fork evaluation runs；仅允许 arm harness selection/pins 不同，所有 shared execution pins 必须逐字段相同。
6. 用无 LLM 的确定性 Policy gates 比较完整、outcome-derived 的质量、成本、时延、失败率与 replay 结果。
7. 支持 human/manual 与可信 external CI/scheduler auto；auto 仅在精确 scope、受众、时间和一次性 sealed grant 均有效时允许。
8. 交付可信 configuration publication 边界、README deterministic fixture、用户文档和只具 propose/evaluate/request/show/explain 权限的模型 skill。

### 3.2 非目标

- 运行中 hot swap、session-local mutation、baseline 自动改写、rebase、patch、promotion 时重新生成或转换 candidate。
- stdin/文件/人工/CI artifact 直接提交 Candidate payload，CLI 直接调用 Provider，或第二模型、Trace、runtime。
- 公共 npm SDK、`helix.harness` Kernel binding、模型可发现的 harness 写入 API、常驻 refiner 服务。
- 改写 milkie IOPort、lifecycle、Trace、Replay、lineage、outcome、预算、Host effect gate。
- model/skill 自动 promotion，或改写 default/current/latest alias。
- 扩展 #10 `HarnessStateRef` 的 closed union、#10 selection `{baselineRef,overlayRef?}`、`HarnessPinsV1`、HarnessDocument schema、overlay schema/merge 语义、#11 Catalog card 或任一 scenario/FLE 语义。

---

## 4. 能力与功能设计

### 4.1 单一 durable Store、不可变 job 与原子可见性

RCS 是 refinement-enabled 部署强制使用的 #10 Store 实现。baseline/overlay 的 #10 payload/read/resolve 与 refinement control records 位于同一耐久数据库和 transaction 域；milkie runs、Trace、outcome 仍由既有 authority 持有，RCS 只保存 immutable refs，且从不事务性改写它们。

RCS append-only 保存 Policy、Suite、Proposal、GenerationJob/Event/Result、Candidate、EvaluationJob/Event/Result、Report、Request、Decision、Association、evaluation-reserved visibility records、PromotionCommit、GrantConsumption 和私有 ActorAssertionConsumption。对象写入后载荷和 identity 不变；状态只由 Event/Result 投影，绝不修改 Job、Request 或 ACK。

`propose` 和 `evaluate` 的首次 assertion transaction 分别仅写私有 receipt 加 Proposal/GenerationJob 或 EvaluationJob，并写 immutable ACK：

```json
{"proposalRef":"...","generationJobRef":"..."}
```

```json
{"evaluationJobRef":"..."}
```

同一 `{issuer,keyId,nonce}`、相同 fingerprint/idempotency key 的重试（包括 Job 完成或进程重启后）逐字节返回首次 ACK；不同 fingerprint/key 返回 `REFINEMENT_ASSERTION_REPLAYED`。Candidate admission、Report publication 只追加 JobResult，绝不改写 receipt、ACK、Job 或旧 artifact。

Promotion transaction 建立 transaction-local write set，所有本次写入携带同一 `commitId`。最后写入 `PromotionCommitV1`，其 canonical payload 精确列出 Decision、Association、已存在 overlay ref、可选 GrantConsumption 与其 hashes。数据库 commit 前，write set 与 marker 对任何 select/list/resolve/show 读路径均不可见；commit 后同时可见。崩溃前只会留下不可见写集；崩溃于 commit 后但响应前时，重试从 unique Decision/marker 返回同一结果。恢复只承认 committed marker 的完整 linkage；不完整写集仅用于诊断，所有运行读取 fail closed。

### 4.2 #10 overlay 准入、identity 与 evaluation-reserved 可见性

模型 generation run 必须输出恰好一个严格 envelope，其 payload 字段是完整 #10 overlay JSON 文本。admission 必须以**原始 JSON bytes**而非已 materialize object 将其交给 #10 parser 和 overlay validator；多候选、空候选、非 JSON、未知 envelope 字段、非 overlay 闭集、base mismatch、hash mismatch，或携带 baseline/policy/suite/holdout/代码/binding/Catalog 正文，均为 `REFINEMENT_CANDIDATE_INVALID`，不写 Candidate、overlay、visibility record 或 JobResult。

候选 payload 必须逐项满足 #10 §4.1/§4.2，特别是：

1. payload 恰为 `HarnessOverlay`：`schemaVersion: 'helix.harness-overlay/v1'`、完整 `baseBaselineRef`、非空 `changes`；每个 object 均 closed，`baseBaselineRef.kind` 恰为 `baseline`，且它不得指向 overlay。
2. `changes` 只能含 `systemInstructionTemplate`、`taskNarrativeTemplate`、`protocolRules`、`stopConditions`、`catalogCards`；数组整体替换，无 delete、通用 patch、第二层 overlay 或未列字段。合并和 Catalog/agent spec closure 必须按 #10 §4.2 在 admission 与 resolve 都验证。
3. parser 必须在**任何 object materialization、schema validation 或 canonicalization 之前**拒绝任意层 duplicate key；不得使用会 first-wins 或 last-wins 吞并键的 `JSON.parse` 类路径。
4. canonical bytes 必为无 BOM UTF-8；object key 按 UTF-16 code unit 升序，数组保留声明顺序，无无意义 whitespace。Unicode scalar 直接 UTF-8 编码，非 ASCII 不得 `\uXXXX` 转义，U+2028/U+2029 直接编码；`/` 必为直接 `0x2f`，仅 `"`、`\\` 和规定 control escapes 可转义，孤立 surrogate 拒绝。
5. 数值仅允许 non-negative safe integer；从 JSON 文本输入时，每个 token 必须是其最短十进制形式，拒绝 `01`、`1.0`、`1e0`、`-0`、负数、浮点、指数、NaN、Infinity 和非安全整数。完整 nested ref 的 `revision` 也受此规则。
6. `payloadHash = sha256(#10 canonical UTF-8 bytes({schemaVersion,baseBaselineRef,changes}))`。它必须精确等于 `baseBaselineRef` 所指 baseline 基础上发布出的 `HarnessStateRef(kind='overlay',...).contentHash`；不得以 refinement artifact hash、resolved `harnessContentHash`、codeProtocolPin 或裸 hash 替代。

admission 的同一 serializable RCS transaction 执行：(a) 精确读取并核对 `baseBaselineRef`；(b) 按上列 #10 规则 parse、validate、canonicalize 和验证 base/Catalog closure；(c) 用**原封不动的 #10 canonical overlay payload bytes**创建 durable #10 `HarnessStateRef(kind='overlay')`；(d) 写 CandidateV1、Candidate↔overlay immutable provenance link 和 evaluation-reserved visibility record；(e) 写唯一 GenerationJobResult。若同一 `baseBaselineRef + payloadHash` 的 ordinary overlay 已存在，使用其精确 ref，仅在该 transaction 新建本 Candidate 的永久 link；绝不改写该 overlay。任一写失败整体回滚。

`CandidateV1` 至少含 `jobRef`、`generationRunRef`、`baseBaselineRef`、`policyRef`、`overlayRef`、`payloadHash`、model pins、预算 reservation/settlement、trace/evidence refs；`overlayRef.kind='overlay'`、`overlayRef.contentHash=payloadHash`、`overlayRef` 的 stored bytes 为该 candidate 的 exact canonical #10 overlay payload。Candidate 不含 inline overlay copy；payload 的唯一 durable authority 是 RCS/#10 Store 中该 ordinary overlay。

evaluation-reserved 是 #10 之外的 RCS **admission/visibility** 规则，而非 #10 schema 扩展：

- 常规 list/default/current/latest projection 和普通 Host selection 不返回或接受该 ref；#10 本身不引入 alias、default、current 或 latest。
- 已认证 evaluator route 只在 Candidate、base、overlay hash、Policy 和 Suite linkage 全部一致时，允许以未改写的 #10 `select({baselineRef,overlayRef}, availableCatalogRefs)` 提交这对完整 ordinary refs；随后 #10 的 validate/resolve/freeze 完全照旧。
- candidate arm 的 Context、evidence、`RunPins.harnessState` 和 replay record 使用普通 #10 `HarnessPinsV1`：其中 `baselineRef`、`overlayRef`、`harnessContentHash`、schema、Catalog refs、compatibility decision 都是 #10 原有字段和值；没有 Candidate ref、evaluation kind、special selection 或 inline payload。
- 普通 external Host route 的新 run selection 必须被 RCS admission gate 拒绝，直到已关联 approved promotion commit。已冻结 evaluation record 的 replay 则直接按其 recorded ordinary #10 refs/hash 使用现有 #10 read/resolve/replay；CLI 停用、Candidate reject 或后续 policy 停用都不删除、重指向或重新解释 Store payload，故 replay 不漂移。
- promotion 不转换、不复制、不重新 canonicalize或重新 publish 内容。它只在同一 RCS transaction 写 approved Decision、Association、可见性状态变更和 PromotionCommit，使**同一 exact overlayRef**对之后经批准的 external run route 可选择。

这是在 #10 Store 的 selection admission 与外部可见性层增加规则，不改变 #10 `HarnessStateRef`、overlay、selection、freeze 或 replay schema。跨设计兼容测试必须证明该分层：#10 `select → validate → resolve → freeze`、ordinary `HarnessPinsV1` record 和 recorded-pin replay 都无需识别 refinement 专有 ref kind；普通 route 不能选择 reserved overlay，evaluator route 能选择，approved 后未来 approved external route 能选择，旧 evaluation replay 始终按 #10 行为成功或 fail closed。

### 4.3 Refinement artifact canonicalization、Policy、Suite 与 HRCA

`RefinementArtifactCanonicalV1` 只用于 Policy、Suite、Proposal、Job/Event/Result、Candidate（不含 overlay payload）、Report、Request、Decision、Association、commit/receipt/grant records。每种 artifact 先按自己的 closed schema 验证，再按该 artifact 的 versioned canonical encoding 算其 `contentHash`；它不定义、代理、放宽或覆盖 #10 parser/canonicalizer。所有 artifact ref 仍必须完整 `{kind,id,revision,contentHash}`，拒绝 latest、alias、路径、裸 hash 及 identity 对应不同 canonical payload。

Suite 仅拥有 case 顺序、caseId、immutable input refs、per-case seed、固定 fork parent。Policy 仅拥有 generation 限制、完整 `executionSpec`、outcome extractor、aggregation、gates 和 authority；它不复制 case/input/seed。受认证的 Harness Refinement Configuration Authority（HRCA）是 Policy/Suite 唯一发布路径：它经 mTLS 或部署 IdP OIDC admin audience 接受 `harness-refinement.config.publish`，验证输入 schema 与 publisher signature，并使用 deployment-anchored `RefinementTrustBundleV1` 发布不可变 refs。skill、模型和普通 refinement assertion 没有该 scope。

Trust bundle 管理 publisher keys、actor assertion issuers、auto-grant issuers、各 key 有效窗口和 revocation generation。轮换先发布包含新旧 key 的 bundle，再切换签发，最终撤销旧 key。HRCA 发布前拒绝 malformed configuration：quality range 为有限 `min < max`；权重正且有限、总和正且有限；case 非空且 caseId 唯一、seed 是 non-negative canonical safe integer；cost/latency 上限有限且非负；terminalFailure 为固定 boolean；threshold/timeout/budget 合法有限。只有运行时缺 metric/outcome、unknown failure、预算溢出或 replay 非 pass 产生 `indeterminate`。

aggregation 固定为加权 normalized quality、总 cost、nearest-rank P95 与 failureRate。Candidate 仅在两侧完整、replay pass、quality delta、cost/latency ratio 与 absolute 上限、failure delta 全部满足时 `passed`；baseline cost/latency 为零时 candidate 必须也为零。

### 4.4 Candidate generation、两 arm 评估与 Report

`propose` 只接受 source recorded run refs、baseline、Policy、允许 generation profile 与 `proposalId`；不接收 overlay 文本、文件、prompt 覆写、Suite/holdout、API key 或 Provider endpoint。Host 将 Policy 允许的 evidence projection、baseline ref 和 generation instruction identity 交给 fixed/pinned model；模型请求、预算、lifecycle、Trace、lineage、outcome 均经 milkie IOPort，CLI 不直连 Provider。

`--proposal-id` 创建唯一 Proposal/Job；同 ID 重试不启动第二模型 run，显式新 ID 才能重新采样。Candidate admission 以 `jobRef` 与 `generationRunRef` 双重唯一索引执行。GenerationJobResult 出现后只读 `show generation-job` 才公开 `candidateRef`。

每个 Suite case 创建 baseline/candidate 两个 isolated milkie runs。baseline arm 按普通 #10 `{baselineRef}` 选择；candidate arm 在 evaluator route 上按同一个 baselineRef 和 Candidate 的 ordinary overlayRef 执行现有 #10 selection。两 arm 不得复用 run。只有 arm harness pins 可不同：candidate 的 `overlayRef` 与由相应 resolved document 得出的 `harnessContentHash` 可不同；其余 `SharedExecutionPinsV1` 必须逐字段相同并与 Policy/Suite 匹配：case identity/input/seed/fork parent、runner/binding/code protocol/model/provider/IOPort/environment pins、timeout、预算 reservation spec、extractor digest、resolver version。任何 shared-pin/hash/linkage 不符均 fail closed；不完整运行时数据才是 indeterminate。

Report 是 immutable artifact，持有 case 对应 baseline/candidate run/outcome refs、两侧普通 #10 arm pins、完全相同的 shared pins、raw outcome-derived metrics、replay refs 和确定性 verdict。EvaluationJob 以 candidate/base/policy/suite 四元组及 evaluation input digest 作为唯一 idempotency key；同理只有一个 Result。`show evaluation-job` 严格只读，terminal success 或 indeterminate 才含 `reportRef`。

### 4.5 Request、assertion、current revocation 与人工 promotion

`request` 只对 `passed` Report 创建不可变 Request；`reportRef` 唯一，重试返回同一 ref；RCS 中 `decisionByRequest(requestRef)` 唯一，竞争决策只允许一个 Decision。

Actor assertion 通过受限 FD/secret store 输入，含 subject、issuer、keyId、audience、operation、issuedAt、expiresAt、nonce、signature。对每个副作用命令，RCS 在同一 serializable transaction 以 `{issuer,keyId,nonce}` 创建 receipt，记录 operation fingerprint、idempotency key、initial ACK/response 与 expiry；同 fingerprint/key 的 retry 回原响应，不产生新工作，不同用途拒绝。propose/evaluate/request/manual approve/manual reject 均把 assertion receipt 与对应 state change 原子写入；commit 前不可见，commit 后 retry 可恢复。

manual approve 在同一 RCS transaction 中先从**当前** trust bundle/revocation generation 重验 Report 所绑定 Policy/Suite publisher signature、key membership、有效期和撤销状态，再验证 Report/Request/Candidate/base/Policy/Suite/linkage、gate 与 actor scope，最后写 approved Decision、Association、reserved overlay external-selectable visibility 和 PromotionCommit。配置不可信返回 `REFINEMENT_CONFIGURATION_UNTRUSTED`，不写 Decision/Association/visibility/marker/receipt。配置撤销后，只有独立可信 human 的 `refine.manual.reject-after-revocation` 才可写 rejected Decision；它不触碰 overlay、Association、marker 或 grant。

同 base/payload hash 的不同 Candidate 可链接同一个 exact overlayRef，但每个 approved Decision 有一个 Association；rejected Decision 没有 Association。任何 validation、visibility、association、decision、receipt 或 marker 写失败都使 transaction 回滚，不存在可见孤儿 overlay、已消费 request/grant 或 partial decision。

### 4.6 Sealed auto grant：claims、验证顺序与一次性消费

`--grant <sealed-ref>` 引用不可变密封授权，不把明文 secret、私钥或 grant payload 回显给模型。解封后的 `AutoPromotionGrantV1` 必须为签名覆盖的 closed claims；签名覆盖整个 canonical claim payload，至少包含：

```ts
type AutoPromotionGrantV1 = {
  schemaVersion: 'helix.refinement-auto-grant/v1'
  operation: 'refine.promote.auto'
  requestRef: RefinementRef
  requestContentHash: string
  reportRef: RefinementRef
  reportContentHash: string
  candidateRef: RefinementRef
  candidateContentHash: string
  baseBaselineRef: HarnessStateRef
  baseBaselineContentHash: string
  policyRef: RefinementRef
  policyContentHash: string
  suiteRef: RefinementRef
  suiteContentHash: string
  payloadHash: string
  subject: string
  audience: string
  issuer: string
  keyId: string
  issuedAt: string
  notBefore: string
  expiresAt: string
  nonce: string
  trustBundleGeneration: string
  signature: string
}
```

所有 `*Ref` 均是完整 closed ref object；每个显式 `*ContentHash` 必须精确等于对应 ref 的 `contentHash`，`payloadHash` 必须精确等于 Candidate `payloadHash`、Candidate overlayRef `contentHash` 和该 stored #10 overlay canonical payload 的 SHA-256。`subject` 是唯一获授权的外部 CI/scheduler identity，`audience` 是本部署的 auto-promotion audience，operation 不能泛化为其他 refinement 操作。时间为可比较、带时区的 UTC instant，且 `issuedAt ≤ notBefore ≤ expiresAt`；nonce 非空、issuer/keyId 必须可由当前 bundle 唯一定位。grant 不含可变 status、别名、通配 ref/hash、模型身份或可由调用者选择的 scope。

auto approve 的**一个** RCS serializable transaction 必须按以下顺序，并且在第 1–4 步失败时不消费 grant nonce、不写 receipt、Decision、Association、visibility 或 marker：

1. 从当前 deployment trust bundle 与 current revocation generation 找到 issuer/keyId，验证 bundle generation、key membership、key validity、撤销状态以及 grant signature；
2. 验证 closed schema、operation、external subject、部署 audience、`issuedAt/notBefore/expiresAt` 与当前可信时间；
3. 精确读取 Request 和其 Report/Candidate/base/Policy/Suite 链，逐项核对全部 ref、全部显式 content hash、payloadHash、Candidate↔overlay link、overlay stored hash 与 base binding；
4. 用当前可信 Policy/Suite publisher 状态重验配置签名、撤销和所有 deterministic gate/report verdict；
5. 仅在上述验证完成后，以 `{issuer,keyId,nonce}` 原子插入唯一 `GrantConsumptionV1`，并写 auto operation assertion receipt、approved Decision、Association、overlay external-selectable visibility 和 PromotionCommit。

同一 valid grant 的相同 idempotency retry 返回首次 canonical response；不同 fingerprint 或并发第二次消费返回 replay error。无效 scope、时间、audience、签名、撤销、identity、gate 或任何 link 的调用均零 effect。发生 crash 时，transaction commit 前零 effect；commit 后由 unique nonce/Decision/marker 恢复同一响应，绝不双重 publication。

---

## 5. 设计思路与折衷

- CLI 集中状态转换、验证和审计；skill 只是受限语言接口，避免第二状态机。
- RCS 同时实现 refinement control、#10 overlay persistence 与 visibility admission，避免跨库原子性和补偿逻辑。
- Candidate 只来自模型 generation run；直接输入会失去 pin、预算、Trace 与来源证明。
- Candidate arm 使用真正的普通 #10 overlay，而非临时 payload 或新 selection kind；RCS visibility 层保证未 promotion 的内容不泄露给普通 future run。
- Policy 锁定执行/指标，Suite 锁定数据集，避免 holdout 替换与权威重复。
- Request 永久 immutable、Decision 唯一终态；append-only Job Event/Result 与 immutable ACK 保证异步重试可审计。
- auto 只信任外部 CI/scheduler；sealed grant 对请求链和 payload 精确绑定，先验证后消费。
- 默认 `show` 脱敏，full read 受 artifact-read gate，避免 evidence、holdout 或凭证泄露。

---

## 6. 架构设计

```text
model-facing skill / researcher                   trusted external CI/scheduler
     │ propose/evaluate/request                             │ sealed grant + auto
     ▼                                                       ▼
┌────────────────────────── Helix refinement CLI ──────────────────────────┐
│ immutable ACK · refs/gates · receipt · terminal Decision                 │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ generation/evaluation jobs    │ one RCS transaction
                ▼                               ▼
┌──────────────────────┐     ┌────────────────────────────────────────────┐
│ Helix Host → milkie  │     │ RCS = #10 HarnessStateStore                 │
│ IOPort/lifecycle/    │     │ ordinary overlay + reserved visibility +    │
│ Trace/outcome/replay │     │ policy/suite/jobs/candidate/report/decision │
└──────────────────────┘     └────────────────────────────────────────────┘
```

CLI 只编排；generation 与两 arm evaluation 都是 milkie 可观察 runs。RCS 是唯一 publication durability boundary。skill 不直连 Store、Provider 或 Kernel，Kernel 不增加 refinement binding。Candidate arm 经 authenticated evaluator route 获得 RCS admission 后，仍只调用 #10 原有 Store selection/resolution。

---

## 7. 模块设计

| 模块 | 职责 | 非职责 |
|---|---|---|
| RCS artifact/receipt Store | immutable artifacts、#10 overlay persistence、reserved/public visibility、nonce receipt、commit visibility | 跨库协调、默认 alias |
| #10 overlay admission adapter | 原始 JSON 的 #10 parse/validate/canonical/hash、base/Catalog closure、Candidate↔overlay link | 通用 JSON 宽松规范化、inline candidate state |
| Policy/Suite + HRCA | 配置/信任发布与 current revocation 验证、确定性 gate | LLM 评价、holdout 改写 |
| evaluator admission | evaluator identity 与 reserved overlay linkage 校验，调用原有 #10 selection | 新 ref kind、新 pins/selection schema、Provider 直连 |
| authority/grant verifier | assertion/grant 签名、claims、time、audience、nonce receipt/consumption | 凭证签发、模型授权 |
| promotion coordinator | immutable Decision、Association、同 ref visibility transition、marker | alias/baseline 改写、内容转换或重发布 |
| CLI / skill projection / docs | JSON 输出、受限模型 workflow、README fixture | public SDK、Kernel API |

依赖固定为 CLI/Host → refinement modules → RCS/#10 Store 与 milkie；具体 scenario 仅为 Suite executor，不反向定义 refinement schema。

---

## 8. API / CLI 设计

公共 npm API 和 Kernel API：**N/A**。成功机器输出为稳定 JSON。

| 命令 | 成功输出 |
|---|---|
| `helix refine propose --proposal-id <id> ... --json` | immutable ACK `{proposalRef,generationJobRef}` |
| `helix refine evaluate --candidate <ref> ... --json` | immutable ACK `{evaluationJobRef}` |
| `helix refine show generation-job <ref> --json` | 严格只读投影；terminal-success 才含 `candidateRef` |
| `helix refine show evaluation-job <ref> --json` | 严格只读投影；terminal-success/indeterminate 才含 `reportRef` |
| `helix refine request --report <ref> --json` | `{requestRef,terminal:false}` |
| `helix refine promote --request <ref> --manual --idempotency-key <id> --json` | Decision、已存在 overlay、Association refs |
| `helix refine reject --request <ref> --manual ... --json` | rejected Decision ref |
| `helix refine promote --request <ref> --auto --grant <sealed-ref> ... --json` | Decision、已存在 overlay、Association refs |
| `helix refinement-admin publish-policy\|publish-suite ...` | HRCA 签名的 immutable ref |

`show` 不得写 receipt、Job、Event、Result、artifact 或 run。summary 默认不返回 overlay payload、holdout/input refs、source evidence/Trace/outcome refs、assertion/grant/nonce 或 secret；full view 另受 artifact-read gate。结构化错误至少包括 `REFINEMENT_CANDIDATE_INVALID`、`REFINEMENT_ASSERTION_REPLAYED`、`REFINEMENT_CONFIGURATION_UNTRUSTED`、`REFINEMENT_GRANT_INVALID`、`REFINEMENT_GRANT_REPLAYED` 与 `REFINEMENT_PUBLICATION_ATOMIC_FAILED`。

---

## 9. 边界考虑

- Candidate 来源仅为单一 recorded milkie generation output；人工、CI、文件或 stdin payload import fail closed。
- Candidate payload 的唯一 hash/canonical authority 是 #10 overlay contract；RefinementArtifactCanonicalV1 不得用于该 payload 或任何 `HarnessStateRef.contentHash`。
- Policy/Suite immutable；skill 无写入路径；actor assertion/grant 不进入 artifact public projection、Trace 或模型上下文。
- RCS reserved visibility 是 access/admission 规则，不是 #10 载荷、ref、selection、pins 或 replay 语义；不得以它逃逸 #10 normal validation。
- Provider 只经 IOPort；replay 零 live fallback；source run 只读，evaluation 有独立 lineage。
- shared execution pins 完全相同，arm harness pins 是唯一允许差异。
- assertion receipt、grant nonce、decisionByRequest 均有 durable unique key；并发只允许一个状态转换。
- revoked configuration 的 approval fail closed；安全 reject 不得发布 overlay 或改变其 visibility。
- promotion 的 Decision/Association/visibility/marker/grant consumption/receipt 同事务；失败零可见 partial state。
- evaluation 成本固定为 Suite 的两 arm，不隐式 retry 或扩展采样。

---

## 10. 迁移 / 兼容 / 回滚

#13 不迁移或更改 #10 schema。RCS 在 #10 Store 外围增加 reserved-overlay admission/visibility policy：ordinary refs、existing explicit selection、freeze、`HarnessPinsV1` 与历史 replay 完全保持 #10 形状。Candidate admission 已保存为 ordinary immutable overlay，因此 evaluation CLI 禁用、Candidate reject、Policy 停用或 refinement CLI 回滚后，已录制 candidate-arm replay 都继续用 recorded ordinary `{baselineRef,overlayRef}` 和 #10 resolver 复原；不会查询当前可见性、default/current/latest 或新 candidate。

回滚只停止新 configuration、CLI、evaluator admission 或 future external selection；不得删除、修改、重指向 reserved overlay、Candidate↔overlay provenance link、已关联 overlay 或任何历史 run。未批准 ref 仍拒绝普通 future Host selection；已批准 ref 只对之后经批准 external route 的显式选择可见。promotion 绝不复制、转码、重新 hash 或重发布 overlay，因此既有 candidate arm 与未来 promoted run 引用的内容身份完全相同。

兼容性设计记录：这一 visibility rule 是 RCS/Host 的 refinement admission 层，位于 #10 closed schema 之外；它不能被实现为 #10 `HarnessStateRef` 或 `select` 参数扩展。若任何 #10 implementation 无法将 Store selection admission 与原有 select/resolve 解耦，则该 deployment 不得启用 #13，直至以单独的 #10 设计变更完成兼容审阅；不得私下放宽 validator 或产生 special ref。

---

## 11. 测试计划

| Story | E2E / Integration | Unit |
|---|---|---|
| S1 | 同 proposalId 的 initial ACK 在完成前/后/重启逐字节相同；`show generation-job` restart 后公开 candidate 并链到 evaluate；多 envelope/文件输入无 Candidate。 | Proposal/Job/run/Candidate 唯一性、assertion nonce/fingerprint/idempotency、Candidate↔ordinary overlay link。 |
| S2 | evaluator route 用 ordinary `{baselineRef,overlayRef}` 完成 #10 select→validate→resolve→freeze，记录普通 `HarnessPinsV1`；CLI disable/reject 后按 recorded pins replay；ordinary route 不得选择 reserved overlay，promotion 后 approved external route 可选择同 ref。 | arm/shared pin 比较、ownership、metrics/P95/zero ratio/indeterminate、RCS visibility admission。 |
| S3 | manual/auto、并发、每 transaction write point crash 均无 partial overlay；撤销 Policy/Suite publisher key 的 pending request approve 零 effect，可信 human safe reject 只写 reject。 | immutable Request/unique Decision、receipt 并发/重启、marker、current revocation。 |
| S4 | HRCA fixture→README manual smoke→new explicit select→old replay；skill allowlist。 | `show` 脱敏/full gate、skill 无 promote/admin/assertion/grant capability。 |

关键 #10 compatibility / canonicalization cases：

- 用与 #10 独立的两个 #10-compatible parser/canonicalizer 对同一**overlay**原始 bytes 交叉验证；样本覆盖 `é`、CJK、U+2028、U+2029、引号、反斜杠、solidus `/`、U+0000..U+001F、UTF-16 code-unit key order、nested `baseBaselineRef`、`0`、最大 safe integer 与所有可达 numeric field。断言 canonical bytes 和 SHA-256 与 #10 完全相同，`/` 为直接 `0x2f`。
- 以 raw JSON bytes 在 materialization 前分别注入顶层 overlay、nested `baseBaselineRef` 和 `changes` duplicate keys；两 parser 都必须拒绝，且不写 Candidate/overlay/link。含孤立 surrogate、`01`、`1.0`、`1e0`、`-0`、负数、float、指数或超 safe integer 的 numeric token 同样拒绝。
- 以非 ASCII key 使 Unicode code-point 顺序与 UTF-16 code-unit 顺序不同的 fixture 验证排序；再证明 refinement artifact canonicalizer 的输出不能被接受为 #10 overlay bytes，除非经完整 #10 parse/validation/canonicalization 后逐字节相等。
- 对 admission payload，断言 `Candidate.payloadHash == overlayRef.contentHash == sha256(#10 canonical overlay payload)`；在 evaluator freeze、Report linkage、promotion 和 future external selection/replay 逐处重算并核对。任一不符零 run/零 effect。
- 对 reserved overlay，验证普通 #10 ref schema/selection/pins/replay 无特殊字段；普通 Host selection 被 RCS gate 拒绝，authenticated evaluator admission 后原 #10 flow 可运行，approved 后 future allowed external route 可运行，旧 evaluation replay 不依赖 CLI 或当前 visibility。

sealed auto grant cases：错误 operation/scope、任一 request/report/candidate/base/policy/suite ref 或 hash、payloadHash、subject、issuer/key、bundle generation、签名、not-before、expiry、audience、撤销配置或 gate 均必须在 nonce consumption、receipt、Decision、Association、visibility 与 marker 前拒绝，断言全部零 effect；两个并发同 nonce 的有效 auto call 只能一个 commit，另一个 replay，且不会双重 publication；commit 前 crash 零 effect，commit 后 retry 返回同一 canonical response。

Unit 无网络/真实 Provider；Integration 使用 transaction-capable RCS 与 milkie adapter；E2E 使用 CLI JSON、deterministic model/Suite/HRCA fixture 与 #10 replay。README smoke 是可执行 fixture consumer。

---

## 12. 开放问题 / 决策记录

| 决策 | 结论 |
|---|---|
| durable topology | RCS 是唯一 transaction control Store，并实现 #10 overlay persistence 与 refinement visibility。 |
| #10 compatibility | Candidate 是普通 #10 `kind='overlay'`；不增加 HarnessStateRef kind、selection union、pins 或 resolver。reserved 是 RCS admission/visibility policy。 |
| candidate identity | `payloadHash` 只等于 #10 canonical overlay SHA-256，且等于 ordinary overlay ref `contentHash`；Candidate 无 inline payload。 |
| canonicalization | #10 overlay 独用 #10 parser/canonical bytes；refinement artifacts 独用有名、受限的 artifact canonicalization，二者不得互换。 |
| async contract | ACK immutable；Job/Event/Result append-only；job show 只读链式取得 Candidate/Report。 |
| request terminality | Request immutable；唯一 Decision 定义终态。 |
| pins | 两 arm 均为 ordinary #10 `HarnessPinsV1`；只有 arm harness pins 可异，shared execution pins 全等。 |
| config trust | HRCA + deployment trust bundle；approve 时按 current revocation 重验。 |
| assertion replay | RCS private nonce receipt 原子绑定状态变化。 |
| auto | 仅可信 external CI/scheduler；sealed grant 精确绑定 request 链、payload、subject/audience、time、issuer/key/bundle generation，先验证后单次消费。 |
| duplicate payload | overlay 按 base/hash 可去重；每个 Candidate 有永久 provenance link，每个 approved Decision 有独立 Association。 |
| N/A | public SDK、Kernel binding、hot swap、baseline rewrite、service queue、inline import、skill/model auto promotion、重做 milkie。 |

无待实现阶段决定的开放问题。任何无法以现有 #10 Store 保持此普通 overlay/ordinary selection 分层的环境必须禁用 #13，而不是扩展 #10 schema。

---

## 13. 关联

- Issue #13：需求 S1–S4 与 approved L1。
- Issue #10：immutable state、完整 closed `HarnessStateRef`、overlay canonicalization、Store、ordinary selection、freeze、`HarnessPinsV1`、explicit selection/replay；本文不修改其 schema。
- Issue #11：Catalog 独立；refinement 不扩展 card 或 runtime effect/budget/replay 契约。
- Issue #1/#3/#5/#7：Host/Kernel、IOPort、Trace、Replay、child lineage 权威。
- `docs/overview.md`：continual harness 只观察跨 run 改进，I/O 经同一 IOPort。
- `README.md`、`docs/refinement.md`、`skills/helix-harness-refinement/SKILL.md`：用户与模型操作面。
