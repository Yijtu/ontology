# ontology · 通用 POC Core

一个可以挂载行业语义、Agent runtime 和数据后端的业务问答框架。它把客户资料变成可审核的实体、属性、关系与规则，再通过受限工具查询数据、执行可表示的规则，并发布经过核验的回答及其来源。

当前开发入口是 `platform/`。本轮重点是从 `main@51c8cb4` 补齐通用产品链，实施分支为 `feat/main-core-product-20260928`。**默认可运行宿主和两个行业的完整 HTTP/UI 流程仍在接线与验收，不能把模块测试通过理解为完整产品已经交付。** 逐项证据见[独立验证记录](platform/docs/main-core-independent-review-2026-09-28.md)。

## 输入和输出

平台有两类使用者。operator 配置行业、来源和映射，导入资料，确认身份，审核、发布或撤回抽取结果；业务用户选择已启用的 profile，提出问题，读取正式回答与来源。

| 输入 | 处理 | 输出 |
| --- | --- | --- |
| 行业对象、属性、单位、关系和身份范围 | 校验并发布有版本的语义定义 | 供抽取、解析、查询和规则执行使用的语义契约 |
| 文本、Markdown、带强标识的 JSON 记录 | 原文归档、解析、抽取、来源绑定和验证 | 待审核候选；不会直接成为正式事实 |
| 身份裁决、候选审核与发布 | 范围校验、CAS、版本存储及 outbox | 已确认实体、发布属性/关系/规则及物化事件 |
| 业务问题、profile、查询上下文 | 运行时经 gateway 调用固定工具、收集证据 | 有预算与进度的 canonical run |
| 查询证据和 typed draft | 硬核验、按配置执行语义核验、发布同一版本 | 可读正文、限制、来源、核验状态与不可变历史答案 |

例如，合成巡检资料中 T-01 的 `inspection_due=true`、`inspection_exempt=false`，审核后的规则 R-T 明确给出 `inspection_required=true` 的结论，才有对应的业务推导。T-03 缺少豁免属性时应为未知；不能补成 false。规则条件不成立或例外成立，也不能自行推导“永远不需要巡检”。

## 功能与目前的验证边界

| 功能 | 实现内容 | 使用边界 |
| --- | --- | --- |
| 组件与 profile | 版本化行业、runtime、backend、transport、model 绑定；发布、preflight、activate | 工作台交互已测试；默认宿主的部署元数据和实际挂载仍待完整验收 |
| 来源与物理映射 | 来源注册/探测、对象和字段映射、受限语义查询编译 | 控制数据与客户业务数据库分开；不假定 DataOS 已提供本体能力 |
| 文档与抽取 | 原文/解析 span 归档；强标识记录的原生抽取；GenerationPort 产候选；Schema 与来源校验 | 模型未配置时不能假装抽取普通自然语言规则成功；模型质量需另行验证 |
| 消歧与发布 | 强标识/候选召回、match/new/reject/clarify/split、revision CAS、cannot-link | 相同名称不自动合并；正式查询只读已确认、已发布的数据 |
| 本体与规则 | 属性子投影、按实体实例化的有界规则、显式例外、类型/单位/结论校验 | 缺失、冲突、规则不适用与业务 false 分开表达；不支持的表达式须显式拒绝 |
| 物化与撤回 | 支撑依赖、当前投影、身份 split fence、outbox 消费、有效时间切片 | 独立来源按 OR 保留支撑；当前 dirty/fence 不冒充有效结果，缺历史快照不以当前头补历史 |
| 事实查询 | `ontology_lookup` 读取已发布属性事实，保留原 statement、schema、单位和来源 | 有界分页、cursor 与 revision；本轮正在补齐分页完整性进入答案核验的保护 |
| 运行调度 | 持久 dispatch、claim/续租、attempt/revision fence、取消与受控恢复 | 调用后崩溃不代表普遍 exactly-once；不能安全恢复的阶段应明确失败 |
| 模型决策 | JEV System One 的实际状态、typed 概率判断、每次调用共享预算；generation 独立端口 | 概率不是正确率；本轮测试使用受控 HTTP，没有据此验证真实模型质量 |
| 正文与溯源 | hash 绑定的数值/布尔/字符串/引文/规则断言、硬核验、正文持久化与来源交互 | 无语义核验时显式展示 `not_run`；旧 metadata-only 答案明确正文不可用 |

