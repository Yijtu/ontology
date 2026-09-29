# SPEC v0.3 A 分册：通用执行、规则与证据

日期：2026-09-29。状态：拟新增实施设计，未实现、未验收；任务及 GitHub 编号映射见[独立批次](../../.autoresearch/batches/v0.3-assistants/INDEX.md)，创建进度以 manifest 为准。需求依据为 [A 通用 PRD](../prd-generic-assistants-core-v0.3.md) 的 US-007～016，并提供 US-001～006 的执行侧约束。行业资产、项目修订、数据物化、文档索引和公共 UI 的权威定义见 [资产、数据与 UI 分册](asset-data-ui.md)；本册定义任务执行、规则语义、类型化结果、核验、发布有效性及恢复契约。

## EX-0. 基线、复用与范围

源码核对时，本文所在工作区实际为 `feat/electrical-costing-poc@b339b8f6a1167218becdd7b33d144c02660f43ce`；目录名不能证明它在 main。A 的交付基线和最终 main SHA 由主 SPEC／任务 manifest 记录。本册还只读核对了 `D:/work/ontology-main-decoupling` 的 `feat/core-planning-provenance@d17c7b520298703feb65f86761f34f1557927aca` 及其未提交修改。下表只表示可复用材料，不构成已交付判断，也不授权整枝合并。

| 能力 | 核对到的复用点 | A 必须补齐 |
| --- | --- | --- |
| 普通 NL 规划 | 研发工作区已有 Template `prepare`、单次 semantic `data_query` 提案、固定 mapping 编译、不可变计划／澄清 receipt；见研发文档 `platform/docs/core-template-planner-preparation-2026-09-29.md` | 扩展受支持任务路由，接 typed writer、全证据核验及发布有效性；当前受控集成查询后仍 failed、无 answer |
| 规则 | `semantic-engine/src/rules/{compile,evaluate,from-published}.ts`、实例物化、例外／双时态 | 不同条件 OR、受限关系前提、无环规则依赖；现有 `any` 仅合并同条件替代来源，不能当作新 OR 已完成 |
| 规则原文 | 研发工作区的 `MaterializedRuleDerivationEvidenceProducer`、raw chunk→candidate→parse→span 桥接 | 正常工具／宿主注入调用；补规则政策原文及关系／上游推导证据；现有桥接不覆盖政策 span |
| 答案 | `PublishedFactsDraftWriter`、`answer-draft@2`、`DraftVerificationService`、持久化发布 | 事实／关系／规则／SQL／引用／compute 全形态和有界大表；Core writer 与 `CorePublicationValidity` 现在均只接受纯 fact 页 |
| runtime | Template、Pi 适配器；`NoProgressGuard`、`SmallPlanExecutor` | Core 真实注册两 runtime、Pi 单一有界循环、可恢复 guard；预声明步骤不等于动态补查 |
| compute | `data_query.kind=compute`、`RegisteredOperation`、`ComputeOperationHandler` | 公共任务→批准输入→注册动作→输出工件→typed 核验／发布闭环及幂等执行记录 |

复用现有 `RunService`、`WorkflowController`、持久 dispatch／lease、`RunManifest`、共享 budget ledger、ToolGateway、四个公共工具、证据 envelope、审核发布及 append-only 历史。不建立另一套任务控制器、运行账本或自由工具；公共 Core 不包含桥架字段、税率、价格、能源算法或客户列名。

## EX-1. 规范所有权与拟新增位置

以下类型、Schema 和端口均为**拟新增／拟扩展**。实施先更新 canonical Schema／手写 contracts，再用仓库生成流程更新 `src/generated/*`；不得直接编辑生成文件来假装契约已经存在。

| 权威位置 | 拟新增／扩展内容 | 实现职责 |
| --- | --- | --- |
| `packages/contracts/src/projects.ts`、相应项目 Schema（拟新增，由数据分册定义） | `ProjectRevisionRef`、不可变项目修订、输入／dataset／document corpus 引用与 readiness receipt | 本册只引用；不另定义项目版本 |
| `packages/contracts/src/tasks.ts`、`schema/tasks.schema.json`（拟新增） | `PublishedTaskBinding`、`RunExecutionRequest`、`RunExecutionBinding`、参数确认、`TaskIntentProposal`、`TaskValidationPolicyPort/Report` | 只包含语义、完整 refs、Schema digests 和能力需求；无 endpoint、密钥、任意脚本 |
| `packages/contracts/src/workflow.ts`、`schema/http.schema.json`、`schema/runtime.schema.json` | RunManifest 可选 `executionBindingRef`；run 请求可选 `task`；阶段模型执行 context；恢复／停止元数据 | application 的服务端验证绑定，不从模型／请求获取权限 |
| `packages/contracts/src/planning.ts`、`schema/tools.schema.json`、tool catalogue | 有界任务提案；`OntologyLookupInput` 的可选 `request: PublishedSemanticQuery`；任务执行与原有四工具对应 | 旧 intent 和 `data_query` direct／semantic／compute 保留；版本化新增输入输出能力 |
| `packages/contracts/src/rule-extraction.ts`、`src/semantic-publication.ts`、`schema/rules.schema.json`（拟新增） | `rule-expression@2`、规则能力描述、`rule-computation-artifact@2`、依赖／关系／presence pins | candidate、发布前能力检查、运行 compiler 共用同一支持子集 |
| `packages/contracts/src/typed-results.ts`、`schema/typed-results.schema.json`（拟新增） | `typed-output-bindings@1`、`typed-result-manifest@1`、table page／field bindings、`compute-result-artifact@1`、`task-finalization-receipt@1`、verification receipt | 通用结果数据与核验覆盖，不包含业务算法或 UI 组件 |
| `packages/contracts/src/verification.ts`、`src/workflow.ts` | `answer-draft@3`、money／规则轴／表格绑定、verification hash／分页核验 receipt 扩展 | 旧 `@1/@2` 继续读取，新增写入不能降级丢字段 |
| `packages/application/src/tasks/`（拟新增）、`workflow/{planning,controller,evidence-loop,publication}.ts` | task resolution、确认、单一 phase ownership、唯一计量／取消、发布 gate | 通过端口接收规则／数据／模型能力，不 import runtime SDK、数据库驱动或行业扩展 |
| `packages/application/src/answers/`（拟新增）、现有 `verification/` | evidence writer、typed manifest builder、分页 hard checks、按证据类型的 validity dispatch | 不把通用 writer 算法堆在 composition root |
| `packages/semantic-engine/src/{rules,materialization,provenance,mapping}` | 规则 V2、真实实例关系导航、依赖索引、原文证据与持久 slices | 纯规则 evaluator 不读库；存储和原文读取经端口注入 |
| `packages/adapters/runtime-{template,pi}`、model／data／transport／control adapters | checkpoint、guard、实际 SQL／MCP、计量与中断、追加存储 | SDK 状态只在 runtime adapter，物理方言只在 data adapter |
| `apps/api/src/composition`、API host、Web 通用结果组件 | 装配 task／runtime／writer／verifier／validity；公开状态、表页和 JSON 导出 | 不按行业名字分支；专业 renderer 经场景组合入口挂载 |

新增迁移号由实施时迁移目录核对分配。研发 `057_core_plan_receipts.sql` 只能审查后复用，本文不预占同号。计划/任务/执行/compute/verification 记录均带 tenant/space RLS、同域 FK 或授权引用校验、唯一逻辑键和追加版本；工件内容存在不可变 artifact store，不把大表塞入控制行。

JSON Schema 规范可序列化的工件 body、读取 envelope、HTTP 请求响应和 UI 投影；`TaskValidationRequest` 中的 reader／AbortSignal 与模型阶段端口属于手写内部接口，不序列化给前端或模型。客户端复用生成 DTO 和同版本 decoder 校验传输数据，可做字段级即时校验；批准、任务绑定、策略执行和发布核验仍由服务端完成。前端 Schema 通过不能产生批准状态、策略 pass 或 verification receipt。

## EX-2. 任务与 Run 的固定绑定

### EX-2.1 类型和入口

项目版本引用使用数据分册的 `ProjectRevisionRef { projectId: Uuid, revision: RevisionString, digest: Sha256Digest }`。其内容固定行业包、定义、`mappingRefs[]`、`ResolvedProfileRef`、批准输入及预先归档的数据／语料 manifests；readiness 单独投影，不后填 immutable revision。作用域和身份始终来自可信 `ToolContext`。

