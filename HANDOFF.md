# Handoff：多行业语义与业务 Agent 平台

更新：2026-09-23。用途：交给后续开发者或 AI 接续工作。本文汇总当前目标、最新约束、仓库状态、审查与调研结论，不替代具体接口规格。

## 最新交付进展（2026-09-23）

以下替代 §1.1 中早先“还不能作为完整交互产品直接使用”的启动与 HTTP 链路状态；它**只覆盖本地合成能源切片**，不表示通用行业/客户数据平台已完成。

- 新增本地产品入口：`cd D:\work\ontology\platform` 后 `pnpm run prepare:local` 建立本机 Postgres control schema/profile/应用角色，`pnpm run dev:local` 启动 loopback API 与 Web。逐步命令和边界在 [docs/local-product.md](docs/local-product.md) 中。
- 正式浏览器 E2E 通过：`pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/local-product.browser.e2e.ts`。从网页 POST 一个 run，经正式 controller、DuckDB 结构化 SOC 聚合、家庭能源 compute、证据归档、正式 hard verifier 到 Postgres 答案；关闭并重启 API 后同一 answerId/hash 可读取。该测试不导入 acceptance harness，也不 seedAnswer。
- 两个 profile 使用不同合成物理布局：DuckDB 宽表与长表 metric-code + 显式预处理视图；同一站点 SOC 均值为 45%。SOC 查询和能源计划经同一个 gateway/tool contract。
- 已支持回答：有来源绑定的 SOC 均值；储能仿真候选计划的费用/末端能量/备电结果摘要，以及只读归档的 96 段充放电与储能量轨迹、备电余量明细。明细经过结果文件完整性校验，且关键摘要数值与已发布 claim 核对；逐时段点位尚未逐项作 claim 核验。真实客户接入、其他行业、真实模型、JEV、多实例并发 CAS、真实设备仍未交付。全部结果为合成输入，设备执行保持禁用。
- 新增 control migration `052_workflow_manifests.sql` 与 Postgres workflow/verification stores；answer publication 持久化已核验 blocks/claims。UI 只渲染 claim-bound 内容，缺少 claim 对应项时不发布普通答案。
- R03/R04 不可表达情况显式拒绝，R05 keyset 分页超过上限显式报不完整；并发物化快照仍需版本栅栏，见审计记录。

验证：最新 `pnpm run typecheck` 与 `pnpm run lint` 通过；目标 unit/E2E 记录见后续验证输出与新产品测试。完整外部客户/生产部署验证仍未运行。

## 最新检查：现在能怎样使用（2026-09-23，main@db4e376）

这是继下方历史快照之后的一次只读核对，当前代码事实优先于旧状态描述：manifest 共 80 张卡，78 done；LOCAL-071 与 074—080 的 NL2SQL 差距核对及相应模块已标记完成。仅 LOCAL-052（真实 HA 只读）和 053（真实设备执行）仍为 planned，等待外部条件。完成卡数量不是产品可用性证明。

本次在 platform/ 运行 typecheck 通过，5 个与新 NL2SQL 能力相关的 unit 文件、36 项测试通过。没有运行当前 HEAD 的整套集成、浏览器或真实模型测试。

**现在可做**：以开发组件方式复用合同、数据适配、业务映射、模板/Pi 运行时、四工具、能源计算和 UI；使用已有单元、集成与浏览器测试驱动合成/受控数据场景。示例验证命令：

```text
cd D:\work\ontology\platform
pnpm run typecheck
pnpm exec vitest run --project unit tests/unit/workflow-question-rewriting-wiring.spec.ts tests/unit/schema-vocabulary.spec.ts tests/unit/few-shot-examples.spec.ts tests/unit/workflow-repair-feedback.spec.ts tests/unit/feedback-api.spec.ts
```

**还不能作为完整的交互产品直接使用**：package.json 没有启动完整 API/Worker/前端的命令；[POST /runs](platform/apps/api/src/http/server.ts)仍只创建记录，未调度控制器；[PublishedAnswer](platform/packages/contracts/src/workflow.ts)和现有 [QueryPanel](platform/apps/web/src/components/QueryPanel.tsx)只传/显示元数据，缺可读业务正文。浏览器验收用例还在测试中 seed 一个答案供页面展示。单独运行 Vite 页面或单元测试不会补上这些连接。

