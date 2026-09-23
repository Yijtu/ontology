---
id: LOCAL-071
number: 71
title: "对齐 NL2SQL 标准流水线（改写/召回/裁剪/Schema/示例/试执行/反馈）"
type: backend
priority: medium
state: done
readiness: done
dependencies: [LOCAL-054]
user_stories: [US-020]
design_tasks: []
execution_mode: post-delivery-verification
origin: user-requested
---

# LOCAL-071：对齐 NL2SQL 标准流水线

## 目标与范围

主体开发（LOCAL-054 端到端验收）完成后，逐项核对下列**标准 Text-to-SQL 流水线**在本项目中的覆盖情况，指出已实现、部分实现与缺失的环节，并对缺失项给出补齐建议或拆成独立卡。本卡是核对与差距登记卡，不改变现有契约边界。

标准流水线（用户口径）：

```text
P 用户问题
  → 问题改写
  → 表召回 + 字段裁剪
  → Schema 构造
  → Few-shot 示例检索
  → LLM 生成 SQL
  → 语法 / Schema / 权限 / 安全校验
  → 试执行
  → 失败则回传错误修正
  → 执行并返回结果
  → 收集反馈
```

## 当前规格覆盖（截至创建时的静态核对）

已有（SPEC / PRD 明确）：

- LLM 通过生成端口产出 SQL 候选（direct Text2SQL，`data_query` direct 模式）。
- 语义辅助 Text2SQL：semantic mapping → query compilation（`LOCAL-026`）。
- SQL 校验：AST、可访问对象白名单、参数绑定、独立只读数据库角色（`FR-26`、contracts-api）。
- 执行并返回结果 + SourceSnapshot / 证据（`LOCAL-011`/`LOCAL-012`/`LOCAL-013`）。
- 失败路径与有限修复（`FR-29` bounded repair）。

规格未提及（需在验收时确认是否缺失）：

- 问题改写（question rewriting）
- 表召回 + 字段裁剪（table recall + column pruning）
- Schema 构造（动态 schema 注入）
- Few-shot 示例检索（example retrieval）
- 试执行 / dry-run（EXPLAIN 或等价预检）
- 失败回传错误后由模型修正的闭环
- 反馈收集（用户/执行反馈回流）

## 验收条件

- [ ] 按上表逐项给出「已实现 / 部分 / 缺失」结论，并指向具体代码或规格位置；不得凭接口存在就判为已实现。
- [ ] 缺失项逐条给出最小补齐建议（落在哪个包/端口），不擅自扩大 core 边界或新增动态工具。
- [ ] 若某环节与现有 SPEC 冲突（例如新增动态工具、放宽 SQL 校验），明确记录冲突点，不静默改变验收口径。
- [ ] 结论写入交付报告或本卡记录，并同步 INDEX/manifest 状态。

## 依赖与进入条件

Dependencies: LOCAL-054

- [LOCAL-054：完成跨层端到端验收与本地交付报告](issue-054-end-to-end-acceptance.md)

- 主体流水线（问答、查询编译、SQL 校验、执行、证据）已交付并通过 E2E。
- 用户明确要求开始本轮核对。

本卡为交付后核对卡，默认不进入当前自动执行批次。

## 技术定位

拟核对位置（后续实现路径，本轮未创建）：

- `platform/packages/application/`（查询规划与执行编排）
- `platform/packages/semantic-engine/`（语义映射 / 查询编译）
- `platform/packages/adapters/data-*/`（SQL 执行与方言）
- `platform/packages/contracts/`（SQL 校验、证据契约）

SPEC Reference: C4/C5、D7；FR-25、FR-26、FR-29。
`S-ID` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-020；FR-25、FR-26
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

- 核对以当前代码与验收证据为准，文档中的历史描述不代表实时进度。
- 结论保留具体位置引用（文件/函数/规格章节），缺失项给出可执行的下一步。
- 不通过删除或放宽校验来"补齐"环节。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库。
- 默认只读数据工具，不新增动态工具或任意代码执行入口。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作。
- 不因本卡存在而让其他卡片自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-020（direct 与语义辅助 Text2SQL 路径）；FR-25、FR-26、FR-29。

## 核对结论（LOCAL-071 执行记录）

只读审计已完成，基线 `main` @ `32fc8b1`。完整报告（含逐项 `file:line` 证据、补齐建议、SPEC 冲突点、未验证项与复现命令）：[`platform/docs/local-071-nl2sql-pipeline-alignment.md`](../../platform/docs/local-071-nl2sql-pipeline-alignment.md)。

10 环节结论：

| # | 环节 | 结论 |
|---|---|---|
| P | 用户问题 | 已实现 |
| 1 | 问题改写 | 缺失 |
| 2 | 表召回 + 字段裁剪 | 部分实现（形态不同：确认 mapping 解析 + 投影级裁剪，无按问题检索） |
| 3 | Schema 构造（动态注入） | 缺失 |
| 4 | Few-shot 示例检索 | 缺失 |
| 5 | LLM 生成 SQL | 部分实现（模型产出语义计划，平台编译成 SQL；无 SQL 专用 prompt/示例/schema） |
| 6 | 语法 / Schema / 权限 / 安全校验 | 已实现（AST + 白名单 + 参数绑定 + 只读角色；FR-26/C3） |
| 7 | 试执行（dry-run/EXPLAIN） | 缺失（且 `explain` 被只读子集禁止，属 SPEC 冲突点） |
| 8 | 失败回传错误修正 | 部分实现（动态 runtime 内回灌；确定性路径遇错即停；核验修复有界但未回传失败项） |
| 9 | 执行并返回结果 | 已实现（快照 + 证据闭环） |
| 10 | 收集反馈 | 缺失 |

主要缺口最小补齐建议（不扩大 core、不新增动态工具、不放宽校验）：问题改写归 `application/workflow/planning.ts`（复用注入的 `GenerationPort`）；召回/裁剪与 Schema 构造归 `semantic-engine`（只从确认 mapping 生成候选 ID 词表并注入 prompt）；few-shot 复用 `search-bm25`；试执行仅前置现有 `StructuredQueryPort.validate`，**不得**引入 EXPLAIN；反馈收集经 `ControlRepository`/`control-postgres` append-only 记录。

SPEC 冲突点：EXPLAIN 试执行 vs 只读子集（`sql-validator.ts:124`）；新增召回/Schema 工具 vs 固定四工具（C4/FR-7）；模型选择标识符 vs C3 mapping-owned；放宽 SQL 校验 vs FR-26；失败项回传草稿模型需契约版本化（`DraftWriterRequest`）；反馈影响发布/权限 vs INV-09。

验证：`pnpm run lint` 通过；`pnpm run typecheck` 通过；`pnpm run test` 通过（157 files / 1618 tests）。本卡仅 docs-only 变更。

未验证：真实模型质量/改写收益/few-shot 收益（无授权端点，CI 用替身）；HA/实机（LOCAL-052/053）；EXPLAIN 真实后端可行性（不存在且不应引入）。
