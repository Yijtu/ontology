# v0.2 验证、覆盖与实施计划

入口：[总 SPEC](../spec-industry-semantic-agent-v0.2.md)。这是未来实施的测试规格；本轮仅校验文档完整性，没有运行应用测试、连接模型或设备。

## V1. 测试层次

| 层次 | 范围 | 是否使用真实外部能力 |
|---|---|---|
| Architecture | 包依赖方向、禁止SDK/DB/领域穿透、公共schema一致性 | 读取构建图，不需要模型 |
| Unit/property | 预算/状态、身份范围、时间区间、规则DAG、数值守恒 | 可控fixture与property-based边界 |
| Port contract | 所有适配器同一输入/输出/错误/取消/分页契约 | 测试时可用stub；不能据此宣称真实适配完成 |
| Integration | DuckDB/Postgres、真实stdio MCP、control事务/outbox、blob完整性 | 本地真实进程与数据库，隔离临时数据 |
| UI E2E | 配置→导入→审核→问答→核验→来源→撤回回放 | 确定模型响应模拟器，其他本地链路真实 |
| Model evaluation | 提取、召回、身份、路由、核验、回答质量 | 获授权后公司生成模型/JEV，保留输入与版本 |
| Load/fault | 大结果、并发、fan-out、断线、租约、取消迟到 | 限定负载环境，报告硬件与边界 |

CI 的fake生成模型和FakeDecisionPort用于稳定流程断言，不证明真实模型准确率、JEV校准或厂商性能。真实模型测试单独预算、显式运行；不能因用户曾提供密钥就自动消费。

测试金标直接来自当前规格与独立检查的领域样例。LOCAL-048 负责规格驱动的回归夹具，只依赖公共契约；算法与集成任务消费这些夹具并证明实现结果。CI 仅检出当前仓库即可构建测试输入，不读取历史演示程序、数据库或其运行结果，不要求通过原型的固定测试数量。

## V2. 必要解耦的验收矩阵

| 测试 | 替换变量 | 不得修改 | 通过标准 |
|---|---|---|---|
| X-01 | PiAdapter ↔ TemplateAdapter | 行业包、工具服务、数据映射 | 各自声明支持的单步/固定计划结果一致，证据契约和核验都生效 |
| X-02 | LocalTransport ↔ stdio MCP | 同一真实领域handler | 规范化数据、状态、错误、证据语义一致；超时与权限行为一致 |
| X-03 | DuckDB ↔ PostgreSQL 业务查询 | core/runtime/行业定义 | 两来源映射后同口径结果相等；不支持类型/快照显式报告 |
| X-04 | home-energy ↔ 无行业直查/第二声明包fixture | 应用执行/HTTP/UI主流程 | 能力按profile启停，没有能源硬编码；不宣称第二行业业务已成熟 |
| X-05 | 公司生成模型 ↔ controlled stub；JEV独立替换 | 工具/事实/权限逻辑 | 角色语义不混淆，typed错误/用量保留，降级可见 |
| X-06 | 设备样例命名A ↔ 样例命名B | home-energy公式和语义定义 | 仅改mapping即可产生相同规范输入与计算结果 |
| X-07 | profile v1 ↔ v2（新运行） | 旧run的版本清单/证据 | 旧run继续或显式无法恢复，不静默切内核/后端 |
| X-08 | 不兼容能力组合 | 所有安全和完成条件 | preflight列出缺项；不得自动扩大工具/联网/写入能力 |

至少 X-01/02/03 使用两个真实实现，不允许全由mock通过“解耦验收”。选择缩小场景时可少接一个第三方产品，但不能删除端口、契约或替换测试。首期不要求远程MCP、S3、HA-live、Milvus、StarRocks全部实现；未实现项显示 not_configured。

## V3. PRD 用户故事逐项映射

`A1/A2/...` 指 PRD 对应 US 内验收清单顺序。下列是实现测试名/检查范围，尚未创建测试代码。