上表描述模块能力。默认宿主中哪些组合实际启用、哪些配置可替换，以及两个行业能否完整走通，以[本轮 SPEC](tasks/spec-main-core-product-2026-09-28.md)和最终验收证据为准。

## 为什么这样拆分

行业资产回答“对象是什么、字段是什么意思、身份如何确定、允许什么规则”；客户映射回答“这些概念在这个客户的哪张表、哪一列”。行业包不保存数据库地址、密钥或客户物理列名。换客户时可以保留同一套行业语义，换行业时也可以保留 runtime 和数据适配器。

```mermaid
flowchart LR
    I[行业语义与客户扩展] --> P[Profile 版本与可信装配]
    M[物理映射与来源配置] --> P
    R[Agent runtime] --> P
    D[数据后端与模型适配器] --> P
    P --> C[运行控制器与共享预算]
    C --> G[工具 gateway]
    G --> T[本体 / 数据 / 文档 / 联网查询]
    T --> E[归档证据]
    E --> V[草稿与核验]
    V --> A[正式正文与来源]
```

模型可选择的公共数据工具固定为 `ontology_lookup`、`data_query`、`document_search`、`web_search`。本地内置调用和 MCP 共用领域服务、授权及证据契约。领域计算通过版本化操作挂载；模型不能运行任意脚本，也不能直接发布答案。

Controller 拥有运行状态、收证循环、取消和共享预算。Template/Pi 等 runtime 负责实际执行策略，generation 模型负责抽取或生成，JEV 负责概率判断。把这些能力分别放在端口后，才能替换其中一个而保留其余部分。

最终回答也有独立门禁：先形成 typed draft，核验其实际值、字段、实体、单位、时间与引用，再发布同一 hash 的版本。草稿修改后必须重新核验。界面显示的进度事件与流式草稿不等同于正式答案。

## 两个可复用的合成行业示例

示例挂载清单位于 [index.json](platform/deploy/core/examples/index.json)。它列出行业 manifest、定义草稿、字段模板、原始资料、政策文本和独立的物理 mapping；没有预置身份裁决、发布事实、派生结果或答案。

| 场景 | 核心对象与规则 | 特意保留的边界 |
| --- | --- | --- |
| 交通设施巡检 | 设施、行政区域；需巡检且明确不豁免时应用 R-T | T-01 双独立来源；T-03/T-05 缺豁免，T-06 缺前提；来源撤回后的替代支撑 |
| 工业资产维护 | 资产、车间；运行达到 100 h 且明确不豁免时应用 R-I | 100 h 边界；另一来源使用 `asset_key`、分钟和 0/1 豁免标记；6000 min = 100 h，5999 min 低于阈值 |

它们是公开合成演示资料和本地假设，**不代表正式行业标准或真实监管政策**。示例单测已经通过真实文档解析器和原生抽取管线产生待审候选，并通过受控 generation 响应产生规则候选。实际宿主挂载、身份审核、发布、物理查询转换及最终答案仍须完整验收。资产格式和证据见[示例说明](platform/docs/core-synthetic-industry-example-assets-2026-09-28.md)。

## 本地准备与启动

需要 Node.js 22+、仓库锁定的 pnpm，以及已启动的 Docker Desktop。以下命令从 `platform/` 执行。本地 Core 使用独立 Compose project，默认端口为 API `3001`、Web `5174`、PostgreSQL `54330`。

```powershell
pnpm install --frozen-lockfile

$env:CORE_PG_PORT = '54330'
$env:CORE_POSTGRES_PASSWORD = 'replace-with-a-local-only-password'
docker compose --project-name ontology-core-local --file deploy/core/compose.yaml up --detach

$escapedPassword = [uri]::EscapeDataString($env:CORE_POSTGRES_PASSWORD)
$env:CORE_CONTROL_DATABASE_URL = "postgresql://postgres:$escapedPassword@127.0.0.1:$($env:CORE_PG_PORT)/ontology_core"
pnpm exec tsx scripts/prepare-core-db.ts
pnpm exec node scripts/dev-core.mjs
```

