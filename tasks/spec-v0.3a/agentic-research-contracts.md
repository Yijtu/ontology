# SPEC v0.3 A 分册：AI 搜寻/研究 agent 化契约（R00）

日期：2026-10-16。状态：**契约定案**。本次只落地 `platform/packages/contracts/**` 的公共数据/Schema/端口/版本/错误定义与测试，以及本分册；不改 `adapters`/`application`/`apps`（实现由 R01–R11 承接）。

权威设计：[design-agentic-research-2026-10-16.md](../design-agentic-research-2026-10-16.md)（尤其 §5–§10）。基础规格：[SPEC 主文](../spec-industry-semantic-agent-v0.2.md)、[C4 工具公共契约](../spec-v0.2/contracts-api.md)、[资产/数据 UI](asset-data-ui.md)、[执行/证据](execution-evidence.md)。

## 1. ADR-04/C4 增量：公共数据工具 vs 受控创作命令

原 C4 固定「四个模型可见只读数据工具」与「`verify_result`/`final_answer` 是 controller service，不在模型目录」。本分册在此基础上新增第三条边界，不改动前两条：

- **公共数据工具（只读）**：`ontology_lookup`、`data_query`、`document_search`、`web_search`，仍是唯一四个模型可见 `ToolId`（`TOOL_IDS` 不变）。
- **受控创作命令（写）**：`submit_candidates` 是**工作区写命令**，**不塞进四个工具、不藏进 `data_query`/compute**，而是建模为运行时动作联合的独立分支。模型侧表现为可调用能力，平台侧是一次受控写；本地与 MCP 后续共用同一命令服务与授权规则。

运行时动作联合（`src/runtime-action.ts`）：

```text
AgentAction = data_tool(ToolCall) | authoring_command(SubmitCandidatesCommand)
```

- `kind='data_tool'` 的 `call.toolId` 必须属于固定四个（`PUBLIC_DATA_TOOL_IDS`，直接取自生成目录 `TOOL_IDS`），否则拒绝。
- `kind='authoring_command'` 目前只有一个成员 `submit_candidates`（`AUTHORING_COMMAND_KINDS`）。

该边界只加契约，扩展 gateway 契约增的命令调用/回执分支、模型协议适配、Pi stream/事件/checkpoint 与运行时能力声明由 R04/R06 实现（见 §9 差异表）。

## 2. `SubmitCandidatesCommand@1`（`src/submit-candidates.ts`）

判别联合，一个候选可携带**多条**来源证据：

| 候选 kind | 内容 | 服务端固定项 |
|---|---|---|
| `source` | 本执行已归档页面引用（`origin`）+ 证据 + 理由 | `kind=web_fetch`、`trustTier=agent_researched`、`reviewState=proposed` |
| `definition` | object/attribute/relation 既有结构（`DefinitionCandidateProposal`，不含 `conflicts`）+ 证据片段 + 理由 | `candidateId`、`state`、`issues` |
| `rule` | 既有规则 AST（condition/exceptions/conclusion/applicability）+ 逐项来源定位 + 依赖引用 | `RuleSupportReport`（有限文法校验） |
| `action` | 既有动作声明（`ActionDeclaration`）+ 证据 + 理由 | `ActionCapabilityBinding`（注册/授权/合约绑定） |

证据（`CandidateEvidence`）逐条携带自己的定位与版本，故一个候选可跨多条来源：

- `web_page`：`url`、`snapshotRef`、`snapshotManifestRef`、`contentDigest`、`fetchedAt`、`parserVersion`；
- `located_span`：`sourceRef` + `CandidateSourceSpan`（文本块或结构化行）+ `parserVersion`。

**模型不能提供可信身份、审核结果、发布状态或自定义 `trustTier`。** 运行时校验 `assertSubmitCandidatesCommandShape` 在任何深度拒绝 `trustTier`/`trust`/`reviewState`/`reviewedBy`/`publishedAt`/`sourceId`/`candidateId`/`proposedBy`/`confidence`/`credibility`/`runId`/`idempotencyKey`/`principal`/`operatorId`/`subjectId`（`FORBIDDEN_MODEL_CANDIDATE_FIELDS`），确保候选的无来源、自授权提交在入库前被拒。

