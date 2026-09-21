---
id: LOCAL-010
number: 10
title: "实现共享预算、工具意图与用量账本"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-004, LOCAL-009]
user_stories: [US-006, US-018, US-019]
design_tasks: [S04]
execution_mode: local-implementation
---

# LOCAL-010：实现共享预算、工具意图与用量账本

## 目标与范围

实现所有模型、工具和重试共享的原子预算服务。

阶段：B 装配与执行基础。Type：backend。Priority：high。

## 验收条件

- [ ] 并行请求争抢最后额度时只有合法 reservation 发起；剩余 deadline 逐层传递。
- [ ] 补查和草稿修复不重置预算；超时可能计费的调用保留 usage_unknown。
- [ ] 完成/取消/失败可幂等结算；导入与在线任务预算能分开限流。

## 依赖与进入条件

Dependencies: LOCAL-004, LOCAL-009

- [LOCAL-004：实现 PostgreSQL 控制存储基础与租户隔离](issue-004-control-postgres-foundation.md)
- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/core/budget/`
- `platform/packages/adapters/control-postgres/`

SPEC Reference: D7.2；C4；C6.2。
`S04` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-006、US-018、US-019；FR-6、FR-7、FR-21、FR-22、FR-23、FR-24
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

并发、重试、未知用量和重复结算故障注入测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-019.A2