近期“现在就能让业务用户使用”的最小完成条件：启动完整服务；配置一份合成或已授权的客户数据和 profile；用户从正式页面输入问题，同一个 run 经调度、工具、核验，最终展示可读回答/方案及证据。之后再用第二种物理结构验证映射复用。能源仿真可以独立演示，但须明确其合成输入与不执行真实设备的边界。

下方 §2 的分支/HEAD/任务数是写文档时的历史快照，不能再当作最新进度。之前 [LOCAL-071 差距报告](platform/docs/local-071-nl2sql-pipeline-alignment.md)记录的是补卡前基线，其中“问题改写、Schema/Few-shot/反馈缺失”已过时；以当前实现与验证为准。

**先读本文件与 [AGENTS.md](AGENTS.md)。旧文档中的“尚未实现”“全部 planned”“从 LOCAL-001 开始”等是历史状态，不能用于决定下一步。**

## 1. 接手摘要

- 目标：客户数据接入与预处理 → 查询/检索 → 可选本体建模、抽取、消歧、规则与派生 → Agent 工具调用 → 核验、可读回答和溯源。
- 首个场景是家庭充电储能仿真；平台须兼容不同行业、不同客户的异构数据结构，并持续积累行业资产。
- 不强制每个场景新增 npm/workspace 包。配置、普通模块或独立包按实际需要选择，必要解耦不能因交付方便被舍弃。
- 最新建议是共享主干维护版本化行业资产，客户配置引用具体版本；短期分支用于开发/实验。用户正在讨论组织方式，不能把“一行业一条长期分支”当成已确定方案。
- 当前已有大量 TypeScript 实现，绝非从零开始。但任务卡 done 和既有测试通过，不代表真实 HTTP→业务答案链路已全部接通。
- 原审查发现 R01—R13；之后 LOCAL-072 已增加公司模型的 OpenAI 兼容解码路径。**R13 必须按新代码复核，不要按旧报告重复改私有 decoder。**
- 本次请求是总结与交接：没有启动新修复、创建分支/远程 Issue、运行 loop-it 或调用模型/设备。

### 1.1 POC Core 的最终输入、输出与使用方式

本节是产品使用目标，不能当作所有能力已经接通。2026-09-23 在 02984da 核对：已有组件/路由，但仍缺完整启动宿主、HTTP→工作流调度以及业务正文的保存/读取/展示；不要给用户虚构一条可以启动完整产品的命令。

建议最终提供一个可启动的后端服务和轻量工作台；也允许客户现有前端调用同一 API。一个客户 POC 由固定版本的资产与客户配置装配，不必复制整个代码仓库，也不是把一句需求自动生成完整行业应用。

| 使用层 | 输入 | 输出 |
|---|---|---|
| 接入与配置（开发/交付人员） | 要解决的业务问题与验收样例、可访问数据、来源 schema、已确认 mapping、可选行业语义/规则、模型/runtime/计算能力配置 | 可预检、激活和运行的客户配置实例；查询/文档索引或视图；启用本体时的候选、审核与发布结果 |
| 业务运行（业务用户） | 问题或任务、对象/站点、时间范围、业务约束；使用已激活的客户配置 | 可读答案、结构化数据或计划/仿真结果，及来源、核验结论、缺口/限制、运行标识与必要的执行记录 |
| 项目复用（团队） | 经验证的语义/规则/接入模式、任务模板、计算与评测改进 | 有范围、版本、依赖和验证证据的资产候选；评审后供后续客户引用，不自动混入客户数据 |

目标流程：

