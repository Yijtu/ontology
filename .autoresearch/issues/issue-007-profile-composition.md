---
id: LOCAL-007
number: 7
title: "实现场景预检、版本清单与激活接口"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-003, LOCAL-004, LOCAL-006]
user_stories: [US-002, US-023]
design_tasks: [S03]
execution_mode: local-implementation
---

# LOCAL-007：实现场景预检、版本清单与激活接口

## 目标与范围

实现 ProfileResolver/CompositionRoot，按契约装配而非硬编码行业。

阶段：B 装配与执行基础。Type：backend。Priority：high。

## 验收条件

- [ ] 逐项检查 required capabilities，缺失能力明确返回；不能用交集悄悄丢需求。
- [ ] 精确保存 runtime/行业/映射/后端/工具/模型/策略版本与 hash，激活使用 CAS。
- [ ] 新配置不影响旧 resolved manifest；允许的降级写入清单，未实现组件保持 not_configured。

## 依赖与进入条件

Dependencies: LOCAL-003, LOCAL-004, LOCAL-006

- [LOCAL-003：定义行业包与场景配置清单](issue-003-package-profile-manifests.md)
- [LOCAL-004：实现 PostgreSQL 控制存储基础与租户隔离](issue-004-control-postgres-foundation.md)
- [LOCAL-006：实现组件注册、生命周期和版本冻结](issue-006-component-registry.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/profiles/`
- `platform/apps/api/composition/`

SPEC Reference: C1；C6；main §2–3。
`S03` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-002、US-023；FR-2、FR-3、FR-31、FR-32
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T002a、X07/X08 的后端测试，包含升级与不兼容场景。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-002.A1、US-023.A1
