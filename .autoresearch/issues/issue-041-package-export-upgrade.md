---
id: LOCAL-041
number: 41
title: "实现行业包导出、成熟度与兼容升级"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-006, LOCAL-007, LOCAL-009, LOCAL-025, LOCAL-031]
user_stories: [US-003, US-023]
design_tasks: [S03, S13, S16]
execution_mode: local-implementation
---

# LOCAL-041：实现行业包导出、成熟度与兼容升级

## 目标与范围

实现可移植行业声明/测试/模板资产导出以及组合升级约束。

阶段：H 行业资产与能源。Type：backend。Priority：high。

## 验收条件

- [ ] 导出含定义、身份策略、映射模板、标准出处与测试，排除客户数据、裁决和凭据。
- [ ] 核心包版本升级仅影响新profile/run；活跃引用版本不能卸载，无法恢复有明确原因。
- [ ] 其他行业准备材料标defined/experimental，不把声明当validated；可在第二来源结构使用。

## 依赖与进入条件

Dependencies: LOCAL-006, LOCAL-007, LOCAL-009, LOCAL-025, LOCAL-031

- [LOCAL-006：实现组件注册、生命周期和版本冻结](issue-006-component-registry.md)
- [LOCAL-007：实现场景预检、版本清单与激活接口](issue-007-profile-composition.md)
- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)
- [LOCAL-025：实现行业模型与语义定义版本存储](issue-025-semantic-model-versions.md)
- [LOCAL-031：实现语义发布事务与审核状态 API](issue-031-semantic-publication.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/packages/`

SPEC Reference: C1；D8；V2 X07。
`S03`、`S13`、`S16` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-003、US-023；FR-3、FR-4、FR-31、FR-32
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T023a/b、T003b、X07/X08版本生命周期和无敏感数据导出检查。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-003.A2、US-023.A1、US-023.A2
