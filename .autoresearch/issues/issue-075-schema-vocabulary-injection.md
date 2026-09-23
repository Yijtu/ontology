---
id: LOCAL-075
number: 75
title: "实现语义 mapping 候选召回与 Schema/词表注入"
type: backend
priority: high
state: planned
readiness: ready
dependencies: [LOCAL-026, LOCAL-025, LOCAL-020]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
execution_mode: local-implementation
---

# LOCAL-075：实现语义 mapping 候选召回与 Schema/词表注入

## 背景

LOCAL-071 核对结论：**Schema 构造环节缺失**。证据：`application/src/workflow/planning.ts:176-190` 使用固定 prompt；`model-company/src/http-client.ts:118-136` 允许宽松空 schema。当前没有把「已确认 mapping 的概念/字段/单位」构造成受控词表注入生成请求。

## 目标与范围

由 `semantic-engine` **仅从已确认 mapping 与已发布定义**生成概念/字段/单位/关系词表，注入 SQL 生成的 prompt。词表是**数据**，不是工具、不构成权限提升。

## 验收条件

- [ ] 词表只来自**已确认 mapping + 已发布定义**；未确认/未发布的映射不得进入词表。
- [ ] 做**字段裁剪**：只注入与本次问题相关的概念/字段（有界，超限显式标记截断），不做全库注入。
- [ ] 不硬编码客户表名/物理列名到核心；物理标识符仍由 mapping 拥有（C3 规则不变）。
- [ ] 注入内容为**不可信数据**：不得改变权限、工具目录或预算；提示注入无法提升权限。
- [ ] mapping 缺失或为空时**显式降级/报缺口**，不得退化为「宽松空 schema」后静默生成 SQL。
- [ ] 注入的词表版本可追溯（进入运行记录/证据引用）。

## 技术定位

- `platform/packages/semantic-engine/src/mapping/`（词表生成与裁剪）
- `platform/packages/application/src/workflow/`（注入装配）
- `platform/packages/contracts/src/`（仅在确有缺口时）

## 验证与完成证据

`pnpm run verify` 全绿；词表来源与裁剪的有界性、注入不可指令化、空 mapping 显式降级；真实容器化 PostgreSQL 集成测试（两套 mapping 得到同口径词表）。

## 边界

- 不改 C3 的 mapping-owned 标识符规则；不新增工具；不放宽 SQL 校验。
- 不得通过删除测试或放宽断言完成任务。
