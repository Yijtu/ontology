---
id: LOCAL-001
number: 1
title: "建立 TypeScript 工作区与依赖边界检查"
type: infra
priority: high
state: planned
readiness: ready
dependencies: []
user_stories: [US-001]
design_tasks: [S01]
execution_mode: local-implementation
---

# LOCAL-001：建立 TypeScript 工作区与依赖边界检查

## 目标与范围

在 `D:/work/ontology/platform/` 独立建立 TS strict、pnpm workspace、Vitest 与最小 CI，依赖仅来自本规格声明的端口与工具链。

阶段：A 基础契约。Type：infra。Priority：high。

## 验收条件

- [ ] contracts/core/application/adapters/industry-pack 的依赖规则可自动检查，禁止核心直接 import SDK、驱动或 home-energy。
- [ ] 使用正负 fixture 证明合法依赖可通过、故意穿透依赖会失败；锁定兼容的 Node/包管理器基础版本。
- [ ] 不实现业务功能；工作区和 CI 不依赖外部历史原型目录；不初始化远程仓库或自动提交。

## 依赖与进入条件

Dependencies: None

- 无前置本地 Issue。

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/package.json`
- `platform/pnpm-workspace.yaml`
- `platform/tsconfig*`
- `platform/tests/architecture/`

SPEC Reference: main §1–2。
`S01` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-001；FR-1
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

运行工作区类型检查、最小测试和依赖边界正负用例。

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
