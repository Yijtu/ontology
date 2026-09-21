---
id: LOCAL-009
number: 9
title: "实现运行记录、事件 API 与并发修订"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-002, LOCAL-004, LOCAL-007]
user_stories: [US-004, US-019, US-022, US-023]
design_tasks: [S09]
execution_mode: local-implementation
---

# LOCAL-009：实现运行记录、事件 API 与并发修订

## 目标与范围

实现 runs/run_events/steps/checkpoints Repository 与 REST/SSE 基础，不引入模型循环。

阶段：B 装配与执行基础。Type：backend。Priority：high。

## 验收条件

- [ ] 创建运行锁定 profile，Idempotency-Key 同请求复用、异请求409，If-Match 防覆盖。
- [ ] SSE seq 持久化、Last-Event-ID 补发去重，公共状态和 runtime 私有 checkpoint 分开。
- [ ] 取消/澄清/恢复记录有权限与版本检查，旧 SDK checkpoint 不兼容明确返回。

## 依赖与进入条件

Dependencies: LOCAL-002, LOCAL-004, LOCAL-007

- [LOCAL-002：定义公共 JSON Schema、端口及统一结果协议](issue-002-canonical-contracts.md)
- [LOCAL-004：实现 PostgreSQL 控制存储基础与租户隔离](issue-004-control-postgres-foundation.md)
- [LOCAL-007：实现场景预检、版本清单与激活接口](issue-007-profile-composition.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/runs/`
- `platform/apps/api/`

SPEC Reference: C2；C6；D7。
`S09` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-004、US-019、US-022、US-023；FR-3、FR-5、FR-21、FR-22、FR-23、FR-24、FR-30、FR-31、FR-32
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

C6 API 集成测试，事件重连、CAS、取消迟到基础状态用例。

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
