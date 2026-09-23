# LOCAL-071 对齐 NL2SQL 标准流水线（核对与差距登记）

> 本报告是 **只读审计**（task-graph 节点 LOCAL-071 / issue #150），逐项核对标准 Text-to-SQL 流水线在本项目的覆盖情况。
> 基线：`main` @ `32fc8b1`，分支 `feat/node-71`。本卡不改动任何产品代码、契约、迁移或测试；只新增本报告、卡片与 INDEX/manifest 状态。
> 结论以**当前代码**为准，不以文档中的历史描述为准。每个「已实现」都指向具体调用路径；每个「缺失」都写明搜索范围与未命中结果。

## 0. 结论速览

10 个环节中：**已实现 3**（5 生成、6 校验、9 执行），**部分实现 2**（2 召回/裁剪、8 失败回传），**缺失 5**（1 改写、3 Schema 构造、4 Few-shot、7 试执行、10 反馈收集）。

关键判断：

- 本项目没有「把 Schema/DDL 文本或 few-shot 示例拼进模型 prompt」的环节；`sql_proposer` 的 prompt 是固定的两条消息（静态 system + 原始问题），模型只被给予一个**宽松空对象 schema** 的工具声明。
- 语义路径把「表召回 + 字段裁剪」替换为「确认 mapping 解析 + 投影级裁剪」：模型必须自己给出 `conceptId/fieldRef/linkId`，编译器只在注入的确认 mapping 内解析，未知即拒绝。这满足「标识符只能来自 mapping」的**意图**，但不含「按问题从目录召回候选表并裁剪字段」的检索阶段。
- 试执行/EXPLAIN **不存在**，且 `explain` 被只读 SQL 子集显式禁止——这是与 SPEC 的**冲突点**，不能靠放开校验来「补齐」。
- 失败回传在**动态 runtime 循环内**存在（工具错误作为 tool result 回灌 transcript，模型可再提议）；但**确定性小计划路径**遇错即停，且核验修复循环并未把失败项回传给草稿模型。
- 反馈收集**完全没有**（`feedback` 在 packages/apps 下零命中）；`tests/load/` 的 correctness/false-pass 是离线评测，不是运行时反馈收集。

## 1. 逐环节结论表

