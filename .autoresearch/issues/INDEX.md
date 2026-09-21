# v0.2 本地 Issue 索引

基于 [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)、[SPEC](../../tasks/spec-industry-semantic-agent-v0.2.md) 与[家庭能源场景](../../tasks/scenario-home-energy-hackathon.md)。

已生成 **54 张本地 Issue**：51 张本地实现/验收任务，3 张外部条件任务。工程位于 `D:/work/ontology`，已关联 [Yijtu/ontology](https://github.com/Yijtu/ontology)。全部状态 planned，未启动代码实现；任务和验收不依赖历史原型。

远程映射（增量进行，不批量预建）：

| LOCAL | GitHub Issue | 状态 |
|---|---|---|
| LOCAL-001 | [#1](https://github.com/Yijtu/ontology/issues/1) | open，本批执行 |
| LOCAL-002 ~ LOCAL-054 | 未创建 | 待前置完成后逐批创建 |

- [机器可读清单](manifest.json)：依赖、状态、源文档hash、进入条件。
- [需求覆盖](coverage.md)：25 个故事的每条验收、34 条 FR、18 个设计任务。
- [执行交接](handoff.md)：本地执行、GitHub映射与 loop-it 注意事项。

## 建议起点

仅 **[LOCAL-001：建立工作区与边界检查](issue-001-typescript-workspace.md)** 无前置依赖。它是输入已齐的首张卡，不代表本轮已授权实现。完成并验证后再解锁 LOCAL-002；公共契约完成后即可准备 LOCAL-048 的独立语义夹具，供后续规则实现消费。不要把 54 张卡直接当作一个全量自动执行批次。

## Issue 清单

| ID | 任务 | 类型 | 优先级 | 前置 | 当前就绪状态 |
|---|---|---|---|---|---|
| [LOCAL-001](issue-001-typescript-workspace.md) | 建立 TypeScript 工作区与依赖边界检查 | infra | high | 无 | 输入就绪 |
| [LOCAL-002](issue-002-canonical-contracts.md) | 定义公共 JSON Schema、端口及统一结果协议 | backend | high | LOCAL-001 | 等待依赖 |
| [LOCAL-003](issue-003-package-profile-manifests.md) | 定义行业包与场景配置清单 | backend | high | LOCAL-002 | 等待依赖 |
| [LOCAL-004](issue-004-control-postgres-foundation.md) | 实现 PostgreSQL 控制存储基础与租户隔离 | infra | high | LOCAL-002 | 等待依赖 |
| [LOCAL-005](issue-005-immutable-artifacts.md) | 实现不可变工件与来源定位存储 | backend | high | LOCAL-002, LOCAL-004 | 等待依赖 |
| [LOCAL-006](issue-006-component-registry.md) | 实现组件注册、生命周期和版本冻结 | backend | high | LOCAL-003, LOCAL-004, LOCAL-005 | 等待依赖 |
| [LOCAL-007](issue-007-profile-composition.md) | 实现场景预检、版本清单与激活接口 | backend | high | LOCAL-003, LOCAL-004, LOCAL-006 | 等待依赖 |
| [LOCAL-008](issue-008-source-bindings-probe.md) | 实现数据源登记与能力探测框架 | backend | high | LOCAL-002, LOCAL-004, LOCAL-007 | 等待依赖 |
| [LOCAL-009](issue-009-run-events-api.md) | 实现运行记录、事件 API 与并发修订 | backend | high | LOCAL-002, LOCAL-004, LOCAL-007 | 等待依赖 |
| [LOCAL-010](issue-010-budget-ledger.md) | 实现共享预算、工具意图与用量账本 | backend | high | LOCAL-004, LOCAL-009 | 等待依赖 |
| [LOCAL-011](issue-011-tool-gateway-local.md) | 实现统一工具网关、本地注册与证据结果 | backend | high | LOCAL-002, LOCAL-005, LOCAL-006, LOCAL-007, LOCAL-009, LOCAL-010 | 等待依赖 |
| [LOCAL-012](issue-012-postgres-query-adapter.md) | 实现 PostgreSQL 只读查询适配器 | backend | high | LOCAL-008, LOCAL-011 | 等待依赖 |
| [LOCAL-013](issue-013-duckdb-query-adapter.md) | 实现 DuckDB 本地查询适配器 | backend | high | LOCAL-008, LOCAL-011 | 等待依赖 |
| [LOCAL-014](issue-014-mcp-transport.md) | 实现 stdio MCP 与本地工具等价调用 | backend | high | LOCAL-011, LOCAL-012 | 等待依赖 |
| [LOCAL-015](issue-015-generation-model-adapter.md) | 实现生成式模型端口与公司 API 适配 | backend | high | LOCAL-002, LOCAL-009, LOCAL-010 | 等待依赖 |
| [LOCAL-016](issue-016-jev-decision-adapter.md) | 实现 JEV 决策适配与显式降级 | backend | high | LOCAL-002, LOCAL-010, LOCAL-015 | 等待依赖 |
| [LOCAL-017](issue-017-template-runtime.md) | 实现模板运行时适配器 | backend | high | LOCAL-009, LOCAL-011, LOCAL-015 | 等待依赖 |
| [LOCAL-018](issue-018-pi-runtime.md) | 实现 Pi Agent Core 运行时适配器 | backend | high | LOCAL-009, LOCAL-011, LOCAL-015, LOCAL-016 | 等待依赖 |
| [LOCAL-019](issue-019-workflow-controller.md) | 实现 WorkflowController 生命周期与恢复协调 | backend | high | LOCAL-007, LOCAL-009, LOCAL-010, LOCAL-017, LOCAL-018 | 等待依赖 |
| [LOCAL-020](issue-020-route-plan-loop.md) | 实现路由、小计划与无进展守卫 | backend | high | LOCAL-011, LOCAL-016, LOCAL-017, LOCAL-018, LOCAL-019 | 等待依赖 |
| [LOCAL-021](issue-021-web-search-adapter.md) | 实现受限 Web 搜索适配器 | backend | high | LOCAL-008, LOCAL-011 | 等待依赖 |
| [LOCAL-022](issue-022-durable-jobs-outbox.md) | 实现异步作业、租约与事务 Outbox | backend | high | LOCAL-004, LOCAL-005, LOCAL-008 | 等待依赖 |
| [LOCAL-023](issue-023-document-parser-spans.md) | 实现文档解析与可追溯分块 | backend | high | LOCAL-005, LOCAL-008, LOCAL-022 | 等待依赖 |
| [LOCAL-024](issue-024-bm25-document-search.md) | 实现 BM25 文档检索与证据返回 | backend | high | LOCAL-011, LOCAL-022, LOCAL-023 | 等待依赖 |
| [LOCAL-025](issue-025-semantic-model-versions.md) | 实现行业模型与语义定义版本存储 | backend | high | LOCAL-003, LOCAL-004, LOCAL-006 | 等待依赖 |
| [LOCAL-026](issue-026-semantic-mapping-query.md) | 实现语义映射、查询编译与本体工具 | backend | high | LOCAL-011, LOCAL-012, LOCAL-013, LOCAL-025 | 等待依赖 |
| [LOCAL-027](issue-027-entity-relation-extraction.md) | 实现实体和关系候选抽取流水线 | backend | high | LOCAL-015, LOCAL-022, LOCAL-023, LOCAL-025 | 等待依赖 |
| [LOCAL-028](issue-028-rule-candidate-extraction.md) | 实现规则候选抽取与表达校验 | backend | high | LOCAL-015, LOCAL-022, LOCAL-023, LOCAL-025, LOCAL-027 | 等待依赖 |
| [LOCAL-029](issue-029-identity-candidate-retrieval.md) | 实现实体候选召回与身份作用域 | backend | high | LOCAL-024, LOCAL-025, LOCAL-027 | 等待依赖 |
| [LOCAL-030](issue-030-identity-decisions.md) | 实现实体裁决、澄清和可撤销身份记录 | backend | high | LOCAL-004, LOCAL-022, LOCAL-025, LOCAL-027, LOCAL-029 | 等待依赖 |
| [LOCAL-031](issue-031-semantic-publication.md) | 实现语义发布事务与审核状态 API | backend | high | LOCAL-022, LOCAL-025, LOCAL-027, LOCAL-028, LOCAL-030 | 等待依赖 |
| [LOCAL-032](issue-032-rule-evaluator-supports.md) | 实现声明式规则求值与紧凑支撑 DAG | backend | high | LOCAL-025, LOCAL-031, LOCAL-048 | 等待依赖 |
| [LOCAL-033](issue-033-incremental-materialization.md) | 实现增量物化、双时态投影和失效围栏 | backend | high | LOCAL-022, LOCAL-031, LOCAL-032 | 等待依赖 |
| [LOCAL-034](issue-034-provenance-history-api.md) | 实现按需溯源、历史和受控明细接口 | backend | high | LOCAL-005, LOCAL-009, LOCAL-031, LOCAL-032, LOCAL-033 | 等待依赖 |
| [LOCAL-035](issue-035-draft-verification.md) | 实现回答草稿与组合核验服务 | backend | high | LOCAL-011, LOCAL-015, LOCAL-016, LOCAL-020, LOCAL-034 | 等待依赖 |
| [LOCAL-036](issue-036-answer-publication-gate.md) | 实现最终答案原子发布与过期检查 | backend | high | LOCAL-009, LOCAL-019, LOCAL-033, LOCAL-034, LOCAL-035 | 等待依赖 |
| [LOCAL-037](issue-037-ui-profiles-sources.md) | 实现配置工作台和数据源能力界面 | frontend | high | LOCAL-006, LOCAL-007, LOCAL-008, LOCAL-009 | 等待依赖 |
| [LOCAL-038](issue-038-ui-jobs-review.md) | 实现导入任务与候选审核界面 | frontend | high | LOCAL-022, LOCAL-023, LOCAL-027, LOCAL-028, LOCAL-029, LOCAL-030, LOCAL-031, LOCAL-037 | 等待依赖 |
| [LOCAL-039](issue-039-ui-query-workflow.md) | 实现业务问答、进度和澄清界面 | frontend | high | LOCAL-019, LOCAL-020, LOCAL-021, LOCAL-024, LOCAL-026, LOCAL-035, LOCAL-036, LOCAL-037 | 等待依赖 |
| [LOCAL-040](issue-040-ui-provenance-history.md) | 实现证据展开与历史对比界面 | frontend | high | LOCAL-034, LOCAL-036, LOCAL-039 | 等待依赖 |
| [LOCAL-041](issue-041-package-export-upgrade.md) | 实现行业包导出、成熟度与兼容升级 | backend | high | LOCAL-006, LOCAL-007, LOCAL-009, LOCAL-025, LOCAL-031 | 等待依赖 |
| [LOCAL-042](issue-042-home-energy-package.md) | 定义家庭能源行业包和两套样例映射 | backend | high | LOCAL-003, LOCAL-025, LOCAL-026 | 等待依赖 |
| [LOCAL-043](issue-043-energy-input-normalization.md) | 实现能源时序规范化与输入快照 | backend | high | LOCAL-005, LOCAL-008, LOCAL-022, LOCAL-042 | 等待依赖 |
| [LOCAL-044](issue-044-energy-simulator.md) | 实现独立能源仿真与物理约束检查 | backend | high | LOCAL-002, LOCAL-043 | 等待依赖 |
| [LOCAL-045](issue-045-energy-planner.md) | 实现有限候选策略与公平基线比较 | backend | high | LOCAL-043, LOCAL-044 | 等待依赖 |
| [LOCAL-046](issue-046-energy-compute-simulation.md) | 注册能源 Compute 操作与模拟执行服务 | backend | high | LOCAL-011, LOCAL-019, LOCAL-022, LOCAL-033, LOCAL-043, LOCAL-044, LOCAL-045 | 等待依赖 |
| [LOCAL-047](issue-047-ui-home-energy.md) | 实现家庭能源计划、对比与仿真界面 | frontend | high | LOCAL-039, LOCAL-040, LOCAL-042, LOCAL-046 | 等待依赖 |
| [LOCAL-048](issue-048-semantic-regression-fixtures.md) | 构建规格驱动的语义回归夹具 | infra | high | LOCAL-002 | 等待依赖 |
| [LOCAL-049](issue-049-composition-conformance.md) | 建立真实适配器与架构替换验收套件 | infra | high | LOCAL-014, LOCAL-017, LOCAL-018, LOCAL-026, LOCAL-041, LOCAL-046 | 等待依赖 |
| [LOCAL-050](issue-050-evaluation-load-harness.md) | 建立质量、负载与故障恢复评测工具 | infra | high | LOCAL-020, LOCAL-024, LOCAL-033, LOCAL-036, LOCAL-046, LOCAL-049 | 等待依赖 |
| [LOCAL-051](issue-051-live-model-validation.md) | 验证真实公司模型与 JEV 的接口和业务质量 | infra | medium | LOCAL-015, LOCAL-016, LOCAL-035, LOCAL-038, LOCAL-047, LOCAL-050, LOCAL-054 | 待外部资源/授权 |
| [LOCAL-052](issue-052-ha-read-integration.md) | 接入真实 Home Assistant 只读遥测 | backend | medium | LOCAL-043, LOCAL-046, LOCAL-049, LOCAL-054 | 待外部资源/授权 |
| [LOCAL-053](issue-053-live-device-actions.md) | 评审并实现受控设备执行扩展 | backend | low | LOCAL-046, LOCAL-050, LOCAL-052, LOCAL-054 | 待外部资源/授权 |
| [LOCAL-054](issue-054-end-to-end-acceptance.md) | 完成跨层端到端验收与本地交付报告 | fullstack | high | LOCAL-037, LOCAL-038, LOCAL-039, LOCAL-040, LOCAL-041, LOCAL-047, LOCAL-048, LOCAL-049, LOCAL-050 | 等待依赖 |

## 外部条件与范围

- LOCAL-051：真实公司模型与 Jev 兼容/质量验证。现有密钥不写入卡片；实际调用预算和数据范围另行明确。
- LOCAL-052：HA真实只读接入，等待设备/插件/API资料与指定环境授权。
- LOCAL-053：独立评审实机控制范围后才实现/启用，不借 data_query 绕过动作边界。
- LOCAL-054 位于文件编号最后，但在依赖上先于上述外部验证完成。本地 E2E 不等待硬件，也不冒充真实模型效果。

## 拆分与验收原则

保留两runtime、两SQL后端、local/MCP真实替换以及独立能源计算模块。前后端、抽取/裁决/发布、规则求值/物化/溯源分别拆卡；不是为赶单而把所有逻辑塞入一个 core。

优先级表示同依赖层内的先后，不允许跳过依赖。依赖完成指接口及该卡测试已通过；人工审核/模型配置/设备资源不是靠后续时间自动满足。计划变更时同步卡片、manifest 和 coverage，不篡改已完成证据。
