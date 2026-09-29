# V03-059：实现报价输入结果策略、金额证据与完整发布门槛

阶段 B · backend · P0 · 状态 planned · GitHub [#230](https://github.com/Yijtu/ontology/issues/230)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 通过A TaskValidationPolicyPort注册B input/result策略，固定price/tax/rounding/coverage/scope等业务约束及policy/handler digests，不把规则放通用Core。
- 结果fields绑定同row/source/input/output/money currency/per-unit/pointers；后页漏行、交换行、错币种/金额、过期或撤回依据阻断。
- result policy reports→finalization receipt→answer@3无引用环；缺required策略、伪造pass、其他输出报告或unknown/incomplete不能发布合格完整报价。

## 依赖与进入条件

Dependencies: #228

依赖：[V03-058](issue-058-quote-task-operation.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 通过A TaskValidationPolicyPort注册B input/result策略，固定price/tax/rounding/coverage/scope等业务约束及policy/handler digests，不把规则放通用Core。
- [ ] 结果fields绑定同row/source/input/output/money currency/per-unit/pointers；后页漏行、交换行、错币种/金额、过期或撤回依据阻断。
- [ ] result policy reports→finalization receipt→answer@3无引用环；缺required策略、伪造pass、其他输出报告或unknown/incomplete不能发布合格完整报价。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#7-证据数字核验与业务验收](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#7-证据数字核验与业务验收)
- [execution-evidence.md#ex-61-注册任务校验策略](../../../../../tasks/spec-v0.3a/execution-evidence.md#ex-61-注册任务校验策略)

故事范围：P.US-016、P.US-017、P.US-018、P.US-019、P.US-020、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-009.AC-02 → P-T009-02：样例可覆盖缺参数、同名异物、冲突、错单位与缺能力，工作台显示规则匹配和已注册动作试算；B 补缺价等报价反例。
- P.US-014.AC-03 → P-T014-03：缺数量、未知单位、规格冲突和未确认关键参数阻断计价，不默认为零或常见值。
- P.US-017.AC-04 → P-T017-04：数量、金额和币种遵守明确精度及舍入契约；内部浮点函数的边界需对照确认。
- P.US-018.AC-01 → P-T018-01：结果字段形成类型化断言并绑定证据；显示、核验、发布和持久化采用同一版本。
- P.US-018.AC-02 → P-T018-02：数值、行标识、单位／币种、规则／价格／函数版本或完整性不匹配时阻断发布。
- P.US-018.AC-03 → P-T018-03：撤回、过期或错范围的依赖不能作为新报价依据；模型概率不能替代程序核验。
- P.US-018.AC-04 → P-T018-04：覆盖不足只显示明确标记的部分结果及未覆盖项，不显示“完整项目合计”。
- P.US-019.AC-02 → P-T019-02：显示范围、币种、含税口径、覆盖率、待处理项与核验／业务审核状态，金额精度不被 UI 改写。
- P.US-020.AC-01 → P-T020-01：从任意报价行展开“原文／单元格→确认参数→适用规则和价格→函数调用→结果”。
- P.FR-21 → P-F21：系统必须阻断缺参数、错单位、缺价和计价口径冲突。
- P.FR-26 → P-F26：系统必须将结果字段绑定到可核验的计算证据。
- P.FR-27 → P-F27：系统必须在发布前校验输入、来源、依赖与结果完整性。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#230](https://github.com/Yijtu/ontology/issues/230)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
