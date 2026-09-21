---
id: LOCAL-031
number: 31
title: "实现语义发布事务与审核状态 API"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-022, LOCAL-025, LOCAL-027, LOCAL-028, LOCAL-030]
user_stories: [US-015, US-011, US-012]
design_tasks: [S11]
execution_mode: local-implementation
---

# LOCAL-031：实现语义发布事务与审核状态 API

## 目标与范围

把已批准候选转换为版本化事实/规则，并原子发出更新事件。

阶段：E 文档与语义。Type：backend。Priority：high。

## 验收条件

- [ ] 候选状态与正式读视图分离；未通过策略的数据不能进入计算。
- [ ] 发布事实、身份约束检查、规则版本与outbox同事务提交，重试不重复。
- [ ] 坏来源、冲突和未批准项返回具体原因，审核/拒绝/修订接口可回读。

## 依赖与进入条件

Dependencies: LOCAL-022, LOCAL-025, LOCAL-027, LOCAL-028, LOCAL-030

- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-025：实现行业模型与语义定义版本存储](issue-025-semantic-model-versions.md)
- [LOCAL-027：实现实体和关系候选抽取流水线](issue-027-entity-relation-extraction.md)
- [LOCAL-028：实现规则候选抽取与表达校验](issue-028-rule-candidate-extraction.md)
- [LOCAL-030：实现实体裁决、澄清和可撤销身份记录](issue-030-identity-decisions.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/semantic-publications/`

SPEC Reference: D4–D6；C6。
`S11` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-015、US-011、US-012；FR-13、FR-14
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T015a/b后端、发布后Worker崩溃重试、来源缺失与权限负例。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-012.A2、US-015.A1、US-015.A2
