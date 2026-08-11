# 【catalog】Helix Capability Catalog（runtime-only）

- Issue: #11
- 状态: Approved（待用户 review 确认）
- 最后更新: 2026-08-10
- 交付面: Helix runtime 级契约（schema / 校验 / 登记谓词 / 首批 2 张 runtime 卡）；**不**提升公共 npm Runtime API；**不**交付任何 example env 卡正文；**不**实现改 harness
- 前置: #1 / #3 / #5 / #7；本设计为序列第 3 项（可调 harness）提供可 pin 的 runtime 卡引用靶（H3/H4 前提）
- 基线: L1 `/tmp/issue-11-l1-v2.md`
- 首批登记单元数（锁定）: **2** = `helix.models@1.0.0` + `helix.session@1.0.0`（**一张物理族卡**，surface 含 session/agents/mailbox；**不拆卡**）
- 篇幅取向: 完整可评审、短硬；双通道 registry 工程细节压成「v1 最小剖面 + 完整契约可选」

---

## 1. 背景

Helix 以持久 IPython 为 Runtime；bindings = 模型可见的「库」。`helix.models`（#5）、`helix.session` 族（#7）的说明书曾与 example 散文 / `SYSTEM_PROMPT` 缠在一起：不可 pin、不可版本化、与 harness 策略混写。

**本 Issue 不实现改 harness。** Catalog 解决「库说明书 / 分类可 pin」，是后续可调整 harness 的**前提**（H3/H4）。

三类问题：

1. **说明书不可版本化** — 无法以稳定身份被 pins / harness 引用。
2. **分类边界易混淆** — env 库、runtime 库、harness 控制面被同一套 binding/prompt 叙述。
3. **#10 缺引用靶** — 无稳定 id+version，harness 状态会再次内联整本库手册。

**产品决策（L1 锁定）**：Catalog 是 Helix **runtime 级**契约。具体 example 如何注册 env 卡 Outside。**无 Factorio env 卡正文。**

---

## 2. 名词解释

| 词 | 定义 |
|---|---|
| **Capability Catalog** | Helix runtime 级登记表与校验契约。生产只收 runtime 卡；标准落 `src/catalog/` 与本设计，**不**落 `examples/*` |
| **Capability Card** | 可 pin 的能力单元。引用身份 = **`id` + `version`（必填）** |
| **规范载荷** | 身份不可变语义整体七项：`kind`、`surface`、`effect`、`budgetAndAuth`、`doc`、`replay`、`nonGoals`。任一变更 **必须** bump `version` |
| **contentHash** | **可选**完整性字段；sha256(canonical JSON of 规范载荷)。**不是**引用身份；v1 可不实现 |
| **kind** | `env \| runtime`。只答归属，不答占槽。生产目录只收 `runtime` |
| **effectClass** | 入口级效应类别，闭集 **恰好七值**（§4.3）。L2 **不得**增删 |
| **occupiesHostEffectSlot** | 入口级可选布尔；`admin` **必填**。非 admin 若出现必须等于默认表 |
| **Host 单 effect 槽** | Host 本 cell 外部 effect 互斥状态；Catalog 只机读声明，不新开平行门闩 |
| **registrationScope** | v1：生产 = 运行时卡文件目录；fixture = 仅测试。完整契约可选枚举见 §4.1.4 |
| **说明书 SSOT** | 卡 `doc` 为模型可见权威正文；harness 引用渲染，不得长期双轨 |
| **catalogCards[]** | pins / HarnessDocument 中的 `{id, version}[]`；不内联库手册 |
| **helix.session 族卡** | **一张**物理卡 `id=helix.session`，覆盖三命名空间；计 1 个 S3 单元 |

---

## 3. 设计目标与非目标

### 3.1 目标

1. 定义能力卡 schema、`env|runtime` 分类、入口级 effectClass 闭集与默认占槽表、说明书 SSOT、与 bindingSet/pins/#10 的 id+version 引用。
2. 写死身份协议：引用 = id+version；规范载荷变更必须 bump；未知/缺 version fail-closed。
3. 写死生产登记谓词与错误码；harness 伪卡、缺 effectClass、占槽冲突、env 进生产 → 拒。
4. 首批只登记 2 张 runtime 卡，对齐 #5/#7，不平行改义。
5. 为 #10 提供四个显式消费点（§4.7 / §8）。
6. 明确 Catalog ⟂ HarnessDocument 边界与 H1–H6 责任（§3.3）。

### 3.2 非目标

- 任何 example **env 卡正文**（含 Factorio）；`kind=env` 仅 schema 扩展点。
- #10 HarnessDocument 实现 / 模块搬迁；序列 4–5 continual/refiner/promotion。
- `helix.harness` 库绑定；session ≡ harness。
- 重写 #5/#7 binding 行为；公共 npm API；#9 工程债。
- 扩展 effectClass 闭集；拆 session 族为多张物理卡。
- 长期 `SYSTEM_PROMPT` 双轨真相。

### 3.3 与 HarnessDocument / #10 边界（H1–H6）

**探针目标：将来能调整 harness——不是本 Issue 实现改 harness。** Catalog 是 H3/H4 前提。

| 探针 | 含义 | #11（本 Issue） | 留给 |
|---|---|---|---|
| **H1** | 可识别的 harness 版本（≠ 仅 code pin） | 定引用靶：卡 id+version；不定义 harness 身份本体 | **#10** harness 身份 |
| **H2** | 可替换策略而不 fork 整棵 example 树 | Catalog 标准不在 `examples/*`；库与策略解耦 | **#10** 策略文档/替换 |
| **H3** | 库说明书 ⟂ harness 策略 | **核心**：Catalog 卡 doc SSOT | #10 只引用不内联 |
| **H4** | harness ⟂ task/env API | **三分界**；env 扩展点无正文；禁止 harness 伪卡 | example 自注册 env；#10 组装 |
| **H5** | 跨 harness 版本可度量（suite） | 不覆盖 | **序列 4–5** |
| **H6** | run 边界应用 / continual | 不覆盖 | **#10 + 序列 4–5** |

