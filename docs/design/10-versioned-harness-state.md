# 【harness】可版本 HarnessDocument 与不可变 run 状态

- Issue: #10
- 状态: Approved
- 最后更新: 2026-08-11
- 交付面: Host control-plane 内部契约、通用 harness core、scenario adapter 组合与 run record/replay；不提升公共 npm Runtime API，不新增 Kernel binding。
- 前置: `docs/overview.md` 序列 3；Issue #5 的 run / Trace / Replay 基线；Issue #7 的 child lineage；Issue #11 的 runtime capability catalog。

---

## 1. 背景

当前 RLM 循环、模型可见策略文本、工具叙事与终止判断集中在既有 scenario harness 中。已有 `codeProtocolPin`（包括历史发行 pin）选择的是可执行 runner / binding 协议，不能指认一份可替换、可审计、可重放的策略状态。

本设计将当前 run 的控制策略抽为通用 `HarnessDocument`：它由不可变 baseline 与至多一份不可变 overlay 在 **run boundary** 解析。解析结果拥有独立于代码发行 pin 的内容身份，并随 Context、pins 与 evidence 记录。具体 scenario 只在 Host 组合处提供任务、环境、执行适配、验证与度量。

这样，变更控制策略不再等同于编辑源码常量或 fork scenario；历史 run 也无需以当前默认值猜测当时策略。该状态只服务本次 run 的 RLM harness；跨 run 的自动生成、评估及晋升不属于本 Issue。

---

## 2. 名词解释

| 词 | 定义 |
|---|---|
| **HarnessDocument** | 通用、可版本的控制策略文档。其规范载荷见 §4.1；不含 scenario 任务、环境实现或 Catalog 卡正文。 |
| **baseline** | 独立发布的完整 `HarnessDocument`，是一次选择的必需基础。 |
| **overlay** | 独立发布、声明 `baseBaselineRef` 的稀疏变更集。每次选择至多有一份 overlay；其可写字段闭集及合并规则见 §4.2。 |
| **resolved document** | 对 baseline 应用合规 overlay 后得到的完整 `HarnessDocument`。只有它进入控制面渲染和 `harnessContentHash` 计算。 |
| **HarnessStateRef** | Store 返回的不可变寻址输入。其唯一合法的闭集 schema、类型和 canonical 规则见 §4.1；`kind` 只能是 `baseline` 或 `overlay`。 |
| **规范载荷** | 为身份计算而 canonicalize 的完整 baseline 文档，或 overlay 的完整 `{ schemaVersion, baseBaselineRef, changes }`；其中 `baseBaselineRef` 是完整规范 ref object。引用之外的 Store 元数据不属于载荷。 |
| **harnessContentHash** | `sha256(canonical UTF-8 bytes(resolved document))` 的 `[0-9a-f]{64}` 摘要；它是本次实际策略的内容身份，不等同于状态 ref 或 `codeProtocolPin`。 |
| **HarnessStateStore** | Host control-plane 持有的 baseline/overlay 不可变发布与读取权威。它不是源码常量、临时 fixture、Kernel 名称空间或 public runtime surface。 |
| **selection** | 仅由 `{ baselineRef, overlayRef? }` 构成的已发布状态选择。它不接受内联文档、裸文本、`latest`、源码路径或单独的 code/protocol pin。 |
| **freeze** | 在 run 启动前完成选择、校验、解析并固定 resolved document；当前 run 与其 child run 只能观察该快照。 |
| **ExampleScenarioAdapter** | 由 Host 组合的 scenario 抽象，提供本次任务/环境载荷、执行适配、结果验证及度量；不拥有 Store、状态身份、pins、evidence 或 replay 规则。 |
| **CatalogCardRef** | #11 的独立 runtime card 引用，严格为 `{ id, version }`。卡的 effect、budget、replay 契约和模型可见正文仍由 #11 定义。 |
| **availableCatalogRefs** | Host 在每个 run 的 bootstrap 中、任何 select/validate/resolve 之前形成的不可变、去重 `CatalogCardRef[]`。其元素严格是 `{ id, version }`；形成机制不属于 #10。它不是 `HarnessDocument` 字段、Store 发布条件或 #11 card 语义。 |
| **codeProtocolPin** | runner / binding 的代码和协议兼容选择。它不是 harness 状态身份，也不能替代 baseline 或 overlay ref。 |
| **LegacySelectionRegistry** | Host 的全局、唯一、append-only 历史 pin 注册表。它是旧格式 artifact 的唯一 selection authority；manifest 只是从 registry 导出的不可变 provenance view。 |

---

## 3. 设计目标与非目标

### 3.1 目标

1. 定义完整、领域无关的 `HarnessDocument`、baseline、overlay、canonical identity 与闭集覆盖规则。
2. 定义 `HarnessStateStore` 的不可变发布、读取、选择、解析与回读语义；这些是 Host control-plane 内部操作。
3. 将 run 生命周期锁定为 `select → validate → resolve → freeze`，并将冻结选择、resolved hash、Catalog refs 与兼容结论写入 Context、`RunPins.harnessState`（`HarnessPinsV1`）、evidence 和 replay record；历史字段 `RunPins.harness` 仅保留 code/protocol 兼容 pin（`factorio-rlm/v4|v5`）。每次选择只能使用该 run 已固定 `availableCatalogRefs` 内的精确 card ref。
4. 保持通用 core 与 scenario 的单向关系：core 只面对 `ExampleScenarioAdapter` 抽象；具体 scenario 只作为 Host 组合 consumer。
5. 为新格式与旧格式 artifact 定义 fail-closed 的 replay 选择、迁移和错误语义。

### 3.2 非目标

- continual、refiner、自动 delta、自动评估、自动晋升或自动回退。
- public npm Runtime API、稳定 SDK、CLI 状态管理命令，或 `helix.harness` Kernel binding / cell effect。
- 运行中的 baseline 或 overlay 热切换；同一 run 内以单次消息、session projection、checkpoint、mailbox 或 handle 改写 harness 状态。
- Catalog 卡正文、卡的 runtime effect/budget/replay 细节，或 scenario env 卡标准；这些分别仍由 #11 与 scenario 负责。
- 特定领域的 Bridge、worker、任务、verifier、pin 命名或迁移 schema 进入 core。
- 对 Issue #7 `agents.spawn(instructions, input?, max_output_tokens?, mailbox?)` 签名及其 child lineage 语义作任何变更。

### 3.3 S1–S4 交付对应