拟新增形状（字段为规范，不表示已生成代码）：

```ts
type TaskKind = 'published_facts' | 'relations' | 'rule_judgement'
  | 'structured_query' | 'document_qa' | 'compute'

interface PublishedTaskBinding {
  schemaVersion: 'published-task-binding@1'
  taskBindingRef: VersionRef                 // id + version + digest，完整固定
  actionDefinitionRef: VersionRef
  kind: TaskKind
  parameterSchema: Readonly<Record<string, unknown>>
  parameterSchemaDigest: Sha256Digest
  requiredCapabilities: readonly string[]
  requiredReadiness: readonly ('published_semantics' | 'dataset' | 'document_index')[]
  resultSchemaRef: VersionRef
  operationRef?: OperationRef               // 仅 compute；不是可执行代码
  registeredOperationDigest?: Sha256Digest  // 覆盖 handler/schema/limits pins
  validationPolicies?: readonly TaskValidationPolicyBinding[]
  fixedPlanRef?: ResourceRef
}

type PublishedTaskBindingBody = Omit<PublishedTaskBinding, 'taskBindingRef'> & {
  taskBindingIdentity: Pick<VersionRef, 'id' | 'version'>
}

type RunExecutionRequest = {
  mode: 'question'
  projectRevisionRef: ProjectRevisionRef
  inputSnapshotRef: ResourceRef
  inputSnapshotDigest: Sha256Digest
} | {
  mode: 'task'
  projectRevisionRef: ProjectRevisionRef
  inputSnapshotRef: ResourceRef
  inputSnapshotDigest: Sha256Digest
  taskBindingRef: VersionRef
  parameters: Readonly<Record<string, unknown>>
}

interface RunExecutionBinding {
  schemaVersion: 'run-execution-binding@1'
  runId: Uuid
  request: RunExecutionRequest
  resolvedProfileRef: ResolvedProfileRef
  runtimeRef: VersionRef
  allowedTaskBindingRefs: readonly VersionRef[]
  inputManifestDigestAtCreation: Sha256Digest
  effectiveLimitsRef: VersionRef
  effectiveTime: { validAt: string; asOfRecordedSeq: RevisionString }
}
```

`PublishedTaskBinding` 是受信读取 envelope 的扁平形状，接口仍使用 `binding.validationPolicies`。归档与 digest 使用独立 `PublishedTaskBindingBody`：body 固定 id/version identity 和其余声明，不含自己的 `taskBindingRef`／digest；算得 body digest 后构造 envelope 的完整 ref。canonical Schema 显式区分两种形状，不能对包含自身 digest 的读取 envelope 再计算 task binding digest。其他工件同样先存 body，再由外层 envelope 携带自己的 ref，已有下游引用的 digest 属于 body。

`inputManifestDigestAtCreation`固定的是加入执行binding之前、已含批准项目/输入refs的初始manifest版本；executionBindingRef存于RunManifest。后续evidence/clarification只追加输入manifest，不回写binding，避免binding与其引用manifest自循环。plan/checkpoint保存其对应manifest revision/digest，恢复验证该历史版本及之后允许的追加记录，不要求后续收证后的digest仍等于创建时digest。

复用 `POST /api/v1/runs`，原必需字段 `profileRef/question/context/preferences` 及幂等头保留，新增可选 `task: RunExecutionRequest`。question 模式在同一 run 由 planner 选择允许的已发布 task；task 模式使用明确绑定的确定计划。RunManifest 增加可选 `executionBindingRef: ResourceRef`，引用服务端归档的 binding。旧无 task 的注册 `facts:` 请求仍按既有兼容路径执行；新项目 UI 必须提交固定项目修订，不能把不带项目的旧请求当作最新项目任务。

`PublishedTaskBinding`是项目/profile预检后形成的可执行装配记录，和行业包里的动作语义声明分层。行业包只保存输入/结果语义及能力需求；实际operation／policy注册实现、backend及fixedPlan绑定由受信装配完成。fixedPlanRef必须与所选profile/runtime/tool schema和mapping pins兼容；它不让行业包夹带物理SQL、runtime SDK或客户地址。UI任务目录可显示未就绪声明及blockers，但model可执行allowedTaskBindingRefs只包含本run授权且预检通过的绑定。

服务端依次检查同域／当前权限、project revision digest、输入 ref 与 digest、批准状态、profile snapshot 一致、所需 readiness、task 参数 Schema 和能力；将 binding 与 run／初始 manifest／ledger／dispatch 一致提交。请求的 `profileRef` 与项目固定 profile 不同返回 `VERSION_CONFLICT`。task 语义已发布但函数、索引或 backend 未挂载返回未就绪及缺项，不能调用启动演示数据。`preferences.route` 保留偏好含义；它不覆盖固定 `runtimeRef`，使用另一个 runtime 须选择预检通过的 profile／新 run。

`inputSnapshotRef` 可直接指向项目修订固定的 `approvedInputRef`，也可指向已注册任务 input Schema 的下游不可变输入工件。后者只能由受信 snapshot 服务在批准项目修订后生成，body 固定完整 `projectRevisionRef`、`approvedInputRef` 和所需已批准依赖；run admission 核对 Schema／digest、真实生产记录、项目与批准输入的精确关系、全依赖同域授权及必需 input 策略。不因客户端自填相同 projectId 而接受。下游输入不得成为该项目修订自己的 approvedInputRef，也不得回填原项目修订；任务专属输入变化形成新固定工件及新 run，不能借 parameters 覆写它。此扩展不把下游领域字段加入公共项目 Schema。

Run 响应保留 `runId/state/revision/resolvedProfileHash`，可选返回 `executionBindingRef`、任务与就绪摘要。`GET /runs/{id}` 返回同一摘要及可恢复原因；运行计划／SDK checkpoint 正文不泄漏给公共 API。

### EX-2.2 澄清和参数变更

复用 `POST /runs/{id}/responses` 和 `If-Match`。拟新增 `TaskParameterConfirmation` 记录 `proposalRef/digest`、完整 prior receipt ref、clarificationId、run revision、字段 old/new 值及来源 ref、参数 Schema digest、确认决定。模型只能产生建议，不能覆盖已批准数据。

同任务、同输入、同授权范围内的选项与操作参数澄清可在当前 run 追加 `clarification` entry，归档新计划 receipt，沿用 ledger。更改已批准行／字段、mapping、资料或行业版本，由项目服务产生新修订和输入 snapshot，再创建新 run；旧 binding 不修改。确认不能扩大 allowlist、项目范围或预算。冲突／旧 revision 返回 409；缺 `If-Match` 返回 428。

## EX-3. 规划、四工具及 runtime

### EX-3.1 受支持提案

拟新增 `TaskIntentProposal` 只允许本阶段六种 `TaskKind`，包含允许列表内的 taskBindingRef、语义字段／已确认 entity refs、固定 query time、参数或文档检索请求、所需证据类别。模型不输出 SQL、URL、scope 身份、连接信息或代码。可信 task compiler 将其编译成 `ExecutablePlan`；SQL 路径复用 `SemanticQueryCompilerPort` 和确认 mapping。编译器检查所有字段、关系、operation、input refs 都属于 run binding，编译一次，保存完整 plan receipt 后执行。

| 任务 | 公共工具／受限输入 | 真实来源 |
| --- | --- | --- |
| 已发布实体／属性 | `ontology_lookup(intent=facts/resolve, request=...)` | 批准身份及正式 published read view |
| 已发布实例关系导航 | `ontology_lookup(intent=relations, request=...)` | 真实 relation statements、端点与版本；不以 SQL JOIN 或证据边冒充 |
| 规则适用性／业务命题／解释 | `ontology_lookup(intent=rules, request=...)` | materialized view／共享 deterministic evaluator，产生 rule_derivation 证据 |
| 物理结构化查询 | `data_query(kind=query, mode=semantic/direct)` | 项目固定的真实 dataset snapshot；direct 只接受可信 compiler 产物 |
| 文档问答 | `document_search` | 项目授权、ready 的固定 index generation 和精确 span |
| 确定性动作 | `data_query(kind=compute)` | 已注册 operation、批准 immutable input refs、typed parameters |

`OntologyLookupInput.request: PublishedSemanticQuery` 为拟新增可判别联合，分别定义 facts 字段／实体筛选、relations 方向与有限路径、rule_judgement 的规则 refs／实体／判断轴及解释请求；它与 intent 必须一致。旧 `intent=rules` 没有 request 时仍是既有规则定义读取，不能自动变成规则判定。`scopeRef` 兼容旧 ontology 输入，但 planner 只由 host 注入可信 scope，gateway 再核对；`data_query` 不新增模型可写 `scopeRef`。新增工具 Schema 以新版 component/catalogue refs 发布，旧 profile 不自动获得新能力。

