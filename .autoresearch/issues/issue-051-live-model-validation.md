---
id: LOCAL-051
number: 51
title: "验证真实公司模型与 JEV 的接口和业务质量"
type: infra
priority: medium
state: planned
readiness: needs_external_input
dependencies: [LOCAL-015, LOCAL-016, LOCAL-035, LOCAL-038, LOCAL-047, LOCAL-050, LOCAL-054]
user_stories: [US-018, US-021, US-024]
design_tasks: [S17]
execution_mode: external-validation
---

# LOCAL-051：验证真实公司模型与 JEV 的接口和业务质量

## 目标与范围

在明确授权、配额和数据范围下验证真实模型链路，保留与离线模拟测试的区别。

阶段：J 外部条件任务。Type：infra。Priority：medium。

## 验收条件

- [ ] 实际endpoint/模型版本/工具调用/结构化与概率字段通过验证，凭据仅服务端引用。
- [ ] 按固定保留集测抽取/消歧/路由/核验/回答及费用时延，不用JEV评分作自己的真值。
- [ ] 无法获得模型/额度或质量不达标如实记录，不能用stub标真实集成完成。

## 依赖与进入条件

Dependencies: LOCAL-015, LOCAL-016, LOCAL-035, LOCAL-038, LOCAL-047, LOCAL-050, LOCAL-054

- [LOCAL-015：实现生成式模型端口与公司 API 适配](issue-015-generation-model-adapter.md)
- [LOCAL-016：实现 JEV 决策适配与显式降级](issue-016-jev-decision-adapter.md)
- [LOCAL-035：实现回答草稿与组合核验服务](issue-035-draft-verification.md)
- [LOCAL-038：实现导入任务与候选审核界面](issue-038-ui-jobs-review.md)
- [LOCAL-047：实现家庭能源计划、对比与仿真界面](issue-047-ui-home-energy.md)
- [LOCAL-050：建立质量、负载与故障恢复评测工具](issue-050-evaluation-load-harness.md)
- [LOCAL-054：完成跨层端到端验收与本地交付报告](issue-054-end-to-end-acceptance.md)

- 用户明确要求进行真实模型调用，并确定预算与可发送的数据。
- 公司生成模型和 Jev 实际端点、访问权限、模型版本与配额已确认。

本卡为条件任务，默认不进入本地自动执行批次。缺少上述资源/授权时保留明确阻塞，不通过假响应标成真实完成。

## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/tests/evaluation/live/`

SPEC Reference: V1；V6；main §11。
`S17` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-018、US-021、US-024；FR-21、FR-27、FR-28、FR-29、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

授权后运行单独的live评测并归档脱敏指标，不从CI自动触发。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-024.A2
