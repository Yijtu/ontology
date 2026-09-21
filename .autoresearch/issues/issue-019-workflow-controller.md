---
id: LOCAL-019
number: 19
title: "实现 WorkflowController 生命周期与恢复协调"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-007, LOCAL-009, LOCAL-010, LOCAL-017, LOCAL-018]
user_stories: [US-004, US-005, US-019, US-021]
design_tasks: [S09]
execution_mode: local-implementation
---

# LOCAL-019：实现 WorkflowController 生命周期与恢复协调

## 目标与范围

协调预检、收证、草稿、核验、发布等外层阶段；领域服务以端口注入。

阶段：D Agent 运行时。Type：backend。Priority：high。

## 验收条件

- [ ] 收证阶段只由选定 runtime 拥有一个策略循环，planner/verifier不各开无界Agent。
- [ ] 澄清恢复重验权限和数据有效性，跨阶段和补查共享预算、输入清单。
- [ ] 取消终态不被迟到消息复活；答案只能在 verifier/publisher 端口通过后进入 published。

## 依赖与进入条件

Dependencies: LOCAL-007, LOCAL-009, LOCAL-010, LOCAL-017, LOCAL-018

- [LOCAL-007：实现场景预检、版本清单与激活接口](issue-007-profile-composition.md)
- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)
- [LOCAL-010：实现共享预算、工具意图与用量账本](issue-010-budget-ledger.md)
- [LOCAL-017：实现模板运行时适配器](issue-017-template-runtime.md)
- [LOCAL-018：实现 Pi Agent Core 运行时适配器](issue-018-pi-runtime.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/workflow/`

SPEC Reference: main §4；D7；C6。
`S09` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-004、US-005、US-019、US-021；FR-5、FR-21、FR-22、FR-23、FR-24、FR-27、FR-28、FR-29
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

状态转换、取消竞态、跨阶段恢复与无绕过发布测试；初期领域服务用受限stub。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-005.A2、US-006.A2、US-019.A2
