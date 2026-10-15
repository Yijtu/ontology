# v0.3 实施基线冻结（V03-001 / #169）

日期：2026-09-29。范围：本批 `batch:v0.3-assistants` 共 72 个 Issue（A 47 / B 25）。
本记录只做静态盘点与版本核对，不启动应用、不调用模型或客户服务，不修改既有 WIP。

## 核对结论摘要

| 项目 | 结论 |
| --- | --- |
| main 基线 | `19c411e8db444e289e8c3ec0395ae909f2534601`，与 manifest.baselines.main 一致 |
| 通用研发线 | `feat/core-planning-provenance @ d17c7b520298703feb65f86761f34f1557927aca`，与 manifest 一致；工作区 `D:/work/ontology-main-decoupling` |
| 通用研发线 WIP | 35 个未提交项（25 改动 + 10 新增），保留原位，不 stash/reset |
| 文档发布线 | `feat/electrical-costing-poc`，工作区 `D:/work/ontology-core-main`（本记录来源） |
| Anker 场景线 | `feat/anker-home-energy`，工作区 `D:/work/ontology`，家庭能源场景；其可复用模块按能力核对，不整枝合入 |
| 旧本地 backlog | `.autoresearch/issues`：80 张卡，78 done，2 planned（LOCAL-052/053 等待外部实机条件） |
| loop 状态 | 仅 `D:/work/ontology/.loop-state.json`（旧 #1，`shipped`）；通用工作线无 `.loop-state.json`；不得覆盖旧记录 |
| 迁移号分配 | control 现有最大 `056`；研发 WIP 占 `057_core_plan_receipts.sql`；本批新增迁移一律从 **058** 起顺序追加 |

## main 已具备能力（只补装配 / 验收，不重复实现）

依据 `platform/docs/core-main-merge-2026-09-29.md`（main 合并台账）与 main 提交历史：

- 通用身份确认、发布事实、按对象实例化的规则与增量物化。
- 正式回答正文、字段核验、证据归档、历史读取与持久运行调度。
- 可替换数据库 / 模型 / 运行端口；公司文本抽取与独立 JEV 配置。
- Core API、五个操作页面、本地启动与数据库准备流程。
- 实际运行绑定的 1–3 字段查询、跨行业配置、重启后同回答与证据读取。
- `deploy/core/examples/` 下交通、工业两套合成验证资产（独立挂载演示，非通用核心常量）。
- `main@19c411e` 最终检查：lint/typecheck/build:web 通过，`vitest run` 209 文件 / 1936 项通过，Node 启动器 6/6。

据此，本批后端卡以“补齐正常装配 + 验收”为主，只实现 `A 通用 SPEC` 相对 main 的实际缺口。

## 仍留在研发线（不在 main）的未提交内容

`core-main-merge` 明确未合入、且当前 `feat/core-planning-provenance` 工作区仍以未提交文件存在：

- TemplatePlanner 新准备口：`packages/adapters/runtime-template/src/*`、`packages/application/src/workflow/planning.ts`、`core-template-plan-receipts.ts`、`core-template-plan-resolver.ts`。
- 计划收据迁移 `057_core_plan_receipts.sql`。
- 普通自然语言查询试验（planning / question-rewriting / few-shot 相关测试与装配）。
- 新规则派生来源桥：`packages/semantic-engine/src/provenance/rule-derivation-producer.ts`、`support-payload.ts`、`materialized-support-reader.ts`。
- UI/宿主装配改动：`apps/api/src/composition/core-local-composition.ts`、`core-main.ts`、`apps/web/src/components/*`、`tests/integration/*`。

**处理原则**：这些是 V03-024（NL 路由 / 计划回执）、V03-028/029（规则派生与证据链）的既有实现素材，实施对应卡时先核对再复用，只补缺口；不整枝合并，不删除。

## 冻结的公共契约与版本

