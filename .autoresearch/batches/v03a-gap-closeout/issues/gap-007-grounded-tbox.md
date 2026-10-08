# GAP-007 · 按原文生成 TBox 并安全重生成

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/assets/definition-candidates/service.ts`
- `platform/packages/application/src/assets/definition-candidates/model-output.ts`
- `platform/packages/contracts/src/asset-candidates.ts（来源输出必要扩展）`
- `platform/apps/api/src/http/definition-candidates.ts`
- `platform/tests/unit/definition-candidate-generation.spec.ts`

## Acceptance

- [ ] 调用 #1 真实读取源文本/表头，在受控模型捕获请求中证明内容已发送；输出候选必须引用有效片段且 span/digest 可回读，虚构引用进入失败/待确认而不能发布。
- [ ] 同 logicalId 重生成相对当前候选/已发布定义 rebase：完全相同幂等复用、变更追加 replacesCandidateId、冲突明确保留；保留人工改动，新的内容必须重新审核。
- [ ] 输出 token 上限与本次候选数匹配，有界分批、截断/异常 JSON/未 completed/取消显式失败；模型未配置在调用前提示未就绪，不存 model-not-configured 伪调用记录。
- [ ] 有限 CQ 与业务边界作为上下文；测试原文注入、缺来源、500 候选/预算、重复生成、人工编辑、租户隔离，增加真实 PG API 路径的受控模型验收。

## Dependencies

GAP-001, GAP-002, GAP-006

## Scope boundary



## Evidence at 43525be

- `packages/application/src/assets/definition-candidates/service.ts:642`
- `packages/application/src/assets/definition-candidates/service.ts:751`
- `apps/api/src/composition/core-local-composition.ts:2152`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #257

Dependencies: #251 (GAP-001), #252 (GAP-002), #256 (GAP-006)
