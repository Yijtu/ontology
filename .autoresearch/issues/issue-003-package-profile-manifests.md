---
id: LOCAL-003
number: 3
title: "定义行业包与场景配置清单"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002]
user_stories: [US-001, US-002, US-003, US-023]
design_tasks: [S01, S03]
execution_mode: local-implementation
---

# LOCAL-003：定义行业包与场景配置清单

## 目标与范围

定义 IndustryManifest/ProfileSpec/ResolvedProfile 与核心、客户扩展、物理映射层次。

阶段：A 基础契约。Type：backend。Priority：high。

## 验收条件

- [ ] 行业包不包含 SDK、物理连接凭据、客户实例或可执行脚本；所需能力与版本可验证。
- [ ] profile 可同时绑定 SQL、文档、模型、runtime 和 compute，配置只保存引用。
- [ ] 模型版本、成熟度、兼容范围、标准出处与企业扩展隔离都有负例检查。

## 依赖与进入条件

Dependencies: LOCAL-002

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/contracts/`
- `platform/deployment-profiles/`

SPEC Reference: C1；main §2；E2。
`S01`、`S03` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-001、US-002、US-003、US-023；FR-1、FR-2、FR-3、FR-4、FR-31、FR-32
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

对有效配置、缺字段、私有数据混入和不兼容范围执行 schema 测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-001.A1
