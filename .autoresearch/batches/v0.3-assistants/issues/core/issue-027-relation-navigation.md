# V03-027：提取通用关系导航并支持一跳关系前提

阶段 A · backend · P1 · 状态 planned · GitHub [#195](https://github.com/Yijtu/ontology/issues/195)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 按 published relation 和固定 scope/revision 执行 ≤3hop 导航，返回端点/关系/来源/coverage。
- 规则仅支持明确有限一跳关系前提，绑定目标实体条件，不拿元数据图/证据依赖冒充实例关系。
- 未知端点、多匹配/冲突、超 cap/跨页/跨范围反例拒绝或显式 incomplete，能源语义不进入 Core。

## 依赖与进入条件

Dependencies: #188, #192

依赖：[V03-026](issue-026-finite-rule-boolean.md)、[V03-018](issue-018-query-projection.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 按 published relation 和固定 scope/revision 执行 ≤3hop 导航，返回端点/关系/来源/coverage。
- [ ] 规则仅支持明确有限一跳关系前提，绑定目标实体条件，不拿元数据图/证据依赖冒充实例关系。
- [ ] 未知端点、多匹配/冲突、超 cap/跨页/跨范围反例拒绝或显式 incomplete，能源语义不进入 Core。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [execution-evidence.md](../../../../../tasks/spec-v0.3a/execution-evidence.md)

故事范围：A.US-008、A.US-015。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-008.AC-01 → A-T008-01：以独立样例验证比较／范围、有限 AND、不同条件 OR、例外、受限关系前提与无环依赖；缺信息不默认为 false。
- A.US-008.AC-02 → A-T008-02：实际调用已发布关系的有界导航，返回实体、关系版本、来源与完整性；不把字段 JOIN 或证据图当实体导航。
- A.FR-14 → A-F14：系统必须报告关系导航与查询结果的完整性。
- P.US-006.AC-02 → P-T006-02：unknown、冲突和明确 false 分开；不支持的 OR／关系前提／递归保持“尚不能执行”。
- P.FR-9 → P-F09：系统必须阻止尚不支持的规则表达被启用。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#195](https://github.com/Yijtu/ontology/issues/195)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
