# V03-029：贯通规则结论、前提与规范原文 span 的证据链

阶段 A · backend · P1 · 状态 planned · GitHub [#200](https://github.com/Yijtu/ontology/issues/200)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 复用 WIP support producer 但接通正常 ontology_lookup：实体前提→规则/版本→派生结论→真实 source/parse/span。
- 规范原文与事实支撑分别定位，字符/字节区间/locator/digest 精确；缺证据明确限制不让模型补证明。
- 撤回、历史、不同实体/时间、跨范围与 tampered pointer 可验证，定义发布来源不只剩一个规则 ID。

## 依赖与进入条件

Dependencies: #197, #178, #187

依赖：[V03-028](issue-028-incremental-rule-state.md)、[V03-006](issue-006-ingestion-coverage.md)、[V03-015](issue-015-dynamic-pack-publish.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 复用 WIP support producer 但接通正常 ontology_lookup：实体前提→规则/版本→派生结论→真实 source/parse/span。
- [ ] 规范原文与事实支撑分别定位，字符/字节区间/locator/digest 精确；缺证据明确限制不让模型补证明。
- [ ] 撤回、历史、不同实体/时间、跨范围与 tampered pointer 可验证，定义发布来源不只剩一个规则 ID。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-009、A.US-011、A.US-012。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-009.AC-01 → A-T009-01：从结论展开实例前提→规则及版本→派生结果，并定位前提的原始片段／单元格。
- A.US-009.AC-02 → A-T009-02：规则规范原文经真实 parse／span 链定位，引用内容、locator 和 digest 一致，不只显示规则 ID。
- A.FR-15 → A-F15：系统必须提供规则结论到原文的证据定位。
- P.US-020.AC-01 → P-T020-01：从任意报价行展开“原文／单元格→确认参数→适用规则和价格→函数调用→结果”。
- P.US-020.AC-02 → P-T020-02：能看到来源修订、确认记录和计算版本；事实支撑与规范原文分别展示覆盖状态。
- P.FR-29 → P-F29：系统必须提供从报价字段到原始依据的交互溯源。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#200](https://github.com/Yijtu/ontology/issues/200)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
