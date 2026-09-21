---
id: LOCAL-044
number: 44
title: "实现独立能源仿真与物理约束检查"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002, LOCAL-043]
user_stories: [US-016, US-024]
design_tasks: [S14]
execution_mode: local-implementation
---

# LOCAL-044：实现独立能源仿真与物理约束检查

## 目标与范围

实现纯领域 EnergySimulatorPort，不访问网络/数据库、不调用LLM。

阶段：H 行业资产与能源。Type：backend。Priority：high。

## 验收条件

- [ ] 按规格计算储能递推、能量平衡、费用和约束；精度/容差配置可追溯。
- [ ] 违反容量、功率、效率、充放电互斥、上网或备电限制时标具体时隙错误。
- [ ] 不支持拓扑/缺关键参数返回明确状态；相同输入结果确定，绝不使用模型概率代替可行性。

## 依赖与进入条件

Dependencies: LOCAL-002, LOCAL-043

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)
- [LOCAL-043：实现能源时序规范化与输入快照](issue-043-energy-input-normalization.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/extensions/home-energy/simulation/`

SPEC Reference: E3–E5。
`S14` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-016、US-024；FR-18、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

E04–E06/E08，边界及property-based能量守恒测试。

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
