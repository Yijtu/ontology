# GAP-011 · 接通固定项目事实快照与持久查询投影

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/application/src/projects/project-materialization-service.ts`
- `platform/packages/semantic-engine/src/project-query/`
- `platform/packages/adapters/data-postgres/src/project-dataset.ts`
- `platform/apps/api/src/composition/core-template-plan-resolver.ts（structuredQueryPlan）`
- `platform/apps/api/src/composition/core-project-query-handler.ts（新增）`
- `platform/tests/integration/project-semantic-sql.spec.ts`

## Acceptance

- [ ] 从 #10 已发布事实读视图生成项目投影，绑定 project revision、definition、mapping、fact recorded point 与 source digest；删除 structured_query 路径对 mappingRefs[0] 启动样例的依赖。
- [ ] 装配现有 PostgresProjectDatasetAdapter 为生产持久快照选项，独立业务数据库配置，不把查询表放进控制 schema；DuckDB 留作可重建/可替换投影。
- [ ] 任务/工具每次运行使用固定 snapshot descriptor，重启仍可读取同一 ready 快照；缺快照、已撤回/陈旧修订、换 definition 必须显式未就绪，禁止退回旧样例或最新数据。
- [ ] 真实 PG 与 DuckDB 同一契约套件验证精确 DECIMAL、分页、跨项目拒绝、1001 行、取消与 cell source；改变新输入改变正常任务结果，历史运行仍读旧固定快照。

## Dependencies

GAP-010

## Scope boundary

不改通用 NL/规则任务路由（#15）；不升级到 Quack 或另建数据库服务。

## Evidence at 43525be

- `apps/api/src/composition/core-template-plan-resolver.ts:766`
- `apps/api/src/composition/core-local-composition.ts:2256`
- `packages/semantic-engine/src/project-query/service.ts:26`
- `packages/adapters/data-postgres/src/project-dataset.ts:63`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #261

Dependencies: #260 (GAP-010)
