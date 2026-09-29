# V03-065：实现配对比较、业务签核与行业反馈提案服务

阶段 B · backend · P1 · 状态 planned · GitHub [#232](https://github.com/Yijtu/ontology/issues/232)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 按固定GoldCase与comparison policy执行逐行/类别精确比较，输入/价格/费用/税/舍入不匹配或阈值未确认不得passed。
- 业务接受/退回保存授权identity/revision/reasons及exact answer/contentHash/manifest/comparison refs，重算不能继承旧签核。
- 反馈只生成经授权来源的行业草稿修改提案，不覆盖已发布行业版本或旧报价；跨客户资料隔离，审计可回读。
- 服务开发用独立synthetic GoldCase与显式synthetic比较策略验证；实际客户阈值/样本未确认时拒绝business_accepted，而不是把050盘点完成当真实就绪。

## 依赖与进入条件

Dependencies: #172, #230

依赖：[V03-050](issue-050-gold-acceptance-discovery.md)、[V03-059](issue-059-quote-policy-evidence.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 按固定GoldCase与comparison policy执行逐行/类别精确比较，输入/价格/费用/税/舍入不匹配或阈值未确认不得passed。
- [ ] 业务接受/退回保存授权identity/revision/reasons及exact answer/contentHash/manifest/comparison refs，重算不能继承旧签核。
- [ ] 反馈只生成经授权来源的行业草稿修改提案，不覆盖已发布行业版本或旧报价；跨客户资料隔离，审计可回读。
- [ ] 服务开发用独立synthetic GoldCase与显式synthetic比较策略验证；实际客户阈值/样本未确认时拒绝business_accepted，而不是把050盘点完成当真实就绪。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#73-四层验收与-goldcase](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#73-四层验收与-goldcase)
- [spec-electrical-costing-mvp-v0.3.md#6-api存储与隔离](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#6-api存储与隔离)

故事范围：P.US-005、P.US-011、P.US-021、P.US-022、P.US-023。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-022.AC-02 → P-T022-02：配对人工报价按稳定行标识比较参数、单价、数量、费用、税费与金额差异。
- P.US-022.AC-03 → P-T022-03：复核者记录接受／退回、原因和签核人；阈值来自签核口径，未签核不得显示“业务通过”。
- P.FR-33 → P-F33：系统必须保存人工报价比较和业务签核决定。
- P.FR-34 → P-F34：系统必须将项目反馈形成行业修改提案而非直接覆盖已发布资产。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#232](https://github.com/Yijtu/ontology/issues/232)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