1. 明确本 POC 的代表问题、期望输出和失败条件。
2. 连接/登记客户来源，核对实际 schema、权限和数据质量；文件或特殊 API 无适配器时补最小读取模块。
3. 选择已有行业资产或无本体模式，确认对象/字段/关系、单位/时间和身份映射；复杂整形用明确的视图或预处理。
4. 配置数据后端、模型、运行时、计算 handler 与策略，预检并固定版本后激活。没有对应业务算法时，不能因挂上 Agent 就宣称具备求解能力。
5. 必要时执行文档解析/检索建索引、候选抽取/消歧/审核发布；后续新增数据按版本增量处理。这些准备工作不要求每次问答重新执行。
6. 业务用户在通用问答或专属任务页面输入问题，等待同一 run 的工具结果、核验和最终内容；不足时明确澄清/缺口/失败。
7. 用预先确认的用例验收；把可泛化部分提为共享资产，新客户主要更换来源、mapping 和业务参数。

家庭储能目标示例：输入设备参数、已有/合成遥测、分时电价、负荷/光伏预测和用户备电约束，询问“明天如何安排充放电，在满足备电要求下尽量降低电费”。输出候选充放电计划、SOC/能量轨迹、同口径基线比较、约束检查和数据来源。没有真实预测时必须说明是假设，缺少关键设备参数时返回缺口；仿真结果不直接控制设备，也不宣称全局最优。

一次问答应区分启动回执（runId/状态/进度入口）与最终业务结果。最终结果的必要内容为：可读结论、支撑该结论的数据/计算结果、逐项证据引用、核验状态及范围、显式假设/缺失/冲突、版本/时间与 simulation/observed/forecast 等标记。核验通过表示已声明检查通过，不是对真实世界绝对正确的保证。

目前能通过组件和测试 harness 验证局部能力，不能把 pnpm test 或启动一个 Vite 静态页面称为交付完整 POC。近期产品完成标准是：提供明确启动入口，配置一份数据和 profile，经正式 UI/API 得到同一 run 的可读结果与证据；再切换第二份结构不同的数据验证核心不变。

## 2. 仓库快照

| 项目 | 交接时状态 |
|---|---|
| 根目录 | D:/work/ontology |
| 实现工作区 | platform/；pnpm 命令在此执行 |
| origin | https://github.com/Yijtu/ontology.git |
| 收尾时分支 | fix/node-73-unhandled-rejection；不是 main，不要假设当前在主干 |
| 收尾时 HEAD | 2d7a7f2fbc3bbbef929e6910cda430c8a712ceb8 |
| 交接开始时观察 | chore/sync-072 @ 8a47032a758e9c24c772ebf63d6aaa858a7a602e；工作期间被其他工作切换 |
| 原完整审查基线 | 527a79c，补查增量至 bd60168 |
| 后续实现 | 2d7a7f2：LOCAL-072 OpenAI 兼容解码；8a47032：同步清单 |
| 开始时任务清单 | 8a47032 的 manifest 为 72 张、69 done、3 planned |
| 收尾时任务清单 | 2d7a7f2 的 manifest 为 71 张、67 done、4 planned；显式 ready 清单为空；元数据较旧 |
| 执行检查点 | .loop-state.json 与 .graph_state 均存在；本轮未验证其批次归属、未改写 |

接手前运行 git status/log/diff 重新核对；上述为时间点快照，不是永久状态。未经任务需要不要切换、重置或清理现有工作树。

**并行工作提醒**：切换后新增了 platform/tests/integration/publication-fence-postgres.spec.ts 的未提交改动（收尾观察为 10 行新增、1 行删除）。这不是本次文档任务产生的改动，尚未审查其完成状态；必须保留。不要为恢复本交接开始时的分支而覆盖它，也不要用某个 manifest 的旧状态推断已经提交的实现不存在。

交接开始前已有未提交项：

- .autoresearch/issues/issue-048-semantic-regression-fixtures.md：用户原有改动，已保留，不能恢复或覆盖。
- AGENTS.md、README.md 与未跟踪的 docs/：本轮系列讨论产生的约定、审查、逆向规格和设计/研究材料，尚未提交。
- 本次额外新增 HANDOFF.md，并更新旧交接和相关入口；没有将这些文档自动推送。

### 2.1 任务状态漂移

