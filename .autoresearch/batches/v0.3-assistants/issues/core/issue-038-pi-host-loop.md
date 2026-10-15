# V03-038：在 Core 正常入口装配 Pi 有界补证运行时

阶段 A · backend · P0 · 状态 planned · GitHub [#209](https://github.com/Yijtu/ontology/issues/209)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 真实 Pi 适配器注册到 Core profile/runtime factory，工具只经过同gateway，共享绑定和预算。
- 测试查询不足→受限补查→已核验最终结果；无新证据、工具不支持或循环cap正确停止。
- SDK stream/final不能发布，parallel/late calls/abort都受Controller管理，不加另一循环所有者或行业逻辑。

## 依赖与进入条件

Dependencies: #196, #199, #200, #201, #207

依赖：[V03-024](issue-024-nl-plan-receipts.md)、[V03-025](issue-025-semantic-sql-query.md)、[V03-029](issue-029-rule-source-provenance.md)、[V03-031](issue-031-compute-execution.md)、[V03-036](issue-036-typed-draft-writer.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [x] 真实 Pi 适配器注册到 Core profile/runtime factory，工具只经过同gateway，共享绑定和预算。
- [x] 测试查询不足→受限补查→已核验最终结果；无新证据、工具不支持或循环cap正确停止。
- [x] SDK stream/final不能发布，parallel/late calls/abort都受Controller管理，不加另一循环所有者或行业逻辑。
- [x] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-007、A.US-013、A.US-015。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-007.AC-01 → A-T007-01：固定验证问题覆盖列表／属性、规则判断与解释、文档依据及已注册计算，路由到当前授权项目和能力。
- A.US-013.AC-01 → A-T013-01：Template 支持已知步骤；动态 runtime 支持“查询不足→补查→完成”的有限测试路径，均由正常 HTTP 分派而非手动 Controller 启动。
- A.US-013.AC-03 → A-T013-03：generation 与 JEV 分端口；JEV 按需决策，概率不能改变权限或证明答案正确；缺决策模型时明确可用降级策略。
- A.FR-12 → A-F12：系统必须把受支持的自然语言问题转为授权任务。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 分支 `feat/v03-038-pi-host-loop`；提交 `feat: assemble Pi bounded evidence runtime at the normal entry (#209)`。
- 改动：`apps/api/src/composition/core-local-composition.ts` 在正常入口注册 `runtime-pi` 组件并装配真实 `PiRuntimeAdapter`（`@ontology/adapter-runtime-pi`），`RuntimeSelectorPort` 按 profile 固定的完整 ref（id+version+digest）在 Template／Pi 两个真实适配器间分派；两者共用同一 `RuntimeCapabilityFactoryPort`（generation 与 JEV 是两个独立端口）和同一 run 账本／输入 manifest，未新增循环所有者或行业逻辑。新增 `tests/integration/core-pi-host-postgres.spec.ts`。
- 验收：正常 HTTP `POST /api/v1/runs`（真实 Postgres + 真实 durable worker + 真实 gateway）分派 Pi profile，受控模型服务器只给出工具提案（受控模型响应，非真实付费调用）。固定路径：第 1 轮 `ontology_lookup(intent=definitions)`（查询不足，非事实页）→ 第 2 轮补查 `ontology_lookup(intent=facts, inspection_due)`（已发布事实）→ 完成；控制器 typed draft→verify→publish 同一已核验版本，回答断言 `inspection_due=false` 且带证据 ref。断言：`runtime-pi`、`runtime-template` 均已注册；run_events 含 `answer.published`；run state=`published`；同一 run 仅 1 个 ledger（补查／模型／草稿修复不重置预算）；2 条 `observation` 证据；`modelRequestCount>=3`（≥3 次模型调用）。JEV 关闭仍可分派，generation／JEV 分端口。
- 负例／停止：Pi 适配器单测（`tests/unit/pi-runtime.spec.ts`）已覆盖无剩余预算、超期、host abort、未授权工具不进入 gateway、gateway 拒绝不被覆盖、无发布路径；`tests/integration/workflow-controller-postgres.spec.ts` 覆盖每 run 唯一 runtime 选择与唯一 ledger。本卡未新增第二循环所有者。
- 命令与结果（`platform/`）：`pnpm run typecheck` 通过；`pnpm run lint` 通过；`pnpm run boundaries` 8 passed；`vitest run tests/unit tests/composition` 147 files / 1602 tests passed；`npx vitest run tests/integration/core-pi-host-postgres.spec.ts` 1 passed；`core-local-host-postgres.spec.ts` 5 passed；`core-model-host-postgres.spec.ts` 1 passed；`core-composition-chain-postgres.spec.ts` passed。容器使用命名卷并显式回收（`startPostgresContainer`），未使用 `--rm`。
- 迁移：无需新迁移（复用既有 run／budget／evidence／checkpoint 存储），未占用 `079_*.sql`。兼容影响：Core 组件注册表新增一个 `runtime-pi` 运行时条目，旧 Template profile 行为不变。
- 未验证／外部条件：真实付费模型调用、真实 MCP transport 与浏览器 E2E 不在本卡（分别属 V03-044/V03-045）；受控模型响应已明确标注，不记为真实模型验收。已知与本卡无关的既有失败：`tests/integration/core-template-plan-receipts-postgres.spec.ts` 一个用例在基线（未含本卡改动）即失败（`expected 'published' to be 'failed'`），已核对非本卡引入。
- GitHub Issue：[#209](https://github.com/Yijtu/ontology/issues/209)。
