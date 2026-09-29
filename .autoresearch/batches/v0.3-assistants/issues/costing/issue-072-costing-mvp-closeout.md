# V03-072：完成造价 MVP 使用文档、交接与最终交付门槛

阶段 B · infra · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #72，本批尚未开始实现。

## 目标与范围

- README按用户流程说明建行业、挂项目、导入/确认、补价、报价、看依据、导出/人工复核，给配置/迁移/启动和准确能力边界。
- 提交场景范围、accepted main SHA、scene commits、实际测试与真实验收结果、未覆盖项/依赖及可复用资产回流清单。
- 合格报价、客户/内部MVP验收与A通用完成分别满足；未具备真实客户验收只标内部演示可用，不关闭正式MVP门槛。

## 依赖与进入条件

依赖：[V03-069](issue-069-costing-browser-e2e.md)、[V03-071](issue-071-real-customer-acceptance.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。
真实客户接口/许可/版本/配对gold或验收人缺失时真实路径不得标完成。机制可用合成资源单独验证；不得用替身关闭真实验收。

## 验收条件

- [ ] README按用户流程说明建行业、挂项目、导入/确认、补价、报价、看依据、导出/人工复核，给配置/迁移/启动和准确能力边界。
- [ ] 提交场景范围、accepted main SHA、scene commits、实际测试与真实验收结果、未覆盖项/依赖及可复用资产回流清单。
- [ ] 合格报价、客户/内部MVP验收与A通用完成分别满足；未具备真实客户验收只标内部演示可用，不关闭正式MVP门槛。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#10-验收映射与任务候选](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#10-验收映射与任务候选)
- [spec-electrical-costing-mvp-v0.3.md#12-当前代码参照与文档交付](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#12-当前代码参照与文档交付)

故事范围：P.US-019、P.US-022、P.US-023、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-024.AC-06 → P-T024-06：CI 可重复执行并清理自建数据和资源；受控模型／合成函数验证与真实模型／客户样本验收分别报告。

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
