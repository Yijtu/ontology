# GAP-021 · 重做项目导入、任务结果与来源阅读体验

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: frontend

## Scope

- `platform/apps/web/src/components/ProjectWorkspacePanel.tsx`
- `platform/apps/web/src/components/InstanceReviewPanel.tsx`
- `platform/apps/web/src/components/BusinessWorkbenchPanel.tsx`
- `platform/apps/web/src/components/QueryPanel.tsx`
- `platform/apps/web/src/components/ResultWorkbenchPanel.tsx`
- `platform/apps/web/src/components/EvidencePanel.tsx`
- `platform/apps/web/src/components/project/（新增局部组件/样式）`
- `platform/tests/ui/（项目/业务/证据流程）`

## Acceptance

- [ ] 结构化导入使用文件预览、列映射对照、单位/必需字段检查与未确认记录队列；身份候选由服务端召回，冲突与手工裁决可操作，后台任务状态与来源能直接打开。
- [ ] 任务首页展示真实已挂载任务和项目就绪条件，NL 与任务参数表单并存；无需填写 ruleRef/asOfRecordedSeq/inputSnapshot digest，参数变更可预览，歧义澄清与取消/重试状态稳定。
- [ ] 结果以结论、正式表格、依据层次呈现；分页/筛选保持固定已核验版本，未核验流式内容、unknown/conflict/不完整不得冒充正式答案；证据抽屉能逐级到原文/单元格。
- [ ] 换版影响与重提取进度、旧结果版本/当前有效性和运行历史可理解；桌面密集表格与 390px 主路径可用，loading/empty/error/permission/model-off/revoked 状态有独立验证。

## Dependencies

GAP-005, GAP-011, GAP-013, GAP-014, GAP-015, GAP-017, GAP-018

## Scope boundary

与 #20 文件/样式分开；不改 API/规则/compute 逻辑或场景专属报价表。

## Evidence at 43525be

- `apps/web/src/components/BusinessWorkbenchPanel.tsx:403`
- `apps/web/src/components/ProjectWorkspacePanel.tsx:526`
- `apps/web/src/components/EvidencePanel.tsx:1`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #271

Dependencies: #255 (GAP-005), #261 (GAP-011), #263 (GAP-013), #264 (GAP-014), #265 (GAP-015), #267 (GAP-017), #268 (GAP-018)
