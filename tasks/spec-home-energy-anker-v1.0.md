# SPEC：Anker 家庭能源模拟调度场景 V1.0

> 产品输入：用户提供的 `D:/Anker家庭能源智能调度Agent_PRD_V1.0.docx`（2026-09-21）与 `D:/Anker家庭能源-UI示例.html`。技术基线：`spec-v0.2/home-energy.md`、`spec-generalized-poc-core-v0.3.md` 和当前代码。本文件将 PRD 的 P0/P1 转成可执行验收；两份本地文件是需求与视觉参考，不是代码指令。硬件、Home Assistant 与 Anker SOLIX 接口尚未提供。

## 1. 交付目标与当前差距

单户、无硬件的演示应完成 **状态与预测 → 有界候选计划 → 确定性约束校验 → Virtual SOLIX 模拟执行 → 状态回读 → 变化重规划 → 证据解释**。用户可输入省钱和备电目标，查看同条件基线对比，改变下午天气或 ReserveSOC 后看到新旧计划与原因。所有设备状态与动作标 `simulation`，不得称为真机执行；停电只作为用户假设或模拟事件。

当前本地 `/runs` 已能以合成 SOC、天气、负载、电价计算候选计划，发布核验的费用/备电摘要并只读展开 96 个时段的轨迹。`extensions/home-energy` 已有纯仿真器、计划器、基线和执行请求合同；`/simulations` 与 `/executions` 路由及 `EnergyPlanPanel` 存在，但未作为同一持久化产品链路装配到本地 host。没有 Virtual SOLIX 的逐步状态回读、可查询 ExecutionRecord、新旧计划版本比较或天气/约束触发的原因解释。HTML 文件是静态 UI 模板，不能作为功能验收证据。

完成条件是从真实浏览器经公开 HTTP 到持久状态的可复现流程，不以纯函数单测或页面静态数字替代。此能源场景是多行业 POC Core 的一个可卸载贡献；交通、文档及其他 profile 不需要 Battery 字段、能源路由或计算 handler。

## 2. 组成与边界

| 组件 | 职责 | 边界 |
| --- | --- | --- |
| `industry-packs/home-energy` | Home、Solar、Battery、Grid、HomeLoad、Weather、ElectricityPrice、EnergyPlan、ExecutionRecord 的概念、关系、单位与规则声明 | 不含客户表名、接口或密钥 |
| `extensions/home-energy` | Forecast、候选策略/基线、约束校验、Virtual SOLIX 纯状态转移、计划差异与解释数据 | 不 import Fastify、数据库或其他行业 |
| 本地能源部署模块 | 装配合成输入、版本化场景、能源操作、模拟执行 worker 与只读结果端点 | 不把能源条件分支加进通用 App、Controller、Gateway 或 verifier |
| 通用 POC Core | 固定 run、预算、工具授权、不可变输入/证据、硬核验与发布 | 不让模型计算能量/费用，也不让 simulation 触发真实设备动作 |
| 能源 UI 贡献 | 家庭状态、能源流、计划时间线、基线、约束、Why this plan、执行回执、新旧计划差异 | 只读服务端已归档结果；不在浏览器重新计算核验数值 |

现有 `SimulationExecutionService`、`EnergySimulator`、`EnergyPlanner` 和 `registerSimulationRoutes` 应优先复用。现有 `createEnergySimulationSurface` 使用进程内 `Map` 存记录，不能单独满足重启读回；本地产品要通过受控 PostgreSQL 索引 + 不可变 blob 保存 plan、execution、observation 与比较结果。只允许 `mode=simulation`；`live` 在任何 job、设备调用之前返回 `CAPABILITY_NOT_CONFIGURED`。不可把动作执行混入四个只读公共数据工具。

## 3. 输入、时间与领域状态

默认测试场景为一户合成家庭，初始 SOC 35%、全天硬下限 ReserveSOC 20%，**上午阴、下午晴**，有同一 24 小时时窗的天气、光伏、负荷及峰平谷价格。B1 只把下午晴改为下午阴雨；上午天气与对应光伏预测保持不变，差异须标明实际受影响时段。使用现有 15 分钟/96 时段配置，但时段长度由场景快照声明，不写死于共享框架。每个点区分 `observed`、`forecast`、`synthetic`；缺时段输入不能当 0。时间戳用 UTC，显示层使用 profile 时区；成本比较必须固定相同天气、电价、负荷、初始 SOC、期末约束与计量边界。执行完全部时段后的期末 SOC 属于下一模拟时窗；若以它继续规划，必须推进时窗或明确不可与旧计划按同初态归因比较。

