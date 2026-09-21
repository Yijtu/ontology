---
id: LOCAL-050
number: 50
title: "建立质量、负载与故障恢复评测工具"
type: infra
priority: high
state: planned
readiness: waiting_dependencies
dependencies: [LOCAL-020, LOCAL-024, LOCAL-033, LOCAL-036, LOCAL-046, LOCAL-049]
user_stories: [US-011, US-017, US-024]
design_tasks: [S16]
execution_mode: local-implementation
---

# LOCAL-050：建立质量、负载与故障恢复评测工具

## 目标与范围

提供可重复的离线金标、路径对照、容量与故障评测，不在本卡消费真实模型。

阶段：I 验证与收尾。Type：infra。Priority：high。

## 验收条件

- [ ] 保留开发/保留集的来源分组；正确性、核验误放行、调用量和降级分母明确。
- [ ] 并发预算、Worker中断、投影fence、MCP断连、取消迟到、发布竞态有可复现故障用例。
- [ ] 报告数据规模/硬件/缓存/P50/P95/资源与失败边界，未达标不通过删去来源和适配层修饰结果。

## 依赖与进入条件

Dependencies: LOCAL-020, LOCAL-024, LOCAL-033, LOCAL-036, LOCAL-046, LOCAL-049

- [LOCAL-020：实现路由、小计划与无进展守卫](issue-020-route-plan-loop.md)
- [LOCAL-024：实现 BM25 文档检索与证据返回](issue-024-bm25-document-search.md)
- [LOCAL-033：实现增量物化、双时态投影和失效围栏](issue-033-incremental-materialization.md)
- [LOCAL-036：实现最终答案原子发布与过期检查](issue-036-answer-publication-gate.md)
- [LOCAL-046：注册能源 Compute 操作与模拟执行服务](issue-046-energy-compute-simulation.md)
- [LOCAL-049：建立真实适配器与架构替换验收套件](issue-049-composition-conformance.md)

- 前置卡片的接口与对应验证已完成；不得把 planned 状态当已交付。
- 开始实现需用户后续明确启动，本次只生成卡片；已明确的执行授权无需重复询问。


## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/tests/load/`
- `platform/tests/evaluation/`

SPEC Reference: V1；V5–V6；main §8–9。
`S16` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-011、US-017、US-024；FR-13、FR-19、FR-20、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

T024a/b离线模式及V5故障清单；真实API指标在独立条件卡采集。

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
