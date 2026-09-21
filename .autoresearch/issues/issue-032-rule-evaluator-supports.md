---
id: LOCAL-032
number: 32
title: "实现声明式规则求值与紧凑支撑 DAG"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-025, LOCAL-031, LOCAL-048]
user_stories: [US-016]
design_tasks: [S12]
execution_mode: local-implementation
---

# LOCAL-032：实现声明式规则求值与紧凑支撑 DAG

## 目标与范围

实现无环规则执行，区分显式事实与派生结论，保留AND/OR支撑语义。

阶段：F 推理与输出。Type：backend。Priority：high。

## 验收条件

- [ ] 同推导AND前提组、同结论OR替代支撑成立，未知/冲突不当true。
- [ ] 规则循环与不支持的否定语义拒绝；proposition key包含时间/单位/范围限定。
- [ ] 紧凑支撑表达避免全组合枚举，按需求值有确定性输入/输出和版本引用。

## 依赖与进入条件

Dependencies: LOCAL-025, LOCAL-031, LOCAL-048

- [LOCAL-025：实现行业模型与语义定义版本存储](issue-025-semantic-model-versions.md)
- [LOCAL-031：实现语义发布事务与审核状态 API](issue-031-semantic-publication.md)
- [LOCAL-048：构建规格驱动的语义回归夹具](issue-048-semantic-regression-fixtures.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/semantic-engine/rules/`

SPEC Reference: D5；E4。
`S12` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-016；FR-18
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T016a、规则边界/多来源/递归拒绝测试；使用 LOCAL-048 的规格金标和独立不变量验证实现，不与历史程序输出做兼容性比较。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-016.A1