| ID | 开始时 8a47032 / 收尾时 2d7a7f2 | 接手解释 |
|---|---|---|
| LOCAL-051 | done / planned、waiting_external_condition | 验证工具与记录实际已提交；不要因旧 manifest 重复实现，也不把任务完成等同于 JEV 通过 |
| LOCAL-052 | 均 planned、waiting_external_condition | 真实 HA 只读遥测；缺设备/API条件不能标完成 |
| LOCAL-053 | 均 planned、waiting_external_condition | 真实设备执行；独立能力与执行边界 |
| LOCAL-071 | 均 planned、waiting_dependencies，依赖 LOCAL-054 | LOCAL-054 已 done，该 readiness 需重新核对；卡自身要求明确核对范围，不能只看旧字段自动执行 |
| LOCAL-072 | done / manifest 尚无此项 | 2d7a7f2 本身包含 codec 实现与测试；8a47032 是后续元数据同步，不能因为清单缺失而重写代码 |

051 的端点验证任务完成不意味着 JEV 集成或模型业务质量已通过。编号映射需核对对应版本的 manifest.github_issue 与既有远程记录；LOCAL 编号不能直接当 GitHub Issue 编号。元数据同步应在了解当前分支/其他工作后进行，本轮未覆盖 manifest。

## 3. 用户明确要求与讨论中的建议

### 已明确的要求

1. 多行业、异构数据：允许不同表名/字段、身份键、关系、宽长表、单位/编码和业务对象；不要求客户使用相同原始 schema。
2. 行业资产可积累：复用语义、规则、映射经验、业务任务、计算和评测；实际客户实例、数据与身份裁决不默认共享。
3. 必要解耦：行业/场景、runtime、数据后端、模型、工具传输与领域计算相互独立；普通字段差异优先配置映射，新的读取协议/方言才考虑新 adapter。
4. 本体是可选增强；直接 Text2SQL、语义辅助查询、RAG 与 Web 都保留适用路径，不把本体强制放在所有查询前。
5. DataOS 暂时只作为数据中台，不假设其本体、抽取或推理能力可用。
6. 使用公司模型 API，不以自部署模型为前置。JEV 为概率决策角色，生成模型负责抽取/SQL候选/表达；概率不是正确性或执行许可。
7. 历史 Python 演示原型不约束当前流程；不依赖其接口、数据、ID、页面或测试数量，不启动它作为新版后端。

### 建议，尚非新增实施授权

- 同一主干 + 版本化资产 + 客户安装配置；长期独立交付线仅在确实需要时采用。
- 先以家庭储能子域积累预览资产，再验证第二种物理结构和第二行业；交通设施巡检只是后续候选场景。
- 优先复用 IndustryManifest、IndustryPackExportBundle、ProfileSpec/ResolvedProfile、OperationRegistry；不预设必须新增 ScenarioPackage、Installation 表、插件商店或运行时热装载。
- 构建/启动时静态装配可接受。接口与输入契约清晰，比是否独立发布包更重要。

## 4. 不可在实现中绕过的边界

完整规则见 AGENTS.md 和 SPEC，本节列出交接重点：

- 模型可选公共数据工具为 ontology_lookup、data_query、document_search、web_search；领域计算以已注册的版本化 operation 接入。
- controller 管阶段与发布，runtime 管有界收证循环；重试、并行、补查与草稿修复共用预算，不另开竞争循环。
- 先形成回答草稿并核验，再发布同一版本。不能核验后重新生成未经验证的正文。
- core/application 不直接依赖 SDK、数据库驱动或能源算法。客户物理映射、行业声明和业务计算分开；local/MCP 使用同一业务服务与授权要求。
- tenant/space、权限、来源版本、证据完整性必须沿在线和后台链路保持；模型、原文或工具结果不授予权限。
- 未知、冲突、假分开；派生的 AND 前提与 OR 替代支撑分开；撤回与历史不可被简单删除覆盖。
- 能源仿真、观测、预测、合成与实机状态显式区分。能量平衡和成本等用确定代码验证，不能由 JEV 代算或宣称全局最优。

## 5. 文档导航及效力

