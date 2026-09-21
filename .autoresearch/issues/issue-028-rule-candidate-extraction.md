---
id: LOCAL-028
number: 28
title: "实现规则候选抽取与表达校验"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-015, LOCAL-022, LOCAL-023, LOCAL-025, LOCAL-027]
user_stories: [US-013, US-015]
design_tasks: [S11]
execution_mode: local-implementation
---

# LOCAL-028：实现规则候选抽取与表达校验

## 目标与范围

抽取有限规则AST及来源，支持条件/例外并标注未覆盖表达。

阶段：E 文档与语义。Type：backend。Priority：high。

## 验收条件

- [ ] AND/OR、比较、显式否定、单位/适用范围与例外均可回溯原文。
- [ ] 循环或未支持的表达不得被降为宽松规则；记录未处理项与原因。
- [ ] 候选与正式规则分离，高影响规则走审核，不因JSON合法自动发布。

## 依赖与进入条件

Dependencies: LOCAL-015, LOCAL-022, LOCAL-023, LOCAL-025, LOCAL-027

- [LOCAL-015：实现生成式模型端口与公司 API 适配](issue-015-generation-model-adapter.md)
- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-023：实现文档解析与可追溯分块](issue-023-document-parser-spans.md)
- [LOCAL-025：实现行业模型与语义定义版本存储](issue-025-semantic-model-versions.md)
- [LOCAL-027：实现实体和关系候选抽取流水线](issue-027-entity-relation-extraction.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/extraction/`

SPEC Reference: D4–D5。
`S11` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-013、US-015；FR-14、FR-15
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T013a/b，条件边界、例外跨段、冲突规则和不支持表达测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-013.A1、US-013.A2
