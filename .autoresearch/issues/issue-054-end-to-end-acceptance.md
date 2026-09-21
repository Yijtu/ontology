---
id: LOCAL-054
number: 54
title: "完成跨层端到端验收与本地交付报告"
type: fullstack
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-037, LOCAL-038, LOCAL-039, LOCAL-040, LOCAL-041, LOCAL-047, LOCAL-048, LOCAL-049, LOCAL-050]
user_stories: [US-025]
design_tasks: [S16]
execution_mode: local-implementation
---

# LOCAL-054：完成跨层端到端验收与本地交付报告

## 目标与范围

验证完整可运行系统及首个家庭能源场景，形成可复现交付说明。

阶段：I 验证与收尾。Type：fullstack。Priority：high。

## 验收条件

- [ ] 自动完成配置→接入/预处理→候选/裁决/发布→提问→工具→草稿核验→答案→来源，断言UI/API/job/data真实路径。
- [ ] 覆盖依据撤回、历史回放、澄清/权限/超时至少一条失败路径；覆盖无本体、第二映射、两runtime与local/MCP。
- [ ] CI使用确定模型响应和独立临时数据；浏览器验证；报告明确模型与硬件尚未实测部分。
- [ ] 不能因真实模型/HA未就绪阻塞本地E2E，也不能把本地E2E结果当成LOCAL-051—053完成。
- [ ] 完成浏览器验证，保存关键正常/异常交互的可复现证据。

## 依赖与进入条件

Dependencies: LOCAL-037, LOCAL-038, LOCAL-039, LOCAL-040, LOCAL-041, LOCAL-047, LOCAL-048, LOCAL-049, LOCAL-050

- [LOCAL-037：实现配置工作台和数据源能力界面](issue-037-ui-profiles-sources.md)
- [LOCAL-038：实现导入任务与候选审核界面](issue-038-ui-jobs-review.md)
- [LOCAL-039：实现业务问答、进度和澄清界面](issue-039-ui-query-workflow.md)
- [LOCAL-040：实现证据展开与历史对比界面](issue-040-ui-provenance-history.md)
- [LOCAL-041：实现行业包导出、成熟度与兼容升级](issue-041-package-export-upgrade.md)
- [LOCAL-047：实现家庭能源计划、对比与仿真界面](issue-047-ui-home-energy.md)
- [LOCAL-048：构建规格驱动的语义回归夹具](issue-048-semantic-regression-fixtures.md)
- [LOCAL-049：建立真实适配器与架构替换验收套件](issue-049-composition-conformance.md)
- [LOCAL-050：建立质量、负载与故障恢复评测工具](issue-050-evaluation-load-harness.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/tests/e2e/`
- `platform/docs/`

SPEC Reference: V3 US025；V5；E8。
`S16` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-025；FR-34
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T025a–d与能源E01–E12、替换X01–X08集成证据；通过后出运行/恢复/已知限制报告。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-025.A1、US-025.A2、US-025.A3、US-025.A4
