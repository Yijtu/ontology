# V03-009：实现定义编辑、术语消歧与兼容性校验

阶段 A · backend · P1 · 状态 planned · GitHub [#183](https://github.com/Yijtu/ontology/issues/183)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 支持编辑、拒绝、同义合并/异义保留及拆分建议，展示受影响的属性、端点、身份和规则。
- 重复标识、悬空端点、错单位与非法类型/基数阻断发布；记录修订差异和裁决理由。
- 破坏兼容的定义采用新版本与明确迁移策略；旧运行、实例和历史不静默改写。
- 通过ReviewableCandidateReader复用现有review tables/routes审核TBox；编辑生成新candidate revision，原approve不沿用，不新建另一份决定表。

## 依赖与进入条件

Dependencies: #181

依赖：[V03-008](issue-008-tbox-candidates.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [x] 支持编辑、拒绝、同义合并/异义保留及拆分建议，展示受影响的属性、端点、身份和规则。
- [x] 重复标识、悬空端点、错单位与非法类型/基数阻断发布；记录修订差异和裁决理由。
- [x] 破坏兼容的定义采用新版本与明确迁移策略；旧运行、实例和历史不静默改写。
- [x] 通过ReviewableCandidateReader复用现有review tables/routes审核TBox；编辑生成新candidate revision，原approve不沿用，不新建另一份决定表。
- [x] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [asset-data-ui.md](../../../../../tasks/spec-v0.3a/asset-data-ui.md)

故事范围：A.US-003、A.US-005。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-003.AC-02 → A-T003-02：可编辑、拒绝、合并术语、修订端点／单位，展示版本差异；不支持的规则保存为不可执行。
- P.US-004.AC-03 → P-T004-03：生成失败可重试，已有人工修改不会被静默覆盖；缺来源的建议标记待确认。
- P.US-005.AC-01 → P-T005-01：可编辑类型、属性类型／单位、关系端点及术语；合并和拆分展示受影响定义。
- P.US-005.AC-02 → P-T005-02：同名不同含义保持独立；标识冲突、悬空关系端点与错误单位阻断发布。
- P.US-005.AC-03 → P-T005-03：与已发布版本的差异可查看；破坏兼容性的修改需要明确修订策略。
- P.FR-6 → P-F06：系统必须允许专家编辑、拒绝、合并或拆分定义候选。
- P.FR-7 → P-F07：系统必须校验类型、属性、单位和关系端点的一致性。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：已在分支 `feat/v03-009-definition-edit` 实现，提交 `feat: definition editing, disambiguation and compatibility validation (#183)`。GitHub Issue：[#183](https://github.com/Yijtu/ontology/issues/183)。
- 实现：`packages/contracts`（`definition-editing.ts`、`candidate-review.ts`，新增 `ReviewableCandidateReader` 与编辑/裁决/兼容契约）；`packages/application/assets/definition-candidates`（`editing-service.ts`、`validation.ts`、`in-memory-editing-store.ts`、`reviewable-reader.ts`）；`packages/semantic-engine/publication`（复用现有 review 表/路由审核 TBox，发布端显式拒绝 definition 候选）；`apps/api/src/http/definition-editing.ts` + `app.ts`/`index.ts` 路由；迁移 `migrations/control/063_definition_edit_adjudications.sql`。
- 命令与结果（在 `platform/` 执行）：
  - `npx vitest run tests/unit/definition-candidate-editing.spec.ts`：14 passed。
  - `npx vitest run tests/integration/definition-editing-postgres.spec.ts`（真实 PostgreSQL，迁移 063 + RLS + 非执行约束）：6 passed。
  - `npx vitest run tests/unit`：116 files / 1336 passed；`tests/contracts`：12 files / 151 passed。
  - 回归：`definition-candidate-generation.spec.ts`、`asset-candidates-postgres.spec.ts`、`semantic-publications-postgres.spec.ts` 全通过。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run boundaries`：通过。
- 满足验收：编辑/拒绝/同义合并/异义保留/拆分及影响面展示；重复标识、悬空端点、错单位、非法基数类型阻断发布；与已发布版本差异及破坏性变更需显式修订策略；不支持规则保存为非执行；TBox 经 `ReviewableCandidateReader` 复用现有审核表/路由，编辑生成新 candidate revision，原 approve 不沿用，不新增决定表。
- 未验证/外部条件：生产装配（`core-local-composition`）尚未注入 `CompositeReviewableCandidateReader`，且裁决表 `asset_definition_adjudications` 暂无 PG 适配器（当前由 `InMemoryDefinitionEditingStore` 提供；迁移 063 已用真实 PG 校验 schema/RLS/约束）。作为后续工作记录，不在本卡虚报完成。

