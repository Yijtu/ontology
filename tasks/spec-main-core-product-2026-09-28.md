# SPEC：main 通用 POC Core 可运行交付

日期：2026-09-28。用户已授权“出方案然后让 GPT-6 Luna max 实现”。基线 main@51c8cb4；实施分支 feat/main-core-product-20260928，目录 D:/work/ontology-main-decoupling。实现者使用 gpt-6-luna / max；根代理独立审查和验收。

需求来源：[PRD v0.2](prd-industry-semantic-agent-v0.2.md)、[SPEC v0.2](spec-industry-semantic-agent-v0.2.md)、[main 状态盘点](../platform/docs/main-core-status-2026-09-28.md)，以及用户明确的“行业包、Agent runtime、数据库可挂载，换场景框架不改”。DataOS 只作为数据中台，不假定其本体能力。本文覆盖状态盘点 K01—K09，优先使既有通用模块形成可用产品。

## 1. 交付目标、边界与决策

交付一个可本地启动的通用应用：operator 注册/选择行业定义、来源和物理 mapping；导入文本/Markdown 或强键结构化记录；抽取待审核实体/关系/规则；确认身份、审核发布；业务用户从 API/UI 提问；同一正式 run 调用真实查询/本体/检索/规则服务，核验并发布可读正文与来源。数据修订或撤回影响之后的结果，历史答案仍可复读。

| 决策 | 实施选择 | 原因 |
| --- | --- | --- |
| 通用主干优先 | 从现有功能分支选择移植通用补丁，不整枝合并 | 避免能源仿真、Clarity UI、固定设备/公式侵入核心 |
| 运行时 | 保留 Template/Pi；业务策略由 profile 和版本化计划选择 | 不重新选重型 Agent 框架，不把计划/loop 等同于更换内核 |
| 存储 | PG 控制/审核/证据/运行状态；PG/DuckDB 业务查询；BM25 文档 | 复用已验证实现；业务库与控制库保持独立 |
| 模型 | 可配置公司 GenerationPort；JEV DecisionPort 可选 | 模型不可用时明确能力与降级范围；模型输出只作为候选/草稿 |
| 行业样例 | 交通设施巡检 + 工业资产维护，明确合成业务数据 | 验证不同对象、属性和物理 schema；避开能源设备交付范围 |
| 规则 | 按实体实例化有限规则，支持明确观测上的有限例外 | 不忽略例外，不从未找到值推断否定；不建设通用 OWL 引擎 |
| 用户入口 | 正常 HTTP/UI 驱动 Controller 和 Worker | 不再靠测试直接启动 Controller/seed 已发布答案证明完成 |
| 本地环境 | API 3001、Web 5174、PG 54330，均可配置，独立 compose project/命名卷 | 保留现有 3000/5173/54329 应用与用户数据 |

可暂不部署的组件：Milvus/向量、StarRocks/Iceberg、S3、MCP HTTP、真实设备、完整任意文件格式与全自动未知行业建模。保留对应端口和明确未配置状态，不伪装已经支持。不训练或自部署模型；不默认调用聊天中出现过的密钥，不把密钥写入文档、fixture 或 Git。

实现在分支上形成可审查提交。本轮不修改能源工作树和用户 issue-048；未经新的明确指令不直接覆盖远端 main。

## 2. 架构与装配边界

沿用 AGENTS 与依赖检查：contracts 只放公共数据/Schema/端口；core/application 不依赖 DB、SDK、HTTP 或行业包；semantic-engine/tool-services 接收端口；驱动在 adapters；具体部署和可信组件选择在 apps 的 composition。

需要以下通用装配职责，可按现有文件组织拆分，不强制新增 npm 包：

- DeploymentManifestLoader：读取并运行时校验行业定义、客户扩展、mapping、来源、runtime/model、策略及工具绑定，禁止可执行脚本和客户端密钥。
- Source/Mapping resolver：只从已授权绑定解析物理对象和精确版本，不接受模型裸表名绕过白名单。
- Workflow host：组装持久 store、Profile/RunService、Controller、runtimes、gateway、draft/verifier/publisher、worker/outbox；管理启动、取消与关闭。
- Published semantic read bridge：连接已确认身份、已发布实例/关系/规则、派生投影和来源。定义关系与实例关系区分；有界读取与完整性明确。
- UI：通用五视图、任务/上下文字段从部署描述驱动；专属展示经 contribution 挂载。