**三类分离（写死）**

| 类 | 是什么 | 本 Issue |
|---|---|---|
| **Catalog 库卡** | 可注入 Kernel 的 env/runtime 能力说明书与契约 | **In**：schema + 2 runtime 卡 |
| **HarnessDocument** | 策略、成功条件、叙事模板、**卡引用** id+version | **Out** → #10；此处只定引用点 |
| **Example env** | 领域环境卡 + 指标（如 Factorio） | **Out** 正文；schema 认 `kind=env` |

禁止：`helix.harness` 库；session≡harness；Catalog 标准沉入 `examples/*`；长期 SYSTEM_PROMPT 双轨。

---

## 4. 能力与功能设计

### 4.1 能力卡 schema

#### 4.1.1 TypeScript 形状（锁定）

```ts
/** Issue #11 — Capability Catalog card schema (Helix-level). */

export type CardKind = 'env' | 'runtime';

/** Closed set of exactly 7 values. Unknown => reject. L2 MUST NOT extend. */
export type EffectClass =
  | 'observe'
  | 'commit'
  | 'env_effect'
  | 'model_effect'
  | 'spawn'
  | 'wait_external'
  | 'admin';

/** Full-contract optional labels; v1 may omit and use path-based admission (§4.1.4). */
export type RegistrationScope = 'runtime-catalog' | 'fixture-extension';
export type InjectionTarget = 'kernel-binding' | 'harness-control';

export interface SurfaceEntry {
  /** Fully-qualified entry name, e.g. "helix.models.call" */
  name: string;
  /** Required. Must be one of EffectClass. */
  effectClass: EffectClass;
  /** Design-level call shape summary (not a full OpenAPI). */
  signature: string;
  /**
   * Optional for non-admin; REQUIRED for admin.
   * If present for non-admin, MUST equal default occupancy for effectClass.
   */
  occupiesHostEffectSlot?: boolean;
}

export interface CardEffectSummary {
  /**
   * Derived projection of unique(surface[].effectClass).
   * v1: MAY omit on disk and derive at load; if present MUST equal that set
   * (no duplicates; every element ∈ EffectClass; set equality).
   */
  effectClasses?: EffectClass[];
  /** REQUIRED. Human-readable mutual-exclusion / admission-failure summary. */
  hostSlotSummary: string;
  mutualExclusionWith?: string[];
  actorModel?: string;
  opaqueCapability?: boolean;
}

export interface BudgetAndAuth {
  capabilityGate: string;
  tokenPool?: string;
  countBudget?: string;
  auth?: string;
  limits?: Record<string, unknown>;
  unauthorized: string;
}

export interface CardDoc {
  format: 'markdown/v1';
  title: string;
  /** Model-visible authoritative body (SSOT). */
  body: string;
}

export interface CardReplay {
  recordingAnchor: string;
  zeroLiveFallback: boolean;
  isolation?: string;
  exactlyOnceMerge?: boolean;
  checkpointBounds?: string;
  notes?: string;
}

/** Normative payload — identity-immutable under id+version. */
export interface NormativePayload {
  kind: CardKind;
  surface: SurfaceEntry[];
  effect: CardEffectSummary;
  budgetAndAuth: BudgetAndAuth;
  doc: CardDoc;
  replay: CardReplay;
  nonGoals: string[];
}

export interface CapabilityCard {
  id: string;
  version: string;
  /** Optional in v1 file cards when path implies production (§4.1.4). */
  registrationScope?: RegistrationScope;
  injectionTarget?: InjectionTarget;
  provider?: string;
  capabilityDiscoveryKeys?: string[];
  pinsTouch?: string;
  /** Optional integrity hash. NOT reference identity. v1 MAY omit. */
  contentHash?: string;
  kind: CardKind;
  surface: SurfaceEntry[];
  effect: CardEffectSummary;
  budgetAndAuth: BudgetAndAuth;
  doc: CardDoc;
  replay: CardReplay;
  nonGoals: string[];
}

export interface CardRef {
  id: string;
  version: string;
  contentHash?: string;
}

export interface BindingSetCardMapping {
  mappingVersion: string;
  bindingSet?: string;
  cards: CardRef[];
}
```

#### 4.1.2 必填与校验要点

| 规则 | 断言 |
|---|---|
| 必填 | `id`, `version`, `kind`, `surface`, `effect`, `budgetAndAuth`, `doc`, `replay`, `nonGoals` |
| `kind` | enum `env\|runtime` |
| `surface` | 非空（生产 runtime）；每项 `name`+`effectClass`+`signature` |
| `effectClass` | 七值闭集；未知 → 拒 |
| `effect.hostSlotSummary` | 非空字符串 |
| `effect.effectClasses` | **派生**自 `unique(surface[].effectClass)`；缺省则加载时填充；手写则必须集合相等、无重复、∈ 七值 |
| `admin` | 必须有 `occupiesHostEffectSlot: boolean` |
| `nonGoals` | `string[]`，可空但字段必须存在 |
| `doc.format` | `"markdown/v1"` |
| `version` | 非空；建议 semver |

#### 4.1.3 规范载荷抽取

```ts
export function extractNormativePayload(card: CapabilityCard): NormativePayload {
  const effectClasses = deriveEffectClasses(card.surface, card.effect);
  return {
    kind: card.kind,
    surface: card.surface,
    effect: { ...card.effect, effectClasses },
    budgetAndAuth: card.budgetAndAuth,
    doc: card.doc,
    replay: card.replay,
    nonGoals: card.nonGoals,
  };
}

/** unique(surface[].effectClass) in surface first-seen order.
 * Handwritten effectClasses, if present, must match as a set; order is non-identity
 * and is NOT preserved — normative projection always uses fromSurface order.
 */
export function deriveEffectClasses(
  surface: SurfaceEntry[],
  effect?: CardEffectSummary,
): EffectClass[] {
  const fromSurface = [...new Set(surface.map((e) => e.effectClass))];
  if (effect?.effectClasses != null) {
    assertEffectClassesMatchSurface(effect.effectClasses, fromSurface);
  }
  return fromSurface;
}
```

