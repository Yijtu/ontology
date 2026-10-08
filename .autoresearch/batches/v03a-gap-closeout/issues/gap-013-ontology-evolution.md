# GAP-013 · 换本体版本后有界重提取与重物化

Batch: v03a-gap-closeout
Target: main
Priority: P1
Type: backend

## Scope

- `platform/packages/application/src/projects/project-service.ts（evolve）`
- `platform/packages/application/src/projects/project-evolution-service.ts（新增）`
- `platform/apps/worker/src/（版本升级作业）`
- `platform/packages/contracts/src/projects.ts`
- `platform/tests/integration/project-api-postgres.spec.ts`

## Acceptance

- [ ] evolve 按 #2 显式策略输出影响清单，并调度有界重新映射/抽取/审核/事实物化/投影；不能只改 definitionRef 使旧事实在新视图中无声消失。
- [ ] 支持追加属性、身份/类型/单位/关系变更的人工处理，无法迁移项明确待确认；keep_independent 保留旧版，retire_previous 只撤当前可见性不删历史。
- [ ] 旧版本在重建期间维持明确状态，新版完成审核、事实和快照 ready 后 CAS 激活；失败/取消/重试不复活撤回内容，旧绑定任务不得混用新数据。
- [ ] 真实 PG 新版同原文重提取并验证新增字段可查、旧 answer/evidence/recorded point 可回读；作业量、预算、幂等与并发换版失败路径有证据。

## Dependencies

GAP-002, GAP-010, GAP-011

## Scope boundary

依赖 #11 串行修改项目快照激活逻辑；不重写全局任务调度框架。

## Evidence at 43525be

- `packages/application/src/projects/project-service.ts:622`
- `packages/semantic-engine/src/materialization/published-source.ts:172`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #263

Dependencies: #252 (GAP-002), #260 (GAP-010), #261 (GAP-011)
