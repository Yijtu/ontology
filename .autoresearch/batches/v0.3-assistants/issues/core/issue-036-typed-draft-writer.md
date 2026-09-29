# V03-036：完成跨结果类型的最终草稿与有界修复

阶段 A · backend · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #36，本批尚未开始实现。

## 目标与范围

- final_answer由控制器调度 writer，支持事实/规则/关系/query/quote/compute 的已绑定正文、表引用与限制说明。
- LLM表达不增添未经绑定的数字或规则断言；反例可定位修复，修复后同预算再核验，SDK final 不直接发布。
- writer/verifier模型调用共享 ctx/signal/ledger和唯一计费记录，失败/迟到/超预算不写正式答案。

## 依赖与进入条件

依赖：[V03-033](issue-033-quantity-table-verifier.md)、[V03-034](issue-034-typed-evidence-verifier.md)、[V03-035](issue-035-publication-validity.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] final_answer由控制器调度 writer，支持事实/规则/关系/query/quote/compute 的已绑定正文、表引用与限制说明。
- [ ] LLM表达不增添未经绑定的数字或规则断言；反例可定位修复，修复后同预算再核验，SDK final 不直接发布。
- [ ] writer/verifier模型调用共享 ctx/signal/ledger和唯一计费记录，失败/迟到/超预算不写正式答案。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-007、A.US-011、A.US-012、A.US-013。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-011.AC-01 → A-T011-01：writer 支持本阶段事实、规则、关系、结构化查询、原文引用和 compute 证据对应的类型化结果。
- A.US-011.AC-03 → A-T011-03：发布有效性涵盖上述证据依赖；仅发布同一已核验版本，正文修改重新核验，SDK final 不能绕过控制器。
- A.US-012.AC-02 → A-T012-02：文档问答的事实依赖检索证据，经引用核验后生成最终回答；检索不到依据时说缺依据。
- A.FR-18 → A-F18：系统必须只发布同一已核验结果版本。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行；无提交/PR/远程 Issue 编号。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