| Story | 本 L2 的锁定交付 | 主要验收节 |
|---|---|---|
| **S1** | 通用 core、Host 组合与 `ExampleScenarioAdapter` 的单向依赖；core 不依赖具体 scenario。 | §6、§7、§11.1 |
| **S2** | baseline/overlay 选择、resolved identity、run-boundary freeze、Context/pins/evidence 回读与 replay 重建。 | §4–§6、§10、§11.2 |
| **S3** | Store 的非源码不可变发布、封闭 overlay、渲染和 fail-closed 校验。 | §4、§8、§9、§11.3 |
| **S4** | 新旧 pins 的区分、全局 legacy registry、manifest provenance view、迁移/replay gate 与 scenario E2E 回归。 | §10、§11.4 |

---

## 4. 能力与功能设计

### 4.1 `HarnessDocument`、完整 ref schema 与 canonical identity

baseline 的存储值必须是下列完整文档；每个 object（包括嵌套 object）均为闭集，除列出的字段外一律拒绝。所有文本字段使用非空 UTF-8 字符串；文本逐字保留，因其模型可见语义可能不同。列表顺序也是语义的一部分：渲染顺序不重排。

```ts
type CatalogCardRef = {
  id: string
  version: string
}

type HarnessStateRef = {
  kind: 'baseline' | 'overlay'
  id: string
  revision: number
  contentHash: string
}

type AgentSpec = {
  id: string
  defaultInstruction: string
  catalogCards: CatalogCardRef[]
  budget: {
    maxCalls?: number
    maxOutputTokens?: number
  }
}

type HarnessDocument = {
  schemaVersion: 'helix.harness/v1'
  control: {
    systemInstructionTemplate: string
    taskNarrativeTemplate: string
    protocolRules: string[]
    termination: {
      successSource: 'scenario-verifier'
      stopConditions: string[]
    }
  }
  catalogCards: CatalogCardRef[]
  compatibility: {
    codeProtocolPins: string[]
  }
  agentSpecs?: AgentSpec[]
}
```

`HarnessStateRef` 必须**恰有**四个字段：`kind` 为上述两个字面值之一，`id` 为非空字符串，`revision` 为非负安全整数，`contentHash` 必须匹配 `[0-9a-f]{64}`，即 64 位小写十六进制 SHA-256 摘要；未知、缺失、`null`、非整数、负数或额外字段一律拒绝。此 schema 在 selection、record、pins、evidence 与 overlay 的规范载荷中完全相同；不得以只含 id、hash 或 pin 的简写替代。

规范化与校验规则：

