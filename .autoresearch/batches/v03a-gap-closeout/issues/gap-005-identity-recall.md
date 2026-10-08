# GAP-005 · 接入服务端身份召回与人工裁决

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/apps/api/src/http/instances.ts`
- `platform/packages/semantic-engine/src/identity/recall-service.ts`
- `platform/packages/application/src/identity/（新增接线服务，如需要）`
- `platform/tests/integration/identity-recall-postgres.spec.ts`

## Acceptance

- [ ] 生产实例身份流程调用 EntityCandidateRecallService，按 definition identityScope 使用 nativeId、规范名、别名和证据；前端无需自造候选全集。
- [ ] 召回有界、跨租户/项目隔离，返回排序与来源；零结果、截断、相似度未配置均显式呈现，禁止把置信度当成批准。
- [ ] 采用已有人工身份决策，重复确认幂等；同 nativeId、不同身份域及不一致候选必须冲突或待裁决，不静默合并。
- [ ] 用真实 PG 验证召回→人工绑定→发布读取及撤回；返回可注册路由/工厂，装配由 #19 完成。

## Dependencies

None

## Scope boundary



## Evidence at 43525be

- `apps/api/src/http/instances.ts:310`
- `packages/semantic-engine/src/identity/recall-service.ts:111`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #255

Dependencies: None