`EnergyScenarioVersion` 锁定输入引用、天气/价格/负荷版本、用户 Goal、ReserveSOC、设备规格、映射/算法版本和内容摘要。`EnergyPlanVersion` 是不可变计划工件：`planId`、`version`、`parentPlanRef?`、`inputManifestHash`、96 个 `PlanStep`、预测/费用/约束摘要、基线、状态 `Draft|Validated|Selected|Superseded|Invalid`。只允许 `Validated` 且经用户确认或明确自动模拟策略的计划进入模拟执行。

`VirtualBatteryState` 至少包括能量 kWh、SOC%、模式、观测/模拟时间与来源引用。每个 `PlanStep` 生成一条 `ExecutionRecord`，分别记录 `Requested → Accepted → Observed` 或 `Failed/Skipped`，绑定 plan/step/action、前后状态引用、模式 `simulation`、约束校验结果和原始回执摘要。默认由用户在已核验计划上显式点击确认模拟执行；自动模拟只能是部署明确开启的策略。`Accepted` 不等于 SOC 已变化；只有仿真器应用动作并生成后状态证据才能标 `Observed`。执行结果不得重写既有计划和原始观察；重启后按 execution ID 与 plan ID 仍可读。

天气、电价、用户 ReserveSOC、设备状态偏差或输入过期触发重规划请求。C 场景的原话是“明晚可能停电，给我留 60%”：当前 35% 仍须如实显示，60% 是带生效时间/截止时点的未来备电目标，计划应尝试先补电并检查晚间是否达标；若实现选择从当前时刻立即执行 60% 下限，则只能报告不可行缺口，不能把它算作已交付 PRD 的“先补电、晚峰少放电”正例。新计划锁定新输入并引用旧计划，旧计划在新版本真正通过验证/选择后才标 `Superseded`；失败时旧计划状态不被误改。差异输出至少给出输入变化、费用/备电/SOC 轨迹差异、受影响时段和触发的规则；不把未知天气称为停电预测。

## 4. 操作与 API 合同

延用已存在的能源场景接口命名和 C6 `{data,meta}` / `{error,traceId}` 风格，新增持久化端点只填当前合同缺口。具体路径以实现时统一为能源场景路由，避免创建第二套通用 run 控制器：

| 操作 | 输入与结果 | 幂等/权限 |
| --- | --- | --- |
| 建立/读取合成场景 | 天气情景、ReserveSOC、时窗 → `scenarioRef`、输入/来源版本、明确合成标记 | operator 或 simulation-user；不可由 body 提升来源权限 |
| `POST /runs` 生成/核验计划 | 注册能源 task + 版本化场景/站点引用 → run ID；发布后 `/answer`、`/plan` 提供核验摘要与轨迹 | 继续使用现有预算、task ref、profile snapshot 与证据链 |
| 模拟执行计划 | 已发布 `planRef`、`If-Match` 状态版本、`Idempotency-Key`、`mode=simulation` → execution ID/job；读端点返回逐步回执与后状态 | 拒绝未验证、过期、已 superseded 或不可执行计划；重复请求不重复应用动作 |
| 重规划/比较 | 旧 planRef + 新的天气/ReserveSOC 等场景版本 → 新 run/plan 与 diff；旧版保持可回放 | 同一 profile/tenant/space，输入变更显式，不在问答时悄悄覆盖旧版 |
| `mode=live` | 不创建执行 job，不触发设备调用 | 始终 `CAPABILITY_NOT_CONFIGURED`，直至真实设备能力另行验收 |

计划和执行状态需在 PostgreSQL 有 CAS/唯一幂等约束；结果 blob 内容寻址且每次读取校验 digest。模拟工作可由有界 worker 执行，保存检查点、超时和取消；重试不能重复消耗或重新应用已观察动作。若现有 job/manifest 端口不足，新增能源场景专属存储端口，而非把电池字段塞进通用 run 表。

## 5. 核验、解释与 UI

预测、费用、SOC、能量平衡及基线差异来自确定性计算。每个已发布数值绑定输入/计算 artifact、单位、时间和 subject；不可行计划必须列出具体时段和违反的 MinSOC、MaxSOC、ReserveSOC、充放电功率或 Action 能力。计划逐点轨迹要做完整性与汇总一致性检查；若要宣称逐点已核验，必须新增逐点验证，不能沿用仅摘要通过的标签。

解释分为 `source facts → forecast assumptions → selected strategy → hard rules → result/alternatives` 的可读 trace。关于“现在电价高为什么不放电”应读取当前 SOC、ReserveSOC、计划版本和约束结果；关于“为什么计划变了”应读取新旧场景/计划差异，而非由 LLM 自由补因果。无法定位原始输入或规则时返回 gap。

