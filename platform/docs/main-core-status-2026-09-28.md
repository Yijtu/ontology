# main 通用 POC Core 状态盘点

日期：2026-09-28。检查对象：远端 main，固定提交 51c8cb43ee467422e81cda009e2f4f5163007946；本地 main、origin/main 与 D:/work/ontology-main-decoupling 的 HEAD 一致。该目录检出名为 feat/main-scenario-decoupling，内容与当前 main 相同。本轮保留 D:/work/ontology 功能分支及其中的用户改动，没有切换它的分支。

用户本轮明确：暂时搁置黑客松场景，**main 通用框架是重点和核心**。验收回到原定产品形态与 [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：按行业定义和客户数据组装，查询、抽取/消歧、可选语义推理、工具调用、强制核验，最终输出可读业务答案与来源。能源调度演示不是通用核心的完成标准。

本轮只盘点、审查和验证；新增本状态文件，未修改业务代码、合并、提交、push 或启动开发循环。

## 判断：模块层较完整，集成层局部打通，产品层仍未闭环

main 已经积累了真实代码与数据库验证：核心契约、语义定义与 mapping、文档处理、身份裁决、审核发布、有限规则与物化、工具网关、运行时、预算/取消、核验/发布、溯源和界面均有实现。

但当前 main **不是开箱可用的通用业务 Agent 产品**。几个最直接的证据：

1. 没有正式应用启动和完整依赖装配入口。API/Worker 是供宿主调用的工厂；package scripts 无 prepare:local/dev:local。前端构建成功不等于后端已启动并装好。
2. HTTP POST /runs 只调用 RunService.createRun，没有分派到 WorkflowController。创建成功不代表工具开始执行；测试另行直接启动 Controller。
3. PublishedAnswer 仅保存 ID/hash/limitations，未保存 blocks/claims 或可读正文引用；问答页因此只能显示发布元数据。
4. 审核发布后的实体属性和规则求值的事实格式不一致；真实文档候选尚不能直接形成可计算前提。
5. 已发布事实/身份/派生事实没有完整接入默认 ontology_lookup/data_query；受控 E2E 的固定 lookup/search 不能证明新导入数据改变了答案。

任务清单统计为 **78 done / 2 planned**，两张 planned 是 HA 读取和设备执行。它只反映旧任务卡状态，不代表产品完成 97.5%，也不代表通用核心只剩硬件接入。

## 通用能力现在做到哪里

| 层 / 能力 | 当前实现 | 已有验证 | 还缺什么 |
| --- | --- | --- | --- |
| 工程与架构边界 | TypeScript 工作区、contracts/core/application/adapters/apps 分层；行业声明和领域计算分开 | 依赖边界检查；非能源 UI 和交通 DuckDB 查询 | 新场景仍须宿主配置和验证，不能理解为任意未知插件自动安装 |
| 组件 / Profile / 来源 | 版本注册、能力预检、激活、运行固定清单、来源探测与权限 | 真实 PG store、CAS/版本和能力缺失测试 | 可运行宿主；UI 下拉选择未发布成实际 Profile；完整来源注册与配置流程 |
| 数据查询与 mapping | PostgreSQL/DuckDB，只读 direct SQL、typed semantic plan、单位/编码转换及 mapping-owned 标识符 | 实际双后端、本地/MCP、两套物理 mapping、交通概念查询 | 客户 mapping 主要代码注入；没有持久编辑/发布的完整用户路径；不是任意客户 schema 自动识别 |
| 文档解析与检索 | 原始与规范化文本、精确 span、不可变工件、分块、BM25 | 真实 PG/blob/parser 和索引集成 | 用户上传/导入入口与部署；向量/混合检索、Milvus 等未实现 |
| 实体/关系/规则抽取 | 强 ID JSON 确定性对齐；GenerationPort 产候选；Schema/端点/单位/来源后验校验；待审核交接 | 真实 PG/worker/parse/blob，模型为固定响应 | 实际抽取提示没注入行业 Schema；真实质量、完整有效时间与部署装配未证明 |
| 消歧与身份 | 强标识、别名/上下文/可选相似召回；match/new/reject/clarify/split；CAS、cannot-link、历史 | 真实 PG/BM25、裁决和并发测试 | 召回未接审核/在线 resolve 主链；生产实例解析与身份簇一致性还有功能分支修复待回流 |
| 审核 / 语义发布 | 候选审核、身份约束、发布/修订/撤回、定义版本固定、outbox | 真实 PG 和 HTTP 审核发布 | 属性事实表示与规则输入未对齐；已确认关系查询、规则执行能力检查未形成完整主链 |
| 规则求值 | 有限声明式子集、精确数量/单位、AND/OR 支撑、unknown/conflict、时态/历史、支撑 DAG | 纯函数场景和真实发布 store 测试 | 例外被忽略；not/relation/部分 any 发布与执行能力不一致；真实实体属性尚不能直接求值 |
| 增量派生物化 | 依赖索引、受影响重算、invalidation fence、投影代次、撤回、历史和按需 fallback | 真实 PG/outbox/worker、崩溃重投、撤回与历史测试 | 单页 1000 输入截断；物化测试手工造标量 statement；派生结果没有完整接入四工具 |
| Agent runtime / 工具 | Template/Pi、固定四工具、local/stdio MCP、授权、预算、证据、取消 | 同一契约的替换测试；Pi 使用实际 SDK，模型受控 | 主应用未装配；RunPlanner/小计划/无进展检测尚未进入完整 Controller 运行路径 |
| NL2SQL 辅助 | 问题改写、Schema vocabulary、few-shot、SQL 生成提案、静态预检、核验失败回传、反馈记录 | 已有独立调用路径与测试，近期提交确实在 main | 未接默认 HTTP 主链；实际模型正确率、示例收益与问答效果未验收 |
| 核验与发布 | 共享预算、有界草稿修复、hash/verdict 绑定、取消后拒绝发布、事务门禁 | 单元和 PG 发布测试 | 缺业务答案正文；验收装配使用 Restricted 草稿/核验；精确 SQL 数值和时态核验需回流修复 |
| 溯源 / 历史 / UI | 五个通用视图、证据读取、依赖展开、历史比较、run 状态/预算/澄清 | 各自 API/PG/blob/UI 测试 | 来源配置、导入、业务答案和证据入口未接成完整用户路径；支撑读取同样有分页问题 |

四个公共数据工具仍是 ontology_lookup、data_query、document_search、web_search。本体关闭时保留 direct/检索路径的设计已经存在；并未交付模型自动判断所有客户数据、任意多跳推理或全行业自动建模。

行业资产成熟度也需要分开：家庭能源有 preview 定义；交通/汽车主要 planned 准备材料，医疗主要 preview preparation。交通查询测试证明核心能够承载另一行业，但不等于已经做出了成熟交通行业包。

## 两条关键链路及断点

### 在线问答

用户问题 → Profile 固定与 run 创建 **已实现**。

run 创建 → 调度 Controller/runtime **main 应用入口未接**。

Controller/runtime → 四工具/预算/证据 → 草稿/核验 → 发布 **有库层机制和受控装配测试**。

发布 → 可读业务答案 → 页面及来源 **缺正文契约与产品装配**。

源码：[HTTP 创建](../apps/api/src/http/server.ts#L107)、[RunService 组合](../apps/api/src/composition/run-service.ts#L64)、[Controller](../packages/application/src/workflow/controller.ts#L86)、[PublishedAnswer](../packages/contracts/src/workflow.ts#L273)、[发布服务](../packages/application/src/workflow/publication.ts#L214)、[问答页面](../apps/web/src/components/QueryPanel.tsx#L233)。

### 数据与本体

文档 → 解析/span → 抽取候选 → 身份裁决/审核 → 发布 **有各段实现和真实存储测试**。

发布属性 → 规则前提 **当前表示不匹配**。

规则求值 → 增量物化/撤回/历史 **有实现，但需要修例外、支持子集与分页**。

发布实例/派生结果 → ontology_lookup/data_query → 回答 **默认在线读取桥未接通**。

这条链路的下一份验收，应使“改动或撤回一份真实来源”确实改变后续工具结果及答案，而不只让所有模块分别返回成功。

## 核心修复与集成缺口

### K01 · 应用入口与可读答案：产品验收阻断

需要一个通用部署装配入口，注入来源、行业定义/mapping、runtime/model、四工具、durable Controller 状态及正式草稿/核验/发布服务。POST、澄清、恢复、取消都进入同一 Controller，不只编辑 RunService 状态。

发布正文必须与已核验草稿同版本绑定，持久保存并授权读取；不靠 UI 临时重新生成。重启后仍能读取同一业务答案和来源。

### K02 · P1：规则例外会被实际求值忽略

[rules/compile.ts](../packages/semantic-engine/src/rules/compile.ts#L23) 只编译 expression，不处理 exceptions。契约要求条件成立且例外不成立，见 [RuleExceptionNode](../packages/contracts/src/rule-extraction.ts#L88)。

**本轮直接运行 main 引擎复现**：主条件 ready=true、例外 exempt=true，已发布规则仍被编译并导出 known / true。应正确实现有限例外语义，或明确拒绝未支持规则，不能静默放宽。

### K03 · P1：实际发布属性不能成为规则前提

[SemanticPublicationService](../packages/semantic-engine/src/publication/publication-service.ts#L558) 产生 predicate=objectId、value={attributes}；[ruleFactsFromStatements](../packages/semantic-engine/src/rules/from-published.ts#L12) 只读取顶层量或 value.value，规则按 attributeId 查前提。

**本轮复现**：包含 ready=true 属性的真实发布形状投影后，仅剩 predicate=customer、无可比较 value；ready 规则得到 unknown。现有物化集成测试使用[手工标量 statement](../tests/integration/materialization-worker-postgres.spec.ts#L44)，不能覆盖这段转换。

需要定义可按实体、属性、单位、有效时间和记录版本求值的事实投影，并保留到原 statement/span 的支撑，不通过丢失结构来简化模型。

### K04 · P1：物化/支撑源只读首个 1000 条

[PublishedSemanticSource.load](../packages/semantic-engine/src/materialization/published-source.ts#L59) 单次取 facts 和 rule versions；真实 PG store 确有 LIMIT。没有分页或不完整标志时，超过边界可漏掉仍有效的替代支撑、规则及依赖。

需要有界分页与完整性传播；不可完整读取时降级/阻断，不能把不完整前提当完整集合重算。功能分支已有相关通用补丁，可优先检查回流。

### K05 · 规则发布与实际支持的执行子集不一致

抽取、Schema 校验及发布允许 not、relation、不同条件 any；编译器拒绝其中一些形式。PublishedSemanticSource 在一次 load 中编译全部规则，一条不支持规则就可能使整个 scope 加载失败。

将执行能力检查前移至发布/激活边界，unsupported 明确标 unhandled；或真正实现对应语义。保留有限规则范围，不需要为了通过用例实现完整 OWL。

### K06 · 行业 Schema 未进入实际抽取提示

[ExtractionPipeline](../packages/application/src/extraction/extraction-service.ts#L697) 发给生成模型的是通用 system 和 chunk.text；Schema 仅在结果返回后校验。真实模型无法从这些输入得知本次 objectId/attributeId/relationId 与规则语法。

需要注入固定版本的有界行业定义及输出契约。测试固定返回准确 ID，不能证明真实抽取能跨行业运行。功能分支已有 Schema 注入补丁。

### K07 · 实例/派生事实读取桥未完成

[OntologyLookupDependencies](../packages/semantic-engine/src/mapping/lookup.ts#L78) 有可选 facts provider，但 main 缺真实 provider 装配；entity resolve 明确未覆盖。DataQueryHandler 能按 mapping 编译 typed 查询，但没有完整连接身份、已发布事实、规则和物化结果。

优先复用功能分支的 published facts provider、身份绑定、cursor/完整性与版本固定。验证真实发布数据能通过工具被读到；不要用固定 lookup payload 代替。

### K08 · 规划与控制器的运行策略未整合

RunPlanner、小计划、NoProgressGuard 有模块和测试，但 Controller 主要是 rewrite→选择 runtime→collect；未证明 JEV 路由和重复无进展防护进入产品路径。Pi 仍可能重复相同调用直到预算耗尽。

默认规划 fallback 还有具体错误：[planning.ts](../packages/application/src/workflow/planning.ts#L354) 的 ontology_lookup 参数缺必填 scopeRef，真实网关不会替它注入。接线时需修复，身份仍来自可信宿主。

Controller.startRun 忽略 createRun 返回的既有 runId，相同幂等键但调用方新 runId 的重试会查询不存在的运行；见 [controller.ts](../packages/application/src/workflow/controller.ts#L86)。功能分支已有修复，不能在接 HTTP 时遗漏。

### K09 · 配置/导入 UI 尚不能完成全部实际操作

工作台组件下拉只改变本地 selection；[preflight](../apps/web/src/components/Workbench.tsx#L128) 和 activate 仍针对传入的 profileRef。换下拉未发布成新的实际配置。

来源页面主要列表/probe，导入页主要读已有 job/retry；注册来源与创建 ingestion 有 API/client 方法，但缺完整表单/上传与流程。应支持真实配置、导入、审核、查询和查看证据，不能只展示每个模块状态。

## 当前测试到底证明了什么

[LOCAL-054 报告](local-054-delivery-report.md) 列的试验规模是 1 文档、3 候选、6 行遥测。其真实 PG、parser、worker、controller、blob 验证有价值，但有以下边界：

- [acceptance 环境](../tests/e2e/acceptance/acceptance-environment.ts#L294) 的 ontology_lookup/document_search 是 RecordingHandler；[gateway 装配](../tests/e2e/acceptance/acceptance-environment.ts#L659) 没有读取刚发布的实例或真正文档索引。
- [Controller 装配](../tests/e2e/acceptance/acceptance-environment.ts#L751) 使用 RestrictedDraftWriter/Verifier、StaticInputValidity，workflow/verification 状态也包含内存实现。
- [测试启动运行](../tests/e2e/acceptance/acceptance-environment.ts#L841) 直接调用 controller.startRun；浏览器另有 seedRun/seedAnswer，不证明正常网页 POST→工具→业务正文。
- 替换测试确实用实际 PostgreSQL/DuckDB、stdio MCP、Template/Pi SDK；模型与部分工具输出为受控响应。可证明契约/边界，不能据此宣称模型业务质量。
- 主干已补 OpenAI-compatible codec，见 [codec](../packages/adapters/model-company/src/vendor/codec.ts)；旧 live Markdown 中 blocked 文字落后于代码，本轮未找到与最新代码对应的真实网关报告。协议修复、真实复测、业务质量三件事需分别记录。JEV 实际路由/校准未由本轮验收证明。

本轮在 main 相同提交上执行：

| 验证 | 结果 |
| --- | --- |
| lint / typecheck / build:web | 全部通过 |
| 核心定向单元与架构 | 12 文件 / 152 项通过：run、Controller、循环、改写、核验、身份、规则、物化、抽取、runtime、mapping 和边界 |
| 替换 / 跨层 | 5 文件 / 26 项通过：runtime、local/MCP、PG/DuckDB、异构 mapping、非能源交通查询和受控跨层验收 |
| 独立语义探针 | 复现 K02：例外成立仍导出 true；复现 K03：发布属性无法成为前提，得到 unknown |
| 未执行 | 全量/负载重测、真实公司模型/JEV、客户数据或设备调用、产品总验收 |

临时探针只运行 main 的实际纯计算引擎，没有改 tracked 文件，已移除。本轮测试容器使用命名测试卷与显式清理，不操作用户本地应用数据库。

## 下一步应围绕 main 做什么

按 poc-flow 将“核心优先”收敛成一条验收链；以下是建议，不是自动启动任务或合并授权。

1. **先整理通用补丁回流。** 从 feat/local-poc-core-20260923 筛选答案正文/claims、PG workflow store、幂等 run、数字/时态核验、已发布事实读取、身份/关系一致性、物化分页、抽取 Schema 注入等。逐批测试，不整枝携带能源 UI/设备模拟。
2. **交付通用可运行宿主。** 注册行业包、来源、mapping、模型/runtime 与 transport，启动 API/worker/Web；提供明确配置、迁移和使用说明。保持数据后端与控制/证据存储分开。
3. **证明一条真正的本体业务链。** 真实文档含两个实体、若干属性、一个关系、一条含例外规则；解析→受控模型抽取→身份/审核发布→真实工具读取→规则/派生查询→正式核验→正文/来源。模型可替身，数据、语义 lookup、规则输入和答案发布不能替身。
4. **证明变化与替换。** 撤回来源：替代支撑存在时保留结论，最后支撑消失时当前结果改变，历史可复读；再换第二物理 schema/第二行业，通用核心不改。
5. **再做真实模型与容量验收。** 对当前已运行主链验证公司模型/JEV、语义正确率、路由收益和数据量边界；需要时再加向量/其他后端，避免先扩充更多模块。

main 的下一个完成标准应是：**客户数据和版本化行业配置进入后，一个用户仅通过正常 API/UI 流程得到有实际业务内容、可核验来源、可响应数据变化的答案；替换场景及适配器不改框架。**

这能把已经写出的模块变成可复用核心产品，也能准确区分行业资产、客户 mapping 与一次性交付代码。
