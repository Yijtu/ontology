# V03-056：实现规格、数量、单位与必需字段确认校验

阶段 B · backend · P1 · 状态 planned · GitHub [#224](https://github.com/Yijtu/ontology/issues/224)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 保存关键字段raw/normalized/source/confirmation，桥架规格/材质/表面处理等仅按签核scope强制；歧义与缺参返回逐行blockers。
- 米↔根等需要段长或组成的换算保存依据及版本，不只改unit标签；精确Decimal/Rational计算，超精度和错维度拒绝。
- 复核后的字段修改走A CAS及新项目revision，不默填数量、规格或价格；同run澄清不覆盖报价经济参数。

## 依赖与进入条件

Dependencies: #222

依赖：[V03-055](issue-055-quote-input-snapshots.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 保存关键字段raw/normalized/source/confirmation，桥架规格/材质/表面处理等仅按签核scope强制；歧义与缺参返回逐行blockers。
- [ ] 米↔根等需要段长或组成的换算保存依据及版本，不只改unit标签；精确Decimal/Rational计算，超精度和错维度拒绝。
- [ ] 复核后的字段修改走A CAS及新项目revision，不默填数量、规格或价格；同run澄清不覆盖报价经济参数。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#32-精确字段与确认](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#32-精确字段与确认)
- [spec-electrical-costing-mvp-v0.3.md#43-税费范围与舍入](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#43-税费范围与舍入)

故事范围：P.US-013、P.US-014、P.US-015、P.US-016。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-014.AC-01 → P-T014-01：关键字段展示原文、当前值、单位、来源和 pending／confirmed／conflict 状态。
- P.US-014.AC-02 → P-T014-02：可编辑规范值与批量确认符合条件的行，记录确认人、时间和修订；改值后需重新检查。
- P.US-014.AC-03 → P-T014-03：缺数量、未知单位、规格冲突和未确认关键参数阻断计价，不默认为零或常见值。
- P.US-015.AC-03 → P-T015-03：“更换规格／税费口径后重新报价”等请求先呈现具体参数变更供确认。
- P.US-016.AC-04 → P-T016-04：米／根／套等换算需有长度或组成依据；税费与舍入阶段采用客户确认版本。
- P.FR-20 → P-F20：系统必须记录关键字段的原始值、规范值、来源和确认状态。
- P.FR-21 → P-F21：系统必须阻断缺参数、错单位、缺价和计价口径冲突。
- P.FR-23 → P-F23：系统必须在执行参数变更前呈现待确认修改。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#224](https://github.com/Yijtu/ontology/issues/224)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