rule query 每次读取保存的 computation 工件，得到精确 premise／rule／time pins，再调用注入的 producer。拟扩展工具 outcome 允许 `supportEvidenceRefs`，gateway 对所有 refs 逐一核对同域完整引用、授权、归档状态和 digest，作为 lineage 加入最终 ToolResult／input manifest；不得仅在 JSON 字符串中塞一个未经授权的 evidence ID。

固定 task／`facts:` 绕过 rewrite、generation、JEV。普通问题缺 generation、空 vocabulary 或不受支持提案显式 `CAPABILITY_NOT_CONFIGURED`／`UNSUPPORTED_QUERY`；禁止默默转成 definitions lookup。只允许 retryable `MODEL_UNAVAILABLE/RATE_LIMITED` 按已绑定策略澄清；预算、期限、取消、archive、accounting、schema 故障保留错误。JEV 仅处理确定性歧义，state archive 保存实际 question／允许任务／schema／refs，按 run/profile 授权；缺 JEV 时使用配置的确定性澄清，不声称概率核验已运行。

### EX-3.2 一个执行所有者和可恢复进展

Controller 拥有外层 phase machine、授权、ledger 和发布；每个 run 只由它选中的一个 RuntimeAdapter 拥有收证循环。Template 执行已知 DAG 步骤、绑定 predecessor 输出、检查缺参，不动态重规划。Pi 通过同一 gateway 执行“查询不足→有用补查→完成”的有限路径。`final_answer` 只能产生草稿意图／收证完成事件，不能返回可发布 answer。

拟扩展 `NoProgressGuard` 为 data-only state + `snapshot()/restore()`，保存 callKey、resultDigest／coverageDigest、已收 evidence 完整 refs、rounds、failureRepairs。key 覆盖工具、规范参数、固定 source／semantic refs 和 cursor；result progress 比较归档结果与新增覆盖，不能用随机 callId／新 evidence ID 制造进展。重复调用在 admission 阶段停止；来源版本固定，动态 runtime 不得以改成 latest 来逃过 repeat 检查。分页 cursor 不重复且新增 coverage 才算新信息。空结果／相同内容／达轮数均带明确 stop reason，故障保留 failure，不能变成 empty。

Template 的 checkpoint 绑定完整 plan receipt 和已完成步骤；Pi 拟新增 checkpoint schema V2，增加 execution binding ref、plan/route receipt、guard state、turn/tool/model counters、input manifest digest 和精确 SDK/adapter/runtime pins。模型调用前保存 attempt 意图；工具成功的 evidence／usage 与进展状态可复核提交后才 checkpoint-ready。恢复校验 scope、run/profile/runtime/ref/hash/lease，加载同一 receipt；不重新规划已归档 executable plan，不重置 ledger／guard。V1 Pi checkpoint 不含 guard：仅在能够由已归档 round 工件验证重建时升级，否则 `CHECKPOINT_INCOMPATIBLE`；不承诺 SDK 状态任意迁移。

## EX-4. 规则有限子集与实例关系

### EX-4.1 RuleExpression V2

拟新增 `expressionSchemaVersion: 'rule-expression@2'` 与 V2 AST。V1 历史保留原语义和 reader，不把已发布 V1 JSON 静默重解释。候选、preflight、publish 与 evaluator 使用同一 `RuleExecutionCapabilities` 描述和 deterministic checker。超界候选保存来源和 `unhandled`，不能启用、删 exception 或降阈值；单条不支持规则不拖垮已有合法 scope。

V2 支持：

- `compare`／`range`：同实体声明属性，V2的数量value/min/max为DecimalString＋显式单位，不先转换Number；读取新增`CandidateAttributeValue.value`精确字符串及`unitCode`，raw lexical只供来源对照。旧finite number仅历史兼容，不能Number→string恢复精度。类型不匹配、缺单位返回能力问题。
- `presence`：判断某字段在固定批准记录中显式 `present`／`confirmed_missing`。必须有 `FieldPresenceEvidence` 记录字段确认修订、snapshot、范围与完备性；没有观测／分页缺行／工具 empty 是 unknown，不是 missing=true。
- `all`：有限 AND；`any`：真正不同条件的有限 OR，如 `operating_hours>=100 h OR alarm=true`。保留每个 branch AST、状态和来源，不能降成同 filter 的来源 group。
- `not`：仅一个显式观察 comparison/range/presence 叶子；unknown/conflict 不反转成普通真假。附着 exception 独立保存，第一批最多四个观察型有限条件，不支持对关系缺失或规则结果做闭世界否定。
- `relation_exists`：至多一个 relation premise，正向一跳已发布关系，从当前 subject 到 schema 声明的 target object；target predicate 仅 compare/range/presence/有限 all，不嵌套 relation／规则依赖。至少一条完整匹配支撑可成立；未找到不能由关系存在性证明 false，除非固定授权 read range 有可验证的完整性证明；缺端点身份、截断或缺 target facts 为 unknown/incomplete。
- `rule_result`：同 subject/object、明确已发布 ruleRef／predicate／期望值的正向依赖。第一批只消费上游明确业务结论，不把“上游不适用”当成业务 false。ruleRef 图必须无环、深度不超过三；不做递归、任意规则名称解析或无限 fixpoint。

四态运算冻结为保守真值表：all 有 conflict 则 conflict，否则有 false 则 false，否则有 unknown 则 unknown，否则 true；any 有 conflict 则 conflict，否则有 true 则 true，否则有 unknown 则 unknown，否则 false；not 只翻转 true/false。冲突来源另存，不能挑一值消冲突。condition=true 且全部 exceptions=false 才提供正向支撑；exception=true 表示此规则不适用；未知例外不被当 false。规则不提供支撑不产生业务反证。业务命题 true/false 需要对应明确事实／审过的结论支撑，双向支撑为 conflict，无支撑为 unknown。

比较器依schema区分decimal、quantity、string和boolean。SQL compiler把精确数值绑定为后端DECIMAL参数，不能对DecimalString进行字典序比较；物理后端精度/scale不能表示输入时明确`PRECISION_UNSUPPORTED`。单位转换使用mapping固定的Decimal/Rational因子和显式precision policy，不保留有损float `unitFactor`用于新精确查询。转换／舍入版本和原值进入证据；外围Decimal不声称能修复上游已有浮点损失。规则、SQL、compute和writer统一这项表示约束，但具体业务舍入口径不进入Core。

### EX-4.2 支撑 DAG、时间与增量

拟扩展紧凑 support DAG，明确 `all`、`any_branch`、`any_source` 三类节点：不同条件 OR 的 branch、同条件替代来源不能混用。保留成功 branch 和其他 branch 状态，不枚举来源笛卡尔积。节点完整 pins 覆盖 subject、object、definition、rule、字段／关系、业务有效时间与 recorded seq。所有叶子和上游推导必须在**同一** `validAt/asOfRecordedSeq` 可见；不能拼过去属性、未来 exemption 或跨实体值。

拟新增 `rule-computation-artifact@2` 保留 V1 的 applicability、factRefs、input/computation digests 和完整性，增加 expressionSchemaVersion、conditionGraphRef、branch states、relationPremiseRefs、presenceEvidenceRefs、dependencyComputationRefs、businessPropositionState 与必要 coverage/fence pins。producer 和 hard verifier 对图／工件完整引用与自摘要进行验证；只读持久 slices，缺历史 slice 不用 current heads 补。业务结果的计算 point 和 broader question point 分开存。

规则发布时建立 definition-scoped dependency DAG 并拒绝 cycle；物化按拓扑序推进，单次 dirty 批次有上限和 continuation。依赖索引覆盖实体属性、规则版本、关系 statement/端点、target 属性、显式 presence、上游 derivation 与未来有效期边界；新增未曾满足的叶子也能触发重算。发布／更正／撤回与 invalidation fence＋outbox 原子提交；worker 去重后追加新 projection slices 和 watermark。仍有其他 branch／rule／source 支撑则保留结论；只撤一个替代来源不能撤整个命题。查询 dirty view 可按同 evaluator 有界求值或返回 pending/incomplete，不能把 stale 结果当当前。

### EX-4.3 导航

