# SPEC v0.3 A：通用双助手 Core

日期：2026-09-29。状态：实施规格；本轮只生成规格和任务，不表示新增能力已经交付。

输入：[A 通用 PRD](prd-generic-assistants-core-v0.3.md)，覆盖 A.US-001～016、A.FR-1～22，以及[总体 PRD](prd-ontology-and-business-assistants-v0.3.md)中归 A 的机制。A 与总体 PRD 的相同数字采用不同命名空间，不混用。

核对基线：main／origin/main 为 19c411e8db444e289e8c3ec0395ae909f2534601；文档所在工作区为 feat/electrical-costing-poc@b339b8f6a1167218becdd7b33d144c02660f43ce。通用研发工作线为 feat/core-planning-provenance@d17c7b520298703feb65f86761f34f1557927aca，存在未提交工作。以上为文档编写时快照，开工重新核对，不按目录名称推断分支。

## 1. 文档分工与交付顺序

| 文档 | 权威范围 |
| --- | --- |
| 本文 | 总体架构、职责、兼容策略、阶段门槛、测试和任务索引 |
| [资产、数据与公共前端](spec-v0.3a/asset-data-ui.md) | 工作区／项目修订、候选、发布包、mapping、解析／索引就绪、公共 UI 和挂载契约 |
| [执行、语义与证据](spec-v0.3a/execution-evidence.md) | task binding／输入与结果工件、规则／关系、runtime、typed 答案、核验、发布有效性与生命周期 |
| [B 造价 SPEC](spec-electrical-costing-mvp-v0.3.md) | 造价声明、客户价格与函数适配、专业 UI 和业务验收；引用 A 的通用契约 |
| [v0.3 任务批次](../.autoresearch/batches/v0.3-assistants/INDEX.md) | 本批任务、依赖、阶段、就绪与真实远程编号映射 |
| [逐项需求覆盖](../.autoresearch/batches/v0.3-assistants/coverage.md) | 两份 PRD 的每项验收条件／FR → SPEC、计划测试与任务 |

两个 A 分册都是规范组成，不能只按本文概述实施。既有 v0.2 SPEC 的依赖、授权、四工具、预算和核验原则继续有效；本版对新增行为和有限范围的明确定义优先，旧非目标不成为禁止用户新需求的理由。

交付路径固定：通用工作线按能力完成和审查 → 合入 main → 记录 A 整体已验收的主线提交 → 活动场景同步 → B 开发专属资产／适配／UI。客户资料核对可以提前进行，B 的专属代码不抢在 A 基线之前开工。场景发现的新通用缺口按同样路径回流，避免维护私有 Core。

## 2. 架构与必要解耦

### 2.1 决策

| 编号 | 决策 | 理由与代价 |
| --- | --- | --- |
| A-ADR-01 | 沿用 TypeScript 模块化单体、Fastify API、React/Vite Web 与现有 Worker | 不重建已交付审核、运行和证据系统；批量异步任务仍通过 jobs／outbox |
| A-ADR-02 | contracts、core、application、services、adapters、extensions、apps 继续按现有边界 | 可替换性由真实契约测试约束，不以一个 interfaces 目录代替 |
| A-ADR-03 | 行业声明、客户扩展、物理 mapping、动作实现、运行配置及场景 UI 独立 | 行业包可导出，不带客户原文、实时价格、连接信息或代码 |
| A-ADR-04 | 发布包动态目录与项目固定修订新增持久端口 | 现有静态 catalogue 和启动 DuckDB 样例不能满足用户新建包／新导入数据 |
| A-ADR-05 | 控制 PostgreSQL + 不可变对象存储；业务 DuckDB／PostgreSQL + BM25 | 复用现有后端，明确控制库与业务库角色；无需先部署向量库 |
| A-ADR-06 | 保留四个数据工具，compute 沿用 data_query 的版本化操作 | 不另造报价万能工具，不让模型执行脚本 |
| A-ADR-07 | 一个 Controller、一个 run manifest／ledger、一个被选 runtime 的收证循环 | 固定计划和动态补证共用预算、取消与同版本发布门槛 |
| A-ADR-08 | 新增 answer-draft@3 的表格工件绑定；@1／@2 继续可读 | 现有小答案 claims 上限不能覆盖 1001 行；通过分批完整核验解决，不放宽检查 |
| A-ADR-09 | 公共 UI 提供挂载契约，专业视图由应用组合入口注册 | React 类型留在 Web 应用；通用后端和公共页面不判断行业名 |
| A-ADR-10 | 内部验证与真实模型／客户质量分别记录 | 受控响应验证机制；不会被包装成真实模型准确率或合格报价 |