| 阅读顺序 | 文档 | 用途与限制 |
|---|---|---|
| 1 | [AGENTS.md](AGENTS.md) | 长期开发/审查约束 |
| 2 | [PRD v0.2](tasks/prd-industry-semantic-agent-v0.2.md) | 产品目标；部分时态描述已旧 |
| 3 | [目标 SPEC](tasks/spec-industry-semantic-agent-v0.2.md) 与分册 | 契约、数据/执行语义、能源、验证计划；目标不等于现状 |
| 4 | [逆向 SPEC](docs/SPEC-as-built-2026-09-23.md) | 527a79c/bd60168 的实际实现快照，之后有 LOCAL-072 增量 |
| 5 | [API/表/包清单](docs/spec-as-built-2026-09-23-inventory.md) | 原扫描 44 路由、57 应用表、30 工作区 package.json；实现变化后重核 |
| 6 | [审查清单](docs/reviews/2026-09-23-code-review.md) | 13 个原始发现、证据和修复验收；状态以本交接补充及当前代码为准 |
| 7 | [多行业/行业资产方案](docs/scenario-decoupling-2026-09-23.md) | 最新异构数据、组织形态、资产沉淀建议 |
| 8 | [Palantir 调研](docs/research/palantir-industry-assets-2026-09-23.md) | 13 个官方来源，区分事实与本项目推导 |
| 按需 | [任务 manifest](.autoresearch/issues/manifest.json) / [INDEX](.autoresearch/issues/INDEX.md) | 编号、依赖和任务状态；有历史字段漂移，需结合代码核实 |

用户最新明确说明优先于旧设计；逆向规格是事实快照，不能反向授权降低 PRD/SPEC 的要求。发现矛盾应记录具体位置与最小调整建议。

## 6. 审查发现的交接状态

R 编号属于审查条目，不是现有 LOCAL 或 GitHub 编号。原报告为 11 个 P1、2 个 P2；不要把该数量当作当前“全部未修复”的结论。

| ID | 原发现 | 当前交接处理 |
|---|---|---|
| R01 | HTTP 创建/澄清/恢复/取消未接入实际 controller 执行 | 待复核并修复正式命令/调度链路 |
| R02 | 最终答案只存/返 ID、hash 等，无完整业务正文链路 | 待补 DraftWriter、已核验内容 artifact/API/UI |
| R03 | 规则编译忽略 exceptions | 待修；不支持的例外应显式拒绝，不可静默丢弃 |
| R04 | 仅按 predicate 选前提，跨实体拼接 | 待修实体/关系绑定和结论身份 |
| R05 | 物化输入只读一次前 1,000 条，没有完整性标识 | 待修稳定分页/依赖读取及不完整状态 |
| R06 | claims 正确但 blocks 可写矛盾正文 | 待修可见内容与已核验断言的覆盖/绑定 |
| R07 | 缺 timePointer 后时间声明绕过检查 | 待修时间联合契约与证据匹配 |
| R08 | JEV 默认路径及请求/响应结构不匹配官方协议 | 新增公司模型 codec 不修此项；单独处理 model-jev |
| R09 | JEV 语义核验仅看到 ID/hash，缺实际 claim/证据 | 待补授权、裁剪、版本化的实际判断输入 |
| R10 | 工作流公共清单/核验记录仅内存 | 待补持久化、并发与跨进程恢复 |
| R11 | controller 忽略幂等 createRun 返回的规范 runId | 待修同键不同输入生成 ID 的重试路径 |
| R12 | 测试手动启动 controller/seedAnswer，掩盖真实入口断链 | 待补同一 run 的正式装配 E2E，明确替身边界 |
| R13 | 公司生成模型不识别 OpenAI 兼容流 | **LOCAL-072 已新增可选 codec 与测试；优先复验当前适配器配置与端到端结果，不重复实现** |

R01—R12 在 bd60168→当前 HEAD 的文件变化中未见直接针对性修复；本次交接没有重新运行其复现场景，后续修复前仍应复核实际路径。

### 6.1 R13 的新事实和旧诊断陷阱