**不进规范载荷**：`id` / `version` / 通道元数据 / `provider` / `contentHash` / 发现键等。

#### 4.1.4 v1 最小剖面 vs 完整契约

| 能力 | v1 最小剖面（本 Issue 实现下限） | 完整契约（可选/后续） |
|---|---|---|
| 身份 | id+version 必填；未知/缺 version fail-closed | 同左 |
| contentHash | **可不实现**；引用不得仅靠 hash | sha256(canonical JSON)；引用侧可选携带并校验 |
| 通道字段 | 生产卡文件目录 = 生产；fixture 目录/夹具 = 仅测 | 显式 `registrationScope` / `injectionTarget` 枚举 |
| 通道漂移 | **同 path 同 id+version 文件不可静默改通道字段**（改则必须 bump version 或换 path） | 发布记录 `CatalogPublishRecord` + `CATALOG_CHANNEL_META_DRIFT` |
| effectClasses | 从 surface **派生**；手写则校验一致 | 同左（派生为权威） |
| 双登记通道工程 | 不强制独立 registry 双写 API | fixture-extension 通道 + 生产准入 API 分叉 |
| 目录形态 | 打包内只读 JSON（或 TS 冻结对象）+ 内存索引 | 同左 + 发布记录快照 |

v1 **语义不变**：生产只收 runtime 库卡；env 形状仅夹具可校验；身份只靠 id+version。

### 4.2 不可变身份

1. pins / bindingSet 映射 / #10 `catalogCards[]` 每项 **必须** 含 `id` 与 `version`。
2. 缺 id/version → `CATALOG_REF_IDENTITY_INVALID`。
3. 目录无该 id+version → `CATALOG_REF_UNKNOWN`。
4. 旧引用 **只** 解析旧 version；**禁止** auto-latest。
5. 同 id+version 规范载荷语义变更 → `CATALOG_IMMUTABLE_VERSION_DRIFT`；必须 bump。
6. contentHash（若实现）：同载荷稳定；不匹配 → `CATALOG_CONTENT_HASH_MISMATCH`；**禁止**只改 hash 不 bump；**禁止**仅 hash 当身份。

**Canonical JSON（完整契约实现 contentHash 时锁定）**：object 键 UTF-16 升序；array **保持声明序**（surface 不排序）；无多余空白；sha256 hex lowercase。

**通道元数据（v1 一条规则）**：已登记的生产卡文件，同 path + 同 id+version **不得**静默改写通道相关字段（含显式 scope/target，或隐含「此文件属生产目录」的安置）。合法换通道语义 → bump version 或新文件身份。

### 4.3 effectClass 七值闭集与默认占槽表

`kind` ≠ `effectClass`。Host 仍 **单 cell 单外部 effect 槽**（#1/#5/#7）。

| effectClass | 含义 | 默认 occupiesHostEffectSlot |
|---|---|---|
| `observe` | 本地/已录制只读；无外部写 | **false** |
| `commit` | 持久投影/mailbox 等写路径 | **true** |
| `env_effect` | 领域环境副作用（将来 env） | **true** |
| `model_effect` | 同步递归模型调用 | **true** |
| `spawn` | 派生子执行体/handle | **true** |
| `wait_external` | 阻塞等外部进展 | **true** |
| `admin` | 管理/创建/恢复；占槽须入口显式声明 | **无默认；必填显式位** |

```ts
export function defaultOccupies(effectClass: EffectClass): boolean | 'explicit-required' {
  switch (effectClass) {
    case 'observe': return false;
    case 'commit':
    case 'env_effect':
    case 'model_effect':
    case 'spawn':
    case 'wait_external':
      return true;
    case 'admin':
      return 'explicit-required';
  }
}

export function resolveOccupies(entry: SurfaceEntry): boolean {
  const d = defaultOccupies(entry.effectClass);
  if (d === 'explicit-required') {
    if (typeof entry.occupiesHostEffectSlot !== 'boolean') {
      throw catalogError('CATALOG_ADMIN_SLOT_UNDECLARED', entry.name);
    }
    return entry.occupiesHostEffectSlot;
  }
  if (entry.occupiesHostEffectSlot !== undefined && entry.occupiesHostEffectSlot !== d) {
    throw catalogError('CATALOG_REJECT_OCCUPANCY', entry.name);
  }
  return d;
}
```

规则：未知值 → 拒；L2 不得增删取值。非 admin 若带 occupies 必须等于默认表。admin 缺显式占槽 → 拒。占槽类 admission 失败 → 不新占槽、live 副作用 0。observe 不触发占槽互斥。

**禁止**：第八个 effectClass；用布尔削弱默认表；仅有布尔无 effectClass；用卡级 effect 散文替代入口表；手写 `effectClasses` 与 surface 集合不一致。

### 4.4 生产登记谓词

#### 4.4.1 准入合取（全部满足才进生产目录）

1. 来自生产卡路径（v1）或 `registrationScope === "runtime-catalog"`（完整契约）
2. `kind === "runtime"`
3. 注入目标为 kernel binding（v1 隐含；完整契约 `injectionTarget === "kernel-binding"`）
4. 每个公开入口 `name` 匹配 `/^helix\./`；主 NS **不得**为 `helix.harness`
5. 每入口闭集内 effectClass；occupancy 与默认表一致；effectClasses 派生/一致
6. 必填字段与身份协议通过；若声明 contentHash 则匹配；通道字段不静默漂移

```ts
export const ALLOWED_KERNEL_NS_PREFIXES = ['helix.'] as const;
export const HARNESS_CONTROL_NAMESPACES = ['helix.harness'] as const;
```

#### 4.4.2 拒绝表与错误码

