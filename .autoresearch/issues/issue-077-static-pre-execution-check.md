---
id: LOCAL-077
number: 77
title: "实现静态试执行预检（dry-run）"
type: backend
priority: high
state: planned
readiness: ready
dependencies: [LOCAL-011, LOCAL-012, LOCAL-013, LOCAL-026]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
execution_mode: local-implementation
---

# LOCAL-077：实现静态试执行预检（dry-run）

## 背景

LOCAL-071 核对结论：**试执行环节缺失**，且 `data_query` handler 当前**跳过了** `StructuredQueryPort.validate`（grep `EXPLAIN` 仅命中 `sql-validator.ts:124` 的注释/拒绝逻辑）。

**冲突登记**：教科书的 dry-run 常用 `EXPLAIN`，但本项目 SQL 子集仅允许单条只读 SELECT/受控 CTE，且 DuckDB 沙箱禁用 `DESCRIBE`/`SHOW`；引入 `EXPLAIN` 会与只读子集冲突。因此试执行必须实现为**静态/AST 预检**。

## 目标与范围

在真正执行前插入**静态预检**：复用现有 `StructuredQueryPort.validate`（AST + 可访问对象白名单 + 参数绑定），**不使用 `EXPLAIN`**。

## 验收条件

- [ ] 生成的 SQL 在真正执行前必经 `validate`；handler 不再跳过预检。
- [ ] **不得使用 `EXPLAIN`/`DESCRIBE`/`SHOW`**（与只读子集及 DuckDB 沙箱冲突）。
- [ ] 预检失败返回**可定位**的原因（哪条规则、哪个对象/参数），供后续修正闭环使用。
- [ ] 预检不产生数据读取；预算上按「意图 + 预检」计，不按执行计（不虚耗执行额度）。
- [ ] 预检通过后才进入执行；预检与执行使用同一只读角色与参数绑定路径。

## 技术定位

- `platform/packages/tool-services/src/handlers/data-query.ts`（插入预检）
- `platform/packages/adapters/data-postgres/`、`data-duckdb/`（复用既有 validate）
- `platform/packages/contracts/src/`（仅在确有缺口时）

## 验证与完成证据

`pnpm run verify` 全绿；预检必过的路径证明、拒绝 `EXPLAIN` 的负例、失败原因可定位、预算计量；真实容器化 PostgreSQL + 真实 DuckDB 引擎的集成测试。

## 边界

- 不放宽 FR-26 / C3 的 SQL 校验；不改只读角色；不新增工具。
- 不得通过删除测试或放宽断言完成任务。
