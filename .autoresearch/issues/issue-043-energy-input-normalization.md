---
id: LOCAL-043
number: 43
title: "实现能源时序规范化与输入快照"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-005, LOCAL-008, LOCAL-022, LOCAL-042]
user_stories: [US-009, US-016, US-024]
design_tasks: [S13, S14]
execution_mode: local-implementation
---

# LOCAL-043：实现能源时序规范化与输入快照

## 目标与范围

通过 TelemetryPort/ForecastPort 形成可复现的能源计算输入。

阶段：H 行业资产与能源。Type：backend。Priority：high。

## 验收条件

- [ ] 单位、时区、时隙和采样类型显式对齐；累计表重置、缺失/unknown不被当零。
- [ ] 按测点覆盖避免总表子回路重复计数；SOC转换只使用声明映射。
- [ ] 保留观测/预测发布时间、有效窗口、spec/价格/用户约束版本；未来数据不泄漏到历史forecast。

## 依赖与进入条件

Dependencies: LOCAL-005, LOCAL-008, LOCAL-022, LOCAL-042

- [LOCAL-005：实现不可变工件与来源定位存储](issue-005-immutable-artifacts.md)
- [LOCAL-008：实现数据源登记与能力探测框架](issue-008-source-bindings-probe.md)
- [LOCAL-022：实现异步作业、租约与事务 Outbox](issue-022-durable-jobs-outbox.md)
- [LOCAL-042：定义家庭能源行业包和两套样例映射](issue-042-home-energy-package.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/extensions/home-energy/input/`

SPEC Reference: E2–E4；C3。
`S13`、`S14` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-009、US-016、US-024；FR-10、FR-11、FR-18、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

E01–E03/E09，缺价格、DST、重复计量和来源哈希测试。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

架构/基础设施支撑卡；与同故事的验收承接卡共同交付。
