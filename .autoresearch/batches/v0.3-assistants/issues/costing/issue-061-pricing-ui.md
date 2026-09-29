# V03-061：实现价源、计价口径与缺价修复专业界面

阶段 B · frontend · P1 · 状态 planned · GitHub [#229](https://github.com/Yijtu/ontology/issues/229)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 专业面板列价源/版本/有效期/币种/per-unit、费用/税basis/舍入/范围，权限内可补价、附来源、审核发布并采用新项目版本。
- 缺配件价从定位→补录→审核→新snapshot→重新报价真正闭环；错误/未批准/越权/过期状态清晰，未就绪无成功报价按钮。
- 经济参数变更先展示diff，旧报价维持原refs/状态；不会自动用联网/RAG价格替代权威价。

## 依赖与进入条件

Dependencies: #221, #225, #226

依赖：[V03-053](issue-053-price-snapshots.md)、[V03-057](issue-057-pricing-context.md)、[V03-060](issue-060-costing-input-ui.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 专业面板列价源/版本/有效期/币种/per-unit、费用/税basis/舍入/范围，权限内可补价、附来源、审核发布并采用新项目版本。
- [ ] 缺配件价从定位→补录→审核→新snapshot→重新报价真正闭环；错误/未批准/越权/过期状态清晰，未就绪无成功报价按钮。
- [ ] 经济参数变更先展示diff，旧报价维持原refs/状态；不会自动用联网/RAG价格替代权威价。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#52-缺价补录的实际路径](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#52-缺价补录的实际路径)
- [spec-electrical-costing-mvp-v0.3.md#82-报价工作台](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#82-报价工作台)

故事范围：P.US-014、P.US-016、P.US-019、P.US-021。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-015.AC-03 → P-T015-03：“更换规格／税费口径后重新报价”等请求先呈现具体参数变更供确认。
- P.US-016.AC-01 → P-T016-01：展示价格基准日、版本、生效范围、币种、计量单位、含税口径、费用范围和函数版本。
- P.US-016.AC-03 → P-T016-03：可选择授权价格来源及快照；缺价按权威函数契约，由授权维护者补录、导入或更新价格源形成新版本，项目采用后重新确认并计算。首期至少提供一条实际可用的补价路径，不要求另建通用价表平台。
- P.US-016.AC-05 → P-T016-05：在浏览器核验选择、确认、缺价、过期和口径冲突。
- P.FR-23 → P-F23：系统必须在执行参数变更前呈现待确认修改。

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

- 当前：未开工；验证未运行。GitHub Issue：[#229](https://github.com/Yijtu/ontology/issues/229)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