实体导航使用已批准身份和 `PublishedStatement(kind=relation)`，包括方向、端点完整 refs、relation/schemaRef、有效区间、记录修订、source refs。第一批最多三跳、指定 path、每层分页；禁止数据表 JOIN、定义的 type relation 或 evidence dependency 作为实体关系边。全 traversal 有 cap，cursor 绑定 project/read snapshot/definition/path/time/scope。返回 visited entities／relation edges、matched paths、coverage；截断时不声称全体、唯一、没有关联。Anker 可复用实现经边界审查后提取，能源规则/UI 不进入通用包。

## EX-5. 原文、单元格与规则证据

原文链复用研发 producer 的 scoped candidate→logical document version→parse→original blob→span 机制，保留逻辑文档 ID 与物理 blob ID 的区别。拟统一 `SourceLocationBinding` 关联 source/document version、parseRef/parserVersion、chunkRef、locator、原始与规范文本映射、quoteDigest/textDigest、主体／字段／premise／rule AST node。CSV/XLSX row/cell 的 locator 与解析契约由数据分册定义，本册要求同字段确认修订可定位原始 cell，不自行另定 row 编号。

新增政策 span 路径：从规则审核版本记录的每个 AST/exception/conclusion source binding 查 scoped parse，读取精确 span，归档不可变 text artifact 与完整 binding artifact，产生 `document_span` envelope；`rule_derivation` wrapper 指向前提事实、关系、依赖推导和政策原文 evidence。必须核对 ruleRef/definition/parse/document/locator/digests 与审批记录；相同文本但另一文档不可替换。raw sourceRef 缺桥接保留并记录缺口，不能变造已验证 evidence ref。

完整性分轴报告：规则计算输入、支撑图、前提原文、政策原文、导航／查询覆盖。support graph resolved 不能代表政策原文已核验。128 KiB span／1 MiB 单 wrapper 超界显式 incomplete；approximate locator 保留标记，不能作为 exact quote。普通 rule verdict 可以明确限制来源展开；用户要求完整原文解释且缺 span 时，不能发布“完整依据”的答案。历史读取优先归档 bytes；不存在或 digest 错误为 unverifiable，无法访问为 forbidden，不吞成空引用。

## EX-6. 注册 compute 与结果工件

复用 `RegisteredOperation` 的 operationRef(id/version)、input/output Schema digests、handlerRef/digest、readOnly、requiredCapabilities、limits、dataMode。task 的绑定必须覆盖整个注册记录 digest，不能只 pin operation ID/version。handler 通过 `ComputeOperationRequest` 接收已授权 input refs、ScopedArtifactReader、ImmutableArtifactWriter、剩余 deadline 和 signal；行业函数、客户端适配、endpoint 或领域公式只在扩展／adapter 装配。

拟新增 `ComputeInvocationRecord`，逻辑键为 scope＋taskBindingRef＋inputSnapshotDigest＋规范参数digest＋registeredOperationDigest。状态 `prepared→executing→completed`；失败／取消追加 attempt，不覆盖旧工件。completed 返回同一有效输出；并发相同键只有一个有效执行 owner/lease。纯 readOnly deterministic handler 的中断恢复可在 reconcile 旧 reservation 后有限重试；非 replayable 外部计算没有完成 receipt 时显式 outcome_unknown，不自动重复。不能宣称远程调用 exactly-once，也不能把不同输入误用旧结果。

拟新增 `compute-result-artifact@1` 通用 wrapper：

```ts
interface ComputeResultArtifact {
  schemaVersion: 'compute-result-artifact@1'
  invocationId: Uuid
  logicalKeyDigest: Sha256Digest
  taskBindingRef: VersionRef
  operationRef: OperationRef
  registeredOperationDigest: Sha256Digest
  algorithmVersion: VersionRef
  inputSchemaDigest: Sha256Digest
  outputSchemaDigest: Sha256Digest
  inputSnapshotRef: ResourceRef
  inputSnapshotDigest: Sha256Digest
  parametersRef: ResourceRef
  parametersDigest: Sha256Digest
  inputRefs: readonly ResourceRef[]
  outputArtifactRef: ResourceRef              // 领域 body；必须先 output Schema 校验
  outputDigest: Sha256Digest
  outputBindingsRef: ResourceRef             // 原始输出pointer描述；此时尚无gateway evidenceRef
  sourceSnapshots: readonly SourceSnapshot[]
  dependencyEvidenceRefs: readonly ResourceRef[]
  coverage: ToolCoverage
  domainStatus: DomainResultStatus
  dataMode: DataMode
}
```

现有 `DataQueryOutput(resultKind=computation).computation.resultRef` 指向该 wrapper；算法/operation字段必须一致。拟扩展`ComputeOperationRequest`内部execution context，传入经host固定的executionBindingRef/taskBindingRef/参数工件ref；不将这些可信标记作为模型可写参数。原始`typed-output-bindings@1`引用领域outputArtifactRef/digest、已注册output Schema和逐字段/row身份/单位/时间pointers，它尚不含gateway的evidenceRef。归档顺序固定为：领域output→原始output bindings→compute wrapper→gateway envelope/ToolResult→Core结果builder的`typed-result-manifest@1`→result policy reports→task finalization receipt→@3 draft。后者绑定已持久真实evidence，wrapper不回填最终manifest，避免工件与证据互相依赖成环。

output projection描述由已注册output Schema的声明式字段metadata或已注册版本化projection提供，包含rowKey/predicate/subject/unit/currency/time绑定；业务计算与projection都可在扩展实现，Core验证其Schema/refs/pointers，不猜客户列名。工具执行成功和领域 known/unknown/conflict/infeasible/not_applicable 分开。缺必填输入、未绑定 operation、Schema 不兼容、函数故障或未完整覆盖均禁止普通完整结果。输出逐字段绑定输入身份／输出 rowKey／columnRef／单位、时间、状态和完整性。示例函数作为合成通用验收扩展，明确 synthetic；不能冒称客户报价。

### EX-6.1 注册任务校验策略

业务范围／完整性／计算不变量可由独立于compute的已注册版本化策略实现。策略不是自由工具，也不将Quote字段或客户公式写入Core。`PublishedTaskBinding.validationPolicies`声明必需input/result策略；preflight仅接受受信registry中同一ref/digest及报告Schema的实现，声明未绑定时task未就绪。策略实现与compute、runtime、transport分别装配，可复用同一领域服务；本体声明包仅列语义需求和refs，不携带执行代码。

拟新增公共端口（权威位于`contracts/src/tasks.ts`，所有I/O仍注入、scope来自ctx）：

```ts
interface TaskValidationPolicyBinding {
  policyRef: VersionRef
  stage: 'input' | 'result'
  required: boolean
  registryDigest: Sha256Digest
  reportSchemaRef: VersionRef
}

type TaskValidationRequest = {
  stage: 'input'
  binding: TaskValidationPolicyBinding
  executionBindingRef: ResourceRef
  inputSnapshotRef: ResourceRef
  inputSnapshotDigest: Sha256Digest
  parametersRef: ResourceRef
  parametersDigest: Sha256Digest
  readInput: ScopedArtifactReader
  limits: CapabilityLimits
  deadline: Rfc3339UtcTimestamp
  signal: AbortSignal
} | {
  stage: 'result'
  binding: TaskValidationPolicyBinding
  executionBindingRef: ResourceRef
  inputSnapshotRef: ResourceRef
  inputSnapshotDigest: Sha256Digest
  parametersRef: ResourceRef
  parametersDigest: Sha256Digest
  outputArtifactRef: ResourceRef
  outputDigest: Sha256Digest
  typedResultManifestRef: ResourceRef
  readInput: ScopedArtifactReader
  limits: CapabilityLimits
  deadline: Rfc3339UtcTimestamp
  signal: AbortSignal
}

interface TaskValidationPolicyReport {
  schemaVersion: 'task-policy-report@1'
  policyRef: VersionRef
  registryDigest: Sha256Digest
  reportSchemaRef: VersionRef
  stage: 'input' | 'result'
  executionBindingRef: ResourceRef
  inputSnapshotRef: ResourceRef
  inputSnapshotDigest: Sha256Digest
  parametersRef: ResourceRef
  parametersDigest: Sha256Digest
  outputArtifactRef?: ResourceRef           // result阶段必需
  outputDigest?: Sha256Digest              // result阶段必需
  typedResultManifestRef?: ResourceRef      // result阶段必需
  status: 'pass' | 'fail' | 'unknown' | 'incomplete'
  coverage: ToolCoverage
  violations: readonly {
    code: string; rowKey?: string; columnRef?: string
    pointer?: string; expected?: string; actual?: string
  }[]
  dependencyEvidenceRefs: readonly ResourceRef[]
}

interface TaskValidationPolicyPort {
  policyRef: VersionRef
  validate(request: TaskValidationRequest, ctx: ToolContext): Promise<TaskValidationPolicyReport>
}
```

