---
id: LOCAL-018
number: 18
title: "实现 Pi Agent Core 运行时适配器"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-009, LOCAL-011, LOCAL-015, LOCAL-016]
user_stories: [US-004, US-005, US-019]
design_tasks: [S09]
execution_mode: local-implementation
---

# LOCAL-018：实现 Pi Agent Core 运行时适配器

## 目标与范围

锁定兼容的 Pi SDK 版本，将事件、工具及停止钩子适配到平台端口。

阶段：D Agent 运行时。Type：backend。Priority：high。

## 验收条件

- [ ] start/resume/cancel 转成统一 RuntimeEvent；所有 execute wrappers 经 gateway。
- [ ] SDK final/消息流只作为候选，不向业务 UI 发布；预算和 stop/cancel hooks 有测试。
- [ ] 相同场景可换 TemplateRuntime；私有 checkpoint 含 SDK/adapter版本，不兼容恢复明确失败。

## 依赖与进入条件

Dependencies: LOCAL-009, LOCAL-011, LOCAL-015, LOCAL-016

- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)
- [LOCAL-011：实现统一工具网关、本地注册与证据结果](issue-011-tool-gateway-local.md)
- [LOCAL-015：实现生成式模型端口与公司 API 适配](issue-015-generation-model-adapter.md)
- [LOCAL-016：实现 JEV 决策适配与显式降级](issue-016-jev-decision-adapter.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/adapters/runtime-pi/`

SPEC Reference: C2；main §4.2–3。
`S09` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-004、US-005、US-019；FR-5、FR-21、FR-22、FR-23、FR-24
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T004a/b、T005b，使用真实Pi包和受控生成响应，禁止付费模型调用。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-004.A1、US-004.A2、US-005.A1、US-005.A2、US-019.A1
