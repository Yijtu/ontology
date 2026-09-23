---
id: LOCAL-079
number: 79
title: "实现核验失败项回传到草稿生成（契约版本化闭环）"
type: backend
priority: high
state: planned
readiness: ready
dependencies: [LOCAL-035, LOCAL-020, LOCAL-077]
origin: nl2sql-pipeline-gap
source_finding: LOCAL-071
execution_mode: local-implementation
---

# LOCAL-079：实现核验失败项回传到草稿生成（契约版本化闭环）

## 背景

LOCAL-071 核对结论：**失败回传错误修正为部分实现**。证据：动态 runtime 内有错误回灌（`runtime-pi/src/tools.ts:65-74` → `stream.ts:241-242`），但**确定性路径**（`application/src/workflow/evidence-loop.ts:84-86`）遇到失败即停，且**核验失败项没有回传到草稿生成**（`DraftWriterRequest` 不含 `failedChecks`）。

**冲突登记**：把 `failedChecks` 加入 `DraftWriterRequest` 需要**契约版本化**（`contracts/src/workflow.ts:118`），不能静默改既有字段语义。

## 目标与范围

让核验失败项能够回传到草稿生成，形成「核验失败 → 有界修正 → 重新核验」的闭环；契约以**版本化、向后兼容**的方式扩展。

## 验收条件

- [ ] `DraftWriterRequest` 以**版本化、向后兼容**的方式承载 `failedChecks`（旧调用方不受影响；契约一致性检查通过）。
- [ ] 确定性路径（evidence-loop）也支持**有界修正**，不再遇失败即停。
- [ ] 修正**共享 run 预算**，不重置；修正轮次有**上限**（与 FR-29 一致），耗尽后发布有限事实/缺口而非未通过正文。
- [ ] 修正后**仍须重新核验**：不绕过 verifier，不因修正次数而放宽核验。
- [ ] 失败项回传内容可定位（对应哪条 claim/字段/证据），且不泄漏草稿到业务事件流。

## 技术定位

- `platform/packages/contracts/src/workflow.ts`（版本化扩展）
- `platform/packages/application/src/verification/`、`src/workflow/`（闭环接线）

## 验证与完成证据

`pnpm run verify` 全绿；契约向后兼容与一致性检查、确定性路径有界修正、预算不重置与轮次上限、修正后重新核验、无草稿泄漏；真实容器化 PostgreSQL 集成测试。

## 边界

- 不改 INV-09（只有 controller 可签发最终答案）；不放宽核验；不新增工具。
- 不得通过删除测试或放宽断言完成任务。
