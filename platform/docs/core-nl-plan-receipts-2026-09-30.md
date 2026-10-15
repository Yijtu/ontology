# Core 普通自然语言路由、澄清与固定规划回执

对应 V03-024（#196）。本说明记录本卡在默认 Core 宿主中补上的 NL 路由、澄清与不可变规划回执，
以及它与既有 `RunPlanner`、Template runtime、JEV 决策端口的边界。

## 正常请求如何处理支持任务

- `facts:<property>[,...]` 仍走确定性零模型路径：由 mount 的行业包按 run 锁定的 profile/mapping
  构造 facts 计划，归档 `fixed_path` 计划回执，逐属性执行一次 `ontology_lookup`。
- 普通自然语言问题由 `CoreTemplatePlanResolver.prepare` 接收真实 `RuntimeInput`/`ResumeInput` 与
  `RuntimeDependencies`，用 run 的已确认 mapping/definition 构造有界 schema vocabulary，允许
  `RunPlanner` 提交**至多一个**语义 `data_query` 提案，用确认 mapping 编译成单个只读查询。
- 不允许的提案/缺失能力显式失败：`CAPABILITY_NOT_CONFIGURED`（缺 generation/data_query/catalog
  mapping）或 `UNSUPPORTED_QUERY`（空 vocabulary、非受支持提案）。不再有 `definitions` 兜底答案。
- 固定 facts 与固定 task 绑定绕过 rewrite/generation/JEV；只有可重试的 `MODEL_UNAVAILABLE`/
  `RATE_LIMITED` 才按策略澄清。

## 歧义、澄清与 JEV 分端口

- 确定性歧义（如 `or`/`或者`/`还是`）先澄清，不强制 JEV。
- 只有真正的路由歧义才调用 JEV 决策端口；JEV 与 generation 是**两个独立端口**，JEV 的概率不改变
  权限、白名单或预算，也不能证明答案正确。缺 JEV/状态归档时用显式确定性澄清并标注降级原因
  （`jev_unavailable` / `jev_state_not_configured` 等）。
- 歧义返回带选项/缺项的 typed 澄清；宿主先归档澄清 receipt，再发 `clarification_requested`。
  用户响应绑定旧 `receiptRef`/`questionRef`/`clarificationId`/run revision，可恢复同一计划、不重放
  generation/JEV。

## 不可变规划回执与恢复

- 迁移 `071_core_plan_receipts.sql` 新增 `agent_platform.core_plan_receipts`（tenant/space RLS，
  同域 FK 到 runs）。回执身份覆盖 run、profile ref/hash、runtime ref、input manifest digest、
  有效问题 digest、mapping/definition、工具绑定与路由信号/澄清响应 digest。
- 写入不可变且对同一请求键幂等；同一请求得到不同结果即冲突。回执可作为 `ResourceRef`（kind
  `plan`）被 checkpoint 引用并完整重读，恢复时不重新规划已归档计划、不重置 ledger。
- 参数变更确认与固定输入快照由 V03-023 的 `ConfirmationProposal`/`task-input-snapshot` 提供；
  本卡不扩大 allowlist、项目范围或预算。

## 验证

```text
pnpm exec vitest run tests/unit/workflow-planning.spec.ts tests/unit/template-runtime.spec.ts \
  tests/unit/schema-vocabulary.spec.ts tests/unit/few-shot-examples.spec.ts \
  tests/unit/workflow-question-rewriting.spec.ts --maxWorkers=1
pnpm exec vitest run tests/integration/core-template-plan-receipts-postgres.spec.ts \
  tests/integration/core-composition-chain-postgres.spec.ts \
  tests/integration/core-local-host-postgres.spec.ts --maxWorkers=1
pnpm run typecheck && pnpm run lint && pnpm run boundaries
```

集成套件使用带标签命名卷的隔离 PostgreSQL 与受控 loopback 模型端点，不访问真实模型或客户数据。