注册策略的handlerRef/digest、requiredCapabilities、readOnly及limits另由受信registry记录并进入registryDigest；模型、客户端或task请求不能任意选择实现。服务端根据绑定调用策略，先runtime Schema校验报告，再归档不可变report并产出`computation`证据、记录实际policy执行receipt。input阶段阻断未满足前置条件的compute；result阶段在typed writer前执行。策略证据追加到同run input manifest，并保存独立不可变`task-finalization-receipt@1`，包含executionBindingRef、taskBindingRef、inputSnapshotRef/digest、parametersRef/digest、outputArtifactRefs/digests、typedResultManifestRef/digest、requiredPolicyBindings和policyReportRefs。report指向同一已归档结果manifest；原typed manifest/compute wrapper不后填报告refs，避免report→manifest→report的digest自循环。@3 body同时固定finalizationReceiptRef/digest，核验该关联后才能正式发布。

hard verifier按taskBinding逐个确认required策略报告确实来自注册执行、stage正确、policy/registry/schema/execution/input/parameters/output digests全部一致、覆盖完整且status=pass；不能凭客户端`true`、另一输出的pass或JEV概率通过。publication validity重验策略绑定授权及报告/依赖的有效性。fail/unknown/incomplete保持定位错误，不生成完整正式业务成果；允许独立核验的有限结果／缺口说明，不能隐藏策略失败。策略、compute和核验同run期限/ledger，不另启循环。策略证明其声明的业务不变量；正式业务签核和客户算法正确性仍需B独立验收，不由Core的系统pass代替。

## EX-7. typed writer、硬核验、发布有效性

### EX-7.1 类型化结果和大表

拟新增 `typed-result-manifest@1`：固定 executionBindingRef、输入／项目 refs、resultKind、outputSchemaRef、evidence refs/result digests、source snapshots、coverage/domainStatus/dataMode、table descriptors、summary bindings、limitations。table descriptor 保存 tableId、columns、totalRows、排序／rowKey策略、每页完整 artifactRef/digest、页序号和 first/last rowKey、pageCoverageDigest；各页最多250行。字段 descriptor 保存 columnRef、semantic predicate、类型、Schema pointer、允许 display label 和必需上下文。存值和 bindings 的 table page 属于不可变工件，不依赖 UI 当前状态生成。

table page body 固定 tableId、column refs、output Schema 与 row 身份，不反指尚未归档的父 result manifest；先归档完整页，再由父 manifest 固定各页 ref/digest。manifest、页和读取 envelope 分别有 Schema，分页 API 不把 envelope 的当前有效性或 verification refs 混入原页内容。

拟新增 `TypedResultCellBinding`：rowKey、columnRef、evidenceRef/resultDigest、valuePointer、subjectPointer、fieldRefPointer、timePointer(声明时间时必需)、可选 status/coverage pointers；quantity 必须 unitPointer，money 必须 currencyPointer；规则必须 judgementAxis、rulePointer/computationPointer 和 premise refs；引用必须 document/locator/text/quote digests pointers；实体／关系必须完整 ref/endpoints/version pointers。所有 pointer 要落在同一真实 row 的身份和值及同一 column descriptor；不能跨行取值、拿每表第一个 subject 配其余行。SQL aggregate 的 subject 是精确定义的集合/口径 artifact，不能假装某实体。

新@3 binding另支持`valueArtifactRef/valueArtifactDigest`：默认pointer作用于evidence payload；若真实值在compute wrapper的outputArtifactRef或规则/原文引用的下层工件，必须显式保存该完整ref，并证明它由该envelope的受检wrapper/binding manifest精确引用后才能读取。field descriptor同理使用声明的artifactRef/pointer。任意同scope artifact不能借此成为依据；verifier检查整条ref/digest链、同row/column结构和受信Schema。@1/@2旧pointer规则保持原义，不自动尝试跨artifact找一个相等值。

money 为通用类型 `{amount: DecimalString, currency: CurrencyCode}`，金额与货币分别核验，`CNY` 不充当 quantity unit。单价额外计量单位／gross-net等口径使用 output Schema 固定的 contextPointers；业务换算与舍入策略由 operation/domain Schema 定义。新 quantity/decimal writer 使用精确字符串；`null`、unknown、conflict、not_applicable 和 incomplete 保留语义，不能变成0、false或空字符串。

拟新增 `answer-draft@3`，扩展现有 `AnswerDraft/PublishedAnswerBody` marker union，包含 resultManifestRef、resultManifestDigest、finalizationReceiptRef/digest、typed table blocks／summary bindings，及带精确引用的 typed statements。旧量值 claims 可复用；新增 money assertion、规则 `judgementAxis: applicability|business_proposition` 和 cell bindings 的 runtime Schema。body、叙述、summary、table pages、字段 descriptors、limitations、evidence manifest、finalization receipt 与 executionBindingRef 共同进入 contentHash。renderer 只能从 verified table manifest／typed statement 取值；模型解释不得增添新主体、数值、关系或规则结论。

@3 的 hash projection 固定上述 body 内容与所有依赖 ref/digest，不包含自己的 contentHash 或之后生成的 verification／table-verification receipt。核验 receipt 可引用 draftHash，但只能在 published answer 的读取 envelope 关联；不能回填原 body 或 manifest 后再声称 hash 不变。finalization receipt 在 draft 前归档，可进入其 hash；验证 receipt 在 draft 后生成，不产生 draft↔verification 的环。

当前128个 claims上限用于正文原子断言，不能靠一个 artifact_summary 跳过1001行。表格有独立有界逐页核验：读取完整 manifest，逐页验证所有行／字段／bindings及原结果；检查页数、行总数、无重复/遗漏rowKey、顺序、页digest、column身份和coverage。拟保存 `table-verification-receipt@1`，包含 draftHash、resultManifestDigest、全部 page digests、checkedRows/Cells、expectedRows/Cells、checksDigest、policyVersion。receipt 完整并通过才允许正式 table block；分页展示不是跳过后页验证的理由。

超cap／时间／预算或者某页缺失时，完整表不发布。可生成独立的明确部分结果 manifest，写出未覆盖范围、无完整合计／“所有”结论，再重新硬核验；不能修改完整manifest的metadata来包装成功。摘要统计从声明口径内完整结果或受限有界统计证据核验，不从一页抽样外推总量。

公共UI所需的拟新增data-only读取投影同样由本册定义，React组件在Web装配，不进入contracts：

```ts
interface TypedInputChange {
  recordRef: ResourceRef
  fieldRef: string
  fieldSchemaRef: VersionRef
  valueKind: string                         // 必须属于固定field Schema的类型
  previousValue: unknown                    // 运行时按field Schema校验
  proposedValue: unknown
  sourceRefs: readonly ResourceRef[]
  reasonCode: string
}

type ConfirmationProposal = {
  proposalRef: ResourceRef
  projectRevisionRef: ProjectRevisionRef
  kind: 'project_input'
  changes: readonly TypedInputChange[]
  requiresNewProjectRevision: true
  requiresApproval: true
} | {
  proposalRef: ResourceRef
  projectRevisionRef: ProjectRevisionRef
  kind: 'task_parameters'
  runId: Uuid
  expectedRunRevision: RevisionString
  taskBindingRef: VersionRef
  priorReceiptRef: ResourceRef
  parameterSchemaDigest: Sha256Digest
  changes: readonly TypedInputChange[]
  requiresNewProjectRevision: false
}

interface VerifiedTypedResultManifestView {
  answerId: Uuid
  runId: Uuid
  contentHash: Sha256Digest
  verificationId: Uuid
  resultManifestRef: ResourceRef
  resultManifestDigest: Sha256Digest
  finalizationReceiptRef: ResourceRef
  publicationKind: 'verified' | 'history_limited'
  coverage: ToolCoverage
  domainStatus: DomainResultStatus
  tables: readonly VerifiedTableDescriptor[]
  limitations: readonly string[]
  currentValidity: { state: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'; reason?: string }
}
```

