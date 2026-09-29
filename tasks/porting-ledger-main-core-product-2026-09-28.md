# main 通用 POC Core donor 回流清单

日期：2026-09-28。目标基线 `main@51c8cb43`，实施分支 `feat/main-core-product-20260928@c542141c`。只读参考 `D:/work/ontology@37f3feb`。donor 工作树含用户未提交的 `issue-048` 改动及其它文件；本清单只记录已提交 donor 与 main 的差异，不把 donor 当可覆盖副本。

## C0 决策

- 不 merge/cherry-pick donor 分支，不做目录级覆盖。逐模块审阅后只移植通用 hunk，并保留 main `51c8cb4` 的 `QueryContextField`/deployment 注入解耦及共享 App 的通用品牌。
- main 当前 control migration 最新为 `051_run_question_rewrite.sql`。donor `052_workflow_manifests.sql` 是通用 workflow state/verification 表及答案正文列，本轮按新审查补上并发 CAS 后可用 `052`；donor `054_identity_recall_audits.sql`、`055_home_energy_simulation_records.sql`、`056_home_energy_plan_versions.sql` 不因 donor 编号较大而照搬，编号冲突检查后只为本轮通用变更追加迁移。
- 不移植能源定义/执行、virtual-solix、能源 UI、能源模拟数据库及能源专属迁移；通用 composition 根据本 SPEC 和独立金标重新装配。
- donor 分支 HEAD `37f3feb` 只有能源表单 null-assertion 的末端小提交；其基线已含下列功能补丁。donor 工作区现有未提交文件没有被读取为实现来源。

## 逐项移植与适配

| 能力 | donor 参考 | 处理决定与本轮限制 |
| --- | --- | --- |
| 已核验答案正文、blocks、claims、typed assertion | `contracts/src/{workflow,verification}.ts`、`answer-store.ts`、`publication.ts`、verification 模块、`052_workflow_manifests.sql` | 选择性移植并采用答案 schema/hash 版本；旧 metadata-only 行保留明确 body-unavailable 语义。补全 rule judgement 的确定性规则工件核验；不得只接受 `kind=rule_judgement` 的候选文字。 |
| PostgreSQL workflow/input manifest、run state、verification persistence | donor `workflow-store.ts` 与 migration 052 | 改为并发安全的 revision/CAS 更新；manifest 与 verification 保持不可变/idempotent。迁移只增加本轮通用表，不带能源对象。主 HTTP host 还需独立持久 dispatch/lease/attempt，donor store 不等价于调度恢复。 |
| canonical idempotency runId | `application/workflow/controller.ts` | Controller 必须使用 `createRun` 返回的 canonical runId，全程查询原 run/manifest/ledger；同幂等请求不能按调用方临时 runId 查找。 |
| 精确数值、单位、时间和非数值核验 | donor `verification/{hard-checks,assertions}.ts`、contracts schema | 移植独立十进制字符串比较、明确单位和 timestamp pointer 校验、quote span/digest 核对。待覆盖错误 subject/unit/time/quote 和跨来源场景；rule judgement 必须绑定确定性计算工件及必要复算。 |
| 已发布 facts、定义 pin、身份簇、关系端点 | `semantic-engine/mapping/published-facts.ts`、identity/publication 变更 | 只借用 provider/身份约束模式；增加属性 statement 到 entity/attribute/value/unit/valid-time/provenance 的投影；按 identity/entity/schema/tenant 隔离。 donor 当前不充分支持实例属性计算，不能将 fail-closed 当完成。 |
| 安全 keyset 分页、materialization/support scan | `semantic-engine/materialization/published-pages.ts`、contracts filters、`published-source.ts`、`support-dependency-source.ts` | 借用游标和 cap 模式；补稳定 snapshot/as-of 或 revision 前后检测并显式 retry/incomplete。不能只声称 keyset cursor 就固定了跨页视图；限制和游标异常不可静默丢规则或支撑。 |
| 抽取 schema 注入 | `application/extraction/extraction-service.ts`、候选 schema/worker 变更 | 采用固定 versioned definition、属性/关系/身份/规则语法作为 generation 输入，并保留 parser span 的后验校验和原始 JSON/native 强键路径。 |
| composition、源配置、导入 UI、任务 runtime、demo 部署 | `apps/api/src/composition/local-product-deployment.ts`、`local-documents.ts`、`query-task-runtime.ts`、`query-tasks.ts`、`apps/web`、`deploy/local/docker-compose.yml` | donor local-product 是固定任务/能源演示装配；不整体移植。local-documents 的每集合单文档约束不适用于通用导入；固定 task runtime 不能覆盖 Template/Pi 的选择能力；published-fact-task 的 100 条结果上限不能充当全量问答。按 main 依赖边界与本 SPEC 重构通用宿主，四工具保持固定目录。 |
| JEV | donor 没有可采纳的真实协议实现；main 现有 `/v1/decide` 与 hash-only `state_ref` 为旧假定 | 依据官方 `/v1/systemone` 协议在 JEV adapter 转换为平台 DecisionPort；从授权有界 resolver 取本 run 实际 state。未配置时明确降级，不调用历史聊天密钥或旧付费 endpoint。 |
| OpenAI-compatible generation codec | main 已实现 | 保留 main adapter，按部署配置启用，不改写为能源固定调用。 |
| PG WorkflowStore 的跨进程运行 | donor `workflow-store.ts` | donor upsert 不带 CAS；不可宣称并发安全。为 workflow counters 使用 revision/CAS，并为 HTTP dispatch 使用有期限 owner/lease/attempt 和恢复；外部副作用采用稳定幂等键，旧 attempt 与取消态不能发布。 |

## 明确不接受的 shortcut

- 未审核候选、published fact/task、RecordingHandler、静态任务结果或已 seed 的 verification/answer 不作为主产品 E2E 数据。
- 数据库查询、ontology lookup、属性投影、规则求值、materializer、硬核验、publication 在主 E2E 必须运行真实实现。只有 generation/decision HTTP 可由受控响应服务驱动。
- 规则 exception 不能被忽略；“规则不适用”与“业务命题为 false”是不同结果。例外成立只移除该规则的正向支撑；其它规则/来源仍可能支持命题，无其它支撑时结果为 unknown。
- 一次逐页 keyset 扫描若跨页 revision 变化、无法确认 snapshot、超过 cap 或遇无进展游标，必须返回显式不完整/重试，不能继续重算并宣称完整。
- 控制存储、客户 query DB、local/MCP、行业定义/物理 mapping/runtime 保持可替换；两场景不通过 core/application 的业务 ID 分支实现。

## C0 状态

已审阅 main/donor 提交、迁移目录及主要差异；本文件记录选择性回流边界。尚未声称任何 C1—C5 业务验收通过。
