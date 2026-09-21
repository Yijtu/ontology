---
id: LOCAL-053
number: 53
title: "评审并实现受控设备执行扩展"
type: backend
priority: low
state: planned
readiness: needs_external_input
dependencies: [LOCAL-046, LOCAL-050, LOCAL-052, LOCAL-054]
user_stories: [US-019, US-021]
design_tasks: [S18]
execution_mode: future-live-actions
---

# LOCAL-053：评审并实现受控设备执行扩展

## 目标与范围

仅在独立评审 live 范围后实现 DeviceActionPort，不混入只读数据工具。

阶段：J 外部条件任务。Type：backend。Priority：low。

## 验收条件

- [ ] 动作授权绑定plan hash、设备范围、状态版本和期限；执行前重验状态，不支持模式拒绝。
- [ ] sent/accepted/observed_applied分开；超时不盲目重发，支持的停止/回读策略以设备规格为准。
- [ ] 真实动作入口有独立权限和确认，不允许LLM任意HA service pass-through；未满足资源条件保持禁用。

## 依赖与进入条件

Dependencies: LOCAL-046, LOCAL-050, LOCAL-052, LOCAL-054

- [LOCAL-046：注册能源 Compute 操作与模拟执行服务](issue-046-energy-compute-simulation.md)
- [LOCAL-050：建立质量、负载与故障恢复评测工具](issue-050-evaluation-load-harness.md)
- [LOCAL-052：接入真实 Home Assistant 只读遥测](issue-052-ha-read-integration.md)
- [LOCAL-054：完成跨层端到端验收与本地交付报告](issue-054-end-to-end-acceptance.md)

- LOCAL-052 的只读接口与设备能力验证完成。
- 用户另行确认真实控制范围、设备、参数边界、停止策略及测试时段；活动规则不替代授权。

本卡为条件任务，默认不进入本地自动执行批次。缺少上述资源/授权时保留明确阻塞，不通过假响应标成真实完成。

## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/adapters/actions-ha/`

SPEC Reference: E7；main ADR-12。
`S18` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-019、US-021；FR-21、FR-22、FR-23、FR-24、FR-27、FR-28、FR-29
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

先执行控制器/驱动合约和模拟故障测试；实机动作只在另行明确的测试范围内进行。

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
