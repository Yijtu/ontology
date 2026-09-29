# V03-063：实现金额、规格、价格规则与函数版本的逐项溯源

阶段 B · frontend · P1 · 状态 planned · GitHub [#233](https://github.com/Yijtu/ontology/issues/233)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 点击任意报价关键字段展开sourceRow/cell/raw/normalized/确认、price/policy/rule/algorithm/input/output完整refs及核验状态。
- 解释仅复述已核验事实/金额，缺配件价或未覆盖费用具体可定位；无权和缺证据保持限制，不假装完整依据。
- 同文本换来源、错行/错版本或被撤回依赖的负例在UI与API均不绕过gate；证据面板复用公共组件，专业业务解释由场景挂载。

## 依赖与进入条件

Dependencies: #230, #231

依赖：[V03-059](issue-059-quote-policy-evidence.md)、[V03-062](issue-062-quotation-workbench.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 点击任意报价关键字段展开sourceRow/cell/raw/normalized/确认、price/policy/rule/algorithm/input/output完整refs及核验状态。
- [ ] 解释仅复述已核验事实/金额，缺配件价或未覆盖费用具体可定位；无权和缺证据保持限制，不假装完整依据。
- [ ] 同文本换来源、错行/错版本或被撤回依赖的负例在UI与API均不绕过gate；证据面板复用公共组件，专业业务解释由场景挂载。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#71-字段绑定](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#71-字段绑定)
- [spec-electrical-costing-mvp-v0.3.md#72-计算证据与发布有效性](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#72-计算证据与发布有效性)
- [spec-electrical-costing-mvp-v0.3.md#82-报价工作台](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#82-报价工作台)

故事范围：P.US-018、P.US-020、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-020.AC-01 → P-T020-01：从任意报价行展开“原文／单元格→确认参数→适用规则和价格→函数调用→结果”。
- P.US-020.AC-02 → P-T020-02：能看到来源修订、确认记录和计算版本；事实支撑与规范原文分别展示覆盖状态。
- P.US-020.AC-03 → P-T020-03：证据缺失或截断时显示限制，不能用模型解释补成完整证明；不展示模型内部思维链。
- P.US-020.AC-04 → P-T020-04：在浏览器核验数字定位、原文对照、缺证据和跨范围拒绝。
- P.FR-29 → P-F29：系统必须提供从报价字段到原始依据的交互溯源。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- pnpm run build:web 后执行 pnpm run test:e2e；按 vitest.e2e.config.ts 编写 tests/e2e/**/*.e2e.ts，真实 chromium 验证。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#233](https://github.com/Yijtu/ontology/issues/233)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