| # | 环节 | 结论 | 证据（代码 file:line / symbol；规格章节 / FR） | 说明 |
|---|---|---|---|---|
| P | 用户问题 | 已实现 | `WorkflowController.startRun` → `runs.createRun`（`packages/application/src/workflow/controller.ts:82`）；`RuntimeInput.question`（`controller.ts:270`）；proposer 用户消息（`workflow/planning.ts:184`） | 问题原文进入 run 与 runtime；C6 `POST /runs` |
| 1 | 问题改写 | **缺失** | 问题原样使用：`planning.ts:184` `{ role: 'user', content: request.question }`；`runtime-pi/src/runtime.ts:135` `prompt: input.question`。搜索 `question.?rewrit|rewriteQuestion|reformulat|decontextual`（packages/apps 排除 node_modules）**零命中** | 无独立改写/消解指代步骤。动态 runtime 会把完整 transcript 交给模型（`stream.ts:90`），但那是会话维持，不是改写；proposer 只有单轮 |
| 2 | 表召回 + 字段裁剪 | **部分实现**（形态不同） | 语义解析替代召回：`semantic-engine/src/mapping/compile.ts:359` `UNMAPPED_CONCEPT`、`:105` `UNMAPPED_FIELD`；registry 为注入的扁平集合 `mapping/registry.ts:37-52`。投影级裁剪：`compile.ts:441-465`（仅投影请求字段）；`mapping/render.ts` 只 SELECT 投影列。模型可**主动**调目录：`data_query kind=describe` → `CatalogPort.listResources`（`tool-services/src/handlers/data-query.ts:461-520`；`data-postgres/src/adapter.ts:358-372`）；`ontology_lookup intent=resolve` 概念→源对象（`semantic-engine/src/mapping/lookup.ts:344-390`）。规格：C3（`tasks/spec-v0.2/contracts-api.md:64,71-75`） | 「按问题从目录召回候选表并裁剪字段」的检索阶段不存在；有的是确认 mapping 解析 + 投影裁剪。且模型只拿到宽松空 schema（见 #3），并未被喂候选表/列 |
| 3 | Schema 构造（动态注入） | **缺失** | 唯一的 SQL proposer prompt 是固定两条：静态 system + 原始问题（`planning.ts:176-190`）；`toolSchemas: ['data_query']` 只是工具 ID 列表（`planning.ts:187`）；厂商客户端把工具 ID 映射为宽松空 schema（`model-company/src/http-client.ts:118-136` `{type:'object',additionalProperties:true}`）；runtime system prompt 是静态常量（`runtime-pi/src/runtime.ts:44-48`）。`information_schema.columns` 仅在适配器 `#discoverResources`（`data-postgres/src/adapter.ts:556-604`）中查询，且只有模型主动 `describe` 才回传。搜索 `schemaText|injectSchema|ddlText|buildDdl` **零命中** | 没有任何「构造 schema/DDL 文本并注入 prompt」的代码路径 |
| 4 | Few-shot 示例检索 | **缺失** | 搜索 `few.?shot|fewshot|example.?retriev|example.?select`（packages/apps）**零命中**；无示例存储、无选择、无注入 | 无任何示例库或检索 |
| 5 | LLM 生成 SQL | **部分实现** | proposer 产出**语义计划**而非 SQL：`RunPlanner.#proposeCandidate`（`planning.ts:170-203`）+ `parseSemanticQueryPlan`（`planning.ts:271`）；SQL 由语义编译器生成（`compile.ts` → `render.ts`）。裸 SQL 路径结构上存在：`DirectSqlQueryPlan.sql`（`tool-services/src/handlers/data-query.ts:145-165`；schema `packages/contracts/schema/data.schema.json:156`），但无任何「要求模型写 SQL」的 prompt/示例/schema；测试中的 direct SQL 均为程序构造（如 `tests/composition/x02-x03-transport-backend-conformance.spec.ts:134`） | 模型产出结构化查询计划，平台编译成 SQL；「LLM 生成 SQL」字面意义上未闭环。规格：C4 `data_query` direct/semantic（`contracts-api.md:90`）、FR-25 |
| 6 | 语法 / Schema / 权限 / 安全校验 | **已实现** | PostgreSQL：`validateReadOnlySql`（`data-postgres/src/sql-validator.ts:665`）——真实 parser（`:674`）、单语句（`:685`）、根仅 SELECT/CTE/union（`:695`）、禁止语句集含可写 CTE/DDL/DML/`explain`/`attach`/`install`（`:48-133`）、函数允许表 + 危险/非 PG 表函数拒绝表（`:324-400,481-514`）、关系必须落在确认 mapping 且源已授权（`checkTableReference` `:516-548`）、参数绑定校验（`:606-622`）、声明对象一致性（`:624-648`）。`validate`（`adapter.ts:225`）与 `execute`（`adapter.ts:264`）都调用，execute 重新校验。只读独立角色：`withReadOnlySnapshot`（`adapter.ts:293`；probe 角色 `ontology_reader`）。DuckDB：`validateSql`（`data-duckdb/src/validator.ts:167`）、AST（`ast.ts`）、引擎禁外部访问（`engine.ts`）。语义路径标识符仅来自 mapping：`assertSafeIdentifier`（`compile.ts:30`）、值绑定 `render.ts:80`。规格：C3（`contracts-api.md:71-73`）、FR-26。测试：`tests/unit/postgres-sql-validator.spec.ts`、`tests/unit/duckdb-sandbox-validator.spec.ts` | 覆盖语法/schema/权限/安全四类；AST + 白名单 + 参数绑定 + 只读角色，非「检查开头 SELECT」 |
| 7 | 试执行（dry-run/EXPLAIN） | **缺失**（且与 SPEC 冲突） | 搜索 `EXPLAIN|dryRun|dry-run|dry_run`（packages/apps 排除 node_modules）仅命中 `sql-validator.ts:124` `'explain'`（在禁止集内），其余为 verification 模板方法名 `explain()`（无关）。无预检执行；首次真正执行即真实查询（`adapter.ts:293`）。`StructuredQueryPort.validate` 端口存在（`packages/contracts/src/ports.ts:146-150`）且适配器实现，但 `data-query` handler **从不调用**它，只靠 `execute` 内部重校验 | 无任何 EXPLAIN/等价预检。冲突见 §3-1 |
| 8 | 失败回传错误修正 | **部分实现** | 动态 runtime：错误结果渲染为 `error: CODE: message`（`runtime-pi/src/tools.ts:65-74`），经 controlled stream 折叠为 `toolResult` 消息回灌 Pi transcript（`runtime-pi/src/stream.ts:241-242`），SDK 循环据此再次调用模型；由共享预算与 turn 数兜底（`runtime.ts:334-368`）。确定性小计划：`NoProgressGuard.observe` 遇 `status==='error'` 直接 `stop`（`workflow/evidence-loop.ts:84-86`），不回传模型。草稿修复（FR-29）：`#draftAndVerify` 在 `drafting↔verifying` 间有界循环（`controller.ts:351-452`），计入共享 repair 预算（`:371-380`），耗尽走确定性有限回答（`:526-578`、`workflow/limited-answer.ts`）；但失败核验结果**未**进入 `DraftWriterRequest`（`:392-402` 只传 `deficits`），`lastFailure` 仅用于 fallback。`'repair'` GenerationRole 在 `model.schema.json:27` 定义但源码**从未使用**（仅 `sql_proposer` 被用） | 工具/SQL 错误在动态循环内可回灌；确定性路径遇错即停；核验修复有界但未把失败项喂回草稿模型 |
| 9 | 执行并返回结果 | **已实现** | `DataQueryHandler.#query` → `#executeQuery` → `StructuredQueryPort.execute`（`tool-services/src/handlers/data-query.ts:363-459`）；`PostgresQueryAdapter.execute` 在只读快照内执行，带 LIMIT/OFFSET 分页与字节上限（`data-postgres/src/adapter.ts:255-310`、`#runTracked:425-453`、`#boundResult:455-499`）；结果带 `SourceSnapshot`（digest/readAt/consistency），证据在成功返回前由网关持久化（`tool-services/src/gateway.ts:411-506`）。DuckDB 适配器同构。规格：C3.1/C4、FR-30 | 执行 + 来源快照 + 证据闭环完整 |
| 10 | 收集反馈 | **缺失** | 搜索 `feedback`（packages/apps 排除 node_modules）**零命中**。现有的只是 run/tool 证据与预算用量账本（计量，非质量反馈）；`tests/load/` 的 correctness/false-pass 是离线评测 harness（`tests/load/verification-quality.ts`），不是运行时反馈收集 | 无用户/执行反馈的采集、存储与回流。规格中无对应 FR（最近的是 US-024 离线评测） |

