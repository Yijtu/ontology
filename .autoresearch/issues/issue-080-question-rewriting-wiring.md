---
id: LOCAL-080
number: 80
title: "把问题改写接入运行路径并持久化改写 trace"
type: backend
priority: high
state: done
readiness: done
dependencies: [LOCAL-074]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
github_issue: 164
execution_mode: local-implementation
---

# LOCAL-080：把问题改写接入运行路径并持久化改写 trace

## 问题

LOCAL-074 交付了 `BoundedQuestionRewriter` 与 `RunPlanner` 中的改写步骤，但它仍是**库组件**：未接入 `WorkflowController`/装配根，且 `QuestionRewrite` trace **未持久化到 durable run record**（需要生成 schema 字段/迁移）。因此 LOCAL-074 的验收项「原问题 → 改写 → 生成 SQL 的链路可回放（改写版本与输入引用进入运行记录）」尚未端到端成立。

## 验收条件

- [ ] `WorkflowController`/装配根实际调用改写步骤（不再只是 `RunPlanner` 的库内能力）。
- [ ] `QuestionRewrite` trace（改写版本 + 输入引用）**持久化到运行记录**，可按 run 回读并回放「原问题 → 改写 → 生成 SQL」链路。
- [ ] 端到端测试：真实 PostgreSQL，覆盖正常改写、歧义→澄清、改写失败；断言 trace 可从运行记录回读。
- [ ] 不改 C4 工具目录、不放宽 SQL 校验、不新增工具。
- [ ] 不削弱既有断言。

## 技术定位

- `platform/packages/application/src/workflow/`
- `platform/apps/api/src/composition/`
- `platform/packages/contracts/`（trace 字段，仅在确有缺口时；如需迁移用 `051`）

## 验证与完成证据

`pnpm run verify` 全绿；真实容器化 PostgreSQL 的端到端回放测试；CI 通过。

## 边界

- 只做装配与 trace 持久化，不改改写语义、不新增工具。
- 不得通过删除测试或放宽断言完成任务。
