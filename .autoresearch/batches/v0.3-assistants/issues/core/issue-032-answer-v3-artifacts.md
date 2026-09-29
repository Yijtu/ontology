# V03-032：新增 answer@3、表工件 manifest 与分页读取契约

阶段 A · backend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #32，本批尚未开始实现。

## 目标与范围

- 新 schema/hash 固定 body、summary、table manifest、行/列绑定及 input/output digest；旧@1/@2历史继续可读。 finalizationReceiptRef/digest 固定required策略报告，结果manifest不反向引用报告。
- 大结果 refs/paged rows 与数据 bounds、stable row keys、sum/counts/complete状态具体定义，未核验原始工件不能作为正式表渲染。
- scoped reader/持久页签/checkpoint 支持全表核验回读；变更页、重复/缺行、digest错和错项目拒绝。

## 依赖与进入条件

依赖：[V03-002](issue-002-public-contracts.md)、[V03-003](issue-003-control-stores.md)、[V03-023](issue-023-task-input-artifacts.md)、[V03-031](issue-031-compute-execution.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 新 schema/hash 固定 body、summary、table manifest、行/列绑定及 input/output digest；旧@1/@2历史继续可读。 finalizationReceiptRef/digest 固定required策略报告，结果manifest不反向引用报告。
- [ ] 大结果 refs/paged rows 与数据 bounds、stable row keys、sum/counts/complete状态具体定义，未核验原始工件不能作为正式表渲染。
- [ ] scoped reader/持久页签/checkpoint 支持全表核验回读；变更页、重复/缺行、digest错和错项目拒绝。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-011、A.US-014。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-010.AC-02 → A-T010-02：保存输入／输出工件、逐字段计算证据、调用状态与完整性；模型不能给缺失数值编造计算结果。
- A.US-011.AC-01 → A-T011-01：writer 支持本阶段事实、规则、关系、结构化查询、原文引用和 compute 证据对应的类型化结果。
- A.FR-14 → A-F14：系统必须报告关系导航与查询结果的完整性。
- P.US-018.AC-01 → P-T018-01：结果字段形成类型化断言并绑定证据；显示、核验、发布和持久化采用同一版本。
- P.FR-26 → P-F26：系统必须将结果字段绑定到可核验的计算证据。

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