## 2. 逐缺口最小补齐建议（不扩大 core、不新增动态工具）

> 原则：所有补齐都必须落在**现有端口**上；新增上下文（schema/示例/召回结果）是**平台拼装后注入 prompt 的数据**，不是模型可选工具；不得新增动态工具、任意 SQL/eval，不得放宽只读/白名单/AST 校验。

1. **问题改写（#1）** — 归属 `packages/application/src/workflow/planning.ts`。在 `RunPlanner.route` 之前加一个有界的纯前置步：用**已注入的** `GenerationPort` 生成改写后的 `PlanRequest.question`，再走现有路由。不新增工具、不开新循环；调用计入共享预算（现有 generation 适配器已在 reserve/settle）。不扩大 core：planner 本就负责路由。若要独立 role，需走**契约版本化**另开卡，不在本卡范围。
2. **表召回 + 字段裁剪（#2）** — 归属 `packages/semantic-engine/src/mapping/`。对注入的 `SemanticMappingRegistry.list()` 做确定性、有界的词面/别名召回，返回候选 `conceptId/fieldRef` 与 `mappingRef`（**不含物理列名**），再把这批 ID 作为允许词表注入 proposer prompt。保持在 semantic-engine 内，不动 core，不新增工具；标识符仍由 mapping 拥有。
3. **Schema 构造（#3）** — 归属应用层 prompt 拼装（`planning.ts` 或一个仅依赖 semantic-engine/contracts 的小模块）。只用**已确认 mapping + 已发布定义**构造概念/字段/单位词表并注入 `GenerationRequest.messages`。这是数据不是工具；模型仍无法命名 mapping 之外的标识符。优先暴露概念/字段 ID 与单位，不直接抛 DDL/物理表名（与 C3 一致）。
4. **Few-shot 示例（#4）** — 归属 `packages/adapters/search-bm25/`（复用现有检索）或 semantic-engine 内的一个小示例索引；示例集由 `industry-packs/*` 声明（问题→语义计划对），检索确定性有界，top-k 注入 proposer prompt。属 prompt 上下文，**不是**模型工具。
5. **试执行（#7）** — 最小且**不冲突**的补齐：把已存在的 `StructuredQueryPort.validate` 在 `DataQueryHandler.#query` 中显式前置调用（当前被跳过），作为执行前的静态预检；语义侧已有 `assertBudget` 基数/传输量预检（`compile.ts:222-268`）。**不要**用 EXPLAIN（见 §3-1）。
6. **失败回传（#8）** — 动态 runtime 已有，保留。补齐点：把 `failedVerification.failedChecks`（及上一版草稿）传入 `DraftWriterRequest`，或使用已定义但未用的 `'repair'` role；仍受现有共享 repair 预算约束。因 `DraftWriterRequest` 是 canonical 契约（`packages/contracts/src/workflow.ts:118`），字段新增须走契约版本化另开卡。
7. **反馈收集（#10）** — 归属 `packages/application`（服务）+ `packages/adapters/control-postgres`（存储），经 `ControlRepository` 或新端口写入 append-only 反馈记录（用户接受/驳回 + 执行结果），保持 tenant/space 隔离，离线供评测。反馈是**数据**，绝不作为权限或自动发布信号。