行业定义、物理 mapping、样例数据和固定任务位于行业声明或部署目录。application/core 不出现 facility、asset、site-demo、virtual-solix 等业务 ID/对象判断。新增行业只增加配置/声明及必要适配器，不改主流程。

**保留 main 的最后解耦改动**：main@51c8cb4 的 QueryContextField/deployment 注入不在 donor 功能分支；移植答案/任务描述时不能整文件覆盖而丢失它，也不能复制能源 branding 到共享 App。

## 3. 通用补丁回流

Donor 为 feat/local-poc-core-20260923@37f3feb；仅作代码参考。实现者先记录移植清单、依赖、迁移和行为变化：

1. PublishedAnswer 正文/blocks/claims、精确非数字 assertion、正文 hash 与 PG 持久化。
2. PG workflow/input-manifest/verification store 与通用迁移；跨重启读取。
3. Controller 使用 canonical runId 的幂等修复；严格数值/单位/时间核验；原文引用核验。
4. 已发布 facts provider、cursor、定义 pin、结果/source 摘要绑定、身份/关系端点与并发簇约束。
5. 物化/溯源的有界分页及完整性错误；候选抽取行业 Schema 注入和模型计费归属。

不能把 donor 的“拒绝 rule_judgement / 所有 exceptions / 多 subject”当作规则业务链完成。安全拒绝可作为中间状态，但本 SPEC 的有限规则和已确认多实体查询必须有正例。不能把固定 task handler 返回值、SQL 来源替换或静态关系图称为自动本体推理。

迁移编号检查本仓库现有编号与 donor，避免同号不同 SQL；只追加迁移，不删重建用户库或改历史已发布工件。

## 4. 文档接入、抽取和身份

### 4.1 输入和任务

提供有授权的 operator 文档导入 API/UI；文本/Markdown 首版有界支持。大小/分块限制从配置与服务能力声明，超限有明确错误，不静默截断后宣布完整。

导入原始工件、来源版本、parse、span 和任务；解析/抽取/校验/awaiting_review 由实际 Worker 驱动，支持幂等和按阶段恢复。按指定 job claim，不能因为并发而处理另一个 job 后误报本 job 完成。

配置模型时非结构化 span 走 GenerationPort；未配置时保留强键 JSON/native 路径，非结构化文本明确 NOT_CONFIGURED，不编造候选。自动抽取不自动高影响发布。

抽取 prompt 必须注入固定 published schema 的 object/attribute/relation/单位/身份范围及有限规则语法；响应受 Schema、来源 span 与版本校验。模型、重试、worker 共享同一背景 budget/accounting owner，不双重计费。

### 4.2 消歧与发布

审核页面可实际获取范围内候选、调用召回、查看强标识/别名/上下文证据并裁决。名称相同不自动合并；native ID 必须有可信身份范围和审核/强键来源；多个候选、cannot-link、并发 revision 需明确处理。

发布关系以已经确认的实体身份为端点；保留 source candidate/parse/span、schemaRef、有效时间/记录版本。候选在未审核/未发布时不能进入在线 fact/rule 查询。

## 5. 属性事实、规则、物化和在线语义读取

### 5.1 统一属性投影

保留原发布 statement 不可变，在读侧形成可求值的属性事实投影，或使用等价的版本化属性断言存储。必须带：

subjectEntityId、objectId、attributeId、canonical scalar/DecimalQuantity、单位、有效时间、recordedSeq、状态、原 statement/version、sourceRefs 和 provenance。

属性缺失是 unknown；不能填 0/false。数字在边界规范化为精确十进制字符串并保留单位。每个属性的稳定逻辑标识支持跨来源 OR 及修订/撤回，不能把独立来源混成同一个覆盖记录。

### 5.2 按实例的规则语义

按 rule.objectId 与 subjectEntityId 实例化规则；每个规则实例只读取该实体/适用范围的事实，结论键包含实体、谓词、有效时间/口径及规则版本。不能把甲实体温度与乙实体豁免组合出全局结论。

首版至少支持有界 all、same-condition any、compare/range；明确观测/完整范围中的有限 not，以及附着 exception 条件。exception 语义为 condition AND NOT exception：
- 主条件成立、例外明确不成立：可以 true。
- 例外成立：该推导不成立；不能把旧 true 留在当前投影。
- 例外缺失/冲突：unknown/conflict，不能当不成立。
- 同一结论还有其他合法规则/来源：按 OR 支撑保留有效结果。

