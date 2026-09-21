---
id: LOCAL-027
number: 27
title: "实现实体和关系候选抽取流水线"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-015, LOCAL-022, LOCAL-023, LOCAL-025]
user_stories: [US-012, US-015]
design_tasks: [S11]
execution_mode: local-implementation
---

# LOCAL-027：实现实体和关系候选抽取流水线

## 目标与范围

通过 GenerationPort 对已解析片段产生候选，保存出处与模型/提示词版本。

阶段：E 文档与语义。Type：backend。Priority：high。

## 验收条件

- [ ] 候选按行业schema校验并关联source spans，不能直接修改schema或已发布真值。
- [ ] 类型错误、假引用、被截断片段进入明确失败/待处理状态；可精确重试阶段。
- [ ] 原生强ID数据可走确定性映射，不对每条遥测强制LLM；记录用量与输入版本。

## 依赖与进入条件

Dependencies: LOCAL-015, LOCAL-022, LOCAL-023, LOCAL-025

- [LOCAL-015：实现生成式模型端口与公司 API 适配](issue-015-generation-model-adapter.md)
- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-023：实现文档解析与可追溯分块](issue-023-document-parser-spans.md)
- [LOCAL-025：实现行业模型与语义定义版本存储](issue-025-semantic-model-versions.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/extraction/`

SPEC Reference: D4；C2。
`S11` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-012、US-015；FR-14
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T012a/b，确定响应模型下的准确/漏字段/假引用/重复作业用例。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-012.A1、US-012.A2
