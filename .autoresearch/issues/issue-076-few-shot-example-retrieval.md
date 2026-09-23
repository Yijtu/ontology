---
id: LOCAL-076
number: 76
title: "实现 Few-shot 示例检索"
type: backend
priority: medium
state: planned
readiness: ready
dependencies: [LOCAL-024, LOCAL-042, LOCAL-020]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
execution_mode: local-implementation
---

# LOCAL-076：实现 Few-shot 示例检索

## 背景

LOCAL-071 核对结论：**Few-shot 示例检索缺失**（grep `few.?shot` 零命中）。当前生成 SQL 时没有示例注入。

## 目标与范围

从**行业包示例集 + 已发布查询模板**中检索少量示例（问题 → 期望查询形态）注入生成 prompt，提高生成质量。复用既有 `DocumentSearchPort`（BM25）能力，不新增工具。

## 验收条件

- [ ] 示例来源可追溯且**版本化**（来自行业包示例集 / 已发布查询模板，带版本引用）。
- [ ] 检索**有界**：top-k 上限 + 显式截断标记（沿用 `ToolResult.coverage` 语义，top-k 未命中不等于不存在）。
- [ ] 示例作为**不可信数据**注入：不能指令化、不影响权限/工具目录/预算。
- [ ] 示例集缺失时**显式 not_configured**，不得编造示例。
- [ ] 示例不得绕过既有 SQL 校验与 mapping 规则（示例只是提示，不是可执行模板白名单）。

## 技术定位

- `platform/packages/adapters/search-bm25/`（复用检索能力）
- `platform/packages/application/src/workflow/`（注入装配）
- `platform/industry-packs/*/`（示例集声明）

## 验证与完成证据

`pnpm run verify` 全绿；检索有界性/截断标记、来源版本化、注入不可指令化、缺示例显式降级；真实容器化 PostgreSQL + 真实 BM25 索引的集成测试。

## 边界

- 不新增工具、不改 C4 工具目录、不放宽 SQL 校验。
- 不得通过删除测试或放宽断言完成任务。
