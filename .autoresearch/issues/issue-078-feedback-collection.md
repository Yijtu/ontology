---
id: LOCAL-078
number: 78
title: "实现反馈收集（append-only）"
type: backend
priority: medium
state: planned
readiness: ready
dependencies: [LOCAL-009, LOCAL-022, LOCAL-004]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
execution_mode: local-implementation
---

# LOCAL-078：实现反馈收集（append-only）

## 背景

LOCAL-071 核对结论：**反馈收集环节缺失**（grep `feedback` 零命中）。当前没有用户/执行反馈的回流通道。

## 目标与范围

收集用户与执行反馈（答案是否有用、SQL 是否正确、缺口/冲突），经控制存储 **append-only** 记录，保持 tenant/space 隔离。

## 验收条件

- [ ] 反馈经 `ControlRepository` **append-only** 记录（可回读，不可改写历史）。
- [ ] 反馈**不影响权限或发布**（INV-09：只有 controller 可签发最终答案；反馈不得成为提权或发布旁路）。
- [ ] tenant/space 隔离，RLS 生效；跨租户不可见。
- [ ] 反馈仅作**数据**：若要进入模型上下文，必须显式标注为不可信数据，且不得改变工具目录/权限/预算。
- [ ] 接口可回读（按 run/答案维度查询）。

## 技术定位

- `platform/packages/application/`（反馈服务）
- `platform/packages/adapters/control-postgres/`（append-only 存储）
- `platform/apps/api/src/http/`（反馈接口）

## 验证与完成证据

`pnpm run verify` 全绿；append-only 与不可改写、租户隔离（真实 RLS）、反馈不触发发布/提权的负例；真实容器化 PostgreSQL 集成测试。

## 边界

- 不改发布/权限语义；不新增工具。
- 不得通过删除测试或放宽断言完成任务。
