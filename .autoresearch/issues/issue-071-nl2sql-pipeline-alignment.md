---
id: LOCAL-071
number: 71
title: "对齐 NL2SQL 标准流水线（改写/召回/裁剪/Schema/示例/试执行/反馈）"
type: backend
priority: medium
state: planned
readiness: waiting_dependencies
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
