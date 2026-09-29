# V03-035：扩展全部证据的发布有效性与事务 fence

阶段 A · backend · P0 · 状态 planned · GitHub [#206](https://github.com/Yijtu/ontology/issues/206)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 对事实/规则/关系/SQL/文档/compute及注册policy依赖检查 revision/digest/权限/当前可见性，历史状态明示。
- 只发布同 draftHash/manifestHash/verificationHash 和已完成全表 verdict；改正文/表/来源重新核验。
- publish CAS/dispatch fence/idempotency 与来源并发撤回/cancel/lost response 在真实控制库验证；不裸upsert保证并发。

## 依赖与进入条件

Dependencies: #204, #205, #197, #198

依赖：[V03-033](issue-033-quantity-table-verifier.md)、[V03-034](issue-034-typed-evidence-verifier.md)、[V03-028](issue-028-incremental-rule-state.md)、[V03-030](issue-030-task-validation-policies.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 对事实/规则/关系/SQL/文档/compute及注册policy依赖检查 revision/digest/权限/当前可见性，历史状态明示。
- [ ] 只发布同 draftHash/manifestHash/verificationHash 和已完成全表 verdict；改正文/表/来源重新核验。
- [ ] publish CAS/dispatch fence/idempotency 与来源并发撤回/cancel/lost response 在真实控制库验证；不裸upsert保证并发。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-009、A.US-011、A.US-013、A.US-014。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-009.AC-03 → A-T009-03：来源撤回后按仍有效支撑增量更新；历史保留旧结果和当时支撑，当前与历史明确区分。
- A.US-011.AC-03 → A-T011-03：发布有效性涵盖上述证据依赖；仅发布同一已核验版本，正文修改重新核验，SDK final 不能绕过控制器。
- A.US-012.AC-03 → A-T012-03：修订／撤回同步索引可见性；缓存、检索与模型上下文保持范围隔离，片段按上限返回并标明覆盖限制。
- A.FR-16 → A-F16：系统必须使索引可见性跟随资料修订与撤回。
- A.FR-18 → A-F18：系统必须只发布同一已核验结果版本。
- A.FR-20 → A-F20：系统必须阻止取消后的迟到结果发布。
- P.US-018.AC-01 → P-T018-01：结果字段形成类型化断言并绑定证据；显示、核验、发布和持久化采用同一版本。
- P.US-018.AC-03 → P-T018-03：撤回、过期或错范围的依赖不能作为新报价依据；模型概率不能替代程序核验。
- P.FR-27 → P-F27：系统必须在发布前校验输入、来源、依赖与结果完整性。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#206](https://github.com/Yijtu/ontology/issues/206)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