不支持的 relation premise、混合任意 OR、递归或不能完整表示的否定，在发布前以同一执行能力检查明确拒绝/标 unhandled，保留候选和来源；一条不支持规则不能使整个 scope 现有合法规则失效。不得只删 exceptions、放宽条件或缩小验收去通过。

### 5.3 物化与读取

实际 publication/outbox/worker 推进物化，投影 dirty/fence 时降级/按需确定性读取，不能返回 stale 为当前有效。分页用稳定 scope/version/as-of 与 cursor；超过 configured total cap 显式 INCOMPLETE，不当全量读取成功。覆盖超过 1000 statements 和多 rule versions 的反例。

ontology_lookup 真实读取定义/mapping/已确认实体/发布关系/属性和派生 fact；data_query 的受限语义子能力可返回具体事实、确定性规则结果或编译物理查询。沿用四工具，不新增第五个公共自由工具。语义读取、实体解析、关系路径和计算都按 profile 的版本/权限/预算限制。

对规则结果归档确定性证据：原规则版本、实体、输入事实/支撑、有效时间、结果状态/值、完整性和计算摘要；typed rule_judgement 核验必须比较该工件/必要复算，不接受模型说“规则成立”作为依据。

## 6. 运行与模型决策

### 6.1 HTTP 驱动的唯一运行链

POST /runs 解析认证、幂等请求及 profile 后由 host 调度同一 Controller；返回 canonical runId/状态/event URL。同 key 同请求重试不重开预算或重复执行；不同请求冲突。

澄清、resume、cancel 都到 Controller，保留 If-Match、同一 budget/manifests 和 AbortSignal。PG store 持久化；restart 后可读已发布正文/证据和恢复支持的检查点，不能假装支持跨 runtime checkpoint。

后台调度必须有限并发、有界队列与生命周期；取消后的迟到结果不发布。运行 dispatch/checkpoint 可通过已有 job/outbox 实现或简单可审计 host executor，不搭新微服务。

### 6.2 路由、小计划和循环

指定任务/固定合法计划可零模型执行；普通复杂问题通过 RunPlanner 的固定词表提出有界计划；未知依赖进选定 runtime 的唯一循环。该策略真正进入 host/Controller，不只导出类。

所有工具参数的 scope 由可信 host 注入，默认 plan 不漏必填 scopeRef；模型不能提高权限。对相同规范化参数、绑定版本和结果签名执行无进展检测，达到阈值结束/clarify/limited；不能仅等待总预算耗尽。

无 generation/decision 的本地部署可使用明确注册的任务和有限确定性路由。问题不匹配任务时给 unsupported/clarification，不把任意问题默认为 SOC 或其他预设答案。

### 6.3 JEV 与公司模型

JEV 仅为必要不确定点提供概率判断；计算、权限与发布门禁仍在代码。generation 与 decision 分端口。

