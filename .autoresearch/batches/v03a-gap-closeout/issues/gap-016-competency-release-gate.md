# GAP-016 · 用真实能力问题检验发布包

Batch: v03a-gap-closeout
Target: main
Priority: P1
Type: backend

## Scope

- `platform/packages/application/src/synthetic/competency-runner.ts（新增）`
- `platform/packages/application/src/synthetic/validation-service.ts（CQ 扩展）`
- `platform/packages/application/src/assets/publication/pack-assembly.ts（testSuite）`
- `platform/packages/contracts/src/pack-assets.ts`
- `platform/tests/integration/synthetic-validation-postgres.spec.ts`

## Acceptance

- [ ] 将 #6 的真实 question 和引用打包为可复用测试套件，替换 validation case ${caseId} 占位文本；CQ 不含客户原文。
- [ ] runner 在隔离 synthetic project 经真实发布/事实/查询/规则/compute 管线执行，比较独立金标、单位/四态和来源覆盖；不把仅 schema 检查当能力验收。
- [ ] 发布报告固定 CQ/定义/规则/样本摘要，必选 CQ 失败阻断部署就绪；不支持的问题明确 not_yet_executable，不偷偷跳过或降级成通过。
- [ ] 至少两种合成行业与 12 个金标；真实人工报价与真实模型质量分别保持外部未验证，具备资源后才新增相应验收结果。

## Dependencies

GAP-004, GAP-006, GAP-008, GAP-011, GAP-012, GAP-014

## Scope boundary

本节点与 #2 共用发布/验证逻辑，依赖路径已确保串行。

## Evidence at 43525be

- `packages/application/src/assets/publication/pack-assembly.ts:343`
- `packages/application/src/synthetic/validation-service.ts:328`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #266

Dependencies: #254 (GAP-004), #256 (GAP-006), #258 (GAP-008), #261 (GAP-011), #262 (GAP-012), #264 (GAP-014)