1. canonical JSON 是唯一的字节编码，输入必须先通过上述闭集 schema。任何接收 JSON 文本的入口（包括 baseline/overlay 发布、selection/read 的 ref、record、pins、evidence 与 replay 输入）都必须使用能在**任意 object materialization 前**报告重复键的 parser；顶层、任意嵌套 `HarnessStateRef` 与 overlay `changes` 等任意 object 层出现重复键均立即拒绝。不得先以 `JSON.parse` 或任何 first-wins/last-wins object materialization 吞并键后，再做 schema validation 或 canonicalization。输出必须是**无 BOM 的 UTF-8 bytes**；键按 UTF-16 code unit 的逐单位升序排序，array 保持声明序，分隔符外不得输出 whitespace。
2. 字符串不得含孤立 surrogate；每个允许的 Unicode scalar value 必须直接编码为 UTF-8，非 ASCII 字符**不得**使用 `\uXXXX` 转义，U+2028 与 U+2029 也直接编码为 UTF-8。solidus U+002F 必须直接输出单个 ASCII `/`（`0x2f`），**不得**输出 `\/`。仅 `"` 输出为 `\"`、`\` 输出为 `\\`；U+0008、U+0009、U+000A、U+000C、U+000D 分别固定输出 `\b`、`\t`、`\n`、`\f`、`\r`；其余 U+0000..U+001F 固定输出六字节、小写十六进制的 `\u00xx`。除此以外不得转义任何字符。
3. 数值只允许非负 safe integer，且每一个数值字段（包括 `revision` 与全部 budget）都进入相应 payload/hash。canonicalizer 必须输出 JSON 十进制最短词法：`0` 为 `0`，正数无符号、前导零、小数点或指数。若输入来自 JSON 文本，校验必须在解析边界拒绝非此词法的数值 token（包括 `01`、`1.0`、`1e0` 和 `-0`），不得先丢失其词法再规范化。
4. 若 schema 允许 literal，`null`、`true`、`false` 必须分别固定为这些 ASCII bytes；当前 v1 闭集 schema 不允许它们作为字段值。字段存在性、闭集与类型规则仍逐项适用，不因 canonicalization 而补齐缺失字段或忽略额外字段。
5. `schemaVersion` 必须恰为 `helix.harness/v1`。`control`、`catalogCards`、`compatibility` 必须存在；`protocolRules`、`stopConditions`、`codeProtocolPins` 可为空数组，但字段不可省略。
6. `CatalogCardRef` 只能有 `id` 与 `version` 两字段，二者均为非空字符串；同一列表内 `(id, version)` 不得重复。`catalogCards` 中每一项都必须经 #11 registry 精确解析，禁止自动选取新版本。对某次 run，baseline、overlay 的 `changes.catalogCards`（若存在）与 resolved document 中的每一项还必须是该 run 已固定 `availableCatalogRefs` 的精确 `{id, version}` 子集；id 相同而 version 不同不匹配。缺失、不精确或额外 ref 一律以 `HARNESS_CATALOG_NOT_AVAILABLE` fail-closed。
7. `compatibility.codeProtocolPins` 逐项为非空、互异字符串；resolved 文档只在其中包含本 run 的 `codeProtocolPin` 时可用。
8. `agentSpecs` 缺省等于无 spec；若存在，`id` 必须唯一，`defaultInstruction` 非空，`catalogCards` 必须为 document `catalogCards` 的无重复子集，且 `budget` 必须恰有可选的 `maxCalls`、`maxOutputTokens` 两字段；出现的每一个 budget 值均为非负安全整数。它不产生新 card、binding、effect 或执行入口。
9. baseline `contentHash = sha256(canonical UTF-8 bytes(HarnessDocument))`。overlay `contentHash = sha256(canonical UTF-8 bytes({ schemaVersion, baseBaselineRef, changes }))`；`baseBaselineRef` 按本节完整 closed ref schema 写入规范载荷。
10. resolved document 以 §4.2 合并后再 canonicalize；`harnessContentHash = sha256(canonical UTF-8 bytes(resolved document))`。所有进入 baseline、overlay 或 resolved document 的字段（包括 budget 数值）都参与相应 canonical payload 和 hash。相同 canonical payload 必得相同 hash；内容身份以 SHA-256 的工程碰撞抗性为操作前提，而不是宣称该摘要在数学上对不同载荷单射。
11. `HarnessStateRef.contentHash` 必须等于 Store 中相应发布规范载荷的 hash。ref 是可寻址输入，`contentHash` 是完整性检查；二者都不能由 `codeProtocolPin` 代替。不同 ref 即使载荷相同也可共存，但必须具有相同相应内容 hash。

实现必须以至少两个独立 canonicalizer 对相同 payload/hash 互测：样本至少包括 `é`、CJK、U+2028、U+2029、引号、反斜杠、solidus `/`、U+0000..U+001F 的每一种字符、UTF-16 key 排序、嵌套 ref、`0`、最大允许 safe integer 与两种 budget 字段，断言 canonical bytes 与 hash 跨实现相同，并逐字节断言 solidus 为直接 ASCII `/` 而非 `\/`。孤立 surrogate、非安全整数、非规范数值 token，以及缺失/额外/错误类型 ref 字段均必须拒绝。

`agentSpecs` 是一等的声明、渲染与 identity 内容：渲染时可把其 default instruction、允许的 card 引用和 budget 形状作为控制面说明；它参与 baseline 和 resolved hash。它**不**新增 `spawn(specId)`，不拦截或改写既有 `agents.spawn(instructions, ...)`，也不将一次 `instructions` 回写 Store。
### 4.2 overlay 闭集、合并与 Catalog closure

overlay 的存储值为：

```ts
type HarnessOverlay = {
  schemaVersion: 'helix.harness-overlay/v1'
  baseBaselineRef: HarnessStateRef
  changes: {
    systemInstructionTemplate?: string
    taskNarrativeTemplate?: string
    protocolRules?: string[]
    stopConditions?: string[]
    catalogCards?: CatalogCardRef[]
  }
}
```

`HarnessOverlay`、`changes` 及其所有嵌套 object 同样是闭集；`baseBaselineRef` 必须使用 §4.1 的完整 `HarnessStateRef` schema，且 `kind` 必须为 `baseline`。overlay 不可指向 overlay。`schemaVersion`、`compatibility`、`termination.successSource`、`agentSpecs` 与任何未列字段均不可覆盖。单个 overlay 不得携带代码、Kernel effect/binding、Catalog 正文或额外 spec。

| 可覆盖字段 | 合并 | 删除 | 冲突 / 非法形状 |
|---|---|---|---|
| `systemInstructionTemplate` | 以 overlay 的完整非空字符串替换 baseline 值。 | 不支持；`null`、缺省外的删除标记均拒绝。 | 非字符串、空字符串或同一输入出现重复路径 → `HARNESS_OVERLAY_INVALID`。 |
| `taskNarrativeTemplate` | 同上，完整替换。 | 同上。 | 同上。 |
| `protocolRules` | 以 overlay 的完整有序字符串数组替换，不作 append、去重或逐项 patch。 | 不支持；空数组是合法的显式替换。 | 非数组、非字符串项或重复路径 → `HARNESS_OVERLAY_INVALID`。 |
| `stopConditions` | 以 overlay 的完整有序字符串数组替换，不改变 `successSource`。 | 不支持；空数组是合法的显式替换。 | 非数组、非字符串项或试图覆盖 `termination` 整体 → `HARNESS_OVERLAY_INVALID`。 |
| `catalogCards` | 以 overlay 的完整有序 `{id, version}[]` 替换；每项必须经 #11 精确解析，且**合并后的**每个固定 `agentSpecs[].catalogCards` 仍是该替换结果的无重复子集。 | 不支持；空数组是合法的显式替换，但若任一固定 spec 需要 card 则不满足 closure。 | 额外字段、重复 `(id, version)`、未知卡 → `HARNESS_CATALOG_UNRESOLVED`；任一 spec 引用在 resolved catalog 缺失 → `HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED`。 |

`changes` 必须至少含一个允许字段。缺省字段保留 baseline 值；不会产生第二层 overlay，也不存在覆盖先后顺序。一个输入表示同一路径两次、以对象 patch 间接改写未列字段、或以删除语义绕过上表，均为冲突并 fail-closed。overlay 在发布和 resolve 两次都必须验证其 `baseBaselineRef` 与所选 baseline 精确相等，并在两次都验证合并后 Catalog closure：baseline spec 需要 `{A,1}` 时，把 catalog 从 `{A,1}` 替换为仅 `{B,1}` 或 `[]` 必须以**唯一**错误 `HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED` 拒绝。`publishOverlay` 不创建 ref，`resolve` 不返回 partial document/ref 或可运行 run。
### 4.3 `HarnessStateStore`：不可变发布与读取

`HarnessStateStore` 是 Host control-plane 的内部持久状态面，最小语义如下：

| 操作 | 输入 | 成功结果 | 不变量 |
|---|---|---|---|
| `publishBaseline` | 完整 `HarnessDocument` | 新 `HarnessStateRef(kind='baseline')` | 先做 schema、canonicalization、Catalog 精确解析及文档兼容形状校验；这是结构自检，不使用某次 run 的 `availableCatalogRefs`；写入后任何既有 ref 不可原地修改。 |
| `publishOverlay` | 完整 `HarnessOverlay` | 新 `HarnessStateRef(kind='overlay')` | 基线 ref 必须已存在且 hash 一致；按 §4.2 校验，并先合并验证固定 agent spec 的 Catalog closure；这是结构自检，不使用某次 run 的 `availableCatalogRefs`；失败不产生 ref。 |
| `read` | 完整 `HarnessStateRef` | 原始不可变载荷及其 ref | §4.1 closed ref schema 的 `kind/id/revision/contentHash` 必须逐项匹配 Store；不得按 id 选择别的 revision。 |
| `select` | `{ baselineRef, overlayRef? }` 加本 run 已固定 `availableCatalogRefs` | 待解析的 selection | 只接受完整已发布 ref；读取 baseline 的 `catalogCards` 与可选 overlay 的 `changes.catalogCards` 后，逐项验证它们是 `availableCatalogRefs` 的精确子集；不接受 inline、`latest`、裸 prompt、源码位置、孤立 hash 或 code/protocol pin。 |
| `resolve` | selection、`codeProtocolPin` 加同一不可变 `availableCatalogRefs` | 完整 resolved document、`harnessContentHash`、精确 Catalog refs、compatibility decision | 验证 baseline、可选 overlay、Catalog、合并后 agent spec Catalog closure、文档 schema、hash 与 code/protocol compatibility；再次验证 resolved `catalogCards` 是 `availableCatalogRefs` 的精确子集；任一失败不返回 partial resolved document 或 run，且不修改 Store。 |

发布在所有校验成功后才原子可读；失败不留下半成品 ref。相同 `id + revision` 不可覆盖；重复 revision、引用 hash 不符、载荷 hash 不符、未知 ref、未知 CardRef 或不兼容文档均显式失败。Store 不维护“当前”“默认”或“最新”状态，因此没有任何隐含 selection。

### 4.4 run-boundary select → validate → resolve → freeze

Host 必须在任何 select、validate、resolve、模型请求、Kernel 启动或 scenario effect 之前，从既有 run bootstrap、`codeProtocolPin` 与 binding projection 形成该 run 唯一的 immutable `availableCatalogRefs`。它是 run-boundary property，一经形成不可替换、扩展或由文档反向改写，并且其形成机制不属于 #10。

随后 Host 按以下固定顺序执行：

1. **select**：取得 run 请求内的 `{ baselineRef, overlayRef? }` 与独立 `codeProtocolPin`，精确读取已发布 baseline/overlay；在此检查各自的 `catalogCards`（overlay 仅在其 `changes` 提供时）都属于 `availableCatalogRefs`。
2. **validate**：核对 §4.1 closed ref schema、ref hash、baseline/overlay kind、overlay 的基线绑定、文档/overlay schema、闭集字段、Catalog refs、合并后 agent spec Catalog closure 与 code/protocol compatibility，并重新执行已加载 baseline/overlay 的 `availableCatalogRefs` membership 检查。
3. **resolve**：以 §4.2 规则形成完整 resolved document，再次验证每个固定 `agentSpecs[].catalogCards` 都是 resolved `catalogCards[]` 子集，解析每个引用，并验证 resolved 的每个 `catalogCards` ref 都是同一 `availableCatalogRefs` 的精确子集；然后计算 `harnessContentHash` 与 compatibility decision。
4. **freeze**：将 selection、resolved 文档、resolved hash、Catalog refs 和 compatibility decision 固定到 run bootstrap；其后不得重新读取“当前”状态、替换 `availableCatalogRefs` 或把任意消息内容合并回文档。

任一步失败都以 `HARNESS_CATALOG_NOT_AVAILABLE`（对 available 集外、缺失或版本不精确的 card）或相应既有错误在模型、Kernel、scenario execution 或外部 effect 之前终止启动，且不产生 run、部分 pins、evidence 或 capability projection。没有默认 baseline、源码 prompt、`latest` 或近似文档回退路径。

child run 不重复选择：它继承 parent 已冻结的完整 harness slice（selection、resolved hash、schema version、Catalog refs 与 compatibility decision）。child 的 record 必须与 parent slice 逐项相等；不同 selection 或不同 resolved hash 为 `HARNESS_CHILD_SELECTION_DRIFT`。Issue #7 的 session、checkpoint、mailbox、handle 与单次 spawn instructions 仍是各自的局部/会话事实，均不能更改该 slice；它们至多影响下一次独立 run 所提交的已发布 selection。

### 4.5 控制面渲染

freeze 后，Host 按固定顺序构造模型可见控制面：

1. resolved `control.systemInstructionTemplate`；
2. resolved `control.taskNarrativeTemplate`、`protocolRules` 与 `termination`；
3. 已解析 `catalogCards[]` 所对应的 #11 card `doc`；
4. resolved `agentSpecs` 的声明性渲染；
5. `ExampleScenarioAdapter` 提供的本次任务/环境载荷；
6. run Context 的动态观察、预算和既有 Trace 反馈。

第 1–4 项来自冻结 harness；第 5 项来自 scenario；第 6 项来自当前 run。Catalog 正文不复制进 `HarnessDocument`，scenario 载荷不写回 `HarnessDocument`，动态观察也不参与 `harnessContentHash`。渲染必须保留 document 和 card 的声明顺序。`HarnessDocument.catalogCards` 只能从 freeze 前已固定的 `availableCatalogRefs` 选择；它不能创建或扩展 runtime binding、capability token、effect class、budget 或该 available 集。#11 仍唯一拥有 card effect、budget 与 replay 语义。

### 4.6 UI / UX：N/A

本 Issue 没有 GUI 或独立交互界面。可观测输出仅是既有 Context、pins、evidence 与 replay 记录；原因是状态仅在 Host control-plane 内部被发布和选择。

---

## 5. 设计思路与折衷

1. **不可变发布，而非可变全局配置**：一次已录制 run 必须能精确复原选择；可变默认值会令同一 record 在不同时间得到不同策略。
2. **baseline + 单 overlay，而非 overlay 链**：单层使覆盖来源、删除语义和 resolved hash 可判定；需要另一变化时发布新的 baseline 或新的 overlay。
3. **resolved hash，而非代码发行 pin**：代码/协议兼容与策略内容独立演进；用同一字段承担两种身份会使 replay 无法区分 runner 变化和策略变化。
4. **完整替换，而非通用 JSON patch**：限定五个字段、对数组整体替换，可避免隐蔽删除和多层冲突，且与模型可见顺序一致。
5. **Catalog 引用，而非内联手册**：卡的 effect、budget、replay 与文档 SSOT 由 #11 维护；harness 只决定本 run 引用哪些精确版本。
6. **Host 组合 scenario，而非 core 认识领域**：通用状态可被多个 scenario 复用；具体场景仍可保持任务与度量内聚。
7. **全局 legacy registry，而非按 manifest 选择**：历史兼容以 recorded code/protocol pin 和全局唯一注册的精确历史 payload 为依据；manifest 只导出 provenance，不能令任一 scenario 或 manifest 定义/重指向 core 的 replay 选择。

---

## 6. 架构设计

```text
                 HarnessStateStore
          publish / read immutable revisions
                         |
                         v