## 3. 与当前 SPEC 的冲突点（不得静默改变验收口径）

1. **EXPLAIN 试执行 vs 只读 SQL 子集** — `explain` 明确在 `FORBIDDEN_STATEMENT_TYPES`（`data-postgres/src/sql-validator.ts:124`）；DuckDB 禁 `DESCRIBE/SHOW/SUMMARIZE`（`data-duckdb/src/validator.ts:51-53`）。C3 规定只读子集与 AST/白名单/参数绑定/只读角色（`contracts-api.md:73`）。**约束**：试执行只能是静态/AST + planner 基数预检，不得通过只读角色执行 EXPLAIN，不得放宽子集。禁止把「补齐试执行」当作「放开 explain」。
2. **为召回/Schema/示例新增工具** — SPEC 固定模型可选工具为四个（`contracts-api.md:85`，FR-7），`verify_result/final_answer` 是 controller service 不可作工具。**约束**：召回/schema/示例上下文必须由平台拼装注入 prompt；若确需扩展能力，只能扩展 `ontology_lookup` 的 intent（属契约变更，须版本化），不得新增动态工具。
3. **让模型选择标识符 / 生成裸物理名 SQL** — 与 C3 语义模式「标识符只能来自已确认 mapping」（`contracts-api.md:75`）及 `IDENTIFIER_NOT_FROM_MAPPING`（`compile.ts:30-37`）冲突。**约束**：保持标识符 mapping-owned，不得放宽 `assertSafeIdentifier`/白名单/allowlist。
4. **放宽 SQL 校验** — 与 FR-26/C3 冲突。**约束**：不得以补齐流水线为名放开 DDL/DML/可写 CTE/文件网络函数/任意 UDF。
5. **把核验失败回传给草稿模型** — `DraftWriterRequest` 是 canonical 契约（`contracts/src/workflow.ts:118`）。**约束**：新增字段须契约版本化，不能静默改验收口径。
6. **反馈影响发布/权限** — 与 INV-09（仅发布已核验同一版本）、D7.4 冲突。**约束**：反馈仅作数据，不能成为发布或权限的控制信号。

