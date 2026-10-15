# GAP-002 · 用审核账本收紧发布门并统一版本差异

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/assets/definition-candidates/validation.ts`
- `platform/packages/application/src/assets/definition-candidates/editing-service.ts（发布验核部分）`
- `platform/packages/application/src/assets/publication/`
- `platform/packages/application/src/synthetic/validation-service.ts`
- `platform/packages/contracts/src/definition-editing.ts`
- `platform/tests/unit/asset-publication.spec.ts`
- `platform/tests/integration/pack-publication-postgres.spec.ts`

## Acceptance

- [ ] 复用 semantic_candidate_reviews/candidate_review_heads 与 CompositeReviewableCandidateReader；定义候选必须存在当前 candidateId + contentDigest 对应的 approve 决策，失败/拒绝/待确认候选不得进入包；不新增第二套审批状态表。
- [ ] 规则/动作仅纳入可发布且已显式启用的最新修订；编辑、重生成或替换后旧批准失效。发布前重核固定审核/工作区修订，竞态不能把未批准内容带入包。
- [ ] 编辑与发布调用同一完整 diff：身份、引用目标、属性归属、类型、单位、端点、基数收窄、删除的判定一致；草稿展示仍保留未批准候选，不复用发布过滤隐藏它们。
- [ ] new_version/keep_independent/retire_previous 策略从验证输入贯穿报告与发布，策略与报告摘要绑定；无策略/错误策略拒绝，有策略且其余检查通过可发布，旧证据保持可读。

## Dependencies

None

## Scope boundary

不重写生成服务，不把候选 state 直接扩展为独立审批真相；#16 后续拥有 CQ 发布集成。

## Evidence at 43525be

- `packages/contracts/src/candidate-review.ts:6`
- `packages/contracts/src/asset-candidates.ts:49`
- `packages/application/src/assets/definition-candidates/validation.ts:47`
- `packages/application/src/synthetic/validation-service.ts:174`
- `packages/application/src/assets/publication/industry-asset-publication-service.ts:197`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #252

Dependencies: None
