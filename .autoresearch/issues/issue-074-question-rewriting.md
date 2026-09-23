---
id: LOCAL-074
number: 74
title: "实现问题改写前置步"
type: backend
priority: high
state: planned
readiness: ready
dependencies: [LOCAL-020, LOCAL-015]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
execution_mode: local-implementation
---

# LOCAL-074：实现问题改写前置步

## 背景

LOCAL-071 的 NL2SQL 流水线核对结论：**问题改写环节缺失**（全库 grep `rewrit`/`reformulat` 零命中）。当前用户问题直接进入规划与 SQL 生成，没有消歧/补全口径的前置步骤。

## 目标与范围

在生成 SQL 之前增加一个**受控的改写步骤**：消歧、补全上下文、明确口径与范围，输出结构化改写结果，作为后续 schema/词表构造与 SQL 生成的输入。复用注入的 `GenerationPort`，**不新增工具**。

## 验收条件

- [ ] 改写是 `application/workflow` 内的一个显式、有界步骤（复用注入的 `GenerationPort`），不新增模型端口、不新增公共工具。
- [ ] 歧义或口径不足时**先澄清**（走既有 `clarification_requested` 路径），不猜测填值。
- [ ] 改写结果可追溯：原问题 → 改写 → 生成 SQL 的链路可回放（改写版本与输入引用进入运行记录）。
- [ ] 改写与后续阶段**共享同一 run 预算**，重试/补查不重置预算。
- [ ] 改写失败或模型不可用时有明确状态，不伪装成功、不静默降级为「原问题直通」而不记录。
- [ ] 不引入「自由文本直接进 SQL」的路径：改写输出仍须经既有 SQL 校验与 mapping 规则。

## 技术定位

- `platform/packages/application/src/workflow/`（规划前置步）
- `platform/packages/contracts/src/`（仅在确有缺口时）

## 验证与完成证据

`pnpm run verify` 全绿；受控 `GenerationPort` 替身覆盖：正常改写、歧义→澄清、改写失败、预算不重置、链路可回放；真实容器化 PostgreSQL 的集成测试。

## 边界

- 遵守 SPEC 端口与依赖方向；不新增动态工具、不改 C4 工具目录、不放宽 SQL 校验。
- 不得通过删除测试或放宽断言完成任务。
