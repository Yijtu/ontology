# Anker 预赛目标与分支审查

审查日期：2026-09-28。目标分支：[feat/local-poc-core-20260923](https://github.com/Yijtu/ontology/tree/feat/local-poc-core-20260923)，固定提交 37f3feb493800cb39e39ef1abd0fa2931e6fbe84。已通过 Git fetch / ls-remote 确认本地与远端一致。

本轮验收依据是用户指定的 D:/Anker首届黑客松挑战赛 · 【有电东西】预赛材料.md。材料描述的是拟实现方案，不能当作已经实现的证明。本报告优先按它检查；旧 [Anker SPEC](../../tasks/spec-home-energy-anker-v1.0.md) 的“单户、无硬件、A/B/C/D/E 通过”只覆盖旧范围。旧交接中的 A4/D1 未完成状态已被 09-26 更新取代。

本轮只审查与验证，未修改业务代码、提交、push、合并或删除工作树。用户原有 issue-048 未提交改动保留。未连接赛事设备、调用付费模型或运行 loop-it。

## 结论

当前交付物是**单户、合成数据、确定性候选调度、整日虚拟执行的可审计研发底座**。规划、约束、版本、证据与基本页面均能运行；尚未交付材料要求的“官方 Home Assistant / SOLIX 模拟环境、三站独立运行、实际功率回读校验、运行中重规划、家庭多角色表达”。

差距属于若干核心业务链路尚未实现，不能用旧 SPEC 的通过率或测试数量折算为产品完成百分比。保留现有框架有价值，优先补赛用单站执行链路，再复用到三站；本体不应扩大为独立图谱管理平台。

## 五个目录是什么

它们是同一 Git 仓库的五个 worktree：共享提交历史，每个目录有自己的检出分支、工作文件及本地依赖。它们不是五个必须一起启动的产品模块。

| 目录 | 检出分支 / 提交 | 当时用途 | 本轮检查与建议 |
| --- | --- | --- | --- |
| D:/work/ontology | feat/local-poc-core-20260923 / 37f3feb | 用户运行、集成与当前预赛交付入口 | 以后日常使用此目录下的 platform。保留；issue-048 有用户未提交改动。 |
| D:/work/ontology-a4 | feat/anker-a4-explanation / 6dccd3b | 隔离开发 A4：本体关系与运行证据解释 | 已合入当前分支，跟踪文件干净，代码层面可以回收此工作树。 |
| D:/work/ontology-capabilities | feat/poc-core-capabilities / c168233 | 通用能力与能源闭环开发，最后完成 D1 预测过期/缺失传播 | 已合入当前分支，跟踪文件干净，代码层面可以回收此工作树。 |
| D:/work/ontology-consistency | feat/ontology-reasoning / 92b512c | 早期本体能力研发，最后增加可选公司模型候选抽取 | 提交 SHA 没有直接合入，但 git cherry 显示其补丁已等价进入当前分支；跟踪文件干净，代码层面可以回收。 |
| D:/work/ontology-main-decoupling | feat/main-scenario-decoupling / 51c8cb4 | main 通用 UI 查询字段解耦 | 当前远端 main 同为 51c8cb4。该提交尚未合入当前功能分支，暂保留至核对并整合。 |

只需从 ontology/platform 启动当前应用。代码已整合并不意味着其他目录里的被忽略文件、环境配置或本地运行数据都可丢弃；如后续回收，应核对这些文件，再用 Git worktree 管理命令处理。本轮没有删除目录。

## 已经实现什么

| 能力 | 实际行为 | 实现证据 |
| --- | --- | --- |
| 场景输入与计划 | 默认 35% 初始 SOC、全天 20% 备用电，96 个 15 分钟时段；天气、备电目标变化生成新快照 | [场景构建](../../platform/apps/api/src/composition/home-energy-scenario.ts) |
| 候选策略与约束 | 自发自用、备用优先、价格窗口等有限策略；确定性计算功率、效率、能量平衡、成本及备用电约束，选择已测试候选中最优 | [planner](../../platform/packages/extensions/home-energy/src/planning/planner.ts)、[simulator](../../platform/packages/extensions/home-energy/src/simulation/simulator.ts) |
| 手动变化重规划 | 只下调下午 PV；晚间 17:00 起 60% 目标；归档前后计划差异，当前 SOC 不被改成目标 SOC | [版本和差异 API](../../platform/apps/api/src/http/energy-plan-versions.ts) |
| 发布与版本控制 | 正式 run 收证、核验、发布；只有当前 Selected 版本可执行，新版成功后旧版 Superseded；写入前复查状态、版本和选择 | [版本存储](../../platform/apps/api/src/composition/energy-plan-version-store.ts)、[本地宿主](../../platform/apps/api/src/local-product-v0.ts) |
| 虚拟执行与保存 | 一次请求计算整天 96 步、存不可变状态快照、推进模拟时钟；并发同键不重复执行，同键可重放已完成回执 | [Virtual SOLIX](../../platform/apps/api/src/composition/virtual-solix-execution.ts) |
| 预测故障拦截 | 过期或下午预测缺失返回 insufficient_data，不产生新的 Selected 可执行版本，并给恢复建议 | [D1 场景](../../platform/apps/api/src/composition/home-energy-scenario.ts)、[能源页面](../../platform/apps/web/src/components/EnergyPlanPanel.tsx) |
| 能源页面 | 指标、Solar/Battery/Grid/HomeLoad 关系示意、时隙数值、计划轨迹、成本、版本、A/B/C/D 场景和模拟回执 | [EnergyPlanPanel](../../platform/apps/web/src/components/EnergyPlanPanel.tsx) |
| A4 关系与证据检查 | 已审核发布的三跳关系导航，核对当前 scenario/result/plan、身份、来源、撤回与版本；不足时 limited | [energy-run-explanation](../../platform/apps/api/src/composition/energy-run-explanation.ts) |
| 通用底座 | 场景贡献、来源 mapping、运行时/工具/存储端口、行业声明与能源计算扩展已分开；另有文档、交通、候选抽取能力 | [部署装配](../../platform/apps/api/src/composition/local-product-deployment.ts)、[行业声明](../../platform/industry-packs/home-energy/src/definitions.ts) |

这些能力在本地测试条件下有效；不等于已经接入赛事官方模拟设备或测得真实节省金额。

## 相对预赛材料的差距

| 材料承诺 | 状态 | 缺口 / 最小验收 |
| --- | --- | --- |
| Home Assistant / 官方 SOLIX 模拟环境 | 缺失，需赛事接口资料与授权 | 当前 runner 明确无设备适配，live 直接拒绝。必须从赛用环境读取一个站点状态、下发一条控制，并获得独立状态回读。官方模拟环境也是外部设备环境，不能用本地公式代替接入验收。 |
| Site A/B/C 三个独立家庭 | 缺失 | 当前 planKey/deviceId 固定 virtual-solix-1，HTTP 输入没有站点选择。需让站点、设备、预测、计划、执行身份贯通；同一租户下三站相互隔离。能源 A/B profile 是宽表/长表数据布局，不是三个家庭。 |
| 分站轻量预测 | 部分 | ForecastPort 与输入规范化存在，但主流程仍用固定负载、高斯 PV 和天气系数。需基于决策时点以前的历史/可用天气预测负载及 PV；已公布未来电价直接读取。 |
| 预测有效性验证 | 缺失 | 未有独立时段的预测对随后观测及 MAE。当前未来全日合成负载标 observed、evaluationClock 为 horizon.end，只能当合成仿真输入，不能直接用来证明无未来信息泄漏的预测回放。 |
| 官方基线或固定自发自用规则 | 部分，默认基线不符 | 当前 BASELINE_STRATEGY 是 no_battery_action（电池保持不动），自发自用只是候选。没有官方基线时，应按材料固定、公开自发自用基线参数；公平比较与期末电量口径已有实现可复用。 |
| 请求接受 / 实际观测 / 验证通过 | 部分，实际 Verify 缺失 | 当前 Observed 指自己算出的能量工件写入后能读回，没有外部实际功率、运行模式、观测时间、生效窗口、容差、持续性及独立校验结果。应单独实现设备执行校验器。 |
| 延迟、超时、控制失败、有限重试 | 缺失 | 当前整日执行在一次事务中完成，成功才存完整回执；异常抛出回滚。需持久化等待/失败状态、有限重试、停止依赖失败动作的后续步骤及告警。 |
| 运行中偏差重规划与周期调度 | 缺失 | 当前是用户点击重新计算，执行时立刻跳完整天。需让短时回读校验与周期调度独立运行，按最新有效状态重算未执行时段。 |
| 暂停自动调度、人工接管 | 缺失 | 尚无自动调度及接管状态机。需管理入口和持久化暂停/接管状态，阻止新动作继续发出。 |
| LLM 不可用时的规则降级 | 部分 | 确定性策略不依赖模型是可复用基础；尚无模型不可用、有效输入/约束门槛、规则运行与告警转人工的完整状态及验证。 |
| 成人视图 | 部分 | 有单站工程控制台；缺三站总览、实际运行成本、异常管理和家庭管理入口。 |
| 长辈三个典型问题 | 缺失 | 能源注册任务主要是 SOC 查询和计划生成，未支持“为什么现在充电”“有电为何仍买电”“是否按计划执行”的事实与执行证据问答。 |
| 儿童只读视图及家庭权限 | 缺失 | SVG 可复用但仅是关系示意；未实现儿童表达/只读身份、长辈只读与成人控制权限。本地 business-user 开发身份不等于家庭角色体系。 |
| 轻量 Energy Ontology | 部分 | 已有 site/device/tariff/forecast/energy_plan 等声明；PlanStep/ExecutionRecord 在执行类型中存在，但未完整关联进语义与解释 API。优先补对象关联，不扩建图谱管理产品。 |
| 共用事实的业务解释 | 部分 | A4 能核对发布关系与工件，但不包含设备执行结果。正常生成计划默认 limited；正例 E2E 直接插入候选后人工审核发布，不能证明生产计划会自动生成可用因果解释。 |
| 可复核效果报告 | 部分 | 有仿真成本与公平比较约束；缺三站逐站结果、实际回读计算成本、执行可靠率/等待/超时/失败数、预测 MAE。计划预测、运行结果、官方结算三类数值尚未形成产品输出。 |

关键代码位置：[固定单设备 planKey](../../platform/apps/api/src/http/energy-plan-versions.ts#L11)、[无设备适配的执行器](../../platform/apps/api/src/composition/virtual-solix-execution.ts#L33)、[合成输入与评估时点](../../platform/apps/api/src/composition/home-energy-scenario.ts#L369)、[当前基线](../../platform/packages/extensions/home-energy/src/planning/types.ts#L65)、[能源任务](../../platform/apps/api/src/scenarios/home-energy-tasks.ts#L19)、[A4 测试直接插入候选](../../platform/tests/e2e/local-product.browser.e2e.ts#L116)。

## 需要修复的现有代码问题

以下是已有路径的具体缺陷，与上面的未实现功能分开。P1/P2 指代码审查严重度；下一节 P0 指产品验收必要性。

### R01 · P1：已有计划后的请求失败被页面隐藏

位置：[failed reducer](../../platform/apps/web/src/state/energy.ts#L253)、[错误面板](../../platform/apps/web/src/components/EnergyPlanPanel.tsx#L554)。

触发：至少已有一个计划、页面处于 ready，此后构建、正式运行发布或执行发生普通 HTTP/网络错误。failed 保留 ready，只把 error 放进 state；组件仅在非 ready 时展示 error。用户继续看到旧计划，无法得知操作为何失败。初次无计划失败、权限拒绝、明确未配置走其他分支，不能覆盖此问题。

修复：保留可查看的旧数据，同时独立显示本次操作的错误、traceId 和恢复操作。回归应覆盖“首版成功后，第二次构建/执行失败”。

### R02 · P2：页面丢响应后无法利用后端幂等恢复执行回执

位置：[客户端每次新建 key](../../platform/apps/web/src/api/client.ts#L719)、[后端拒绝新键重复计划](../../platform/apps/api/src/composition/virtual-solix-execution.ts#L129)。

触发：执行已提交，HTTP 响应丢失；页面重试产生新幂等键，后端拒绝“该计划已执行”。页面没有收到 executionId，也没有复用原键，无法取回已完成回执。后端同键重放机制正确，但用户入口没有接上。

修复：一次逻辑执行保留同一 key 和请求身份，重试复用；重载后可按持久化执行身份查询。不得用新键再次发控制动作。

### R03 · P2：执行器接受未注册的操作版本

位置：[只校验 operation ID](../../platform/apps/api/src/composition/virtual-solix-execution.ts#L80)、[注册版本为 1](../../platform/packages/extensions/home-energy/src/compute/manifest.ts#L26)。

触发：有效计划执行请求把 operationRef.version 改成 999，其他字段保持有效。Virtual runner 没有按 id/version 查注册表；发布授权回调的输入也不包含 operationRef。

**本轮临时集成复现**：真实 PostgreSQL、blob 与 HTTP 返回 202，回执记为 home-energy.simulate@999，并生成 96 步，而预期为副作用前拒绝。复现沿用既有集成夹具的发布授权回调替身，未将此测试包装为完整产品发布验收。

修复：在所有副作用之前校验完整操作引用与版本；未知版本不产生执行记录或状态推进。

### R04 · P2：超过最近 500 条预览后，合法计划可能无法执行

位置：[执行查找](../../platform/apps/api/src/composition/virtual-solix-execution.ts#L91)、[历史列表 LIMIT 500](../../platform/apps/api/src/composition/postgres-energy-simulation-store.ts#L33)。

触发：计划尚未执行且仍合法，之后新增至少 500 个其他仿真/预览，没有替换 Selected；所需记录退出最近 500 窗口。执行器把列表当工件定位索引，找不到后返回 INVALID_ARGUMENT。

**本轮临时集成复现**：在真实 PG 插入 501 个更新、无关的预览元数据后，合法归档计划执行从预期 202 变为 422 / INVALID_ARGUMENT。所插入元数据只用于构造分页边界，未伪造设备观测或创建 501 次模型调用。现有 history>100 测试覆盖 PlanVersion 精确读取，未覆盖本路径。

修复：从已发布计划/resultRef 精确定位输入与计算工件，或提供可证明完整的有界分页；近期列表不能决定合法计划是否存在。

### R05 · P2：天气实体达到扫描上限后，完整 A4 解释也会降级

位置：[天气起点查找](../../platform/apps/api/src/composition/energy-run-explanation.ts#L93)、[UUID 排序分页](../../platform/packages/adapters/control-postgres/src/identity-decision-store.ts#L212)。

触发：同一 scope 有 32 个非 retired 的天气实体时，查询达到上限就加入 WEATHER_ENTITY_SCAN_LIMIT，最终强制 limited；更多实体时，当前运行的天气实例还可能根本不在前 32 个中。已确认的正确链路不能持续稳定查询。

修复：按本次场景的稳定原生键定位，处理唯一性与歧义；或者完整、受控分页查找。保留安全降级，但不要把全库任意前 32 个当起点索引。

### R06 · P2：可比但持平/亏损的结果被误标为不可比

位置：[收益面板](../../platform/apps/web/src/components/EnergyPlanPanel.tsx#L309)、[比较规则](../../platform/packages/extensions/home-energy/src/planning/baseline.ts#L119)。

触发：comparable=true，但方案成本持平或更高，因此 savingsClaim=false。页面把所有 false 都显示为“口径不同 / not_comparable”，隐藏正常的零或负节省差额，与材料要求冲突。

修复：先判断 comparable；可比时显示带符号差额及持平/更贵，只有不可比时解释缺失口径。不能用取绝对值把成本增加变成收益。

### R07 · P2：A4 把计算证据错误标成 SOC 来源

位置：[SOC 来源标签](../../platform/apps/web/src/components/EnergyPlanPanel.tsx#L748)、[实际取 candidate_total_cost 证据](../../platform/apps/api/src/http/local-plan-detail.ts#L236)。

sourceEvidenceRef 实际是费用/计划 simulation compute 证据，UI 却称 SOC 来源。用户展开无法沿它找到最初的 SOC 查询依据。修复应分别返回与展示 SOC 来源证据和计算结果证据，不只改成含糊的统一“来源”。

### R08 · P2：本体指标把定义关系数量显示为实例关系数量

位置：[计数来源](../../platform/apps/web/src/components/EnergyPlanPanel.tsx#L503)、[指标标签](../../platform/apps/web/src/components/EnergyPlanPanel.tsx#L543)。

默认 A4 limited、没有已确认实例路径时，仍以 definition.declaredRelations.length 显示 3，并标“已声明的实例关系”。修复应分开“行业定义关系数”和“本次已确认实例边数”；不能把声明存在当实例已建立。

### 已排除的疑点

EnergyOverview 优先读取 version.scenario，再使用当前可编辑 scenario，因此不会把旧计划 interval 绑定到新来源。这一项不列为缺陷。顶部指标将已归档计划 SOC/成本与可编辑备用目标并列，建议标“待应用目标”，但不据此扩大为整条来源链错误。

租户隔离、Selected 互斥、写入前复核和并发同键执行已有真实实现与相关验证；本轮没有找到这些路径的明确越权或重复执行缺陷。不能因此宣称整库安全审计完成。

## 建议开发顺序：按预赛目标收敛

以下按 poc-flow 区分优先级、就绪状态与验收。不是已批准启动的循环或工期承诺。

| 顺序 / 优先级 | 就绪条件 | 最小产出与验收 |
| --- | --- | --- |
| 1 / P0：重新对齐比赛验收与修确定缺陷 | ready：材料与代码已具备 | 将本材料作为比赛分支的需求索引；旧单户 SPEC 保留为历史子集。修 R01—R08 并保留反例。无需扩张通用本体平台。 |
| 2 / P0：赛用适配器单站链路 | discovery：核对赛事连接方式、控制字段、单位/方向、模式、传感器时间与授权 | 通过 DevicePort/来源适配器挂载 HA/SOLIX；一站读取→一条合法控制→独立实际回读→窗口/容差验证。缺资源时只能验适配器契约，不能关闭官方接入验收。 |
| 3 / P0：短时验证、失败和接管 | 单站接口与观测含义确定后 ready | Requested/Accepted/Observed/Verified/Failed 分开存；延迟、有限重试、失败停止、暂停/接管均留持久证据。执行器按当前时段运行，不把瞬间算完一天当现场执行。 |
| 4 / P0：站点参数化与三站复用 | 可先定义站点契约；三站接入需赛用数据 | siteId/deviceId 贯穿快照、版本、状态、执行、成本和权限，单站调度器复用到 A/B/C；一站故障不影响另两站，不做跨站电力交换。 |
| 5 / P0：预测、正确基线与变化重规划 | 历史/天气/价格字段明确后 ready | 轻量分站预测、官方或固定自发自用基线；周期重规划与短时 verify 分离，天气/负荷/实际偏差用最新有效状态更新后续计划。以决策时刻 asOf 阻止未来信息泄漏。 |
| 6 / P0：家庭表达与事实问答 | 计划/执行事实和来源 API 稳定后 ready | 成人控制台、三个典型只读问答、儿童能源流图共享同一站点/时间/计划/执行数据；成人有管理权限，其余角色不发指令。可先做好有限问题，不先建设开放聊天平台。 |
| 7 / P0：指标与连续演示 | 前述链路稳定后 ready | 分站预测成本、观测运行结果和官方结果分列；同条件成本差额可正可负；预测 MAE、执行可靠率及等待/超时/失败数可复核。演示三站→天气扰动→一次执行与延迟/失败→家庭追问→验证记录。 |
| 后续 / P1：能力优化 | 出现已测性能、预测误差或交互缺口 | 更复杂优化器、模型决策、更多行业包等按证据推进；保留已有解耦，不把框架删成难以替换的赛题脚本。 |

必要解耦应继续保留：行业声明、站点/物理数据 mapping、设备适配器、Agent runtime、存储与模型端口各自装配。当前首要复用资产是可靠的站点执行和证据契约；不要求每个家庭拉一套长期分支，也不让每次计划必须先手工审核三跳关系才可解释。

## 本轮验证记录

| 检查 | 本轮结果与限制 |
| --- | --- |
| 远端分支与 worktree | 确认 HEAD 与远端同为 37f3feb；五树用途、合并/补丁等价与用户脏改动已核对 |
| lint / typecheck / build:web | 全部通过 |
| 定向单元、UI、架构 | 第一轮 9 文件 / 134 项通过，另一个 UI worker 启动超时；降低并发重跑该 UI 与架构，2 文件 / 15 项通过。两轮有重复项，不相加作为覆盖率 |
| 能源真实数据库集成 | energy-simulation-ui-postgres.spec.ts：1 文件 / 11 项通过，使用临时 PG、不可变 blob、HTTP 路由 |
| 产品浏览器链路 | local-product.browser.e2e.ts：1 文件 / 5 项通过，使用临时 PG、实际 API、构建后的 Web 与 Chromium；覆盖单户 A/B/C、虚拟执行、过期拒绝和运行持久化 |
| 新缺陷反例 | 临时 PG/HTTP 反例 2 项均按正确预期失败，分别确认版本 999 被执行、501 条后执行查找误拒绝；不是既有测试套件回归失败 |
| 没有进行 | 全量测试/负载审计、真实公司模型/JEV、官方 HA/SOLIX 接入、三站实测、预测 MAE 与运行收益验证 |

因此结论是“现有受控仿真主要路径能运行，但审查仍有明确未修问题，预赛目标也有核心缺口”，不是 clean review 或产品总验收通过。

