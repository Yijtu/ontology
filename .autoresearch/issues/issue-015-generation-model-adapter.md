---
id: LOCAL-015
number: 15
title: "实现生成式模型端口与公司 API 适配"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002, LOCAL-009, LOCAL-010]
user_stories: [US-004, US-012, US-018, US-021]
design_tasks: [S08]
execution_mode: local-implementation
---

# LOCAL-015：实现生成式模型端口与公司 API 适配

## 目标与范围

实现 GenerationPort、确定响应测试适配器和可配置公司 API 客户端；本卡不调用付费/真实模型。

阶段：D Agent 运行时。Type：backend。Priority：high。

## 验收条件

- [ ] 流式文本、tool-call、结构化候选、usage和错误统一输出；端口不自行执行工具。
- [ ] timeout/retry/cancel 接入全局预算，凭据由 server secretRef 注入并脱敏。
- [ ] 确定响应 fixture 可复现正常、坏JSON、断流及部分usage，供应商类型不泄漏到core。

## 依赖与进入条件

Dependencies: LOCAL-002, LOCAL-009, LOCAL-010

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)
- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)
- [LOCAL-010：实现共享预算、工具意图与用量账本](issue-010-budget-ledger.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/adapters/model-company/`

SPEC Reference: C2；D4；D7。
`S08` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-004、US-012、US-018、US-021；FR-5、FR-14、FR-21、FR-27、FR-28、FR-29
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

mock HTTP/受控流契约测试；真实 API 验证仅由条件卡执行。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

架构/基础设施支撑卡；与同故事的验收承接卡共同交付。
