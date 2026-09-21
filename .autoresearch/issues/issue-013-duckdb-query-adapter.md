---
id: LOCAL-013
number: 13
title: "实现 DuckDB 本地查询适配器"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-008, LOCAL-011]
user_stories: [US-008, US-009, US-020, US-024]
design_tasks: [S05]
execution_mode: local-implementation
---

# LOCAL-013：实现 DuckDB 本地查询适配器

## 目标与范围

实现第二个真实 SQL 后端，以样例文件快照验证可替换性。

阶段：C 数据与协议适配。Type：backend。Priority：high。

## 验收条件

- [ ] 通过相同 query/catalog 接口返回规范化数据、类型与来源版本。
- [ ] 禁止未经登记文件访问、ATTACH/INSTALL/扩展加载和危险表函数；设置扫描/结果限制。
- [ ] 同语义 fixture 与 PostgreSQL 的规范化结果相等，方言差异只在适配器内。

## 依赖与进入条件

Dependencies: LOCAL-008, LOCAL-011

- [LOCAL-008：实现数据源登记与能力探测框架](issue-008-source-bindings-probe.md)
- [LOCAL-011：实现统一工具网关、本地注册与证据结果](issue-011-tool-gateway-local.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/adapters/data-duckdb/`

SPEC Reference: C3；V2 X03。
`S05` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-008、US-009、US-020、US-024；FR-10、FR-11、FR-25、FR-26、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

DuckDB 真实集成与 X03 初步对照；禁止用 mock 宣称后端可换。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-008.A1、US-009.A1、US-020.A2
