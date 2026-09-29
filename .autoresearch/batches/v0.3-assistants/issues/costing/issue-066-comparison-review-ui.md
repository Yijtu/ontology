# V03-066：实现人工差异、接受退回与资产反馈专业界面

阶段 B · frontend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #66，本批尚未开始实现。

## 目标与范围

- 显示人工样本版本、逐行/类别差异和已确认比较口径；区分system_verified/business_accepted/client_accepted，不只看总额。
- 权限内可接受/退回并说明问题行/理由，exact报价修订确认；没有配对样本或阈值时保持待复核。
- 将合理业务反馈提交行业修改提案并显示来源，旧包/报价保持不变；专业审核入口不侵入公共UI行业判断。

## 依赖与进入条件

依赖：[V03-062](issue-062-quotation-workbench.md)、[V03-065](issue-065-comparison-review-service.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 显示人工样本版本、逐行/类别差异和已确认比较口径；区分system_verified/business_accepted/client_accepted，不只看总额。
- [ ] 权限内可接受/退回并说明问题行/理由，exact报价修订确认；没有配对样本或阈值时保持待复核。
- [ ] 将合理业务反馈提交行业修改提案并显示来源，旧包/报价保持不变；专业审核入口不侵入公共UI行业判断。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#73-四层验收与-goldcase](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#73-四层验收与-goldcase)
- [spec-electrical-costing-mvp-v0.3.md#82-报价工作台](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#82-报价工作台)

故事范围：P.US-019、P.US-022、P.US-023、P.US-024。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-019.AC-03 → P-T019-03：可分页、定位问题行、查看差异及导出；空表和失败展示具体原因，不仅展示错误码。
- P.US-022.AC-03 → P-T022-03：复核者记录接受／退回、原因和签核人；阈值来自签核口径，未签核不得显示“业务通过”。
- P.US-022.AC-04 → P-T022-04：在浏览器核验导出、差异、退回与签核。
- P.FR-33 → P-F33：系统必须保存人工报价比较和业务签核决定。
- P.FR-34 → P-F34：系统必须将项目反馈形成行业修改提案而非直接覆盖已发布资产。
- P.FR-35 → P-F35：系统必须通过场景组合入口挂载专业页面，不在公共双助手框架内按行业名称分支。

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
