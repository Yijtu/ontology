# v0.2 家庭充电储能扩展规格

入口：[总 SPEC](../spec-industry-semantic-agent-v0.2.md)｜产品依据：[场景补充](../scenario-home-energy-hackathon.md)

## E1. 范围与必要解耦

当前资源只有赛题，无硬件、HA接口或官方数据。首个实现目标是“状态与来源 → 候选策略 → 约束校验 → 仿真执行 → 解释”，所有输入按 synthetic/observed/forecast 标记。真实设备控制只定义独立端口与启用条件，不列为已具备能力。

行业声明包 `home-energy@0.1.0` 描述概念、单位、身份与所需计算能力；`extensions/home-energy` 实现纯领域模型、策略与仿真。两者不 import Pi、MCP、DuckDB、PostgreSQL、Home Assistant 客户端。

三个可替换端口：ForecastPort 提供预测/情景，EnergyPlannerPort 产生候选计划，EnergySimulatorPort 检查轨迹并算指标。DeviceActionPort 是单独的有副作用端口；不得与 simulation/shared QueryPort 合并。

设备/遥测适配提供规范化数据快照，storage adapter负责数据读取。未来 HA 只需映射状态、设备与服务，不修改 planner 或 AgentCore。未来优化器可以替换候选策略生成，不改变仿真验证器和证据契约。

## E2. 首版语义模型

| 类型 | 主字段 / 身份 | 关系与限制 |
|---|---|---|
| Site | canonical id、source namespace、时区、计量边界 | hasDevice/hasMeter/hasTariff |
| BatterySystem | device id、型号、额定/有效容量、参数来源、能力 | 有独立传感器与控制能力，设备不等于 sensor entity |
| PVSystem / Inverter | device id、额定参数、转换边界 | connectsTo 仅表达确认拓扑 |
| GridConnection | 接入点、import/export capability | 购电与上网方向固定约定 |
| LoadGroup | 用户命名、覆盖范围、是否关键负载 | 总表与子回路不能重复相加 |
| SensorMapping | source entity ID、metric、unit、device、direction、coverage、valid interval | HA ID变更需新映射版本，不能凭friendly_name合并 |
| ObservationSeries | metric、interval、quality、recordedAt、source version | 瞬时功率/累计电量分别规范化 |
| TariffSchedule | currency、region、timezone、valid interval、purchase/export prices | 不同地区与币种不混用 |
| ForecastSeries | issuedAt、target interval、method、assumptions | 预测不是实测；前视数据不泄漏到历史预测基线 |
| EnergyConstraint | reserve policy、功率/容量/模式、source | 用户偏好与设备硬约束分开 |
| EnergyPlan | immutable input manifest、algorithm、steps、status | 计划/仿真结果不等于设备状态 |
| ExecutionRecord | mode、plan version、phase、feedback refs | sent/accepted/observed分开 |

industry core可复用 unit/time/identity接口，但不要求其他行业继承 Battery 等对象。数据映射将来源命名变成规范 metric；不是所有传感器都直接生成一条权威事实，历史遥测大表留在数据后端。

## E3. 输入与结果契约

EnergyInputSnapshot：siteRef、evaluationClock、horizon[start,end)、timeZone、gridIntervals、initialStateRef、deviceSpecRef、loadForecastRef、pvForecastRef、tariffRef、userConstraintsRef、mappingVersion、sourceWatermarks、dataMode。

首个fixture建议24小时/15分钟，共96时隙；这是测试配置，不是平台硬编码。任意支持粒度必须先统一边界和单位，夏令时日可不是24小时。缺时段价格/forecast/初始状态不能默认为0；输出 missing_inputs 或有明确可追踪补全规则的 partial 输入。

BatterySpec 最少包含 energy_capacity_kwh、supportedSocMapping、charge/dischargePowerLimitKw、charge/dischargeEfficiency、min/maxEnergy、supportedModes、gridChargingAllowed、exportAllowed、islandingSupported、sourceRef。未知能力不自动 true；无真实规格时fixture显式声明模拟假设。