| # | 条件 | 错误码 | 结果 |
|---|---|---|---|
| B1 | harness-control / 策略当库 | `CATALOG_REJECT_HARNESS_CONTROL` | 拒，不得 pin |
| B2 | surface 主 NS ∈ `helix.harness` 等控制面 | `CATALOG_REJECT_HARNESS_NAMESPACE` | 同上 |
| B3 | 无 helix. 可注入入口 / 空 surface | `CATALOG_REJECT_NO_KERNEL_INJECTION` | 同上 |
| B4 | 生产通道且 `kind=env` | `CATALOG_REJECT_ENV_IN_RUNTIME_CATALOG` | 同上 |
| B5 | 生产通道且 `kind !== "runtime"` | `CATALOG_REJECT_NON_RUNTIME_KIND` | 同上 |
| B6 | 完整契约下生产提交缺通道元数据（v1 path 隐含则 N/A） | `CATALOG_REJECT_ADMISSION_METADATA_MISSING` | 同上 |
| B7 | 缺 id/version、同 version 规范载荷漂移、空 version | `CATALOG_REJECT_IDENTITY` / `CATALOG_IMMUTABLE_VERSION_DRIFT` | 同上 |
| B8 | 缺/非法 effectClass；或手写 effectClasses 不一致/重复/第八值 | `CATALOG_REJECT_EFFECT_CLASS` | 同上 |
| B9 | occupies 与默认表冲突；admin 缺显式位 | `CATALOG_REJECT_OCCUPANCY` | 同上 |

附加（实现完整契约或 v1 文件覆写门闩时）：

| 条件 | 错误码 |
|---|---|
| 同 id+version 通道字段静默漂移 | `CATALOG_CHANNEL_META_DRIFT` |
| 引用 hash 不匹配 | `CATALOG_CONTENT_HASH_MISMATCH` |
| bindingSet 无法解析完整列表 | `CATALOG_BINDING_SET_UNRESOLVABLE` |
| fixture 卡被生产解析 | `CATALOG_REF_NOT_IN_PRODUCTION` |
| 未知 id+version | `CATALOG_REF_UNKNOWN` |
| 引用缺 id/version | `CATALOG_REF_IDENTITY_INVALID` |

#### 4.4.3 Fixture

- 仅 schema/kind/effectClass/通道负向测试。
- 通过 ≠ 生产准入；**不得**被 pins/#10 生产路径当作已登记生产卡。

### 4.5 说明书 SSOT 与渲染

1. **权威在卡**：`doc.body`（`markdown/v1`）为模型可见 SSOT。
2. `renderCardDoc(id, version)`：按 id+version 解析（禁止 auto-latest）；规范化换行；同身份两次渲染字节一致；不插入 harness 任务前言。
3. 能力发现投影（`capabilities.*`）≠ 说明书全书；数值以 Host 为准。
4. doc 无凭证/token/stack。
5. 迁移期 prose 可短期并存，须标明 Catalog 为权威；禁止长期只改 SYSTEM_PROMPT。

### 4.6 首批 runtime 卡（恰好 2；无 Factorio）

**S3 计数（锁定）**：生产登记单元 = **2**。

| # | id | version | kind | 说明 |
|---|---|---|---|---|
| 1 | `helix.models` | `1.0.0` | runtime | #5 递归模型调用 |
| 2 | `helix.session` | `1.0.0` | runtime | 族卡：session + agents + mailbox |

两卡生产安置：`registrationScope` 隐含/显式 = 生产 runtime 目录；`injectionTarget` 隐含/显式 = `kernel-binding`；`provider` 建议 `helix-runtime`。

contentHash：**可选**。若实现完整契约并采用与既有规范载荷一致的 canonical 输入，参考值：

| id | version | sha256（可选锁定） |
|---|---|---|
| helix.models | 1.0.0 | `6de520da1a0b32ea0a668bdea926c666421c13c8cf978fbaa0c55ac7853cbd17` |
| helix.session | 1.0.0 | `d404bda51e25bb93e33cfd8c0bcf27e39332cce470dce03ae6a096caecc08a8e` |

v1 不实现 hash 时 **不** 将上表列为 S3 必过。

#### 4.6.1 卡 A — `helix.models@1.0.0`

**元数据**

| 字段 | 值 |
|---|---|
| id / version | `helix.models` / `1.0.0` |
| kind | `runtime` |
| capabilityDiscoveryKeys | `["recursiveModel"]` |
| pinsTouch | 启用 recursiveModel 的 bindingSet/能力集须解析到本卡 id+version |

**surface**

| name | signature | effectClass | occupiesHostEffectSlot |
|---|---|---|---|
| `helix.models.call` | `call(instructions, input=None, max_output_tokens=None) -> RecursiveModelResult` | `model_effect` | `true`（默认） |

**effect（派生）**

- effectClasses: `[model_effect]`（= unique(surface)）
- hostSlotSummary: 准入成功后占 Host 单 effect 槽；与其它占槽类互斥；失败 live 副作用 0
- mutualExclusionWith: `env_effect`, `commit`, `spawn`, `wait_external`, `admin(occupies=true)`, `model_effect`

**budgetAndAuth**

- capabilityGate: `capabilities.recursiveModel.enabled`
- tokenPool: 父剩余模型预算池（#5 reserve/settle）
- countBudget: 递归调用次数预算
- unauthorized: binding 不可用且/或 effect 拒（`RECURSIVE_MODEL_NOT_ENABLED`）；Provider 前 fail-closed；不占槽

**doc（SSOT）**

```markdown
# helix.models

Synchronous recursive model query from the persistent Kernel.

## Entry

`result = helix.models.call(instructions, input=None, max_output_tokens=None)`

- Fixed to parent run model pin; temperature=0.
- Returns bounded RecursiveModelResult: status, text preview, usage, child_run_id, response_ref.
- Does not expand full provider response into outer LLM context.

## Capability projection

Discovered only via `capabilities.recursiveModel` {enabled, remainingCalls, remainingTokens, maxCompletionTokens}.
When enabled=false, binding is not injected; Host rejects with RECURSIVE_MODEL_NOT_ENABLED.

## Effect

effectClass=model_effect; occupies Host single-effect slot after admission.
Mutually exclusive with domain environment effects (`env_effect`), session write paths, spawn/wait, mailbox durable changes, and other model_effect in the same cell.

## Budget

Shares parent remaining model token pool and recursive call count. Admission computes declared caps, reserves before Provider, settles actual/charged/overflow after terminal.

## Replay

Each admitted call is an independent child run (parentId link). Parent cell records modelEffect. Parent/child I/O queues isolated. Zero live Provider fallback on Replay.
```

