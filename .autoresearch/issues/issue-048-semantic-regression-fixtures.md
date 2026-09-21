---
id: LOCAL-048
number: 48
title: "构建规格驱动的语义回归夹具"
type: infra
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002]
user_stories: [US-016, US-017, US-024]
design_tasks: [S12, S16]
execution_mode: local-implementation
---

# LOCAL-048：构建规格驱动的语义回归夹具

## 目标与范围

根据当前 PRD/SPEC 独立构造事实、规则、证据、变更事件和预期结果，形成后续算法/集成测试共同使用的语义回归夹具。夹具及其预期行为全部在当前仓库可重建，不需要原型代码、数据库、旧 ID 或旧接口。

阶段：A 基础契约。Type：infra。Priority：high。

## 验收条件

- [ ] 夹具符合 LOCAL-002 的公共契约，包含明确输入、操作序列、预期有效结论、缺口/冲突和证据条件；定义来源指向当前 SPEC。
- [ ] 覆盖 AND 前提、OR 替代支撑、最后支撑撤回、未知/冲突、数值边界、部分有效区间更正与历史知识视图；预期结果经独立规则推导或人工复核。
- [ ] 夹具生成与加载可重复运行，不调用或导入历史程序，不读取外部演示库；不绑定某个实现的 proof 数量、字段布局或测试数量。
- [ ] 为 LOCAL-032/033/034/054 提供清楚的消费约定；本卡完成只代表测试输入和金标就绪，不代表算法或业务验收已经通过。

## 依赖与进入条件

Dependencies: LOCAL-002

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/tests/fixtures/semantic/`
- `platform/tests/contracts/semantic-fixtures/`

SPEC Reference: D3/D4/D5/D7/D8；V1；V3 US-016/US-017。
`S12`、`S16` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-016、US-017、US-024；FR-18、FR-19、FR-20、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

验证夹具 schema、可重复生成、金标依据和场景覆盖。将输入交给规则求值、物化和溯源实现的测试由对应实现卡完成；不以旧程序的实际输出作为金标。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-017.A1、US-017.A2