| US | 覆盖验收 | 对应 SPEC | 测试与可观察结果 |
|---|---|---|---|
| US-001 | A1,A2 | C1、主文INV-01—04 | T001a非法manifest不注册；T001b模型/MCP发现未知包不加载 |
| US-002 | A1,A2 | C1/C6 | T002a缺必需能力预检失败；T002b UI显示就绪/缺项/降级并浏览器检查 |
| US-003 | A1,A2 | C1/C3、D3、E2 | T003a两来源映射同结果；T003b企业扩展不改核心/不导出私有实例 |
| US-004 | A1,A2 | C2、D7 | T004aPi开始/继续/取消事件；T004b工具只能gateway、SDK final不能发布 |
| US-005 | A1,A2 | C2、X-01 | T005a模板/Pi同任务结果；T005b不兼容checkpoint明确409且无行业代码改动 |
| US-006 | A1,A2 | C4/C5 | T006a四工具schema/错误/取消/证据；T006b模型目录不含发布核验绕过入口 |
| US-007 | A1,A2 | C5、X-02 | T007a真实data_query本地/stdio一致，其余共用契约；T007b注入额外工具/断线不变成结果为空 |
| US-008 | A1,A2 | C3/C6 | T008aprobe与实际能力对应；T008bsecret不进入UI/prompt/export，浏览器验证 |
| US-009 | A1,A2 | C3、D6 | T009a原库直查/预处理fixture均有来源；T009b坏行保留/重试幂等/不支持跨库明确拒绝 |
| US-010 | A1,A2 | D3/D4、C3 | T010aPDF/text定位与检索模式真实；T010b原文可打开、解析错不同空结果，浏览器验证 |
| US-011 | A1,A2 | D6、C6 | T011a杀Worker后按stage恢复；T011b发布不重复、任务状态准确，浏览器验证 |
| US-012 | A1,A2 | D4 | T012a抽取按schema输出且不改定义；T012b错类型/假引用不发布、强ID可确定映射 |
| US-013 | A1,A2 | D4/D5 | T013aAND/OR/例外/否定/单位fixture；T013b无法表达规则进入review不宽松执行 |
| US-014 | A1,A2 | D4/C6 | T014a同名/别名/时间/负例分组；T014b裁决修订可回看、浏览器验证 |
| US-015 | A1,A2 | D4/D5 | T015a未发布不可进入求值；T015b冲突、拒绝、修订 UI 与事务一致 |
| US-016 | A1,A2 | D5、E5 | T016aAND/OR、未知冲突和循环拒绝；T016b按需/物化同输入同结果 |
| US-017 | A1,A2 | D3/D5 | T017a替代支撑/最后支撑撤回；T017b处理中fence、双时态旧版本、证据独立于SDK |
| US-018 | A1,A2 | C2、D7 | T018a确定模板不调用JEV且复杂题默认一个计划；T018b未配置/不确定/降级不假造能力 |
| US-019 | A1,A2 | D7、C2/C4 | T019aSQL多跳/已知依赖/新证据loop；T019b重复/超限/取消/澄清恢复共享预算 |
| US-020 | A1,A2 | C4/C5、D7 | T020a无本体direct+有语义版本+来源类别；T020b禁止Web/列权限/写SQL均阻止 |
| US-021 | A1,A2 | D7.4、C6 | T021a单位/实体/来源/过期误答被识别；T021b核验同hash才发布、UI不漏未核验正文 |
| US-022 | A1,A2 | D3/D7、C6 | T022a证据/历史/导出权限；T022b大图分页、版本/语义参与标识和浏览器验证 |
| US-023 | A1,A2 | C1、D8 | T023a新组合不改旧run；T023b导出不含私有数据/密钥、行业成熟度准确 |
| US-024 | A1,A2 | X-01—08、V6 | T024a替换矩阵正/负例；T024b固定模型/数据比较路径并保存指标 |
| US-025 | A1,A2,A3,A4 | V5全链 | T025a完整UI→API→任务→数据→回答；T025b撤回/历史/失败；T025c无本体/第二映射/两runtime/MCP；T025d CI隔离与真实模型评测分离 |

## V4. 功能要求到实现边界映射

