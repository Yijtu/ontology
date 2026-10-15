# GAP-017 · 重做信息架构、视觉系统与应用框架

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: frontend

## Scope

- `platform/apps/web/src/components/App.tsx（导航/全局上下文）`
- `platform/apps/web/src/components/GuideHome.tsx`
- `platform/apps/web/src/components/ui/（新增公共组件）`
- `platform/apps/web/src/styles.css（tokens/基础组件）`
- `platform/apps/web/src/main.tsx（入口状态）`
- `platform/tests/ui/（框架交互）`

## Acceptance

- [ ] 以已合入 PR #250 为基线，组织成本体建模、项目实践两条主路径，行业资产/运行历史为辅助入口，配置与原始 JSON 放高级区域；保留已有可到达路径和行业贡献入口。
- [ ] 实现统一字体、间距、配色、按钮/输入/表格/状态/空白/加载/抽屉体系，参考 frontend-design.md 与可交互视觉方案；使用实际数据与契约，不用固定数量或假入口撑页面。
- [ ] 统一项目/工作区/包版本上下文，切换与 URL 深链保持一致；脏表单/审核选择保留或明确提示，禁止跨项目继续采用旧结果。普通路径不用输入 UUID/digest/序号。
- [ ] 1440/1024/768/390px 可用，键盘能操作导航/表单/抽屉并回到触发位置，焦点与对比度满足 WCAG 2.2 AA；框架无窄屏溢出，加载与失败可恢复。

## Dependencies

None

## Scope boundary

第一波与后端并行；本节点不改 Definition/Project/Business/Evidence 页面业务逻辑，也不重写客户场景组件。

## Evidence at 43525be

- `apps/web/src/components/App.tsx:79`
- `apps/web/src/components/GuideHome.tsx:1`
- `apps/web/src/styles.css:1`
- `PR #250 已合入 main @ 43525be`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #267

Dependencies: None