- [codec 选择](platform/packages/adapters/model-company/src/vendor/codec.ts)已有 private / openai-compatible 两条路径，适配器每次尝试创建 codec。
- [配置类型](platform/packages/adapters/model-company/src/types.ts)的 protocol 默认仍为 private；接入兼容网关应显式选择 openai-compatible。验证脚本已经支持相应参数，验证装配默认选兼容路径。
- [新增测试](platform/tests/unit/model-company-openai.spec.ts)覆盖文本、分片工具参数、非 UUID ID、usage、结束与异常；另有 [live validation 的本地替身测试](platform/tests/unit/live-model-validation.spec.ts)。本交接只核对源码，未重跑这些测试或真实端点。
- [旧 live-model 报告](platform/docs/live-model-validation.md)仍写着适配器 blocked，是 LOCAL-051 时的记录，不能当作 LOCAL-072 之后的最新结果。本轮未找到默认位置的 live-model-validation.json；真实复测证据需要另行核实。
- [旧诊断脚本](docs/reviews/2026-09-23/reproduce.mts)的 COMPANY-PROTOCOL 用例直接调用 private decoder；新架构下该函数继续拒绝 OpenAI chunk 是正常的。应测试实际适配器加 protocol 选择，而不是为了让这个私有函数接受另一协议而破坏隔离。

整个诊断脚本断言的是原缺陷表现，不是“修好后必须全绿”的验收套件。后续应将相关反例转成期待正确行为的回归测试，并标记旧诊断适用基线。

## 7. 行业资产积累与 Palantir 启示

复用单元按职责划分，不强制新增包：

| 资产层 | 共享内容 | 客户侧保留 |
|---|---|---|
| 框架 | 控制器、工具、数据/模型适配、权限、预算、核验、证据 | 实际端点和授权配置 |
| 行业/子域 | 对象、关系、术语、身份、单位/时间、规则模板与来源 | 客户专有政策、真实实体与裁决 |
| 场景能力 | 查询/计划模板、算法、输入/结果契约、可复用视图 | 特定设备参数、业务偏好、一次性 UI |
| 接入与评测 | 结构映射模式、合成样例、代表问题、金标、反例、预期溯源 | 客户原文、实际表列绑定及私有评测数据 |

资产至少记录 ID、版本/摘要、范围、依赖/兼容性、来源、负责人、验证证据与限制；客户 profile 引用固定版本。Git 保存源码历史，分支名不能替代资产/schema/mapping 版本。

