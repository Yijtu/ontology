# V03-068：验证两个客户结构映射与独立报价对照测试

阶段 B · infra · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #68，本批尚未开始实现。

## 目标与范围

- 两种客户列名/单位/行结构从真实parser/mapping/confirmed snapshot进入同语义synthetic任务，比较独立预期和实际输出。
- 至少1001行、不丢行/合并工程量、跨客户refs/模型上下文/证据/export拒绝；共享包不带客户价格。
- 机制fixture与real held-out GoldCase分开，adapter相同套件及受影响通用回归保存证据；测试期望不调用被测公式计算。

## 依赖与进入条件

依赖：[V03-055](issue-055-quote-input-snapshots.md)、[V03-058](issue-058-quote-task-operation.md)、[V03-065](issue-065-comparison-review-service.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 两种客户列名/单位/行结构从真实parser/mapping/confirmed snapshot进入同语义synthetic任务，比较独立预期和实际输出。
- [ ] 至少1001行、不丢行/合并工程量、跨客户refs/模型上下文/证据/export拒绝；共享包不带客户价格。
- [ ] 机制fixture与real held-out GoldCase分开，adapter相同套件及受影响通用回归保存证据；测试期望不调用被测公式计算。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#101-可实施测试矩阵](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#101-可实施测试矩阵)

故事范围：P.US-013、P.US-017、P.US-023、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-023.AC-02 → P-T023-02：B 在同一桥架语义版本下挂载两套合成客户映射，批准后的同口径报价结果一致。
- P.US-023.AC-04 → P-T023-04：共享资产导出不含私有项目实例、价格和密钥；完成适用边界测试。
- P.FR-16 → P-F16：系统必须隔离共享行业资产和客户项目数据。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 执行 pnpm run verify、适用的 pnpm run test:acceptance；保存实际命令、环境、结果与资源清理证据。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行；无提交/PR/远程 Issue 编号。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
