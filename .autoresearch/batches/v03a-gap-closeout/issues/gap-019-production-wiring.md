# GAP-019 · 统一生产装配并验收新能力入口

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: infra

## Scope

- `platform/apps/api/src/composition/core-local-composition.ts`
- `platform/apps/api/src/composition/（本批叶模块装配）`
- `platform/apps/worker/src/（必要注册）`
- `platform/tests/composition/`
- `platform/tests/e2e/`
- `platform/docs/`
- `README.md`
- `本批 manifest/完成记录`

## Acceptance

- [ ] 唯一负责装配根接线：来源读取、审核发布、召回、事实写入、PG 投影、规则关系任务、索引、真实摘要和 CQ 均进入正常宿主；拆出本批叶模块，避免继续在 2428 行文件堆逻辑。
- [ ] 正常 HTTP/worker 宿主挂载全部叶模块，通过真实 PG composition 集成、typecheck/boundaries/受影响回归；故障、隔离、取消、未配置能力有明确结果。
- [ ] 向 #22 前端整栈验收提供真实 API 与已登记的两个合成行业、固定快照/规则/CQ/证据路径；不能由前端 mock API 代替生产接线。
- [ ] 记录迁移/配置/支持子集与装配证据；本节点不承担全批 release gate，#23 在 #22 通过后做最终主线验收。

## Dependencies

GAP-004, GAP-009, GAP-013, GAP-015, GAP-016, GAP-018

## Scope boundary



## Evidence at 43525be

- `AGENTS.md`
- `platform/docs/v03-a-release-2026-09-30.md`
- `apps/api/src/composition/core-local-composition.ts`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #269

Dependencies: #254 (GAP-004), #259 (GAP-009), #263 (GAP-013), #265 (GAP-015), #266 (GAP-016), #268 (GAP-018)
