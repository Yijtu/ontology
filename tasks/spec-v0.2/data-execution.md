# v0.2 数据、语义与执行规范

入口：[总 SPEC](../spec-industry-semantic-agent-v0.2.md)｜线协议：[契约分册](contracts-api.md)。状态和表名为目标设计，不表示已有迁移。

## D1. 控制库与数据边界

控制库采用 PostgreSQL 专用 schema `agent_platform`。所有客户记录使用复合键 `(tenant_id, space_id, id)`，子记录 FK 同样带 tenant/space；行业公共定义使用独立发布区，通过授权安装复制/引用，不用省略 tenant 的混合查询实现共享。

类型约定：id UUID；版本/内容 hash TEXT；时间 TIMESTAMPTZ（UTC）；有效区间半开 `[from,to)`；金额/精确物理量 NUMERIC 或 JSON 十进制字符串+unit；结构化草稿/定义 JSONB；大结果只存 blob_ref。HTTP 中大整数 revision 使用十进制字符串，避免 JS 精度丢失。

模型生成内容和原文是数据；运行状态、审核、权限由服务控制。生产 app role 不应为 table owner/superuser，RLS 作为应用过滤之外的一层保护；连接池事务内设置可信 tenant context 并清理，不能让上个请求的身份泄漏。后台全局调度只读任务元数据，领取任务后进入对应 tenant 的事务。

## D2. 目标表族与索引

| 表族 | 主字段/唯一性 | 索引与用途 |
|---|---|---|
| component_versions | kind/id/version/digest、manifest、trust/status | unique kind/id/version；相同版本不同 digest 拒绝 |
| profile_versions / profile_active | profile id/version、resolved manifest/hash、revision | unique profile/version；激活指针 CAS |
| source_bindings / source_versions | adapterRef、secretRef、scope/mapping、schema digest、capabilities | 按客户/角色/source 查，模型不可读 secret |
| artifacts / document_versions / chunks | content hash、storage ref、page/offset、normalization map、index generation | tenant-scoped content dedup；document+version+ordinal |
| jobs / job_attempts / outbox | pipeline version、stage、lease、attempt、input digest、next-at | stage idempotency unique；status/next-at/lease 索引 |
| candidates / model_calls | candidate kind/value/source spans、parser/prompt/model版本、usage、state | job/status/type；调用与候选分开，可追踪多次输出 |
| entities / identity_assertions / identity_decisions | stable ID/type、source native ID、alias/negative、valid interval、decision evidence | typed scoped identity key；原始别名及归一形态检索 |
| explicit_assertion_versions | logical assertion ID、subject/predicate/value/qualifiers、source、valid range、recorded_seq、op | subject/predicate/time；同来源重试的幂等键 |
| rule_versions | rule ID/version、typed AST、source、review、valid range、recorded_seq | namespace/predicate/dependency；版本不可覆写 |
| derived_claims / justification_versions / dependency_edges | proposition key、ruleRef、support expression、version、input refs | premise→support / support→claim 两向索引 |
| semantic_events / projection_state / projection_slices | per-space seq、event payload、effective interval、watermark/dirty | seq唯一；scope/predicate/entity分区查询 |
| runs / run_events / steps / runtime_checkpoints | profile hash、state、revision、event seq、checkpoint blob+sdkVersion | run/event sequence；If-Match修订；按状态调度 |
| budget_ledger / tool_attempts | reservations、limits、actual/unknown usage、logical call id | 原子额度预留；run/call/attempt唯一 |
| evidence / evidence_edges | evidence kind、source snapshot、result digest、execution/rule refs | id/hash、反向依赖；权限与来源同域 |
| drafts / verifications / answers | draft hash、evidence manifest hash、verdict、published version | 一个 answer 引用确切 verification，禁止直接改正文 |

各表都有 created_at/actor/request_id；人工更改另存原因。索引首期按实际访问模式创建，不因“可扩展”给所有 JSONB 字段建索引。遥测和业务大表留在业务后端，不混入上述控制表。

### D2.1 最小 DDL 约束示意

```sql
-- 规格片段，不是本轮要执行的迁移。
CREATE TABLE agent_platform.answers (
  tenant_id uuid NOT NULL,
  space_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  verification_id uuid NOT NULL,
  content_hash text NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, space_id, id)
  -- 实际 migration 加同域 run/draft/verification FK。
);
CREATE UNIQUE INDEX answer_one_version_per_verification
  ON agent_platform.answers (tenant_id, space_id, verification_id);
```

发布服务在同一事务检查 verification.draft_hash/content_hash 与 evidence manifest 匹配、verdict允许、run未取消、权限仍有效及投影水位。数据库 FK 保证同域关系，应用事务保证业务条件；不能只凭模型返回 `pass` 插入答案。

## D3. 时间、版本与来源

### D3.1 双时间语义

