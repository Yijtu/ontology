# V03-070：实现并核对已授权的真实客户报价适配器

阶段 B · backend · P0 · 状态 planned · GitHub [#227](https://github.com/Yijtu/ontology/issues/227)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 真实接口/库/进程的授权、固定算法/price版本、精度/舍入和逐行输出契约确认后实现注册adapter，复用054端口与conformance套件。
- 归档原始request/response和权威回执，验证价格固定与行映射/合组分摊；错版本、缺明细、精度损失、只最新价保持contract_gap。
- 核对真实超时/取消、幂等与调用状态查询；没有查询能力不盲重调，不能用synthetic关闭本卡。
- 客户资源或许可缺失时保持external_unconfirmed、未完成；内部合成E2E不依赖本卡，正式业务验收071必须依赖本卡。

## 依赖与进入条件

Dependencies: #171, #223

依赖：[V03-049](issue-049-authority-discovery.md)、[V03-054](issue-054-customer-quotation-adapter.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。
真实客户接口/许可/版本/配对gold或验收人缺失时真实路径不得标完成。机制可用合成资源单独验证；不得用替身关闭真实验收。

## 验收条件

- [ ] 真实接口/库/进程的授权、固定算法/price版本、精度/舍入和逐行输出契约确认后实现注册adapter，复用054端口与conformance套件。
- [ ] 归档原始request/response和权威回执，验证价格固定与行映射/合组分摊；错版本、缺明细、精度损失、只最新价保持contract_gap。
- [ ] 核对真实超时/取消、幂等与调用状态查询；没有查询能力不盲重调，不能用synthetic关闭本卡。
- [ ] 客户资源或许可缺失时保持external_unconfirmed、未完成；内部合成E2E不依赖本卡，正式业务验收071必须依赖本卡。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#51-可替换客户报价端口](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#51-可替换客户报价端口)
- [spec-electrical-costing-mvp-v0.3.md#11-外部依赖图纸与未验证风险](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#11-外部依赖图纸与未验证风险)

故事范围：P.US-007、P.US-016、P.US-017、P.US-023、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-017.AC-03 → P-T017-03：客户函数不可用或未获确认时不给正式报价；替身只能产出显式合成结果。
- P.US-023.AC-03 → P-T023-03：动作、数据后端与运行时由明确契约装配；不兼容组合拒绝并说明原因。
- P.FR-11 → P-F11：系统必须仅执行已注册并授权的函数版本。
- P.FR-24 → P-F24：系统必须固定报价输入、价格、规则和函数的版本引用。
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

- 当前：未开工；验证未运行。GitHub Issue：[#227](https://github.com/Yijtu/ontology/issues/227)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