Palantir 的公开机制把 Product、Version、Installation 和输入/输出绑定分开，也支持组合资产与受控升级。它允许安装后定制，但修改可能被升级覆盖，不能推导出任意定制均无成本兼容。[官方核心概念](https://www.palantir.com/docs/foundry/devops/core-concepts)、[安装管理](https://www.palantir.com/docs/foundry/marketplace/installations)

本项目建议优先借鉴这套生命周期，而非照搬 Marketplace/对象存储/微服务。还需分清数据映射与业务能力接口：前者说明字段在哪、怎样归一，后者说明一个问题/操作需要哪些已知条件。业务接口也不等于 TypeScript port 或 MCP 协议。

现有行业包测试偏重能力能否装配，应引用业务金标验证答案、例外、撤回、关系绑定和两种 schema 的等价性。资产从 preview 开始，证据充分后再提升成熟度；不能仅通过改 stable 标签宣称行业标准已完成。

## 8. 建议下一步顺序与完成标准

以下为建议切片，不是新 Issue 编号，不会因本文件存在而自动开工。具体执行范围沿用用户当时已给的授权；本轮没有指定新的实现批次。

| 阶段 | 输入/工作 | 完成标准 |
|---|---|---|
| H0 状态复核 | 当前 HEAD、工作树、R01—R13、LOCAL-051/071/072、旧检查点归属 | 得到已修/仍可复现/需证据矩阵；不重复实现 R13，不按旧 ready 字段自动续跑 |
| H1 正确性 | R03—R09 与当前仍存在的模型协议问题 | 例外、实体、分页、正文/时间、真实语义输入的负例均被正确处理；暂不支持的语义显式拒绝 |
| H2 可用闭环 | R01/R02/R10/R11 与 H1 的核验契约 | 仅从 HTTP 创建同一个 run，经实际调度/工具/核验到可读答案；重试、取消、澄清、重启恢复可验证 |
| H3 真实入口验收 | R12；正式宿主，受控外部模型响应 | 不手动推进 controller、不 seed 答案；业务内容和证据由同一条链路产出 |
| H4 异构数据复用 | 家庭储能 A/B 两种物理结构、相同语义问题 | 主要改变 source/mapping/必要预处理；不修改公共执行逻辑；结果与预期来源一致 |
| H5 第一份行业资产 | 已验证定义/计算/映射模式/问题与反例 | 有范围、版本和验证记录，两个客户配置引用相同上游资产 |
| H6 第二行业及扩展 | 按可用数据选择，交通巡检为候选 | 新语义和结构仍复用核心；据真实需要决定独立包或交付线 |

H1/H2 可按真实依赖拆分；业务问题、样例和资产整理不必等全部代码修好才开始。不能为一个大型“全平台完成”前置条件推迟所有验证，也不能为演示省掉必要解耦与核验。

对第二份数据的关键验收：宽/长表、单位/编码、主键和关联变化；同名不同实体、未知关系；缺必需参数；超过 1,000 条与 schema 漂移。合成数据证明工程机制，不等于两个真实客户验收。

## 9. 测试证据与执行提醒

### 已在本任务前序审查中执行的验证

- 527a79c/bd60168 范围：lint、三套 typecheck、88 文件/1,162 项 unit/architecture 测试、3 文件/26 项 acceptance、Web build、6 文件/25 项 browser，共 1,213 项既有测试通过。
- bd60168 增量：35 项相关测试通过，部分与前述重复；不能累加为去重覆盖率。
- 11 个诊断案例复现了原缺陷；其中 R13 路径已被后续实现改变，见 §6.1。
- 上述不是收尾时当前分支的全量测试声明。本次 handoff 只核对仓库/源码/记录及文档，不重跑应用测试、不调用真实模型。

### 常用命令（在 platform/）

```text
pnpm run lint
pnpm run typecheck
pnpm exec vitest run --project unit --project architecture --maxWorkers 4
pnpm run test:acceptance
pnpm run build:web
pnpm run test:e2e
```

按改动选择有意义的测试，源码变化后再扩大到相关集成。数据库/浏览器环境需要 Docker/浏览器依赖；使用项目已有命名卷测试辅助，勿执行全局 Docker 清理。

真实模型验证属于单独范围，使用现有 SecretResolver/环境配置，凭据不写入共享文档、源码或输出。不要从聊天记录复制密钥。缺设备/API资料时保持仿真状态。

恢复 loop-it/graph 前读取当前技能及检查点，核对仓库、批次、编号和授权。只执行明确选定的任务；不要抓全部 open Issues，也不要伪造 LOCAL→GitHub 映射或覆盖旧检查点。

## 10. 仍待确定的事项

- 第二行业的实际业务问题、数据、业务语义确认人和验收口径；交通巡检不是已锁定交付。
- 新客户是否只需要配置映射，还是需要专属模块；是否存在独立发布/权限边界使拆包/拆仓库有价值。
- 家庭能源的真实设备、HA API、可写能力及最新活动验收规则。
- JEV 实际集成结果、语义核验输入与公司模型新 codec 的最新真实验证证据。
- 下一轮精确修复批次、交付范围与维护人；没有确认的容量/期限不能自行补成承诺。
- LOCAL-071 readiness、旧交接/报告时态，以及 LOCAL-072 卡片正文编码异常等元数据需要整理；不要让这些记录问题覆盖源码事实。

## 11. 可转交给下一任务的提示

> 在 D:/work/ontology 工作。先读 HANDOFF.md 与 AGENTS.md，核对最新 HEAD、分支和未提交改动。保留 issue-048 的用户改动。先更新 R01—R13 状态矩阵，注意 LOCAL-072 已新增公司模型兼容 codec，旧 private decoder 诊断不能用于否定新路径。按照用户当前明确授权的批次推进；未给实现批次时先给最小建议。保持多行业异构数据、可选本体和必要解耦，不强制新增包或长期行业分支。复用现有接口与资产，保证正式 HTTP→工具→核验→正文→溯源的同一 run 闭环，再用两种数据结构证明行业资产复用。检查点、远程 Issue、发布、模型调用与实机操作均按实际范围处理，不由本提示额外扩权。