- `valid_from/to`：业务事实在哪段现实时间成立。
- `recorded_seq/recorded_at`：平台何时获知该版本。
- 同一 logical assertion 的更正/撤回是新事件，作用范围为显式给定有效区间；历史 payload 不覆盖。
- asOfRecordedSeq + validAt 共同决定视图。每个 logical assertion，在所选系统版本内选覆盖 validAt 的最新更正；撤回 tombstone 表示该区间没有当前支持。部分区间更正不抹掉其他区间；投影可拆片，权威事件保持追加。
- 旧版本查询不能读取后来才获知的别名、规则或来源。源不支持永久快照时保留当次查询结果工件，说明“执行时观察结果”而非可重建全源库。

未来生效/到期也是变化：发布时登记边界任务，时间到达触发投影推进；不能只监听数据库写入而遗漏自然到期。家庭能源 forecast 的发布时刻、目标时窗、实际观测时间三者分别存储。

### D3.2 来源定位与去重

文档定位包含 document_version、page 或 offset、原始/规范化文本的对应、quote digest；不得仅用模型生成的引用标题。OCR 后无法精确定位时标 approximate_locator 并进入待核对，不能声称精确页内证据。

内容 hash 去重在客户域内执行，避免跨客户存在性泄漏。复制件归入共同 source lineage；多个页面重复同一声明不代表独立证据。模型结果记录 input/prompt/model/schema/parser版本和完成状态，必要敏感正文存受限工件而非普通日志。

## D4. 抽取与消歧

1. **解析**：文件类型识别、文本层/OCR适配、章节/条款/表格分块；保留否定、例外和跨页上下文。
2. **抽取**：GenerationPort 按已发布行业 schema 产出 candidate；schema扩展单独提议，不直接造新 canonical type。
3. **确定性校验**：类型/单位/值域/关系端点、原文定位存在、规则 AST可表达；结果记录 coverage，截断不得视为全文已处理。
4. **候选召回**：scope/type/native ID→已确认别名→时间/地点/上下文→可选相似召回。分层记录 recall evidence，不对全库做 pairwise LLM 匹配。
5. **裁决**：强身份条件或人工证据允许 match；新实体 candidate 有独立暂存 ID；不确定进入 clarify；cannot-link 或身份冲突阻止发布。LLM/JEV可供辅助分数，不能直接触发无条件合并。
6. **发布**：按类型策略自动/人工批准，事务提交版本、身份约束、事实/规则事件和 outbox。重试同批次输入及批准版本不重复写入。

设备 native ID 的唯一性需带数据源/站点/类型命名空间；传感器属于设备不等于与设备同一。entity 名称和临时设备地址不作为永久键。更换设备可产生新 entity + time-bounded mapping，不覆写所有历史关系。

增量身份合并首期使用受限 must-link/cannot-link 校验和一致簇，不要求通用最优聚类。若合并产生冲突，整组进入 review，不任意丢负例。纠正合并要能分离来源记录并使下游实体绑定/结论失效，保留历史决策。

实体关系图、证据依赖图、运行事件图独立建模。路径可达不自动表示两实体同一或因果关系；分析“影响”时必须说明依据的是业务关系还是实际推导依赖。

## D5. 规则与派生事实

规则 AST 第一版支持 typed `all/any`、明确属性比较、数值区间和已确认关系查询。否定只针对显式观察值或声明了完备范围的条件；未找到数据默认 unknown，不能自动 false。领域约束返回 satisfied/not_satisfied/unknown/conflict。不支持的循环/递归/聚合否定拒绝发布，不降级成宽松规则。

原始断言与派生记录分别存储；同 proposition 可有多个来源断言或多个推导。proposition key 包含主体、谓词、值、单位、时间/范围等语义限定，不能只按字段名合并。

支撑表达式保留 AND/OR DAG：一个 rule justification 需要若干 premise groups，每组可有多个等价有效来源。避免枚举所有来源组合的笛卡尔积；业务上不同规则路径仍为独立 justification。解释时可挑选有代表性的依据，必须保留“还有其他依据”的完整性提示。

```text
publish(change):
  append semantic event + update invalidation fence + enqueue outbox atomically
  worker finds affected identity/assertion/rule scopes through dependency indexes
  invalidate affected support expressions for effective intervals
  reevaluate remaining supports and affected rule outputs in dependency order
  write new projection generation + advance watermark atomically per scope
```

撤回一前提使依赖它的支撑失效；其他有效支撑存在则结论保留。所有支撑消失才从当前有效结果撤出。新增事实造成冲突也会失效原来单值判断，不能只做“新增推导”。循环自我支撑不能凭空成立。

依赖可能尚未建边：规则谓词→候选实体范围也需索引，新增符合规则的事实才能触发此前不存在的推导。规则更新、identity mapping变化、有效时间边界均为触发器。

### D5.1 更新与查询并发

发布事务先设置 invalidation fence，再把事件交给 Worker。读取服务检查请求版本、相关投影水位和 dirty范围；未计算完时返回 pending/stale，或只返回不受影响的明确部分。fan-out 很大、受影响集合尚未穷尽时，保守标记整个相关 scope 为 dirty，不能在队列积压时继续把旧派生视作当前。