### 2.2 组件与依赖

~~~mermaid
flowchart TD
    UI[公共双助手 + 已注册场景视图] --> API[HTTP 认证与 Schema 校验]
    API --> AS[行业工作区／项目应用服务]
    AS --> STORE[控制存储端口 + 不可变工件]
    AS --> JOB[已存在的 Job／Outbox]
    JOB --> ING[解析／抽取／审核发布／项目投影]
    ING --> QRY[业务 SQL 数据快照与文档索引]
    API --> CTRL[WorkflowController]
    CTRL --> RT[已注册 Template 或 Pi]
    RT --> GW[统一 Tool Gateway]
    GW --> SEM[ontology_lookup：定义／事实／规则／关系]
    GW --> DATA[data_query：SQL 或注册 Compute]
    GW --> DOC[document_search：版本化片段]
    GW --> WEB[web_search：授权且已配置时]
    DATA --> QRY
    DATA --> EXT[版本化计算扩展与客户适配]
    CTRL --> DRAFT[同版本 typed 答案草稿]
    DRAFT --> VERIFY[硬核验 + 全部工件绑定]
    VERIFY --> VALID[依赖有效性与发布事务]
    VALID --> ANSWER[持久答案／表工件／证据／历史]
~~~

UI、HTTP、MCP 和 SDK 不能产生另一套发布判定。generation／decision 端口输出不可信候选；JEV 的概率不提升权限，也不等于答案正确率。

### 2.3 模块位置

| 现有位置 | 修改责任 |
| --- | --- |
| platform/packages/contracts/schema 与 src | 新 DTO／引用／端口／错误和生成类型；数据 Shape 运行时校验 |
| platform/packages/application/src | 工作区／项目／发布包编排、规划与工作流；不直接使用数据库驱动 |
| platform/packages/semantic-engine/src | 有限规则表达、关系查询、物化及 provenance 生产 |
| platform/packages/tool-services/src | 已注册任务／compute 与语义／查询／检索工具装配，保留可信 gateway |
| platform/packages/adapters | 控制持久化、业务物化／查询、模型、解析、BM25、runtime、local／MCP；SDK 不穿透 |
| platform/apps/api/src/http 与 composition | 新管理入口、normal run dispatch、已验收组件装配 |
| platform/apps/web/src | 公共双助手、client、mount 契约及有限 typed 组件；场景视图独立目录 |
| platform/apps/worker/src 与 migrations/control | jobs／outbox 的新处理阶段及追加迁移，不删除旧历史 |
| platform/tests | 独立合成样例、单元／集成／浏览器／真实替换测试 |

不要求为每个故事创建新 package；已有职责能承载时扩展原包。场景计算和客户连接仍通过独立扩展与适配器挂载，不能为了减少文件把它们放进通用包。

## 3. 版本、数据与一致性

### 3.1 固定引用

项目修订权威定义见资产分册。一次运行必须固定 projectRevisionRef、行业包／definition、mapping、资料修订／查询快照、taskBindingRef、inputSnapshotRef／digest、operation／handler／Schema 版本和 runtime／profile。

HTTP 可提交期望引用，服务端必须在认证范围内核实归属、修订、就绪与权限，然后创建不可变 execution binding，绑定到现有 RunManifest。请求 body 中的 tenant、项目名称、工具参数、上下文都不能替代可信 principal。

