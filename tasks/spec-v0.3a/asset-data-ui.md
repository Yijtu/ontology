# SPEC v0.3 A：行业资产、项目数据与公共双助手前端

日期：2026-09-29。状态：技术规格；本文所述新增表、接口和页面尚未实现。本文只做静态源码核对和设计，没有运行服务、测试、模型、迁移或分支操作。

来源：[阶段 A PRD](../prd-generic-assistants-core-v0.3.md)、[总体及阶段 B PRD](../prd-ontology-and-business-assistants-v0.3.md)、[既有 SPEC](../spec-industry-semantic-agent-v0.2.md)。本分册是阶段 A 主 SPEC 的规范组成；执行、任务绑定、规则语义、类型化结果与发布核验以 [execution-evidence.md](execution-evidence.md) 为权威，本文不再定义另一套运行控制器或证据协议。

## 1. 覆盖与边界

覆盖 A US-001～006、009、012、014～016 的资产／数据／前端部分，以及总体 US-001～015、019～024 的通用机制。A US-007～014 的执行和结果部分由执行分册覆盖。报价字段、权威价格、税费、报价表、报价 XLSX、人工金额差异和造价业务签核归 B 场景模块。

本分册的退出条件是正常浏览器完成资料→建模候选→人工编辑与审核→发布包→新项目挂载→实际实例导入和字段确认→可查询数据及文档索引就绪→受支持业务任务→已核验结果、来源、历史及 JSON 导出。行业切换和专业 UI 挂载也必须真实通过，不交付仅有接口的空框架。

### 1.1 已有实现与需要新增的接缝

| 源码事实 | 复用方式及新增工作 |
| --- | --- |
| contracts/src/semantic-definitions.ts 已定义对象、属性、关系、身份范围、规则约束和不可变 DefinitionBinding | 继续作为发布的语义模型；新增行业工作区、草稿和 TBox 候选，不能直接修改发布版本 |
| semantic-engine/definitions、control-postgres/semantic-definition-store.ts 已有定义校验／发布存储；migration 007 已落表 | 复用校验、digest 和版本冲突原则；包级发布需事务统一定义、包资产、组件注册与 outbox |
| extraction_candidates、candidate_review_heads、semantic_candidate_reviews 和 SemanticPublicationService 已有候选审核／事实发布 | 实例继续复用；TBox 候选使用同一审核记录、权限和 CAS 机制，不再建另一套审核决定系统 |
| application/packages/catalogue.ts 当前为 composition 预载的 InMemoryIndustryPackCatalogue | 新增动态持久 catalogue／IndustryManifestSource；从 UI 发布的包不允许只在重启后或手改示例列表才能挂载 |
| document-parse.ts／adapter-extraction-document 已有 original、normalized、spanMap、chunk／digest 和读取端口 | 扩展 JSON／CSV／XLSX 格式及 cell／JSON pointer locator；仍保留既有 text／PDF 历史读取能力 |
| ExtractionPipelineService.#runModel 现 system 为通用提示，user 只有 chunk.text | 增加固定行业 Schema／规则支持范围的实际请求上下文；不能只对响应做校验 |
| CandidateAttributeValue 已允许 string，但 schema-validation.ts 对 quantity 只接受 finite number | 新流水线 quantity 使用 DecimalString；联动 parser、提示、校验、发布、映射及结果核验 |
| core-local-composition.ts 的 createDuckDbSnapshot 只载启动示例；SemanticMappingRegistry 也是启动内存装配 | 新增批准项目快照物化／按固定修订解析数据组件；未就绪时拒绝任务，不回退到 fixtures |
| BM25 已有 generation／documents／postings／active 表，builder 及检索端口 | 复用；补项目 corpus 解析、generation 分配/CAS 激活、修订撤回 fence、项目授权与实际 ingestion 装配 |
| App.tsx 已有 AppViewContribution，deployment.ts 中 home-energy 仍有 profile 名称判断 | 演进为明确场景模块注册；公共 App 和 deployment 不再 import 或判断行业模块 |

源码位置均相对 platform/。现有 HTTP 使用 data/meta envelope、可信 RequestToolContext、If-Match 和 Idempotency-Key；新增接口沿用这些约定。迁移采用现有 forward-only runner，A0 同时核对 main/WIP 后分配新序号；不固定占用 057，不编辑旧 SQL。

## 2. 应用服务与依赖

新增职责放在现有 application／semantic-engine 与 adapters 包内，不为每个职责创建 npm 包：

- IndustryWorkspaceService：业务边界、来源集合、草稿头、候选生成与草稿差异；调用 GenerationPort，保存不可变候选。
- IndustryAssetPublicationService：组合现有语义校验／审核，事务发布定义和 PackAsset；动态 catalogue 读取该资产。
- ProjectService／ProjectInputSnapshotService：项目及资产 pins、记录修订、字段确认、批准快照、就绪状态与任务可用性。
- ProjectDataMaterializer：从已批准不可变输入写入受控业务快照；通过端口分别调用 DuckDB／业务 PostgreSQL writer，独立于只读 QueryPort。
- ProjectDocumentIndexCoordinator：从指定 corpus 构建和激活 BM25 generation，传播撤回及索引就绪状态。
- 公共 Web 工作区：通过 WorkbenchClient 请求上述 HTTP；专业场景只能通过 apps/web 的组合注册挂载 React 组件。

新增跨层端口在 contracts 中，只包含数据、权限上下文及行为约束；pg、DuckDB、React、XLSX/ZIP 解析库类型不得进入 contracts。新服务不 import 行业包或客户实现。composition 是唯一接入组件、Worker topic consumer、后端 writer 和场景模块的入口。

下表给出实现落点，标为“新”的文件尚不存在；全部路径相对 platform/。具体 SQL 迁移序号由 A0 分配。

