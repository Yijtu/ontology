# V03-033：实现数值、货币与分批全表绑定硬核验

阶段 A · backend · P0 · 状态 planned · GitHub [#204](https://github.com/Yijtu/ontology/issues/204)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 精确数值/单位/currency/subject/time/row/column 对授权结果 pointers 和 source refs 校验，禁止有损浮点恢复假精度。
- 按照 bounded claim batches 完整核验所有声明表行，counts/digest/顺序/行绑定/完整性对账；不因128claim上限跳过后页。
- 错误金额/单位/币种/交换行/缺行/篡改manifest/截断阻断完整发布；每批共享 budget/deadline，记录恢复进度。

## 依赖与进入条件

Dependencies: #203, #199, #201, #198

依赖：[V03-032](issue-032-answer-v3-artifacts.md)、[V03-025](issue-025-semantic-sql-query.md)、[V03-031](issue-031-compute-execution.md)、[V03-030](issue-030-task-validation-policies.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 精确数值/单位/currency/subject/time/row/column 对授权结果 pointers 和 source refs 校验，禁止有损浮点恢复假精度。
- [ ] 按照 bounded claim batches 完整核验所有声明表行，counts/digest/顺序/行绑定/完整性对账；不因128claim上限跳过后页。
- [ ] 错误金额/单位/币种/交换行/缺行/篡改manifest/截断阻断完整发布；每批共享 budget/deadline，记录恢复进度。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-010、A.US-011、A.US-016。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-011.AC-01 → A-T011-01：writer 支持本阶段事实、规则、关系、结构化查询、原文引用和 compute 证据对应的类型化结果。
- A.US-011.AC-02 → A-T011-02：核验字段／主体／单位／时间／来源／版本／完整性及授权；错规则判定、错数值、错引用或错行绑定阻断发布。
- A.FR-17 → A-F17：系统必须对支持结果执行类型化硬核验。
- P.US-018.AC-01 → P-T018-01：结果字段形成类型化断言并绑定证据；显示、核验、发布和持久化采用同一版本。
- P.US-018.AC-02 → P-T018-02：数值、行标识、单位／币种、规则／价格／函数版本或完整性不匹配时阻断发布。
- P.FR-26 → P-F26：系统必须将结果字段绑定到可核验的计算证据。
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

- 当前：未开工；验证未运行。GitHub Issue：[#204](https://github.com/Yijtu/ontology/issues/204)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
