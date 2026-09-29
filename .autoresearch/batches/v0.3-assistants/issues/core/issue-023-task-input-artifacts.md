# V03-023：实现版本化任务绑定、输入快照与策略预检

阶段 A · backend · P1 · 状态 planned · GitHub [#194](https://github.com/Yijtu/ontology/issues/194)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 现有 runs 入口新增服务端核实的 execution binding，锁定 project/input/mapping/schema/task/operation/handler digests。
- 输入/结果政策只可绑定已注册授权版本，报告关联 input/output/policy digest；缺参/能力不执行。
- 同 key 重试读回 canonical run，scope 不由 body/context 提供，旧 facts 调用兼容。
- 普通approved-input与造价等受信派生task-input均验证project/base input/Schema/依赖/确认 pins；工件body不反指包含自己的项目或run manifest digest。

## 依赖与进入条件

Dependencies: #173, #184, #189, #192

依赖：[V03-002](issue-002-public-contracts.md)、[V03-010](issue-010-rule-action-candidates.md)、[V03-016](issue-016-project-bindings.md)、[V03-018](issue-018-query-projection.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 现有 runs 入口新增服务端核实的 execution binding，锁定 project/input/mapping/schema/task/operation/handler digests。
- [ ] 输入/结果政策只可绑定已注册授权版本，报告关联 input/output/policy digest；缺参/能力不执行。
- [ ] 同 key 重试读回 canonical run，scope 不由 body/context 提供，旧 facts 调用兼容。
- [ ] 普通approved-input与造价等受信派生task-input均验证project/base input/Schema/依赖/确认 pins；工件body不反指包含自己的项目或run manifest digest。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-007、A.US-010、A.US-013。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-003.AC-03 → A-T003-03：动作声明只绑定已注册授权能力；模型建议代码、任意脚本和任意地址不能执行。
- A.US-007.AC-03 → A-T007-03：参数修改先展示具体差异供确认；生成 SQL／查询计划受 mapping、只读白名单及 Schema 校验约束。
- A.US-010.AC-01 → A-T010-01：示例动作通过正常 task／gateway／compute 注册链执行，固定输入、函数版本、授权范围和前置条件。
- A.US-014.AC-01 → A-T014-01：输入、定义、mapping、函数与资料变更产生新修订，旧结果保存当时快照／证据；历史回读与固定版本复算分别标注。
- A.FR-6 → A-F06：系统必须只执行已注册并授权的版本化动作。
- P.US-007.AC-01 → P-T007-01：动作草稿展示输入输出、前置条件、权限、证据要求和副作用类别。
- P.US-007.AC-02 → P-T007-02：可绑定授权的已注册函数版本；未绑定或契约不兼容时显示“不可执行”及原因。
- P.US-007.AC-03 → P-T007-03：模型候选不自动注册代码，不接受任意脚本、任意 URL 或未授权调用。
- P.US-012.AC-02 → P-T012-02：A 按动作契约检查所需规则、函数、输入与映射；B 追加权威价格和计价口径检查。缺项列出原因和下一步。
- P.US-015.AC-03 → P-T015-03：“更换规格／税费口径后重新报价”等请求先呈现具体参数变更供确认。
- P.US-017.AC-01 → P-T017-01：输入以不可变快照绑定批准行、参数、行业／规则／价格版本、函数版本及完整性。
- P.US-023.AC-03 → P-T023-03：动作、数据后端与运行时由明确契约装配；不兼容组合拒绝并说明原因。
- P.FR-10 → P-F10：系统必须保存动作声明的输入输出、前置条件与权限。
- P.FR-11 → P-F11：系统必须仅执行已注册并授权的函数版本。
- P.FR-15 → P-F15：系统必须分别显示语义发布状态与部署执行能力。
- P.FR-18 → P-F18：系统必须使本次项目的实际批准数据可由业务动作读取。
- P.FR-23 → P-F23：系统必须在执行参数变更前呈现待确认修改。
- P.FR-24 → P-F24：系统必须固定报价输入、价格、规则和函数的版本引用。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#194](https://github.com/Yijtu/ontology/issues/194)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
