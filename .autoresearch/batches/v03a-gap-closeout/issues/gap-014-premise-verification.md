# GAP-014 · 核验规则前提事实与原文定位

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/answers/typed-draft-writer.ts`
- `platform/packages/application/src/verification/typed-checkers.ts`
- `platform/packages/semantic-engine/src/provenance/（规则派生来源读取）`
- `platform/packages/provenance/src/（复用通用证据读取）`
- `platform/tests/integration/rule-derivation-provenance-postgres.spec.ts`
- `platform/tests/integration/answer-routes-postgres.spec.ts`

## Acceptance

- [ ] rule_judgement 草稿带实际 premiseRefs，逐一绑定规则版本、属性/关系/上游支撑、固定 recorded point 与来源工件，而非 premiseRefs: []。
- [ ] 核验沿归档前提回读事实和 span/row digest，并按该批真实有限规则重算结果；不能只用归档 applicability 状态自证答案正确。
- [ ] 错误前提、错 span、错 ruleRef、丢边/丢上游支撑、跨 scope 和撤回竞态均不得核验通过；approximate OCR 或来源缺口按已有精度/coverage 语义保留限制。
- [ ] 复用既有 evidence/answer@3/发布有效性，不新增收据家族；覆盖一跳目标条件、三层链、多替代支撑及历史版本的真实 PG 来源闭环。

## Dependencies

GAP-001, GAP-003, GAP-010, GAP-012

## Scope boundary



## Evidence at 43525be

- `packages/application/src/answers/typed-draft-writer.ts:412`
- `packages/application/src/verification/typed-checkers.ts:227`
- `packages/semantic-engine/src/provenance/rule-derivation-producer.ts:322`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #264

Dependencies: #251 (GAP-001), #253 (GAP-003), #260 (GAP-010), #262 (GAP-012)
