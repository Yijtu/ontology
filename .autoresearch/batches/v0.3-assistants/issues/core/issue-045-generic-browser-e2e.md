# V03-045：实现通用双助手整栈浏览器 E2E 与关键反例

阶段 A · infra · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #45，本批尚未开始实现。

## 目标与范围

- 自动浏览器从原始资料生成/修改本体与规则/动作、发布包、建项目、导入/身份/字段确认、NL任务到最终核验结果。
- 属性/规则原文/文档问答/注册计算及第二行业通过真实UI/HTTP/Worker/持久层；不seed候选/派生结论/答案。
- 至少1001行、后页证据、错值/假引用/缺能力/cancel/重启/撤回/跨项目关键反例通过，CI重复且只清自建资源。

## 依赖与进入条件

依赖：[V03-001](issue-001-baseline-wip-audit.md)、[V03-002](issue-002-public-contracts.md)、[V03-003](issue-003-control-stores.md)、[V03-004](issue-004-workspace-api.md)、[V03-005](issue-005-structured-parser.md)、[V03-006](issue-006-ingestion-coverage.md)、[V03-007](issue-007-schema-extraction.md)、[V03-008](issue-008-tbox-candidates.md)、[V03-009](issue-009-definition-edit-validation.md)、[V03-010](issue-010-rule-action-candidates.md)、[V03-011](issue-011-workspace-source-ui.md)、[V03-012](issue-012-definition-editor-ui.md)、[V03-013](issue-013-instance-review-ui.md)、[V03-014](issue-014-synthetic-validation.md)、[V03-015](issue-015-dynamic-pack-publish.md)、[V03-016](issue-016-project-bindings.md)、[V03-017](issue-017-project-mapping.md)、[V03-018](issue-018-query-projection.md)、[V03-019](issue-019-document-index.md)、[V03-020](issue-020-project-data-ui.md)、[V03-021](issue-021-package-publish-ui.md)、[V03-022](issue-022-frontend-mount.md)、[V03-023](issue-023-task-input-artifacts.md)、[V03-024](issue-024-nl-plan-receipts.md)、[V03-025](issue-025-semantic-sql-query.md)、[V03-026](issue-026-finite-rule-boolean.md)、[V03-027](issue-027-relation-navigation.md)、[V03-028](issue-028-incremental-rule-state.md)、[V03-029](issue-029-rule-source-provenance.md)、[V03-031](issue-031-compute-execution.md)、[V03-032](issue-032-answer-v3-artifacts.md)、[V03-033](issue-033-quantity-table-verifier.md)、[V03-034](issue-034-typed-evidence-verifier.md)、[V03-035](issue-035-publication-validity.md)、[V03-036](issue-036-typed-draft-writer.md)、[V03-037](issue-037-template-host.md)、[V03-038](issue-038-pi-host-loop.md)、[V03-039](issue-039-run-lifecycle.md)、[V03-040](issue-040-business-results-ui.md)、[V03-041](issue-041-history-json-export.md)、[V03-042](issue-042-public-ui-states.md)、[V03-043](issue-043-industry-backend-conformance.md)、[V03-044](issue-044-runtime-transport-conformance.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 自动浏览器从原始资料生成/修改本体与规则/动作、发布包、建项目、导入/身份/字段确认、NL任务到最终核验结果。
- [ ] 属性/规则原文/文档问答/注册计算及第二行业通过真实UI/HTTP/Worker/持久层；不seed候选/派生结论/答案。
- [ ] 至少1001行、后页证据、错值/假引用/缺能力/cancel/重启/撤回/跨项目关键反例通过，CI重复且只清自建资源。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-generic-assistants-core-v0.3.md#7-验收矩阵](../../../../../tasks/spec-generic-assistants-core-v0.3.md#7-验收矩阵)

故事范围：A.US-016。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-001.AC-04 → A-T001-04：在浏览器核验真实可操作的两工作区、空态、错误态和挂载视图。
- A.US-002.AC-04 → A-T002-04：在浏览器核验分页、失败行、重复文件、修订与来源对照。
- A.US-003.AC-04 → A-T003-04：在浏览器核验完整候选生成、修改、冲突、拒绝和动作未绑定流程。
- A.US-004.AC-04 → A-T004-04：在浏览器核验提参、字段修改、同名异物、拒绝、关系端点及发布回读。
- A.US-005.AC-02 → A-T005-02：合成实例隔离标记，用于规则／动作验证；不会成为真实事实或自动获业务批准。
- A.US-005.AC-04 → A-T005-04：在浏览器核验验证反例、发布阻断、版本查看、导出及新项目挂载。
- A.US-006.AC-04 → A-T006-04：在浏览器及 API 核验新导入数据、映射变更、失败恢复和跨项目读取拒绝。
- A.US-007.AC-04 → A-T007-04：在浏览器核验普通问题、澄清、变更确认、执行结果和不可用任务。
- A.US-008.AC-04 → A-T008-04：在浏览器及 API 核验规则正文、关系端点、OR 替代支撑、未知和超界状态。
- A.US-009.AC-04 → A-T009-04：在浏览器核验支持撤回、替代依据、原文引用、缺证据与越权拒绝。
- A.US-010.AC-04 → A-T010-04：在浏览器及 API 核验结果、未就绪、重复提交及工件回读；示例不冒称客户报价。
- A.US-011.AC-04 → A-T011-04：在浏览器核验表、正文、依据、失败原因及持久化后同版本回读；生成解释不另添事实。
- A.US-012.AC-04 → A-T012-04：在浏览器及 API 核验新增资料可检索、旧修订、撤回、空结果、伪造引用和跨范围拒绝。
- A.US-013.AC-04 → A-T013-04：在浏览器及 API 核验进度、取消、无进展、预算耗尽、澄清续跑和迟到结果不发布。
- A.US-014.AC-04 → A-T014-04：在浏览器核验差异、失败重试、重启、历史、导出与错误状态。
- A.US-016.AC-01 → A-T016-01：自动浏览器测试从原始合成资料生成定义／规则／动作，人工编辑审核后发布行业包，新建项目、挂载、导入实例并确认身份与字段。
- A.US-016.AC-02 → A-T016-02：普通提问分别完成属性查询、规则结论与原文解释、文档问答及注册示例计算，查看已核验正文／表格、来源、JSON 导出和历史；第二行业重复最小流程。
- A.US-016.AC-03 → A-T016-03：覆盖缺值、错单位、不同条件 OR、关系前提、缺能力、假引用／错结果、撤回、跨范围、取消／重试、重启；至少 1001 行并验证后页证据与完整性。
- A.US-016.AC-04 → A-T016-04：使用实际 UI／HTTP／Worker／Controller／持久层，不预置候选、派生结论或答案；CI 可重复清理自建数据、容器与命名卷。
- P.US-001.AC-04 → P-T001-04：在浏览器核验入口、空态、切换、刷新和权限状态。
- P.US-002.AC-04 → P-T002-04：在浏览器核验创建、编辑和恢复。
- P.US-003.AC-04 → P-T003-04：在浏览器核验正常导入、失败、部分成功和原文对照。
- P.US-004.AC-04 → P-T004-04：在浏览器核验候选列表、来源、冲突和生成前后的草稿差异。
- P.US-005.AC-04 → P-T005-04：在浏览器核验编辑、拒绝、冲突和差异。
- P.US-006.AC-04 → P-T006-04：在浏览器核验规则原文、例外、缺信息和不支持状态。
- P.US-007.AC-04 → P-T007-04：在浏览器核验动作声明、可用性、未绑定和不兼容状态。
- P.US-008.AC-04 → P-T008-04：在浏览器核验来源对照、字段错误、关系端点和待处理项。
- P.US-009.AC-02 → P-T009-02：样例可覆盖缺参数、同名异物、冲突、错单位与缺能力，工作台显示规则匹配和已注册动作试算；B 补缺价等报价反例。
- P.US-009.AC-04 → P-T009-04：在浏览器核验生成、验证和隔离。
- P.US-010.AC-04 → P-T010-04：在浏览器核验绑定、冲突、拒绝及发布后的可读状态。
- P.US-011.AC-04 → P-T011-04：在浏览器核验发布阻断、版本查看、导出与挂载入口。

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
