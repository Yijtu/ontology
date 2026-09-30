# V03-058：将 costing.quote 接入公共 task、compute 与正常报价入口

阶段 B · backend · P0 · 状态 planned · GitHub [#228](https://github.com/Yijtu/ontology/issues/228)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 在受信组合入口注册costing.quote、参数/结果Schema与task binding，普通报价问题和快捷动作都进入A /runs/gateway/Controller。
- scoped loader读取固定quoteInput、prices/policies/rules/确认refs，运行注册adapter并归档raw output→output bindings→compute wrapper→gateway evidence；不建立第二控制器。
- 输出完整/部分/阻断、缺能力、timeout_unknown、取消状态准确；机制测试可合成，正式调用必须通过客户authority与范围门槛。
- binding声明必需领域策略，V03-059尚未装配/通过时正式报价保持未就绪；本卡不提前冒称已完成专属核验。

## 依赖与进入条件

Dependencies: #220, #223, #222, #225

依赖：[V03-052](issue-052-industry-package.md)、[V03-054](issue-054-customer-quotation-adapter.md)、[V03-055](issue-055-quote-input-snapshots.md)、[V03-057](issue-057-pricing-context.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 在受信组合入口注册costing.quote、参数/结果Schema与task binding，普通报价问题和快捷动作都进入A /runs/gateway/Controller。
- [ ] scoped loader读取固定quoteInput、prices/policies/rules/确认refs，运行注册adapter并归档raw output→output bindings→compute wrapper→gateway evidence；不建立第二控制器。
- [ ] 输出完整/部分/阻断、缺能力、timeout_unknown、取消状态准确；机制测试可合成，正式调用必须通过客户authority与范围门槛。
- [ ] binding声明必需领域策略，V03-059尚未装配/通过时正式报价保持未就绪；本卡不提前冒称已完成专属核验。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#44-输入函数绑定与-compute-parameters](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#44-输入函数绑定与-compute-parameters)
- [spec-electrical-costing-mvp-v0.3.md#5-客户函数价格修复与任务执行](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#5-客户函数价格修复与任务执行)

故事范围：P.US-015、P.US-017、P.US-018、P.US-021、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-001.AC-02 → P-T001-02：A 的业务首页显示项目、新建项目和当前已挂载任务；本体首页显示行业包、创建行业包、继续建模。B 挂载“AI 造价师／请求报价”入口。
- P.US-007.AC-02 → P-T007-02：可绑定授权的已注册函数版本；未绑定或契约不兼容时显示“不可执行”及原因。
- P.US-012.AC-02 → P-T012-02：A 按动作契约检查所需规则、函数、输入与映射；B 追加权威价格和计价口径检查。缺项列出原因和下一步。
- P.US-015.AC-01 → P-T015-01：报价工作区有问题输入与报价快捷入口，当前项目和资料范围明确可见。
- P.US-015.AC-02 → P-T015-02：能识别已支持的报价、缺项检查和报价解释任务；不支持的任务给出范围说明。
- P.US-017.AC-02 → P-T017-02：正常请求通过已注册报价动作执行，保存逐行结果、调用记录、失败和覆盖情况。
- P.US-017.AC-03 → P-T017-03：客户函数不可用或未获确认时不给正式报价；替身只能产出显式合成结果。
- P.FR-11 → P-F11：系统必须仅执行已注册并授权的函数版本。
- P.FR-18 → P-F18：系统必须使本次项目的实际批准数据可由业务动作读取。
- P.FR-22 → P-F22：系统必须将自然语言报价请求转为当前项目的受支持业务任务。
- P.FR-25 → P-F25：系统必须由确定性函数产出报价金额。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#228](https://github.com/Yijtu/ontology/issues/228)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
