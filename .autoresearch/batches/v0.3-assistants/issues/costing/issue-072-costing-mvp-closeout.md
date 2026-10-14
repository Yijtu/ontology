# V03-072：完成造价 MVP 使用文档、交接与交付门槛

阶段 B · infra · P0 · 状态 planned · GitHub [#240](https://github.com/Yijtu/ontology/issues/240)

执行工作线：feat/electrical-costing-poc；目标：feat/electrical-costing-poc。2026-10-14 按 [新 B PRD](../../../../../tasks/prd-ai-cost-engineer-mvp.md) 重写；V03 是规划 ID，GitHub 编号见 manifest。

## 目标与范围

- README 与使用说明逐项标注可用、受限、未配置、未验证；记录所用 main 基线与造价分支提交。
- 汇总 V03-069 与 V03-071 的实测证据、已知限制和迁移配置说明。
- 没有真实样本验收时只标“内部演示可用”，不宣称 MVP 交付。
- 完成独立审查并按分支管理规则处理回流。

## 依赖与进入条件

Dependencies: #238, #239

依赖：[#238](issue-069-costing-browser-e2e.md)、[#239](issue-071-real-sample-acceptance.md)。
必须在 V03-051 同步门槛通过后开工；发现通用缺口先回 main，再同步。

## 验收条件

- [ ] README 与使用说明逐项标注可用、受限、未配置、未验证；记录所用 main 基线与造价分支提交。
- [ ] 汇总 V03-069 与 V03-071 的实测证据、已知限制和迁移配置说明。
- [ ] 没有真实样本验收时只标“内部演示可用”，不宣称 MVP 交付。
- [ ] 完成独立审查并按分支管理规则处理回流。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [prd-ai-cost-engineer-mvp.md#8-成功指标](../../../../../tasks/prd-ai-cost-engineer-mvp.md#8-成功指标)

故事范围：无直接故事（门槛或外部条件卡）。逐项覆盖见[覆盖表](../../coverage.md)。

## 验证方法

- 在 platform/ 执行 pnpm run verify、pnpm run boundaries 及适用的 pnpm run test:e2e；保存实际命令、环境、结果与资源清理证据。
- 记录所用 main SHA 与分支提交；CI 结果需对应同一提交。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 身份来自可信上下文；数据资产、项目、单据、文件、缓存和导出均保持 tenant/space 与项目隔离。
- 金额只由确定性代码产出；不跳过失败、未知或不完整结果，不以零值或默认值填补缺失。
- 不对外发送报价或澄清单，不调用未授权服务，不把客户资料、真实价格或密钥写入仓库、日志或 Issue。

## 完成记录

- 当前：未开工；验证未运行。GitHub Issue：[#240](https://github.com/Yijtu/ontology/issues/240)（2026-10-14 正文待按本卡更新）；文档提交不代表功能完成。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