- `@ontology/contracts` 导出面见 `packages/contracts/src/index.ts`：`ports`、`budget`、`component-registry`、`semantic-definitions`、`profile-store`、`source-bindings`、`web-search`、`run-store`、`feedback`、`job-store`、`document-parse`、`extraction`、`identity-decisions`、`decision-state`、`rule-extraction`、`semantic-publication`、`materialization`、`evidence-store`、`provenance-read`、`trusted`、`operations`、`compute`、`semver`、`industry-packs`、`pack-assets`、`preflight`、`verification`、`workflow`、`workflow-dispatch`、`planning`、`few-shot`、`schema-vocabulary`。
- 正式回答草稿当前版本：`answer-draft@2`（`packages/contracts/src/workflow.ts`）。V03-032 新增 `answer@3` 与表工件 manifest，必须 additive，且 `answer@1/@2` 继续可解析。
- 固定公共数据工具不变：`ontology_lookup`、`data_query`、`document_search`、`web_search`；领域计算只经注册的版本化 compute，禁止万能 eval。
- contracts 不得引入 React / SQL / HTTP / 行业实现；生成类型与 `schema/*.schema.json` 必须一致（`check:contracts`）。
- V03-002 冻结对象：Workspace、ProjectRevision、PublishedTaskBinding、immutable input artifact、capability status、`answer@3` body；`PublishedTaskBindingBody`/`ProjectRevisionBody`/`answer@3` body 与读取 envelope 分离，自身 ref/digest 与 verification receipts 不计回内容，避免 hash 自循环。

## 冻结的规则子集（有限可执行范围）

按 `spec-v0.3a/execution-evidence.md`：同一事实属性的**有限不同条件 OR**、**AND**、**例外**；**一跳**关系前提；规则依赖最多三层且无环。不支持的 OR / 关系前提 / 递归一律保持“尚不能执行”，不静默删条件换取通过。未知、冲突与 false 分开表达。切换规则版本或撤回来源后按仍有效支撑增量物化，历史证据不被当前投影覆盖。

## 冻结的目录与装配分配

- 包：`contracts`（纯数据/Schema/端口/版本/错误）、`core`、`application`、`semantic-engine`、`provenance`、`tool-services`、`adapters/*`、`extensions/home-energy`。
- 应用：`apps/api`、`apps/web`、`apps/worker`。
- 行业包：`industry-packs/{automotive,health-services,home-energy,transport-government}`；场景专业 UI 与组合入口独立于公共前端，公共前端不按行业名分支。
- 迁移：`platform/migrations/control/`，本批新增自 `058` 起，逐卡分配且不与 WIP `057` 冲突；每张新表带 `tenant_id`/`space_id` 主外键、RLS 与 scope_isolation 策略，只追加不修改已应用文件。
- 边界校验：`platform/tests/architecture/boundaries.config.json` + `pnpm run boundaries`。

## 与旧任务 / GitHub 卡的核对

- 旧 `.autoresearch/issues`（LOCAL-001…080）与旧 manifest 保留为历史记录，**不按旧队列自动执行本批**；`V03-xxx`／`LOCAL-xxx` 不自动等于 GitHub `#xxx`。
- 旧 backlog 唯一未完成项 LOCAL-052（HA 读集成）/ LOCAL-053（Live device actions）等外部实机条件，与本批 A/B 无交叉，保持外部未就绪。
- 本批权威映射：`batches/v0.3-assistants/manifest.json` 的 `issues[].github_issue_number` 与 `github_allowlist`。

## 未验证 / 外部条件

- 未运行应用、未调用模型或客户服务；本记录不构成任何功能已实现或已通过测试。
- 未验证真实外部模型、客户数据、设备与真实价源；真实客户报价接口（V03-070）、真实样本与业务签核（V03-071）保持明确外部就绪状态，不因盘点变更为已签核。
- 迁移分配与兼容反例在实施对应卡时以实际 `pnpm` 结果复验。

## 实施基线声明

本批实施以 main `19c411e8` 为语义基线，在 `feat/core-planning-provenance` 工作线（保留 05x WIP 与 `057`）上开发；按能力经独立审查合入 main，落地提交 SHA 在 V03-047 记录。此声明冻结后如需变更（规格漂移、迁移号冲突），先同步任务与测试覆盖再继续。