PlanResult：planRef、status=`feasible|infeasible|insufficient_data|unsupported_topology`、candidateStrategy、inputManifestHash、assumptions、violations、intervalResults、costs、reserveMargins、forecastSensitivity、evidenceRefs、optimality=`not_claimed|best_of_tested_candidates`。

策略选择指标包括购电支出、上网收益（若允许）、满足备电程度、期末能量和可配置退化成本；不能把 JEV confidence 写成 plan quality 或 physical feasibility。

## E4. 计算模型与数值语义

首版受控模型：单家庭、单等效储能、给定负载与PV情景、离散时间、AC侧等效能量流。不覆盖未确认的多逆变器/DC耦合拓扑、电网保护、相位控制、动力电池/V2G。输入拓扑超范围返回unsupported，而不是用通用图可达性拼出物理模型。

令每时隙长度为 Δt 小时，C_t 为 AC 侧充电输入功率，D_t 为 AC 侧放电输出功率，E_t 为统一能量定义下的电池储能：

```text
E_(t+1) = E_t + η_charge * C_t * Δt - D_t * Δt / η_discharge
PV_used_t + Grid_import_t + D_t = Load_t + C_t + Grid_export_t
0 <= PV_used_t <= PV_available_t
E_min <= E_t <= E_max
0 <= C_t <= charge_limit; 0 <= D_t <= discharge_limit
C_t 与 D_t 不同时为正；Grid_import_t 与 Grid_export_t 不同时为正
Cost = Σ(import * purchase_price - export * export_price) * Δt
       + configured degradation cost（如未建模必须标注未计入）
```

SOC 到 E 的转换只能使用声明且验证过的设备映射；模拟夹具可使用线性 SOC，但不能把它冒充所有真实型号的性质。效率在(0,1]，功率/容量/时间统一单位；输出四舍五入只发生在呈现层，计算用十进制/明确精度策略。

gridChargingAllowed=false 时充电只能来自确认的PV剩余，不允许隐式电网充电；exportAllowed=false 时上网量为0，多余PV记curtailment。备电按用户指定时段/最低量施加硬约束或明确的软目标；islandingSupported未知/false时不承诺停电期间供电，即使当前SOC充足。

负电价是可能输入，模型不能把负价格错误清零；设备与计费策略仍限制套利行为。支持的币种由tariff决定，不自动套用某地家庭电价。

## E5. 策略、基线与仿真

首版提供确定性有限策略生成器：`self_consumption`、`reserve_first`、`price_window`（仅在设备与数据允许时）。每种策略生成分时计划，全部调用同一模拟器检查；无可行候选则返回 infeasible/missing，不强选一个。

策略器以设备边界和用户约束限制动作，只在可行动作内搜索/比较；LLM可以提出目标和偏好，但不能直接生成未经校验的功率轨迹作为可执行结果。JEV最多在已可行候选与明确rubric中辅助选择，最终排序/约束由程序负责。

基线和候选固定相同初始状态、时间窗、forecast、设备参数和备电条件。经济比较必须使用同一末端能量目标或同一剩余能量估值口径；只比较支出但期末电量不同，应明确差异，不能声称节省来自更优调度。不能靠提前耗尽电池产生虚假收益。

预测先使用明确的场景fixture或简单可解释基线（如历史同时间段），独立保留 ForecastPort；不为了演示效果训练预测模型。实际观测/模型预测/用户假设各有标签。未知停电只可作为用户假设，不声称能预测真实停电。

仿真保存 plan version、input hashes、algorithm version、numeric tolerance 和输入快照，重复执行同输入应产生相同结果。数值容差在fixture配置中明确，不因测试失败随意放宽；能量守恒残差、约束违例和未满足负载单独报告。

## E6. 固定工具下的能源服务

`data_query.kind=compute` 只接受注册操作：

