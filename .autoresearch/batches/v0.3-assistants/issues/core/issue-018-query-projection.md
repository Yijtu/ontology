# V03-018：将批准项目数据物化到可查询固定快照

阶段 A · backend · P0 · 状态 planned · GitHub 编号未分配

执行工作线：feat/core-planning-provenance；目标：main。本地卡不是远程 #18，本批尚未开始实现。

## 目标与范围

- 通过独立 writer 端口在 DuckDB/PostgreSQL 业务后端构建 scoped staged snapshot，不直接改控制存储角色。
- 控制批准/outbox、构建 counts/digest、CAS 激活和撤回 fence 正常执行；失败/并发修订不读旧启动样例。
- 工具读取固定 project/query revision 并报告 coverage；至少 1001 行及增量改/删、restart、跨项目拒绝通过。
- 新精确quantity规则与SQL编译使用Decimal/Rational及后端DECIMAL能力检查，不按字符串字典序比较，也不使用有损float unitFactor。

## 依赖与进入条件

依赖：[V03-016](issue-016-project-bindings.md)、[V03-017](issue-017-project-mapping.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 通过独立 writer 端口在 DuckDB/PostgreSQL 业务后端构建 scoped staged snapshot，不直接改控制存储角色。
- [ ] 控制批准/outbox、构建 counts/digest、CAS 激活和撤回 fence 正常执行；失败/并发修订不读旧启动样例。
- [ ] 工具读取固定 project/query revision 并报告 coverage；至少 1001 行及增量改/删、restart、跨项目拒绝通过。
- [ ] 新精确quantity规则与SQL编译使用Decimal/Rational及后端DECIMAL能力检查，不按字符串字典序比较，也不使用有损float unitFactor。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [asset-data-ui.md](../../../../../tasks/spec-v0.3a/asset-data-ui.md)

故事范围：A.US-006、A.US-015。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-006.AC-01 → A-T006-01：项目绑定确定的行业、mapping、数据来源与批准修订；数据就绪状态可读，未同步不冒称可查询。
- A.US-006.AC-02 → A-T006-02：正常接入流程将记录映射到授权可查询数据集，增量变更／删除策略明确；不读取启动演示快照来代替用户输入。
- A.US-006.AC-03 → A-T006-03：相同业务数据经不同客户列名／单位映射后语义一致，结果来源定位到各自实际物理对象。
- A.FR-11 → A-F11：系统必须按 mapping 查询本项目实际批准数据。
- P.US-013.AC-04 → P-T013-04：重复导入按文件修订处理；跨页仍保持行完整，新资料不能查询到另一项目的示例数据。
- P.FR-16 → P-F16：系统必须隔离共享行业资产和客户项目数据。
- P.FR-18 → P-F18：系统必须使本次项目的实际批准数据可由业务动作读取。

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
