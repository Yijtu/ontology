---
id: LOCAL-035
number: 35
title: "实现回答草稿与组合核验服务"
type: backend
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-011, LOCAL-015, LOCAL-016, LOCAL-020, LOCAL-034]
user_stories: [US-021]
design_tasks: [S10]
execution_mode: local-implementation
---

# LOCAL-035：实现回答草稿与组合核验服务

## 目标与范围

实现结构化claims/evidence草稿、硬检查与按策略JEV语义审查。

阶段：F 推理与输出。Type：backend。Priority：high。

## 验收条件

- [ ] 数字/单位/引用/主体/时间与结果绑定，注入不受支持结论能定位具体问题。
- [ ] 程序失败优先于概率高分；JEV不输出自由文本错误说明，模板/生成器受限生成说明。
- [ ] verdict绑定draft_hash/evidence_manifest_hash/policy_version；修订内容产生新草稿。

## 依赖与进入条件

Dependencies: LOCAL-011, LOCAL-015, LOCAL-016, LOCAL-020, LOCAL-034

- [LOCAL-011：实现统一工具网关、本地注册与证据结果](issue-011-tool-gateway-local.md)
- [LOCAL-015：实现生成式模型端口与公司 API 适配](issue-015-generation-model-adapter.md)
- [LOCAL-016：实现 JEV 决策适配与显式降级](issue-016-jev-decision-adapter.md)
- [LOCAL-020：实现路由、小计划与无进展守卫](issue-020-route-plan-loop.md)
- [LOCAL-034：实现按需溯源、历史和受控明细接口](issue-034-provenance-history-api.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/application/verification/`

SPEC Reference: D7.4；C6；main §4。
`S10` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-021；FR-27、FR-28、FR-29
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T021a，正确答案误阻止和错误答案误放行夹具；不用模型自评分作金标。

- 在本卡范围运行有意义的类型/单元/契约/集成检查，保留命令、结果和必要的 fixture/version 信息。
- 原始断言、模型假响应、真实工具结果和实机数据必须正确标注；测试通过不替代客户验收。
- 发现设计契约矛盾时记录具体阻塞和最小建议，不能通过绕过解耦、核验或权限来完成卡片。

## 边界

- 遵守 SPEC 的端口与依赖方向；行业逻辑不进入 core，runtime 不直连数据库，MCP 不拥有另一套业务实现。
- 默认只读数据工具；密钥不写代码、文档、fixture 或日志。
- 本卡不授权提交/推送/合并、付费模型调用或设备操作；实际执行范围以用户届时指令为准。
- 同批次的其他卡片不因本卡存在而自动开工；依赖不能通过编号顺序跳过。

## 需求追踪

US-021.A1
