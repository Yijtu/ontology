# GAP-003 · 让已发布规则执行一跳关系前提与目标条件

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/semantic-engine/src/rules/`
- `platform/packages/semantic-engine/src/validation/synthetic-evaluator.ts`
- `platform/packages/semantic-engine/src/materialization/published-source.ts（关系输入）`
- `platform/packages/contracts/src/rule-action-candidates.ts（必要关系输入扩展）`
- `platform/tests/unit/rule-relation-premise.spec.ts`
- `platform/tests/integration/rule-evaluator-postgres.spec.ts`

## Acceptance

- [ ] 从固定 definition 中读取 relationPremises 声明，统一 support、合成评估、发布编译与运行求值；一条正向一跳关系条件走真实已发布关系，不用字段伪装 relation。
- [ ] 对已解析端点的目标属性 targetCondition 实际求值，支持该批有限 compare/range/all/any 子集；真、显式反驳、缺观测 unknown、冲突保持独立。
- [ ] 声明、目标事实、边事实均限定项目/definition/validAt/recorded point；关系缺失在无完备证明时保持 unknown，撤回边或目标支撑会更新结果与来源。
- [ ] 仍拒绝递归、多跳、负关系与多关系前提；真实 PostgreSQL 导入→审核→发布→编译→求值验收，覆盖跨项目同名实体、端点未解析与 targetCondition 未满足。

## Dependencies

None

## Scope boundary

#12 在本节点合入后修改同一编译器；不引入通用 Datalog 引擎。

## Evidence at 43525be

- `packages/semantic-engine/src/rules/compile.ts:451`
- `packages/semantic-engine/src/rules/support.ts:291`
- `packages/semantic-engine/src/validation/synthetic-evaluator.ts:109`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #253

Dependencies: None