定义、输入、确认、价格等引用发生变化时形成新修订；旧运行和旧结果固定旧引用。读取历史内容与使用旧版本重新计算是两项能力，不支持固定版本复算时明确返回限制。

### 3.2 三种就绪与固定快照

项目分别记录语义发布、业务查询投影和文档索引就绪。表格已上传或实例已发布不等于对应 SQL／文档数据已可查询。任务契约说明需要哪些投影；不需要文档检索的计算任务不被无关索引阻断。

控制事务写批准修订和 outbox；Worker 在临时 generation／snapshot 构建并校验 coverage，成功后 CAS 激活对应修订。撤回／修订先设 fence，再更新投影；工具只读固定就绪 revision，不能退回启动样例或任意旧缓存。快照不受支持时返回 SNAPSHOT_UNAVAILABLE，而不是暗中切到最新数据。

### 3.3 迁移与兼容

现有迁移最大已提交序号为 056，另一个工作区存在未提交 057。V03-001 先核对 main、活动研发及 schema ledger；新增迁移按实际保留顺序分配，不在规格中占用会冲突的固定数字。

迁移采用追加表／列／索引和版本化 payload；先部署 reader／端口，再启用新 writer。旧 jobs、回答、证据和事实入口仍可读取。撤销启用通过 feature／profile 配置切回旧能力，不以 DROP 历史表作为回滚。具体表、主外键、唯一索引与 CAS 定义见两个分册。

## 4. API、动作与前端契约

### 4.1 API 风格

沿用 /api/v1、成功 data 包装、既有 PlatformError／failureBody、可信认证与 If-Match 数字修订。新增 endpoints 在资产分册给出精确请求响应，实施者须同步 HTTP Schema 和客户端解析，不能只通过 TypeScript 断言。

| 入口 | 本版行为 |
| --- | --- |
| 行业工作区／候选／发布包 | 新增草稿修订、资料、生成／编辑／验证／发布／导出入口；复用 definition 和既有候选审核 |
| 客户项目／mapping／资料／字段确认 | 新增项目级管理入口，保存固定修订、行 coverage 和三种就绪状态 |
| POST /api/v1/runs | 保留原入口与 facts 请求；新增可选项目／task／输入绑定，服务端固定 execution binding |
| runs 的 responses／cancel／events／answer | 保留 canonical runId、同 ledger；澄清恢复、事件、取消、最终回答按新能力扩展 |
| 证据／history／答案工件读取 | 新增受限分页读取 v3 已核验表工件与 JSON 导出；每次读取重验范围和可见性 |
| core/deployment／profile preflight | 报告实际可用任务、模型与执行／结果格式能力，不把注册声明当可执行 |

请求版本不兼容返回显式错误；不自动猜测缺少的 task、行业或参数。旧 facts 入口继续产生兼容答案，不要求既有调用者一次性迁移。

### 4.2 声明与执行分离

行业 action 声明描述 input／output Schema、前置条件、权限、证据／effect 需求和所需能力。部署 task binding 绑定已注册 operation、实现／Schema digest 与 runtime 约束。没有实现时行业包仍可语义发布，但任务状态为缺能力，不能产出正式计算结果。

compute handler 只收到固定输入引用、限定 reader／writer、operation limits、可信 ToolContext 和 AbortSignal。无文件系统路径、任意 URL、代码或数据库密钥字段。缺参和不完整是明确业务状态，不用默认值填平。

### 4.3 公共 UI 与场景挂载

业务入口先列出当前已挂载且授权的任务。通用 client／view 使用公共 DTO 和受支持 typed 展示，视图注册契约在 Web 应用内；UI metadata 可以声明 capability，不能在行业包注入 JS／React 模块地址。

专业模块负责表单、展示和导出布局；核心负责授权、执行、核验、工件、来源和生命周期。配置一个新场景只需声明／mapping／扩展和应用组合注册，公共双助手框架不新增行业 if 分支。前端表格字段读取同一已核验工件，不把原始 compute JSON 当正式结果。

## 5. 执行、推理、核验与错误

### 5.1 正常业务路径

