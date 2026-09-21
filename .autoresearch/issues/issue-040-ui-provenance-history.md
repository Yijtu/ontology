---
id: LOCAL-040
number: 40
title: "实现证据展开与历史对比界面"
type: frontend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-034, LOCAL-036, LOCAL-039]
user_stories: [US-017, US-022]
design_tasks: [S10, S15]
execution_mode: local-implementation
---

# LOCAL-040：实现证据展开与历史对比界面

## 目标与范围

在答案和事实界面按需展示来源、推导依据和历史版本。

阶段：G 产品界面。Type：frontend。Priority：high。

## 验收条件

- [ ] 从结论展开实际依据、SQL/规则/文档定位，不展示伪造模型思维链。
- [ ] 大图按需分页，当前/历史与截断状态显式；权限失败不显示原文或其他租户对象。
- [ ] 版本变化后清除旧比较结果，历史仍可回看，浏览器验证。
- [ ] 完成浏览器验证，保存关键正常/异常交互的可复现证据。

## 依赖与进入条件

Dependencies: LOCAL-034, LOCAL-036, LOCAL-039

- [LOCAL-034：实现按需溯源、历史和受控明细接口](issue-034-provenance-history-api.md)
- [LOCAL-036：实现最终答案原子发布与过期检查](issue-036-answer-publication-gate.md)
- [LOCAL-039：实现业务问答、进度和澄清界面](issue-039-ui-query-workflow.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/apps/web/`

SPEC Reference: C6；D3；D7.4。
`S10`、`S15` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-017、US-022；FR-19、FR-20、FR-30
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T022与T017 UI，包含替代依据、全部依据撤回和图分页。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-017.A2、US-022.A1、US-022.A2
