---
id: LOCAL-036
number: 36
title: "实现最终答案原子发布与过期检查"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-009, LOCAL-019, LOCAL-033, LOCAL-034, LOCAL-035]
user_stories: [US-021, US-022, US-019]
design_tasks: [S10]
execution_mode: local-implementation
---

# LOCAL-036：实现最终答案原子发布与过期检查

## 目标与范围

控制器通过核验后发布同一内容版本，复核取消、权限及数据有效性。

阶段：F 推理与输出。Type：backend。Priority：high。

## 验收条件

- [ ] verification/draft/evidence hash一致且允许发布才提交Answer，不能被SDK final旁路。
- [ ] 核验后撤回依据、收回权限或取消时阻止发布；仅明确历史限定可用旧结果。
- [ ] 有限修复共享run预算，耗尽后发布有限事实/缺口而非未经通过正文；事件流不泄漏草稿。

## 依赖与进入条件

Dependencies: LOCAL-009, LOCAL-019, LOCAL-033, LOCAL-034, LOCAL-035

- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)
- [LOCAL-019：实现 WorkflowController 生命周期与恢复协调](issue-019-workflow-controller.md)
- [LOCAL-033：实现增量物化、双时态投影和失效围栏](issue-033-incremental-materialization.md)
- [LOCAL-034：实现按需溯源、历史和受控明细接口](issue-034-provenance-history-api.md)
- [LOCAL-035：实现回答草稿与组合核验服务](issue-035-draft-verification.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/answers/`

SPEC Reference: D2.1；D7.4；C6。
`S10` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-021、US-022、US-019；FR-21、FR-22、FR-23、FR-24、FR-27、FR-28、FR-29、FR-30
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T021b、T019b，发布竞态与故障注入真实控制库测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-004.A2、US-006.A2、US-021.A2
