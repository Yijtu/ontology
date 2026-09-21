---
id: LOCAL-023
number: 23
title: "实现文档解析与可追溯分块"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-005, LOCAL-008, LOCAL-022]
user_stories: [US-010, US-012, US-013]
design_tasks: [S06]
execution_mode: local-implementation
---

# LOCAL-023：实现文档解析与可追溯分块

## 目标与范围

实现可信PDF/text解析适配，原文、规范化文本和定位映射独立存储。

阶段：E 文档与语义。Type：backend。Priority：high。

## 验收条件

- [ ] 条款/章节/表格分块保留条件与例外上下文；解析版本和覆盖范围有记录。
- [ ] 页码/offset可回到原始版本，OCR近似定位显式标记；解析失败不伪装完整。
- [ ] source复制件归为共同lineage，租户范围内去重；不编辑输入原始资料。

## 依赖与进入条件

Dependencies: LOCAL-005, LOCAL-008, LOCAL-022

- [LOCAL-005：实现不可变工件与来源定位存储](issue-005-immutable-artifacts.md)
- [LOCAL-008：实现数据源登记与能力探测框架](issue-008-source-bindings-probe.md)
- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/adapters/extraction-document/`

SPEC Reference: D3–D4；C3。
`S06` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-010、US-012、US-013；FR-12、FR-14、FR-15
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T010a/b 后端部分、原文位置及跨页/截断/坏文件测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-010.A1
