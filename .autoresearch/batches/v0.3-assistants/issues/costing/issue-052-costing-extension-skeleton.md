# V03-052：建立造价扩展包、场景模块与数据资产存储骨架

阶段 B · backend · P1 · 状态 planned · GitHub [#220](https://github.com/Yijtu/ontology/issues/220)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。2026-10-14 按 [新 B PRD](../../../../../tasks/prd-ai-cost-engineer-mvp.md) 重写；V03 是规划 ID，GitHub 编号见 manifest。

## 目标与范围

- 新增造价扩展包（packages/extensions 下）与前端造价场景模块，通过 CoreComputeRegistration 与 ScenarioModuleRegistry 显式装配，公共框架不按行业名称分支。
- 为五类数据资产定义版本化存储端口、追加迁移（tenant/space 主外键、RLS、scope_isolation）与运行时 Schema 校验，金额与数量使用 DecimalString。
- 定义“资产版本快照”契约：项目或成本版本引用资产时按值固定当次内容与摘要，资产后续修改不改写已引用快照。
- 架构边界测试覆盖：造价语义不进入 core/contracts 的行业无关部分，公共前端无造价分支。

## 依赖与进入条件

Dependencies: #219, #170

依赖：[#219](issue-051-accepted-main-sync.md)、[#170](issue-048-scope-discovery.md)。
必须在 V03-051 同步门槛通过后开工；发现通用缺口先回 main，再同步。

## 验收条件

- [ ] 新增造价扩展包（packages/extensions 下）与前端造价场景模块，通过 CoreComputeRegistration 与 ScenarioModuleRegistry 显式装配，公共框架不按行业名称分支。
- [ ] 为五类数据资产定义版本化存储端口、追加迁移（tenant/space 主外键、RLS、scope_isolation）与运行时 Schema 校验，金额与数量使用 DecimalString。
- [ ] 定义“资产版本快照”契约：项目或成本版本引用资产时按值固定当次内容与摘要，资产后续修改不改写已引用快照。
- [ ] 架构边界测试覆盖：造价语义不进入 core/contracts 的行业无关部分，公共前端无造价分支。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [prd-ai-cost-engineer-mvp.md#4-功能需求](../../../../../tasks/prd-ai-cost-engineer-mvp.md#4-功能需求)
- [prd-ai-cost-engineer-mvp.md#7-技术考虑](../../../../../tasks/prd-ai-cost-engineer-mvp.md#7-技术考虑)

故事范围：无直接故事（门槛或外部条件卡）。逐项覆盖见[覆盖表](../../coverage.md)。

- C.FR-9 → C-F09：当项目引用任一数据资产时，系统必须保存当次快照，资产后续更新不得改写历史项目结果。

## 验证方法

- 在 platform/ 运行受影响的单元与集成测试、pnpm run typecheck、pnpm run lint；适用时运行 pnpm run boundaries。
- 测试预期来自新 PRD 的验收条件和独立算例；负例（缺值、越权、篡改、跨项目）必须保持阻断。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 身份来自可信上下文；数据资产、项目、单据、文件、缓存和导出均保持 tenant/space 与项目隔离。
- 金额只由确定性代码产出；不跳过失败、未知或不完整结果，不以零值或默认值填补缺失。
- 不对外发送报价或澄清单，不调用未授权服务，不把客户资料、真实价格或密钥写入仓库、日志或 Issue。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#220](https://github.com/Yijtu/ontology/issues/220)（2026-10-14 正文待按本卡更新）；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
