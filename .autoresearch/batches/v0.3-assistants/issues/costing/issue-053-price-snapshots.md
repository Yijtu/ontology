# V03-053：实现版本化价表、授权补价与项目采用接口

阶段 B · backend · P1 · 状态 planned · GitHub [#221](https://github.com/Yijtu/ontology/issues/221)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 实现PriceSnapshot/PriceBasis与草稿→审核→不可变发布→项目采用的实际接口及存储端口，固定价源、币种、per-unit、有效期与范围。
- 缺价可授权补录/导入、附来源审核、发布新价后形成新项目revision；未批准、过期、冲突、无权或凭空零价保持阻断。
- 金额十进制字符串与显式税basis不会Number化；客户资源缺失时只验证独立synthetic价源并准确标注，不形成真实正式价表。
- 按签核后的内部分层使用synthetic价源实现机制；正式采用严格检查真实来源/版本/权限，不要求本卡伪造不存在的客户价表。

## 依赖与进入条件

Dependencies: #219, #171, #220

依赖：[V03-051](issue-051-accepted-main-sync.md)、[V03-049](issue-049-authority-discovery.md)、[V03-052](issue-052-industry-package.md)。
必须包含 V03-047 已验收的 main，并完成 V03-051 兼容门槛。发现通用缺口先回 main，再同步；不在场景维持另一份 Core。

## 验收条件

- [ ] 实现PriceSnapshot/PriceBasis与草稿→审核→不可变发布→项目采用的实际接口及存储端口，固定价源、币种、per-unit、有效期与范围。
- [ ] 缺价可授权补录/导入、附来源审核、发布新价后形成新项目revision；未批准、过期、冲突、无权或凭空零价保持阻断。
- [ ] 金额十进制字符串与显式税basis不会Number化；客户资源缺失时只验证独立synthetic价源并准确标注，不形成真实正式价表。
- [ ] 按签核后的内部分层使用synthetic价源实现机制；正式采用严格检查真实来源/版本/权限，不要求本卡伪造不存在的客户价表。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-electrical-costing-mvp-v0.3.md#42-精确数值与价格](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#42-精确数值与价格)
- [spec-electrical-costing-mvp-v0.3.md#52-缺价补录的实际路径](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#52-缺价补录的实际路径)
- [spec-electrical-costing-mvp-v0.3.md#6-api存储与隔离](../../../../../tasks/spec-electrical-costing-mvp-v0.3.md#6-api存储与隔离)

故事范围：P.US-016、P.US-020、P.US-021。逐项覆盖见[覆盖表](../../coverage.md)。

- P.US-009.AC-02 → P-T009-02：样例可覆盖缺参数、同名异物、冲突、错单位与缺能力，工作台显示规则匹配和已注册动作试算；B 补缺价等报价反例。
- P.US-016.AC-01 → P-T016-01：展示价格基准日、版本、生效范围、币种、计量单位、含税口径、费用范围和函数版本。
- P.US-016.AC-02 → P-T016-02：客户规则、行业规则与专家建议分来源；价格过期、缺配件价或口径冲突时明确阻断。
- P.US-016.AC-03 → P-T016-03：可选择授权价格来源及快照；缺价按权威函数契约，由授权维护者补录、导入或更新价格源形成新版本，项目采用后重新确认并计算。首期至少提供一条实际可用的补价路径，不要求另建通用价表平台。
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

- 当前：未开工；验证未运行。GitHub Issue：[#221](https://github.com/Yijtu/ontology/issues/221)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
