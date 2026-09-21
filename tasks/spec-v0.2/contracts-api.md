# v0.2 组件、工具与 API 契约

规范入口：[总 SPEC](../spec-industry-semantic-agent-v0.2.md)。以下为待实现的线协议/类型设计，不是已经可调用接口。

## C1. 契约与装配

Canonical JSON Schema 为跨进程契约，TypeScript 类型从同一份 schema 生成，CI 检查一致；不把 Zod/SDK 内部类作为公共协议。时间统一 RFC3339 UTC，用户/计费时区单独保存 IANA 名称；UUID 表示内部资源，来源 ID 保持原样并附命名空间。

共同类型：`VersionRef={id,version,digest}`；`ResourceRef={id,version,digest,kind}`；`Principal={tenantId,subjectId,roles,scopes,authEpoch}`；金额/精确十进制使用十进制字符串+currency/unit，不能以 JSON 浮点承担精确计费。

| 契约 | 必要字段 |
|---|---|
| ComponentManifest | kind、id、version、digest、contractRange、provides、requires、entrypointRef、trustStatus |
| Capability | name、version、limits、consistency、cancellation、pagination、supportedDataTypes |
| IndustryManifest | namespace、definitionsRef、identityPolicyRef、rulePolicyRef、queryTemplatesRef、requiredCapabilities、testSuiteRef |
| ProfileSpec | industryRef、mappingRefs、runtimeRef、backendBindings、modelBindings、toolBindings、computeBindings、policyRef |
| ResolvedProfile | ProfileSpec + exact versions/digests、resolvedCapabilities、explicitDegradations、snapshotHash |

backendBindings 按逻辑角色命名，例如 `telemetry`、`catalog`、`documents`；行业包使用逻辑角色，不引用 URL/物理表。mappingRefs 负责角色到来源对象/列/单位转换。computeBindings 把声明的操作 ID 绑定到可信 handler，不能由用户问题指定包路径。

Preflight 算法：校验 manifest → 精确解析版本 → 验证运行时/模型/后端契约 → 检查需要的每项能力 → 计算授权后工具子集 → 检查数据角色和 mapping → 产生 resolved profile 或 missing-capabilities。不能用交集静默丢弃 required。检查输出本身版本化；激活前若输入变更要重做。

模块生命周期：`registered → validated → active → deprecated → retired`。active run 引用的版本不能 retired；不自动从网络下载未知包。绑定变更只创建新 profile version。

## C2. 运行时与模型端口

```typescript
// 仅类型契约示意；实现细节在适配器中。
interface RuntimeAdapter {
  manifest: ComponentManifest;
  start(input: RuntimeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent>;
  resume(input: ResumeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent>;
  cancel(runId: string, reason: string): Promise<CancelReceipt>;
}
interface RuntimeDependencies {
  gateway: ToolGateway;
  generation: GenerationPort;
  decision: DecisionPort;
  checkpoints: RuntimeCheckpointPort;
  budget: BudgetPort;
  signal: AbortSignal;
}
```

RuntimeInput 包含 runId、resolvedProfileRef、question、confirmedContext、evidenceRefs、deficits、planRef、remainingBudget；不含数据库连接、secret value 或全量工具结果。RuntimeDependencies 是 host 注入的受限闭包，不从模型可序列化参数反序列化。

RuntimeEvent 的固定 union：`plan_proposed`、`step_started`、`evidence_added`、`clarification_requested`、`collection_complete`、`checkpoint_ready`、`cancelled`、`failed`；各含 run_id/event_id/sequence。框架消息转换在适配器完成。`collection_complete` 仅表示可以草拟，不表示答案已通过。

PiAdapter 通过受控 stream function/工具包装对接上述端口。`beforeToolCall` 不能取代 service 授权；包装 execute 必须经 gateway，`shouldStopAfterTurn` 和 signal 共同停止；不能只依赖每条工具结果的 terminate hint。具体 hooks 在锁版本时做兼容测试。

TemplateAdapter 输入是已发布的模板 PlanSpec，节点含 toolId、typedArgs/前驱输出绑定、依赖和失败行为；缺少必要参数时返回澄清，不靠猜测填值。两适配器遵守同一证据、预算、取消和结束契约。

GenerationPort：`generate(GenerationRequest,ctx) → AsyncIterable<GenerationEvent>`；请求包含 role、messages/evidenceRefs、responseSchemaRef 或 toolSchemas、modelRef、outputLimit；事件 union 为 text_delta/tool_call_delta/usage/completed/error。它不执行工具。