`VerifiedTableDescriptor`为前述table descriptor的授权投影（tableId、columns、totalRows、manifest/page refs/digests、coverage与verification receipt），不附未授权raw payload。`currentValidity`是读取envelope的外部meta，不计入旧answer/manifest内容、不改其digest。proposal由服务端归档；`project_input`确认按数据分册产生新待审核项目修订，返回`{projectRevisionRef,requiresApproval:true}`，不能自动批准冻结；`task_parameters`确认按EX-2.2继续同run，返回`{runId,runRevision}`。客户端提交值仍按Schema、权限和CAS重新验证，展示投影不能授予发布权限。

### EX-7.2 每种证据的共同三层

| 证据／结果 | writer 必需绑定 | hard verifier 必需检查 | publication validity 必需重验 |
| --- | --- | --- | --- |
| published fact observation | schema/entity/field/value/unit/time/source/statement refs | 精确值、主体、字段、单位、同时间、完整refs与批准版 | 权限、statement更正/撤回、identity/schema refs、read-view fence/watermark；不能再仅按fact页形状限定整个gate |
| 实例 relation observation | relation type/version、两端完整refs、path/time、来源 | 实例边真实存在、端点/schema匹配；每hop完整/方向正确 | 端点身份变更、edge撤回/有效期、path snapshot/fence和覆盖 |
| SQL table/statistics observation | mapping/dataset/source/query/result refs、row/column、口径 | 编译白名单、精确DECIMAL、同row主体字段单位时间、coverage | 固定dataset是否仍授权／批准、source物化receipt与snapshot、mapping有效/撤回；无永久源快照时使用归档观察并明确时间限制 |
| rule_derivation | applicability/business axis、rule/definition、computation、所有premise/graph/time | 精确工件自digest、输入/branch/exception/dependency状态、实体与point，必要复算；不能只比较模型boolean | 规则/事实/关系/上游推导的撤回、相关dirty fence、水位、政策span可验证性与时间；不同支撑的OR不能被错误整体撤出 |
| document_span | document/parse/span/locator/text/quote完整绑定 | 授权bytes、UTF-8 digest、精确引用与locator、原始/规范映射；同文本别文档不能替换 | corpus/文档修订/撤回/权限、parse/索引generation授权与原文工件完整性 |
| computation | wrapper、operation/handler/schemas、输入/参数/输出pins、逐字段与domainStatus | output Schema、工件digest、row/column/单位/货币/时间／状态、coverage及计算版本；schema验过不等于客户算法已业务验证 | operation授权/版本、批准输入与每个外部依赖、输出完整性、invocation完成receipt；缺源或撤回不历史降级发布 |

`identity_decision` 和 `model_output` 作为相关依赖可被读取核对，但不独立证明业务值。`web_page` 沿用现有授权/快照/freshness策略，A的固定文档问答验收不依赖Web；启用后也不得绕过quote/来源有效性。不同 evidenceKind 的 checker 由 typed injected registry 装配，不按行业名称决定。

发布 gate 必须重验 run state/revision、当前权限、dispatch fence、完整 refs、verification policy/version、同draftHash与evidence/result manifests；source validity 的 `permission_revoked/evidence_retracted/evidence_unverifiable` 均阻断。仅 source 在核验后前进而旧artifact、原批准版本及权限完整时允许明确 `history_limited/asOf`；其他情况不能借历史发布绕过撤回或失权。若为了采用剩余OR支撑而改变refs/正文，生成新draft重新核验，不能在gate临时换依据。SDK final、客户端“pass”或JEV高分不能生成 publication grant。

## EX-8. 阶段模型、预算、取消和生命周期

拟新增内部 `WorkflowModelPhaseFactoryPort.forPhase({runId,resolvedProfileRef,runtimeRef,budgetLedgerId,phase,signal},ctx)`，phase 为 rewriting/drafting/verifying；返回当前phase被允许的generation/decision ports和完整model refs。`DraftWriterPort`／`AnswerVerifierPort` 拟扩展可选第三个 internal execution context，旧确定性实现兼容忽略；新模型实现不能通过静态constructor端口绕过run绑定。Controller每阶段创建新AbortController并加入active-work map；cancel/lease loss到达当前writer/verifier/模型/工具，在await后重新读取run状态再推进/发布。

generation/JEV adapter为每个实际provider attempt唯一预留/结算；gateway为每个实际tool attempt计量。controller不再给deterministic writer虚构固定64token预留，模型writer也不双记一层64token。拟新增端口元数据 `modelAccounting: 'none'|'adapter_owned'`，未声明的legacy writer按兼容策略管理但不能被注册为新模型writer。表格核验按同ledger剩余duration/bytes/rows约束；若需扩充硬核验用量投影，追加metrics而不新建ledger。澄清、补查、repair、transport retry、并行和重启均沿用账本，真实usage unknown维持占用和publication阻断。

Run状态仍使用既有 phase machine：created→preflight→collecting→drafting→verifying→published；合法分支 awaiting_input/resume、blocked/failed/cancelled 以及修复返回drafting／补收证按既有转换规则执行，不新建平行的任务状态机。readiness、rule四态、tool status、compute invocation状态是不同层，不把unknown业务结果等同Run失败。明确unknown／缺依据的typed有限答案可硬核验发布，limitations不能被UI隐藏。

恢复按风险分开：归档fixed plan/完成tool/evidence可重读；执行中的非幂等provider attempt无receipt时fail closed且usage_unknown；purecompute在声明replayable后可有限重试；完成draft/verification receipt按hash恢复；publication响应丢失由同逻辑键返回同answer。取消后的迟到events归abandoned，不恢复run、不插入answer。profile/runtime/SDK切换只影响新run；历史正文和工件继续授权读取。

修订／撤回保留旧artifact/answer。当前读可返回附加有效性meta，明确旧answer受哪个新revision影响，不能改变原body/contentHash。固定版本复算创建新run及新verification，标明原project/input/definition/mapping/operation refs，源不可重建时提示 archived_snapshot_only／不支持复算；“回读历史”不是复算成功。

## EX-9. HTTP 和错误

以下新增endpoint均为拟新增，沿用现有JSON error envelope、可信session/principal、RLS与权限映射。旧routes保留，无额外公共工具。

| API | 请求／返回要点 |
| --- | --- |
| `POST /api/v1/runs` | EX-2的可选task；幂等键＋固定refs，响应含run/dispatch关联，不手动start Controller |
| `GET /api/v1/runs/{id}`／`events` | 保留Run/SSE shape，新增task摘要、readiness/停止/缺项代码；无未核验正文流 |
| `POST /api/v1/runs/{id}/responses` | 原clarification及CAS；绑定参数proposal/receipt，执行scope不能变化 |
| `POST /api/v1/runs/{id}/cancel`、恢复入口 | 现有CAS语义与checkpoint pins；返回已接受cancel/恢复限制，非“立即没用量”承诺 |
| `GET /api/v1/runs/{id}/answer` | 兼容PublishedAnswer，body可为@3；resultManifestRef/digest及table摘要来自已核验版本 |
| `GET /api/v1/answers/{answerId}/tables/{tableId}?cursor&limit` | 仅读取published verified manifest中的页；cursor绑定answer/table/digest/scope，return rows/columns/bindings/coverage/verificationRef，不取latest dataset |
| `GET /api/v1/runs/{id}/answer/export?format=json` | 同answer body、typed result/表页、完整version/source索引、限制和核验refs；有界流式JSON或manifest refs，当前权限和工件完整性全量预检 |
| 现有 evidence read/dependencies/export、object history | 扩展V2 rule/政策span／表工件显示；维持有界授权，graph完整性独立于页面truncation |

拟新增错误码须登记于 `schema/error-catalog.json/errors.schema.json`，并统一HTTP/local/MCP映射，不把中文文案作为机器契约：

