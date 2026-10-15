# Core v0.3 A 增量验收记录：Ontology 知识工作台重塑

日期：2026-10-15。基线 main：`6164c55e9ebea9efe5f522b5abe0f113c9d03121`（N13 整栈验收合入后）。
权威设计：[A 知识工作台重塑设计](../../tasks/design-core-knowledge-workbench-2026-10-15.md)；
产品范围：[A PRD §6 增量](../../tasks/prd-generic-assistants-core-v0.3.md)。

本记录汇总「把 demo 感改成产品感」这条重塑路径的实际交付与验收命令。**连接测试通过不等于业务质量；受控响应不等于真实模型**，两类证据在下文分别记录。本批次不含任何造价／B 业务内容（main 仅承载通用 Core 与公共前端）。

## 1. 交付节点（N00～N17）

设计与节点编号见设计稿 §3、§5.4。全部节点已按 PR 合入 main：

| 节点 | 标题 / 类型 | 合入 PR |
| --- | --- | --- |
| N00 | 冻结产品范围与增量契约 / docs | [#325](https://github.com/Yijtu/ontology/pull/325) |
| N01 | 来源、研究与概览契约 / backend | [#327](https://github.com/Yijtu/ontology/pull/327) |
| N02 | 工作台外壳与导航 / frontend | [#326](https://github.com/Yijtu/ontology/pull/326) |
| N03 | 概览与真实待办 / backend | [#338](https://github.com/Yijtu/ontology/pull/338) |
| N04 | 来源审核、纳入与撤回 / backend | [#331](https://github.com/Yijtu/ontology/pull/331) |
| N05 | 可归档的公共搜索适配 / infra | [#330](https://github.com/Yijtu/ontology/pull/330) |
| N06 | 来源库与上传体验 / frontend | [#329](https://github.com/Yijtu/ontology/pull/329) |
| N07 | 文件映射接入体验 / frontend | [#328](https://github.com/Yijtu/ontology/pull/328) |
| N08 | 有界研究编排 / backend | [#339](https://github.com/Yijtu/ontology/pull/339) |
| N09 | 行业工作流贯通 / frontend | [#335](https://github.com/Yijtu/ontology/pull/335) |
| N10 | 项目任务与结果贯通 / frontend | [#337](https://github.com/Yijtu/ontology/pull/337) |
| N11 | 研究授权与进度界面 / frontend | [#336](https://github.com/Yijtu/ontology/pull/336) |
| N12 | 正常启动装配与联调 / fullstack | [#340](https://github.com/Yijtu/ontology/pull/340) |
| N13 | 整栈与隔离验收 / fullstack | [#341](https://github.com/Yijtu/ontology/pull/341) |
| N14 | 上手文档与交付记录 / docs | 本记录所在 PR |
| N15 | 多模型目录、凭据托管与分配服务 / backend | [#332](https://github.com/Yijtu/ontology/pull/332) |
| N16 | 执行模型绑定与热切换 / backend | [#334](https://github.com/Yijtu/ontology/pull/334) |
| N17 | AI 设置与生效模型界面 / frontend | [#333](https://github.com/Yijtu/ontology/pull/333) |

交付的可见能力：首屏「工作概览」与三料源入口（AI 搜寻 / 上传 / 结构化接入）、两个工作台（行业 / 项目）、服务端派生的真实待办、来源审核→纳入→撤回、AI 搜寻的有界编排与授权界面、多模型连接目录与按能力/对象分配、执行模型固定与热切换。

## 2. 实际运行的命令与结果

以下命令在 `platform/` 下执行，结果为本批次（N13/N14 时点）实测：

| 命令 | 结果 |
| --- | --- |
| `pnpm run verify` | lint + 四套类型检查 + 单元/集成测试：**3303 通过** |
| `pnpm run boundaries` | 依赖边界检查：**8/8 通过** |
| `pnpm run test:e2e` | 真实 Chromium 浏览器 E2E：**102 通过**（含旧入口到新信息架构的迁移断言、模型设置面、工作台与三料源） |

E2E 与集成验收使用真实 PostgreSQL、不可变对象工件与真实浏览器；容器测试使用项目标记的命名卷并显式回收。

## 3. 新增迁移

本批次相对重塑基线新增 4 张迁移，控制库 `platform/migrations/control/` 现共 59 个 SQL 迁移：

| 序号 | 文件 | 内容 | 节点 |
| --- | --- | --- | --- |
| 089 | `089_source_review_admissions.sql` | 来源审核历史、来源纳入记录与撤回事件 | N04 |
| 090 | `090_model_connections.sql` | 模型连接目录、凭据元数据与分配 | N15 |
| 091 | `091_workspace_research_runs.sql` | 工作区研究记录（关联 job / ledger / brief / 策略） | N08 |
| 092 | `092_model_connection_tests_scope_pkey.sql` | 修正模型连接测试表主键，使每个控制键都带 tenant_id/space_id | N13 |

编号空缺不补造迁移；`088_candidate_sources.sql` 在本批重塑前已在 main 上。

## 4. 受控响应与真实模型分别记录

- **受控验收**：生成模型以受控 provider 只替代 HTTP 边界；外部搜索/归档走受控适配器。集成/E2E 在真实 PostgreSQL、不可变工件与真实浏览器上运行。这些用例证明的是**机制正确**（授权、预算、取消、隔离、撤回、同版本发布、热切换固定），**不是真实模型或客户质量**。
- **真实模型**：本批**未调用**公司真实模型 API，模型质量、消歧、人工修改率均未验收。
- **外部搜索/归档**：未针对真实搜索 provider 与真实域名授权做验收；快照归档的可归档/越域/超限拒绝由受控用例覆盖。
- **客户生产系统**：数据库连接器、向量库、DataOS 等未接入；结构化接入首期仅为文件映射快照。

## 5. 未验证项

- 真实外部生成模型与研究模型的质量、成本与参考集评测（缺授权资源，如实记为未验证）。
- 真实外部搜索提供方、归档域名授权与内容授权范围。
- 客户生产数据库 / 向量库 / DataOS 连接器与实机效果。
- 连接测试通过只证可达与协议匹配，不代表业务答案正确率。

## 6. 相关阅读

- [本机启动指南](core-local-startup-2026-09-28.md)：重塑后的入口与启动步骤。
- [A 主线验收记录](v03-a-core-acceptance-2026-10-11.md)：重塑前 A 通用 Core 的验收证据。
- [A 知识工作台重塑设计](../../tasks/design-core-knowledge-workbench-2026-10-15.md)：双工作台、三料源与 AI 设置的权威定义。
