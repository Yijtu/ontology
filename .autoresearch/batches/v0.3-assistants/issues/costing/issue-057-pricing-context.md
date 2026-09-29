# V03-057：实现费用范围、税费、舍入与计价就绪策略

阶段 B · backend · P1 · 状态 planned · GitHub [#225](https://github.com/Yijtu/ontology/issues/225)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 实现版本化PricingPolicy、selectedScope、explicit prices或pinned server snapshot，币种/含税/费用/折扣/舍入来源清楚且按客户确认契约。
- 计价就绪逐行报告missing-price、单位basis、有效期、费用覆盖与函数能力；任何必需冲突阻断正式执行。
- 口径变更需diff确认并产生新输入修订，不自设税率/公式/1%容差；snapshot与policy pins完整进入输入阶段策略报告。

## 依赖与进入条件

Dependencies: #221, #224

依赖：[V03-053](issue-053-price-snapshots.md)、[V03-056](issue-056-specification-confirmation.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 实现版本化PricingPolicy、selectedScope、explicit prices或pinned server snapshot，币种/含税/费用/折扣/舍入来源清楚且按客户确认契约。
- [ ] 计价就绪逐行报告missing-price、单位basis、有效期、费用覆盖与函数能力；任何必需冲突阻断正式执行。
- [ ] 口径变更需diff确认并产生新输入修订，不自设税率/公式/1%容差；snapshot与policy pins完整进入输入阶段策略报告。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#43-税费范围与舍入](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#43-税费范围与舍入)
- [spec-electrical-costing-mvp-v0.3.md#53-运行状态与正式结果](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#53-运行状态与正式结果)

故事范围：P.US-014、P.US-016、P.US-017。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-012.AC-02 → P-T012-02：A 按动作契约检查所需规则、函数、输入与映射；B 追加权威价格和计价口径检查。缺项列出原因和下一步。
- P.US-014.AC-03 → P-T014-03：缺数量、未知单位、规格冲突和未确认关键参数阻断计价，不默认为零或常见值。
- P.US-016.AC-01 → P-T016-01：展示价格基准日、版本、生效范围、币种、计量单位、含税口径、费用范围和函数版本。
- P.US-016.AC-02 → P-T016-02：客户规则、行业规则与专家建议分来源；价格过期、缺配件价或口径冲突时明确阻断。
- P.US-016.AC-04 → P-T016-04：米／根／套等换算需有长度或组成依据；税费与舍入阶段采用客户确认版本。
- P.US-017.AC-01 → P-T017-01：输入以不可变快照绑定批准行、参数、行业／规则／价格版本、函数版本及完整性。
- P.US-017.AC-04 → P-T017-04：数量、金额和币种遵守明确精度及舍入契约；内部浮点函数的边界需对照确认。
- P.FR-15 → P-F15：系统必须分别显示语义发布状态与部署执行能力。
- P.FR-21 → P-F21：系统必须阻断缺参数、错单位、缺价和计价口径冲突。
- P.FR-24 → P-F24：系统必须固定报价输入、价格、规则和函数的版本引用。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#225](https://github.com/Yijtu/ontology/issues/225)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
