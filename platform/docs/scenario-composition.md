# 场景装配边界（main 基线）

本仓库的通用控制器、工具网关、数据适配和核验链路不根据“家庭能源”分支执行。一个部署选择 profile、时区、行业语义、客户物理映射及按需启用的界面/HTTP 路由；这些选择由装配入口负责，不成为 `App` 或 `createApiServer` 的内置默认值。

## 现在的代码边界

| 层 | 通用入口 | 场景装配点 |
| --- | --- | --- |
| Web 壳 | `apps/web/src/components/App.tsx` 只声明工作台、问答、任务、审核、证据五个公共视图 | `scenarioViews` 提供命名、标签和 renderer；当前能源视图在 `scenarios/home-energy-view.tsx` |
| 业务问答/工作台 | `QueryPanel`、`Workbench` 都要求调用方传入 `profileRef`；问答的 `timeZone` 和上下文字段也由调用方传入 | `apps/web/src/deployment.ts` 为现有家庭能源 demo 提供站点字段。其他部署可配置自己的文本、数字或枚举字段，不修改共享组件 |
| HTTP 宿主 | `createApiServer` 只注册通用路由组，不 import 能源类型或能源路由 | 调用方在同一个 Fastify 实例上显式调用 `registerSimulationRoutes(app, ...)`，或注册另一个领域的路由 |
| 业务数据 | `DataQueryHandler`、DuckDB/PostgreSQL 适配器和证据协议只看契约与已确认 mapping | 部署注册来源、物理表/视图、单位/编码转换和行业概念。复杂长表先做可追溯的预处理 |

目前 `main.tsx` 装配了已有家庭能源演示，以维持演示与浏览器测试；这只是部署配置，不是共享组件的默认业务。`?profileId=transport-facility-inspection&profileVersion=1.0.0&timeZone=UTC` 可使通用界面针对另一 profile 请求范围，但真实服务端仍需先注册并激活该 profile。参数并不会自动创建客户数据或语义映射。

一个非能源视图只需贡献 `AppViewContribution`，例如 `view: 'transport-inspection'`、`label: '交通设施巡检'` 和一个 renderer。问答条件通过部署的 `queryContextFields` 传入，如交通的 `district`；通用问答不内置 `siteRef`。它不能绕过通用的 run、证据与核验契约；新增场景也不要求创建 npm 包。`tests/ui/app-scenario-composition.spec.ts` 用交通巡检视图、字段和 profile 验证 UI 替换，`tests/composition/transport-semantic-scenario.spec.ts` 用实际 DuckDB 交通设施数据验证不同概念、列名与状态编码仍走同一个 `data_query` 和证据路径。既有能源浏览器测试仍验证原场景可用。

## 新场景接入顺序

1. 先确定代表问题、正确/错误结果与证据来源；不要从页面控件反推行业模型。
2. 登记来源及权限，确认物理 schema、单位、时间、身份键和更新/撤回语义。简单差异落在版本化 mapping，复杂整形落在受限视图/预处理。
3. 将行业定义、mapping、runtime、后端和工具授权固定到 profile；预检缺失能力后再激活。模型输出不能提升授权或改变已锁定版本。
4. 需要专属算法或结果视图时，在场景模块实现计算 handler/renderer，并在部署层注册；通用 App/API/Controller 不新增客户表名或行业判断。
5. 用相同语义、不同物理 schema 的数据测试，以及第二行业的不同概念测试；再覆盖无数据、冲突、过期、权限、来源撤回和证据完整性。

该改动提供可替换的装配边界，不等于已经接入真实交通数据或自动抽取任意行业本体。后续功能分支仍需按产品 SPEC 完成文档抽取、消歧、规则/派生事实、复杂查询与多路径回答的闭环。