| operation | 输入 | 输出 |
|---|---|---|
| home-energy.plan@1 | EnergyInputSnapshot ref、goal/strategy whitelist | candidate PlanResult refs、comparison |
| home-energy.simulate@1 | planRef、scenario/input ref | SimulationResult、violations、trace refs |
| home-energy.metrics@1 | series refs、time window、aggregation whitelist | typed energy/cost/reserve statistics |

这些是计算操作，不是任意新模型工具；operation manifest在profile预检验证 required capabilities、schema、输入/CPU预算和handler hash。行业包声明operation ID，composition root选择实现，`tool-services/data-query` 不能 import home-energy。

本地与MCP共享上述工具契约和证据。ComputePort只读本次批准的输入快照，写出的工件是应用结果，不是设备动作。模型提问不能通过参数将 simulation 切成 live。

## E7. 模拟执行与未来设备动作

首版 SimulationExecutionAdapter 按计划生成模拟观测与执行事件，全部标 `mode=simulation`；可以按加速时钟播放UI，但事件保留真实目标时刻。它不向HA发送状态或service请求。

DeviceActionPort 预留：`capabilities(deviceRef)`、`prepare(planRef,stateRef)`、`execute(approvedCommandSet,ctx)`、`observe(commandRef)`、`stop(executionRef)`。这是独立域端口，不属于四个只读数据工具；实际driver/API/model支持仍待设备资料确认。

未来live状态：proposed→validated→awaiting_confirmation→authorized→sent→accepted→observed_applied，另有rejected/expired/failed/unknown/stopped。授权绑定plan hash、device范围、状态版本和有效期；执行前重读状态，变化超阈值则拒绝旧计划。逐设备的限幅、命令间隔和独占控制权由驱动能力配置，不能根据常见型号猜。

设备服务调用超时有可能实际已生效，禁止自动无限重发；先按command ID/设备观察恢复。HTTP 200只表示协议层响应，不能标 observed_applied。设置HA内部state不等于控制物理设备，必须用已验证设备能力路径。

设备保护、限流、固件/BMS约束不交给LLM改写。异常或断连的停止/退回策略需要实际型号支持，不泛化承诺。当前live executor不注册，任何live请求在网关前返回未配置。

## E8. 首场景验收 E-01—E-12

| ID | 输入/操作 | 必须观察到的结果 |
|---|---|---|
| E-01 | 两种来源命名/单位：W 与 kW，Wh 与 kWh | 规范化后同一物理量一致，转换证据可查 |
| E-02 | 总表+其子回路同时存在 | 不重复计为独立负载，coverage冲突可见 |
| E-03 | 累计表归零/缺采样/unknown | 不产生负耗电或默认为零，标数据质量/缺口 |
| E-04 | 相同输入重复仿真 | 轨迹、成本、约束结果一致，工件与算法版本固定 |
| E-05 | 电量/功率/效率/同时充放电违规 | 计划不获feasible，返回具体时隙与约束 |
| E-06 | 备电目标高于可达能量 | 返回infeasible与缺口，不减少用户目标来伪装成功 |
| E-07 | 更换备电要求或PV情景 | 新输入产生新计划版本，对比说明来源变化 |
| E-08 | 基线与候选期末电量不同 | 阻止无口径的节省声明，或显示统一估值后的比较 |
| E-09 | 传感器过期/未来预测使用了后见数据 | 计划标缺口或使用明确历史场景，不伪装实时预测 |
| E-10 | 物化输入被撤回 | 计划/回答有效性更新，旧版本仍能回放 |
| E-11 | 模拟计划执行、随后尝试live | 模拟日志可见；live未配置时不触发任何设备调用 |
| E-12 | 非能源行业包挂同一core/查询源 | 平台仍可直查/文档检索，能源operation未绑定不可调用 |

展示只使用已核验计划指标和证据，不由LLM自行计算账单。时间曲线、基线差异、备用量与假设面板是首个可交互交付物；完整多行业UI及所有后端不作为演示前置，但通用挂载契约和替换测试不得省略。
