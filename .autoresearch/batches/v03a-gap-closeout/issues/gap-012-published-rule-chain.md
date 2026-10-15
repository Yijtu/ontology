# GAP-012 · 让已发布规则按真实依赖串联

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/semantic-engine/src/rules/compile.ts`
- `platform/packages/semantic-engine/src/rules/evaluate.ts`
- `platform/packages/semantic-engine/src/materialization/（依赖索引与增量失效）`
- `platform/packages/contracts/src/rule-action-candidates.ts（依赖明确引用）`
- `platform/tests/integration/rule-dependency-materialization-postgres.spec.ts`

## Acceptance

- [ ] 基于已发布 ruleDependencies 与固定 ruleRef 编译 propositionKey 前提，用 subject/object/definition 限定上游结论；不把对象类型 label 误当同一实体命题。
- [ ] 三层规则由真实候选→审核/启用→发布→编译→拓扑求值产生，禁止手工构造 RuleDefinition 替代这一验收；多个独立支撑分别保留。
- [ ] 上游 unknown/conflict、例外及支撑撤回正确传播；撤一个替代支撑不删除仍被其它支撑支持的结论，历史 recorded point 可读。
- [ ] 循环明确 CYCLE_DETECTED，仍采用有限无环子集；覆盖跨实体/项目误串联、版本替换、依赖失效、深度上限与来源图。

## Dependencies

GAP-003

## Scope boundary

与 #3 共用编译/求值逻辑，强制在 #3 合入之后实施。

## Evidence at 43525be

- `packages/semantic-engine/src/rules/compile.ts:350`
- `packages/semantic-engine/src/rules/evaluate.ts:320`
- `tests/unit/rule-dependency-chain.spec.ts:71`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #262

Dependencies: #253 (GAP-003)