| 落点 | 目标改动 |
| --- | --- |
| packages/contracts/src/projects.ts、asset-workspace.ts 及 schema/projects.schema.json、asset-workspace.schema.json（新） | 本册项目／资产／输入／就绪形状与 ports；生成工具同步 generated/contracts.ts，不直接手改生成物 |
| packages/contracts/src/document-parse.ts、extraction.ts、pack-assets.ts | additive 格式、locator、exact quantity、合成样例 refs；保持历史 Schema 可读 |
| packages/application/src/assets/*、projects/*（新），packages/application/src/packages/catalogue.ts | 行业草稿、项目冻结、物化和索引协调；catalogue 通过注入读端口查持久资产 |
| packages/adapters/control-postgres/src/asset-workspace-store.ts、project-store.ts（新） | 同控制事务 CAS／版本／审核复用／outbox；组合既有 semantic-definition-store.ts、semantic-publication-store.ts |
| packages/adapters/extraction-document/src/*，search-bm25/src/builder.ts、postgres-store.ts、index-build-stage.ts | 四格式及来源回读；真实 corpus、generation 分配和事务激活 |
| packages/adapters/data-duckdb/src/project-materializer.ts、data-postgres/src/project-materializer.ts（新） | writer／receipt；已有 adapter.ts 保留只读 QueryPort，semantic-engine 的两类 SQL renderer 接入 exact factor |
| apps/api/src/http/assets.ts、projects.ts、documents.ts（新），composition/core-local-composition.ts | 同 host 路由、可信上下文、动态 catalogue／dataset registry／worker topics 装配 |
| apps/web/src/api/client.ts、components/App.tsx、SourcePanel.tsx、PublishedAnswerBody.tsx；scenario-module.ts（新） | 公共客户端和双工作区；受信 frontend registry、已核验 renderer，main.tsx／deployment.ts 使用明确组合 |

## 3. 版本及状态契约

以下是目标新增形状。Uuid、RevisionString、VersionRef、ResourceRef、MappingRef、ResolvedProfileRef、DecimalQuantity、CompletenessStatus 均复用现有类型；HTTP 的 revision 始终为十进制字符串。

### 3.1 行业工作区、草稿及候选

~~~ts
interface IndustryWorkspace {
  workspaceId: Uuid;
  namespace: string;
  displayName: string;
  boundary: { goals: string[]; included: string[]; excluded: string[];
    applicability: { region?: string; validFrom?: string; validTo?: string } };
  headRevision: RevisionString;
  latestPublishedPackRef?: VersionRef;
  state: 'draft' | 'review' | 'published' | 'archived';
}
interface AssetDraftVersion {
  workspaceId: Uuid; revision: RevisionString; digest: Sha256Digest;
  basePackRef?: VersionRef;
  documentSetRef: ResourceRef;
  // 逻辑定义 ID 对应的是不可变候选版本 UUID，而非可变 payload。
  candidateRefs: { logicalId: string; candidateId: Uuid; digest: Sha256Digest }[];
  syntheticExampleSetRef?: ResourceRef;
  validationRef?: ResourceRef;
}
interface AssetCandidateVersion {
  candidateId: Uuid; workspaceId: Uuid; logicalId: string;
  domain: 'definition';
  kind: 'object' | 'attribute' | 'relation' | 'identity_scope' | 'rule' | 'action';
  payload: SemanticDefinition | ReviewedRuleProposal | ActionDeclaration;
  inputDraftRef: { workspaceId: Uuid; revision: RevisionString; digest: Sha256Digest };
  sourceRefs: ResourceRef[]; sourceSpans: CandidateSourceSpan[];
  state: 'produced' | 'pending_review' | 'failed' | 'rejected';
  issues: { code: string; path: string; message: string }[];
  replacesCandidateId?: Uuid;
  generationCallRef?: ResourceRef;
  contentDigest: Sha256Digest;
}
~~~

ReviewedRuleProposal 使用执行分册的有限规则 AST、显式例外、结论及支持状态，不同时创造第二种规则解释器。SemanticDefinitionVersion 的 ruleConstraints 与运行规则策略由同一编译/校验过程产出并固定关联；不能只发布一种结构，执行另一份未经审核的规则。

ActionDeclaration 保存语义名称、输入／输出 SchemaRef、前置条件、所需能力、权限、readOnly／副作用类别及 TaskBindingRef。其实际 operationRef／handlerRef 由受信部署装配，未绑定可保存／发布声明，但执行能力状态必须为不可用。A 仅启用有受控实现的只读示例动作；不自动注册模型生成代码。

GAP-008 的平台生成、逐条件原文定位、共同预算／CAS，以及人工编辑后的来源确认接口见 [规则与动作生成契约](../../platform/docs/rule-action-generation.md)。人工确认必须回读实际批准资料并追加新的未审核候选；旧批准、模型生成调用和旧来源状态不得继承为新修订的依据。

草稿状态与候选状态分开。一次生成保存独立 candidate versions 和生成调用记录，完成后只生成“应用建议”差异，不覆盖期间发生的人工编辑。用户接受建议、编辑、合并术语或拆分类型均追加新草稿修订；涉及内容改变的候选产生新 candidateId，之前的 approve 不能沿用。仅改变显示排序不改变定义内容，但仍记录草稿操作。

TBox 候选内容由新 asset_candidate_versions 保存，审核继续写现有 semantic_candidate_reviews／candidate_review_heads。抽出可注入的 ReviewableCandidateReader，使现有审核服务可读取实例或 TBox 的 candidateId／state／digest／source；审核路由、角色、reason、evidenceRefs、If-Match 和历史算法共用。事实发布端显式拒绝 domain=definition 的候选，行业包发布端显式拒绝 instance 候选。这里新增的是审核对象，没有另一套 approve 真值或第二份决定表。

### 3.2 项目修订、批准输入与就绪投影

~~~ts
interface ProjectRevisionRef {
  projectId: Uuid; revision: RevisionString; digest: Sha256Digest;
}
interface ProjectRevision {
  ref: ProjectRevisionRef;
  industryPackRef: VersionRef;
  definitionRef: VersionRef;
  mappingRefs: MappingRef[];
  profileRef: ResolvedProfileRef; // id/version/snapshotHash，复用既有形状
  documentSetRef: ResourceRef;
  approvedInputRef?: ResourceRef;
  datasetSnapshotRef?: ResourceRef;
  documentIndexRef?: ResourceRef;
  semanticPublicationRefs: VersionRef[];
  sourceVisibilityEpoch: RevisionString;
  changeReason: string;
}
interface ApprovedInputSnapshot {
  schemaVersion: 'project-input-snapshot@1';
  projectId: Uuid;
  inputRevision: RevisionString; // 冻结前读取的输入修订，工件不含最终项目digest
  definitionRef: VersionRef; mappingRefs: MappingRef[];
  recordPages: { ref: ResourceRef; rowCount: number; firstRecordId: Uuid;
    lastRecordId: Uuid }[];
  counts: { total: number; confirmed: number; approved: number;
    excluded: number; pending: number; failed: number };
  excluded: { recordId: Uuid; reason: string; actor: string }[];
  coverage: CompletenessStatus;
  confirmationManifestRef: ResourceRef;
}
interface ReadinessProjection {
  projectRevisionRef: ProjectRevisionRef;
  kind: 'published_semantics' | 'dataset' | 'document_index';
  targetRef: ResourceRef | VersionRef;
  state: 'pending' | 'building' | 'ready' | 'failed' | 'revoked';
  completeness: CompletenessStatus;
  expectedCount: number; processedCount: number; failedCount: number;
  targetDigest: Sha256Digest;
  receiptRef?: ResourceRef;
  fenceRevision: RevisionString;
  jobId?: Uuid; error?: { code: string; retryable: boolean; message: string };
}
~~~

ProjectRevision 内容固定，ready／failed 不属于其 digest，而是独立投影。批准时先归档确认清单、分页数据及期望 DatasetSnapshot／DocumentIndexSnapshot manifests，再在控制事务创建新项目修订、绑定 refs 与 enqueue outbox。Worker 完成后只写 receipt 和 readiness，不后填或修改同一项目修订的 refs。

上述 ProjectRevision 是读取 envelope，ref 含项目正文计算出的 digest；它不直接作为 canonical hash body。新增 ProjectRevisionBody 固定 projectId、revision 及上述资产／输入／数据／语料 pins、visibility epoch 和 changeReason，排除 ref 及任何自身 digest 字段。先序列化并 hash 该 body，再构造外层 ProjectRevisionRef 和读取 envelope；两者使用分别命名的 Schema 校验。body 不因外层 ref 或 readiness receipt 到达而改写。

snapshot manifest 自身不包含自身 digest，避免循环 hash；ApprovedInputSnapshot body 不含最终 ProjectRevisionRef。具体冻结顺序为：先生成 records＋confirmation manifests；approved-input body 固定 projectId、inputRevision、asset pins 和成员 refs，不含最终 ProjectRevision.digest；计算 inputSnapshotRef；再计算含该引用的 ProjectRevision.digest。HTTP 读取 envelope 可另含 projectRevisionRef／inputSnapshotRef，不计入 approved-input 工件内容。序列化 Schema 必须显式区分 body 与 envelope。

datasetSnapshotRef 指向从批准行、映射、物理 Schema 和行顺序构成的不可变逻辑数据快照 manifest。documentIndexRef 指向 BM25 corpus／parser／tokenizer 固定版本的不可变索引快照 manifest，其 receipt 包含既有 collectionRef、generation、indexRef:VersionRef 及 indexDigest。ResourceRef 包装不会代替 BM25 既有 generation 协议。

项目头可变，修订不可变。字段、资料、身份绑定、mapping 或行业版本变化产生新修订；当前任务使用明确 ProjectRevisionRef，旧 run 不更换 inputSnapshotRef。语义／SQL／文档索引 readiness 独立：属性任务无需强制等待 BM25，文档任务必须等待该 corpus 的索引，规则任务必须等待所需语义 fence。只允许依 taskBinding 所需能力判定 ready。

换本体版本使用 `POST /projects/:id/evolutions`（`/evolve` 为同一严格入口），须有 If-Match、Idempotency-Key、确切已发布行业包、`new_version / keep_independent / retire_previous` 策略和逐个原始导入映射的人工对应关系。配置演化的宿主拒绝旧 pack-mount 瞬时改定义入口；PG 也拒绝已有记录／项目规则的项目仅替换 definitionRef。项目可变读 envelope 的 `headRevision` 固定新的待审核修订，`activeRevision` 固定当前已激活修订。当前普通查询／已发布项目规则读 active；新候选、字段确认、身份裁决与事实发布仍校验 staging head。`stagingWritable=false` 拒绝取消后的迟到写入。旧 run 继续使用归档绑定和不可变的已激活快照，不用当前 readiness 代替历史授权。

演化协调复用 topic outbox，保留原始资料／parse／映射／全部贡献语句版本和已发布原始 recordId 集合。原文重新读取、绑定新映射、200 个 selector 一批的候选抽取和 pending 实例创建均有界；不复制原审核或身份决定。最多 10 个来源、20,000 个原始记录／次、3 个尝试，重试共享累计 recordOperations／batches，不重新获得预算。缺失／冲突类型等不可迁移记录保持 `needs_human`，关系变更须有真实的新端点候选、当前人工审核和关系发布。已撤回的原始记录不会因为重读同一字节而再次成为支撑。

所有重建实体经既有字段确认、身份裁决、审核账本和事实发布后，官方事实 reader 复核完整原始记录覆盖及新增字段，再建立各对象的确切业务快照。实际后端 activation receipt、当前源／语句／人工决定和 readiness 在最终项目事务再次校验；只有 staging head 与旧 active 同时满足 CAS 时才更新 activeRevision。`keep_independent` 保留旧 readiness；`retire_previous` 仅撤旧版当前 readiness，保留所有历史事实、语句版本、旧快照与凭据。失败／取消／撤回／并发换版均不能让旧尝试重新激活。`dataset_materialization` 演化作业由其专属 outbox consumer 和有限 CAS 协调处理，通用 ingestion worker 不重复执行它。

新版输入由真实已激活业务快照中的官方记录分页归档；独立 confirmation manifest 保存既有字段确认事件、真实身份绑定及内容固定的审核账本记录。`ApprovedInputSnapshot` 使用这些真实页、明确排除项及实际已确认／已批准计数，不能只写一个批准 marker。最终 CAS 将其不可变 `inputSnapshotRef` 与各对象快照一起封存在演化激活记录中，不回填 staging ProjectRevision。普通任务 preflight 在修订本身没有旧 approvedInputRef 时，通过宿主 `projectApprovedInput` 端口读取实际工件字节并重核数据页、激活快照与人工证据；仅接受同一实际输入 ref/digest。配置了 ProfileStore 的演化同时要求确切的目标 ResolvedProfileRef，复算实际已解析 manifest hash 并核对目标 industryRef；新版普通任务必须使用该项目修订固定的实际 profile。旧输入／旧 profile 不得借新版 ready 绕过这些固定引用。

### 3.3 字段确认与记录修订

~~~ts
interface FieldConfirmation {
  recordId: Uuid; recordRevision: RevisionString; fieldId: string;
  rawValue: string | boolean | null;
  normalizedValue: { kind: 'scalar'; value: string | number | boolean | null }
    | { kind: 'quantity'; value: DecimalQuantity }
    | { kind: 'reference'; entityId: Uuid };
  source: { documentRef: ResourceRef; parseId: Uuid; chunkId: Uuid;
    locator: SourceLocator; textDigest: Sha256Digest; quoteDigest: Sha256Digest };
  status: 'pending' | 'confirmed' | 'conflict';
  reason?: string; actor?: string; confirmedAt?: string;
  confirmationRevision: RevisionString;
}
~~~

fieldId 是 Schema 中的属性 ID 加必要的重复值序号，不是前端随意 JSON path。UI 可展示 path，但更新服务校验 Schema、cardinality、单位、来源和关系端点。字段确认是输入治理记录，不能代替现有 candidate approve／publish。

字段修改在同一事务追加 record revision／confirmation event，并建立新的实例 candidate 版本和 current-candidate 绑定。旧 candidate payload、审核和身份历史保留；需重新校验与审核，当前项目不能通过旧 candidateId 发布旧值。实例审核／发布服务增加 current-revision guard；旧的独立非项目流程保持兼容。批量确认只接明确的 recordRevision／fieldIds，服务返回成功、冲突和跳过列表，不能一键把未读取的全量记录视作确认。

人工新增实例或补参同样保存真实来源：服务把用户提交的 exact JSON bytes 归档为 project-owned manual-entry 文档，记录 actor、time、reason、前一来源引用和 entry digest，走同一 JSON parser／Schema validator 创建候选及 json_pointer locator，不需要模型。新增行的稳定 recordId 由服务分配；人工更正保留原文件来源和 manual-entry 的修订链。SourcePanel明确显示“人工录入／修改”，不能把手填值标成客户原单元格或伪造引用；保存后仍待字段确认、身份裁决及审核批准。

### 3.4 合成实例与独立验证

新增 SyntheticExampleSetVersion 工件，固定 sourceKind:'synthetic'、dataMode:'synthetic'、所验证 draftRef 或 definitionRef、生成策略／模型调用 ref、分页 case refs 和人工确认的 expectation refs。工作区提供“生成测试实例”，可选缺参数、同名异物、矛盾、错单位和缺能力反例；生成结果可编辑后形成新样例版本，并持续显示“合成测试”。它与既有 PackAsset.exampleSet 的 FewShotExampleSet（问题／查询形状）是不同资产，不能复用同一字段。

样例只进入独立验证 sandbox，不能走真实项目 input-publications 或 SemanticPublicationService。后端按 dataMode 和目标空间强拒绝将其发布为 observed/live；标签不能仅由 UI 显示。草稿规则由同一有限编译／求值器检验，已注册动作经受控扩展试算，未绑定动作返回具体 blocker。结果保留 Schema、规则／动作 refs、coverage、支持状态及实际试算 receipt；验证不在草稿上凭空创建业务 pass。模型生成样例的期望答案须专家确认或来自独立 authored oracle，不能用同次生成或实现输出充当金标。共享包可携带经审核合成样例，真实项目实例不随之导出。

## 4. 持久化、索引和事务

新增表均在 agent_platform，复合 PK／FK 带 tenant_id、space_id；应用显式授权和 RLS 同时执行。每条事件包含 actor、trace_id、reason、recorded_at。JSONB 不保存大型原文、全量长表或密钥；这些进入既有 immutable blob registry。

### 4.1 表和索引

| 表／变化 | 主键、重要字段与约束 | 必需索引 |
| --- | --- | --- |
| industry_workspaces 新 | scope＋workspace_id；namespace、display_name、head_revision bigint、state、latest_pack_ref；namespace 不是跨客户全局唯一 | scope＋state＋updated_at＋workspace_id |
| asset_draft_versions 新 | scope＋workspace_id＋revision；digest、body_ref、document_set_ref；append-only | scope＋workspace_id＋revision desc |
| asset_candidate_versions 新 | scope＋candidate_id；workspace_id、logical_id、kind、content_digest、payload、input_draft_ref、sources；unique scope＋idempotency_key | scope＋workspace_id＋kind＋state；scope＋logical_id＋recorded_at |
| 既有 review_heads／semantic_candidate_reviews 复用 | 同一个 candidate UUID 对应不可变内容；新增 reader dispatch 验证 TBox／instance；旧记录及权限不迁移成另一份决定 | 保留 candidate_id＋revision；审核读取须再查对象授权 |
| published_pack_assets 新 | scope＋pack_id＋version；digest、manifest_ref、asset_ref、definition_ref、validation_ref、origin_workspace_id；同 id/version 不同 digest 拒绝 | scope＋namespace＋published_at；scope＋definition_id/version |
| projects 新 | scope＋project_id；title、head_revision、state、created_by | scope＋state＋updated_at＋project_id |
| project_revisions 新 | scope＋project_id＋revision；digest、body_ref、source_visibility_epoch；append-only | scope＋project_id＋revision desc |
| project_documents 新 | scope＋project_id＋document_id＋membership_revision；original_ref、parse_ref、state:active/retracted、visibility_epoch；历史成员不覆盖 | scope＋project_id＋state；scope＋parse_id；scope＋document_id＋membership_revision |
| project_record_versions 新 | scope＋project_id＋record_id＋revision；stable_source_row_key、candidate_id、body_ref、current-head linkage；原行／实例分开 | scope＋project_id＋source_row_key；scope＋candidate_id |
| field_confirmation_events 新 | scope＋project_id＋record_id＋field_id＋revision；content_digest、status、actor、source_ref、event_payload；projection 为 current record body | scope＋project_id＋status＋record_id；scope＋record_id＋field_id＋revision |
| project_mapping_versions 新 | scope＋mapping_id＋version；import_mapping_ref、semantic_mapping_ref、definition_ref、digest、dialect；客户 mapping 不进入行业包 | scope＋definition_id/version；scope＋mapping_id＋version |
| project_readiness 新 | scope＋project_id＋project_revision＋kind＋target_digest；state、fence_revision、receipt_ref、counts、job_id、error | state＋available_at 用于已授权调度；scope＋project_id＋project_revision |
| project_projection_events 新 | scope＋project_id＋seq；kind、expected_ref、effect、idempotency_key；unique scope＋idempotency_key | scope＋project_id＋seq；scope＋kind＋target_digest |
| 既有 job_outbox／jobs／job_attempts 复用 | 新增 topic 和 pipeline kind，不另建队列；幂等键包含目标修订、targetDigest、pipeline／parser／mapping版本 | 保留 claim／lease／outbox 索引 |
| 既有 keyword_index_* 复用并增补 | generation 分配以 collection counter 事务进行；active 指针加 membership_revision／corpus_digest／fence_revision CAS | 原 postings／lineage 索引；active 按 scope＋collection_ref |

table body 中 scopeRef 不是可信权限。workspace／project 访问还须核对归属及 allowedResources；只符合 tenant/space RLS 不意味着可以读取同空间另一个无权限项目。派生索引、cache 与 model context 沿用同一项目资源范围。

### 4.2 写入原子性

1. 写操作要求 If-Match；创建资源要求 Idempotency-Key；首次 review expectedRevision=0。命中相同 key＋相同 requestDigest 返回原结果；相同 key 不同 payload 返回 IDEMPOTENCY_CONFLICT。
2. 事务用 SELECT ... FOR UPDATE 锁对应 workspace／project head，检查 revision，追加不可变版本及事件，更新 head，写 job_outbox 后提交。失配返回 409 VERSION_CONFLICT，缺 header 返回 428 REVISION_REQUIRED；客户端重新加载差异后人工决定，不自动重复旧覆盖。
3. 大工件先写受控暂存并验证 digest，成功后提交引用；数据库事务失败不使工件成为可查询事实，孤立工件由既有保留／回收策略处理，历史引用不回收。
4. 包发布是一个控制库事务：校验 exact 草稿及 shared review revisions → semantic_definition_versions＋events → published_pack_assets → component registry 声明和事件 → workspace publish pointer → outbox。application 使用单个事务端口 AssetPublicationStore.commitApprovedAsset；不能串调各自独立事务的服务并宣称原子。具体 SQL／pg transaction 留在 control-postgres；复用现有纯校验及 canonical hash。
5. 批准项目输入是一个控制库事务：核对 current candidates、字段确认、身份和 shared review revisions → 调用现有事实发布核心的事务内写入 → 保存批准 facts revisions／approved input refs／ProjectRevision → 设置 semantic/query/index 的 pending／fence → outbox。新增 ProjectInputPublicationStore.commitApprovedInput 持有同一控制事务并复用现有发布校验／SQL，不能先独立发布事实再冻结快照并宣称原子。只冻结已发布事实的兼容请求也必须检查 current-candidate guards 和 exact publication refs。执行授权和前置校验在 run 创建及正式发布前再次检查。
6. 跨控制库、业务库和 blob 没有分布式原子事务。物化先写 staging 并校验→业务库内原子提交→控制库 CAS ready＋receipt；失败保持 pending／failed，重试按 snapshot digest 重用已经提交的数据。仅前两个阶段成功不得提前显示 ready。

### 4.3 后台作业与 pipeline

复用 JobWorker／TopicOutboxConsumerRouter 和租约、attempt、预算、重试。JobKind 新增 asset_generation、dataset_materialization、document_index；保持原 ingestion／simulation。新 pipeline 声明合法阶段，不能让 BM25 的 extracted→published 越过现有 canAdvanceJobStage 检查。索引／物化短管线显式采用 received→parsed→extracted→validated→published，validated 的终点由 pipeline 类型允许；ingestion 仍停在 awaiting_review。规则／定义审核不由 worker 越过。

topic 至少包括 asset.pack.published、project.data.materialize、project.documents.index、project.document.visibility.changed。消费者在事务成功后 ack，失败有限退避并保存 stage error；不把本项目的所有失败通配成“重做行业”。generation/model attempt 至少一次，candidate／publication／projection commit 幂等，不承诺外部模型 exactly once。

## 5. 资料解析、来源定位与精确值

### 5.1 格式和限额

新文件上传路由默认单文件 20 MiB；文本原始粘贴仍可沿用既有 /api/v1/ingestions 的 1 MiB 限制。新解析默认单个选定工作表／JSON 数组最多 10,000 数据行、128 列、单元格文本 64 KiB；文本最大 chunk 8 KiB、单次 reader 64 KiB、UI 页面 100 行。XLSX ZIP 展开上限 100 MiB／10,000 entry，拒绝超界、加密文件和宏执行。限额由版本化 parser policy 配置并在上传前显示；超限不能截断后写 complete。

支持范围为 UTF-8 文本、JSON、CSV、XLSX。A 不承诺 PDF／扫描件／DWG 新导入路径；旧已保存 PDF 的来源回读继续兼容。CSV 选择编码／分隔符／表头及列，XLSX 选择 sheet／表头行／数据范围及列；CSV 没有 sheet 选择。

- 文本：验证 UTF-8，保留 original bytes、换行及 normalization map；offset 明确 byte/character 单位。
- JSON：支持一个对象、对象数组或约定 records 数组；使用可保留数字词法值的解析路径，拒绝无法定位的重复键。不得先 JSON.parse 将 quantity 数字变 Number 再 stringify。locator 固定 JSON Pointer 和原始 byte range；显示原始 number token。
- CSV：处理带引号、换行、空值的字段，保留 record index／物理行范围／column index／原始 byte range。空字段是 missing，不是 0。列映射按位置＋表头 digest，重名表头不依名称猜测。
- XLSX：读取原始 OOXML 的单元格类型和 lexical value，保留 sheet 的稳定 ID/name、row/column/A1 address、shared string 引用解析结果及原值。数量／尺寸从 XML 十进制 token 读取；只给出 JS Number 的库输出不作为 exact 输入。样例验证解析依赖并锁 lockfile 后才能启用该 parser adapter，不依赖客户 Excel 在机器上打开。数值公式单元格显示 formula 与 cached value，首期不计算公式、cached value 未确认不进入批准输入；日期和显示格式不把 ID／数值自动改成日期或科学计数结果。

多级表头、合并单元格、外部链接、跨表公式等首期不支持结构明确定位并请求模板/范围调整。隐藏行、空行与表头行数量分开展示；没有显式用户选择就不静默排除有数据的隐藏行。

### 5.2 SourceLocator 与 span 读取

扩展既有 DocumentSpan.locator／ReadSpanRequest.locator 的 tagged union；旧 page／offset／approximate_locator 保持读取：

~~~ts
type SourceLocator = ExistingDocumentLocator
  | { kind: 'json_pointer'; pointer: string; startByte: number; endByte: number;
      normalizationMapRef: string }
  | { kind: 'table_cell'; format: 'csv' | 'xlsx'; sheetId?: string; sheetName?: string;
      recordIndex: number; row: number; column: number; address?: string;
      startByte?: number; endByte?: number; normalizationMapRef: string }
  | { kind: 'table_row'; format: 'csv' | 'xlsx'; sheetId?: string; sheetName?: string;
      recordIndex: number; row: number; columnFrom: number; columnTo: number;
      normalizationMapRef: string };
~~~

row／column／recordIndex 在展示契约中均从 1 开始，byte interval 半开。sheetId 来自 parser 固定映射；locator 不接任意本机路径。quoteDigest 是原始选定值／片段 bytes 的 sha256，textDigest 是返回片段的文本 hash，二者在 normalized 情况下可不同。spanMap 保存确定映射，全文原文与规范化值并列展示，不把规范化结果冒充逐字原文。

DocumentMediaKind 扩展 json/csv/xlsx；DocumentChunkRecord 继续承载 table chunk，新增 cell/row members refs，不将全部大表塞一个文本 chunk。BM25 store 的 toLocator、span reader、evidence schema、API/UI decoder及生成契约一起扩展。表行检索命中可先返回 row locator，再展开具体 cell；缺原文件或 digest 错误阻断精确来源声明。

### 5.3 Schema 入 prompt 与 exact quantity

实例抽取加载项目固定 definitionRef 的 IndustrySchema，生成 canonical schemaContext 工件，内容包括 objects、attribute 类型/cardinality/单位/enum、relations 端点、identityScopes、有限规则语法/支持上限及 decimal 表示。GenerationRequest 的 system 包含 schemaContext 的限定内容和 digest，user 输入来源片段并标为资料；记录 promptVersion/schemaDigest/parserVersion/modelRef/inputDigest。超模型上下文按对象／有界行组拆分，不能静默丢掉约束或整单一次投喂。

TBox 生成与实例抽取采用不同 responseSchemaRef。TBox 请求提供业务边界、已有草稿 ID/类型约束、允许候选种类和规则支持语法；没有已发布行业包时使用 bootstrap 建模协议，不要求先有行业 Schema。模型输出的新类型只是 definition candidate，不能进入实例 canonical ID。

quantity 新候选线形仍为 {attributeId, value: DecimalString, unitCode}；类型由固定 Schema 校验。raw lexical 值另存 FieldConfirmation；规范十进制禁止 NaN／Infinity／非法指数、超精度和无声明舍入。负值是否允许由属性约束决定，不通用禁负。旧 finite number quantity 仅兼容历史读取，新的 XLSX/CSV/JSON 输入及模型输出不得经 Number 转换伪造 exact。单位转换用固定维度、精确因子／分子分母及显式 scale/rounding policy；需要长度、组成等业务依据的换算归场景校验，不能只改单位标签。

semantic Mapping 的 quantity unitFactor／scaled compiler 当前为 number；补 exact-factor 分支并同步两个 SQL renderer及规则比较，不能在确认快照中保持字符串但查询时重新引入浮点。DuckDB 使用已声明的 DECIMAL precision/scale，业务 PostgreSQL 使用 NUMERIC；超出声明精度拒绝或按已批准舍入策略生成新规范值，不能数据库静默四舍五入。

## 6. 动态发布、挂载和项目数据查询

### 6.1 动态 package catalogue

实现 PostgresIndustryPackCatalogue:IndustryPackCatalogue 和持久 IndustryManifestSource，按完整 id/version/digest＋可信 scope 读取 published_pack_assets／immutable asset。现有静态示例作为受控种子注册记录，动态新包走同一读端口，不能用“仅支持当前 scenarioForIndustryRef”挡住正常挂载。

AssetPublicationService 从审核草稿输出现有 SemanticDefinitionRecord、IndustryManifest、身份/规则/queryTemplate/testSuite 版本引用与 PackAsset。PackAsset／ExportBundle additive 增补 actionDeclarationsRef、sourceIndexRef、syntheticExampleRef、validationRef；源索引仅含授权声明引用或脱敏来源，不携带客户私有全文。部署实际执行任务可用性由 profile resolver/preflight 判断，不将包 usable=true等同所有动作可执行。

创建/切换项目先调用既有 profile publication／preflight 机制，从受控部署模板和该包能力要求产出版本化 ProfileSpec；映射／运行时／工具／compute bindings 由显式选择的兼容已注册组件组成。缺能力返回 blockers，保留项目草稿。挂载后保存 ResolvedProfileRef＋mappingRefs，定义数据绑定使用现有 DefinitionBinding。资产新版本不自动切换旧项目。

### 6.2 两层 mapping

ImportMappingVersion 保存文件选择、header digest、fieldRef→column index／JSON pointer、原始单位、确定性值映射、精确转换、identity scope和关系键，供 parser→candidate 使用。SemanticMappingVersion 复用现有 SemanticMapping 的概念、字段、links、dialect／SourceObjectRef，将批准输入的字段映射到受控查询对象。行业包只给无物理列名的 MappingTemplate。

导入后规范化数据物化到 canonical SQL 列，因此物化 SemanticMapping 的 unitFactor=1；转换记录在确认 manifest 中保存。直接读取授权外部业务库时仍使用受控物理 mapping 的转换，不能接受模型生成表/列。更换 mapping 产生新修订和新 expected dataset ref；旧 SQL/data cache 不重解释。

### 6.3 批准快照与物化

1. 稳定 recordId 源于项目＋原始文件修订＋sheet/row，实体身份为独立 entityId。两行同一实体仍保留两条 record。文件相同内容上传时提供复用选择；替换文件形成新来源修订，不以行顺序强行等同全部旧记录。
2. 对批准范围完整分页读取 current candidate／confirmation／identity/publication。取明示 rowCount 和有签名 cursor，行顺序稳定；未处理/失败/排除全部对账。禁止拿默认 facts: 的 100 行构建“完整项目”输入。
3. 保存分页 approved rows、confirmation manifest 及 DatasetSnapshot manifest，digest 校验并 enqueue 物化。任务所需字段缺值／冲突仍阻断；允许用户确认一个明确子集，但 coverage、排除原因和范围必须随结果保持。
4. DuckDB writer 复用 DuckDbEngine.runTrusted，读取授权 rows，在新的内存实例／受控 snapshot 文件构建表；表和列名只从服务端 mapping/schema生成。完成后核对 rowCount／canonical rows digest／schema digest，再发布 snapshot adapter registry。Query resolver按 datasetSnapshotRef缓存独立实例，不继续使用 createDuckDbSnapshot 的启动数据；重启从不可变工件重建，重建完成前 query readiness=pending。
5. 业务 PostgreSQL writer 使用独立受控 business database/schema和写入角色，snapshot_id＋record_id唯一，在该业务库事务中分批写 staging，验证 schema/count/digest后提交 snapshot metadata。QueryPort继续使用独立只读角色和现有 AST 白名单；control PostgreSQL 的库不能算第二业务后端。不得写客户生产表以演示“支持 PostgreSQL”。
6. 两后端采用 immutable snapshot 身份：批准更正／删除生成新snapshot；不会原地删旧 snapshot 的行。当前读取检查 visibility/fence，不以旧数据冒充已改正当前结果；历史仍读取原工件。实例撤回将相关新任务可用性 fenced，重新物化后再ready。
7. 业务库提交成功、control CAS失败时 retry读回相同 snapshot digest并补 receipt；worker不得将过期 job的 ready pointer切到新项目头。行/Schema digest不一致返回 MATERIALIZATION_MISMATCH，绝不使用旧启动资料回退。

## 7. BM25 文档索引修订、撤回与就绪

结构化导入叶服务使用真实不可变原文及现有 structured parse。CSV/XLSX 的表头与行、JSON 的记录生成有界文本投影：最多 1000 行、每行 8 KiB、文本 1 MiB、来源映射 4 MiB，超限显式记录 skipped/truncated，不改变解析器或业务查询的默认上限。文本导入沿用原始 byte-offset 的精确引用。表格/JSON 投影偏移只定位派生文本，来源映射另存实际 parseId、recordId、rowDigest、每个原始 cell/JSON locator 和 rawDigest；不能把该偏移称为原文件内的精确文本位置。

`POST /projects/:id/structured-imports` 除既有 parse 信息外返回 host 生成的 documentId、documentSetRef 与 documentIndexState。成员只引用授权原文及投影 artifacts；同一原文的并发重试收敛到现有 parse/member，撤回后导入不能重新激活同一成员。调用方通过既有项目修订流程固定返回的真实 documentSetRef，索引 ready 不表示字段、身份、事实或 dataset 已批准。普通 document_qa 的 admission 在既有 RunExecutionBinding 中保存 host 生成的 projectDocumentIndexSnapshotRef，固定项目修订、documentSet、generation 和 visibility epoch，检索与最终发布均重新检查；请求不能携带历史开关或自行声明该证明。

近似投影问答使用既有 artifact_summary，绑定实际派生 artifact 及原始 cell 来源，保留 approximate_document_source/limited_factual_result；不冒充精确逐字引用。原文/来源位置/固定索引失效或撤回阻止新的发布，已核验历史答案和其归档证据仍按原有授权读取。相同文件的不同定位行保留为不同检索片段，重复文件中的同定位 quote 按 lineage 折叠。

collectionRef 由 host 生成 project:<projectId>，客户端／模型只能通过项目任务请求其可用文档能力。corpus 是固定 DocumentSet 中授权 active memberships及完整 parse refs，不是全空间 listParses；索引 digests包括 tokenizer/parser版本、成员documentRef/parseRef/textDigest与visibility epoch。

现 builder 存在读取全部 generations再 Number(max)+1 的竞争和精度风险；改为 scope＋collection 的 bigint counter锁和唯一digest复用。每个 build job固定 request corpus ref，parses由 coordinator在领取时按该manifest分页读取，不在composition写死。

build流程：解析/文档set冻结→标索引pending/fence→builder写 staged generation及postings的原子事务→核对预期corpus/digest/count/coverage→control事务CAS激活既有active pointer及project readiness／receipt。cas检查expected membership revision、source visibility epoch和targetDigest；旧build完成不能重新激活已撤回文档。原createBm25IndexBuildHandler的先activate再job publication路径改为目标校验后的单事务激活端口，或其事务等价实现。

资料修订／撤回先在control事务增加visibility epoch、更新membership、设置相关index/semantic fence并enqueue rebuild/invalidate。新document_search在检索开始及返回前检查epoch；新answer发布再次检查source及index依赖。队列尚未处理时拒绝需要当前完整corpus的文档任务，或明确 partial，不从旧active索引照常取已撤回片段。旧历史引用允许在仍有授权时按archived span读取，并标历史／当前已撤回。

缓存键包含scope/project/corpusDigest/indexRef/visibilityEpoch、查询词、limit及授权epoch。BM25 score只是检索排序，不当概率或可信度。相同digest副本按现lineage折叠；片段返回上限和matchedTotal/truncated随ToolCoverage保留。generation docCount指chunk数，UI另显示源文件数，不能混称已索引文档数。

## 8. HTTP 请求与响应

全部新增在同一 Fastify host／api/v1，沿用 data/meta。所有 ref 到 server 后重新授权并查 exact digest；body 中 tenantId、role、path、SQL或script不能决定执行。读取使用keyset cursor，cursor绑定scope/project/revision/filter；pageSize默认100、最大250，返回 rows、total、nextCursor、completeness，过期cursor拒绝不从第一页静默重读。

### 8.1 路由

| 路由 | 请求关键字段 | 响应／复用 |
| --- | --- | --- |
| POST /industry-workspaces | displayName、namespace、boundary；Idempotency-Key | workspace＋draftRef；201 |
| GET /industry-workspaces | cursor、state、pageSize | workspace列表／meta |
| GET/PATCH /industry-workspaces/:id | PATCH: boundary/name、reason；If-Match | 新headRevision／差异 |
| POST /industry-workspaces/:id/generations | draftRef、documentSetRef、kinds、generationPolicyRef；If-Match＋key | 202 jobId；共用GET /jobs/:id |
| POST /industry-workspaces/:id/example-generations | draftRef或definitionRef、caseKinds、generationPolicyRef；If-Match＋key | 202 jobId；结果为syntheticExampleSetRef |
| GET /industry-workspaces/:id/drafts/:revision | immutable revision | draft＋候选索引＋validation状态 |
| POST /industry-workspaces/:id/draft-operations | operation:edit/accept_proposals/merge_alias/split_definition、targetIds、expectedCandidateDigests、reason | 新draftRef＋affectedItems；CAS |
| GET /industry-workspaces/:id/candidates | kind、cursor | 带domain的候选列表和来源 |
| POST /candidates/:id/reviews | 复用现 decision/reason/evidenceRefs/If-Match | 复用 CandidateReviewRecord，支持TBox reader |
| POST /industry-workspaces/:id/validations | draftRef、syntheticExampleSetRef、validationPolicyRef；key | 202 validationJobId；结果ref/逐项问题 |
| POST /industry-workspaces/:id/publications | draftRef、version、validationRef、reviewRevisions；If-Match＋key | 201 packRef/definitionRef、capabilityStatus |
| GET /industry-packs、现export route | exact版本 | 动态catalogue，复用现导出服务 |
| POST /documents | multipart file＋owner:{workspaceId或projectId}＋sourceRef；key | originalRef、documentId、uploadRevision、format状态 |
| GET /documents/:id/previews | parseRef、sheetId、range、cursor | 源表／原值与parser coverage，不能当confirmed输入 |
| POST /documents/:id/parses | parserPolicyRef、sheet/header/range/format options；If-Match＋key | 202 parseJobId、parse target ref |
| GET /documents/:id/spans | parseRef、locator、maxBytes | 复用DocumentSpanReader，精确原文及textDigest |
| POST /projects | title、goal、industryPackRef、deploymentTemplateRef；key | projectRevisionRef及preflight blockers |
| GET /projects/:id /revisions/:revision | exact project revision | pins＋readiness＋capabilities，历史有标记 |
| POST /projects/:id/mappings | import fields/units、definitionRef、backend choice；If-Match＋key | MappingRefs、新project revision、preview errors |
| POST /projects/:id/records | objectTypeRef、exact values、relation keys、reason；If-Match＋key | manual-entry原文ref、稳定recordId、待审核candidate及新revision |
| GET /projects/:id/records | revision、status、cursor | 原行＋current候选＋FieldConfirmations、counts |
| POST /projects/:id/record-edits | expectedRevision、explicit recordRevision＋fieldId＋newValue＋reason | 新record/project revisions，待校验/审核状态 |
| POST /projects/:id/field-confirmations | explicit recordRevision/fieldIds＋decision/reason；If-Match＋key | confirmed/conflict/skipped及新revision |
| POST /projects/:id/input-publications | projectRevisionRef、批准候选及reviewRefs、excluded记录；If-Match＋key | approvedInputRef、新revision、ready states、jobs |
| POST /projects/:id/document-memberships/:documentId/revisions | op:retract/replace、reason、replacementRef?；If-Match＋key | 新revision及fence/后台任务 |
| GET /projects/:id/readiness | projectRevisionRef | semantic/query/index投影与可修复blockers |
| GET /projects/:id/tasks | projectRevisionRef | TaskBindingRefs/labels/支持参数与requiredReadiness/可用性 |
| POST /runs | 执行分册的task＋question/profileRef等既有字段 | 保留run状态/SSE，详见执行分册 |

路由名表为目标设计，现有已存在的 /ingestions、/jobs、/semantic-publications、/statements、/industry-packs、/profiles、/runs 不再建立平行v2服务。新documents上传包裹既有blob/parse/job端口；旧 /ingestions 文本调用保持兼容并可绑定明确项目。新input-publications调用同一语义发布核心并加项目冻结事务，不另定义“approved=true就是真实事实”。

### 8.2 示例形状

~~~json
{
  "data": {
    "projectRevisionRef": {"projectId":"<uuid>","revision":"7","digest":"sha256:<hex>"},
    "approvedInputRef": {"id":"<uuid>","version":"1.0.0","digest":"sha256:<hex>","kind":"artifact"},
    "readiness": [
      {"kind":"dataset","state":"building","expectedCount":1001,"processedCount":250,
       "completeness":"partial","jobId":"<uuid>"},
      {"kind":"document_index","state":"pending","expectedCount":3,"processedCount":0,
       "completeness":"unknown","jobId":"<uuid>"}
    ]
  },
  "meta": {"traceId":"<trace>","revision":"7"}
}
~~~

task请求使用执行分册 RunExecutionRequest 的 tagged union：question 模式为 task:{mode:'question',projectRevisionRef,inputSnapshotRef,inputSnapshotDigest}；快捷任务模式为 task:{mode:'task',projectRevisionRef,taskBindingRef:VersionRef,inputSnapshotRef:ResourceRef,inputSnapshotDigest,parameters}。inputSnapshotRef由项目冻结服务提供，客户端无法凭question中的文件路径建立输入。TaskBinding注册内容由执行分册规定；UI只消费可读投影与引用，权限不从context字段取。

## 9. 公共 UI 路由、状态和场景挂载

### 9.1 路由与迁移

沿用现URL query方案，新增 assistant／workspace／project／revision／tab/run。规范路由：/?assistant=ontology&workspace=<uuid>&tab=materials|definitions|rules-actions|instances|validation|versions；/?assistant=business&project=<uuid>&revision=7&tab=materials|records|tasks|results|history。顶部始终两个助手入口；管理配置进入权限内的辅助入口，不作普通用户任务前置。

旧 view=jobs/review/query/evidence/workbench和run深链接仍支持一次性路由映射至对应公共面板；旧链接没有project时保持旧只读/管理能力，不擅自把一个全局candidate加入当前项目。刷新恢复保存的server drafts，切助手各自保留未提交本地编辑，离开脏表单提供保存/放弃选项；不在URL保存资料、token或价表内容。

### 9.2 组件及实际操作

- IndustryWorkspace：资料列表＋中间定义列表＋右侧来源/修改详情；新增/编辑属性和关系、接受候选、审核、生成合成实例、规则匹配／动作试算、验证、发布均有真实API，不只画图。
- ProjectWorkspace：文件/表预览、sheet/表头/列映射、记录表、按Schema新增实例、逐字段修正与确认；实体匹配以业务标识搜索/选择，不要求手填entity UUID。创建新实体和完成关联用同一引导呈现两个后台结果，未完成绑定不可显示已确认。
- TaskPanel：列出当前版本可用任务，普通问题和快捷入口调用同一task registry；blockers跳到可修复的资料/字段/资产/能力位置。更改参数先显示具体diff、作用记录与确认按钮。
- ResultPanel：仅消费已发布answer及已核验 typed-result-manifest@1；叙述、结果表和分页共享digest，原始compute JSON不可绕过核验展示正式值。分页250行上限/总行10,000与执行分册一致。
- SourcePanel：按text/json/cell/row locator选择原文对照方式，显示原始值、规范值、单位、版本、确认记录；缺文件/断链明确显示覆盖限制。
- HistoryPanel：同项目修订差异、run状态/版本、旧结果和来源；旧值显示历史状态，重算是新run。

状态组件共用 StatePanel 及 API错误分类。至少展示：无工作区/无资料、处理中、解析部分成功、字段pending/conflict、草稿发布阻断、包已发布但动作未绑定、项目query/index/semantic未就绪、任务超界、权限不足、计算/检索失败、核验失败、已核验结果、当前依赖撤回及历史。前端禁用按钮须同时解释原因；后台仍强校验。

readonly用户不显示可执行的编辑/批准/发布入口；model未配置只阻断生成相关步骤，确定性JSON/表格/已发布任务按能力仍可使用。服务短暂失败保留页面和草稿，Retry仅调用可重试阶段，不能重新创建重复逻辑任务。

### 9.3 场景模块前端契约（只在 apps/web）

~~~ts
interface FrontendScenarioModule {
  ref: VersionRef; // 前端构建组合时注册，不能来自资料内容或任意URL
  capabilityRequirements: string[];
  taskEntries: { taskBindingRef: VersionRef; label: string; iconKey?: string }[];
  ParameterPanel?: ComponentType<ScenarioParameterProps>;
  ResultRenderer?: ComponentType<ScenarioResultProps>;
  exporters?: { id: string; label: string; format: string;
    exportCapabilityRef: VersionRef }[];
}
interface ScenarioParameterProps {
  projectRevisionRef: ProjectRevisionRef;
  taskBindingRef: VersionRef;
  fields: readonly FieldConfirmation[];
  issues: readonly UserFacingIssue[];
  readOnly: boolean;
  proposeChange(change: TypedInputChange): Promise<ConfirmationProposal>;
  confirmChange(proposalRef: ResourceRef, expectedRevision: RevisionString): Promise<
    { kind: 'project_input'; projectRevisionRef: ProjectRevisionRef; requiresApproval: true }
    | { kind: 'task_parameters'; runId: Uuid; runRevision: RevisionString }>;
  openSource(source: FieldConfirmation['source']): void;
}
interface ScenarioResultProps {
  projectRevisionRef: ProjectRevisionRef;
  publishedAnswerRef: ResourceRef;
  verifiedResult: VerifiedTypedResultManifestView;
  loadVerifiedPage(cursor?: string): Promise<VerifiedResultPage>;
  openEvidence(ref: ResourceRef): void;
  requestExport(exporterId: string): Promise<AuthorizedDownloadView>;
}
~~~

React ComponentType及这些props位于 apps/web，contracts只保存非React元数据和已有共享数据类型。UiCapabilityMetadata:{moduleRef,taskBindingRefs,requiredCapabilities}可放部署/行业声明，不能夹bundle代码、任意HTML、JS路径或远程动态import。trusted web composition注册moduleRef→编译模块；API deployment metadata只引用可用模块。未注册模块显示“专业视图不可用”及通用已核验结果，不默认显示报价按钮。

动作声明可列语义校验需求；实际 PublishedTaskBinding 只使用 validationPolicies:TaskValidationPolicyBinding[]，形状及 input/result 阶段以执行分册为准，没有 requiredValidationPolicyRefs 别名。实际策略实现通过 TaskValidationPolicyPort 的受信扩展注册。公共参数/结果界面展示绑定到execution/input/output/policy digests的报告状态及具体violations；缺必需报告或fail保持阻断，前端不能根据Schema通过自行生成业务pass。B在该端口提供价税/计价/覆盖等业务策略；通用Core不复制客户判断。

既有 AppViewContribution作为兼容adapter包装到该registry；main.tsx／deployment.ts删除home-energy name判断，以build entry的明确注册替代。A 包含两个隔离标记的中性测试场景挂载，验证只改组合入口和配置即可更换参数面板／结果renderer。B自行注册桥架参数、报价表、价格动作和XLSX exporter；专业renderer接收已核验view，不能取得任意未核验artifact URL作为正式结果。export capability服务端再次验证范围、answer/result digest及权限；JS formatter不能另造金额。

TypedInputChange／ConfirmationProposal／VerifiedTypedResultManifestView 使用执行分册 EX-7.1 的唯一投影，前端不另定义可变 snapshot。project_input 确认返回新待审核 ProjectRevisionRef 与 requiresApproval:true，重新审核批准后才能冻结新输入／创建新 run；task_parameters 确认通过同 run 的 /responses CAS 返回 runId/runRevision，不改变项目修订或批准输入。expectedRevision 由 proposal.kind 决定是项目或 run 的修订，服务端再校验归档 proposal 和相应 prior receipt。专业模块不可把任一“确认”按钮直接等同批准发布。

## 10. 错误、恢复和权限

| 错误分类 | HTTP／可恢复性 | 用户操作 |
| --- | --- | --- |
| REVISION_REQUIRED / VERSION_CONFLICT | 428 / 409；不自动覆盖 | 刷新差异、重新确认 |
| IDEMPOTENCY_CONFLICT | 409；同key不能修订payload | 读取原操作；新修改使用新逻辑key |
| INVALID_ARGUMENT / SCHEMA_MISMATCH | 400 / 422；不可直接重试 | 定位具体字段/单位/端点修正 |
| UNSUPPORTED_MEDIA_TYPE / UNSUPPORTED_TABLE_LAYOUT | 415 / 422 | 提供模板、已支持格式或调整sheet/range |
| LIMIT_EXCEEDED / PARSE_INCOMPLETE | 413 / 422 | 明示上限或部分范围，拆分资料／修正输入 |
| SOURCE_LOCATOR_INVALID / SOURCE_DIGEST_MISMATCH | 422；禁止确认/精确引用 | 重新解析/复核来源，不能猜位置 |
| CANDIDATE_REVISION_STALE / UNCONFIRMED_INPUT | 409 / 422 | 查看current candidate及缺项、重新审核 |
| RULE_UNSUPPORTED / ACTION_UNBOUND | 422或preflight blocker | 保存草稿、改规则或由维护者绑定已注册能力 |
| DATASET_NOT_READY / INDEX_NOT_READY / SEMANTIC_NOT_READY | 409，带kind/job/retryable | 看阶段，等待或重试允许的失败作业 |
| MATERIALIZATION_MISMATCH / INDEX_CORPUS_STALE | 409／失败作业 | 保留输入；修复映射或按当前corpus重建 |
| FORBIDDEN / NOT_FOUND | 403／404 | 不透露另一项目的存在或正文 |
| SOURCE_UNAVAILABLE / MODEL_NOT_CONFIGURED | 503／preflight blocker | 保留页面；仅重试短暂故障，配置缺项由维护者处理 |

新错误必须进既有 error-catalog、schemas、generated types和HTTP分类，不能只在前端判字符串。message不包含secret／连接串／全文；issues可返回授权范围内fieldId/recordId/locator摘要。

上传owner、candidateID、packRef、projectRevisionRef、sourceRef和下载每次均授权。发布/撤回复用semantic-publisher，审核复用semantic-reviewer；行业编辑/profile配置采用现有profile-editor/platform-admin并按workspace范围约束。只读role不可通过浏览器mount组件获得额外权限。下载/来源读取固定archive ref，不接本机路径。

## 11. 测试与验收映射

本轮未运行以下测试。实现任务只执行其相关套件；最终A gate再跑正常整栈、替换矩阵和回归，不能以单元mock替代可操作UI。

实际脚本以 platform/package.json 为准：pnpm run lint、pnpm run typecheck、pnpm run test、pnpm run boundaries；真实浏览器需先 pnpm run build:web，再 pnpm run test:e2e。现仓库由 vitest.e2e.config.ts 运行 tests/e2e/**/*.e2e.ts，并在测试中使用 Playwright chromium；没有 playwright.config.ts。tests/ui 为 jsdom，不能替代浏览器验收。拟新增 tests/e2e/asset-workspace.v03.e2e.ts、project-data.v03.e2e.ts、document-index.v03.e2e.ts、scenario-mount.v03.e2e.ts；整栈收尾套件由根manifest统一指定。单卡可采用现 Vitest 的文件过滤调用测试文件，最终gate执行完整脚本，不猜测不存在的CLI或test:ui脚本。

