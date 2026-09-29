# V03-055：实现桥架清单映射与不可变报价输入

阶段 B · backend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #55，本批尚未开始实现。

## 目标与范围

- 定义quote-input领域Schema、规格/行身份/精确数量/sourceRowRef/确认refs、客户mapping与scope coverage，使用A parser及批准records冻结snapshot。
- 同规格两行保留不同inquiryLineId，不错误合并工程量；source row、真实批准数据与quote parameters refs/digest精确一致。
- 每阶段对账expected/included/excluded/blocked行，排除须确认理由；修订生成新snapshot，旧输入不回填最新价格/规则。

## 依赖与进入条件

依赖：[V03-051](issue-051-accepted-main-sync.md)、[V03-052](issue-052-industry-package.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 定义quote-input领域Schema、规格/行身份/精确数量/sourceRowRef/确认refs、客户mapping与scope coverage，使用A parser及批准records冻结snapshot。
- [ ] 同规格两行保留不同inquiryLineId，不错误合并工程量；source row、真实批准数据与quote parameters refs/digest精确一致。
- [ ] 每阶段对账expected/included/excluded/blocked行，排除须确认理由；修订生成新snapshot，旧输入不回填最新价格/规则。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#32-精确字段与确认](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#32-精确字段与确认)
- [spec-electrical-costing-mvp-v0.3.md#33-输入覆盖与排除](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#33-输入覆盖与排除)
- [spec-electrical-costing-mvp-v0.3.md#44-输入函数绑定与-compute-parameters](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#44-输入函数绑定与-compute-parameters)

故事范围：P.US-008、P.US-010、P.US-012、P.US-013、P.US-017。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-008.AC-01 → P-T008-01：抽取请求使用固定版本的类型、属性、关系、单位和规则约束；不得仅在响应之后才做 Schema 校验。
- P.US-008.AC-02 → P-T008-02：属性保留原始值、规范值与来源位置，数量和尺寸不得先经有损浮点转换。
- P.US-010.AC-03 → P-T010-03：原始记录保持稳定行标识；实体合并不会删除独立业务记录。B 验证同规格多行不丢数量或项目位置。
- P.US-012.AC-01 → P-T012-01：可建立项目、输入业务目标、选择已发布行业包；页面显示项目、行业、客户范围和所用版本。
- P.US-013.AC-01 → P-T013-01：XLSX／CSV 可选择工作表并确认／调整列对应关系，显示原行号、名称、规格、数量和单位；JSON／文本进入相同审核流程。
- P.US-013.AC-03 → P-T013-03：显示总行、已解析、待确认、无法处理、拟计价和排除数量；排除须有理由。
- P.US-013.AC-04 → P-T013-04：重复导入按文件修订处理；跨页仍保持行完整，新资料不能查询到另一项目的示例数据。
- P.US-014.AC-01 → P-T014-01：关键字段展示原文、当前值、单位、来源和 pending／confirmed／conflict 状态。
- P.US-017.AC-01 → P-T017-01：输入以不可变快照绑定批准行、参数、行业／规则／价格版本、函数版本及完整性。
- P.US-023.AC-02 → P-T023-02：B 在同一桥架语义版本下挂载两套合成客户映射，批准后的同口径报价结果一致。
- P.FR-18 → P-F18：系统必须使本次项目的实际批准数据可由业务动作读取。
- P.FR-19 → P-F19：系统必须报告清单各处理阶段的行数和覆盖情况。
- P.FR-24 → P-F24：系统必须固定报价输入、价格、规则和函数的版本引用。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行；无提交/PR/远程 Issue 编号。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
