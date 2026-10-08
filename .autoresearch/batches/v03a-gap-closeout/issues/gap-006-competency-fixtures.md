# GAP-006 · 定义能力问题与独立合成金标

Batch: v03a-gap-closeout
Target: main
Priority: P1
Type: backend

## Scope

- `platform/packages/contracts/src/competency-questions.ts（新增）`
- `platform/schema/competency-questions.schema.json（新增）`
- `platform/tests/fixtures/competency-questions/（新增）`
- `tasks/spec-v0.3a/competency-questions.md（新增）`

## Acceptance

- [ ] CQ 作为版本化声明包含 question、task kind、definition/规则引用、合成输入、预期值/四态/单位、必要来源定位与允许能力范围；不放客户原文、物理 SQL、脚本或秘密。
- [ ] 至少 12 个独立人工推导金标，覆盖属性查询、数量合计、一跳目标条件、三层规则、例外、unknown/conflict、撤回、跨项目拒绝与版本变更；不从被测算法反算预期。
- [ ] 使用至少两个合成行业配置，区分样例与行业标准；保留真实人工报价金标接口和缺资源标记，真实验收缺失不能记作通过。
- [ ] 运行时 schema 与生成契约校验通过，声明不等于执行结果；#7 可把已批准 CQ 加入生成上下文，#16 实现真实 runner 与发布门。

## Dependencies

None

## Scope boundary

本节点不编辑 pack-assembly/validation-service，避免与 #2 冲突。

## Evidence at 43525be

- `packages/application/src/assets/publication/pack-assembly.ts:343`
- `tasks/spec-v0.3a/execution-evidence.md:474`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #256

Dependencies: None
