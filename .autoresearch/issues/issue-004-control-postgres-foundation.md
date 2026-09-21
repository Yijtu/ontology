---
id: LOCAL-004
number: 4
title: "实现 PostgreSQL 控制存储基础与租户隔离"
type: infra
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002]
user_stories: [US-001, US-008, US-011, US-023]
design_tasks: [S02]
execution_mode: local-implementation
---

# LOCAL-004：实现 PostgreSQL 控制存储基础与租户隔离

## 目标与范围

建立控制 schema 迁移、事务 Repository、可信 principal 注入与本地隔离测试数据库配置。

阶段：A 基础契约。Type：infra。Priority：high。

## 验收条件

- [ ] 复合键/FK 包含 tenant/space；非 owner 应用角色及 RLS 配置通过跨租户负例。
- [ ] 连接池身份事务后清理，不能复用上个请求 scope；local-dev 主体仅 loopback 模式可用。
- [ ] 数据库初始化/版本演进与服务启动分开；后续模块可添加 migration，不包含历史原型导入或兼容结构；不访问客户生产库。

## 依赖与进入条件

Dependencies: LOCAL-002

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/migrations/control/`
- `platform/packages/adapters/control-postgres/`

SPEC Reference: D1–D2；D8；C6。
`S02` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-001、US-008、US-011、US-023；FR-1、FR-3、FR-10、FR-13、FR-31、FR-32
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

临时 PostgreSQL 上运行迁移、事务回滚、RLS 和池连接复用集成测试。

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
