# V03-069：完成造价双助手正常入口的合成整栈浏览器 E2E

阶段 B · infra · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #69，本批尚未开始实现。

## 目标与范围

- 从原始synthetic资料经候选/编辑/发布/挂载，导入项目清单确认参数、普通报价请求、registered compute核验、专业表/证据/导出/反馈完整跑通。
- 真实UI/API/Worker/Controller/控制与业务持久层，禁止预置最终包/答案或手动启动Controller；覆盖1001行后页、缺价修复和修订。
- 缺价/篡改/错行/错money/required policy fail/撤回/跨客户/取消负例不会正式发布；构建Web后实际Vitest+chromium执行，资源清理可重复。

## 依赖与进入条件

依赖：[V03-052](issue-052-industry-package.md)、[V03-053](issue-053-price-snapshots.md)、[V03-054](issue-054-customer-quotation-adapter.md)、[V03-055](issue-055-quote-input-snapshots.md)、[V03-056](issue-056-specification-confirmation.md)、[V03-057](issue-057-pricing-context.md)、[V03-058](issue-058-quote-task-operation.md)、[V03-059](issue-059-quote-policy-evidence.md)、[V03-060](issue-060-costing-input-ui.md)、[V03-061](issue-061-pricing-ui.md)、[V03-062](issue-062-quotation-workbench.md)、[V03-063](issue-063-quotation-provenance-ui.md)、[V03-064](issue-064-quotation-export.md)、[V03-065](issue-065-comparison-review-service.md)、[V03-066](issue-066-comparison-review-ui.md)、[V03-067](issue-067-requote-lifecycle.md)、[V03-068](issue-068-client-mapping-conformance.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 从原始synthetic资料经候选/编辑/发布/挂载，导入项目清单确认参数、普通报价请求、registered compute核验、专业表/证据/导出/反馈完整跑通。
- [ ] 真实UI/API/Worker/Controller/控制与业务持久层，禁止预置最终包/答案或手动启动Controller；覆盖1001行后页、缺价修复和修订。
- [ ] 缺价/篡改/错行/错money/required policy fail/撤回/跨客户/取消负例不会正式发布；构建Web后实际Vitest+chromium执行，资源清理可重复。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#102-实际测试入口与交付证据](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#102-实际测试入口与交付证据)

故事范围：P.US-001、P.US-004、P.US-006、P.US-008、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-001.AC-04 → P-T001-04：在浏览器核验入口、空态、切换、刷新和权限状态。
- P.US-002.AC-04 → P-T002-04：在浏览器核验创建、编辑和恢复。
- P.US-003.AC-04 → P-T003-04：在浏览器核验正常导入、失败、部分成功和原文对照。
- P.US-004.AC-04 → P-T004-04：在浏览器核验候选列表、来源、冲突和生成前后的草稿差异。
- P.US-006.AC-04 → P-T006-04：在浏览器核验规则原文、例外、缺信息和不支持状态。
- P.US-008.AC-04 → P-T008-04：在浏览器核验来源对照、字段错误、关系端点和待处理项。
- P.US-009.AC-02 → P-T009-02：样例可覆盖缺参数、同名异物、冲突、错单位与缺能力，工作台显示规则匹配和已注册动作试算；B 补缺价等报价反例。
- P.US-009.AC-04 → P-T009-04：在浏览器核验生成、验证和隔离。
- P.US-010.AC-04 → P-T010-04：在浏览器核验绑定、冲突、拒绝及发布后的可读状态。
- P.US-011.AC-04 → P-T011-04：在浏览器核验发布阻断、版本查看、导出与挂载入口。
- P.US-012.AC-04 → P-T012-04：在浏览器核验建项目、挂载、未就绪和版本切换。
- P.US-013.AC-05 → P-T013-05：在浏览器核验上传、分页、重复导入、失败行和项目隔离。
- P.US-014.AC-04 → P-T014-04：在浏览器核验逐字段修改、批量确认、来源定位与阻断。
- P.US-015.AC-04 → P-T015-04：在浏览器核验普通提问、缺项澄清、修改确认与范围外问题。
- P.US-016.AC-05 → P-T016-05：在浏览器核验选择、确认、缺价、过期和口径冲突。
- P.US-019.AC-04 → P-T019-04：在浏览器核验长清单、合计、部分失败和刷新回读。
- P.US-020.AC-04 → P-T020-04：在浏览器核验数字定位、原文对照、缺证据和跨范围拒绝。
- P.US-021.AC-04 → P-T021-04：在浏览器核验修改、取消、重试、历史与恢复。
- P.US-022.AC-04 → P-T022-04：在浏览器核验导出、差异、退回与签核。
- P.US-024.AC-02 → P-T024-02：自动浏览器测试从原始合成资料生成定义／规则／动作候选，人工编辑确认后发布包并挂载项目。
- P.US-024.AC-03 → P-T024-03：在同一测试中导入清单、完成身份和参数确认、提出报价要求、调用注册函数、核验发布、展开来源并导出。
- P.US-024.AC-04 → P-T024-04：覆盖缺价阻断与补齐后报价、金额／行绑定篡改被拒绝、输入修订后的新旧报价回读及跨客户访问拒绝。
- P.US-024.AC-05 → P-T024-05：使用真实 UI／API／持久层和正常任务分派；不预置候选、已发布结论或最终答案，不手动启动 Controller。
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