| 验收／独立预期 | 测试类型与最小证据 | 覆盖 |
| --- | --- | --- |
| 首次从资料生成定义，编辑候选后审核/发布，刷新再挂载 | controlled GenerationPort检查请求中业务边界/Schema digest；HTTP＋Postgres＋浏览器生成真实候选及动态catalogue读取 | A US-001/003/005；总体US-001～007/011 |
| 草稿并发/模型迟到结果不覆盖，修改不得沿用审核 | CAS失配、相同key异payload、generation并发人工edit；旧review发布拒绝 | A US-003/005 |
| 合成实例生成、编辑和试算与真实事实隔离 | 两种draft/published目标、支持/缺参数/冲突样例；后端拒绝synthetic→真实input-publications；browser持续标识，预期来自专家或独立oracle | A US-005；总体US-009/011 |
| 四格式解析和原文定位准确 | UTF-8非ASCII/换行、JSON原始高精度token、CSV带逗号/换行、XLSX lexical小数/sheet/cell；原byte/cell回读digest独立核对 | A US-002/004 |
| identity与记录分离，字段修正/批量确认 | 同名不同scope、同实体多行、unknown unit、missingquantity、current候选替换；UI无需手填UUID | A US-004；总体US-008/010/013/014 |
| 新批准数据进入两真实查询后端 | 固定输入1001行，DuckDB实际表与独立businessPostgres真实表逐页计数/值/来源；启动示例隔离 | A US-006/015/016 |
| SQL物化宕机及幂等回执 | businesscommit后control失败／CAS旧worker完成／重启重建DuckDB；ready之前任务拒绝，rowsdigest不符拒绝 | A US-006/014 |
| BM25新增/修订/撤回真实可检索 | 真实parse/chunks→index→document_search→span核对；oldbuild迟到、撤回fence、同digest副本、跨project引用 | A US-009/012/016 |
| 注册动作和专业页面挂载真正可替换 | 两中性scene模块从composition注册；App无行业判断；参数proposal/已核验结果/JSON exporter走API | A US-001/010/011/015 |
| 历史、取消与导出同一版本 | 修改新revision、旧run读回、导出digest和页面一致、来源已撤回标记；执行分册联合 | A US-014/016 |
| 建模与提参实际模型质量 | 授权公司API固定资料/专家参考/保留集，错误遗漏/修改时间独立报告；缺资源标未验证 | A US-016，不用受控response证明真实质量 |

