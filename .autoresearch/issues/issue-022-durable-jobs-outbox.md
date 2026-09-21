---
id: LOCAL-022
number: 22
title: "实现异步作业、租约与事务 Outbox"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-004, LOCAL-005, LOCAL-008]
user_stories: [US-011, US-009]
design_tasks: [S02, S11]
execution_mode: local-implementation
---

# LOCAL-022：实现异步作业、租约与事务 Outbox

## 目标与范围

实现导入/发布后台job基础，阶段检查点、租约与幂等提交。

阶段：E 文档与语义。Type：backend。Priority：high。

## 验收条件

- [ ] logical job与attempt分开，幂等键包含输入和pipeline版本；同key不同payload拒绝。
- [ ] 崩溃/租约过期可重领，不重复发布；人工未决不无限重跑。
- [ ] 阶段进度和错误计数可查询，后台与在线模型配额分离。

## 依赖与进入条件

Dependencies: LOCAL-004, LOCAL-005, LOCAL-008

- [LOCAL-004：实现 PostgreSQL 控制存储基础与租户隔离](issue-004-control-postgres-foundation.md)
- [LOCAL-005：实现不可变工件与来源定位存储](issue-005-immutable-artifacts.md)
- [LOCAL-008：实现数据源登记与能力探测框架](issue-008-source-bindings-probe.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/apps/worker/`
- `platform/packages/application/jobs/`
- `platform/migrations/control/`

SPEC Reference: D6；C6。
`S02`、`S11` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-011、US-009；FR-10、FR-11、FR-13
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T011、T009b，临时PG+Worker故障注入；不调用客户数据或真实模型。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-009.A2、US-011.A1、US-011.A2