run request -> Host control-plane: select -> validate -> resolve -> freeze
                         |                         |
                         |                         +--> Context / RunPins / evidence
                         v
          generic harness core ----> ExampleScenarioAdapter (abstraction)
                         |                         ^
                         |                         |
                         +---- rendered control ---+---- scenario implementation
                         |
                    milkie run / Trace / Replay
```

依赖和所有权锁定：

- generic harness core 可依赖 Helix/milkie 的通用抽象及 `ExampleScenarioAdapter` 抽象；不得 import 任一具体 scenario 的 Bridge、worker、task、verifier、pin 名称或 legacy schema。
- `ExampleScenarioAdapter` 实现依赖 core 的 document/renderer 输入形状，而非反向定义它；adapter 不能写 Store、改 selection、计算 harness identity、拼装 pins/evidence 或决定 replay。
- Host 是唯一组合根：它持有 Store，在 select 前形成不可变 `availableCatalogRefs`，执行 run-boundary 固定流程、将 frozen harness 与一个 adapter 实例接合，并将已解析卡交给 renderer。
- milkie 继续是 lifecycle、Trace、Replay、lineage 和 task outcome 的权威。harness 不复制这些记录模型。
- 任何具体 scenario（当前可用的 Factorio 亦然）只可作为 adapter E2E scenario 或 legacy fixture；它不拥有 core schema、public surface 或 manifest 格式。

---

## 7. 模块设计

下表是逻辑边界，不规定文件布局或实现步骤。

| 逻辑单元 | 职责 | 明确不负责 |
|---|---|---|
| Document validator / canonicalizer | 校验 §4.1 文档，形成 baseline 内容 hash。 | Store 持久化、scenario 载荷、Catalog 正文。 |
| Overlay validator / resolver | 校验 §4.2 overlay、精确基线绑定，产生 resolved 文档及 hash。 | 多层 patch、隐含删除、运行中改写。 |
| HarnessStateStore | 原子发布与精确 ref 读取。 | 默认选择、动态配置、模型可见 Kernel surface。 |
| Host state loader | 在 select 前形成 immutable `availableCatalogRefs`，执行 §4.4 的 select/validate/resolve/freeze，并构造 frozen slice。 | 通过当前源码或默认值补齐缺失状态，或由 HarnessDocument 创建/扩展 binding、capability token、effect class、budget 或 available 集。 |
| Control renderer | 以 §4.5 固定顺序组合 resolved document、Card docs 与 adapter 载荷。 | 改写 harness、复制 Card doc 为第二真相。 |
| Run-record bridge | 在 Context、pins、evidence 与 replay record 写入/核对 harness slice。 | 改变 milkie Trace / lineage 基础语义。 |
| Legacy selection resolver | 依据 §10 的全局 `LegacySelectionRegistry` 为旧 artifact 定位精确 legacy baseline。 | 猜测历史 payload、由 manifest 选择或重指向历史映射。 |
| ExampleScenarioAdapter | 提供任务/环境载荷、执行适配、验证和度量。 | Store、state ref、hash、pins、evidence、manifest、replay 选择。 |

---

## 8. API / CLI 设计

### 8.1 Host control-plane 内部操作

以下名称描述内部语义，不是 npm export、SDK、HTTP 或 Kernel API：

publishBaseline(document: HarnessDocument): HarnessStateRef
publishOverlay(overlay: HarnessOverlay): HarnessStateRef
read(ref: HarnessStateRef): StoredHarnessState
select(
  input: { baselineRef: HarnessStateRef; overlayRef?: HarnessStateRef },
  availableCatalogRefs: CatalogCardRef[],
): HarnessSelection
resolve(
  selection: HarnessSelection,
  codeProtocolPin: string,
  availableCatalogRefs: CatalogCardRef[],
): ResolvedHarness
registerLegacySelection(entry: LegacySelectionRegistryEntry): LegacySelectionRegistryEntry
resolveLegacySelection(codeProtocolPin: string): LegacySelectionRegistryEntry

`ResolvedHarness` 至少包含完整 `document`、`selection`、`harnessContentHash`、`schemaVersion`、已解析 `catalogCards` 和 `compatibilityDecision`。`freeze` 是 run bootstrap 的状态转移，不是可在 run 中再次调用的接口。

### 8.2 Public Runtime API：N/A

不新增 public npm Runtime API 或稳定 SDK。原因是 Store 和选择只属于 Host control-plane 内部运行组装；开放 surface 会超出 #10 的分层交付。

### 8.3 Kernel binding / cell effect：N/A

不新增 `helix.harness`，也不新增相关 cell effect。原因是发布、选择、校验、解析和 freeze 必须在 Kernel 之外、模型请求之前完成。

### 8.4 CLI：N/A

不新增 CLI 命令。原因是本 L2 锁定的是 state 语义与记录格式，不为具体运维入口另立产品 surface。

---

## 9. 边界考虑

| 边界 | 锁定结论 |
|---|---|
| Harness identity vs `codeProtocolPin` | baseline/overlay refs 与 `harnessContentHash` 标识策略状态；`codeProtocolPin` 只标识代码/协议兼容。三者不得互换。 |
| Harness vs available Catalog 集 | Host 在 select 前固定 `availableCatalogRefs`；baseline、overlay 与 resolved document 只能精确选择其内 ref。文档不能创建或扩展该集、runtime binding、capability token、effect class 或 budget。 |
| Harness vs Catalog | `catalogCards[]` 每项只有 `{id, version}`；Card 的 runtime effect、budget、replay 与 `doc` 继续归 #11。Harness 不内联、复制或改写 Card 正文。 |
| Harness vs scenario | core 只通过 adapter abstraction 接触场景；场景不定义 Document、Store、selection、pins、evidence、replay 或 manifest。 |
| Harness vs #7 session | session projection、checkpoint、mailbox、handle、child local input 与 harness state 分离。它们不能修改已 freeze 的 run；child 继承 frozen slice。 |
| Harness vs单次模型消息 | 单次 system/user/tool 内容、执行结果和 `agents.spawn` instructions 是 Trace 局部事实；不得隐式发布、覆盖或成为 overlay。 |
| Harness vs Kernel | Kernel 只继续承载既有 bindings；没有 harness discovery、写入或热切换路径。 |
| Harness vs milkie | milkie 保留 Trace、Replay、lineage、lifecycle 和 task outcome 权威；harness 仅补充可核验 state slice。 |
| Harness vs continual | 本 Issue 不生成候选、比较任务表现或自动改变未来 state。未来工作只能以已录制的 harness slice 为输入，不能反向修改历史 run。 |

所有跨边界缺失、未知、hash 不符、schema 不符、Card 不可解析、基线绑定不符或兼容不成立的状态都 fail-closed。不存在“尽量运行”的降级路径。

---

## 10. 迁移 / 兼容 / replay

### 10.1 新格式记录

新 run 必须同时记录两类 pin 字段，且不得混用：

- `RunPins.harness`（历史字段名）：**仅** code/protocol 兼容 pin（如 `factorio-rlm/v4` \| `factorio-rlm/v5`），用于 runner/binding issuance，**不是** harness 内容身份。
- `RunPins.harnessState`：冻结的 harness 内容身份 slice，类型为 `HarnessPinsV1`。

Context、`RunPins.harnessState` 与 evidence 都必须写入同一组 `HarnessPinsV1` 值：

```ts
type HarnessPinsV1 = {
  format: 'harness/v1'
  codeProtocolPin: string
  baselineRef: HarnessStateRef
  overlayRef?: HarnessStateRef
  harnessContentHash: string
  schemaVersion: 'helix.harness/v1'
  catalogCards: Array<{ id: string; version: string }>
  compatibilityDecision: {
    documentAcceptsCodeProtocolPin: true
    catalogResolved: true
  }
}
```

Context 在 `runtime.harness` 回读该完整对象；evidence 在 `harness` 回读相同字段，并额外记录 `selectionSource: 'recorded'`。三个位置的同名字段必须逐项相等。`harnessContentHash` 必须由 Store 读出的精确载荷重新计算；不得相信外部传入摘要。`RunPins.harness` 必须与 `HarnessPinsV1.codeProtocolPin` 一致，但不得单独充当 state selection。

新格式 replay 只读取 artifact 中的 `HarnessPinsV1`（位于 `RunPins.harnessState` / evidence `harness`）作为 selection：Host 先从 replay run bootstrap、recorded `codeProtocolPin` 与 binding set 形成 immutable `availableCatalogRefs`，再按 refs 从 **已 hydrate 的 durable Store** 读取、核对每个 ref hash、重新 resolve，并同时比对 recorded `harnessContentHash`、schema、Catalog refs 和 compatibility decision。它不得查询 `LegacySelectionRegistry`、任何 manifest、当前默认或 `latest`；也不得在 replay 路径发布、比较或选择当前源码默认 baseline / legacy fixture。每次 resolve 都执行该 available 集 membership 检查，失败不产生 run 或 live effect。

### 10.2 全局 `LegacySelectionRegistry` 与 manifest provenance view

旧 artifact 未保存 baseline/overlay ref、只保存历史 `codeProtocolPin` 时，Host 只能查询一个全局、唯一、append-only 的 `LegacySelectionRegistry`。它不是按 artifact、scenario、版本或 manifest 分片的表；每个已注册 entry 不可变，一个 pin 的第一次成功注册永久确定其唯一 selection。

```ts
type LegacySelectionRegistryIdentity = {
  id: 'helix.harness-legacy-selection-registry'
  schemaVersion: 'v1'
}