**replay**

- recordingAnchor: parent `CellExecutionRecord.modelEffect` + child run Trace
- zeroLiveFallback: true
- isolation: parent/child I/O queues isolated
- notes: Align #5; C1 attachFailed ∉ childRunIds; C2 post-started replayable

**nonGoals**

- async sub-agent / mailbox / cross-run session
- arbitrary model routing / public npm Runtime API
- parallel multi-child same cell / rewrite #7 session semantics

#### 4.6.2 卡 B — `helix.session@1.0.0`（族聚合）

**拆卡决策（锁定）**：session / agents / mailbox **不**拆三张物理卡。S3 = 1（本族）+ 1（models）= **2**。

**元数据**

| 字段 | 值 |
|---|---|
| id / version | `helix.session` / `1.0.0` |
| kind | `runtime` |
| capabilityDiscoveryKeys | `["sessionAsync"]` |
| pinsTouch | 启用 sessionAsync 的 bindingSet/能力集须解析到本卡 id+version |

**surface（全部公开入口）**

| name | signature | effectClass | occupiesHostEffectSlot |
|---|---|---|---|
| `helix.session.create` | `create(capability_token, metadata=None) -> SessionView` | `admin` | **true**（显式） |
| `helix.session.resume` | `resume(session_id, capability_token, version=None) -> SessionView` | `admin` | **true**（显式） |
| `helix.session.checkpoint` | `checkpoint(note=None) -> SessionView` | `admin` | **true**（显式） |
| `helix.session.lookup` | `lookup(session_id=None, capability_token=None) -> SessionView` | `observe` | false |
| `helix.agents.spawn` | `spawn(instructions, input=None, max_output_tokens=None, mailbox=True) -> HandleView` | `spawn` | true |
| `helix.agents.wait` | `wait(handle_id, timeout_ms=None) -> HandleView` | `wait_external` | true |
| `helix.agents.poll` | `poll(handle_id) -> HandleView` | `observe` | false |
| `helix.mailbox.send` | `send(to, payload, to_handle_id=None) -> Receipt` | `commit` | true |
| `helix.mailbox.receive` | `receive(mailbox_id=None, timeout_ms=0) -> Message \| None` | `commit` | true |
| `helix.mailbox.peek` | `peek(mailbox_id=None) -> Message \| None` | `observe` | false |

**mailbox.receive**：分类锁定 `commit`。成功推进持久游标时占槽；空/未变更对齐 #7 admission——Catalog 不削弱「未变更则不占槽」。

**effect（派生）**

- effectClasses: 集合 = unique(surface)；**规范投影顺序 = surface 首次出现序**；手写数组顺序非身份且不保留
- hostSlotSummary: 占槽入口（admin occupies=true、spawn、wait_external、commit）与 model_effect / 将来 env_effect 互斥；observe 永不占槽；receive 仅持久游标前进时占槽（细则 #7）
- actorModel: Host 从 capability 推导；忽略模型自报
- opaqueCapability: true

**budgetAndAuth**

- capabilityGate: `capabilities.sessionAsync.enabled`
- auth: SessionCreationCapability vs session-bound SessionCapability；principal 绑定；跨主体 resume 不可枚举
- limits: maxActiveHandles=4，maxHandlesPerSession=16，mailbox 有界（#7）
- unauthorized: fail-closed、不可枚举、live 副作用 0、无秘密泄漏

**doc（SSOT）**

```markdown
# helix.session (family card)

One physical capability card covering three Kernel namespaces: helix.session, helix.agents, helix.mailbox.
Shared gate: capabilities.sessionAsync.enabled. This is NOT harness baseline/overlay state (#10).

## Session

- create(capability_token, metadata=None) — admin, occupies slot
- resume(session_id, capability_token, version=None) — admin, occupies slot
- checkpoint(note=None) — admin, occupies slot; commits monotonic sessionVersion
- lookup(...) — observe, no slot; actor-filtered SessionView

Session projection is the sole cross-run authority. Live Kernel namespace is same-run cache only.

## Agents

- spawn(...) — spawn class; returns handle immediately; independent child run + parentId
- wait(handle_id, timeout_ms=None) — wait_external; blocking path occupies slot
- poll(handle_id) — observe snapshot; no slot

No bare threads. Handle state machine: pending→running→{completed|failed|cancelled}|rejected.

## Mailbox

- send(to, payload, ...) — commit; durable enqueue occupies slot
- receive(...) — commit; successful consume/cursor advance occupies; empty/no durable mutation per #7 does not
- peek(...) — observe; no cursor advance; no slot

Bounded depth/size. Authorization matrix fail-closed.


**`helix.mailbox.receive` 占槽细则（对齐 #7，优先于「commit 默认占槽」笼统表述）**：

1. `timeout_ms == 0`：仅 **成功消费并推进游标** 时占 Host 单 effect 槽；空队列且持久态未变更 → **不占槽**。
2. `timeout_ms > 0`：admission 通过并进入等待路径即 **占槽**；即使最终超时、未消费、游标未推进，**不回滚** 槽。
3. 入口 `effectClass` 仍为 `commit`；不得将正 timeout receive 描述为 `observe`。
4. 测试须分：静态分类 = commit；运行时 gate = 非阻塞空 vs 正 timeout 两条路径。

## Cut vs helix.models

models.call remains synchronous recursive query (#5). Session/async/mailbox must not be stuffed into models.call.

## Replay

Committed sessionVersion boundaries; checkpoint include/exclude; exactly-once merge via append-only ledger + dedupeSnapshot; zero live fallback on related runs.
```

**replay**

- recordingAnchor: session projection versions + domain-event/merge ledger + handle/mailbox cell effects
- zeroLiveFallback: true
- exactlyOnceMerge: true
- checkpointBounds: included/excluded handle terminals and mailbox enqueues relative to committed version V
- notes: Align #7; session ≠ harness state

