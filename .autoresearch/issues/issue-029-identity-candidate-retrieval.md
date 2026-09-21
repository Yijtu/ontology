---
id: LOCAL-029
number: 29
title: "实现实体候选召回与身份作用域"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-024, LOCAL-025, LOCAL-027]
user_stories: [US-014]
design_tasks: [S11]
execution_mode: local-implementation
---

# LOCAL-029：实现实体候选召回与身份作用域

## 目标与范围

建立强标识、别名、时间/地域/类型过滤的有界候选召回。

阶段：E 文档与语义。Type：backend。Priority：high。

## 验收条件

- [ ] 同名跨客户/站点/类型不可混合，稳定ID和确认别名优先。
- [ ] 保留归一前文本、召回策略与截断；没有候选返回未决而非证明不存在。
- [ ] 不会全库两两模型比较；可选相似后端只有已挂载时才使用。

## 依赖与进入条件

Dependencies: LOCAL-024, LOCAL-025, LOCAL-027

- [LOCAL-024：实现 BM25 文档检索与证据返回](issue-024-bm25-document-search.md)
- [LOCAL-025：实现行业模型与语义定义版本存储](issue-025-semantic-model-versions.md)
- [LOCAL-027：实现实体和关系候选抽取流水线](issue-027-entity-relation-extraction.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/semantic-engine/identity/`

SPEC Reference: D4；C3。
`S11` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-014；FR-16、FR-17
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T014a：别名、同名、历史有效别名、negative与截断召回测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-014.A1
