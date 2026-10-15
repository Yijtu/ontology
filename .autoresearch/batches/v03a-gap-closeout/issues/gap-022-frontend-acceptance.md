# GAP-022 · 完成主应用接线与响应式前端验收

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: frontend

## Scope

- `platform/apps/web/src/components/App.tsx（新页面最终挂载）`
- `platform/apps/web/src/main.tsx`
- `platform/tests/e2e/（正常入口三管线）`
- `platform/tests/ui/（公共可访问性）`
- `platform/docs/frontend-acceptance.md（新增）`

## Acceptance

- [ ] 正常主应用 URL 进入全部更新页面；项目/工作区/行业包/运行深链可刷新、前进后退和切换，#250 已有入口不丢失；配置/JSON 等高级功能可达但不占据主流程。
- [ ] 真实 chromium + #19 正常宿主覆盖新建工作区→资料→模型受控生成→原文→审核→CQ→发布、项目→映射→身份→物化、规则/关系问答→核验结果→原文，禁止 harness/mock 全链路代替。
- [ ] 1440/1024/768/390px 截图验收，主流程无页面级横向溢出，长中文/数字/空数据能读；键盘、抽屉焦点、表单 label、对比度、非颜色状态及 reduced-motion 满足约定。
- [ ] web build/typecheck/UI 与浏览器 E2E 通过，保留关键页面前后截图和失败状态证据；若视觉明显仍是零散表单/粗糙卡片堆叠必须迭代，功能与视觉两项均达标才完成。

## Dependencies

GAP-017, GAP-019, GAP-020, GAP-021

## Scope boundary

依赖 #17，串行修改 App/main；生产后端先由 #19 合入，避免 UI 验收与后端接线互相等待。

## Evidence at 43525be

- `apps/web/src/main.tsx:1`
- `apps/web/src/components/App.tsx:79`
- `platform/docs/v03-a-release-2026-09-30.md`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #272

Dependencies: #267 (GAP-017), #269 (GAP-019), #270 (GAP-020), #271 (GAP-021)
