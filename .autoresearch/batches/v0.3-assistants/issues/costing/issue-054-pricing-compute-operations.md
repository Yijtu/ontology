# V03-054：实现 2–3 种计价规则的注册 compute 操作

阶段 B · backend · P0 · 状态 planned · GitHub [#223](https://github.com/Yijtu/ontology/issues/223)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。2026-10-14 按 [新 B PRD](../../../../../tasks/prd-ai-cost-engineer-mvp.md) 重写；V03 是规划 ID，GitHub 编号见 manifest。

## 目标与范围

- 按 V03-048 确认的计价规则实现 2–3 个版本化 compute 操作（如 costing.tray-expansion-weight 等），注册到 Core 并固定 handler 摘要。
- 输入为已确认的标准参数、工艺参数、价格与数量，输出逐行分项（板材、表面处理、加工、配件、其他、运输）与合计；用 DecimalString 和定点整数运算，舍入阶段显式。
- 缺参数、缺价、单位不符时返回带原因的阻断行，不以零值进入合计。
- 测试预期来自 V03-048 的书面算例和独立推导，不复制被测算法；规则未确认时只用标注为合成的算例验证机制。

## 依赖与进入条件

Dependencies: #220, #170

依赖：[#220](issue-052-costing-extension-skeleton.md)、[#170](issue-048-scope-discovery.md)。
必须在 V03-051 同步门槛通过后开工；发现通用缺口先回 main，再同步。

## 验收条件

- [ ] 按 V03-048 确认的计价规则实现 2–3 个版本化 compute 操作（如 costing.tray-expansion-weight 等），注册到 Core 并固定 handler 摘要。
- [ ] 输入为已确认的标准参数、工艺参数、价格与数量，输出逐行分项（板材、表面处理、加工、配件、其他、运输）与合计；用 DecimalString 和定点整数运算，舍入阶段显式。
- [ ] 缺参数、缺价、单位不符时返回带原因的阻断行，不以零值进入合计。
- [ ] 测试预期来自 V03-048 的书面算例和独立推导，不复制被测算法；规则未确认时只用标注为合成的算例验证机制。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [prd-ai-cost-engineer-mvp.md#us-005工艺规则维护](../../../../../tasks/prd-ai-cost-engineer-mvp.md#us-005工艺规则维护)
- [prd-ai-cost-engineer-mvp.md#us-014双成本测算计算引擎](../../../../../tasks/prd-ai-cost-engineer-mvp.md#us-014双成本测算计算引擎)
- [prd-ai-cost-engineer-mvp.md#4-功能需求](../../../../../tasks/prd-ai-cost-engineer-mvp.md#4-功能需求)
- [prd-ai-cost-engineer-mvp.md#7-技术考虑](../../../../../tasks/prd-ai-cost-engineer-mvp.md#7-技术考虑)

故事范围：C.US-005、C.US-014。逐项覆盖见[覆盖表](../../coverage.md)。

- C.US-005.AC-05 → C-T005-05：MVP 只支持约定的 2–3 种计价规则；每种规则是一个经审查测试、注册到 Core 的版本化 compute 操作，页面只维护其参数，不提供任意表达式或脚本。
- C.US-014.AC-06 → C-T014-06：AI 不参与金额计算；金额只由注册的确定性 compute 操作产出，输入输出形成不可变工件。
- C.FR-19 → C-F19：系统必须基于已确认清单、已确认标准规则、工艺公式与企业价格执行确定性计算，产出标准参数成本与实际生产成本两套结果。

## 验证方法

- 在 platform/ 运行受影响的单元与集成测试、pnpm run typecheck、pnpm run lint；适用时运行 pnpm run boundaries。
- 测试预期来自新 PRD 的验收条件和独立算例；负例（缺值、越权、篡改、跨项目）必须保持阻断。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 身份来自可信上下文；数据资产、项目、单据、文件、缓存和导出均保持 tenant/space 与项目隔离。
- 金额只由确定性代码产出；不跳过失败、未知或不完整结果，不以零值或默认值填补缺失。
- 不对外发送报价或澄清单，不调用未授权服务，不把客户资料、真实价格或密钥写入仓库、日志或 Issue。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#223](https://github.com/Yijtu/ontology/issues/223)（2026-10-14 正文待按本卡更新）；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