JEV 适配器按当前官方 [API](https://docs.typesafe.ai/api) 实现 POST /v1/systemone：实际 state、model、typed questions 映射到 answers/概率/usage。适配器内转换到平台契约；支持原私有 wire 时必须显式配置，不能默认发送猜测的 /v1/decide 形状。

state 由授权的有界 provider 从 stateRef 解引用，包含实际问题、候选 route/tool、已确认语义和有关证据；不是只发 hash 或 claimId。状态与问题准备参考 [State](https://docs.typesafe.ai/concepts/state)、[Choice](https://docs.typesafe.ai/primitives/choice)、[意图路由](https://docs.typesafe.ai/patterns/intent-routing)。概率不等于答案正确率；未校准阈值不能标已验证。

外部 endpoint/key 未配置时显示能力缺失或策略允许的明确 fallback；不能偷偷外发私有来源，也不自动使用过去聊天密钥。代码验收用真实服务端口背后的受控 HTTP model，验证线上会发送实际 state、重试/取消/usage 处理；真实网关质量留作明确 external acceptance。

## 7. 正文生成、核验和溯源

PublishedAnswer 增加版本化可读 blocks/claims 或授权可读的 immutable draftRef；优先移植 donor 的同 hash 正文持久化。旧元数据-only 历史答案读取明确 body unavailable，不伪造正文。

DraftWriter 从实际 evidence 生成/组装正文与 typed assertions：数值、布尔/枚举/实体列表、精确引文和规则判定。无生成模型的合法固定任务可以确定性组装证据结果；任意自然语言的生成仍需配置模型，不以通用静态摘要代替问题答案。

每个关键断言带 subject、predicate、单位/口径、有效时间、来源/evidence、result pointer 或 rule computation ref。硬核验比较实际结果；SQL DECIMAL 字符串精确处理；时间断言无 timePointer 时拒绝；原文引句必须与精确 span/digest 一致；定义关系不能当实例事实；未知/不完整不能发布普通已知结论。

通过的同一草稿版本发布，任何修改再核验。前端展示正文、事实/规则/未知限制、可展开来源和历史。去掉仅 ID/hash 的业务结果体验，保留审计信息供展开查看。

## 8. 本地部署与可用 UI

提供 Node/pnpm/Docker 下可复制的安装、迁移、启动与停止命令；服务 readiness 与分类错误清楚。使用独立本地 compose project 和命名卷；测试容器 teardown 同时回收卷。不会删已有能源数据库或 reset 用户文件。

核心配置 UI 必须真正发布所选组合的新 profile，再 preflight/activate，不能下拉只改 React state。提供部署允许的 profile/任务及上下文字段描述；替换行业字段从配置挂载。

operator 来源注册/探测、文档导入、候选召回/裁决/审核/发布/撤回通过正常 API/UI 完成；业务用户默认只读查询，operator 管理动作有独立权限。本地 loopback demo 身份明确标注，不宣称生产 SSO 完成。

README 描述产品形态、组件装配、输入输出、首个示例、第二场景挂载步骤、模型可选配置、失败路径、来源和已验证限制。含代表请求/响应和确定性推理来源示例，不只列开发命令。

## 9. 验收矩阵（最终门槛）

| ID | 正例 | 必要反例/边界 |
| --- | --- | --- |
| A01 启动 | 新建独立临时库、迁移、配置→API/Worker/Web 就绪 | 未配置/连接失败分类明确，不默认触碰既有54329库 |
| A02 配置 | UI 选行业/runtime/backend并发布新profile，真实生效 | 版本/能力不兼容、未经授权来源、修改字段后仍用旧profile要失败 |
| A03 文档 | 正常上传→parse→模型/强键候选→awaiting_review | 超限、缺模型、并发job、重复导入、失败阶段重试 |
| A04 身份/发布 | 召回→证据裁决→审核→发布真实实体/关系 | 同名不同实体、未审核nativeId、并发簇、缺身份端点/跨tenant |
| A05 属性事实 | 实际候选发布属性进入规则输入和ontology读取 | 缺属性不变false/0，精确数值与单位，Schema/时间版本固定 |
| A06 例外规则 | 主条件true+例外false产生正确实体结论 | 例外true/缺失/冲突不得导出普通true；不同实体条件不得混用 |
| A07 规则能力 | 支持子集发布并计算 | 不支持规则发布前拒绝/明确unhandled，不拖垮scope |
| A08 增量 | 发布触发真实outbox/worker物化与查询 | 撤回一支撑但OR仍存→保留；最后支撑消失→当前unknown/失效，历史仍可读 |
| A09 分页 | >1000 facts、多规则版本和cursor仍完整 | 总cap/不稳定cursor显式不完整，不能静默漏前提 |
| A10 真实问答 | 浏览器POST正常run→真实工具→正式核验→正文及来源 | 不手动startController、不seed答案、不使用固定lookup/search替身 |
| A11 模型/路由 | 受控HTTP Generation/JEV向实际服务端口，JEV state含真实内容；单步/小计划/loop实际执行 | 无模型明确fallback；未知任务澄清；重复无进展停止；概率不绕过硬核验 |
| A12 正文核验 | 数值/布尔/枚举/精确quote/规则结果同版本发布 | 注入错值、错subject、错单位、错时间、错quote、错rule verdict必须阻断 |
| A13 生命周期 | 同key重试/澄清/取消/resume沿同run同budget | 新runId幂等重试、迟到结果、重复任务、副作用重放 |
| A14 重启 | PG持久状态与已发布正文/source restart后可读 | 旧metadata-only答案明确不足；不默默生成新正文 |
| A15 替换 | 交通设施与工业资产，两套异构物理mapping，通过同主流程 | 替换不修改core/application；无本体direct/keyword仍可用；local/MCP、PG/DuckDB契约保持 |
| A16 文档/范围 | README可按步骤实际运行，SPEC/报告反映实现 | 不以78/80卡或受控模型当真实业务质量/容量/外部网关验收 |

测试可控制 generation/decision 的响应，但禁止替换真实来源查询、ontology实例读取、属性投影、规则求值、materializer、硬核验和发布来凑 E2E。输入数据独立构造、期望由业务语义推导，不复制被测代码生成金标。样例规则标合成测试政策，不称行业标准或真实法规。

## 10. 实施顺序与提交边界

| 批次 | 内容 | 依赖/验收后继续 |
| --- | --- | --- |
| C0 | 读donor补丁，记录移植清单；确认边界和迁移 | 不整枝merge；保留main部署字段解耦 |
| C1 | 正文/typed assertions/PG workflow+verification/幂等/精确核验 | A12/A13/A14有关定向反例通过 |
| C2 | Schema抽取/身份关系/属性投影/有限例外规则/分页/读取桥 | A04—A09；真实publication→规则→query正例 |
| C3 | 通用host、四工具、worker、Controller路由/生命周期、optional模型/JEV state与协议 | A01/A10/A11/A13 |
| C4 | 真正配置/导入/问答UI、二行业部署样例、README | A02/A03/A15/A16；实际浏览器流程 |
| C5 | 独立review、修复、整合回归与完成记录 | 全部适用A01—A16；不得只报单测数量 |

每批形成可审查提交并同步本SPEC完成证据，最终在分支交付。新缺口如会改变范围，先记录并通知根代理；普通实现选择自行解决，不能因此停止全部工作。

最终验证：lint、typecheck、boundaries、完整 Vitest（容器并发受控）、build:web、全部浏览器 E2E、上述新的真实PG/HTTP/browser验收。性能和容量只报告所测样例与限制，不承诺无限数据。

根代理负责独立读代码、复跑关键验收和审查。完成记录区分：实现/测试、可运行演示、真实网关、客户验收；缺真实资源不冒称完成，也不妨碍交付本轮通用框架。

## 11. 本轮完成记录

### C0/C1 checkpoint（2026-09-28）

- 移植决策清单：[porting ledger](porting-ledger-main-core-product-2026-09-28.md)，提交 `cb29b0a`。
- C1 提交：`ac88da6`（答案正文/typed assertions、workflow/verification PostgreSQL store、CAS、canonical run id 与精确核验）。
- 独立验收金标：[acceptance-main-core-product-2026-09-28.md](acceptance-main-core-product-2026-09-28.md)，内容按原始数据起步、区分规则适用性与业务命题，并覆盖正文注入、例外、时态、隔离、分页与并发恢复。C1 不把金标中尚未执行的产品链标完成。

| 验证命令 | 结果 |
| --- | --- |
| `pnpm --filter @ontology/contracts run check:contracts` | 通过；DecisionResult Noul `probability` 字段已纳入 canonical schema 与生成类型 |
| `pnpm run typecheck` | 通过，包含 API/Web/acceptance TS project |
| `pnpm run lint` | 通过 |
| `pnpm exec vitest run tests/unit/draft-verification.spec.ts tests/unit/answer-publication.spec.ts tests/unit/workflow-controller.spec.ts tests/unit/answer-api.spec.ts tests/unit/feedback.spec.ts --maxWorkers=2` | 5 文件 / 60 项通过 |
| `pnpm exec vitest run tests/integration/workflow-store-postgres.spec.ts tests/integration/answer-publication-postgres.spec.ts tests/integration/ui-query-postgres.spec.ts --maxWorkers=1` | 3 文件 / 12 项通过；临时 PostgreSQL 使用命名卷并由测试显式回收 |

C1 确认了 V2 body blocks 只能引用通过硬核验的 claim/assertion，正文、claims、assertions 与 limitation codes 绑定内容 hash；自由 prose 或伪装成 limitation 的业务断言不能通过。十进制字符串按严格 lexical 和精确比较，predicate/column、subject、time 绑定均独立核验。PostgreSQL answer row 持久化正文，旧 metadata-only 行明确返回 `legacy_metadata_only`；workflow state 和 input manifest 使用 revision CAS，verification/manifest 不可变冲突会拒绝；Controller 使用 RunService 返回的 canonical run id 重绑可信 ToolContext。

C1 对应 A12 的模块和 publication 测试、A13 的幂等 run id / CAS 测试、A14 的正文持久化和 legacy 缺正文标记已有实现及测试。尚未完成的限制：持久 HTTP dispatch/lease/崩溃恢复、真正独立进程重启与端到端 UI 恢复留在 C3—C5；因此 A13/A14 尚不能标作产品级全量通过。A01—A11、A15—A16 仍按最终真实 HTTP/PG/browser 链验收，不从 C1 单测推断。

之后每批继续追加提交、命令结果、数字和限制；仅在所有适用 A01—A16 门槛实际验收后更新最终完成状态。

### C2/C3 持久读/调度与本地启动基础设施 checkpoint（2026-09-28）

- 提交 `4e9a0fb` 增加 identity scope read revision、PostgreSQL durable workflow dispatch（migration 054）、隔离 Core 本地启动配置/launcher（仅配置检查与显式 prepare）、公共导出及独立验收记录。
- 身份决策与真实 PostgreSQL store：`tests/unit/identity-decisions.spec.ts` + `tests/integration/identity-decisions-postgres.spec.ts`，2 文件 / 23 项通过；覆盖scope revision、实体 CAS、并发 match、事务回滚和 RLS。
- Dispatch store：`pnpm exec vitest run tests/unit/workflow-dispatch.spec.ts tests/integration/workflow-dispatch-postgres.spec.ts --maxWorkers=1`，2 文件 / 6 项通过（含真实 PG 4 项）；覆盖幂等动作、两个 claimant、lease expiry/reclaim、stale owner/attempt fence、取消、payload digest、RLS、预算账本不变。独立 dispatch 记录见 [workflow-dispatch-2026-09-28.md](../platform/docs/workflow-dispatch-2026-09-28.md)。
- 启动配置：`tests/unit/core-local-startup.spec.ts` 3/3；`node --test tests/unit/core-local-dev.test.mjs` 4/4；Node syntax、scoped ESLint 和 `docker compose ... config --quiet` 通过。prepare 实际执行于独立命名卷/临时端口的 `ontology_core`，首跑应用 25 migrations、二跑 0 applied / 25 current；`ontology_app` 为非 superuser 且 NOBYPASSRLS，无scope读取返回0行。测试临时脚本、`.env.core.local`、容器和卷已显式清理。证据与命令边界见 [main-core-independent-review-2026-09-28.md](../platform/docs/main-core-independent-review-2026-09-28.md)。
- 以上只验收身份读端口、调度存储和 prepare/launcher 本身。`core-main.ts`、HTTP 接收后持久 enqueue/崩溃恢复、host/controller lease fencing 与实际发布事务、API/Web readiness 未完成；不得据此标 A01、A13 或 C3 产品链完成。prepare 检查时的迁移只到 053，不代表后来 054/055 已对同一临时数据库验证。

### C2 发布事实、实体规则与增量物化 checkpoint（2026-09-28）

- 已完成并暂存：已发布的 attribute array 投影为保留 parent statement/schema/entity/精确单位/有效时间/source refs 的属性事实；同规则按实体隔离实例；例外四态与 business proposition status 分离，例外不适用不会输出业务 false；显式审核 consequence binding 绑定定义的同对象属性和类型/单位；撤回按 parent statement 扩展到所有属性 child dependencies；OR 支撑按实体聚合，分页和不完整来源显式保留。
- 验证命令：`pnpm exec vitest run tests/unit/incremental-materialization.spec.ts tests/unit/rule-published-instances.spec.ts tests/unit/materialization-outbox-consumer.spec.ts tests/unit/published-semantic-source.spec.ts tests/unit/rule-conclusion.spec.ts tests/unit/semantic-publication.spec.ts --maxWorkers=1`，6 文件 / 57 项通过。
- 根代理独立真实 PostgreSQL 验收：materialization-worker、incremental-materialization、publication-fence、identity-decisions 4 文件 / 14 项通过，覆盖 1001 个属性、例外 false/true/缺失、同实体替代 OR 支撑、逐条撤回、稳定分页、身份 split 与物化 fence/outbox 的事务原子性。
- 单测/PG结论只标 C2 模块门槛。原始输入经过真实抽取/身份审核发布再经普通 HTTP/四工具形成可读答案的完整链尚未验收；A04—A10 与跨两场景 A15/A16 不据此标完成。
