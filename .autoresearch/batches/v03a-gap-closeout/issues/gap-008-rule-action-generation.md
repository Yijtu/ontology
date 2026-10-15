# GAP-008 · 平台生成带来源的规则与动作候选

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/assets/rule-action-candidates/`
- `platform/packages/contracts/src/rule-action-candidates.ts（生成请求与输出）`
- `platform/apps/api/src/http/rule-action-candidates.ts`
- `platform/tests/unit/rule-action-candidates.spec.ts`
- `platform/tests/integration/rule-action-candidates-postgres.spec.ts`

## Acceptance

- [ ] 新增平台自有生成入口，调用模型端口并使用 #1 原文和已批准/选定的定义术语；rawOutput 摄入继续作为显式导入入口，不能冒充模型生成。
- [ ] 规则条件、例外、关系声明和依赖保留原意及逐条件来源；无匹配 span、不可执行形式或截断输出显式保留问题，禁止删条件以求通过。
- [ ] 动作只引用已登记 operation/schema/真实摘要，不允许模型生成处理器；候选生成和编辑均不能直接启用或发布。
- [ ] 幂等、版本冲突、取消、共同预算和模型未配置行为与 TBox 一致；受控模型的生成→审核/启用→验核→发布测试覆盖正反例，真实模型质量单独记未验证。

## Dependencies

GAP-001, GAP-002, GAP-007

## Scope boundary

support/compile 逻辑由 #3/#12 拥有；只消费公开端口。

## Evidence at 43525be

- `packages/application/src/assets/rule-action-candidates/service.ts:209`
- `packages/application/src/assets/rule-action-candidates/service.ts:296`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #258

Dependencies: #251 (GAP-001), #252 (GAP-002), #257 (GAP-007)
