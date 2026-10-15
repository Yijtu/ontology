# GAP-009 · 从动态发布包读取可复用术语

Batch: v03a-gap-closeout
Target: main
Priority: P1
Type: backend

## Scope

- `platform/packages/application/src/assets/definition-candidates/terminology.ts`
- `platform/packages/application/src/assets/definition-candidates/dynamic-terminology.ts（新增）`
- `platform/tests/unit/dynamic-terminology.spec.ts（新增）`

## Acceptance

- [ ] 按 basePackRef 精确 id/version/digest 从授权 published catalogue/definition reader 加载对象、属性、关系、身份与单位声明；静态包与动态包使用同一端口。
- [ ] 声明来源保留版本，别名/显示名相同但业务意义不同时不自动合并；动态定义有术语，缺包/退役权限/错摘要显式失败，不回退为空术语。
- [ ] 从包 A 创建工作区 B 并生成增量候选，证明既有术语被正确引用、冲突可解释，跨租户私有包不可读取。
- [ ] 缓存如采用必须按 scope+完整 ref 分区、仅缓存不可变版本；不扩展多 basePack 合并、共享词表平台或类层次。

## Dependencies

GAP-002

## Scope boundary



## Evidence at 43525be

- `packages/application/src/assets/definition-candidates/terminology.ts:68`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #259

Dependencies: #252 (GAP-002)
