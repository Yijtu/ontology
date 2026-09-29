# V03-064：实现与已核验版本一致的 XLSX 和 JSON 报价导出

阶段 B · fullstack · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #64，本批尚未开始实现。

## 目标与范围

- 绑定answer/contentHash/verified manifest与版本化模板生成权限内XLSX及JSON，包含逐行、范围、计价版本、业务状态和证据索引。
- 十进制精度超过Excel可靠数值范围时以文本/明确精度策略导出，不经Number丢失；防公式注入，导出不重新计算另一份金额。
- 后页数据、行顺序/身份、完整性与屏幕同版；未完整报价不能导出伪装正式完整文件，越权/已撤回/过期读取按A gate。

## 依赖与进入条件

依赖：[V03-059](issue-059-quote-policy-evidence.md)、[V03-062](issue-062-quotation-workbench.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 绑定answer/contentHash/verified manifest与版本化模板生成权限内XLSX及JSON，包含逐行、范围、计价版本、业务状态和证据索引。
- [ ] 十进制精度超过Excel可靠数值范围时以文本/明确精度策略导出，不经Number丢失；防公式注入，导出不重新计算另一份金额。
- [ ] 后页数据、行顺序/身份、完整性与屏幕同版；未完整报价不能导出伪装正式完整文件，越权/已撤回/过期读取按A gate。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#83-xlsx-与-json](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#83-xlsx-与-json)

故事范围：P.US-019、P.US-022、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-019.AC-03 → P-T019-03：可分页、定位问题行、查看差异及导出；空表和失败展示具体原因，不仅展示错误码。
- P.US-022.AC-01 → P-T022-01：可导出 XLSX 和结构化 JSON，包含明细、范围、版本、状态及溯源索引；导出与已核验页面一致。
- P.US-022.AC-04 → P-T022-04：在浏览器核验导出、差异、退回与签核。
- P.FR-32 → P-F32：系统必须导出与已核验版本一致的报价。

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

- 当前：未开工；验证未运行；无提交/PR/远程 Issue 编号。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