**nonGoals**

- bare threads without handle / unbounded mailbox / public npm Runtime API
- treat session as harness baseline/overlay / rewrite #5 call semantics
- Global Evolution / promotion / enumerable multi-tenant session namespace without auth

#### 4.6.3 kind=env 扩展点（非交付）

- Schema 允许 `kind=env`；入口同样必填 effectClass（典型 `env_effect`/`observe`）。
- 本 Issue **零** env 实例正文；测试仅最小合法 env 夹具。
- **无 Factorio env 卡交付。**

### 4.7 与 pins / bindingSet / #10 的引用关系

#### 4.7.1 引用链

```text
Catalog 卡 (id+version, 规范载荷)
    ↑ 引用，不内联手册
pins / bindingSet → 解析为 catalogCards[]: {id, version}[]
    ↑ 引用
HarnessDocument (#10): harness 身份 + 策略 + catalogCards[] + 可选说明覆写
    ↑
Run 组装（选卡 + capability 投影）
```

#### 4.7.2 pins 三分（关系本 Issue 写清；字段细节 #10）

| 切片 | 含义 | 本 Issue |
|---|---|---|
| **codePin** | 代码/发行针脚（如历史 `factorio-rlm/v*`、kernelProtocol） | 不改义；与 catalog 并列 |
| **harness 身份** | HarnessDocument 版本/基线+overlay | **#10** |
| **catalogCards[]** | 本 run 启用的库卡 **id+version** 列表 | **定语义** |

```ts
interface CatalogPinsSlice {
  catalogMappingVersion?: string; // e.g. "1"
  catalogCards: CardRef[];        // each MUST include id+version
}
```

bindingSet **不废除**：须能确定性映射到 id+version 集合（映射表自身可版本化）。组装方**选卡**，不定义 schema。

#### 4.7.3 抽象能力集映射（Helix 级）

```ts
export const CATALOG_BINDING_SET_MAPPING_VERSION = '1' as const;

export type RuntimeCapabilitySetId =
  | 'helix.runtime.recursive-model/v1'
  | 'helix.runtime.session-async/v1'
  | 'helix.runtime.core/v1';

export const RUNTIME_CAPABILITY_SETS: Record<RuntimeCapabilitySetId, CardRef[]> = {
  'helix.runtime.recursive-model/v1': [
    { id: 'helix.models', version: '1.0.0' },
  ],
  'helix.runtime.session-async/v1': [
    { id: 'helix.session', version: '1.0.0' },
  ],
  'helix.runtime.core/v1': [
    { id: 'helix.models', version: '1.0.0' },
    { id: 'helix.session', version: '1.0.0' },
  ],
};
```

Example 本地 bindingSet（如 factorio/v3|v4）可别名到抽象集；**Catalog 标准不沉入 example**。映射变更 → bump `mappingVersion`。无法解析完整列表 → `CATALOG_BINDING_SET_UNRESOLVABLE`。

#### 4.7.4 Fail-closed（S4 可判定）

- 未知 id / 缺 version / 目录无该 id+version → 拒组装/pin/preflight
- 同 id+version 改规范载荷 → 发布校验拒（必须 bump）
- 旧引用只解析旧载荷，禁止静默升版
- harness 伪卡 / `helix.harness` surface / 生产塞 env → 拒
- 缺/非法 effectClass 或占槽布尔与默认表冲突 → 拒
- 手写 effectClasses 与 surface 不一致 → 拒

#### 4.7.5 #10 对本 Issue 的四个消费点

1. HarnessDocument 能力列表 = `catalogCards[]`（每项 id+version）
2. 加载时存在性 + version 校验 fail-closed（可选 hash）
3. 模型可见库说明渲染输入 = 被引卡 `doc`（+ 可选 harness 级覆写），非 example 私有长文
4. HarnessDocument **不**定义 Catalog schema、**不**登记为库卡

---

## 5. 设计思路与折衷

1. **Catalog 必须 runtime 级** — 若沉入 `examples/*`，#10 与第二 example 必然分叉。语义仍对齐 #5/#7，标准落 `src/catalog/`。
2. **session 族不拆** — 共享 `sessionAsync` 与 actor 模型；S3 计数=2 清晰。
3. **effectClass 在入口** — 仅卡级散文无法机读 observe vs 占槽。
4. **effectClasses 派生** — 避免 surface/汇总双写漂移；手写仅作可选显式且必须一致。
5. **contentHash 可选** — version 负责演进；hash 防篡改。v1 可不实现，完整契约再上。
6. **通道工程压扁** — v1 用生产目录 path +「同身份不静默改通道」一条规则，避免双 registry 注水。
7. **生产拒 env** — 防止「首批是否含 Factorio」重新开口。

**放弃**：Catalog 归 example；首批 env 正文；`helix.harness` 库注入；仅卡级 effect；用布尔削弱占槽表；session 物理三卡；长期 SYSTEM_PROMPT 双轨。

---

## 6. 架构设计

```text
docs/design/11-runtime-capability-catalog.md   ← 本 L2
                    │
                    ▼
src/catalog/
  types.ts            Card / EffectClass / CardRef
  validate.ts         schema + B* + occupancy + effectClasses 派生/一致
  registry.ts         生产目录 load/get/list（v1 最小）
  render.ts           renderCardDoc
  binding-set-map.ts  mappingVersion + capability sets
  cards/              helix.models.1.0.0.json
                      helix.session.1.0.0.json
  canonical.ts        （可选）canonicalJson + contentHashOf
        │
        ├─ pins / evidence.catalogCards[]
        ├─ fixture tests only
        └─ #10 HarnessDocument（后续）→ 渲染 doc + 覆写策略
```

- Catalog **只读投影**占槽声明；真正占槽仍在 Host admission（#5/#7）。
- 加载：读生产卡 → 结构+准入校验 → 派生 effectClasses → 索引 `id@version` → 拒绝同身份载荷/通道漂移。
- 与 Host effect gate：**不**替换 `LiveCellExecutor` 计数器。

