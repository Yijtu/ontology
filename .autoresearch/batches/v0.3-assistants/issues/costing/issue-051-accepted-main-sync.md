# V03-051：同步已验收 main 并完成造价分支兼容门槛

阶段 B · infra · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #51，本批尚未开始实现。

## 目标与范围

- 读取A release record并固定已验收main SHA，核对实际branch/worktree和WIP归属，保留既有修改；不能以目录名称或A未完成研发HEAD代替。
- 将accepted main同步到现有feat/electrical-costing-poc，执行受影响的contracts/boundaries/公共UI与正常任务回归，保存基线和迁移/配置receipt。
- 发现通用缺口先独立修复并合入main再同步；未通过本门槛，所有B专属代码卡都不得ready。

## 依赖与进入条件

依赖：[V03-047](../core/issue-047-main-release-gate.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 读取A release record并固定已验收main SHA，核对实际branch/worktree和WIP归属，保留既有修改；不能以目录名称或A未完成研发HEAD代替。
- [ ] 将accepted main同步到现有feat/electrical-costing-poc，执行受影响的contracts/boundaries/公共UI与正常任务回归，保存基线和迁移/配置receipt。
- [ ] 发现通用缺口先独立修复并合入main再同步；未通过本门槛，所有B专属代码卡都不得ready。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-generic-assistants-core-v0.3.md#8-任务阶段门槛与合入-main](../../../../../tasks/spec-generic-assistants-core-v0.3.md#8-任务阶段门槛与合入-main)
- [spec-electrical-costing-mvp-v0.3.md#12-ab-是实施门槛](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#12-ab-是实施门槛)

故事范围：P.US-023、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-024.AC-01 → P-T024-01：A 先通过[通用 PRD](../../../../../tasks/prd-generic-assistants-core-v0.3.md)的独立 E2E，记录验收后的 main 提交；B 同步该版本并保留通用回归。

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
