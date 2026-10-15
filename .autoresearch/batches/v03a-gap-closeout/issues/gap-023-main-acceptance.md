# GAP-023 · 完成全批独立审查与主线交付门槛

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: infra

## Scope

- `platform/tests/（全批适用回归与金标）`
- `platform/docs/（release 与限制）`
- `README.md`
- `本批 manifest/完成记录`

## Acceptance

- [ ] lint、typecheck、boundaries、全套适用 tests、web build 与 chromium E2E 通过；真实 PG 测试并发受控且测试卷回收，未归属 error 必须定位。
- [ ] 至少两个合成行业、两查询后端、1001 行/固定历史快照，以及撤回/隔离/取消/版本重提取经过正常前后端闭环；CQ 独立预期与来源证据均成立。
- [ ] 独立 review-it 按 AGENTS 检查语义与用户体验，不允许宽化断言或能力子集掩盖缺陷；修复后复跑对应检查，视觉与功能验收记录可核对。
- [ ] 全部节点的实际提交/PR/最终 main SHA、迁移、支持范围、外部未验证项写入本批记录；受控机制不冒充真实模型质量，保留旧 manifest/工作区，不顺带关闭 #169 或启动 B。
- [ ] 用户追加：全部前置能力与前端合入 main 后，基于实际 main Core 重写根 README.md；简洁、生动，一个可运行真实例子和验证过的启动方法，详细契约放链接，不将规划功能写成已完成。

## Dependencies

GAP-019, GAP-022

## Scope boundary



## Evidence at 43525be

- `AGENTS.md`
- `platform/docs/v03-a-release-2026-09-30.md`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #273

Dependencies: #269 (GAP-019), #272 (GAP-022)
