# V03-019：实现项目文档 BM25 索引与修订撤回可见性

阶段 A · backend · P1 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #19，本批尚未开始实现。

## 目标与范围

- 按项目固定 parse corpus 构建 BM25 generation，完成校验后 CAS 激活，索引就绪明确可读。
- document_search 返回实际片段/locator/digest/revision，旧 revision 与撤回 fence 不暴露为当前有效内容。
- 空结果、索引失败、索引并发/重启、bytes/片段上限与范围隔离可验证。

## 依赖与进入条件

依赖：[V03-006](issue-006-ingestion-coverage.md)、[V03-016](issue-016-project-bindings.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 按项目固定 parse corpus 构建 BM25 generation，完成校验后 CAS 激活，索引就绪明确可读。
- [ ] document_search 返回实际片段/locator/digest/revision，旧 revision 与撤回 fence 不暴露为当前有效内容。
- [ ] 空结果、索引失败、索引并发/重启、bytes/片段上限与范围隔离可验证。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [asset-data-ui.md](../../../../../tasks/spec-v0.3a/asset-data-ui.md)

故事范围：A.US-012。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-012.AC-01 → A-T012-01：导入授权文本后有索引状态，能检索本项目实际片段并返回固定修订／span；失败或未就绪明确提示。
- A.US-012.AC-03 → A-T012-03：修订／撤回同步索引可见性；缓存、检索与模型上下文保持范围隔离，片段按上限返回并标明覆盖限制。
- A.FR-16 → A-F16：系统必须使索引可见性跟随资料修订与撤回。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：未开工；验证未运行；无提交/PR/远程 Issue 编号。
- 实现后记录：提交/PR、适用命令结果、满足的验收、未验证/外部条件、迁移配置与兼容影响。