1. 授权服务读取固定项目修订与当前任务可用性，必要时返回澄清或字段确认。
2. 创建时依据已预检 profile 和能力固定 runtimeRef、运行绑定与原 ledger。Template 执行已知路径／有限计划，Pi 支持根据新证据有界补查；同一 run 不切换 runtime，也不为改策略创建新账本。
3. 通过四工具及已注册 compute 获取实际项目数据，保存工具结果和来源；不让每个步骤重新选一次模型或重置预算。compute 先归档领域输出、无 gateway evidenceRef 的原始 output bindings 和 wrapper，gateway 归档 envelope 后，Core 才建立引用真实证据的 typed manifest。
4. 受信注册策略分别校验输入与结果，报告固定同一输出／结果 manifest；独立 finalization receipt 关联必需策略与结果，结果不反向引用报告。生成固定 receipt 的 answer@3 草稿，逐字段和分批表绑定硬核验；总行数、digest、列映射与 completeness 同时验证。报告缺失、失败、未知或不完整均不形成正式完整结果。
5. 发布前再次核对依赖有效性、权限、run CAS／dispatch fence。成功提交同一草稿、核验与工件版本，之后 UI 和 JSON 导出读取相同版本。

模型表达不另生成数值或规则判定；所有可见业务断言有结果绑定。证据和执行细化见执行分册，不用“LLM 检查答案”代替硬核验。

### 5.2 有限规则与状态

首批规则语法冻结在执行分册：有限比较／范围／缺失／AND、不同条件分支 OR、明确例外、一跳关系前提和三层无环依赖。关系导航最多三跳；不支持循环规则或关系无限展开。

模型提规则候选必须保留原条件与例外。支持校验失败可存草稿，但不能发布为启用状态。规则不产生正向支撑与业务命题 false 分开；未知和冲突保留。替代支撑撤回只更新受影响依赖，历史仍可回读。

### 5.3 统一错误与恢复

| 错误族 | HTTP／处理 | 用户恢复 |
| --- | --- | --- |
| INVALID_ARGUMENT／INVALID_SCHEMA | 400／422；不重试 | 定位字段或格式，修正后新修订 |
| VERSION_CONFLICT／IDEMPOTENCY_CONFLICT | 409；不机械重试 | 读取当前修订，展示差异；同 key 同 payload 读回原结果 |
| CAPABILITY_NOT_CONFIGURED／PROFILE_INCOMPATIBLE | 409；不冒称成功 | 显示缺少哪项能力／Schema／runtime；维护者配置 |
| INSUFFICIENT_DATA／DATA_CONFLICT／DATA_STALE | 既有映射；业务阻断 | 缺项确认、冲突裁决、等待固定投影；禁止转成空成功 |
| SNAPSHOT_UNAVAILABLE／CHECKPOINT_INCOMPATIBLE | 409；不换版本续跑 | 明确历史／恢复范围，用户另建运行 |
| RATE_LIMITED／SOURCE_UNAVAILABLE／MODEL_UNAVAILABLE | 429／503；有界 | 共享 deadline／ledger 内退避；缺模型时不伪装已生成 |
| BUDGET_EXHAUSTED／NO_PROGRESS／DEADLINE_EXCEEDED | 停止并持久化原因 | 显示已覆盖与缺口，不能无限补查 |
| VERIFICATION_FAILED／RESULT_TOO_LARGE | 422／413，记录位置 | 修复草稿仅限原预算；截断不发布完整表或完整结论 |
| UNAUTHENTICATED／FORBIDDEN | 401／403；不重试 | 不泄露另一范围的记录存在性或数据 |

新增更具体业务错误映射到既有规范 envelope 和 code catalogue，不私自返回裸 500。分类、指针／行号和操作建议可见，敏感详情不进普通 UI。

## 6. 限制、容量与安全

数据量未知，以下是有限配置起点，不是性能承诺；执行分册给出精确默认值与 preflight 条件。文件大小、压缩后展开量、行／列、片段、索引、批次、模型并发、工具和工件 bytes 均设 cap，达到边界显式 incomplete／reject。

