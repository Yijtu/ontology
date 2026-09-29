# V03-030：实现注册任务策略、核验报告与无环最终关联

阶段 A · backend · P0 · 状态 planned · GitHub [#198](https://github.com/Yijtu/ontology/issues/198)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 提供受信 TaskValidationPolicyPort registry、版本/handler/Schema pins和input/result阶段执行；客户端或模型不能选择实现、伪造报告或跨范围引用。
- 冻结 task-policy-report@1 与 task-finalization-receipt@1，报告指向既有输出/typed manifest；最终关联引用报告和结果而不回填结果，所有工件无digest环。
- 必需策略缺失、fail/unknown/incomplete、错input/output/registry digest保持阻断；共享run ledger/deadline/signal，并为通用合成不变量提供独立测试，不硬编码造价口径。
- 本卡独立实现策略/报告/最终关联的端口与机制；031生成原始输出与wrapper，032～036贯通真实typed manifest、result reports、finalization和draft，最终045正常入口验收。

## 依赖与进入条件

Dependencies: #173, #194

依赖：[V03-002](issue-002-public-contracts.md)、[V03-023](issue-023-task-input-artifacts.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 提供受信 TaskValidationPolicyPort registry、版本/handler/Schema pins和input/result阶段执行；客户端或模型不能选择实现、伪造报告或跨范围引用。
- [ ] 冻结 task-policy-report@1 与 task-finalization-receipt@1，报告指向既有输出/typed manifest；最终关联引用报告和结果而不回填结果，所有工件无digest环。
- [ ] 必需策略缺失、fail/unknown/incomplete、错input/output/registry digest保持阻断；共享run ledger/deadline/signal，并为通用合成不变量提供独立测试，不硬编码造价口径。
- [ ] 本卡独立实现策略/报告/最终关联的端口与机制；031生成原始输出与wrapper，032～036贯通真实typed manifest、result reports、finalization和draft，最终045正常入口验收。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md#ex-61-注册任务校验策略](../../../../../tasks/spec-v0.3a/execution-evidence.md#ex-61-注册任务校验策略)

故事范围：A.US-010、A.US-011、A.US-013。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-003.AC-03 → A-T003-03：动作声明只绑定已注册授权能力；模型建议代码、任意脚本和任意地址不能执行。
- A.US-010.AC-01 → A-T010-01：示例动作通过正常 task／gateway／compute 注册链执行，固定输入、函数版本、授权范围和前置条件。
- A.US-010.AC-03 → A-T010-03：缺输入、未绑定函数、契约不兼容或函数故障有明确阻断和重试路径；同逻辑动作重试不重复有效执行。
- A.FR-6 → A-F06：系统必须只执行已注册并授权的版本化动作。
- P.US-007.AC-03 → P-T007-03：模型候选不自动注册代码，不接受任意脚本、任意 URL 或未授权调用。
- P.FR-11 → P-F11：系统必须仅执行已注册并授权的函数版本。
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

- 当前：未开工；验证未运行。GitHub Issue：[#198](https://github.com/Yijtu/ontology/issues/198)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
