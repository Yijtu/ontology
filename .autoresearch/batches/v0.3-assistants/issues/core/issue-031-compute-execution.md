# V03-031：装配注册 Compute、实现版本与不可变结果工件

阶段 A · backend · P0 · 状态 planned · GitHub [#201](https://github.com/Yijtu/ontology/issues/201)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 通过 task/gateway/data_query compute dispatcher 执行已注册中性示例操作，handler/schema digests 和输入 refs 固定。
- 结果工件/来源/逐字段绑定、执行/完整性/policy报告写入持久层；money currency 与 unit 分别保留。
- 缺函数/不兼容/失败/重复提交/未知外部结果停止或读回，不由模型编数值，也不标客户报价。
- 注册合成动作接通014 sandbox真实试算；返回output bindings供032构建typed manifest，发布仍依赖032～036的完整策略/核验链。

## 依赖与进入条件

Dependencies: #194, #198

依赖：[V03-023](issue-023-task-input-artifacts.md)、[V03-030](issue-030-task-validation-policies.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 通过 task/gateway/data_query compute dispatcher 执行已注册中性示例操作，handler/schema digests 和输入 refs 固定。
- [ ] 结果工件/来源/逐字段绑定、执行/完整性/policy报告写入持久层；money currency 与 unit 分别保留。
- [ ] 缺函数/不兼容/失败/重复提交/未知外部结果停止或读回，不由模型编数值，也不标客户报价。
- [ ] 注册合成动作接通014 sandbox真实试算；返回output bindings供032构建typed manifest，发布仍依赖032～036的完整策略/核验链。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-010、A.US-011。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-005.AC-02 → A-T005-02：合成实例隔离标记，用于规则／动作验证；不会成为真实事实或自动获业务批准。
- A.US-010.AC-01 → A-T010-01：示例动作通过正常 task／gateway／compute 注册链执行，固定输入、函数版本、授权范围和前置条件。
- A.US-010.AC-02 → A-T010-02：保存输入／输出工件、逐字段计算证据、调用状态与完整性；模型不能给缺失数值编造计算结果。
- A.US-010.AC-03 → A-T010-03：缺输入、未绑定函数、契约不兼容或函数故障有明确阻断和重试路径；同逻辑动作重试不重复有效执行。
- A.FR-6 → A-F06：系统必须只执行已注册并授权的版本化动作。
- P.US-007.AC-02 → P-T007-02：可绑定授权的已注册函数版本；未绑定或契约不兼容时显示“不可执行”及原因。
- P.US-009.AC-02 → P-T009-02：样例可覆盖缺参数、同名异物、冲突、错单位与缺能力，工作台显示规则匹配和已注册动作试算；B 补缺价等报价反例。
- P.US-017.AC-02 → P-T017-02：正常请求通过已注册报价动作执行，保存逐行结果、调用记录、失败和覆盖情况。
- P.FR-11 → P-F11：系统必须仅执行已注册并授权的函数版本。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：实现完成，验证已运行（分支 feat/v03-031-compute-execution）。GitHub Issue：[#201](https://github.com/Yijtu/ontology/issues/201)。
- 实现：新增 `contracts/src/compute-execution.ts`（`ComputeInvocationRecord`/`ComputeResultArtifact`/`ComputeOutputBindings` 及存储端口与运行时守卫）；`migrations/control/075_compute_execution.sql`（invocations/output_bindings/result_artifacts，RLS+scope 隔离、logical_key 唯一键幂等）；control-postgres 三个存储；tool-services `compute/`（`RegisteredComputeExecutionService` 幂等执行、block/重试、逐字段 unit/currency 绑定；中性示例操作 `example.compute.aggregate`；`SyntheticActionTrial` 接通 014 sandbox `ActionTrialPort`）。
- 满足验收：任务/注册操作→scoped reader/受限 limits/可信 ctx/AbortSignal→领域输出→原始 output bindings→wrapper→invocation 完成；缺输入/未绑定/契约不符/函数故障显式阻断且可重试；同逻辑键重试读回同一结果（handler 不重复执行）；货币与单位分开保存。
- 验证命令（platform/）：`pnpm run typecheck`、`pnpm run lint`、`pnpm run boundaries`、`pnpm --filter @ontology/contracts run check:contracts` 均通过；`vitest run tests/unit/compute-execution.spec.ts`（9 passed）、`tests/integration/compute-execution-postgres.spec.ts`（4 passed，真实 PG）、composition-chain 及相关单测（7 files / 66 tests passed）。
- 未验证/边界：032 起才构建 typed manifest / 发布门（本卡只产出 output bindings）；未接入 apps/api 运行期装配；EX-9 的 `COMPUTE_*` 线级错误码登记留待统一错误目录变更；未调用真实外部模型/客户服务。
- 兼容影响：仅追加表/契约/服务，未改旧行为；迁移号 075（074 已为并行节点保留）。