建议浏览器data-testid按公共对象命名：assistant-ontology/business、industry-workspace-create、asset-candidate-list、asset-validation-blockers、asset-publish、project-create、document-upload、sheet-select、mapping-confirm、record-table、field-source、field-confirm、project-readiness、task-entry、run-progress、verified-result、result-export、history-revision。专业场景自有命名空间不侵入公共选择器。

整体E2E从原始合成资料和空授权项目开始：生成＋审核行业包→挂载→上传1001行→确认身份和字段→等待指定backend实际ready→自然语言受支持任务→核验结果/后页来源/JSON导出/历史；第二行业重复最小流程。测试不seed候选、published facts或答案，不从queryhandler直接手动调用Controller。服务、数据库、模型替身与worker作为正常host组件装配，受控模型只是外部依赖替身。

## 12. 可独立拆分的小 Issue 候选

以下仅为待根manifest分配 V03-NNN 的候选，不是已创建Issue，不覆盖旧LOCAL队列。每卡包含SPEC节、可观察结果、依赖和反例；细化时不把整分册塞成一张卡。

| 局部键 | 最小产出 | 依赖 | 必须验证的反例 |
| --- | --- | --- | --- |
| AD-01 资产与项目版本契约/迁移 | §3/4 additive schemas、workspace/project revisions、CAS、RLS/索引，复用审核表 | A0迁移/WIP核对 | revision冲突、跨scope、同版本异digest、hash环 |
| AD-02 四格式parser与cell/pointer来源 | §5 upload/parse/job/SourceLocator正常HTTP，limits可见 | AD-01、既有blob/parse | XLSX词法精度、JSON大数字、CSV换行、错表结构、locator/digest不符 |
| AD-03 TBox候选生成和共享审核 | §3.1业务边界/prompt/候选/edit/审核API | AD-01/02、GenerationPort | 模型迟到不覆盖、TBox实例混用、旧review沿用、unsupported rule |
| AD-04 Schema prompt及exact quantity贯穿 | §3.3/5.3请求实检、人工实例/补参审计、字段编辑/确认、新candidate绑定 | AD-01/02、执行decimal契约 | 缺数量/未知单位、有损number、错误端点、旧candidate发布、手填伪装原cell |
| AD-05 原子资产发布与动态catalogue | §4.2/6.1不可变PackAsset、导出、动态IndustryManifestSource、挂载 | AD-03、profile resolver | 已发布但不能挂载、部分提交、包代码/私有数据泄漏、未绑定动作显示 |
| AD-06 批准输入快照与mapping | §3.2/6.2/6.3完整行/确认manifest、两层mapping、outbox/fence | AD-04/05 | 默认100行截断、排除无理由、别项目fixtures、refs变更旧run |
| AD-07 DuckDB真实项目物化 | §6.3实际snapshot/query registry/receipt与恢复 | AD-06、查询服务 | 未ready回退启动数据、宕机、重复物化、过期job、错误digest |
| AD-08 业务Postgres真实项目物化 | §6.3独立writer/readonlyquery角色/物化事务、等价mapping | AD-06、既有data-postgres | control库冒第二后端、部分数据ready、精度差异、越权source |
| AD-09 BM25项目索引协调与撤回 | §7固定corpus、generation CAS、索引pipeline、visibility/fence | AD-02/06、writer引用核验 | oldbuild重新激活、索引fixture、撤回检索、跨project、tokenizer版本变 |
| AD-10 公共本体工作台 | §9.1/9.2建包列表/编辑/来源/规则动作/实例/验证发布 | AD-02～05、AD-13 | 空态/CAS冲突/失败/readonly/未绑定动作、刷新及来源 |
| AD-11 公共项目输入与任务工作台 | §9.1/9.2项目/上传/映射/字段/ready/任务入口 | AD-06～09、执行taskBinding | 关键字段确认、具体blocker修复、无内部ID、长表、草稿保留 |
| AD-12 场景mount与已核验结果/来源/历史 | §9.3React本地契约、二场景注册、旧路由兼容、通用JSON导出 | AD-10/11、执行typed-result/draft@3 | 行业硬编码、raw结果正式渲染、digest错页、专业module未注册、导出越权 |
| AD-13 合成实例与行业包验证 | §3.4样例生成/编辑/独立expectation、规则匹配和注册动作sandbox试算、验证报告 | AD-03/04、执行有限规则/受控compute | synthetic发布真实事实、实现自当oracle、未绑定动作假pass、draft变更沿用验证 |