至少 1001 行来自真实接入与审核链，后一页证据参与核验。控制表只保存 refs／counts／digests；原文和大结果存不可变工件。游标绑定固定 revision／scope，重复或倒退游标、generation 变化不得静默拼接。

所有 jobs、draft、mapping、query、index、model 输入、artifact reader、缓存和后台 worker 延续可信 tenant／space／project 约束。SQL 只读 AST／对象白名单与独立只读角色；文档内容和候选提示均是不可信数据，不获得工具权限。项目内密钥由部署持有，不写行业包、结果、日志或本批任务。

不额外自动调用实际模型／客户服务。对应真实资源条件由任务卡明确，实际执行授权、公司 API 和预算齐备后才运行质量测试。本阶段不涉及设备控制。

## 7. 验收矩阵

### 7.1 故事 → 技术与测试

下列 ID 为计划测试，不表示已经存在或通过。每个 AC 的具体测试与任务见逐项覆盖表。

| A 故事 | 规格责任 | 测试内容 |
| --- | --- | --- |
| US-001 | 资产分册 UI／mount | 双助手创建／切换／恢复、可用任务、模块挂载与错误态 |
| US-002 | 资产分册 parse／mapping | 四格式、工作表／列确认、位置、行对账、重复和失败 |
| US-003 | 资产分册 draft／candidate | 生成候选、专家编辑、同名语义、单位端点、动作绑定 |
| US-004 | 资产／执行分册 | 实际请求 Schema、精确值、身份、来源、关系候选及审核 |
| US-005 | 资产分册 publish／catalogue | validate、不可变导出／挂载、合成隔离与能力就绪 |
| US-006 | 资产分册 query generation | 刚批准数据可查、两 mapping、失败 fence、项目隔离 |
| US-007 | 执行分册 route／plan | 普通 NL、支持任务、歧义、修改确认、白名单编译 |
| US-008 | 执行分册 semantic | 不同条件 OR、一跳前提、三层 DAG、导航、unknown／冲突 |
| US-009 | 执行分册 provenance | 前提／规则／结论原文、digest、替代支撑撤回与历史 |
| US-010 | 执行分册 compute | 输入／实现 pin、调用、结果、缺能力、幂等和业务状态 |
| US-011 | 执行分册 answer／verify | 各 typed 证据、全表、同版本正文、篡改与发布有效性 |
| US-012 | 资产 index + 执行 quote | corpus 修订、BM25、来源引用、撤回、空结果与隔离 |
| US-013 | 执行分册 runtime | 正常分派、两策略、signal、共用预算、no-progress、澄清 |
| US-014 | 资产／执行生命周期 | 新旧修订、恢复、lost response、JSON 同版本导出 |
| US-015 | 两分册 + 架构套件 | 两行业／mapping、Template／Pi、业务 DuckDB／Postgres、本地／真实 stdio MCP |
| US-016 | 本文交付门槛 | 原始资料到候选／发布／任务／来源的整栈 E2E、反例、1001 行、main SHA |

### 7.2 FR → 技术责任

| A FR | 约束位置 |
| --- | --- |
| FR-1、2 | 资产分册公共双助手与场景组合入口 |
| FR-3、4、5 | 资产分册工作区／候选；执行分册规则支持校验 |
| FR-6 | 执行分册 task binding／注册动作／可信 compute |
| FR-7、8、9 | 资产分册抽取／审核／分类隔离 |
| FR-10、11 | 资产分册 published catalogue／project query snapshot |
| FR-12、13、14、15 | 执行分册计划／语义／完整性／provenance |
| FR-16 | 资产分册 generation、撤回 fence 与索引可见性 |
| FR-17、18 | 执行分册 typed verifier／publication transaction |
| FR-19、20 | 执行分册同 ledger／signal／dispatch fence |
| FR-21、22 | 两分册历史／published artifact／JSON 导出 |

### 7.3 独立金标与真实替换

