# V03-044：验证两 runtime 与本地/真实 MCP 替换

阶段 A · infra · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #44，本批尚未开始实现。

## 目标与范围

- Template/Pi共同支持任务经实际adapter/gateway达到同语义结果与证据/核验，checkpoint不兼容显式拒绝。
- 本地与真实stdio MCP复用同领域服务与授权，不mock RPC冒充跨进程；配置允许的组件绑定严格固定。
- 预算、cancel、malformed envelope、unavailable capability和late-result反例通过，child进程和自建资源清理。

## 依赖与进入条件

依赖：[V03-037](issue-037-template-host.md)、[V03-038](issue-038-pi-host-loop.md)、[V03-039](issue-039-run-lifecycle.md)、[V03-031](issue-031-compute-execution.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] Template/Pi共同支持任务经实际adapter/gateway达到同语义结果与证据/核验，checkpoint不兼容显式拒绝。
- [ ] 本地与真实stdio MCP复用同领域服务与授权，不mock RPC冒充跨进程；配置允许的组件绑定严格固定。
- [ ] 预算、cancel、malformed envelope、unavailable capability和late-result反例通过，child进程和自建资源清理。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-generic-assistants-core-v0.3.md#7-验收矩阵](../../../../../tasks/spec-generic-assistants-core-v0.3.md#7-验收矩阵)

故事范围：A.US-015、A.US-013。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-015.AC-02 → A-T015-02：复用并接通 Template／Pi 两 runtime、DuckDB／PostgreSQL 两业务查询后端、本地／真实 stdio MCP；在共同支持任务上结果／核验契约一致。
- A.US-015.AC-03 → A-T015-03：控制库 PostgreSQL 不算第二个业务查询后端；checkpoint 与不支持快照能力显式拒绝，不承诺任意 SDK 状态迁移。
- A.US-015.AC-04 → A-T015-04：合成计算函数及场景 UI 来自扩展装配；无客户端代码或真实价格进入通用包，适用架构边界测试通过。
- P.US-023.AC-03 → P-T023-03：动作、数据后端与运行时由明确契约装配；不兼容组合拒绝并说明原因。

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
