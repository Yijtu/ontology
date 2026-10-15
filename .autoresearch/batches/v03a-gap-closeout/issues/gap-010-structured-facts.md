# GAP-010 · 将已确认结构化记录物化为语义事实

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/projects/project-mapping-service.ts`
- `platform/packages/application/src/projects/project-fact-materialization-service.ts（新增）`
- `platform/packages/application/src/publication/（复用事实发布管线的桥）`
- `platform/packages/contracts/src/project-mapping.ts`
- `platform/tests/integration/project-fact-materialization-postgres.spec.ts（新增）`

## Acceptance

- [ ] CSV/XLSX 规范化项目记录只作为审核暂存；固定已确认 mapping/record revision、definition、单位因子与人工身份绑定后，通过既有候选审核/发布机制生成实体、属性、已解析关系事实。
- [ ] 已发布语义事实是问答/规则的唯一语义真相；不得在事实与查询表两边分别改业务值，未确认字段、未知身份、解析不完整不得自动升级为事实。
- [ ] 保留每条事实到原始单元格/row digest 的来源、精确十进制、valid/recorded 时间；分页批处理、幂等、事务/outbox、撤回多支撑、租户/项目隔离均覆盖。
- [ ] 真实 PG 导入→映射→人工确认→身份→发布→ontology_lookup/规则读取闭环，验证两种列名/单位映射产生相同语义值且保留不同物理来源；超上限显式拒绝。

## Dependencies

GAP-002, GAP-005

## Scope boundary

不修改 published-source 的关系求值逻辑（#3）；采用其公开事实读取/发布端口。

## Evidence at 43525be

- `packages/application/src/projects/project-mapping-service.ts:470`
- `packages/semantic-engine/src/materialization/published-source.ts:127`
- `packages/contracts/src/semantic-publication.ts:20`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #260

Dependencies: #252 (GAP-002), #255 (GAP-005)
