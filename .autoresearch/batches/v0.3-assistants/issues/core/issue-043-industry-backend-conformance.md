# V03-043：验证两行业、两 mapping 与两业务 SQL 后端

阶段 A · infra · P1 · 状态 planned · GitHub [#215](https://github.com/Yijtu/ontology/issues/215)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 交通/工业在相同公共框架和正常导入/发布/任务链有独立预期，canonical单位/语义一致、来源各指原对象。
- DuckDB与业务Postgres按共同支持查询契约交换，真实只读查询/范围/固定snapshot校验；控制库不计第二后端。
- 字段/阈值/客户列不进入Core/publicUI，架构规则覆盖合法装配和负向跨包/SDK渗漏。

## 依赖与进入条件

Dependencies: #192, #199, #195, #197, #212

依赖：[V03-018](issue-018-query-projection.md)、[V03-025](issue-025-semantic-sql-query.md)、[V03-027](issue-027-relation-navigation.md)、[V03-028](issue-028-incremental-rule-state.md)、[V03-040](issue-040-business-results-ui.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 交通/工业在相同公共框架和正常导入/发布/任务链有独立预期，canonical单位/语义一致、来源各指原对象。
- [ ] DuckDB与业务Postgres按共同支持查询契约交换，真实只读查询/范围/固定snapshot校验；控制库不计第二后端。
- [ ] 字段/阈值/客户列不进入Core/publicUI，架构规则覆盖合法装配和负向跨包/SDK渗漏。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [spec-generic-assistants-core-v0.3.md#7-验收矩阵](../../../../../tasks/spec-generic-assistants-core-v0.3.md#7-验收矩阵)

故事范围：A.US-015。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-001.AC-02 → A-T001-02：挂载测试场景的任务／表单／结果视图时只改场景组合入口与配置，公共框架不新增行业判断。
- A.US-006.AC-03 → A-T006-03：相同业务数据经不同客户列名／单位映射后语义一致，结果来源定位到各自实际物理对象。
- A.US-006.AC-04 → A-T006-04：在浏览器及 API 核验新导入数据、映射变更、失败恢复和跨项目读取拒绝。
- A.US-015.AC-01 → A-T015-01：交通与工业两行业、至少两种物理映射经相同公开契约产生独立金标结果，不在公共后端／前端新增行业判断。
- A.US-015.AC-02 → A-T015-02：复用并接通 Template／Pi 两 runtime、DuckDB／PostgreSQL 两业务查询后端、本地／真实 stdio MCP；在共同支持任务上结果／核验契约一致。
- A.US-015.AC-03 → A-T015-03：控制库 PostgreSQL 不算第二个业务查询后端；checkpoint 与不支持快照能力显式拒绝，不承诺任意 SDK 状态迁移。
- A.US-015.AC-04 → A-T015-04：合成计算函数及场景 UI 来自扩展装配；无客户端代码或真实价格进入通用包，适用架构边界测试通过。
- A.FR-2 → A-F02：系统必须通过场景组合入口挂载专业 UI。
- P.US-023.AC-01 → P-T023-01：A 在交通和工业合成任务中验证同一框架，并以不同列名／单位映射核对结果；通用 Core 和双助手框架不新增行业分支判断。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 执行 pnpm run verify、适用的 pnpm run test:acceptance；保存实际命令、环境、结果与资源清理证据。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#215](https://github.com/Yijtu/ontology/issues/215)；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
