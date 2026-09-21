---
id: LOCAL-039
number: 39
title: "实现业务问答、进度和澄清界面"
type: frontend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-019, LOCAL-020, LOCAL-021, LOCAL-024, LOCAL-026, LOCAL-035, LOCAL-036, LOCAL-037]
user_stories: [US-019, US-020, US-021]
design_tasks: [S10]
execution_mode: local-implementation
---

# LOCAL-039：实现业务问答、进度和澄清界面

## 目标与范围

实现问题输入、场景范围、允许路径、执行进度、澄清恢复与最终答案。

阶段：G 产品界面。Type：frontend。Priority：high。

## 验收条件

- [ ] 用户可在场景允许范围提问/取消/补充澄清，恢复不重置预算。
- [ ] 进度和已验证数据可见；未通过草稿不作为最终答案token流泄漏。
- [ ] 正常、有限回答、缺口、冲突和工具失败均有可观察界面；浏览器验证。
- [ ] 完成浏览器验证，保存关键正常/异常交互的可复现证据。

## 依赖与进入条件

Dependencies: LOCAL-019, LOCAL-020, LOCAL-021, LOCAL-024, LOCAL-026, LOCAL-035, LOCAL-036, LOCAL-037

- [LOCAL-019：实现 WorkflowController 生命周期与恢复协调](issue-019-workflow-controller.md)
- [LOCAL-020：实现路由、小计划与无进展守卫](issue-020-route-plan-loop.md)
- [LOCAL-021：实现受限 Web 搜索适配器](issue-021-web-search-adapter.md)
- [LOCAL-024：实现 BM25 文档检索与证据返回](issue-024-bm25-document-search.md)
- [LOCAL-026：实现语义映射、查询编译与本体工具](issue-026-semantic-mapping-query.md)
- [LOCAL-035：实现回答草稿与组合核验服务](issue-035-draft-verification.md)
- [LOCAL-036：实现最终答案原子发布与过期检查](issue-036-answer-publication-gate.md)
- [LOCAL-037：实现配置工作台和数据源能力界面](issue-037-ui-profiles-sources.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/apps/web/`

SPEC Reference: C6；D7；main §4。
`S10` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-019、US-020、US-021；FR-21、FR-22、FR-23、FR-24、FR-25、FR-26、FR-27、FR-28、FR-29
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T019b/T020/T021b UI自动化，检查答案hash与服务器发布版一致。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-019.A2、US-021.A2
