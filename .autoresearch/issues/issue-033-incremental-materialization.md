---
id: LOCAL-033
number: 33
title: "实现增量物化、双时态投影和失效围栏"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-022, LOCAL-031, LOCAL-032]
user_stories: [US-016, US-017]
design_tasks: [S12]
execution_mode: local-implementation
---

# LOCAL-033：实现增量物化、双时态投影和失效围栏

## 目标与范围

实现变更索引、局部投影、有效时间事件和查询fence，避免每次全量重算。

阶段：F 推理与输出。Type：backend。Priority：high。

## 验收条件

- [ ] 新增/修订/撤回/规则或身份变化/自然到期均触发受影响求值；最后支撑移除才撤出当前结论。
- [ ] 发布先设fence后异步推进，重算未完成不返回过期结论；大fan-out保守标dirty。
- [ ] 有效时间和recorded_seq独立；部分区间更正不覆盖其他时间，按需/物化结果一致。

## 依赖与进入条件

Dependencies: LOCAL-022, LOCAL-031, LOCAL-032

- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-031：实现语义发布事务与审核状态 API](issue-031-semantic-publication.md)
- [LOCAL-032：实现声明式规则求值与紧凑支撑 DAG](issue-032-rule-evaluator-supports.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/semantic-engine/projections/`
- `platform/apps/worker/`

SPEC Reference: D3；D5.1；D8。
`S12` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-016、US-017；FR-18、FR-19、FR-20
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T016b、T017a/b，未来生效、回溯纠错、队列积压和新增此前无依赖边案例。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-016.A2、US-017.A1、US-017.A2
