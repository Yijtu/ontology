# V03-039：完善计划/循环的预算取消、澄清与检查点恢复

阶段 A · backend · P0 · 状态 planned · GitHub [#211](https://github.com/Yijtu/ontology/issues/211)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 工具、planner、generation、repair、verification、后台页核验均传播唯一ctx/ledger/deadline/signal，重试/澄清不重置。
- cancel late-result、source变更、restart、响应丢失和同请求键正确读回或明确不兼容，不创建新的隐藏动作。
- 进度事件与持久状态一致，有界 retry/no-progress/failure/policy映射可定位，固定输入历史保留。

## 依赖与进入条件

Dependencies: #208, #209, #206

依赖：[V03-037](issue-037-template-host.md)、[V03-038](issue-038-pi-host-loop.md)、[V03-035](issue-035-publication-validity.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 工具、planner、generation、repair、verification、后台页核验均传播唯一ctx/ledger/deadline/signal，重试/澄清不重置。
- [ ] cancel late-result、source变更、restart、响应丢失和同请求键正确读回或明确不兼容，不创建新的隐藏动作。
- [ ] 进度事件与持久状态一致，有界 retry/no-progress/failure/policy映射可定位，固定输入历史保留。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-013、A.US-014。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-013.AC-02 → A-T013-02：策略设定步数、时间、模型／工具预算及无进展停止；补查、澄清和草稿修复共用 ledger，不重置额度。
- A.US-013.AC-04 → A-T013-04：在浏览器及 API 核验进度、取消、无进展、预算耗尽、澄清续跑和迟到结果不发布。
- A.US-014.AC-02 → A-T014-02：发布响应丢失可由同一逻辑键读回；重启后正文与证据不变，支持的检查点恢复沿用原 ledger，不支持的组合明确提示。
- A.US-015.AC-03 → A-T015-03：控制库 PostgreSQL 不算第二个业务查询后端；checkpoint 与不支持快照能力显式拒绝，不承诺任意 SDK 状态迁移。
- A.FR-19 → A-F19：系统必须以共享预算限制计划与循环。
- A.FR-20 → A-F20：系统必须阻止取消后的迟到结果发布。
- P.US-021.AC-02 → P-T021-02：执行中有阶段进度和取消入口；重试沿用同一逻辑动作标识，不能重复生成计价动作。
- P.FR-31 → P-F31：系统必须支持有界任务取消与幂等重试。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#211](https://github.com/Yijtu/ontology/issues/211)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
