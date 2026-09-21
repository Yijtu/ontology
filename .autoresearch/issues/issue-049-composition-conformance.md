---
id: LOCAL-049
number: 49
title: "建立真实适配器与架构替换验收套件"
type: infra
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-014, LOCAL-017, LOCAL-018, LOCAL-026, LOCAL-041, LOCAL-046]
user_stories: [US-001, US-005, US-007, US-024]
design_tasks: [S16]
execution_mode: local-implementation
---

# LOCAL-049：建立真实适配器与架构替换验收套件

## 目标与范围

落实 X01–X08 和依赖边界测试，证明必要解耦不是形式接口。

阶段：I 验证与收尾。Type：infra。Priority：high。

## 验收条件

- [ ] 真实Pi/Template、DuckDB/Postgres、local/stdio组合完成对应fixture，不以全mock代替。
- [ ] 更换行业/数据mapping不改核心业务执行代码；不支持组合清楚失败。
- [ ] 按授权、错误、数据/证据语义比较，允许后端无关的格式差异；所有外部未实测模块标not_configured。

## 依赖与进入条件

Dependencies: LOCAL-014, LOCAL-017, LOCAL-018, LOCAL-026, LOCAL-041, LOCAL-046

- [LOCAL-014：实现 stdio MCP 与本地工具等价调用](issue-014-mcp-transport.md)
- [LOCAL-017：实现模板运行时适配器](issue-017-template-runtime.md)
- [LOCAL-018：实现 Pi Agent Core 运行时适配器](issue-018-pi-runtime.md)
- [LOCAL-026：实现语义映射、查询编译与本体工具](issue-026-semantic-mapping-query.md)
- [LOCAL-041：实现行业包导出、成熟度与兼容升级](issue-041-package-export-upgrade.md)
- [LOCAL-046：注册能源 Compute 操作与模拟执行服务](issue-046-energy-compute-simulation.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/tests/contracts/`
- `platform/tests/composition/`

SPEC Reference: V2；main INV-01–10。
`S16` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-001、US-005、US-007、US-024；FR-1、FR-5、FR-6、FR-8、FR-9、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

全量X01–X08与架构负向导入检查，报告每个组合具体实现。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-005.A1、US-005.A2、US-007.A1、US-024.A1