DecisionPort：`decide({stateRef,questions,modelRef},ctx) → DecisionResult`；question 只能是 choice/score/noul 固定题型；结果保留选项、概率分布、confidence（支持时）和定义版本。不能生成代码/解释；跨不同题型/选项集的分数不可直接排名。

两端口独立 mock 和真实适配。JEV 不可用按 profile 进入 deterministic fallback、明确标记的生成式分类 fallback 或澄清；永不静默伪造 calibrated 字段。记录 fallback_reason 与原失败证据，不把密钥放入模型状态。

## C3. 数据与计算端口

| 端口 | 主要操作 | 关键契约 |
|---|---|---|
| CatalogPort | describe/listResources | 仅返回当前主体可见结构，分页、schema revision |
| StructuredQueryPort | validate/execute/cancel | QueryPlan、snapshot request、params、row/byte/time limits；结果携来源 |
| DocumentSearchPort | search/readSpan | Query、filters、index version、cursor；引用原文与权限 |
| TelemetryPort | readSeries/readCurrent | entity/metric、time window、quality、unit、aggregation、source watermark |
| BlobPort | putImmutable/getAuthorized | content digest、媒体类型、tenant授权引用；本地/S3一致语义 |
| ComputePort | describeOperation/execute/cancel | 受信 operation ID/version、输入 schema、只读 snapshot refs、算法版本 |
| ControlRepository | transaction/readProjection/appendEvent | 业务控制持久化端口，不与 StructuredQueryPort 合并 |

直接查询模式仍需经过目录/权限，LLM 在规划阶段通过生成端口给出 SQL 候选；StructuredQueryPort 只解析、约束和执行，不启动第二个规划 Agent。数据库适配器可只接受声明的 SQL 子集并返回 `UNSUPPORTED_QUERY`。

SQL 子集仅单条只读 SELECT/受控 CTE，禁止可写 CTE、DDL/DML、文件/网络访问函数、扩展加载及任意 UDF；通过 AST、可访问对象白名单、参数绑定与独立只读数据库角色约束。不能靠检查开头 SELECT 实现。测试还覆盖 DuckDB 文件表函数/ATTACH/INSTALL 及同类绕过。

semantic 模式 QueryPlan 以 concept/field/link ID、filters、aggregation、time、order、limit 表示；mapping resolver 解析为后端方言。过滤值参数化，标识符只能来自已确认 mapping。跨源 JOIN 必须有明确关系/键，先做基数与传输量检查；超预算或不可保持口径则拒绝/分步，不能任意拉全表。

ComputePort 不访问数据库网络：服务层先按来源绑定取得带版本的数据，再把有界快照引用交给 handler。handler 只经 ScopedArtifactReader 读取本次批准的不可变输入，可生成计算结果工件；不获得通用 filesystem/DB credential。能源包所需的 plan/simulation 方法因此不穿透通用层。

### C3.1 Snapshot 与一致性

每条工具结果附 SourceSnapshot：sourceRef、schemaVersion、readAt、asOf/watermark（可得时）、consistency=`immutable|repeatable_read|read_time|unknown`、resultDigest。PostgreSQL 的 repeatable-read 只在该查询事务内保证一致，不能把已结束事务的 snapshot ID 当可永久重读版本。需复现实验时归档授权范围内的结果快照；不能虚构跨库原子版本。

## C4. 工具公共契约

ToolDefinition 含 toolId、version、inputSchema、outputSchema、requiredCapabilities、readOnly、resultLimits。实现注册四工具：ontology_lookup、data_query、document_search、web_search。verify_result/final_answer 是 controller service，不加入模型目录。

| 工具 | 输入形状（共同含 cursor/limit 时均有上限） | 结果 |
|---|---|---|
| ontology_lookup | scopeRef、concepts/entityRefs、intent=`definitions|resolve|relations|rules|facts`、timeContext | 可见的局部定义、映射/事实引用、缺口和版本；无自动发布 |
| data_query | 判别 union：`describe`；`query`+mode direct/semantic；`compute`+operationRef+inputRefs/typed parameters | 结构化表、统计或类型化计算结果，均含证据 |
| document_search | query、allowedCollectionRefs、filters、mode keyword/vector/hybrid、cursor | 片段、scoreKind、source spans、index version、完整性状态 |
| web_search | query、allowedDomains、freshnessHint、cursor | 公网页面证据及 URL/发布时间/抓取时间；来源内容无指令权限 |

