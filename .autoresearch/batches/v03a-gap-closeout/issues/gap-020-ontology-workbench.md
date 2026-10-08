# GAP-020 · 重做资料、候选审核与行业包发布体验

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: frontend

## Scope

- `platform/apps/web/src/components/OntologyWorkspacePanel.tsx`
- `platform/apps/web/src/components/WorkspaceSourcesPanel.tsx`
- `platform/apps/web/src/components/DefinitionWorkbenchPanel.tsx`
- `platform/apps/web/src/components/PackagePublicationPanel.tsx`
- `platform/apps/web/src/components/ontology/（新增局部组件/样式）`
- `platform/tests/ui/（本体流程）`

## Acceptance

- [ ] 按资料→生成→审核→验核→发布形成可理解流程，上传/解析覆盖、失败原因、来源定位、生成预算与工作区版本在对应步骤展示；无需在模块间反复寻找操作。
- [ ] 候选列表、定义详情、原文依据并排，搜索/筛选/批量操作/键盘切换可用；对象/属性/关系提供结构化编辑与拆分/合并预览，审核与编辑严格区分，切换后不丢草稿。
- [ ] 有限规则/例外通过条件编辑器与自然语言摘要展示，动作从真实登记列表选择；高级 JSON 折叠且有运行时校验，普通用户不必写 JSON 或摘要。未经批准的来源/候选不得显示已生效。
- [ ] CQ 就绪、阻断项、完整 diff 与破坏性策略在发布前清晰呈现；版本比较能读懂变更对象及影响，所有按钮连接真实 API，权限/模型关闭/失败/取消/未知均可解释。

## Dependencies

GAP-007, GAP-008, GAP-009, GAP-016, GAP-017

## Scope boundary

复用 #17 公共组件与 tokens；不修改 App/global styles，由 #22 最终挂载。

## Evidence at 43525be

- `apps/web/src/components/DefinitionWorkbenchPanel.tsx:157`
- `apps/web/src/components/PackagePublicationPanel.tsx:369`
- `apps/web/src/components/WorkspaceSourcesPanel.tsx:1`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #270

Dependencies: #257 (GAP-007), #258 (GAP-008), #259 (GAP-009), #266 (GAP-016), #267 (GAP-017)
