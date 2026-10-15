# GAP-015 · 自然语言选择规则与关系任务并补齐内部绑定

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/workflow/planning.ts`
- `platform/apps/api/src/composition/core-template-plan-resolver.ts（规则/关系路径）`
- `platform/apps/api/src/composition/core-task-bindings.ts`
- `platform/apps/api/src/composition/core-rule-judgement-handler.ts`
- `platform/apps/api/src/composition/core-relations-task-handler.ts（新增）`
- `platform/tests/integration/core-rule-judgement-task-postgres.spec.ts`

## Acceptance

- [ ] 受控 NL 可以提出已启用的 structured_query、rule_judgement、relations、document_qa、已注册 compute 任务意图；host 基于 profile/CQ/注册项约束选择，模型不能提升权限或指定任意函数。
- [ ] 服务端从固定 project revision/definition/事实点解析 ruleRef/digest/asOfRecordedSeq/subject；用户只选择可理解的规则/实体或描述问题，歧义请求澄清，不让模型伪造内部摘要。
- [ ] 挂载 relations 任务，复用已发布有界导航器与 answer@3；规则路径经过 #14 前提核验，查询路径经过 #11 固定项目快照。
- [ ] 模型关闭可使用显式任务和确定性参数表单；模型配置开启才接受 NL；受控模型正常 HTTP 入口覆盖路由、能力缺失、歧义、取消和跨项目，并保持四个公共工具不变。

## Dependencies

GAP-011, GAP-012, GAP-014

## Scope boundary



## Evidence at 43525be

- `packages/application/src/workflow/planning.ts:546`
- `apps/api/src/composition/core-task-bindings.ts:57`
- `apps/api/src/composition/core-rule-judgement-handler.ts:109`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #265

Dependencies: #261 (GAP-011), #262 (GAP-012), #264 (GAP-014)