| FR | 负责模块/API | 验证 |
|---|---|---|
| FR-1 | RegistryService / POST components | T001 |
| FR-2 | ProfileResolver / POST preflight | T002 |
| FR-3 | RunService / resolved manifest | T002,T023 |
| FR-4 | IndustryManifest + MappingResolver | T003 |
| FR-5 | RuntimeAdapter factory | T004,T005 |
| FR-6 | ToolGateway + server authorization | T006,T007 |
| FR-7 | ToolRegistry visible subset | T006 |
| FR-8 | Local/MCP adapters | T007,X-02 |
| FR-9 | MCP discovered→registered mapping | T007 |
| FR-10 | Backend capability compiler | T008,T009 |
| FR-11 | Ingestion versions / publication | T009 |
| FR-12 | Document spans / GET evidence | T010 |
| FR-13 | Jobs/outbox/idempotent publisher | T011 |
| FR-14 | Candidate store + published view | T012,T015 |
| FR-15 | Rule candidate validator | T013 |
| FR-16 | IdentityResolver / decision API | T014 |
| FR-17 | Clarification state and API | T014 |
| FR-18 | RuleEvaluator / support DAG | T016 |
| FR-19 | DependencyIndexer / outbox worker | T017 |
| FR-20 | InvalidationFence / read service | T017 |
| FR-21 | Template/Pi strategy + controller | T018,T019 |
| FR-22 | BudgetLedger reservation | T019 |
| FR-23 | NoProgressGuard | T019 |
| FR-24 | cancel/responses API + checkpoint | T019 |
| FR-25 | direct query plan without industry | T020 |
| FR-26 | SQL validation / Web policy | T020 |
| FR-27 | VerificationService / controller | T021 |
| FR-28 | AnswerPublisher atomic hash gate | T021 |
| FR-29 | bounded repair / fallback states | T021 |
| FR-30 | ProvenanceService dependency paging | T022 |
| FR-31 | Registry maturity + UI | T023 |
| FR-32 | VersionResolver pinned run | T023 |
| FR-33 | composition contract suite | T024 |
| FR-34 | UI/API/job/data end-to-end suite | T025 |

## V5. 关键完整流程与故障

### 通用 happy path

选择已注册行业/runtime/data profile → probe/preflight → 创建导入job → 原文/数据预处理 → 生成候选 → 人工确认消歧与规则 → 发布 → 提问 → 受控工具查询 → 产生草稿 → 程序/JEV策略核验 → 发布同版本答案 → 点击证据查看来源 → 保存可回放版本。

模型fixture故意提供可解析但错误的引用，验证发布被拦；权限fixture将同名实体放在另一客户空间，确保候选/检索/缓存/溯源都不泄漏。

### 家庭能源 happy path

两套合成设备/传感器命名→映射规范单位→读取固定时间窗的观测、forecast和价格→形成目标/备电约束→调用受信 energy.plan→simulate→核验数值和假设→展示基线/计划/电量曲线→修改一个备电参数重算→模拟执行→查看输入来源和结果版本。使用能源分册 E-01—E-12 作为附加验收。

### 必测故障

- Worker提交事实后、确认job完成前崩溃：重试不重复发布。
- 模型超时但可能已计费：不重置预算，usage未知标记保留。
- 两并行工具同时抢最后额度：只有合法预留者可发请求。
- MCP返回未注册工具、错误content伪装成功或不符schema：拒绝/降级，不当可信证据。
- SDK发出final text但核验未过：业务UI没有final正文事件。
- 核验通过后依据被撤回/权限收回：发布事务阻止过期或无权答案。
- 用户取消后工具迟到：run不被复活，结果只留受限审计。
- 源库不支持永久快照：历史展示明确为当次保存结果，不宣称可重新读取原库。
- 部分有效时间更正：只影响指定区间，旧知识视图仍可复现；未来到期也触发失效。
- 一份来源被复制多次：独立证据计数不膨胀。
- 计算operation请求file/network/code字段：schema拒绝；不能借 compute 绕开四工具边界。
- 预置HA service参数或mode=live：driver未启用时不发请求。

## V6. 性能和评测

采用主文参考档位逐级测量，报告冷/热缓存、并发数、长尾/高fan-out、节点/边/历史量与来源快照能力。模型耗时与本地计算分开；部分降级不能算完整回答成功。

直接SQL、语义SQL、关键词/向量RAG（实际支持时）、Web、混合、Auto在相同数据/模型/权限上比较。工具可用性不同的profile不做不公平性能排名；记录缺失能力。

人工真值/执行结果是评测依据，JEV评分不是自身正确率金标。用保留集测路由误判、核验误放行/误拒绝与不确定时的覆盖率；训练/开发问题不能混成保留集。不同客户或文件版本分组，避免文档片段泄漏。

指标定义必须写分母、完整性和失败统计方式。性能未达标时优先优化扫描、索引、缓存和批处理，不通过删除来源、绕过审核或取消适配层提高平均速度。

## V7. 实施任务图（设计 ID，未创建 Issue）