---

## 7. 模块设计

| 路径 | 职责 | 非职责 |
|---|---|---|
| `src/catalog/types.ts` | 类型与七值闭集 | Host gate |
| `src/catalog/validate.ts` | schema、B 码、occupancy、effectClasses | Provider |
| `src/catalog/registry.ts` | 生产索引、get、list、登记不可变门闩 | example env 产品中心 |
| `src/catalog/render.ts` | 稳定 markdown | harness 任务前言 |
| `src/catalog/binding-set-map.ts` | 抽象能力集 → CardRef[] | 改 factorio pins 字面量本体 |
| `src/catalog/cards/*.json` | 首批卡冻结正文 | 运行时可变配置 |
| `src/catalog/canonical.ts` | 可选 hash | 身份解析 |
| `test/catalog/*.test.ts` | S1–S4 | 强制 FLE E2E |

```ts
export function validateCardStructure(card: unknown): CatalogValidationResult;
export function validateProductionAdmission(card: CapabilityCard): CatalogValidationResult;
export function validateFixtureCard(card: CapabilityCard): CatalogValidationResult;
export function getProductionCard(id: string, version: string): CapabilityCard;
export function resolveCapabilitySet(setId: RuntimeCapabilitySetId): CardRef[];
export function renderCardDoc(id: string, version: string): string;
export function registerCard(card: CapabilityCard): CatalogValidationResult; // enforces freeze
```

衔接：Kernel binding 名与 effect method **保持** #5/#7；Catalog 只描述。`harness.ts` 迁移期 prose 旁注释指向卡 doc。本 Issue **不强制**立刻改 factorio pins 字面量；提供 `catalogCards` 切片与纯函数 gate 供 #10 接入。

---

## 8. API / CLI 设计

| 项 | 结论 |
|---|---|
| 公共 npm API | **N/A** — 仓库内模块，无 package exports 承诺 |
| 用户产品 CLI | **N/A** — 可选开发脚本 `scripts/catalog-validate.ts`（加载 cards、准入、退出码） |
| 模型可见面 | 模型不见 Catalog；只见 bindings + 渲染后的 doc |
| CardRef JSON | `{ "id": "helix.models", "version": "1.0.0" }`（contentHash 可选） |

**#10 消费伪代码（契约，非本 Issue 实现）**

```ts
function loadHarnessLibs(h: { catalogCards: CardRef[] }): string[] {
  return h.catalogCards.map((ref) => {
    if (!ref.id || !ref.version) throw err('CATALOG_REF_IDENTITY_INVALID');
    const card = getProductionCard(ref.id, ref.version);
    if (ref.contentHash) assertHash(card, ref.contentHash); // if hash enabled
    return renderCardDoc(ref.id, ref.version);
    // harness overlay MUST NOT replace SSOT identity
  });
}
```

---

## 9. 边界考虑

| 面 | 要点 |
|---|---|
| 安全 | doc/渲染无凭证、token、stack；harness-control 机拒 |
| 权限/占槽 | 声明与 Host 门闩一致；enabled=false 既有拒绝保留 |
| Replay | 卡 replay 为摘要；权威行为在 #5/#7；改摘要 → bump |
| 多 example | 共用同一 runtime 卡 id+version；env 将来自注册 |
| 错误面 | 断言 code 而非仅 message 子串 |
| 性能 | 首批 2 卡；校验 O(entries) |
| N/A | 见 §12 |

---

## 10. 迁移 / 兼容 / 回滚

1. 落地 `src/catalog/**` + 两张卡 + S1–S4 单测。
2. 双轨标明权威：prose 注释指向卡 doc；禁止只改 prose。
3. 可选 pins 切片 `catalogCards`；旧 artifacts 无字段 = 未启用 Catalog 切片。
4. #10 接入：harness 存 CardRef[]；删内联手册（后续 Issue）。
5. **不**要求本 Issue 迁移 Factorio SYSTEM_PROMPT 全文。

兼容：kernelProtocol 不因 Catalog 升版；mappingVersion 独立。回滚：关闭切片写入；Host 仍仅依赖 #5/#7；已发布 id+version 不得改写不 bump。

版本政策：破坏性 surface/effectClass/预算 → MAJOR；doc 规范化文本变 = 必须 bump（doc∈规范载荷）。

---

## 11. 测试计划

### 11.0 设计评审清单（人工，不进 `test/catalog`）

- [ ] § 与 HarnessDocument/#10 四消费点仍在且与 L1 一致
- [ ] pins 三分（codePin / harness 身份 / catalogCards[]）关系可陈述且与 #10 对齐
- [ ] `mailbox.receive` 双分支占槽与 #7 一致
- [ ] 首批 runtime 卡 doc 无 example 专有环境名（如 Factorio）作为通用术语

可执行自动化测试仅含下列行为契约：
（S1–S4）

### 11.1 Stories → 判定

| Story | 判定 |
|---|---|
| **S1** schema/分类 | 必填闭集；kind∈{env,runtime}；入口必有闭集 effectClass；observe≠占槽类可机读；harness 伪卡/`helix.harness` 拒；env 夹具可识别但不进生产；手写 effectClasses 不一致 → 拒；派生一致 → 过 |
| **S2** 说明书 SSOT | 同 id+version 渲染稳定；改 doc/surface/effectClass/budget/replay/nonGoals/kind 不 bump → 拒；旧引用不渲染新文；同身份静默改通道字段 → 拒；幂等同文重登记 → 过 |
| **S3** 首批 runtime | 生产可数 **2**：`helix.models` + `helix.session` 族；入口 effectClass 表与 §4.6 一致；effectClasses 集合=unique(surface)；**无** Factorio/env 正文；标准路径 ∉ `examples/*`；无独立 agents/mailbox 生产卡 id |
| **S4** 引用 | 能力集→完整 id+version 列表；缺/错 version fail-closed；旧 pin 不升版；#10 四消费点可勾选；pins 关系含 codePin / harness 身份 / catalogCards 三分 |

### 11.2 必覆盖用例 ID