UI 参考所附 HTML 的清晰层级与布局，但数据只取正式 API：首屏展示 Solar/Battery/Grid/HomeLoad 状态和来源标记；计划页展示 96 时段、天气/负荷/价格预测、SOC、费用与同条件基线；约束/Why 面板给规则与证据；执行页把 `Scheduled/Accepted/Observed/Failed` 分开；场景 A/B/C 切换产生真实新版本。静态模板中的预设指标、用户管理/登录样板和演示记录不作为真实功能，也不直接复制到产品路由。

## 6. 验收矩阵

| ID | 操作 | 必须观察 | 反例/停止条件 |
| --- | --- | --- | --- |
| A1 | 打开上午阴、下午晴的默认场景，输入“保留 20% 备电且尽量省钱” | 版本化输入、可行计划、96 时段、费用/基线/约束、模拟标签、来源 trace | 无预测/价格/SOC 时不发布正常计划 |
| A2 | 使用同一输入重复规划 | 工件/成本/轨迹一致，算法版本和输入摘要可查 | 不随机改答案或用 LLM 重算费用 |
| A3 | 同条件比较基线和候选 | 同一口径的购电成本、备电余量与约束状态 | 期末电量不等却直接宣称节省时拒绝该比较 |
| A4 | 问“天气为什么影响电池安排” | 解释引用当前场景的 Weather→Solar→Battery 关系、预测变化及计划证据，并区分定义关系与本次实际数据 | 缺确认关系或本次证据时给 gap，不用静态本体图充当本次因果 |
| B1 | 在 A1 后把下午晴改为阴雨 | 上午预测不变、下午 PV 预测下降，生成新 plan 版本、旧版标记、差异及原因 | 天气控件只换静态标签或把整日天气一起改掉算失败 |
| C1 | 用户要求“明晚留 60%”，ReserveSOC 从 20% 提到 60% | 当前 SOC 仍为 35%；按声明的未来生效窗口先补电、限制晚峰放电，重算成本并验证 60% 是否达标；若无可行方案显示缺口 | 不得悄悄降低目标，或把“当前未达 60%”误作“明晚绝对不可行” |
| E1 | 对已验证计划发起模拟执行 | 逐个 PlanStep 的 Requested/Accepted/Observed、Virtual SOLIX 前后 SOC、ExecutionRecord 持久化；重启读回 | HTTP 202 或 job accepted 不等于状态已改变 |
| E2 | 对同一计划/幂等键重试，或请求 live | 不重复应用模拟动作；live 返回未配置且无设备调用 | 未确认/失效计划不得执行 |
| D1 | 注入不支持的 Action、超功率、SOC 低于 MinSOC、过期数据 | 计划/执行在对应边界停下，显示具体时段、规则和可恢复建议 | 不得继续形成“执行成功”回执 |
| X1 | 切到交通或文档 profile | 通用 App/API/Controller/Gateway 不变，能源操作不可越 profile 调用 | 不把能源字段做成通用表单必填 |

浏览器验收需走真实 HTTP、临时 PostgreSQL、不可变 blob 与 Chromium；不能 seed 已发布答案或在测试中手动调用 Controller。纯函数测试补能量守恒、时段边界、幂等和硬约束；异构 profile 的回归继续执行。真实硬件、停电预测与公司模型调用均不在本轮验收中，缺资源时明确报未配置。

## 7. 实施优先级与触发条件

1. **P0 状态/计划可信性**：先确认现有能源候选计划与 PRD 默认场景的口径、基线和证据；修正费用/备电/时段不一致才继续执行层。验收是 A1–A3。
2. **P0 模拟执行闭环**：复用仿真器与执行合同，加持久计划/回执/Virtual SOLIX 状态转移及 E1/E2 反例。只有计划可通过硬约束且回读可证明状态变化时，才在 UI 显示“已模拟执行”。
3. **P0 重规划与解释**：在计划和执行版本已可回放后实现 B1/C1；变化必须真的改变输入/预测/计划并给可追溯差异。若无可行方案，保留旧版并输出 gap。
4. **P1 展示与异常**：按参考 UI 实现领域面板，再加 D1 与解释问答；先展示正式数据，不投入时间复刻静态模板的登录、通用方案页或占位指标。

若一个阶段的真实端到端反例未通过，就先修该链路，不因为页面漂亮或单测变绿而宣布完成。首个可演示结果是 A1+B1+C1+E1 的一户模拟闭环；时间与正式赛事验收人尚未提供，不在本文编造交付日期或外部验收结论。