按需求值与后台物化共用 RuleEvaluator 与版本输入；区别只在是否持久化结果投影。缓存包含语义版本、数据水位、规则、时间区间与授权scope。历史查询可以显式读取旧 generation，不和当前 dirty 状态混淆。

## D6. 作业与幂等

Job key：tenant/space + source/document version + pipeline/parser/schema/model/prompt version + stage。相同逻辑 job 的 attempt单独记录；模型输出不同可产生候选版本，但发布时以批准candidate版本唯一化。

PostgreSQL jobs + transactional outbox 为首个实现，Worker 使用租约/心跳与 `FOR UPDATE SKIP LOCKED` 领取；租约过期可重领。语义是至少一次执行、幂等提交，不宣称外部模型调用恰好一次。文件工件先暂存/校验再发布引用，垃圾暂存独立回收。

模型429/暂时网络错误有限退避，工具错误与候选业务错误区别处理。人工未决状态不自动无限重跑。批量作业可部分成功，状态统计准确，未处理项不计完成。

## D7. 运行控制、预算与草稿

### D7.1 运行启动

验证身份/资源范围→解析profile→preflight→保存resolved manifest→初始化预算和run事件→选择template/Pi→执行。JEV仅在确实存在路线歧义时使用，不为每个确定步骤强加决策调用。

规划器输出的计划是候选：每步只引用白名单工具、typed args和上游证据。controller/gateway拒绝未绑定能力、循环计划、未来不可知参数伪装成已知值和无界结果。不因计划合法就绕过每次运行时检查。

### D7.2 并发预算

预算在控制库原子预留；并发工具/模型调用在发起前消耗槽位和估算额度。completed结算实际使用；failed/cancelled仍记录已发生用量；usage未知时保守占用到协调，不按零费用处理。后台导入和问答分配额度，不能因导入占满公司API使在线请求饿死。

补查、草稿修复、runtime内部turn和transport重试均使用同一run预算。领域handler不得创建自己的无限模型循环。run deadline传播为剩余时限，不在每个网络请求重新获得完整120秒。

### D7.3 不确定性与停止

同工具 + 规范化参数 + source/semantic版本构成重复键；调用相同查询若无明确瞬时错误恢复/新数据理由，则判no-progress。局部正确但证据不足返回有限事实与缺口；候选被截断不能断言“所有”“不存在”。

澄清保存 typed question schema、待确认项与运行检查点。恢复时用户回答不可改主体、白名单或任意指令；若回答改变目标或数据范围，重新preflight并修订计划，预算默认不重置。

### D7.4 AnswerDraft 与核验

Draft结构：`draftId,runId,blocks,claims,evidenceManifest,limitations,contentHash`。claim含标准化值/unit、事实或预测标签、支持的evidenceRefs。表格/图表引用结果数据集及renderer版本；精确数值从结果绑定，不让模型自由抄写后当真值。

verify_result返回 verdict、failedChecks、supportedClaims、missingEvidence、draftHash、evidenceManifestHash、policyVersion；硬检查失败优先于模型评分。可用JEV检查原子语义支撑，但不能用其高分覆盖过期来源/计算失败。

发布前复核权限/当前有效性/fence。若结果在收证后已变旧：不作当前答案发布，返回收证补查或以明确历史时点发布。已发布历史答案不可变，当前查看时可附加“已过期/来源已修正”元状态。

对未提供变更通知或稳定版本的外部来源，平台只能保证标注的读时结果与配置新鲜度，不能保证发布瞬间外部世界未改变。超过 freshness TTL 时重读或降级；没有授权重读时保留历史限定，不声称全局最新。

通过核验的draft原样发布；任何模型重写都创建新draft并重新核验。格式渲染也要保持数据绑定和引用；图上数字与表格数值不一致属于核验失败。有限回答的缺口标识不得在render中被隐藏。

## D8. 数据库版本演进与失败恢复

拟迁移批次：001 tenancy/component/profile；002 source/artifact/job；003 semantic/candidates/identity；004 rules/provenance/projection；005 runs/budgets/answers。FK与RLS覆盖跨表关系；迁移部署与runtime初始化分离，应用启动不擅自建生产表。

本工程从当前数据模型初始化；不建立历史原型导入器、兼容字段或旧 ID 映射。测试夹具由本规格的 D3/D4/D5/D7 契约独立构造，使用本仓库声明的测试 tenant、版本与预期结果。紧凑支撑 DAG 的验收关注有效性与证据语义，不绑定某个旧实现的 proof 数量或记录结构。

回滚应用不删除新事件；schema扩展向后兼容，破坏式变更须版本migration并检查活跃profile。只回滚激活指针影响新运行；旧run若SDK不可用返回显式恢复限制，不能丢失审计。

故障恢复先重放outbox/未完成job，不全库重建每次问答。投影可从事件+检查点重建；重建期间标dirty，不假装完整可用。Blob丢失/hash不符导致证据不可验证，停止相关答案发布。
