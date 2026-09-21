---
id: LOCAL-011
number: 11
title: "实现统一工具网关、本地注册与证据结果"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002, LOCAL-005, LOCAL-006, LOCAL-007, LOCAL-009, LOCAL-010]
user_stories: [US-006, US-020, US-021]
design_tasks: [S04]
execution_mode: local-implementation
---

# LOCAL-011：实现统一工具网关、本地注册与证据结果

## 目标与范围

实现四工具 registry/local transport，权限、验参、预算与证据归档共用路径。

阶段：B 装配与执行基础。Type：backend。Priority：high。

## 验收条件

- [ ] 仅已启用四工具可调用；final_answer/verify_result 由平台控制，不在自由工具目录。
- [ ] 每次执行先记录 intent/预算，结果和 evidence 成功归档后才返回可追溯成功。
- [ ] ToolResult 区分 error/empty/partial，输入身份、未知 compute operation 和恶意参数被拒绝。

## 依赖与进入条件

Dependencies: LOCAL-002, LOCAL-005, LOCAL-006, LOCAL-007, LOCAL-009, LOCAL-010

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)
- [LOCAL-005：实现不可变工件与来源定位存储](issue-005-immutable-artifacts.md)
- [LOCAL-006：实现组件注册、生命周期和版本冻结](issue-006-component-registry.md)
- [LOCAL-007：实现场景预检、版本清单与激活接口](issue-007-profile-composition.md)
- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)
- [LOCAL-010：实现共享预算、工具意图与用量账本](issue-010-budget-ledger.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/tool-services/`
- `platform/packages/adapters/transport-local/`

SPEC Reference: C4–C5；D7。
`S04` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-006、US-020、US-021；FR-6、FR-7、FR-25、FR-26、FR-27、FR-28、FR-29
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T006、T020b 网关部分，证据写入失败和目录绕过负例。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-001.A2、US-004.A2、US-006.A1、US-006.A2、US-020.A2
