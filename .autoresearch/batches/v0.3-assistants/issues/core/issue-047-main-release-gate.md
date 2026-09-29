# V03-047：完成通用独立审查、README 与 main 基线交付

阶段 A · infra · P0 · 状态 planned · GitHub [#218](https://github.com/Yijtu/ontology/issues/218)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 适用lint/typecheck/单元/集成/真实浏览器/边界与两个替换套件通过，独立审查问题闭环；模型质量未验证明确标记。
- README讲清两个助手实际用法、支持/受限/缺配置、迁移与示例；文档和manifest以验收证据更新，不用代码存在当完成。
- 通用变更通过PR合入main，保存release record包含实际main SHA/迁移/contracts/runtime/capabilities/test证据，未混入造价/客户实现。
- 记录已审查并合入的main SHA、完整回归结果、迁移/配置与未覆盖项，供所有场景同步；未到main即不满足B进入条件。

## 依赖与进入条件

Dependencies: #217, #210

依赖：[V03-045](issue-045-generic-browser-e2e.md)、[V03-046](issue-046-model-quality-evidence.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 适用lint/typecheck/单元/集成/真实浏览器/边界与两个替换套件通过，独立审查问题闭环；模型质量未验证明确标记。
- [ ] README讲清两个助手实际用法、支持/受限/缺配置、迁移与示例；文档和manifest以验收证据更新，不用代码存在当完成。
- [ ] 通用变更通过PR合入main，保存release record包含实际main SHA/迁移/contracts/runtime/capabilities/test证据，未混入造价/客户实现。
- [ ] 记录已审查并合入的main SHA、完整回归结果、迁移/配置与未覆盖项，供所有场景同步；未到main即不满足B进入条件。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-generic-assistants-core-v0.3.md#8-任务阶段门槛与合入-main](../../../../../tasks/spec-generic-assistants-core-v0.3.md#8-任务阶段门槛与合入-main)

故事范围：A.US-016。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-016.AC-06 → A-T016-06：适用 lint、typecheck、单元／集成／E2E 与边界检查通过并独立审查；同步 README、SPEC、迁移说明和完成清单，合入 main 后记录明确提交 SHA。
- P.US-024.AC-01 → P-T024-01：A 先通过[通用 PRD](../../../../../tasks/prd-generic-assistants-core-v0.3.md)的独立 E2E，记录验收后的 main 提交；B 同步该版本并保留通用回归。

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

- 当前：未开工；验证未运行。GitHub Issue：[#218](https://github.com/Yijtu/ontology/issues/218)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
