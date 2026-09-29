# V03-060：挂载桥架资料、清单与专业参数确认页面

阶段 B · frontend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本地卡不是远程 #60，本批尚未开始实现。

## 目标与范围

- 通过Web FrontendScenarioModule注册专业项目入口、清单/规格/单位表单和来源，复用公共upload/mapping/confirm与权限。
- 显示处理数、待确认/冲突/排除行和新修订diff，用户可实际修正再提交；不要求用户配置runtime/MCP或JSON。
- 长表/窄屏/键盘/空态/错误态可用，刷新保留project/revision；公共助手内不新增行业名if或硬编码桥架列。

## 依赖与进入条件

依赖：[V03-051](issue-051-accepted-main-sync.md)、[V03-055](issue-055-quote-input-snapshots.md)、[V03-056](issue-056-specification-confirmation.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 通过Web FrontendScenarioModule注册专业项目入口、清单/规格/单位表单和来源，复用公共upload/mapping/confirm与权限。
- [ ] 显示处理数、待确认/冲突/排除行和新修订diff，用户可实际修正再提交；不要求用户配置runtime/MCP或JSON。
- [ ] 长表/窄屏/键盘/空态/错误态可用，刷新保留project/revision；公共助手内不新增行业名if或硬编码桥架列。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#81-frontendscenariomodule](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#81-frontendscenariomodule)
- [spec-electrical-costing-mvp-v0.3.md#82-报价工作台](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#82-报价工作台)

故事范围：P.US-001、P.US-012、P.US-013、P.US-014、P.US-019。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-001.AC-01 → P-T001-01：页面有“本体生成助手”和“业务实践助手”两个明确入口，切换保留各自草稿。
- P.US-001.AC-02 → P-T001-02：A 的业务首页显示项目、新建项目和当前已挂载任务；本体首页显示行业包、创建行业包、继续建模。B 挂载“AI 造价师／请求报价”入口。
- P.US-012.AC-04 → P-T012-04：在浏览器核验建项目、挂载、未就绪和版本切换。
- P.US-013.AC-01 → P-T013-01：XLSX／CSV 可选择工作表并确认／调整列对应关系，显示原行号、名称、规格、数量和单位；JSON／文本进入相同审核流程。
- P.US-013.AC-02 → P-T013-02：首期清单模板和可解析表结构明确可见；多级表头、合并单元格等未支持结构定位提示，不自动错猜后宣称解析成功。
- P.US-013.AC-05 → P-T013-05：在浏览器核验上传、分页、重复导入、失败行和项目隔离。
- P.US-014.AC-01 → P-T014-01：关键字段展示原文、当前值、单位、来源和 pending／confirmed／conflict 状态。
- P.US-014.AC-02 → P-T014-02：可编辑规范值与批量确认符合条件的行，记录确认人、时间和修订；改值后需重新检查。
- P.US-014.AC-04 → P-T014-04：在浏览器核验逐字段修改、批量确认、来源定位与阻断。
- P.US-015.AC-01 → P-T015-01：报价工作区有问题输入与报价快捷入口，当前项目和资料范围明确可见。
- P.US-015.AC-04 → P-T015-04：在浏览器核验普通提问、缺项澄清、修改确认与范围外问题。
- P.FR-1 → P-F01：系统必须提供两个有明确用途和独立工作状态的助手入口。
- P.FR-19 → P-F19：系统必须报告清单各处理阶段的行数和覆盖情况。
- P.FR-20 → P-F20：系统必须记录关键字段的原始值、规范值、来源和确认状态。
- P.FR-22 → P-F22：系统必须将自然语言报价请求转为当前项目的受支持业务任务。
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
