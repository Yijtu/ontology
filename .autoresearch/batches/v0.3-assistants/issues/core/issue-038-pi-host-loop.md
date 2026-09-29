# V03-038：在 Core 正常入口装配 Pi 有界补证运行时

阶段 A · backend · P0 · 状态 planned · GitHub [#209](https://github.com/Yijtu/ontology/issues/209)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 真实 Pi 适配器注册到 Core profile/runtime factory，工具只经过同gateway，共享绑定和预算。
- 测试查询不足→受限补查→已核验最终结果；无新证据、工具不支持或循环cap正确停止。
- SDK stream/final不能发布，parallel/late calls/abort都受Controller管理，不加另一循环所有者或行业逻辑。

## 依赖与进入条件

Dependencies: #196, #199, #200, #201, #207

依赖：[V03-024](issue-024-nl-plan-receipts.md)、[V03-025](issue-025-semantic-sql-query.md)、[V03-029](issue-029-rule-source-provenance.md)、[V03-031](issue-031-compute-execution.md)、[V03-036](issue-036-typed-draft-writer.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 真实 Pi 适配器注册到 Core profile/runtime factory，工具只经过同gateway，共享绑定和预算。
- [ ] 测试查询不足→受限补查→已核验最终结果；无新证据、工具不支持或循环cap正确停止。
- [ ] SDK stream/final不能发布，parallel/late calls/abort都受Controller管理，不加另一循环所有者或行业逻辑。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-007、A.US-013、A.US-015。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-007.AC-01 → A-T007-01：固定验证问题覆盖列表／属性、规则判断与解释、文档依据及已注册计算，路由到当前授权项目和能力。
- A.US-013.AC-01 → A-T013-01：Template 支持已知步骤；动态 runtime 支持“查询不足→补查→完成”的有限测试路径，均由正常 HTTP 分派而非手动 Controller 启动。
- A.US-013.AC-03 → A-T013-03：generation 与 JEV 分端口；JEV 按需决策，概率不能改变权限或证明答案正确；缺决策模型时明确可用降级策略。
- A.FR-12 → A-F12：系统必须把受支持的自然语言问题转为授权任务。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#209](https://github.com/Yijtu/ontology/issues/209)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
