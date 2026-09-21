---
id: LOCAL-038
number: 38
title: "实现导入任务与候选审核界面"
type: frontend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-022, LOCAL-023, LOCAL-027, LOCAL-028, LOCAL-029, LOCAL-030, LOCAL-031, LOCAL-037]
user_stories: [US-010, US-011, US-014, US-015]
design_tasks: [S11]
execution_mode: local-implementation
---

# LOCAL-038：实现导入任务与候选审核界面

## 目标与范围

提供任务阶段进度、原文对照、身份裁决和事实/规则审核的最小UI。

阶段：G 产品界面。Type：frontend。Priority：high。

## 验收条件

- [ ] 任务阶段、部分失败与重试真实可见，不把已处理数量当已发布数量。
- [ ] 候选可对照原文匹配/新建待确认/拒绝/澄清/批准，冲突和并发版本变化可理解。
- [ ] 修订后可查看之前依据；原文打开、缺来源、错误状态均经浏览器验证。
- [ ] 完成浏览器验证，保存关键正常/异常交互的可复现证据。

## 依赖与进入条件

Dependencies: LOCAL-022, LOCAL-023, LOCAL-027, LOCAL-028, LOCAL-029, LOCAL-030, LOCAL-031, LOCAL-037

- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-023：实现文档解析与可追溯分块](issue-023-document-parser-spans.md)
- [LOCAL-027：实现实体和关系候选抽取流水线](issue-027-entity-relation-extraction.md)
- [LOCAL-028：实现规则候选抽取与表达校验](issue-028-rule-candidate-extraction.md)
- [LOCAL-029：实现实体候选召回与身份作用域](issue-029-identity-candidate-retrieval.md)
- [LOCAL-030：实现实体裁决、澄清和可撤销身份记录](issue-030-identity-decisions.md)
- [LOCAL-031：实现语义发布事务与审核状态 API](issue-031-semantic-publication.md)
- [LOCAL-037：实现配置工作台和数据源能力界面](issue-037-ui-profiles-sources.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/apps/web/`

SPEC Reference: C6；D4–D6。
`S11` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-010、US-011、US-014、US-015；FR-12、FR-13、FR-14、FR-16、FR-17
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T010b/T011b/T014b/T015b跨UI/API流程测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-010.A2、US-011.A2、US-014.A2、US-015.A2
