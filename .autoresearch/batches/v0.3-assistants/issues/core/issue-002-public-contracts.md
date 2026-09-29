# V03-002：扩展公共 Schema、版本引用与挂载契约

阶段 A · backend · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #2，本批尚未开始实现。

## 目标与范围

- 新增工作区、项目修订、task binding、不可变输入和能力状态 DTO/Schema，字段、版本、长度与 unknown 校验对齐分册。
- 保留可信 scope、现有四工具和运行入口；新字段 additive，旧 facts、answer@1/@2 与旧 payload 仍可解析。
- contracts 不引入 React、SQL、HTTP 或领域实现；生成类型与 Schema 一致并通过兼容反例。
- PublishedTaskBindingBody、ProjectRevisionBody、answer@3 body与读取envelope分离；自身ref/digest及verification receipts不计回内容，避免hash自循环。

## 依赖与进入条件

依赖：[V03-001](issue-001-baseline-wip-audit.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 新增工作区、项目修订、task binding、不可变输入和能力状态 DTO/Schema，字段、版本、长度与 unknown 校验对齐分册。
- [ ] 保留可信 scope、现有四工具和运行入口；新字段 additive，旧 facts、answer@1/@2 与旧 payload 仍可解析。
- [ ] contracts 不引入 React、SQL、HTTP 或领域实现；生成类型与 Schema 一致并通过兼容反例。
- [ ] PublishedTaskBindingBody、ProjectRevisionBody、answer@3 body与读取envelope分离；自身ref/digest及verification receipts不计回内容，避免hash自循环。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-generic-assistants-core-v0.3.md#4-api动作与前端契约](../../../../../tasks/spec-generic-assistants-core-v0.3.md#4-api动作与前端契约)

故事范围：A.US-001、A.US-003、A.US-005、A.US-006、A.US-010、A.US-015。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-015.AC-04 → A-T015-04：合成计算函数及场景 UI 来自扩展装配；无客户端代码或真实价格进入通用包，适用架构边界测试通过。

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