写入端口 `CandidateSubmissionPort`（application 实现；`tool-services` 不反向依赖 application）。宿主信封 `SubmitCandidatesRequest` 携带宿主生成的 `runId`/`logicalActionId`/`idempotencyKey`；**幂等键由宿主结合运行+逻辑动作+内容摘要生成**（规格 §7），故模型命令不含。回执 `SubmitCandidatesReceipt`（`accepted`/`rejected`/`replayed`）保证部分成功不伪装成整体成功。

## 3. 工具结果形状（`src/web-search.ts` + `src/document-targeted-read.ts`）

**`web_search` 区分两类发现**：`toWebSearchToolPage()` 把 provider 页面映射为

- `ArchivedPageDiscovery`（`discovery='archived'`）：原始快照 `snapshotRef`、manifest `snapshotManifestRef`、解析版本、可读文档引用 `parsedRef?`、抓取时间、内容 digest——可作依据；
- `DiscoveryOnlyPage`（`discovery='discovery_only'`）：URL、标题、摘要、不可归档原因（`WebSnapshotSkipReason`）——**不能**用它提交「已由原文支撑」的候选。

**`document_search` 增版本化定向读取**（`DocumentTargetedReadRequest@1`）：指定已授权文档/片段（可选 `parseId`）+ 有界游标 `cursor` + `limit` + `maxBytes`。结果 `DocumentTargetedReadResult` 每项绑定文档版本/locator/quote digest/parser version，`indexState` 区分 `indexed`/`not_indexed_readable`/`unavailable`（不把「尚未索引」当「没有内容」），截断显式返回，从不返回整篇。

## 4. 工具连接契约（`src/tool-connection.ts`，设计 §9）

与模型连接（`model-selection.ts`）显式分离、生命周期同构：配置连接 → 分配到 scope → 绑定到单次执行。**连接使用权 ≠ 可扩域名或放宽预算**。

- `ToolConnectionDescriptor`/`ToolConnectionAdminView`/`ToolConnectionSummary`（非密钥；`adapterType='native_tavily'|'http_compat'`）；
- `ToolAssignmentSet@1`（workspace/space 的 `inherit`/`disabled`/`connection`，按 `ToolId` 分配，含 `defaultSelection` + `toolSelections`）；
- `EffectiveToolSelection@1`（固定解析序 `object_tool → object_default → space_tool → space_default`，`state`/`blockedReason` 明确，`available` 必须具名连接）；
- `ExecutionToolBinding@1`（单次执行不可变，含 `connectionRef` 版本钉）；
- `ToolConnectionProbeResult`（**搜索/归档分项探测**：`search` 与 `archive` 两个 `ToolConnectionProbeItem`，不可只报 `passed`）；
- 端口：`ToolConnectionStore`、`ToolAssignmentStore`、`ToolSelectionResolver`、`ToolConnectionProbePort`、`ExecutionToolBindingStore`、`ToolCredentialCustodian`（复用模型设置同一凭据托管边界）、`ToolTargetDirectory`。

只传无密钥数据与不透明引用（`ResourceRef` 凭据引用）；探测结果回显脱敏原因，绝不回显 provider body。

## 5. `ResearchExecution@2`（`src/research-execution.ts`）

作为**运行投影**，把以下维度分列，读者不能互相反推、也不把计划步骤当完成进度：

- 执行状态：`status`/`stage`；
- 人工待办：`humanTodos`（`source_review`/`candidate_review`/`terminology_confirmation`/`external_wait`）；
- 停止原因：`stopReason`（沿用 `ResearchStopReason`）；
- 候选回执：`candidateReceipts`（`candidateId`/`kind`/`state`/`pendingConfirmation`/`issueCodes`）；
- 证据清单：`evidence`（`locatorKind`/`digest`/`parserVersion?`/`archived`）；
- 覆盖缺口：`coverageGaps`，按 `mustCover` 呈现 `unresearched`(未查)/`material_found`(找到材料)/`conflicting`(有冲突)/`pending_confirmation`(待确认)；**「找到材料」≠ 已证明正确**；
- 用量：`usage`（搜索/归档/模型 token·轮数/候选/下载与读取字节/修复次数/`usageUnknown`）。

