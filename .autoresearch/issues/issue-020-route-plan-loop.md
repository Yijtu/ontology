---
id: LOCAL-020
number: 20
title: "实现路由、小计划与无进展守卫"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-011, LOCAL-016, LOCAL-017, LOCAL-018, LOCAL-019]
user_stories: [US-018, US-019, US-020]
design_tasks: [S09]
execution_mode: local-implementation
---

# LOCAL-020：实现路由、小计划与无进展守卫

## 目标与范围

按固定路径或实际缺口选择模板/动态执行策略，避免重复判断链。

阶段：D Agent 运行时。Type：backend。Priority：high。

## 验收条件

- [ ] 明确路径不强制JEV；普通复杂题默认一份可执行小计划，歧义时先澄清。
- [ ] 单SQL多跳不拆成每边模型调用；只有新结果决定下一步时进入有界循环。
- [ ] 重复键包含工具、规范参数与来源版本；无新信息/预算耗尽明确停止，失败不等于无数据。

## 依赖与进入条件

Dependencies: LOCAL-011, LOCAL-016, LOCAL-017, LOCAL-018, LOCAL-019

- [LOCAL-011：实现统一工具网关、本地注册与证据结果](issue-011-tool-gateway-local.md)
- [LOCAL-016：实现 JEV 决策适配与显式降级](issue-016-jev-decision-adapter.md)
- [LOCAL-017：实现模板运行时适配器](issue-017-template-runtime.md)
- [LOCAL-018：实现 Pi Agent Core 运行时适配器](issue-018-pi-runtime.md)
- [LOCAL-019：实现 WorkflowController 生命周期与恢复协调](issue-019-workflow-controller.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/core/planning/`
- `platform/packages/application/workflow/`

SPEC Reference: D7.1–3；C2；main §4。
`S09` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-018、US-019、US-020；FR-21、FR-22、FR-23、FR-24、FR-25、FR-26
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T018a/b、T019a/b，记录工具/模型调用数以验证无冗余路径。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-018.A1、US-018.A2、US-019.A1、US-019.A2
