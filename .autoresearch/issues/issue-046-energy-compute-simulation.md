---
id: LOCAL-046
number: 46
title: "注册能源 Compute 操作与模拟执行服务"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-011, LOCAL-019, LOCAL-022, LOCAL-033, LOCAL-043, LOCAL-044, LOCAL-045]
user_stories: [US-006, US-016, US-019, US-020]
design_tasks: [S14, S15]
execution_mode: local-implementation
---

# LOCAL-046：注册能源 Compute 操作与模拟执行服务

## 目标与范围

用声明式 operation manifest 将独立计算handler绑定到data_query，并提供模拟执行job。

阶段：H 行业资产与能源。Type：backend。Priority：high。

## 验收条件

- [ ] home-energy.plan/simulate/metrics仅在profile授权绑定后可调用，通用工具服务不import能源包。
- [ ] 参数schema、只读输入ref、CPU/deadline和幂等工件约束生效，拒绝code/file/network绕过。
- [ ] 执行记录明确simulation；live驱动未配置时不发送任何设备请求；迟到任务不复活已取消run。

## 依赖与进入条件

Dependencies: LOCAL-011, LOCAL-019, LOCAL-022, LOCAL-033, LOCAL-043, LOCAL-044, LOCAL-045

- [LOCAL-011：实现统一工具网关、本地注册与证据结果](issue-011-tool-gateway-local.md)
- [LOCAL-019：实现 WorkflowController 生命周期与恢复协调](issue-019-workflow-controller.md)
- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-033：实现增量物化、双时态投影和失效围栏](issue-033-incremental-materialization.md)
- [LOCAL-043：实现能源时序规范化与输入快照](issue-043-energy-input-normalization.md)
- [LOCAL-044：实现独立能源仿真与物理约束检查](issue-044-energy-simulator.md)
- [LOCAL-045：实现有限候选策略与公平基线比较](issue-045-energy-planner.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/extensions/home-energy/`
- `platform/apps/api/`

SPEC Reference: E6–E7；C4；C6。
`S14`、`S15` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-006、US-016、US-019、US-020；FR-6、FR-7、FR-18、FR-21、FR-22、FR-23、FR-24、FR-25、FR-26
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

E10–E12、compute gateway集成及本地/MCP同契约检查。

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
