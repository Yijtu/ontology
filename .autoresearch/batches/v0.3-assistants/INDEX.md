# v0.3 双助手：GitHub Issue 批次

日期 2026-09-29。已创建 72 个 GitHub Issues：A 通用 Core 47 项，B 造价 MVP 25 项。全部保持 planned／open，未开始实现，未启动 loop-it。

任务按用户要求发布到 [Yijtu/ontology 本批 Issues](https://github.com/Yijtu/ontology/issues?q=is%3Aissue+is%3Aopen+label%3A%22batch%3Av0.3-assistants%22)。本目录保留对应卡和真实编号映射；旧 .autoresearch/issues 与已有 loop 执行记录保留。V03 ID 与 GitHub 数字不能直接互换，使用 manifest 中的映射。

## 从哪里开始

先做 [V03-001](issues/core/issue-001-baseline-wip-audit.md)，核对 main、WIP、旧任务和保留契约。A 完整验收经 [V03-047](issues/core/issue-047-main-release-gate.md) 合入 main；B 经 [V03-051](issues/costing/issue-051-accepted-main-sync.md) 同步并验证。三个 B discovery 可以提前核对，全部专属代码等待主线门槛。

~~~mermaid
flowchart LR
    A0[主线与 WIP 核对] --> A[通用后端 + 公共双助手]
    A --> AM[独立验收并合入 main]
    AM --> S[造价同步门槛]
    D[范围 / 权威函数 / 人工样本核对] --> B[行业资产 + 适配 + 专业 UI]
    S --> B
    B --> I[合成整栈验证]
    I --> R[真实报价比对与业务签核]
~~~

## GitHub 入口与编号


开发入口 [#169](https://github.com/Yijtu/ontology/issues/169)；A 验收并合入 main 门槛 [#218](https://github.com/Yijtu/ontology/issues/218)；B 同步门槛 [#219](https://github.com/Yijtu/ontology/issues/219)。真实 adapter [#227](https://github.com/Yijtu/ontology/issues/227) → 实际样本与业务验收 [#239](https://github.com/Yijtu/ontology/issues/239) → MVP 收尾 [#240](https://github.com/Yijtu/ontology/issues/240)。

只处理标签 batch:v0.3-assistants 和 manifest.github_allowlist 内的任务。下面依赖是实际 GitHub 编号；不要按 V03 的数字访问远程 Issue。

| V03 ID | GitHub Issue | 阶段 | 依赖 |
| --- | --- | --- | --- |
| V03-001 | [#169](https://github.com/Yijtu/ontology/issues/169) | A | 无 |
| V03-002 | [#173](https://github.com/Yijtu/ontology/issues/173) | A | #169 |
| V03-003 | [#174](https://github.com/Yijtu/ontology/issues/174) | A | #173 |
| V03-004 | [#177](https://github.com/Yijtu/ontology/issues/177) | A | #174 |
| V03-005 | [#175](https://github.com/Yijtu/ontology/issues/175) | A | #173 |
| V03-006 | [#178](https://github.com/Yijtu/ontology/issues/178) | A | #174、#175 |
| V03-007 | [#179](https://github.com/Yijtu/ontology/issues/179) | A | #173、#178 |
| V03-008 | [#181](https://github.com/Yijtu/ontology/issues/181) | A | #177、#178、#179 |
| V03-009 | [#183](https://github.com/Yijtu/ontology/issues/183) | A | #181 |
| V03-010 | [#184](https://github.com/Yijtu/ontology/issues/184) | A | #183 |
| V03-011 | [#180](https://github.com/Yijtu/ontology/issues/180) | A | #177、#178、#176 |
| V03-012 | [#185](https://github.com/Yijtu/ontology/issues/185) | A | #183、#184、#180 |
| V03-013 | [#182](https://github.com/Yijtu/ontology/issues/182) | A | #179、#180 |
| V03-014 | [#186](https://github.com/Yijtu/ontology/issues/186) | A | #183、#184、#182 |
| V03-015 | [#187](https://github.com/Yijtu/ontology/issues/187) | A | #174、#184、#186 |
| V03-016 | [#189](https://github.com/Yijtu/ontology/issues/189) | A | #174、#187 |
| V03-017 | [#190](https://github.com/Yijtu/ontology/issues/190) | A | #175、#178、#189 |
| V03-018 | [#192](https://github.com/Yijtu/ontology/issues/192) | A | #189、#190 |
| V03-019 | [#191](https://github.com/Yijtu/ontology/issues/191) | A | #178、#189 |
| V03-020 | [#193](https://github.com/Yijtu/ontology/issues/193) | A | #189、#190、#192、#191、#176 |
| V03-021 | [#202](https://github.com/Yijtu/ontology/issues/202) | A | #185、#182、#186、#187、#189、#176、#188、#201 |
| V03-022 | [#176](https://github.com/Yijtu/ontology/issues/176) | A | #173 |
| V03-023 | [#194](https://github.com/Yijtu/ontology/issues/194) | A | #173、#184、#189、#192 |
| V03-024 | [#196](https://github.com/Yijtu/ontology/issues/196) | A | #179、#187、#194 |
| V03-025 | [#199](https://github.com/Yijtu/ontology/issues/199) | A | #192、#194、#196 |
| V03-026 | [#188](https://github.com/Yijtu/ontology/issues/188) | A | #173、#184、#186 |
| V03-027 | [#195](https://github.com/Yijtu/ontology/issues/195) | A | #188、#192 |
| V03-028 | [#197](https://github.com/Yijtu/ontology/issues/197) | A | #188、#195 |
| V03-029 | [#200](https://github.com/Yijtu/ontology/issues/200) | A | #197、#178、#187 |
| V03-030 | [#198](https://github.com/Yijtu/ontology/issues/198) | A | #173、#194 |
| V03-031 | [#201](https://github.com/Yijtu/ontology/issues/201) | A | #194、#198 |
| V03-032 | [#203](https://github.com/Yijtu/ontology/issues/203) | A | #173、#174、#194、#201 |
| V03-033 | [#204](https://github.com/Yijtu/ontology/issues/204) | A | #203、#199、#201、#198 |
| V03-034 | [#205](https://github.com/Yijtu/ontology/issues/205) | A | #199、#200、#191、#203、#198 |
| V03-035 | [#206](https://github.com/Yijtu/ontology/issues/206) | A | #204、#205、#197、#198 |
| V03-036 | [#207](https://github.com/Yijtu/ontology/issues/207) | A | #204、#205、#206 |
| V03-037 | [#208](https://github.com/Yijtu/ontology/issues/208) | A | #196、#199、#200、#201、#207 |
| V03-038 | [#209](https://github.com/Yijtu/ontology/issues/209) | A | #196、#199、#200、#201、#207 |
| V03-039 | [#211](https://github.com/Yijtu/ontology/issues/211) | A | #208、#209、#206 |
| V03-040 | [#212](https://github.com/Yijtu/ontology/issues/212) | A | #193、#203、#207、#208、#209、#211 |
| V03-041 | [#214](https://github.com/Yijtu/ontology/issues/214) | A | #203、#206、#211、#212 |
| V03-042 | [#216](https://github.com/Yijtu/ontology/issues/216) | A | #185、#182、#193、#202、#212、#214 |
| V03-043 | [#215](https://github.com/Yijtu/ontology/issues/215) | A | #192、#199、#195、#197、#212 |
| V03-044 | [#213](https://github.com/Yijtu/ontology/issues/213) | A | #208、#209、#211、#201 |
| V03-045 | [#217](https://github.com/Yijtu/ontology/issues/217) | A | #169、#173、#174、#177、#175、#178、#179、#181、#183、#184、#180、#185、#182、#186、#187、#189、#190、#192、#191、#193、#202、#176、#194、#196、#199、#188、#195、#197、#200、#201、#203、#204、#205、#206、#207、#208、#209、#211、#212、#214、#216、#215、#213 |
| V03-046 | [#210](https://github.com/Yijtu/ontology/issues/210) | A | #179、#181、#186、#191、#196、#207 |
| V03-047 | [#218](https://github.com/Yijtu/ontology/issues/218) | A | #217、#210 |
| V03-048 | [#170](https://github.com/Yijtu/ontology/issues/170) | B | 无 |
| V03-049 | [#171](https://github.com/Yijtu/ontology/issues/171) | B | 无 |
| V03-050 | [#172](https://github.com/Yijtu/ontology/issues/172) | B | 无 |
| V03-051 | [#219](https://github.com/Yijtu/ontology/issues/219) | B | #218 |
| V03-052 | [#220](https://github.com/Yijtu/ontology/issues/220) | B | #219、#170 |
| V03-053 | [#221](https://github.com/Yijtu/ontology/issues/221) | B | #219、#171、#220 |
| V03-054 | [#223](https://github.com/Yijtu/ontology/issues/223) | B | #219、#171、#220、#221 |
| V03-055 | [#222](https://github.com/Yijtu/ontology/issues/222) | B | #219、#220 |
| V03-056 | [#224](https://github.com/Yijtu/ontology/issues/224) | B | #222 |
| V03-057 | [#225](https://github.com/Yijtu/ontology/issues/225) | B | #221、#224 |
| V03-058 | [#228](https://github.com/Yijtu/ontology/issues/228) | B | #220、#223、#222、#225 |
| V03-059 | [#230](https://github.com/Yijtu/ontology/issues/230) | B | #228 |
| V03-060 | [#226](https://github.com/Yijtu/ontology/issues/226) | B | #219、#222、#224 |
| V03-061 | [#229](https://github.com/Yijtu/ontology/issues/229) | B | #221、#225、#226 |
| V03-062 | [#231](https://github.com/Yijtu/ontology/issues/231) | B | #228、#230、#226、#229 |
| V03-063 | [#233](https://github.com/Yijtu/ontology/issues/233) | B | #230、#231 |
| V03-064 | [#234](https://github.com/Yijtu/ontology/issues/234) | B | #230、#231 |
| V03-065 | [#232](https://github.com/Yijtu/ontology/issues/232) | B | #172、#230 |
| V03-066 | [#235](https://github.com/Yijtu/ontology/issues/235) | B | #231、#232 |
| V03-067 | [#236](https://github.com/Yijtu/ontology/issues/236) | B | #228、#231、#232 |
| V03-068 | [#237](https://github.com/Yijtu/ontology/issues/237) | B | #222、#228、#232 |
| V03-069 | [#238](https://github.com/Yijtu/ontology/issues/238) | B | #220、#221、#223、#222、#224、#225、#228、#230、#226、#229、#231、#233、#234、#232、#235、#236、#237 |
| V03-070 | [#227](https://github.com/Yijtu/ontology/issues/227) | B | #171、#223 |
| V03-071 | [#239](https://github.com/Yijtu/ontology/issues/239) | B | #171、#172、#238、#227 |
| V03-072 | [#240](https://github.com/Yijtu/ontology/issues/240) | B | #238、#239 |

## 文档与执行规则

- [prd-generic-assistants-core-v0.3.md](../../../tasks/prd-generic-assistants-core-v0.3.md)
- [prd-ontology-and-business-assistants-v0.3.md](../../../tasks/prd-ontology-and-business-assistants-v0.3.md)
- [spec-generic-assistants-core-v0.3.md](../../../tasks/spec-generic-assistants-core-v0.3.md)
- [asset-data-ui.md](../../../tasks/spec-v0.3a/asset-data-ui.md)
- [execution-evidence.md](../../../tasks/spec-v0.3a/execution-evidence.md)
- [spec-electrical-costing-mvp-v0.3.md](../../../tasks/spec-electrical-costing-mvp-v0.3.md)
- [逐项需求／计划测试覆盖](coverage.md)：每个 AC 和 FR 都有 SPEC、任务、计划测试。
- [权威任务 manifest](manifest.json)：依赖、阶段、初始就绪、源文件 SHA256 和真实远程编号字段。
- [实施交接](handoff.md)：main 退出/场景进入、就绪与 loop-it 衔接。

表中“等待”是实施依赖状态；本轮只写规格和任务，不把任何代码任务标 completed。真实模型质量、系统核验、真实客户业务接受和 MVP 验收分别记录。

## A：通用 Core → main

| 任务 | 内容 | 类型／优先级 | 依赖 | 初始就绪 |
| --- | --- | --- | --- | --- |
| [V03-001](issues/core/issue-001-baseline-wip-audit.md) | 核对主线、WIP 与旧任务，冻结本批实施基线 | infra / P0 | 无 | 可核对基线 |
| [V03-002](issues/core/issue-002-public-contracts.md) | 扩展公共 Schema、版本引用与挂载契约 | backend / P0 | V03-001 | 等待依赖 |
| [V03-003](issues/core/issue-003-control-stores.md) | 新增工作区与项目修订的持久端口和追加迁移 | backend / P1 | V03-002 | 等待依赖 |
| [V03-004](issues/core/issue-004-workspace-api.md) | 实现行业工作区、草稿修订与管理 API | backend / P1 | V03-003 | 等待依赖 |
| [V03-005](issues/core/issue-005-structured-parser.md) | 实现 CSV/XLSX 有界解析与单元格来源 | backend / P1 | V03-002 | 等待依赖 |
| [V03-006](issues/core/issue-006-ingestion-coverage.md) | 接通解析 Job、行对账、重试与修订回读 | backend / P1 | V03-003、V03-005 | 等待依赖 |
| [V03-007](issues/core/issue-007-schema-extraction.md) | 将固定行业 Schema 注入抽取并保留精确值 | backend / P1 | V03-002、V03-006 | 等待依赖 |
| [V03-008](issues/core/issue-008-tbox-candidates.md) | 实现从资料生成本体定义候选的服务 | backend / P1 | V03-004、V03-006、V03-007 | 等待依赖 |
| [V03-009](issues/core/issue-009-definition-edit-validation.md) | 实现定义编辑、术语消歧与兼容性校验 | backend / P1 | V03-008 | 等待依赖 |
| [V03-010](issues/core/issue-010-rule-action-candidates.md) | 实现规则与动作候选、支持校验和能力绑定 | backend / P1 | V03-009 | 等待依赖 |
| [V03-011](issues/core/issue-011-workspace-source-ui.md) | 实现本体工作区首页、创建与资料操作前端 | frontend / P1 | V03-004、V03-006、V03-022 | 等待依赖 |
| [V03-012](issues/core/issue-012-definition-editor-ui.md) | 实现定义、规则、动作编辑审核工作台 | frontend / P1 | V03-009、V03-010、V03-011 | 等待依赖 |
| [V03-013](issues/core/issue-013-instance-review-ui.md) | 补齐公共实例身份裁决与关键字段确认流程 | fullstack / P1 | V03-007、V03-011 | 等待依赖 |
| [V03-014](issues/core/issue-014-synthetic-validation.md) | 建立隔离合成实例与行业验证服务 | backend / P1 | V03-009、V03-010、V03-013 | 等待依赖 |
| [V03-015](issues/core/issue-015-dynamic-pack-publish.md) | 接通行业包发布、动态目录与不可变导出 | backend / P0 | V03-003、V03-010、V03-014 | 等待依赖 |
| [V03-016](issues/core/issue-016-project-bindings.md) | 实现客户项目、版本挂载与修订服务 | backend / P1 | V03-003、V03-015 | 等待依赖 |
| [V03-017](issues/core/issue-017-project-mapping.md) | 实现列映射确认、单位规范与项目记录绑定 | backend / P1 | V03-005、V03-006、V03-016 | 等待依赖 |
| [V03-018](issues/core/issue-018-query-projection.md) | 将批准项目数据物化到可查询固定快照 | backend / P0 | V03-016、V03-017 | 等待依赖 |
| [V03-019](issues/core/issue-019-document-index.md) | 实现项目文档 BM25 索引与修订撤回可见性 | backend / P1 | V03-006、V03-016 | 等待依赖 |
| [V03-020](issues/core/issue-020-project-data-ui.md) | 实现项目、资料映射与就绪状态公共前端 | frontend / P1 | V03-016、V03-017、V03-018、V03-019、V03-022 | 等待依赖 |
| [V03-021](issues/core/issue-021-package-publish-ui.md) | 实现包验证发布、导出与项目挂载前端 | frontend / P1 | V03-012、V03-013、V03-014、V03-015、V03-016、V03-022、V03-026、V03-031 | 等待依赖 |
| [V03-022](issues/core/issue-022-frontend-mount.md) | 实现公共双助手骨架与场景视图挂载端口 | frontend / P1 | V03-002 | 等待依赖 |
| [V03-023](issues/core/issue-023-task-input-artifacts.md) | 实现版本化任务绑定、输入快照与策略预检 | backend / P1 | V03-002、V03-010、V03-016、V03-018 | 等待依赖 |
| [V03-024](issues/core/issue-024-nl-plan-receipts.md) | 补齐 NL 路由、澄清与固定规划回执 | backend / P0 | V03-007、V03-015、V03-023 | 等待依赖 |
| [V03-025](issues/core/issue-025-semantic-sql-query.md) | 装配项目语义与 SQL 查询正常工具路径 | backend / P1 | V03-018、V03-023、V03-024 | 等待依赖 |
| [V03-026](issues/core/issue-026-finite-rule-boolean.md) | 实现有限不同条件 OR、AND 与例外规则契约 | backend / P1 | V03-002、V03-010、V03-014 | 等待依赖 |
| [V03-027](issues/core/issue-027-relation-navigation.md) | 提取通用关系导航并支持一跳关系前提 | backend / P1 | V03-026、V03-018 | 等待依赖 |
| [V03-028](issues/core/issue-028-incremental-rule-state.md) | 补齐三层无环规则依赖、增量物化与时态回读 | backend / P1 | V03-026、V03-027 | 等待依赖 |
| [V03-029](issues/core/issue-029-rule-source-provenance.md) | 贯通规则结论、前提与规范原文 span 的证据链 | backend / P1 | V03-028、V03-006、V03-015 | 等待依赖 |
| [V03-030](issues/core/issue-030-task-validation-policies.md) | 实现注册任务策略、核验报告与无环最终关联 | backend / P0 | V03-002、V03-023 | 等待依赖 |
| [V03-031](issues/core/issue-031-compute-execution.md) | 装配注册 Compute、实现版本与不可变结果工件 | backend / P0 | V03-023、V03-030 | 等待依赖 |
| [V03-032](issues/core/issue-032-answer-v3-artifacts.md) | 新增 answer@3、表工件 manifest 与分页读取契约 | backend / P1 | V03-002、V03-003、V03-023、V03-031 | 等待依赖 |
| [V03-033](issues/core/issue-033-quantity-table-verifier.md) | 实现数值、货币与分批全表绑定硬核验 | backend / P0 | V03-032、V03-025、V03-031、V03-030 | 等待依赖 |
| [V03-034](issues/core/issue-034-typed-evidence-verifier.md) | 核验规则、关系、查询与原文引用的 typed 断言 | backend / P0 | V03-025、V03-029、V03-019、V03-032、V03-030 | 等待依赖 |
| [V03-035](issues/core/issue-035-publication-validity.md) | 扩展全部证据的发布有效性与事务 fence | backend / P0 | V03-033、V03-034、V03-028、V03-030 | 等待依赖 |
| [V03-036](issues/core/issue-036-typed-draft-writer.md) | 完成跨结果类型的最终草稿与有界修复 | backend / P0 | V03-033、V03-034、V03-035 | 等待依赖 |
| [V03-037](issues/core/issue-037-template-host.md) | 接通 Template 的正常 NL/固定任务运行链 | backend / P0 | V03-024、V03-025、V03-029、V03-031、V03-036 | 等待依赖 |
| [V03-038](issues/core/issue-038-pi-host-loop.md) | 在 Core 正常入口装配 Pi 有界补证运行时 | backend / P0 | V03-024、V03-025、V03-029、V03-031、V03-036 | 等待依赖 |
| [V03-039](issues/core/issue-039-run-lifecycle.md) | 完善计划/循环的预算取消、澄清与检查点恢复 | backend / P0 | V03-037、V03-038、V03-035 | 等待依赖 |
| [V03-040](issues/core/issue-040-business-results-ui.md) | 实现业务任务、typed 结果与来源公共工作台 | frontend / P1 | V03-020、V03-032、V03-036、V03-037、V03-038、V03-039 | 等待依赖 |
| [V03-041](issues/core/issue-041-history-json-export.md) | 完成结果修订历史与已核验 JSON 导出 | fullstack / P1 | V03-032、V03-035、V03-039、V03-040 | 等待依赖 |
| [V03-042](issues/core/issue-042-public-ui-states.md) | 补齐公共助手的权限、未就绪与错误恢复状态 | frontend / P1 | V03-012、V03-013、V03-020、V03-021、V03-040、V03-041 | 等待依赖 |
| [V03-043](issues/core/issue-043-industry-backend-conformance.md) | 验证两行业、两 mapping 与两业务 SQL 后端 | infra / P1 | V03-018、V03-025、V03-027、V03-028、V03-040 | 等待依赖 |
| [V03-044](issues/core/issue-044-runtime-transport-conformance.md) | 验证两 runtime 与本地/真实 MCP 替换 | infra / P1 | V03-037、V03-038、V03-039、V03-031 | 等待依赖 |
| [V03-045](issues/core/issue-045-generic-browser-e2e.md) | 实现通用双助手整栈浏览器 E2E 与关键反例 | infra / P0 | V03-001、V03-002、V03-003、V03-004、V03-005、V03-006、V03-007、V03-008、V03-009、V03-010、V03-011、V03-012、V03-013、V03-014、V03-015、V03-016、V03-017、V03-018、V03-019、V03-020、V03-021、V03-022、V03-023、V03-024、V03-025、V03-026、V03-027、V03-028、V03-029、V03-031、V03-032、V03-033、V03-034、V03-035、V03-036、V03-037、V03-038、V03-039、V03-040、V03-041、V03-042、V03-043、V03-044 | 等待依赖 |
| [V03-046](issues/core/issue-046-model-quality-evidence.md) | 固定建模/提参评测集与真实模型就绪报告 | infra / P1 | V03-007、V03-008、V03-014、V03-019、V03-024、V03-036 | 等待依赖 |
| [V03-047](issues/core/issue-047-main-release-gate.md) | 完成通用独立审查、README 与 main 基线交付 | infra / P0 | V03-045、V03-046 | 等待依赖 |

## B：造价专属分支

| 任务 | 内容 | 类型／优先级 | 依赖 | 初始就绪 |
| --- | --- | --- | --- | --- |
| [V03-048](issues/costing/issue-048-scope-discovery.md) | 确认桥架报价的输入、品类、费用与图纸覆盖 | discovery / P0 | 无 | 可收集资料；外部待确认 |
| [V03-049](issues/costing/issue-049-authority-discovery.md) | 确认权威报价函数、价格版本与复用权限 | discovery / P0 | 无 | 可收集资料；外部待确认 |
| [V03-050](issues/costing/issue-050-gold-acceptance-discovery.md) | 取得配对人工报价、比较口径与授权验收人 | discovery / P0 | 无 | 可收集资料；外部待确认 |
| [V03-051](issues/costing/issue-051-accepted-main-sync.md) | 同步已验收 main 并完成造价分支兼容门槛 | infra / P0 | V03-047 | 等待依赖 |
| [V03-052](issues/costing/issue-052-industry-package.md) | 通过本体助手生成审核桥架行业包与动作声明 | domain / P1 | V03-051、V03-048 | 等待依赖 |
| [V03-053](issues/costing/issue-053-price-snapshots.md) | 实现版本化价表、授权补价与项目采用接口 | backend / P1 | V03-051、V03-049、V03-052 | 等待依赖 |
| [V03-054](issues/costing/issue-054-customer-quotation-adapter.md) | 实现可替换报价端口与两种合成适配的契约套件 | backend / P1 | V03-051、V03-049、V03-052、V03-053 | 等待依赖 |
| [V03-055](issues/costing/issue-055-quote-input-snapshots.md) | 实现桥架清单映射与不可变报价输入 | backend / P1 | V03-051、V03-052 | 等待依赖 |
| [V03-056](issues/costing/issue-056-specification-confirmation.md) | 实现规格、数量、单位与必需字段确认校验 | backend / P1 | V03-055 | 等待依赖 |
| [V03-057](issues/costing/issue-057-pricing-context.md) | 实现费用范围、税费、舍入与计价就绪策略 | backend / P1 | V03-053、V03-056 | 等待依赖 |
| [V03-058](issues/costing/issue-058-quote-task-operation.md) | 将 costing.quote 接入公共 task、compute 与正常报价入口 | backend / P0 | V03-052、V03-054、V03-055、V03-057 | 等待依赖 |
| [V03-059](issues/costing/issue-059-quote-policy-evidence.md) | 实现报价输入结果策略、金额证据与完整发布门槛 | backend / P0 | V03-058 | 等待依赖 |
| [V03-060](issues/costing/issue-060-costing-input-ui.md) | 挂载桥架资料、清单与专业参数确认页面 | frontend / P1 | V03-051、V03-055、V03-056 | 等待依赖 |
| [V03-061](issues/costing/issue-061-pricing-ui.md) | 实现价源、计价口径与缺价修复专业界面 | frontend / P1 | V03-053、V03-057、V03-060 | 等待依赖 |
| [V03-062](issues/costing/issue-062-quotation-workbench.md) | 实现已核验逐项报价、费用范围与业务状态工作台 | frontend / P1 | V03-058、V03-059、V03-060、V03-061 | 等待依赖 |
| [V03-063](issues/costing/issue-063-quotation-provenance-ui.md) | 实现金额、规格、价格规则与函数版本的逐项溯源 | frontend / P1 | V03-059、V03-062 | 等待依赖 |
| [V03-064](issues/costing/issue-064-quotation-export.md) | 实现与已核验版本一致的 XLSX 和 JSON 报价导出 | fullstack / P1 | V03-059、V03-062 | 等待依赖 |
| [V03-065](issues/costing/issue-065-comparison-review-service.md) | 实现配对比较、业务签核与行业反馈提案服务 | backend / P1 | V03-050、V03-059 | 等待依赖 |
| [V03-066](issues/costing/issue-066-comparison-review-ui.md) | 实现人工差异、接受退回与资产反馈专业界面 | frontend / P1 | V03-062、V03-065 | 等待依赖 |
| [V03-067](issues/costing/issue-067-requote-lifecycle.md) | 完成重报价、版本差异、取消与 unknown 恢复闭环 | fullstack / P1 | V03-058、V03-062、V03-065 | 等待依赖 |
| [V03-068](issues/costing/issue-068-client-mapping-conformance.md) | 验证两个客户结构映射与独立报价对照测试 | infra / P1 | V03-055、V03-058、V03-065 | 等待依赖 |
| [V03-069](issues/costing/issue-069-costing-browser-e2e.md) | 完成造价双助手正常入口的合成整栈浏览器 E2E | infra / P0 | V03-052、V03-053、V03-054、V03-055、V03-056、V03-057、V03-058、V03-059、V03-060、V03-061、V03-062、V03-063、V03-064、V03-065、V03-066、V03-067、V03-068 | 等待依赖 |
| [V03-070](issues/costing/issue-070-real-customer-adapter.md) | 实现并核对已授权的真实客户报价适配器 | backend / P0 | V03-049、V03-054 | 等待依赖 |
| [V03-071](issues/costing/issue-071-real-customer-acceptance.md) | 完成真实模型、权威函数与保留样本的业务验收 | validation / P0 | V03-049、V03-050、V03-069、V03-070 | 等待依赖 |
| [V03-072](issues/costing/issue-072-costing-mvp-closeout.md) | 完成造价 MVP 使用文档、交接与最终交付门槛 | infra / P0 | V03-069、V03-071 | 等待依赖 |

## 并行层次

以下由依赖图生成；同层可并行不代表当前已经 ready，外部进入条件仍有效。

- 第 1 层：V03-001、V03-048、V03-049、V03-050
- 第 2 层：V03-002
- 第 3 层：V03-003、V03-005、V03-022
- 第 4 层：V03-004、V03-006
- 第 5 层：V03-007、V03-011
- 第 6 层：V03-008、V03-013
- 第 7 层：V03-009
- 第 8 层：V03-010
- 第 9 层：V03-012、V03-014
- 第 10 层：V03-015、V03-026
- 第 11 层：V03-016
- 第 12 层：V03-017、V03-019
- 第 13 层：V03-018
- 第 14 层：V03-020、V03-023、V03-027
- 第 15 层：V03-024、V03-028、V03-030
- 第 16 层：V03-025、V03-029、V03-031
- 第 17 层：V03-021、V03-032
- 第 18 层：V03-033、V03-034
- 第 19 层：V03-035
- 第 20 层：V03-036
- 第 21 层：V03-037、V03-038、V03-046
- 第 22 层：V03-039
- 第 23 层：V03-040、V03-044
- 第 24 层：V03-041、V03-043
- 第 25 层：V03-042
- 第 26 层：V03-045
- 第 27 层：V03-047
- 第 28 层：V03-051
- 第 29 层：V03-052
- 第 30 层：V03-053、V03-055
- 第 31 层：V03-054、V03-056
- 第 32 层：V03-057、V03-060、V03-070
- 第 33 层：V03-058、V03-061
- 第 34 层：V03-059
- 第 35 层：V03-062、V03-065
- 第 36 层：V03-063、V03-064、V03-066、V03-067、V03-068
- 第 37 层：V03-069
- 第 38 层：V03-071
- 第 39 层：V03-072
