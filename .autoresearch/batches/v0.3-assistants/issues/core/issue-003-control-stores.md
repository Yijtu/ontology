# V03-003：新增工作区与项目修订的持久端口和追加迁移

阶段 A · backend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #3，本批尚未开始实现。

## 目标与范围

- 实现分册指定的 scoped repository、主外键、唯一索引、revision CAS 与 append-only 发布/确认记录。
- 控制事务与 outbox 同步提交；相同 idempotency key/payload 读回，冲突 payload 拒绝；旧数据升级可读。
- 新增迁移按 V03-001 ledger 分配；失败回滚/禁用不删历史，真实 PostgreSQL 验证隔离、并发和重启。

## 依赖与进入条件

依赖：[V03-002](issue-002-public-contracts.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 实现分册指定的 scoped repository、主外键、唯一索引、revision CAS 与 append-only 发布/确认记录。
- [ ] 控制事务与 outbox 同步提交；相同 idempotency key/payload 读回，冲突 payload 拒绝；旧数据升级可读。
- [ ] 新增迁移按 V03-001 ledger 分配；失败回滚/禁用不删历史，真实 PostgreSQL 验证隔离、并发和重启。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [asset-data-ui.md](../../../../../tasks/spec-v0.3a/asset-data-ui.md)

故事范围：A.US-003、A.US-004、A.US-005、A.US-006、A.US-014。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-002.AC-02 → P-T002-02：保存后有稳定工作区标识和草稿修订，刷新可恢复。

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