type LegacySelectionRegistryEntry = {
  registryIdentity: LegacySelectionRegistryIdentity
  codeProtocolPin: string
  baselineRef: HarnessStateRef
  baselineContentHash: string
  schemaVersion: 'helix.harness/v1'
}

type LegacySelectionRegistry = {
  registryIdentity: LegacySelectionRegistryIdentity
  entries: LegacySelectionRegistryEntry[]
}

type LegacySelectionManifest = {
  manifestVersion: 'helix.harness-legacy-selection/v1'
  registryIdentity: LegacySelectionRegistryIdentity
  exportedEntries: LegacySelectionRegistryEntry[]
}
```

registry 的 key 是全局 `codeProtocolPin`；entry 不含 overlay，且每个 entry 的 `registryIdentity`、`baselineContentHash` 必须分别精确等于全局 registry identity、`baselineRef.contentHash`。`registerLegacySelection` 只在迁移时运行，先精确读取并核对 baseline ref/hash/schema，然后原子追加一个新 pin。pin 已存在时不得产生第二条 entry：完全相同的重提只回传既有 entry 而不写入，不同的 baseline ref、`baselineContentHash` 或 schemaVersion 必须以 `HARNESS_NONDETERMINISTIC_SELECTION` 拒绝。导出 manifest 是不可变 provenance view，可跨版本生成多个 view，但不是 selection authority：它不得新增、覆盖、重指向或覆盖 registry entry，resolver 绝不选择“manifest latest/version”或某个 manifest entry。

旧 artifact replay 仅以 artifact 记录的 pin 精确查询 registry 的全局唯一 entry；Host 先从 replay run bootstrap、recorded `codeProtocolPin` 与 binding projection 形成 immutable `availableCatalogRefs`，再从 Store 精确读取 entry baseline，核对完整 ref、baseline hash 与 schema，以空 overlay resolve 并执行该 available 集 membership 检查。evidence 写入 `selectionSource: 'legacy-registry'` 及 `registryIdentity`；如需附带某份 manifest，只能作为 provenance，不能影响选择。它不会读取当前源码策略、当前默认 baseline、`latest` 或 manifest 版本；失败不产生 run 或 live effect。

迁移是数据导入：对每个历史 code/protocol pin 取得精确历史策略 payload，按 §4.1 规范化、发布为 immutable legacy baseline，并向全局 registry 注册带 hash/schema/identity 的 entry。若 payload 不可取得、同一 pin 对应不同选择、文档无效或所需 Catalog version 不存在，迁移停止并报告错误；不得产出近似 baseline。历史 artifact 和已导出 manifest 均不改写。任何领域历史材料最多是 legacy fixture，不改变 registry 形状。
### 10.3 允许性与错误码

旧格式 replay 先适用表中 legacy 专用行：`HARNESS_LEGACY_SELECTION_UNAVAILABLE` **只**表示缺 registry entry、entry baseline 缺失或 entry hash/schema 不匹配；不要将这些情况降级为一般 `HARNESS_REF_INVALID`。

| 情形 | 结果 |
|---|---|
| 新 run：baseline ref 存在且完整；可选 overlay 精确绑定该 baseline；文档接受 code/protocol pin；全部 CardRef 可解析且精确属于该 run 的 `availableCatalogRefs`。 | 允许，freeze `HarnessPinsV1`。 |
| 新 run：无 overlay，baseline 与 pin 兼容。 | 允许；空 overlay 是明确选择。 |
| 新格式 replay：recorded refs/hash/schema/Cards/compatibility 全部一致。 | 允许；仅按 recorded selection reconstruct，live effect 为零。 |
| 旧 replay：recorded pin 有全局唯一 registry entry，Store baseline hash 与 entry 一致。 | 允许；标记 `legacy-registry`，并记录 `registryIdentity`。 |
| 缺 baseline ref，或以 pin 充当新格式状态选择。 | `HARNESS_SELECTION_REQUIRED`。 |
| `latest`、内联文档、裸文本、源码路径、孤立 hash，或试图让 legacy replay 在 registry entry 外另行选择 baseline/overlay。 | `HARNESS_NONDETERMINISTIC_SELECTION`。 |
| 任一接收 JSON 文本的入口在 object materialization 前遇到 JSON 语法错误、非规范数值 token 或任意层重复键。 | `HARNESS_JSON_INVALID`。 |
| ref 不存在，或完整 ref 的字段/类型/闭集不合法，或 ref 与 Store 载荷 hash 不一致。 | `HARNESS_REF_INVALID`。 |
| overlay 基线与 selection baseline 不同。 | `HARNESS_OVERLAY_BASE_MISMATCH`。 |
| overlay 未列字段、删除语义、重复路径或非法值。 | `HARNESS_OVERLAY_INVALID`。 |
| CardRef 缺失、未知、重复或无法精确解析。 | `HARNESS_CATALOG_UNRESOLVED`。 |
| 已发布 baseline、overlay 或 resolved document 含 `availableCatalogRefs` 外的 CardRef，或 id 相同但 version 不同。 | `HARNESS_CATALOG_NOT_AVAILABLE`。 |
| overlay 替换后的 Catalog 不再包含任一固定 `agentSpecs[].catalogCards` 引用。 | `HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED`。 |
| document schema 不支持、或 compatibility 不接受 code/protocol pin。 | `HARNESS_PROTOCOL_INCOMPATIBLE`。 |
| child record 的 harness slice 与 parent frozen slice 不同。 | `HARNESS_CHILD_SELECTION_DRIFT`。 |
| 旧 pin 在全局 registry 中无 entry、entry baseline 丢失，或 entry 的 baseline hash/schema 不一致。 | `HARNESS_LEGACY_SELECTION_UNAVAILABLE`。 |
| 试图以不同 baseline ref/content hash/schema 重注册既有历史 pin，或以 manifest 重指向该 pin 的 registry selection。 | `HARNESS_NONDETERMINISTIC_SELECTION`。 |

---

## 11. 测试计划

### 11.1 S1 — 通用 core 与 scenario adapter 边界

- 对 core 依赖做静态/契约检查：不得出现具体 scenario 的 Bridge、worker、task、verifier、pin 或 legacy schema import；允许的 scenario 接点仅为 `ExampleScenarioAdapter` abstraction。
- 用一个最小 adapter fixture 与 Host 完成组装，断言任务/环境载荷只在 renderer 的 scenario 段出现，Document、Store、pins、evidence 和 replay 仍由 core/Host 产生。
- 使用当前可用的 Factorio adapter 做一条 E2E scenario 回归，保持既有 P1 task outcome 语义。该测试只证明 adapter 组合；不把 Factorio 字段、pin 或 manifest 写入 core 契约。

### 11.2 S2 — 稳定加载、freeze 与回读

- 预置合规 baseline V1，连续选择 V1 加空 overlay 启动 Run A1 与 Run A2。断言两个 run 的 `harnessContentHash`、baseline ref、缺省 overlay、schema、Catalog refs 和 compatibility decision 一致。
- 每个 run 同时从 Host control-plane 读取 Store 原载荷/ref，从 Context、`RunPins.harnessState`（`HarnessPinsV1`）与 evidence 读取同一 harness slice；逐项相等，并断言控制面渲染来自 V1。历史字段 `RunPins.harness` 仅校验为匹配的 code/protocol pin。
- 在 Run A1 内派生 child run，断言 child slice 与 parent 冻结 slice 相同；尝试改变 child selection 必须得到 `HARNESS_CHILD_SELECTION_DRIFT`。
- 分别 replay A1 与 A2，断言只消费各自 recorded refs/hash，resolved identity 一致，live effect 为零，且不查询当前默认或 `latest`。

### 11.3 S3 — 连续 V1 / V2 / V3 发布、选择、运行与历史 replay

此测试从唯一的 V1 baseline 开始；整个序列只经 Host control-plane 连续发布，期间不编辑源码 prompt、runner 源码或测试 fixture。

1. 发布并选择 **V1 baseline**，启动 **Run A**；读回 Store、Context、pins、evidence 与渲染控制面。
2. 仅改变允许字段 `taskNarrativeTemplate`，发布新的 **V2 baseline**，选择 V2 并启动 **Run B**；断言 V2 的 baseline ref 与 resolved hash 不同于 V1，且模型可见控制面仅出现该策略变更。
3. 基于 V2 发布只替换 `protocolRules` 的 **V3 overlay**，选择 `{ V2 baseline, V3 overlay }` 并启动 **Run C**；断言 V3 overlay ref、V3 resolved hash、渲染规则及三处记录均与 A/B 可区分。
4. 对 A、B、C 分别 replay：A 精确恢复 V1；B 精确恢复 V2；C 精确恢复 V2+V3。每次都读取 control-plane 的精确 ref/载荷并核对 Context、pins、evidence 与 resolved hash，且 live effect 为零。测试中后续发布任何新 revision 不得影响已有三次 replay。
5. 使用两套独立 canonicalizer 对同一 payload 计算，样本必须同时含 `é`、CJK、U+2028、U+2029、引号、反斜杠、solidus `/`、U+0000..U+001F 的每一种字符、刻意乱序的 UTF-16 key、`0`、最大允许安全整数、`maxCalls`、`maxOutputTokens` 和嵌套 `baseBaselineRef`；断言两者产出逐字节相等的无 BOM UTF-8 canonical bytes 与相同 `[0-9a-f]{64}` hash，并逐字节断言该 `/` 是直接 ASCII `0x2f`、绝不为 `\/`；该字符必须参与上述 canonical bytes 与 sha256 比对。分别改变 budget 数值和 agent spec 其余字段，断言它们进入 resolved identity 与渲染，但既有 `agents.spawn(instructions, ...)` 输入/输出形状和局部 Trace 内容不变。
6. 分别覆盖非法 schema、未知 ref、ref hash 不符、缺失/额外/错误类型 ref 字段、孤立 surrogate、非安全整数、负数或浮点 budget、非规范数值 token（`01`、`1.0`、`1e0`、`-0`）、未知 CardRef、overlay 基线失配、未列字段、重复覆盖、删除语义、空 `changes`、不兼容 pin 和 `latest`。另以原始 JSON bytes（而非已 materialize object）提供三组 duplicate-key fixture：顶层 `HarnessDocument` 重复 `schemaVersion`、嵌套 overlay `baseBaselineRef` 重复 `id`、以及 overlay `changes` 重复 `protocolRules`。每组 fixture 均必须交给两套独立 parser；二者都必须在任何 object materialization、schema validation 或 canonicalization 前以 `HARNESS_JSON_INVALID` 拒绝，且断言未调用 `JSON.parse` 或任何 first-wins/last-wins 路径。其余各项必须返回 §10.3 对应 `HARNESS_*` 错误；所有拒绝均不产生 ref、run 或任何 partial Store ref/document、pins、evidence、canonical artifact。
7. 令 V2 baseline 的固定 agent spec 引用 `{A,1}`：发布将 catalog 从 `{A,1}` 替换成仅 `{B,1}` 的 overlay，以及替换为 `[]` 的 overlay，均必须在 `publishOverlay` 以唯一 `HARNESS_AGENT_SPEC_CATALOG_UNRESOLVED` 拒绝且不生成 ref；构造等价已发布输入到 `resolve` 也必须得到同一错误且不返回 partial ref/document/run。保留 `{A,1}` 的替换则允许。
8. 三条 integration cases 固定某次 run 的 `availableCatalogRefs` 为 `{A,1}`，并使 #11 registry 同时存在 `{A,1}`、`{A,2}`、`{B,1}`：含额外 `{B,1}` 的 baseline 必须可通过 Store 结构发布、却在该 run 的 `select` 以 `HARNESS_CATALOG_NOT_AVAILABLE` 拒绝；以可用集合外 `{B,1}` 替换的 overlay 也必须在 `select` 拒绝；baseline 的 card 引用 `{A,2}` 而 available 集只有 `{A,1}` 必须以同一错误拒绝。三例均在 `resolve` 再次覆盖，且任何拒绝都不得产生 run、部分 pins、evidence、capability projection、模型请求、Kernel 启动或 effect。

该序列明确不包含自动产生 V2/V3、自动评估或自动改变未来 selection。

### 11.4 S4 — 新旧格式 replay 与 scenario 回归

- 为两个通用历史 `codeProtocolPin` 导入各自精确策略 payload，发布 immutable legacy baseline，并向同一个全局 `LegacySelectionRegistry` 各注册一次。对两个旧 artifact 分别 replay，断言只选中 registry 中各自 entry、hash/schema 一致、空 overlay、evidence 标记 `legacy-registry` 与 `registryIdentity`，且零 live effect。
- 对新格式 A/B/C artifact，断言不查询 registry 或 manifest，只使用各自 recorded refs/hash；对旧格式 artifact，断言不能追加 overlay，且不选择任何 manifest 的 latest/version 或 entry。
- 从同一 registry 导出两个不同版本 manifest provenance view：在第二个 view 试图将已注册 pin 写成不同 baseline、或尝试以不同 baseline/hash/schema 重注册该 pin，均必须以**恰为** `HARNESS_NONDETERMINISTIC_SELECTION` 拒绝；registry entry、既有 view 和历史 replay 均保持不变。
- 覆盖 registry 缺 entry、Store baseline 丢失、entry hash 不符与 schema 不符；这些且仅这些不可用情形必须以 `HARNESS_LEGACY_SELECTION_UNAVAILABLE` 拒绝，且不得退回当前源码、默认策略或 manifest 选择。
- 将 §11.1 的 Factorio E2E scenario 置于既有回归集合，确认默认 P1 通过新 Host 组合获得一个显式 Store baseline ref；它不是 generic core 的默认场景或特殊迁移规则。

---

## 12. 开放问题 / 决策记录 / N/A

### 12.1 已关闭决策

| 决策 | 结论 |
|---|---|
| 状态单位 | baseline + 至多一份明确绑定的 overlay；不使用可变全局值或 overlay 链。 |
| 内容身份 | 仅 resolved `HarnessDocument` 的 canonical hash；不以 `codeProtocolPin` 充当状态身份。 |
| 覆盖范围 | §4.2 五字段闭集，整体替换，无删除与通用 patch。 |
| `agentSpecs` | 仅声明、渲染、identity；不改变 spawn API 或把局部文本持久化。 |
| Catalog | 只保存 `{id, version}`；effect、budget、replay 与正文归 #11。 |
| available Catalog 集 | Host 在 select 前固定 `availableCatalogRefs`；每个 baseline、overlay 与 resolved `catalogCards` ref 必须是其精确 `{id, version}` 子集，失败即关闭启动。该集合与 card effect、budget、replay 语义保持分离。 |
| scenario | `ExampleScenarioAdapter` 是 Host 组合 consumer；具体 scenario 仅作 E2E/legacy fixture。 |
| 运行时机 | 仅 run boundary `select → validate → resolve → freeze`；child 继承固定 slice。 |
| 历史 replay | 新格式以 recorded refs/hash 为准；旧格式只按全局 append-only `LegacySelectionRegistry` 的唯一 entry，manifest 仅为 provenance view。 |

### 12.2 不适用项

- **自动策略生产、质量比较、晋升与回退：N/A。** 原因：它们属于 overview 序列 4–5，而本 Issue 只建立可选择、可记录的状态基础。
- **公共 Runtime API / SDK：N/A。** 原因：状态操作只属于 Host control-plane 内部契约。
- **Kernel harness binding 或 cell effect：N/A。** 原因：状态必须在模型与 Kernel 之前 freeze，不能在 cell 中改变。
- **CLI 与 GUI：N/A。** 原因：本 Issue 的可观测面是既有 Context、pins、evidence 和 replay record。
- **特定领域 schema、env 卡正文与迁移格式：N/A。** 原因：core 只接受 adapter abstraction；Catalog 与 scenario 保持独立。

### 12.3 开放问题：N/A

所有影响 #10 可观测边界的状态形状、覆盖集、hash、record、replay 和错误语义已在本 L2 锁定；具体持久化介质和文件安置不影响上述契约，故不形成待实现阶段决定的设计问题。

---

## 13. 关联

- Issue **#10**：本设计的 S1–S4。
- `docs/overview.md`：RLM/continual 分工、序列 3 与 run-boundary 原则。
- `docs/design/5-kernel-recursive-model-call.md`：既有 Kernel、child run、Trace/Replay 与单 effect 基线；本设计不新增 harness binding。
- `docs/design/7-session-subagent-mailbox.md`：session、child lineage、mailbox 与局部 spawn 输入边界；它们不构成 harness state。
- `docs/design/11-runtime-capability-catalog.md`：`catalogCards[]` 的 `{id, version}` 解析目标、Card 文档 SSOT、runtime effect/budget/replay 契约。
- 后续序列 4–5：可基于已录制 `HarnessPinsV1` 做候选与评估，但不得改变本设计的 immutable publish、freeze 与 replay 规则。
