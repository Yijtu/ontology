---
id: LOCAL-037
number: 37
title: "实现配置工作台和数据源能力界面"
type: frontend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-006, LOCAL-007, LOCAL-008, LOCAL-009]
user_stories: [US-002, US-008, US-023]
design_tasks: [S03, S10]
execution_mode: local-implementation
---

# LOCAL-037：实现配置工作台和数据源能力界面

## 目标与范围

建立 React/Vite 页面，管理可用组件、场景组合与source probe状态。

阶段：G 产品界面。Type：frontend。Priority：high。

## 验收条件

- [ ] 可选已注册行业/runtime/后端，显示必需能力缺项和显式降级，保存/激活使用版本检查。
- [ ] 密钥只允许服务端引用，不回显到HTML/事件；活跃运行版本不随UI切换改变。
- [ ] 加载、空、未配置、失败和权限不足状态明确；浏览器验证桌面与窄屏。
- [ ] 完成浏览器验证，保存关键正常/异常交互的可复现证据。

## 依赖与进入条件

Dependencies: LOCAL-006, LOCAL-007, LOCAL-008, LOCAL-009

- [LOCAL-006：实现组件注册、生命周期和版本冻结](issue-006-component-registry.md)
- [LOCAL-007：实现场景预检、版本清单与激活接口](issue-007-profile-composition.md)
- [LOCAL-008：实现数据源登记与能力探测框架](issue-008-source-bindings-probe.md)
- [LOCAL-009：实现运行记录、事件 API 与并发修订](issue-009-run-events-api.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/apps/web/`

SPEC Reference: main §3；C6；V3。
`S03`、`S10` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-002、US-008、US-023；FR-2、FR-3、FR-10、FR-31、FR-32
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T002b/T008b UI测试，使用真实API夹具，检查网络和页面无secret值。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-002.A2、US-008.A2