union 的每支有完整 schema，`compute` 的参数按已注册 operation schema 验证；禁止 `code`/任意脚本字段。未启用 `home-energy.plan@1` 时参数写对也不能执行。

统一 ToolResult：`callId,status=ok|partial|empty|error,dataRef/inlineData,schemaRef,evidenceRefs,sourceSnapshots,coverage,usage,warnings,error?`。coverage 记录 returned/knownTotal/cursor/truncated；RAG top-k 是召回范围，不证明全集不存在。领域结果另有 unknown/conflict/infeasible 等状态，不与工具执行失败混淆。

ToolContext（非模型参数）包含可信 principal、runId、resolvedProfileHash、policyVersion、deadline、budgetReservation、allowedResources、traceId。gateway 先验证调用→原子预算预留→记录 intent→执行→持久化 evidence/result→结算；缺失 evidence 时不能返回可追溯成功。

## C5. 本地与 MCP 等价边界

本地适配器把 ToolDefinition 注册到 runtime，并以受限闭包传入 ctx。MCP server 通过服务端同一 ToolGateway 暴露工具服务；外部单独工具调用建立限定的 tool-session/context 和调用额度，不能绕过网关直接执行业务函数。业务校验复用同一实现，transport 不含领域逻辑。

入站远程 MCP 先验证身份/audience，映射资源范围并建立独立 session/run；模型传入 tenant_id/run_id 不授予信任。出站 MCP client 使用 profile 绑定的远程工具映射，只注入白名单 subset；工具 list_changed 不自动扩大能力。远程 server 同样执行自己的授权和限流；不能仅因客户端自称已校验而放行。

首期实现并实测 stdio，支持 structuredContent/outputSchema 的兼容协议子集；Streamable HTTP 先定义 host 契约，启用前补认证与断线测试。一次真实领域工具在 local/stdio 两路径交叉验收，其余工具运行同套 adapter contract tests。

MCP `isError`、JSON-RPC error 与平台错误明确映射，不能把错误文本当有效结果。断连时不盲目重复非幂等操作；四数据工具本身只读，但计算结果工件仍需幂等归档。相同源快照和计算输入产生相同逻辑 evidence digest；执行 attempt ID 可不同，不要求不同传输的运行 UUID 相同。

取消与超时是尽力通知；服务不支持 cancel 时不宣称已终止远端任务，平台将结果标 abandoned 并隔离迟到输出。跨传输重试计入同一预算。

## C6. HTTP API

公共响应：成功 `{data,meta:{traceId,revision?,nextCursor?}}`；失败 `{error:{code,message,retryable,detailsRef?},traceId}`。ID/版本缺失返回404，格式/不兼容分别400/409/422。身份由服务端建立。

| 方法/路径（前缀 /api/v1） | 输入要点 | 返回 | 权限 |
|---|---|---|---|
| POST /components | manifest + artifactRef | registered component | platform-admin |
| GET /components | kind、cursor | manifests/status | profile-editor |
| POST /profiles | ProfileSpec | profile/version | profile-editor |
| POST /profiles/{id}/preflight | version | resolved/missing capabilities | profile-editor |
| POST /profiles/{id}/activate | version + If-Match | activeVersion | profile-editor |
| POST /sources | adapterRef、secretRef、scope、mappingRef | source ID | data-editor |
| POST /sources/{id}/probe | capability subset | job ID | data-editor |
| POST /ingestions | sourceRef、document/datasetRef、pipelineVersion | job ID (202) | data-editor |
| GET /jobs/{id} | — | stage、counts、errors | resource-authorized |
| POST /jobs/{id}/retry | failedStage、If-Match | same logical job/new attempt | data-editor |
| GET /candidates | job/scope/status/cursor | candidate page | semantic-reviewer |
| POST /candidates/{id}/decision | match/create/clarify/reject、evidenceRefs、If-Match | decision version | semantic-reviewer |
| POST /semantic-publications | approvedCandidateRefs、schemaRef、If-Match | publication version (201) | semantic-publisher |
| POST /statements/{id}/revisions | correction/retraction + validity + reason + If-Match | new version + invalidation job | semantic-publisher |
| POST /runs | profileRef、question、context、preferences | run ID/events URL (202) | business-user |
| GET /runs/{id} | — | sanitized state/budget | run-owner/scoped-reader |
| POST /runs/{id}/responses | clarification ID、typed response、expectedRevision | continued/blocked | run-owner |
| POST /runs/{id}/cancel | reason、expectedRevision | cancelling/cancelled | run-owner/operator |
| GET /runs/{id}/events | Last-Event-ID | SSE | run-owner/scoped-reader |
| GET /runs/{id}/answer | — | verified answer/202/not available | run-owner/scoped-reader |
| GET /evidence/{id} | asOf/validAt | authorized evidence | scoped-reader |
| GET /evidence/{id}/dependencies | direction、cursor、depth | bounded graph | scoped-reader |
| GET /objects/{id}/history | recordedAt/validAt/cursor | historical assertions | scoped-reader |
| POST /simulations | registered operation、inputRefs、parameters | job/plan ref (202) | simulation-user |
| GET /simulations/{id} | — | typed result/evidence | scoped-reader |
| POST /executions | planRef、mode=simulation | simulation execution (202) | simulation-user |

