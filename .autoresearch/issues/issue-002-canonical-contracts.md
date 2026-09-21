---
id: LOCAL-002
number: 2
title: "定义公共 JSON Schema、端口及统一结果协议"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-001]
user_stories: [US-004, US-006, US-008, US-018]
design_tasks: [S01]
execution_mode: local-implementation
---

# LOCAL-002：定义公共 JSON Schema、端口及统一结果协议

## 目标与范围

定义 wire schemas 和生成 TS 类型，覆盖身份上下文、runtime、模型、数据、计算、工具及错误。

阶段：A 基础契约。Type：backend。Priority：high。

## 验收条件

- [ ] 固定四工具及 data_query 判别 union 有 schema；compute 只引用已注册 operation。
- [ ] GenerationPort 与 DecisionPort 分开；可信 ToolContext 不能由模型参数创建。
- [ ] 时间、十进制量、版本引用、完整性、错误、取消及证据 envelope 均有有效/无效序列化测试。

## 依赖与进入条件

Dependencies: LOCAL-001

- [LOCAL-001：建立 TypeScript 工作区与依赖边界检查](issue-001-typescript-workspace.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/contracts/`

SPEC Reference: C1–C4。
`S01` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-004、US-006、US-008、US-018；FR-5、FR-6、FR-7、FR-10、FR-21
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

schema/type 一致性检查及跨端口 round-trip 契约测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-006.A1
