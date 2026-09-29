# V03-041：完成结果修订历史与已核验 JSON 导出

阶段 A · fullstack · P1 · 状态 planned · GitHub [#214](https://github.com/Yijtu/ontology/issues/214)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 从正常UI/API读回旧修订的body/table/evidence hashes，旧结果不被新输入/mapping/规则/撤回改写。
- 通用JSON导出只读取同一已核验工件，完整性/限制/versions/provenance索引和当前读取权限一致。
- restart/lost response/version mismatch、legacybody、过期依赖与历史复算不可用在浏览器/API验证。

## 依赖与进入条件

Dependencies: #203, #206, #211, #212

依赖：[V03-032](issue-032-answer-v3-artifacts.md)、[V03-035](issue-035-publication-validity.md)、[V03-039](issue-039-run-lifecycle.md)、[V03-040](issue-040-business-results-ui.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 从正常UI/API读回旧修订的body/table/evidence hashes，旧结果不被新输入/mapping/规则/撤回改写。
- [ ] 通用JSON导出只读取同一已核验工件，完整性/限制/versions/provenance索引和当前读取权限一致。
- [ ] restart/lost response/version mismatch、legacybody、过期依赖与历史复算不可用在浏览器/API验证。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [asset-data-ui.md](../../../../../tasks/spec-v0.3a/asset-data-ui.md)
- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-014。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-009.AC-04 → A-T009-04：在浏览器核验支持撤回、替代依据、原文引用、缺证据与越权拒绝。
- A.US-010.AC-04 → A-T010-04：在浏览器及 API 核验结果、未就绪、重复提交及工件回读；示例不冒称客户报价。
- A.US-014.AC-01 → A-T014-01：输入、定义、mapping、函数与资料变更产生新修订，旧结果保存当时快照／证据；历史回读与固定版本复算分别标注。
- A.US-014.AC-02 → A-T014-02：发布响应丢失可由同一逻辑键读回；重启后正文与证据不变，支持的检查点恢复沿用原 ledger，不支持的组合明确提示。
- A.US-014.AC-03 → A-T014-03：结果可导出结构化 JSON，包含状态、版本和来源索引，权限与已核验页面一致；专业 XLSX 模板由 B 挂载。
- A.US-014.AC-04 → A-T014-04：在浏览器核验差异、失败重试、重启、历史、导出与错误状态。
- A.FR-21 → A-F21：系统必须保留历史结果的原快照与证据。
- A.FR-22 → A-F22：系统必须提供与已核验版本一致的 JSON 导出。
- P.US-021.AC-01 → P-T021-01：变更输入、价格或行业版本产生新修订；重算前展示变化，旧报价保留原快照和证据。
- P.US-021.AC-03 → P-T021-03：刷新／进程重启可读回持久结果；历史回读与固定版本复算分别标注能力。
- P.US-022.AC-01 → P-T022-01：可导出 XLSX 和结构化 JSON，包含明细、范围、版本、状态及溯源索引；导出与已核验页面一致。
- P.FR-30 → P-F30：系统必须按修订保留旧报价和其原始证据。
- P.FR-32 → P-F32：系统必须导出与已核验版本一致的报价。

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

- 当前：未开工；验证未运行。GitHub Issue：[#214](https://github.com/Yijtu/ontology/issues/214)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