所有 POST create/retry 要求 Idempotency-Key；同 key 同 canonical payload 返回同资源，不同 payload 返回409。资源更新使用 If-Match；缺 header 返回428。POST /runs 不接受客户端指定 principal、强制扩大预算、工具白名单或 secret。

`mode=live` 当前返回409 `CAPABILITY_NOT_CONFIGURED`，不代理到 HA。未来需独立 action授权与一次性确认契约，见能源分册；当前未定义为可执行实现任务。

### C6.1 关键线格式样例

```json
{
  "profileRef": {"id":"home-energy-demo","version":"1.0.0"},
  "question":"在备电要求下比较明天的用电策略",
  "context": {"siteRef":"site-demo-a","timeZone":"Asia/Shanghai"},
  "preferences": {"route":"auto","allowWeb":false}
}
```

202 返回 runId、state=created、eventsUrl、resolvedProfileHash。实例选择与时间/备电需求不充分时进入澄清；示例不隐含任何真实设备配置。

SSE 事件：`run.state`、`plan.summary`、`tool.started`、`tool.completed`、`evidence.available`、`clarification.required`、`answer.published`、`run.failed`。每项含持久化递增 seq，Last-Event-ID 断线重连按序补发；客户端按 event ID 去重。没有 `unverified_answer.delta` 对业务 UI 公开事件。

### C6.2 错误与重试

| code | HTTP | 可自动重试 | 行为 |
|---|---|---|---|
| INVALID_ARGUMENT / INVALID_SCHEMA | 400/422 | 否 | 指明字段，不编造默认数据 |
| UNAUTHENTICATED / FORBIDDEN | 401/403 | 否 | 停止或请求用户处理身份 |
| VERSION_CONFLICT / IDEMPOTENCY_CONFLICT | 409 | 否 | 刷新后重新决策，不能覆盖 |
| CAPABILITY_NOT_CONFIGURED / PROFILE_INCOMPATIBLE | 409 | 否 | 缺项列表，不隐式注册能力 |
| SNAPSHOT_UNAVAILABLE / CHECKPOINT_INCOMPATIBLE | 409 | 否 | 明确重新运行/历史限制 |
| SOURCE_UNAVAILABLE / MODEL_UNAVAILABLE | 503 | 有限 | 只读最多2次退避，仍受总预算限制 |
| RATE_LIMITED | 429 | 有限 | 尊重 retry-after，超 deadline 则停止 |
| DEADLINE_EXCEEDED | 504 | 视作用 | 只读可有限重试，记录远端状态未知 |
| BUDGET_EXHAUSTED / NO_PROGRESS | 409 | 否 | 有限回答/停止，预算不重置 |
| DATA_STALE / DATA_CONFLICT / INSUFFICIENT_DATA | 422 | 非机械重试 | 补数据、澄清或领域有限结果 |
| VERIFICATION_FAILED | 422 | 修复预算内 | 不发布未经验证草稿 |
| RESULT_TOO_LARGE / UNSUPPORTED_QUERY | 413/422 | 换计划 | 分页/聚合/缩范围，不当空数据 |
| INTERNAL_ERROR / EVIDENCE_PERSIST_FAILED | 500 | 视幂等性 | 留 trace，不返回假成功 |

空查询是成功结果的 `empty`，不是错误；无匹配证据并不自动意味着业务命题为假。领域 infeasible 可以是计算成功的结果，不伪装成平台异常。
