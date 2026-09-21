---
id: LOCAL-047
number: 47
title: "实现家庭能源计划、对比与仿真界面"
type: frontend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-039, LOCAL-040, LOCAL-042, LOCAL-046]
user_stories: [US-021, US-022]
design_tasks: [S15]
execution_mode: local-implementation
---

# LOCAL-047：实现家庭能源计划、对比与仿真界面

## 目标与范围

提供一户家庭的能量状态、目标输入、计划曲线、基线对比和模拟执行结果。

阶段：H 行业资产与能源。Type：frontend。Priority：high。

## 验收条件

- [ ] 所有数据标来源、单位、时间和synthetic/forecast/observed；仿真收益不标实际账单节省。
- [ ] 修改备电要求或天气情景生成新计划版本，显示约束缺口与来源变化。
- [ ] 仅展示核验过的数值/计划；模拟与真实执行不可混淆，浏览器验证异常与窄屏。
- [ ] 完成浏览器验证，保存关键正常/异常交互的可复现证据。

## 依赖与进入条件

Dependencies: LOCAL-039, LOCAL-040, LOCAL-042, LOCAL-046

- [LOCAL-039：实现业务问答、进度和澄清界面](issue-039-ui-query-workflow.md)
- [LOCAL-040：实现证据展开与历史对比界面](issue-040-ui-provenance-history.md)
- [LOCAL-042：定义家庭能源行业包和两套样例映射](issue-042-home-energy-package.md)
- [LOCAL-046：注册能源 Compute 操作与模拟执行服务](issue-046-energy-compute-simulation.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/apps/web/`

SPEC Reference: E8；main §7。
`S15` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-021、US-022；FR-27、FR-28、FR-29、FR-30
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

E01–E12对应UI切片，图表与表格绑定同一结果ID/数值。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-021.A2