沿用[Core 独立验收](acceptance-main-core-product-2026-09-28.md)的交通和工业语义，补不同条件 OR、受限关系前提、合成确定性动作和包生成预期。测试期望由资料／规则和确定性算例独立推导，不复制实现算法。示例计算标记 synthetic，不称客户报价。

单元可用替身；最终验收必须实际 UI、HTTP、Controller、Worker、控制库、业务后端和对象工件。两 runtime 的共同支持任务分别经过 gateway；两个业务后端执行同语义 mapping；MCP 是真实 stdio 进程，不能用 mock RPC 证明替换。控制 PostgreSQL 不算第二个业务查询后端。

真实模型评测单独报告 API／模型版本、参考集、候选错漏、消歧与人工修改。资源未满足时如实记录未验证及能力成熟度，不能用受控结果宣传抽取质量。客户金额质量在 B 验收，不能由 A 替代。

## 8. 任务、阶段门槛与合入 main

### 8.1 任务依赖

权威依赖是[本批 manifest](../.autoresearch/batches/v0.3-assistants/manifest.json)。本批 A 为 V03-001～047，B 为 V03-048～072；V03 本地 ID 不等于 GitHub issue 数字。旧 .autoresearch/issues 和现有 .loop-state.json 不被覆盖。任务卡给出范围、具体输出、失败行为、验证命令、复用检查及逐项 PRD AC。

先执行 V03-001 的主线／WIP／旧任务核对，再固定公共契约。资料／建模／项目就绪、查询／规则／动作／typed 发布、公共 UI 依依赖交付。不存在“整个实验分支都完成”这个隐含依赖；每张卡开工先核对已经合入的能力，能复用则只做缺口。

### 8.2 A 的完成门槛

- 公共双助手完整正常路径可操作；真实新发布包可挂载，实际导入记录可查询。
- 明确范围内 NL、规则／关系、文档问答与注册计算任务形成已核验、可溯源、可回读结果。
- 全表和 1001 行、权限、撤回、错版本、缺值、取消、幂等、重启及真实替换验收通过。
- 受影响单元／集成／浏览器／架构检查、lint、typecheck 通过并完成独立审查；迁移与部署说明清楚。
- README 对可用、受限、未配置／未验证逐项说明，保存执行证据；通过 PR 合入 main 并记录实际提交 SHA。

工程检查在 platform/：pnpm run verify、pnpm run boundaries、适用 pnpm run test:acceptance／test:e2e 和浏览器测试；已有脚本覆盖范围按源码核对，不假设名字代表全部 UI 已跑。容器测试只管理自建容器和命名卷，不做全局清理。

### 8.3 向 B 交接

V03-047 输出阶段 A release record：mainCommit、迁移清单、contracts／answer／runtime 支持版本、schema／task capabilities、测试／审查证据和已知限制。造价分支经 V03-051 用普通 merge 同步主线，证明包含该提交并跑受影响回归；未经这个门槛，B 的专属代码卡保持等待。V03-048～050 为可提前开展的外部资料核对，不实现场景代码。

本批发布远程 Issue、提交或启动实现循环不是“规格已完成”的组成推断，按用户当轮授权执行。当前请求包含 SPEC 与任务创建，不包含运行实现循环、模型调用或合并未完成代码。

## 9. 假设、风险与外部条件

- 电气桥架与图纸量算的业务澄清仍在 B；A 以交通／工业合成样例独立验证，不受其阻断。
- WIP 模块仅按静态核对复用，迁移号、claim 能力、历史／validAt 和正常入口集成必须重新验收，不能以源文件存在宣称已完工。
- 未知数据量通过有限限制和实测处理；部署 cap 变更需 preflight 和同契约回归，不自动承诺性能或无限深度。
- 公司实际模型端点与评测预算由部署环境提供；无 JEV 时可走明确策略，不降低硬核验。联网搜索只在授权域名与来源已配置时可用，未配置状态必须可见。
- 新表、answer@3 和动态 catalogue 是兼容风险较高的交付点，分卡完成 reader／writer／migration 与负向测试，不能只改页面绕过。
