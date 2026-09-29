# V03-067：完成重报价、版本差异、取消与 unknown 恢复闭环

阶段 B · fullstack · P1 · 状态 planned · GitHub [#236](https://github.com/Yijtu/ontology/issues/236)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 修改已确认规格/数量/价源/口径生成新项目snapshot/run/quote；新旧输入结果并列回读，业务签核不自动沿用。
- lost response按原幂等key恢复，取消共享signal与ledger；外部execution_unknown先查询原调用，无查询能力保持待人工确认。
- 被取消run的迟到输出不发布，重启读回原工件/digests；展示实际可同版本复算或仅原响应归档的限制。

## 依赖与进入条件

Dependencies: #228, #231, #232

依赖：[V03-058](issue-058-quote-task-operation.md)、[V03-062](issue-062-quotation-workbench.md)、[V03-065](issue-065-comparison-review-service.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 修改已确认规格/数量/价源/口径生成新项目snapshot/run/quote；新旧输入结果并列回读，业务签核不自动沿用。
- [ ] lost response按原幂等key恢复，取消共享signal与ledger；外部execution_unknown先查询原调用，无查询能力保持待人工确认。
- [ ] 被取消run的迟到输出不发布，重启读回原工件/digests；展示实际可同版本复算或仅原响应归档的限制。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#51-可替换客户报价端口](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#51-可替换客户报价端口)
- [spec-electrical-costing-mvp-v0.3.md#9-错误恢复与资源限制](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#9-错误恢复与资源限制)

故事范围：P.US-015、P.US-017、P.US-021、P.US-022、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-015.AC-03 → P-T015-03：“更换规格／税费口径后重新报价”等请求先呈现具体参数变更供确认。
- P.US-021.AC-01 → P-T021-01：变更输入、价格或行业版本产生新修订；重算前展示变化，旧报价保留原快照和证据。
- P.US-021.AC-02 → P-T021-02：执行中有阶段进度和取消入口；重试沿用同一逻辑动作标识，不能重复生成计价动作。
- P.US-021.AC-03 → P-T021-03：刷新／进程重启可读回持久结果；历史回读与固定版本复算分别标注能力。
- P.US-021.AC-04 → P-T021-04：在浏览器核验修改、取消、重试、历史与恢复。
- P.FR-23 → P-F23：系统必须在执行参数变更前呈现待确认修改。
- P.FR-30 → P-F30：系统必须按修订保留旧报价和其原始证据。
- P.FR-31 → P-F31：系统必须支持有界任务取消与幂等重试。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- pnpm run build:web 后执行 pnpm run test:e2e；按 vitest.e2e.config.ts 编写 tests/e2e/**/*.e2e.ts，真实 chromium 验证。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#236](https://github.com/Yijtu/ontology/issues/236)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