| ID | 任务与主要产物 | 前置 | ready 条件 |
|---|---|---|---|
| S01 | workspace契约、JSON Schema、依赖规则与公共错误 | 无 | SPEC边界确认 |
| S02 | control migrations、Repository、RLS、blob-local | S01 | 控制库开发配置与fixture范围明确 |
| S03 | Registry/ProfileResolver/CompositionRoot | S01,S02 | 组件manifest和首profile确定 |
| S04 | ToolGateway/BudgetLedger/evidence envelope | S01,S02,S03 | 四工具契约及配额默认明确 |
| S05 | DuckDB/Postgres真实query adapters | S04 | 两份同语义fixture与映射；无需客户生产库 |
| S06 | 文档解析/BM25/来源定位 | S02,S04 | 公开/合成文档fixture与parser来源明确 |
| S07 | Local+stdio MCP真实路径 | S04,S05 | 输入输出和身份注入契约通过 |
| S08 | Generation/JEV端口与假响应适配，真实接口适配外壳 | S01,S04 | 不需要真实key；真实调用测试另有授权 |
| S09 | Pi+Template runtimes/controller/SSE/取消恢复 | S03,S04,S08 | 锁SDK版本、fake模型及两runtime契约场景 |
| S10 | Draft/Verification/Answer发布门与问答UI | S05,S06,S09 | 程序核验fixture与草稿协议 |
| S11 | 抽取/消歧/审核/发布与job恢复 | S02,S03,S06,S08 | 行业schema/身份策略/审核样例 |
| S12 | RuleEvaluator/物化/时态/撤回 | S11 | 支撑语义和更新fence测试先定义；LOCAL-048 的独立夹具在公共契约完成后即可准备 |
| S13 | home-energy行业包与两数据映射 | S03,S05 | 合成设备/时序/价格/约束显式配置 |
| S14 | 独立能源planner/simulator与compute注册 | S04,S13 | 能量模型与E-01—E-09期望结果 |
| S15 | 能源UI/模拟执行/溯源闭环 | S10,S12,S14 | simulation模式与E-10—12不越界 |
| S16 | 全部替换矩阵/E2E/负载报告 | S07,S10,S11,S12,S15 | 所有本地真实适配可用，测试数据独立 |
| S17 | 真实公司模型/JEV质量与兼容验证 | S08,S10,S11,S16 | 实际endpoint、额度、数据授权明确；用户要求运行 |
| S18 | HA真实读取/设备执行扩展（后续） | S15,S16 | 官方资源/设备能力/授权明确，单独评审live范围 |

这些依赖允许按工程资源安排，但本轮不启动代理或执行。S17/S18受外部条件约束，不阻塞本地契约与simulation；通过fake不能将它们标为完成。没有必要接入的后端不纳入本轮ready列表。

供后续 loop-it 使用时，将 S-ID 转为真实 Issue 编号并写 Dependencies，只交接本批 ready 编号。不把整个表一次全部激活，不自动提交/推送/合并；按届时用户授权确定交付范围。

## V8. 替代方案与风险记录

| 方案 | 取舍 |
|---|---|
| 将历史实验当作新系统兼容基线 | 会固化无业务依据的旧接口/数据模型；不采用，新系统按当前规格与独立金标建设 |
| 所有模块先拆微服务 | 有网络隔离但运维/一致性成本过早，不能替代端口约束；先包边界和同进程依赖注入 |
| 所有工具强制MCP | 增加本地延迟与错误层，仍可能业务逻辑耦合；本地/MCP双适配同契约 |
| 同一SQL直接支持所有库 | 类型、方言、时间和快照语义不同；用能力声明、语义plan和后端编译 |
| 一个LLM判断/计算/解释全部完成 | 无法可靠区分数值错误与表达错误；领域计算与核验独立 |
| 所有派生预物化 | 增加维护/存储且可能没收益；选择性物化，与按需求值共用语义 |
| 先省略第二适配器以后再解耦 | 只剩形式接口，无法证明可换；保留最小真实替换矩阵作为首版验收 |

剩余风险：设备能力与活动要求尚不确定；真实模型格式/工具调用支持需验证；source schema drift可破坏映射；证据依赖fan-out可能拖慢更新；同时支持历史与授权撤回需谨慎。每项在preflight、版本锁定、投影fence与专门测试中有对应处理，不用“全局正确”掩盖边界。