| 错误 | 分类／HTTP建议 | 状态与恢复 |
| --- | --- | --- |
| `PROJECT_DATA_NOT_READY`／`INDEX_NOT_READY`／`TASK_NOT_BOUND` | 409能力未就绪，非retryable模型故障 | 保存输入，显示缺能力/修复入口；ready后新run或允许的同输入重试 |
| `CAPABILITY_NOT_CONFIGURED`／`PROFILE_INCOMPATIBLE` | 409能力／版本未就绪 | 显示缺少的已注册能力／Schema／runtime；修复配置后新预检，不冒称成功 |
| `UNSUPPORTED_QUERY`／`UNSUPPORTED_RULE`／`PRECISION_UNSUPPORTED` | 422支持范围 | 明确澄清/受限，不能换任务后称成功；精度不支持不能偷偷转float |
| `RULE_DEPENDENCY_CYCLE`／`RULE_LIMIT_EXCEEDED` | 422发布阻断 | 候选保存unhandled和来源；修改后新candidate revision |
| `RESULT_INCOMPLETE`／`RESULT_LIMIT_EXCEEDED` | 422或tool partial+coverage | 不完整状态可被显式limited结果核验，不作完整结论 |
| `COMPUTE_INPUT_UNAPPROVED`／`COMPUTE_CONTRACT_MISMATCH` | 422前置条件 | 无执行；修正输入／绑定后新固定snapshot |
| `TASK_POLICY_NOT_BOUND`／`TASK_POLICY_FAILED`／`TASK_POLICY_INCOMPLETE` | 409未就绪或422策略阻断 | 保留报告与row/field定位；补能力/输入后新确认修订，不凭pass字段绕过 |
| `COMPUTE_OUTCOME_UNKNOWN`／`USAGE_UNKNOWN` | 409待协调 | receipt/usage reconcile前不自动重复或发布 |
| `EVIDENCE_BINDING_MISMATCH`／`TABLE_VERIFICATION_INCOMPLETE` | 422hard fail | 指出row/column/ref；有限repair沿用ledger |
| `NO_PROGRESS`／`BUDGET_EXHAUSTED`／`DEADLINE_EXCEEDED` | 已有或补登记的运行停止 | 明确停止；可发布仅已硬核验的limited事实，不能伪装完整成功 |
| `CHECKPOINT_INCOMPATIBLE`／`VERSION_CONFLICT` | 409，缺revision为428 | 说明旧snapshot/运行时不匹配；不能silent恢复或刷新refs |
| `FORBIDDEN`／`SCOPE_MISMATCH` | 403；按既有防枚举策略处理404 | 不泄露其他项目内容或存在性 |

异常必须保留canonical code、cause、retryable和定位上下文；重试仅已声明可恢复错误，最大次数计入共享限制。工具错误不会成为empty检索；archive/schema/accounting失败不会变成澄清成功。

## EX-10. 冻结的有限初值

以下是A默认部署初值和最小验收配置，不是容量、时延或费用保证。最终有效限制为平台ceiling、profile、task及operation声明的最小值；模型与客户端不能放宽。维护者调整需新配置版本＋preflight，超过本册已实现支持子集须新SPEC/契约验收；不能把调大参数当无限能力。

| 边界 | 默认初值 |
| --- | --- |
| 已知Template plan | 最多8步，DAG无环，依赖深度4；同run最多16实际tool calls，含分页／retry |
| Pi动态收证 | 最多6 rounds，工具并发2，失败修复最多1；admission在第7round前停止 |
| 全run | 180 s deadline；最多32,000实际model tokens（profile可更紧），最大draft attempts2；所有阶段／补查共用 |
| 规划器输出 | 单提案JSON64 KiB、generation事件总128 KiB、最多1024events；不把provider outputLimit当硬限制 |
| 查询／typed结果 | 总10,000行、最多32列；页250行、单页1 MiB、总结果16 MiB；固定排序／cursor／总coverage |
| 正文与核验 | 最多128原子claims/assertions；表页逐行逐字段单独核验、总10,000行；不能借正文cap省略表后页 |
| 规则表达式 | AST64节点、深度4；all最多8operands、any最多4branches、exceptions最多4 |
| 关系前提／规则依赖 | 每规则至多1 relation_exists节点、一跳，最多64targets；rule依赖DAG深度3、任务最多64rule版本 |
| 实例导航 | 指定path最多3hop；页250edge；单次最多2,000visited实体／4,000edge，超cap显式truncated |
| 文档收证 | 每次topK<=10，最多20唯一spans/任务；单span128 KiB、模型文本context总128 KiB，摘要不代替源bytes核验 |
| 规则证据 | 单wrapper1 MiB，source mappings最多256，依赖展开深度6／总nodes2,000，分页250并独立报告完整性 |
| compute | 沿用operation CPU/rows/bytes limits与剩余run期限；示例声明10,000行／16 MiB，输出Schema先验 |
| task policy | 每stage最多8个已注册策略；每策略最多10,000输入/结果行，report1 MiB、定位violations最多256并报告真实总数；截断诊断不把失败变pass |

数据解析的文件／sheet／批量上限由数据分册规定，和上述查询／结果上限分开。1001行样例使用250行页，后页事实/OR支撑/规则版本必须被真正读取核验。查询总cap、物化批次cap和可见性不等价，不能第1000行默认为全体；达到不同cap返回其明确限制。

## EX-11. A 的16故事测试ID建议

下列ID是拟定验收映射，不表示已有测试通过；主SPEC合并数据／UI分册覆盖。`A-EX-xxx` 对应A的 `US-xxx`，每条以独立业务预期和固定原始合成资料建立，受控模型只控制model输出，不替代正式query/rule/materializer/verification。

| ID／A故事 | 本册执行验收及关键反例 | 跨分册依赖 |
| --- | --- | --- |
| A-EX-001／US-001 | 公共工作区任务从正常HTTP dispatch运行；缺能力/权限/failed保留任务与草稿，API中文原因由机器码映射；SDK final不能成为UI正式答案 | 双助手/项目首页与场景mount浏览器 |
| A-EX-002／US-002 | 同原资料版本解析的text／JSON／CSV／XLSX locator到result来源；重复导入保持raw row/cell身份，错误定位不能移到别行 | 真实parser、分页失败行/来源对照 |
| A-EX-003／US-003 | 新OR/relation/dependency AST受同checker约束；超界候选保存不可执行；代码/任意URL动作建议不进入gateway | TBox/规则/action候选、人工编辑版本 |
| A-EX-004／US-004 | 受控HTTP记录实际generation请求含固定object/attribute/relation/unit和rule能力；unknown/conflict/精确Decimal修订有完整source binding | 固定Schema抽取/身份/字段确认 |
| A-EX-005／US-005 | 行业包发布验证cycle/unsupported规则/未注册operation；语义发布与可执行ready分开；synthetic样例不会进入真实project scope | 行业资产包/验证/导出挂载 |
| A-EX-006／US-006 | 新批准项目dataset真实query，改变原输入改变结果；不同列名/单位mapping语义一致且物理source不同；读旧演示snapshot/跨项目必须失败 | dataset ready receipt、两业务后端 |
| A-EX-007／US-007 | 普通中文问题分别选facts/rule/document/compute任务；歧义typed澄清、参数差异确认；无model/未知task不返回definitions默认答案 | task目录/普通输入UI |
| A-EX-008／US-008 | 独立金标覆盖different-condition OR、false/unknown/conflict、explicit缺失、exception、relation_exists和三层DAG；cycle/关系超界拒绝；导航读取真实instance relations | schema/rule审核、关系UI；data-service真实调用 |
| A-EX-009／US-009 | conclusion→premise→policy原文精确span/cell展开；相同文本另文档替换/digest/locator错/缺span/越权阻断；撤回一个OR支撑后仍有另一支撑、全撤后unknown，旧答不变 | 原文parser、政策来源、证据浏览器 |
| A-EX-010／US-010 | registered synthetic compute经normal task/gateway保存input/output/wrapper/field bindings；并发同logical key只有一个有效完成；缺input、错Schema、函数fail/cancel与outcome_unknown；必需input/result策略缺绑定或失败阻断 | 动作绑定/确认表单、扩展装配 |
| A-EX-011／US-011 | facts/relations/rule/SQL/quote/compute全类型writer＋hard checks＋source validity；每种注入错row/column/subject/unit/currency/time/ref/verdict；1001行后页错值不得发布，raw artifact不可冒正式表；伪造／错版本／错输出策略pass不得通过 | typed table/body/UI、published storage |
| A-EX-012／US-012 | 新授权text实际BM25索引后检索并exact quote回答；empty明确缺依据；revision/retract/index未ready、跨scope缓存和伪造引用反例 | 索引job/activation/corpus版本 |
| A-EX-013／US-013 | Template已知计划与Pi“先查不足→新补查→完成”经真实HTTP/Worker；duplicate、empty、round cap/预算停止；恢复guard/ledger；取消rewriter/collection/writer/verifier后late结果不发布；JEV概率不覆盖hard fail | runtime注册/模型端口/进度UI |
| A-EX-014／US-014 | 版本更正、输入/函数/mapping修订、撤回后新run；旧body/table digests不变；publication响应丢失同key读回、真正进程重启恢复；JSON导出同hash同scope；不可重建源不冒复算 | persistent stores、JSON/history浏览器 |
| A-EX-015／US-015 | 同task/evidence/verification契约在交通/工业、两mapping、Template/Pi、DuckDB/业务PG、local/真实stdio MCP共同支持组合通过；control PG不算业务PG，架构无行业判断 | 装配/真实替换契约套件、边界检查 |
| A-EX-016／US-016 | 两行业从原始合成资料→资产候选/编辑/发布→项目/导入/确认→普通问答四类→正文/表/来源/JSON/历史的真实浏览器/HTTP/Worker/PG E2E；1001行、缺值/错单位/OR/relation/撤回/取消/重启等独立反例；受控与真实model评测分别报告 | 主SPEC最终E2E、工程检查与已验收main SHA |