**运行目标判别联合** `ResearchExecutionGoal`：`industry_workspace_research`（固定工作区草稿版本 `draftRevision`）与 `project_qa`（项目问答）。`ResearchRunManifest@1` 固定 brief/运行目的/runtime/模型绑定 `modelBindingRef`/工具绑定 `toolBindingRefs`/授权回执 `authorizationReceiptRef`/唯一账本 `budgetLedgerId`/输入清单 `inputManifestId`，`purpose` 必须等于 `goal.kind`。

**预算维度** `ResearchBudgetDimensions` 至少含：总调用/搜索次数/模型 token·轮数/来源数/候选数/下载字节/读取字节/并发/修复次数/deadline；以部署研究策略为上限、用户只能收紧（沿用 `BudgetLedgerLimits` 的「只能收紧」语义）。

## 6. `@1`/`@2` 兼容

- `ResearchExecution`（`@1`）**保持可读**：`assertResearchExecutionShape` 不变；`assertResearchExecutionAnyShape` 按 `schemaVersion` 分派，旧记录不伪装成 agent 运行（不迁移、不重写）。
- `researchExecutionSchemaVersion`/`isResearchExecutionV2` 为版本判别辅助。
- `ModelingBrief@1`、`CandidateSource@1`、`ResearchRequest@1`、`ResearchLimits` 语义不变；新增字段均为可选或新版本。

## 7. 契约落地方式（仓库既有约定）

核心线协议（`schema/*.schema.json` → `src/generated/**`）本次**未改动**，因此**无需重生成**生成物。领域契约沿用本仓库既有方式（与 `research-execution.ts`、`model-selection.ts`、`candidate-source.ts`、`web-search.ts` 同构）：手写 TypeScript 接口 + 运行时 Schema 校验（`assert*Shape`）、端口与错误码，经 `public-api.ts` 导出。边界数据在运行时校验，不靠 TS 断言；`contracts` 不依赖框架/DB/HTTP/行业实现，不含任何密钥。

新增导出：`submit-candidates`、`runtime-action`、`tool-connection`、`document-targeted-read`，以及 `web-search`/`research-execution` 的增量。

## 8. 规格 vs 实现差异（R00）

| 设计项 | 现状 | 本次（R00） |
|---|---|---|
| 四个公共数据工具（ADR-04） | 已实现（`TOOL_CATALOGUE`/`TOOL_IDS`） | 未动，作 `AgentAction.data_tool` 白名单 |
| `AgentAction` 联合、候选命令单独建模 | 无 | **新增契约**（`runtime-action.ts`） |
| `SubmitCandidatesCommand@1` + 回执 | 无（候选生成走同步 generation） | **新增契约**（`submit-candidates.ts`） |
| `web_search` archived/discovery_only | provider 已归档，但 handler 未传出引用（设计 §1） | **新增工具级发现联合+映射** |
| `document_search` 定向读取 | 仅检索（`DocumentSearchRequest`） | **新增版本化定向读取契约** |
| 工具连接/分配/绑定/探测 | 模型连接已实现（`model-selection.ts`） | **新增工具侧同构契约**（`tool-connection.ts`） |
| `ResearchExecution@2`、运行目标、Manifest | `ResearchExecution@1`、`RunManifest`（核心） | **新增 @2 投影与 Manifest 扩展**，@1 保持可读 |
| research job 执行内核、gateway 命令分支、模型协议/Pi stream、composition 装配 | 现为固定链路 | **不在 R00**：R04/R06 |
| 原生搜索/双层探测实现、研究暂存文档集、受控提交服务、迁移、UI | 无 | **不在 R00**：R01/R02/R03/R05/R07/R08/R09/R10/R11 |

R00 定案但不阻碍其它结论的三项（设计 §12）：① 原生搜索服务基线（建议 Tavily，需中文行业检索实测）；② 研究预算档位（只从部署约束收紧）；③ 普通行业网页的正式依据资格（首期仍为研究参考，不得塞进 `public_standard`）。