**S1**

| ID | 断言 |
|---|---|
| `S1.schema-required-fields` | 缺必填 → 失败 |
| `S1.kind-enum` | 非法 kind 失败；env/runtime 可识别 |
| `S1.effectclass-closed-seven` | 仅七值；第八值 → B8 |
| `S1.observe-vs-commit-occupancy` | false vs true |
| `S1.admin-requires-occupies` | 缺 → 拒 |
| `S1.b9-observe-true` / `S1.b9-commit-false` | 拒 |
| `S1.fixture-R-pass` | 合法 runtime 生产通过 |
| `S1.fixture-H1-B1` | harness-control 拒 |
| `S1.fixture-H2-B2` | helix.harness 拒 |
| `S1.fixture-E-channel-split` | fixture 可过 / 生产拒 env |
| `S1.effect-classes-derived` | 缺省手写时派生 = unique(surface) |
| `S1.effect-classes-mismatch` | 手写漏列/多列/重复/第八值 → B8 |
| `S1.effect-classes-match` | 手写与 surface 一致 → 过 |

**S2**

| ID | 断言 |
|---|---|
| `S2.render-stable` | 双渲染字节一致 |
| `S2.bump-required-on-doc` | 同 version 改 doc 拒 |
| `S2.bump-required-on-effectclass` | 同 version 改入口 class 拒 |
| `S2.bump-required-on-budget` / `replay` | 同 |
| `S2.no-hash-only-identity` | 仅 hash 无 version 的 ref 拒 |
| `S2.channel-meta-no-silent-drift` | 同 path 同 id+version 改通道字段拒 |
| `S2.channel-meta-idempotent` | 全同重登记过 |
| `S2.hash-mismatch` | （若实现 hash）拒 |

**S3**

| ID | 断言 |
|---|---|
| `S3.production-count-2` | list.length === 2 |
| `S3.models-surface-model-effect` | call → model_effect |
| `S3.session-surface-table` | 10 入口 class/occupies 全表 |
| `S3.effect-classes-consistent` | 两卡集合=unique(surface) |
| `S3.no-env-instance` | 生产无 kind=env |
| `S3.session-not-split` | 无独立 helix.agents / helix.mailbox 生产 id |
| `S3.path-not-under-examples` | 标准/卡路径 ∉ `examples/*` |

**S4**

| ID | 断言 |
|---|---|
| `S4.resolve-core-set` | core/v1 → 两卡 ref |
| `S4.unknown-ref` / `S4.missing-version` | 拒 |
| `S4.pinned-old-version` | v1 不升 v2 |
| `S4.binding-set-unresolvable` | 拒 |
| ~~`S4.doc-checklist-issue10`~~ → **设计评审清单**（非代码测试） | 四消费点存在于本设计 §4.7.5 |
| ~~`S4.pins-three-way`~~ → **设计评审清单**（非代码测试） | codePin / harness 身份 / catalogCards 关系可陈述 |

### 11.3 分层与环境

- **Unit** 为主；纯函数 + 内存夹具。
- **Integration**：加载真实 JSON 卡；render 非空；映射常量。
- **E2E**：不强制 FLE/容器；不得把 env 可用性写成 S3 必过。
- 契约测试零外部游戏依赖；失败必须 `ok===false` 且 code 匹配。

---

## 12. 开放问题 / 决策记录 / N/A

### 12.1 已关闭决策

| 决策 | 结论 |
|---|---|
| session 族物理形态 | **1 张** `helix.session` |
| 首批单元数 | **2** |
| effectClass | **恰好 7 值**；不可扩展 |
| env 交付 | **无** |
| effect.effectClasses | **派生**自 surface；手写必须一致 |
| contentHash | **可选**；v1 可不实现 |
| 通道元数据 v1 | 生产目录 path + 同身份不静默改通道 |
| 公共 npm / 用户 CLI | **N/A** |
| #10 实现 | **N/A 本 Issue**（只定引用点） |
| Catalog 路径 | `src/catalog/` |
| 初始 version | 两卡 `1.0.0` |
| mappingVersion | `"1"` |

### 12.2 N/A（写原因）

| 项 | 原因 |
|---|---|
| Factorio / 任一 env 卡正文 | L1 Out；仅 schema 扩展点 + fixture |
| 独立 `helix.agents` / `helix.mailbox` 生产卡 | 族聚合锁定 |
| 用户 CLI / 公共 npm API | 非目标 |
| #10 harness 模块实现 | 只定四消费点 |
| continual / refiner / promotion / #9 | 非本 Issue |
| effectClass 第八值 | 禁止；须先修订 L1 |
| SYSTEM_PROMPT 全文迁移验收 | 非强制 |
| 完整双通道 registry 工程 | v1 压成最小剖面；语义保留 |

### 12.3 残留观察（不阻塞 Draft 评审）

1. example 本地 bindingSet 别名表落 example 还是 catalog 旁路文件：建议 catalog 只持抽象集。
2. `catalogCards` 是否写入正式 RunPins 字段：待 #10 与 pins 升级。
3. doc 首版英文技术正文（与 kernel 文案一致）；中文设计文档不进规范载荷。

---

## 13. 关联

- Issue **#11** · Capability Catalog（runtime-only；本 L2 Draft）
- Issue **#10** · HarnessDocument / pins 三分 / 四消费点（§3.3 · §4.7.5）
- Issue **#5** · `docs/design/5-kernel-recursive-model-call.md` · `models.call` → `model_effect`
- Issue **#7** · `docs/design/7-session-subagent-mailbox.md` · session≠harness；入口占槽表
- Issue **#1** / **#3** · 单 effect / Replay / 零 live fallback
- `docs/overview.md` · Catalog 不归 example
- L1 · `/tmp/issue-11-l1-v2.md`

---

**状态**: Draft · **Issue**: #11 · **最后更新**: 2026-08-10 · **主节**: 13 · **effectClass**: 7 闭集 · **首批卡**: 2 runtime · **env 正文**: 无 · **改 harness**: 不在范围（H3/H4 前提）