## 4. 未验证 / 超出本卡范围

- **真实模型行为**：无授权的公司生成/JEV 端点，CI 用确定性替身（`platform/docs/local-054-delivery-report.md:62-63`；`tests/unit/workflow-planning-fixtures.ts` 的 `CountingGeneration`）。因此「LLM 生成 SQL」的质量、问题改写收益、few-shot 收益**未验证**。
- **实机数据/HA**：LOCAL-052/053 仍未完成（`local-054-delivery-report.md:71-72`），不在本卡。
- **EXPLAIN 在真实后端的可行性**：不存在试执行，未做实测；且按 §3-1 不应引入。
- **本审计为静态审计**（读代码 + grep），未运行真实模型，未执行模型生成的 direct SQL 路径。
- 交付报告已声明的其它外部条件项（blob-s3、向量检索、StarRocks/Iceberg、MCP HTTP）与本卡无关。

## 5. 如何复现本审计

基线：`main` @ `32fc8b1`，`pnpm install --frozen-lockfile` 后于 `platform/` 执行：

```powershell
pnpm run verify        # lint + typecheck + test（本卡为 docs-only，应保持绿）
```

搜索（Windows + PowerShell 7；本环境未安装 ripgrep，故用 Select-String，并排除 node_modules）：

```powershell
$files = Get-ChildItem -Path packages,apps -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' }

# 试执行 / dry-run
$files | Select-String -Pattern 'EXPLAIN|dryRun|dry-run|dry_run' -CaseSensitive:$false
# 反馈收集
$files | Select-String -Pattern 'feedback' -CaseSensitive:$false
# Few-shot
$files | Select-String -Pattern 'few.?shot|fewshot|example.?retriev|example.?select' -CaseSensitive:$false
# 问题改写
$files | Select-String -Pattern 'question.?rewrit|rewriteQuestion|reformulat|decontextual' -CaseSensitive:$false
# Schema/DDL 注入
$files | Select-String -Pattern 'schemaText|injectSchema|ddlText|buildDdl' -CaseSensitive:$false
# 未使用的 repair role
$files | Select-String -Pattern "role: 'repair'|'repair' as" -CaseSensitive
```

预期（本审计实测）：`EXPLAIN` 仅命中 `sql-validator.ts:124`；`feedback`/`few-shot`/`question rewriting`/`schema injection`/`repair role` **均零命中**。

关键阅读点：

- `packages/application/src/workflow/planning.ts`（proposer prompt 与语义计划解析）
- `packages/adapters/model-company/src/http-client.ts:118-136`（工具声明为宽松空 schema）
- `packages/adapters/runtime-pi/src/tools.ts` / `stream.ts`（错误回灌 transcript）
- `packages/adapters/data-postgres/src/sql-validator.ts`（只读子集与 `explain` 禁止）
- `packages/semantic-engine/src/mapping/compile.ts` / `render.ts`（mapping-owned 标识符、投影裁剪）
- `packages/application/src/workflow/evidence-loop.ts` / `controller.ts`（确定性遇错即停、有界核验修复）

## 6. 交付报告验证结果

- `pnpm run lint`：通过（无输出）。
- `pnpm run typecheck`：通过（`tsc -p tsconfig.json && tsc -p apps/web/tsconfig.json && tsc -p tsconfig.acceptance.json`）。
- `pnpm run test`：通过，`Test Files 157 passed (157)`，`Tests 1618 passed (1618)`，Duration 219.73s。
- 本卡仅新增本报告并更新卡片/INDEX/manifest，未改动任何产品代码、契约、迁移或测试。
