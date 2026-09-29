# V03-071：完成真实模型、权威函数与保留样本的业务验收

阶段 B · validation · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #71，本批尚未开始实现。

## 目标与范围

- 资源/权限/预算与验收人就绪后实际公司模型候选及提参评测、客户函数conformance和paired held-out项目逐行/类别差异验证。
- 使用已确认范围/算法/价格/税费/舍入/容差，保留授权造价师业务签核；客户/内部MVP接受另列。
- 未取得真实资源不能completed、不能用synthetic替代；失败归因与改进项明确，客户原始数据不进入公共repo。

## 依赖与进入条件

依赖：[V03-049](issue-049-authority-discovery.md)、[V03-050](issue-050-gold-acceptance-discovery.md)、[V03-069](issue-069-costing-browser-e2e.md)、[V03-070](issue-070-real-customer-adapter.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。
真实客户接口/许可/版本/配对gold或验收人缺失时真实路径不得标完成。机制可用合成资源单独验证；不得用替身关闭真实验收。

## 验收条件

- [ ] 资源/权限/预算与验收人就绪后实际公司模型候选及提参评测、客户函数conformance和paired held-out项目逐行/类别差异验证。
- [ ] 使用已确认范围/算法/价格/税费/舍入/容差，保留授权造价师业务签核；客户/内部MVP接受另列。
- [ ] 未取得真实资源不能completed、不能用synthetic替代；失败归因与改进项明确，客户原始数据不进入公共repo。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#73-四层验收与-goldcase](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#73-四层验收与-goldcase)
- [spec-electrical-costing-mvp-v0.3.md#11-外部依赖图纸与未验证风险](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#11-外部依赖图纸与未验证风险)

故事范围：P.US-004、P.US-006、P.US-008、P.US-016、P.US-017、P.US-018、P.US-022、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-022.AC-02 → P-T022-02：配对人工报价按稳定行标识比较参数、单价、数量、费用、税费与金额差异。
- P.US-022.AC-03 → P-T022-03：复核者记录接受／退回、原因和签核人；阈值来自签核口径，未签核不得显示“业务通过”。
- P.US-024.AC-06 → P-T024-06：CI 可重复执行并清理自建数据和资源；受控模型／合成函数验证与真实模型／客户样本验收分别报告。
- P.FR-33 → P-F33：系统必须保存人工报价比较和业务签核决定。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- pnpm run build:web 后执行 pnpm run test:e2e；按 vitest.e2e.config.ts 编写 tests/e2e/**/*.e2e.ts，真实 chromium 验证。
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
