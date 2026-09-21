---
id: LOCAL-052
number: 52
title: "接入真实 Home Assistant 只读遥测"
type: backend
priority: medium
state: planned
readiness: needs_external_input
dependencies: [LOCAL-043, LOCAL-046, LOCAL-049, LOCAL-054]
user_stories: [US-008, US-009, US-024]
design_tasks: [S18]
execution_mode: external-integration
---

# LOCAL-052：接入真实 Home Assistant 只读遥测

## 目标与范围

拿到设备和指定插件资料后实现只读 TelemetryPort，并与规范化契约对照。

阶段：J 外部条件任务。Type：backend。Priority：medium。

## 验收条件

- [ ] 核实型号/固件/插件/实体ID/计量范围，probe只声明实际能力。
- [ ] 实测单位、时间、更新频率、表计重置、过期和断连；设备与传感器身份保持分离。
- [ ] 本卡只读，不启用设备service控制；没有硬件时保持blocked，不把合成数据叫实测。

## 依赖与进入条件

Dependencies: LOCAL-043, LOCAL-046, LOCAL-049, LOCAL-054

- [LOCAL-043：实现能源时序规范化与输入快照](issue-043-energy-input-normalization.md)
- [LOCAL-046：注册能源 Compute 操作与模拟执行服务](issue-046-energy-compute-simulation.md)
- [LOCAL-049：建立真实适配器与架构替换验收套件](issue-049-composition-conformance.md)
- [LOCAL-054：完成跨层端到端验收与本地交付报告](issue-054-end-to-end-acceptance.md)

- 已取得实际设备、固件、Home Assistant 插件/API 资料与可访问测试环境。
- 用户明确授权对指定测试站点进行只读连接。

本卡为条件任务，默认不进入本地自动执行批次。缺少上述资源/授权时保留明确阻塞，不通过假响应标成真实完成。

## 技术定位

拟修改位置（均为后续实现路径，本轮未创建）：

- `platform/packages/adapters/data-ha/`

SPEC Reference: E2–E3；main §11；V7 S18。
`S18` 是 SPEC 设计任务，不是 GitHub 编号。

- [PRD v0.2](../../tasks/prd-industry-semantic-agent-v0.2.md)：US-008、US-009、US-024；FR-10、FR-11、FR-33
- [SPEC 主文](../../tasks/spec-industry-semantic-agent-v0.2.md)：总体边界、ADR 与 INV-01—10
- [组件/API](../../tasks/spec-v0.2/contracts-api.md)、[数据/执行](../../tasks/spec-v0.2/data-execution.md)、[家庭能源](../../tasks/spec-v0.2/home-energy.md)、[验证计划](../../tasks/spec-v0.2/verification-plan.md)

## 验证与完成证据

在获准的测试站点进行只读契约测试，结果与mock/模拟标识分离。

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