建议实现测试落点：`tests/contracts/v03-task-results.spec.ts`、`tests/unit/rule-v2-*.spec.ts`、`tests/unit/typed-*-writer.spec.ts`、`tests/unit/table-hard-verification.spec.ts`、`tests/integration/core-task-execution-postgres.spec.ts`、`tests/integration/core-dynamic-runtime-postgres.spec.ts`、`tests/integration/compute-task-publication-postgres.spec.ts`、`tests/integration/rule-policy-provenance-postgres.spec.ts`、`tests/contracts/execution-substitution.spec.ts`、`tests/e2e/generic-assistants-v03.e2e.ts`（均拟新增，命名可按repo组织调整）。实际浏览器脚本先 `pnpm run build:web`，再 `pnpm run test:e2e`；现 `platform/vitest.e2e.config.ts` 匹配 `tests/e2e/**/*.e2e.ts`，仓库没有 `playwright.config.ts`。`verify` 不含这个需要 Web build 与浏览器二进制的独立套件。容器使用显式带标签命名卷、teardown同时回收，不创建匿名卷泄漏；纯本次文档设计不运行这些程序。

## EX-12. 细粒度 Issue 候选与依赖

以下仅候选，不是GitHub／LOCAL编号，不启动实现循环。主manifest负责最终号、投入上限、状态和全覆盖；依赖 `DATA-*`／`ASSET-*`／`UI-*` 是对应分册的交付物引用，不假设已经存在同名Issue。

| 候选 | 可独立审查的实现边界 | 直接依赖 | 退出证据 |
| --- | --- | --- | --- |
| EX-01 execution/task契约 | canonical Schema、Run请求可选task、binding artifact、taskKind与operation全pin、兼容parse | 项目/输入契约 | A-EX-005/007的contract与legacy回归 |
| EX-02 服务端任务预检/固定binding | task resolver、project/profile/readiness一致、approved refs和原子run/manifest/dispatch | EX-01、DATA-readiness | A-EX-006/007的真HTTP与越权/旧digest反例 |
| EX-03 参数proposal/确认 | typed field diff、CAS receipt、scope不扩大；输入更改交项目修订 | EX-02、UI-confirm | A-EX-007/014同ledger澄清、新snapshot新run |
| EX-04 审查复用planner/receipt WIP | fixed bypass、fatal传播、bounded stream、完整receipt与checkpoint、迁移核对 | EX-01/02 | A-EX-007/013真实PG/受控HTTP，facts零model |
| EX-05 六任务compiler/公共工具接线 | TaskIntentProposal→authorized plan；ontology request联合、SQL/document/compute正常gateway | EX-04、DATA-query/index、ASSET-task | A-EX-007六类route/Schema/allowed refs及真实query gateway；各类正式发布在EX-19合流验收 |
| EX-06 规则V2表达式/发布能力检查 | Decimal、presence、不同条件OR、exception真值、同checker；V1兼容 | ASSET-rule-candidate、EX-01 | A-EX-003/008金标与超界不削弱 |
| EX-07 实例关系导航提取 | relation statement真实端点、有界path/cursor/time；Anker通用代码审查提取 | published关系/identity、EX-01 | A-EX-008/015导航及隔离/截断 |
| EX-08 relation premise/DAG编译求值 | one-hop目标谓词、positive rule_result、cycle/depth、紧凑support DAG | EX-06/07 | A-EX-008不同实体/时态/unknown/OR矩阵 |
| EX-09 V2增量依赖与history | relation/target/presence/上游规则依赖索引、dirty/outbox、拓扑物化、append slices | EX-08 | A-EX-009/014支撑撤回/1001后页/旧point不丢 |
| EX-10 规则前提/政策原文producer | 注入candidate/parse/span、policy绑定、V1/V2wrapper/reader、完整性分轴 | EX-09、DATA-source locators | A-EX-009真实import/PG/原文，不只模块单测 |
| EX-11 typed manifest/表工件/@3 | fields/row bindings、money context、分页manifest/hash、历史@1/@2读 | EX-01、DATA-output locators | A-EX-011/014 Schema/digest/1001表页一致 |
| EX-12 query/关系/规则/document writers | 六证据typed转换、unknown/precision/coverage与叙述绑定 | EX-05/10/11 | A-EX-011/012所有类型正反例 |
| EX-13 大表及全证据hard checks | 全row/cell分页检查receipt、statement/quote/rule/compute checks、精确subject/单位/货币/时间、必需policy reports | EX-11/12、EX-16wrapper、EX-20 | A-EX-011后页注错、无跳页、hash绑定、伪造策略pass阻断 |
| EX-14 publication validity dispatch | fact/relation/SQL/rule/document/compute source checkers；gate/lease/CAS/history_limited | EX-09/10/13、DATA-fences | A-EX-009/011/014核验后撤回/变更/失权/迟到 |
| EX-15 phase模型cancel/唯一计量 | fresh phase signal、model factory、none/adapter_owned、usage_unknown/repair同ledger | EX-04、既有model adapters | A-EX-013各phase取消/真实attempt账目 |
| EX-16 compute invocation/wrapper | approved input/operation全pin、logical key/lease/recovery、outputSchema/typed manifest/source依赖 | EX-02/05/11/20、ASSET-action、合成extension | A-EX-010真实gateway并发/故障/工件回读 |
| EX-17 Pi有界loop/checkpoint+Core注册 | 单loop、guard state/progress、严格adapter/SDK/profile pin；Template注册共契约 | EX-05/15 | A-EX-013/015补查/duplicate/restart/两runtime |
| EX-18 正式结果API/JSON与回读 | answer@3、verified表页/导出、history meta、raw artifact不能正式render | EX-11/13/14、UI-results | A-EX-011/014同answer同hash与权限 |
| EX-19 真替换与整栈验收 | 两SQL业务backend/local/stdioMCP契约、browser流程、独立model评测限制 | EX-02～18/20、DATA/ASSET/UI完整链 | A-EX-015/016及主SPEC工程/main门槛 |
| EX-20 注册任务校验策略 | policy registry/port、input/result绑定report/执行receipt、同ledger/cancel、manifest无digest环、required策略阻断 | EX-01/02/11、注册合成policy extension | A-EX-010/011缺策略、fail/incomplete、伪造pass/错输出/失权反例 |

可并行点：EX-06/07、EX-11、EX-15在各自契约冻结后可同时推进；EX-16与EX-12分别接compute和其他writer，EX-13等到wrapper/schema后合流；禁止EX-14仅为fact保持旧gate然后把其他类型标完成。依赖只表达功能门槛，不要求所有候选合成单个巨型PR。数据/索引/资产/UI分册的实现先后由主manifest合并；本册没有为B客户函数、价格或桥架Schema安排Core任务。

## EX-13. 兼容与实际交付记录

保留现有Run ID/phase/SSE、四工具名、scope授权、ledger和answer读取；新增版本化Schema/ref不自动扩权。旧published facts writer可继续写@2，新task若要求@3而host/writer/verifier不支持，preflight明确未就绪。reader同时支持@1/@2/@3和V1/V2规则工件；new writer只写目标版本，hash算法按schemaVersion区分。旧checkpoint若无法证明新guard/binding状态，说明不支持恢复；不能以删除历史或把新字段当空来兼容。

完成记录按候选实际变更填写：实现commit/main SHA、migration编号、支持的profile/runtime/backend/transport组合、适用lint/typecheck/边界/单元/真实PG-HTTP/浏览器结果、受控model与真实model质量验证、未验证项及cap实测。本次只创建技术文档，没有执行程序测试、联网模型、客户服务、Git mutation或Issue创建。