A最终整栈E2E与main gate由根manifest统一收尾，不另设本分册自称完成的发布流程。AD-05、AD-07/08、AD-09分别对应动态行业包、实际批准数据查询、实际文档索引三项接缝，必须独立回归，不能让一个截图或testfixture掩盖其中任何缺口。

## 13. 迁移、兼容与风险处理

迁移先新增表/列/索引/状态，再注册新HTTP及pipeline；旧数据不自动获得project或field-confirmed标记。现有definition/package refs、candidate reviews、facts:入口、旧answer/source/run深链接保持读取。新项目导入必须通过明确绑定与冻结，旧全局事实不未经用户选择混入某项目。

资产草稿模型新增但不重写已发布定义；旧有静态包按其确切ref登记catalogue或在受信composite catalogue读取。曾使用home-energy显式profile的前端部署保留其自己build composition，公共main不能import该场景来实现兼容。

主要实现风险是多库物化、索引激活race、quantity在中途重新浮点化、建模generation与人工编辑并发。其处理均以immutable manifests、CAS、fence、receipt与独立反例为门槛。外部公司模型资源是实际建模质量验证依赖；客户函数、报价价表、桥架图纸和人工报价金标属于B，不阻断上述通用机制设计/合成验证。A实际模型未验证时按主SPEC gate记录限制，不冒称质量已通过。