**当前默认 API 入口仍待接线验收。** 缺少 `apps/api/src/core-main.ts` 时，launcher 会报明确缺入口错误，不会伪报就绪。这段命令是本地部署的准备入口；不是当前产品已经能完整操作的承诺。

prepare 显式运行迁移，验证非 superuser、`NOBYPASSRLS` 的 `ontology_app`，并写入忽略提交的 `.env.core.local`。API 启动不会自动迁移；业务数据库与控制数据库也不是同一项配置。详细重启、端口、模型开关和故障处理见[启动说明](platform/docs/core-local-startup-2026-09-28.md)。

模型默认关闭。只有明确设置 `CORE_ENABLE_MODELS=true` 并提供 profile 所需的公司模型/JEV 服务配置时，才允许外部模型调用。密钥留在 API 进程，不传给 Vite。没有配置的模型能力必须在结果中显示缺失或明确 fallback。

正常停止 launcher 用 **Ctrl+C**；停止 PostgreSQL 并保留数据：

```powershell
docker compose --project-name ontology-core-local --file deploy/core/compose.yaml stop
```

## 目录与阅读顺序

| 目录 | 用途 |
| --- | --- |
| `tasks/` | PRD、SPEC、场景说明与实施验收契约 |
| `.autoresearch/issues/` | 本地任务卡、依赖、覆盖与真实 GitHub 编号映射 |
| `platform/packages/contracts/` | 公共端口、版本和运行时 Schema |
| `platform/packages/core/`、`application/` | 通用纯核、用例与运行/核验/发布控制 |
| `platform/packages/semantic-engine/` | 身份、规则、支撑、物化与本体语义服务 |
| `platform/packages/adapters/` | 数据库、runtime、模型、解析、检索及传输实现 |
| `platform/industry-packs/`、`platform/packages/extensions/` | 行业声明资产与独立领域计算 |
| `platform/apps/` | API、worker、Web 与具体装配入口 |
| `platform/deploy/core/` | 通用 Core 的本地部署和合成示例 |
| `platform/tests/`、`platform/docs/` | 契约/单元/集成/验收测试与验证、使用说明 |

先读[本轮交付 SPEC](tasks/spec-main-core-product-2026-09-28.md)和[独立验证记录](platform/docs/main-core-independent-review-2026-09-28.md)，再按需要读[PRD v0.2](tasks/prd-industry-semantic-agent-v0.2.md)、[SPEC v0.2](tasks/spec-industry-semantic-agent-v0.2.md)、[任务索引](.autoresearch/issues/INDEX.md)、[需求覆盖](.autoresearch/issues/coverage.md)、[执行交接](.autoresearch/issues/handoff.md)。开发与审查遵守 [AGENTS.md](AGENTS.md)。

家庭能源是一个独立业务场景，资料见[家庭充电储能说明](tasks/scenario-home-energy-hackathon.md)。它的设备、公式、策略或界面不构成通用 Core 的行业约束。历史演示原型也不构成代码、接口、数据库或测试兼容要求。

## 开发检查与交付记录

在 `platform/` 执行：

```text
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run boundaries
pnpm run build:web
```

`typecheck` 同时覆盖后端、Web 和 acceptance 项目。真实数据库/worker/HTTP 验收与受控模型单测分别记录；聚焦检查点存在重叠，不能相加成一次全量通过。真实付费模型质量、客户数据质量、任意历史重建和生产 SSO 不因本地测试而自动通过。

截至当前检查点，完整 TypeScript 检查通过；全 unit/contracts/UI 项目为 1,381 项中 1,380 项通过，支撑来源链回归正在修复。默认启动、正常原始导入至正式回答、两个行业替换、修改/撤回与重启等，仍以本轮最终验收为交付门槛。LOCAL 与 GitHub Issue 的对应关系以 [manifest](.autoresearch/issues/manifest.json) 为准。
