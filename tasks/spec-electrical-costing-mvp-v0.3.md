# SPEC v0.3 B：电气桥架 AI 造价师 MVP

日期：2026-09-29。状态：设计稿；本文件没有宣称报价功能、客户函数调用或业务验收已经完成。

需求来源：[总体／造价 PRD v0.3](prd-ontology-and-business-assistants-v0.3.md)、[阶段 A 通用 PRD](prd-generic-assistants-core-v0.3.md)、[首单 POC 方案](../docs/poc/electrical-costing/first-poc-plan-2026-09-29.md)。分支顺序以[分支管理](../docs/branch-management.md)为准。

## 1. 范围、基线与设计决定

### 1.1 本文件负责什么

B 在已验收通用双助手上挂载电气桥架资产、客户映射、参数及价格确认、版本化报价函数、专业报价表、解释、导出、人工对比与业务签核。领域为电气安装中的电缆桥架；若项目负责人确认实际范围不同，应更换领域资产并重新签核，不能沿用桥架规则。

覆盖总体 PRD US-001～024 的桥架含义；US-016～022 为报价主链，US-023～024 为场景替换与真实业务验收。通用部分由 A 交付，B 不重新实现 Controller、planner、数据工具、定义候选框架、身份审核、通用存储、answer 或 verification 协议。

### 1.2 A→B 是实施门槛

所有场景专属代码、迁移、配置及专业 UI 实现依赖 A 的整体退出条件通过并合入 main；先由造价分支同步该明确基线、执行受影响回归，再开始 B 实现。A 期间可以进行资料、权威函数、价格口径、黄金样本及图纸覆盖 discovery，也可以编写需求／SPEC；不能把提前的客户资料核对写成 B 代码交付。

B 的基线记录至少包含：

| 字段 | 要求 |
| --- | --- |
| aAcceptanceRef | A 整体独立验收记录的不可变引用，状态为 passed |
| acceptedMainSha | A 验收后真实合入 main 的提交，不能用功能分支 HEAD 代替 |
| scenarioHead | 包含该 main SHA 的造价分支提交，附祖先关系核对结果 |
| contractsAndMigrations | 所用公共契约版本、迁移范围、profile 和场景模块版本 |
| scenarioRegressionRef | 同步后受影响回归结果；不把只合并文件解释为已获得能力 |

此记录是部署／验收控制资料，不从模型输入或客户请求取得。尚无 A 验收 SHA 时标记 gate_pending，不填造假的提交。B 发现新通用缺口时，独立任务与提交先验收回流 main，再同步 B；不在场景中复制一份 Core。

### 1.3 公共契约权威

- [A 资产、数据与公共 UI](spec-v0.3a/asset-data-ui.md)：ProjectRevisionRef、批准字段、实际项目数据集、行业包、公共审核及 FrontendScenarioModule。
- [A 执行与证据](spec-v0.3a/execution-evidence.md)：任务绑定、RunManifest.executionBindingRef、TaskValidationPolicyPort、task-policy-report@1、task-finalization-receipt@1、compute-result-artifact@1、typed-output-bindings@1、typed-result-manifest@1、answer-draft@3、预算／取消／恢复、硬核验与发布有效性。
- A 的其他通用规则／关系契约由 A 主 SPEC 统一引用。本文使用 A 支持的规则子集；不复制 OR、关系导航或规则引擎实现。

本文定义领域 outputArtifactRef 指向的 QuoteResultArtifact，不重新定义 A 的通用 wrapper。B 的 JSON Schema、生成类型、工件版本和 adapter conformance suite 必须与上述已验收公共版本一致。

### 1.4 已决定与尚待客户确认

| 决定 | 方案及理由 |
| --- | --- |
| 金额来源 | 已注册、经审查并获客户认可的确定性函数；模型不计算金额 |
| 任务路线 | 正常项目任务入口识别报价意图，固定 task binding 调用 costing.quote；无需为报价再搭动态 Agent |
| 输入 | 已确认字段、价格及规则形成不可变工件；compute 只读批准的引用 |
| 金额表达 | 复用 Money.amount 为 DecimalString、currency 为 CurrencyCode；计价数量单位另存 DecimalQuantity |
| 表格与正文 | 只渲染 A 已核验的 typed-result-manifest@1／answer-draft@3；原始客户 JSON 不直接成为正式报价表 |
| 客户 I/O | 注入 CustomerQuotationPort，HTTP／库／受控进程适配器可替换；扩展不绑定客户端或服务器 |
| 缺价修复 | 至少一条授权补录／导入→审核→新价格快照→项目采用→重新计算的真实 UI/API 路径 |
| 业务公式 | 不从演示源码复制；权威契约未确认的公式、默认值、税费、容差均保持 discovery |

客户报价性质、直线段／盖板／配件／支吊架覆盖、供货／安装／运输等费用、图纸量算、函数版本与权限、真实价格和配对样本依 §11 确认。本 SPEC 的内部端口和异常语义已经明确；外部映射不能冒称已确定。

## 2. 架构与目录边界

~~~mermaid
flowchart TD
    A[公共本体生成助手] --> B[专家确认的桥架声明包]
    C[客户清单与项目资料] --> D[A 解析、映射、实例与字段审核]
    B --> D
    D --> E[B QuoteInputSnapshot]
    P[B 授权价格快照、规则和税费口径] --> E
    E --> F[A task binding / runs / gateway]
    F --> G[costing.quote ComputeOperationHandler]
    G --> H[注入 CustomerQuotationPort]
    H --> I[客户 HTTP / 库 / 受控进程适配器]
    G --> J[QuoteResultArtifact + A compute wrapper]
    J --> K[A typed writer、硬核验、有效性与发布]
    K --> L[B 报价 renderer、解释、XLSX、对比与签核]
~~~

| 位置／职责 | B 内容 | 禁止进入此层的内容 |
| --- | --- | --- |
| industry-packs/electrical-costing | 类型、属性、关系、单位、术语、身份范围、有限规则及动作声明 | React、脚本、密钥、客户价格和物理列 |
| packages/extensions/electrical-costing | 领域 Schema、QuoteInput/Result、客户报价端口、校验及确定性结果投影、对比契约 | 数据库 driver、HTTP SDK、固定客户地址 |
| packages/adapters/costing-* | 客户协议／库／受控进程、精确响应解析、授权价格导入、B store 实现 | 模型决定税率、任意脚本执行器 |
| 客户版本化 mapping／扩展资产 | 列对应、规格词典、客户规则、价格来源与函数 binding | 冒充全行业标准或携带共享客户实例 |
| apps/api 的可信装配 | 挂载行业／客户适配／操作／profile／专业路由和模块 | 让客户端任意选择 URL、函数或文件路径 |
| apps/web 的场景模块 | 桥架参数、口径、报价、差异、专业导出 | 修改公共页面使其按行业名称判断 |
| 授权项目存储 | 原资料、确认、价格、调用、报价及业务签核工件 | 复制入共享 fixture／公开行业包 |

复用现有 TypeScript、ESM、pnpm 与单进程显式装配。新包仅在职责边界需要时建立；B 的 store 通过端口注入并使用现有控制／工件存储，业务 SQL 数据仍遵守 A 的数据边界。

## 3. 桥架资产与确认输入

### 3.1 行业声明与客户扩展

最小候选类型为 Project/Inquiry、InquiryLine、Product/Specification、PricingContext、PricingRule、Quote/QuoteLine；最终 id、必填字段、粒度与词典经专家确认后发布。

关系至少包括询价包含原行、行引用规格、报价使用输入及口径版本、报价行对应原行、参数／规则引用依据。原清单行标识来自 A 的稳定 row identity，不能用 Product 实体 ID 替代：两个同规格的原行可以指向同一 Product，仍保留两份数量、位置和业务覆盖。

行业规则只声明参数完整性、规格适用性、单位／价格有效性、费用范围、适用条件及明确例外。价格本身和客户工艺／折扣放在客户扩展与快照。B 中生成的桥架候选仍走 A 的专家编辑、审核、发布与挂载流程；独立 E2E 不能预置最终包来代替本体助手。

报价动作声明固定动作id/version、适用对象、输入／输出Schema refs及digests、确认／覆盖前置条件、逻辑权限、必需能力及策略、证据要求与read-only副作用类别；它引用A的task binding，绑定注册的costing.quote版本。声明发布只代表语义可用；函数实现、策略和mapping经可信部署装配并通过preflight后才显示“当前部署可执行”。模型只建议／编辑声明，不产生可自动执行的函数代码。

不同条件 OR、一个关系前提或无环规则依赖必须在 A 的已验收子集中表达。不支持的条件保存为 unhandled 并阻止相关正式报价；若业务确认确需更广表达，先补通用契约回 main，不能删除条件、扩大适用范围或把规则结果硬编码在 UI。

### 3.2 精确字段与确认

引用 A 的 FieldConfirmation，B 只添加桥架字段规范化与校验。每个关键字段保留 rawValue、normalizedValue、source.locator及文档／parse／chunk／digest、pending/confirmed/conflict、actor、confirmedAt、recordRevision与confirmationRevision。金额／数量链不得先转 Number 再恢复字符串。

桥架字段是版本化定义中的 id，不是 Core 常量；具体必填项由已发布 product category 与已确认函数契约共同决定。可能的字段包括材质、宽／高／厚、表面处理、盖板、长度、数量、计量单位与工程条件。密度、损耗、折边、板厚分档、配件比例或税率没有未经批准的隐含默认。

规格文字由模型提出候选，显式数量／单位优先由确定性表格解析读取。字段修正通过A的project_input提案与CAS形成待审核项目修订，生成当前candidate版本后重新校验／审核／发布，再归档新的approvedInput；确认按钮不自动发布事实或将新输入标ready。批量确认仅处理来源完整、无冲突且用户确实选中的recordRevision／fieldIds，返回成功／未确认行数。批准输入的实际数据集／语义readiness由所需task能力检查后才能报价；原run不更换snapshot。

人工补参／更正复用A的project-owned manual-entry exact JSON文档，归档actor/time/reason、前source及entry digest并经同一JSON parser生成FieldConfirmation.source的json_pointer定位。UI分别展示原cell／原文与人工修改来源；不能把新值伪装成原单元格已有内容。人工补价草稿同样保留真实录入／导入来源和审核依据。

| 换算 | 允许依据 | 缺依据行为 |
| --- | --- | --- |
| 同维度长度／质量 | 固定版本单位定义与精确比例，保留原值及转换引用 | 未知单位 pending，不只换标签 |
| 米↔根 | 已确认单节长度及对应产品／规则版本 | 阻断，不能默认常见长度 |
| 件↔套／组 | 已确认组成／配比与适用规格 | 阻断，不能把套数当件数 |
| 吨↔产品数量／单价 | 已确认重量或确定性重量函数及全部输入 | 阻断，不能用模型估算 |
| 币种转换 | 权威 FX 快照及客户允许的规则／舍入版本 | 首版缺该能力时拒绝混币报价，不自动换币 |

### 3.3 输入覆盖与排除

InquiryCoverageManifest 保存所有原始行的稳定 ID、位置和以下互斥状态：included、excluded_confirmed、unhandled、pending。排除需理由、范围决定和确认引用；不能为避开缺价把该行静默排除。

全项目“完整报价”要求原询价范围被完整解释：included 全部成功，所有排除均属于已确认费用／品类范围，pending/unhandled 为零。用户明确请求子集时固定新的 scope selection 并显示“所选范围报价”及原询价未覆盖数，不能显示“完整项目合计”。

## 4. 领域契约与不可变工件

以下为内部契约设计，不是客户既有 API 的声明。引用 A 的 ProjectRevisionRef = {projectId, revision, digest}、VersionRef、ResourceRef、ScopeRef、SourceLocator 与 typed evidence。tenant/space/project 授权来自可信上下文，不从 parameters 接收。

### 4.1 Schema 注册

| Schema | 版本 | 内容与存储 |
| --- | --- | --- |
| electrical-costing.specification | 1.0.0 | 已确认产品规格及字段／换算引用 |
| electrical-costing.price-snapshot | 1.0.0 | 权威价格明细、范围、有效期及审核 |
| electrical-costing.pricing-policy | 1.0.0 | 币种、含税、税费、费用、折扣、舍入及规则引用 |
| electrical-costing.quote-input | 1.0.0 | 完整确认输入，进入 inputSnapshotRef |
| electrical-costing.quote-result | 1.0.0 | 客户结果的精确领域工件，进入 outputArtifactRef |
| electrical-costing.quote-comparison | 1.0.0 | 同输入同口径的人工差异与验收 |
| electrical-costing.business-review | 1.0.0 | 接受／退回及签核，绑定已核验版本 |

所有边界按已注册 JSON Schema 运行时校验，additionalProperties 默认关闭；变更字段／枚举／舍入语义必须形成新版本并更新 conformance suite。序列化和 digest 复用 A canonical artifact 约定；保持原始 wire artifact，不能用重序列化结果替代原始响应摘要。

### 4.2 精确数值与价格

~~~typescript
type ExactQuantity = DecimalQuantity; // {amount: DecimalString, unit: UnitCode}
type ExactMoney = Money;              // {amount: DecimalString, currency: CurrencyCode}

interface PriceBasis {
  readonly price: ExactMoney;
  readonly per: ExactQuantity;         // 分母 > 0，如某长度／件／吨；不是 currency unit
  readonly taxBasis: 'net' | 'gross';
}

interface PriceEntry {
  readonly priceEntryId: string;
  readonly productSelectorRef: ResourceRef;
  readonly chargeCode: string;
  readonly basis: PriceBasis;
  readonly applicabilityRef: ResourceRef;
  readonly sourceRefs: readonly ResourceRef[];
}

interface PriceEntryBinding {
  readonly chargeCode: string;
  readonly priceSnapshotRef: ResourceRef;
  readonly priceEntryId: string;
}

interface PriceSnapshot {
  readonly schemaVersion: 'electrical-costing.price-snapshot@1.0.0';
  readonly customerPricingScopeRef: ResourceRef;
  readonly authorityBindingRef: VersionRef;
  readonly authorityReceiptRef: ResourceRef;
  readonly baseDate: string;
  readonly validity: {readonly validFrom: string; readonly validTo?: string};
  readonly currency: CurrencyCode;
  readonly entries: readonly PriceEntry[];
  readonly sourceArtifactRefs: readonly ResourceRef[];
  readonly approvalRef: ResourceRef;
  readonly supersedes?: ResourceRef;
}
~~~

技术规范允许技术性字符串长度／精度上限；经济参数不能由 Schema 的 default 补齐。exact amount 按公共 DecimalString 规范解析和比较；报价数量须正值，折扣／冲减是否允许及其表示由客户签核契约决定，未确认时拒绝负值。价格为零必须有明确权威依据和审核理由；缺价用缺失状态，不能写零占位。

price selector 必须唯一匹配已确认规格、charge 和适用范围；重复／冲突价格进入 price_conflict。一个报价币种下价格／费用币种一致。PriceSnapshot 不能只存“最新价表”字符串，必须有实际内容 digest、可读取工件和认可该来源的 authority receipt。

### 4.3 税费、范围与舍入

PricingPolicy 工件至少包含：

| 字段 | 内容与验证 |
| --- | --- |
| quotationPurpose | 客户确认的供货报价／内部成本／工程综合造价性质；没有默认性质 |
| applicableScopeRef | 客户、项目、地区／标准、产品范围及有效时间 |
| currency | 与所有价格及输出金额一致 |
| includedChargeCodes | 约定纳入的材料／加工／表面处理／盖板／配件／安装／运输等 charge id |
| excludedCharges | charge id、排除理由与确认引用；与 included 不重叠 |
| taxBasis | net、gross 或 mixed_components；混合口径必须按 component 明确标注 |
| taxRuleBindings | 每项 rate 的 DecimalString、适用费用基准、执行顺序和来源／规则版本 |
| discountRuleRefs | 已批准折扣／系数规则，适用粒度及顺序；缺少时不自行推导 |
| roundingStages | 字段／阶段、scale、模式和客户规则引用；不假定只在最终总额舍入 |
| priceSelectionMode | explicit_input_snapshot 或 pinned_server_snapshot |
| confirmationRef | 本次项目采用口径的确认记录 |

舍入阶段覆盖客户契约实际使用的单位成本、中间费用、行金额、税费、项目汇总或分配。模式是可识别的固定模式或已注册客户算法 profile 引用，不接受自由脚本。客户内部 Number/Math 的算法只能如实记录 precision contract；外围 Decimal 不修复其既有损失。

不得统一套用“数量×单价”“总价÷税率”或自行按比例分配项目折扣。只有客户契约明确保证的等式才作为独立核验规则执行；其他字段核验其与权威结果的精确一致，业务正确性由黄金样本和专家判定。

### 4.4 输入、函数绑定与 compute parameters

~~~typescript
interface QuoteInputLine {
  readonly inquiryLineId: Uuid;
  readonly sourceRowRef: ResourceRef;
  readonly productEntityRef: ResourceRef;
  readonly specificationRef: ResourceRef;
  readonly quantity: ExactQuantity;
  readonly fieldConfirmationRefs: readonly ResourceRef[];
  readonly conversionRefs: readonly ResourceRef[];
  readonly requiredChargeCodes: readonly string[];
  readonly priceEntryBindings: readonly PriceEntryBinding[];
}

interface QuoteFunctionBinding {
  readonly operationRef: OperationRef; // costing.quote@1.0.0，技术版本
  readonly registeredOperationDigest: Sha256Digest; // pin完整注册记录，而非仅id/version
  readonly adapterRef: VersionRef;
  readonly customerAlgorithmRef: VersionRef;
  readonly capabilityReceiptRef: ResourceRef;
  readonly inputMappingRef: VersionRef;
  readonly outputMappingRef: VersionRef;
}

interface QuoteInputSnapshot {
  readonly schemaVersion: 'electrical-costing.quote-input@1.0.0';
  readonly projectRevisionRef: ProjectRevisionRef; // 已批准项目的下游报价工件，非其approvedInputRef
  readonly inquiryRef: ResourceRef;
  readonly approvedInputRef: ResourceRef;
  readonly industryPackRef: VersionRef;
  readonly definitionRef: VersionRef;
  readonly customerRuleRefs: readonly VersionRef[];
  readonly industryRuleRefs: readonly VersionRef[];
  readonly coverageManifestRef: ResourceRef;
  readonly lines: readonly QuoteInputLine[];
  readonly priceSnapshotRefs: readonly ResourceRef[];
  readonly pricingPolicyRef: ResourceRef;
  readonly functionBindingRef: ResourceRef;
  readonly selectedScopeRef: ResourceRef;
  readonly confirmationRef: ResourceRef;
}

interface CostingQuoteParameters {
  readonly quoteInputRef: ResourceRef;
  readonly quoteInputDigest: Sha256Digest;
}
~~~

costing.quote 的 operation input schema 仅接受上述两个 parameters，inputRefs 必須包含 quoteInputRef 及其批准依赖 manifest。引用、实际 digest 与 A execution binding 的 inputSnapshotRef/digest 一致；重复声明不一致时拒绝。大数据在不可变工件中，不把整单明细塞进可随意修改的模型 arguments。

归档顺序为A的approvedInput／数据manifests→已批准ProjectRevision→B的QuoteInputSnapshot。QuoteInputSnapshot引用该项目ref和approvedInputRef，是受信服务冻结的下游专属任务输入；绝不能用它作为同一ProjectRevision.approvedInputRef，或在原项目修订回填quoteInputRef，否则产生digest环。A /runs的inputSnapshotRef可指这个下游工件，服务端必须核对其schema、digest、projectRevisionRef、approvedInputRef及全部批准依赖归属；只接受B可信snapshot loader产生的关系，不因客户端自填同projectId就通过。

snapshot loader 以 A 的 scoped reader 读取授权 refs，验证全部价格／规则／确认和项目范围后运行。模型不能覆盖 customerAlgorithmRef、币种、价格或函数地址。QuoteFunctionBinding 的客户端接口形式与身份来自可信部署配置。

operation绑定必须固定A的完整注册记录digest（Schema digests、handler digest、readOnly、capabilities、limits、dataMode），与task binding/preflight一致；客户algorithm、adapter及mapping版本另有独立refs，不能以operation技术version代替客户算法版本。

成本相关数量、规格、scope、价格和税费修改均作为project_input修订，批准后产生新snapshot／run。A的task_parameters可在同run按/responses CAS确认其受支持参数，但不能修改costing.quote固定input refs/digest或覆写快照中的经济参数；本报价绑定不额外接受裸税率、单价或数量。

### 4.5 输出契约

~~~typescript
interface QuoteCharge {
  readonly chargeId: string;
  readonly chargeCode: string;
  readonly amount: ExactMoney;
  readonly taxBasis: 'net' | 'gross';
  readonly priceEntryBindings: readonly PriceEntryBinding[];
  readonly ruleRefs: readonly VersionRef[];
  readonly calculationReceiptRef: ResourceRef;
}

interface QuoteLineResult {
  readonly inquiryLineId: Uuid;
  readonly sourceRowRef: ResourceRef;
  readonly specificationRef: ResourceRef;
  readonly quantity: ExactQuantity;
  readonly unitPrice?: PriceBasis;
  readonly charges: readonly QuoteCharge[];
  readonly lineTotal: ExactMoney;
  readonly taxAmount?: ExactMoney;
  readonly authorityOutputPointer: string;
  readonly groupingReceiptRef?: ResourceRef;
}

interface QuoteResultArtifact {
  readonly schemaVersion: 'electrical-costing.quote-result@1.0.0';
  readonly quoteInputRef: ResourceRef;
  readonly quoteInputDigest: Sha256Digest;
  readonly functionBindingRef: ResourceRef;
  readonly customerAlgorithmRef: VersionRef;
  readonly appliedPriceSnapshotRefs: readonly ResourceRef[];
  readonly appliedPricingPolicyRef: ResourceRef;
  readonly rawResponseRef: ResourceRef;
  readonly invocationReceiptRef: ResourceRef; // 先归档的客户原始调用回执，不指Core最终完成receipt
  readonly resultStatus: 'complete' | 'partial' | 'blocked';
  readonly lines: readonly QuoteLineResult[];
  readonly projectCharges: readonly QuoteCharge[];
  readonly totals?: {
    readonly net?: ExactMoney;
    readonly tax?: ExactMoney;
    readonly gross?: ExactMoney;
    readonly scopeRef: ResourceRef;
    readonly authorityOutputPointers: readonly string[];
  };
  readonly coverage: {
    readonly expectedLineIdsRef: ResourceRef;
    readonly successfulLineIds: readonly Uuid[];
    readonly excludedLineDecisionRefs: readonly ResourceRef[];
    readonly blockedLines: readonly {readonly inquiryLineId: Uuid; readonly reasons: readonly string[]}[];
    readonly complete: boolean;
  };
  readonly reproducibility: {
    readonly mode: 'same_version_replay_supported' | 'archived_response_only';
    readonly reason?: string;
  };
}
~~~

unitPrice只在客户权威结果实际提供或经批准的独立公式确定时出现，不用lineTotal/quantity猜出单价。费用构成、税额亦如此。P.US-019要求的计价行单价属于正式输出能力检查：可计单价行缺该字段时保持contract_gap，不能借Schema的可选字段降格验收；已确认不适用的特殊类别须有客户范围／原因记录并显示not_applicable。若验收要求明细而客户只给总额，该适配保持contract_gap，不生成伪造分解。

一个 included 输入行必须对应一条有效 QuoteLineResult；重复、交换或未知 line id 均失败。客户函数按规格合组时，适配必须保存权威 grouping／allocation 依据并还原原行对应；无可靠分配契约时保留分组诊断并阻止合格逐行报价，不自行平均金额。

项目费用在 projectCharges 独立表达，不同时计入多个行导致重复汇总。客户提供的 totals 绑定其 raw pointer；是否可由明细独立复算取决于已批准费用及舍入等式。partial/blocked 没有“完整项目合计”；诊断工件可以保留成功行及未覆盖项，但不标业务通过。

invocationReceiptRef只指先归档的客户原始调用回执，保存调用键、请求、原始响应、算法／价格版本及客户调用状态；该回执不能包含尚不存在的normalized QuoteResultArtifact、compute wrapper、typed manifest或Core完成receipt refs。Core执行完成receipt在领域output/wrapper之后另行归档并引用它们，QuoteResultArtifact不反指Core完成receipt，避免result↔receipt循环。

## 5. 客户函数、价格修复与任务执行

### 5.1 可替换客户报价端口

~~~typescript
interface CustomerQuotationPort {
  describe(binding: QuoteFunctionBinding, ctx: TrustedQuoteContext): Promise<CustomerQuoteCapability>;
  quote(request: ApprovedCustomerQuoteRequest, execution: QuoteExecutionContext): Promise<CustomerQuoteResponse>;
  findInvocation?(logicalInvocationKey: string, execution: QuoteExecutionContext): Promise<CustomerQuoteResponse | undefined>;
}
~~~

TrustedQuoteContext、QuoteExecutionContext 由 A host 提供 scope、runId、logical invocation key、共享 ledger、deadline 与 AbortSignal；端口不接受用户自造 principal。ApprovedCustomerQuoteRequest 是已验证 snapshot 的客户契约映射，包含固定输入／价格／规则／算法版本，不是模型裸参数。

CustomerQuoteCapability 必须声明算法身份及版本证明、支持品类／费用、精度和舍入契约、价格绑定模式、结果明细能力、最大输入、超时、幂等／状态查询能力、是否同版本可复算。read-only 指无客户生产报价保存／审批副作用；函数若会自动保存或发送，首期必须选无副作用试算接口，不能谎称 read-only。

| 适配方式 | 必需实现 | 失败行为 |
| --- | --- | --- |
| HTTP | 可信 endpoint/credential ref、超时/取消、请求及响应归档、版本/价格回执校验 | 无权限／版本不匹配不可用；不接受模型 URL |
| 库 | 经授权安装的固定模块与 digest、同一映射／conformance suite、取消及资源隔离 | 无许可／输出不符契约拒绝；不动态执行模型代码 |
| 受控进程 | 固定已注册可执行入口、结构化 stdin/stdout、资源／取消边界与版本回执 | 不接受任意命令、文件路径或脚本；超时终止并保存状态 |
| 内部合成替身 | 明确 synthetic 标记、独立预期与边界样例 | 仅验证机制，不能标客户正式报价 |

客户内部价格必须使用已批准 explicit input snapshot，或服务支持的 pinned server snapshot。若只接受“当前最新价”且不能证明实际应用版本，保存诊断响应与限制，不能形成已确认口径的正式报价。

同一 quoteInputDigest＋functionBindingRef＋task logical key 重试命中原调用回执。外部超时但可能已执行时标 execution_unknown；先用 findInvocation 恢复，不能偷偷重调并假称 exactly-once。若接口没有查询／幂等能力，由授权人员确认是否建立新逻辑动作，旧尝试保留。取消后的迟到响应可归档但不能恢复 run 或发布。

### 5.2 缺价补录的实际路径

1. 参数／函数能力检查产生 MissingPriceRequirement：inquiryLineId、规格引用、chargeCode、计价单位、税口径、适用日期和缺失原因；不填预设金额。
2. 有授权的价格维护者进入本项目价格面板，选择补录或者导入已支持 CSV/XLSX；填写精确金额／currency／per quantity、net/gross、有效日期、适用规格、权威来源及理由。
3. 形成 PriceRevisionDraft，按 A 的 CAS 审核机制校验。来源缺失、冲突 selector、错单位、错范围或无权限均阻断批准。
4. 价格审核者确认该记录属于可用权威来源；发布新的 PriceSnapshot，保留旧版与 supersedes。原报价／run 不换输入。
5. 项目复核者查看新旧价格、受影响行与口径差异，明确采用新快照；产生新 ProjectRevisionRef、QuoteInputSnapshot 并重新请求计算。
6. 历史报价读原价格；新报价只读新快照。补录成功但尚未项目采用时页面仍显示未就绪。

部署的客户权威契约若只允许服务器价库修改，价格面板改为授权客户价源导入／更新回执路径；首期必须选择并实现至少一种可用方式。不能以“未来价格服务”代替必要补价能力，也不自动写客户生产价库。

### 5.3 运行状态与正式结果

| B 状态 | 进入条件 | 用户可做什么 |
| --- | --- | --- |
| draft | 资料／规范字段尚未完整 | 修改、解析、确认 |
| awaiting_parameters | 必需字段 pending/conflict | 打开原文、修正并确认 |
| awaiting_pricing | 缺价／过期／费用或税口径未确认 | 授权补价、更新口径 |
| ready | 参数、价格、规则、函数及 A 基线检查通过 | 冻结快照并提交任务 |
| running | A run 已接受，固定 execution binding | 看阶段、取消 |
| system_blocked | 函数失败／覆盖或证据不满足 | 看诊断、处理原因，不显示合格报价 |
| system_verified | A 发布同一已核验结果 | 看正式表与来源，发起业务复核 |
| business_accepted / business_returned | 授权复核决定绑定 exact published result | 导出或修订后新报价 |

B 状态是领域视图；A run phase 是执行权威，不复制其状态机。报价意图识别只在当前项目支持的固定任务中匹配。改规格／税费／数量等 NL 请求先生成明确字段变更提案供确认，再产生新修订；解释任务只引用已核验 fields 和来源。

## 6. API、存储与隔离

### 6.1 共用端点与 B 路由

以下为新增场景 REST 契约方案。复用 A 的 /projects、/documents、/confirmations、/industry-workspaces、/runs、/answers、/evidence 等公共端点；B 不新建平行运行或发布 API。

| Method / Path | 用途 | 请求／响应与约束 |
| --- | --- | --- |
| GET /api/v1/projects/{projectId}/costing/readiness | 定位缺参、缺价、范围及函数问题 | 绑定 project revision，返回逐行 blocker；无副作用 |
| POST /api/v1/projects/{projectId}/costing/price-drafts | 建立补录／导入价格草稿 | PriceRevisionDraft；Idempotency-Key；逻辑价格维护权限 |
| PATCH /api/v1/projects/{projectId}/costing/price-drafts/{id} | 修改未发布价格 | If-Match 与完整边界 Schema；新修订 |
| POST /api/v1/projects/{projectId}/costing/price-drafts/{id}/reviews | 批准／拒绝权威价格 | If-Match、理由、来源确认；拒绝不进入有效价 |
| POST /api/v1/projects/{projectId}/costing/price-snapshots | 发布批准价版本 | 批准草稿 refs，返回不可变 ref/digest；原值不可覆盖 |
| POST /api/v1/projects/{projectId}/costing/pricing-contexts | 项目采用价格／范围／税舍入口径 | exact refs＋差异确认；CAS 生成新项目修订 |
| POST /api/v1/projects/{projectId}/costing/input-snapshots | 冻结报价输入 | 指定 projectRevisionRef；服务端只读取已批准 records |
| POST /api/v1/runs | 通过公共 task 执行报价 | A canonical task:{mode:'task',projectRevisionRef,taskBindingRef,inputSnapshotRef,inputSnapshotDigest,parameters}；固定costing.quote，遵守A请求envelope其余必需字段 |
| GET /api/v1/projects/{projectId}/costing/quotes/{runId} | 报价领域视图 | 组合 A published answer/manifest、B review，不返回未核验原 JSON 为正式结果 |
| POST /api/v1/projects/{projectId}/costing/comparisons | 关联人工金标及对比 | 已核验 quote ref＋匹配 gold case ref＋已确认 comparison policy |
| POST /api/v1/projects/{projectId}/costing/quotes/{runId}/reviews | 接受／退回 | exact answerId/contentHash/manifest digest＋理由＋授权复核者 |
| POST /api/v1/projects/{projectId}/costing/quotes/{runId}/exports | 生成报价 XLSX | exact published refs＋版本化模板；返回受授权 artifact ref |

路由 id 用现有 UUID／revision 类型，scope 从 ctx 取。业务用户不能注册函数、编辑全局行业包或任意选择客户 URL。价格编辑、价格批准、项目口径采用、报价业务签核为不同 logical permission；同人是否兼任由客户授权策略明确，不在代码默认提权。

公共 API envelope／错误分类沿用 A。B 的详细 blocker code 放在已设计的领域错误上下文，不能未更新公共契约便新增平台 ErrorCode。

### 6.2 存储端口与迁移

使用一个 B QuotationStorePort 保存草稿／revision／manifest 索引与业务 review，所有正式大数据进入已有 immutable artifact store；domain package 不引入数据库 driver。推荐控制侧记录：

| 记录 | 必需约束 |
| --- | --- |
| costing_pricing_revisions | tenant/space/project/customer scope、revision CAS、draft/reviewed/published、来源审计 |
| costing_quote_inputs | snapshot ref/digest、project revision、price/policy/function refs、唯一逻辑 freeze key |
| costing_invocations | run/task logical key、attempt、request/response ref、execution_unknown／cancelled 状态 |
| costing_quote_reviews | exact published answer/manifest、review revision、接受／退回、理由与复核身份 |
| costing_gold_cases / comparisons | 同输入／口径 refs、保留集标识、comparison policy、分类差异及签核 |

各表按 tenant/space/project 与记录 id 唯一／索引；通过既有事务记录状态变更和 outbox，工件 stage/publish 与失败恢复沿用 A。PriceSnapshot、QuoteInput/Result、comparison 内容不存成可覆盖 JSON。

B 迁移编号在 A main 同步后检查现有最大编号再分配，不预先占用历史 056 或复用 WIP 编号。保留 @1/@2 历史答案，B 使用 A 的新增 @3 reader；迁移失败关闭 B capability，不让兼容旧事实回答的逻辑被报价改动破坏。

## 7. 证据、数字核验与业务验收

### 7.1 字段绑定

每个正式可见字段必须来自 A typed-result-manifest 的可核验 row/column 绑定。最少映射：

| 显示字段 | Value pointer | 必需上下文绑定 |
| --- | --- | --- |
| 数量 | QuoteResultArtifact.lines[i].quantity.amount | quantity.unit、inquiryLineId、input line 的确认／原行引用 |
| 单价 | unitPrice.price.amount | price.currency、per.amount/unit、taxBasis、price entry／snapshot |
| 费用／税额 | charges[j].amount.amount 或 taxAmount.amount | currency、chargeCode、net/gross、规则与实际响应 pointer |
| 行金额 | lineTotal.amount | currency、稳定 inquiryLineId、inputDigest、authority output pointer |
| 合计 | totals 的对应 amount | currency、scopeRef、coverage complete、确认汇总／舍入口径 |
| 规格与解释文本 | 已确认 spec、规则/引用字段 | 对应字段／原文 locator 与 digest；不得混入未核验金额 |

A 已承诺 quantity 使用 unitPointer、money 使用 currencyPointer，单价分母／税口径使用固定 Schema 的 contextPointers。上表是可读字段路径；实际 binding 使用经 Schema 校验的 RFC 6901 JSON Pointer，例如 /lines/0/lineTotal/amount，并同时绑定该行 /lines/0/inquiryLineId；不能把含 i/j 的路径传给核验器。QuoteResultArtifact在gateway envelope下层：最终cell binding必须指定valueArtifactRef=wrapper.outputArtifactRef、valueArtifactDigest=wrapper.outputDigest，并由Core核对envelope→受检wrapper→outputBindingsRef及该领域工件的完整链；pointer不能直接作用于wrapper payload，也不能从同scope任意工件寻找相同金额。PriceEntryBinding通过snapshot ref/digest与唯一priceEntryId解析至真实entry及pointer，不假定每个内嵌价格已单独存成ResourceRef。CNY等currency不伪装成物理unit。若通用@3不能表达这些binding，先补A main，不在B绕过hard verifier。

### 7.2 计算证据与发布有效性

compute-result-artifact@1 wrapper固定A定义的operationRef、registeredOperationDigest、algorithmVersion、inputSchemaDigest/outputSchemaDigest、inputSnapshotRef/inputSnapshotDigest、parametersRef/parametersDigest、logicalKeyDigest、outputArtifactRef/outputDigest、outputBindingsRef、coverage/domainStatus/dataMode及依赖。wrapper.algorithmVersion精确对应QuoteResultArtifact.customerAlgorithmRef。outputBindingsRef指A的typed-output-bindings@1，保存原始outputArtifactRef/digest及row/field pointers，不内含尚不存在的gateway evidenceRef或最终typed manifest。B只提供QuoteResultArtifact领域body、这些原始output绑定和批准字段、industry/customer rules、价格、口径、算法、原调用回执依赖，B不再造独立发布协议。

无循环归档顺序严格复用A：QuoteResultArtifact领域output（先归档客户rawResponse及调用回执）→typed-output-bindings@1（没有gateway evidenceRef）→compute-result-artifact@1(outputBindingsRef)→gateway envelope/ToolResult→Core result builder创建typed-result-manifest@1（此时绑定真实evidence）→result policy reports→task-finalization-receipt@1→answer-draft@3。input策略在compute前执行；所有工件先依赖后引用，不能给wrapper后填最终manifest或给原manifest后填policy refs。

B 另向 A 的 TaskValidationPolicyPort 注册版本化策略：input 阶段核查确认字段、规格／单位、范围、价格／税费／舍入及权威函数绑定；result 阶段核查逐行覆盖／分组、应用价格与算法回执、币种／费用口径及客户已批准的计算不变量。策略实现与 compute 独立装配；PublishedTaskBinding.validationPolicies 将必要策略标记 required:true，并固定 policyRef、stage、registryDigest、reportSchemaRef。行业动作声明只保存需求及 refs，不携执行代码；未绑定策略时 task 未就绪。不能靠 quote函数返回 verified:true、客户端 true 或 JEV pass 跳过策略。

报告复用task-policy-report@1，固定execution/input/parameters/output refs及digests、typedResultManifestRef、策略版本、coverage、pass/fail/unknown/incomplete和逐行／逐字段violations，并归档为computation证据。result policy使用同一已归档typed-result-manifest；task-finalization-receipt@1独立关联该manifest、输出与全部必需policyReportRefs，@3 body固定resultManifestRef/resultManifestDigest及finalizationReceiptRef/digest。原wrapper／manifest不后填报告，避免digest环。A hard verifier核对真实策略执行及所有pins一致、覆盖完整且必需报告pass；validity重查策略及依赖有效性。失败仍可发布经独立核验的诊断／缺口说明，不能发布完整合格报价。

正式发布前用 A validity extension seam 验证引用仍授权可见、版本正确、没有撤回／过期／错误范围，且客户响应应用的价格／算法与输入一致。输入修订以后旧报价仍可读，但不能当作新输入的有效输出；历史读取保留当时依据并标状态。

至少阻断：改金额、错 currency/unit、对调两行、遗漏后页、未经确认的价格／参数、未知 grouping、函数版本错、价格回执不同、缺输入工件、丢响应／损坏 digest、引用错项目、partially covered 却显示完整合计。draft 修改需重新核验；专业 renderer/exporter不能自行补值。

### 7.3 四层验收与 GoldCase

内部机制、系统核验、真实业务通过、客户／内部 MVP 验收分别记录，不合并为一个 passed。GoldCase 至少包含同一原始资料及行 ID、已批准标准参数、价格／规则／币种／税费／范围／舍入版本、权威函数 binding、人工最终报价及其来源、验收人和 comparison policy。

无配对关系的历史成本表、不同项目报价或过期价格不能直接作为金标。训练／调参样例与保留集分开；禁止由被测函数输出生成期望。按行及 material/specification、quantity/unit、unit_price、charges、tax、rounding、coverage 等类别对比，不只检查总额。

comparison 使用 DecimalString 精确解析；系统核验要求等于归档授权结果。人工比较的 tolerance 可以按客户确认规则选 absolute、relative 或字段特定策略，绑定版本与确认人；未确认不设“1%”等默认通过门槛。专家可解释合法差异并接受，也可退回；没有授权签核不得显示 business_accepted。

BusinessReview 固定 quote answerId、contentHash、result manifest digest、comparisonRef 与 review revision，不能给之后的重算自动继承“已通过”。合格报价要求确认输入、权威口径、约定范围完整、系统核验和业务接受记录全部成立。

## 8. 专业 UI 与导出

### 8.1 FrontendScenarioModule

复用 A 的可信 FrontendScenarioModule：ref:VersionRef、capabilityRequirements、taskEntries、ParameterPanel、ResultRenderer、exporters。B module 为 electrical-costing；该 React 注册端口和组件 props 仅位于 apps/web，contracts仅含非 React元数据和公共数据类型，industry pack仅保存 moduleRef/taskBindingRefs声明，不嵌 React、bundle或动态代码地址。可信 Web composition 将版本化 moduleRef 注册到构建内模块，不由API或上传资料装入组件代码。

| 插槽 | B 内容 | 共用 A 能力 |
| --- | --- | --- |
| taskEntries | “为当前项目报价”“检查缺项”“解释该报价”“确认修改后重算” | 当前项目／profile／权限、正常 task dispatch |
| ParameterPanel | 桥架字段、规格、计量与配件确认、范围选择 | FieldConfirmation、原文／cell 面板、CAS与冲突 |
| pricing panel | 权威价格及口径、缺价补录／导入／审核／采用 | 版本／来源组件、权限与review公共接口 |
| ResultRenderer | 报价表、费用、税、覆盖、blocked行及状态 | 只读已核验 manifest、页读取、证据导航 |
| comparison/review | 人工差异、接受／退回及依据 | 固定 published refs、审计与权限 |
| exporters | 桥架报价 XLSX、保留 JSON与引用索引 | 授权工件生成／下载、同版本导出 |

未挂载 B 的 main 不显示默认报价按钮；挂载 B 后缺价／函数未就绪显示具体可操作原因，不能仅返回 CAPABILITY_NOT_CONFIGURED 并清空页面。

### 8.2 报价工作台

顶部持续显示项目、输入 revision、行业／价格／规则／函数版本、范围、币种、税口径、系统核验和业务状态。表包含原稳定行号、名称／规格、quantity/unit、unit price/basis、charges、line amount、状态；总数与 pending/excluded/covered 相互对账。

分页保持同一已核验 manifest digest，不因翻页读“最新报价”。点击任意数值按 §7 展开原行／确认→价格和规则→函数调用→结果。解释可以用模板或模型叙述，但仅引用已核验字段；新增断言／金额必须走 A 的 writer 和重新核验，不能前端展示一段自由文字替代证据。

重算展示参数和口径变更再确认；执行中可取消，重复请求命中同逻辑动作；历史报价能回读并显示旧版本。长表、键盘表单、空态、错误态、权限、窄屏滚动及表格/依据面板必须在浏览器验证。

专业复核可将错误规格、未覆盖品类或规则问题提交为A的行业修改提案，固定来源review／input refs与版本并由行业维护者审核；不会直接改已发布包或追溯覆盖旧报价。提案去除客户价格和敏感原文后才可进入共享行业工作区，未获共享授权的细节仍留在客户项目。

### 8.3 XLSX 与 JSON

QuoteExportManifest 固定 publishedAnswerRef、typed manifest digest、业务 review ref、export template version、coverage 和范围。导出逐页读取同一已核验结果，不调用客户函数、不另算金额或从 raw response补字段。

XLSX 至少包含报价明细、费用及口径、版本和状态、差异／业务签核、溯源索引。精确数值以不丢精度的表示保存；不能先转 JS Number 或靠 Excel 公式计算正式金额。金额 decimal string 与 currency/unit 分列，原行 ID、input/result digests 可回查。客户要求普通数值格时先冻结可表达精度契约并测试边界；不满足者保存为文本并明确列含义。

JSON 导出复用 A 通用方式。UI／XLSX／JSON 的行数、金额和状态一致；部分覆盖导出保留 pending 并标范围，不标“完整报价／业务通过”。下载再次鉴权，跨项目引用拒绝；共享行业包导出不包含上述客户工件。

## 9. 错误、恢复与资源限制

| 领域 blocker | 行为 | 可恢复路径 |
| --- | --- | --- |
| parameter_missing / unit_unknown / specification_conflict | 阻断对应输入 | 原文对照、编辑和重新确认 |
| price_missing / price_expired / price_conflict | 不默认价、不静默遗漏配件 | §5.2新价格快照及新输入 |
| scope_or_tax_unconfirmed | 不建立正式 ready snapshot | 项目口径签核 |
| rule_unhandled | 保留完整条件，阻断依赖结果 | 通用缺口回 main 或专家确认合法不同方案 |
| function_unavailable / contract_gap / version_mismatch | 无正式金额 | 权威契约／adapter discovery与版本修复 |
| execution_unknown | 保留 attempt，不自动重复调用 | 查询回执或授权新逻辑动作 |
| result_incomplete / grouping_unresolved | 保存诊断，不发布完整合计 | 完整响应／分组映射修复 |
| evidence_invalid / snapshot_changed | 发布拒绝，不能修改旧run pins | 新快照、新run、重新核验 |
| cancelled / deadline / budget_exhausted | A 终止；迟到结果不发布 | 按 A 恢复规则／新的授权运行 |

技术 cap 随 deployment/profile 固定并写入能力回执：文件、snapshot bytes、行数、价格条数、输出页、CPU/elapsed、并发与客户调用上限。B 复用 A 执行分册的初值：typed表每页最多250行、最多32列、总10,000行，正文最多128个原子断言；表格逐页全字段核验独立执行，正文断言上限不是跳过后页的理由。A 的bytes／deadline／ledger等限额同样生效，B不另造不受预算的JSON直出通道。内部验收至少 1001 行；容量结果按实测报告，不把现有约600行资料估计当客户容量承诺。

默认按整单调用权威函数；只有 capability 明确支持 partitionable、其分组与合并规则经认可时才分批计算。全单折扣／税费／配件共用等跨行语义不能被按页批处理破坏。超 cap 返回明确不支持／不完整，不能逐页相加猜正式总额。

所有缓存键绑定 tenant/space/project、输入 digest、价格／规则／算法及 output mapping versions。相同价格版本下不同项目参数仍不同 key；不在全局变量保存某客户上下文。重试、分页、解释及草稿修复共用 A ledger，不新增第二套预算。

## 10. 验收映射与任务候选

### 10.1 可实施测试矩阵

测试列为实施时必须建立的覆盖，不代表本次已运行。U 为领域单元／契约，I 为正常 HTTP＋真实持久层集成，E 为浏览器 E2E，R 为经授权的真实模型／客户函数／人工样本验证。

| B AC | 总体 US / FR | 测试与独立期望 |
| --- | --- | --- |
| B-AC01 | US-001～007,011,012；FR-1～17 | E：从桥架合成原资料经 A 生成定义／规则／动作，编辑审核发布挂载；不可执行规则/动作阻断；不预置最终包 |
| B-AC02 | US-003,008,010,013,014；FR-3,12,13,18～21 | U/I/E：XLSX/CSV实际cell→exact字段→身份及确认；同规格两行不合并数量；重复／分页／失败定位 |
| B-AC03 | US-014,016；FR-20～24 | U/I/E：缺参、米↔根无长度、错currency/单位、税或范围冲突阻断；修正后新revision，旧snapshot不变 |
| B-AC04 | US-016；FR-21,24 | I/E：缺配件价→授权补录／导入→审核发布价→项目采用→重新报价；零价须权威理由，越权／过期／冲突反例 |
| B-AC05 | US-007,017,023；FR-10,11,24,25 | U/I：至少两种 adapter test实现共用端口套件；exact输入输出、错版本／schema／价格回执、取消、unknown调用状态 |
| B-AC06 | US-015,017,018；FR-22～27,31 | I/E：普通报价问题→正常 /runs→真实注册compute→A wrapper/manifest→verify/publish；不seed answer、不手动启动Controller |
| B-AC07 | US-018～020；FR-26～29 | U/I/E：改金额、对调行、wrong currency/unit、缺原文、后页漏行、被撤回价／规则被拒绝；显示值逐字段等于独立归档结果；缺必需策略、伪造pass、另一个output的pass、报告unknown/incomplete和finalization pins错均阻断 |
| B-AC08 | US-019～022；FR-28～33,35 | E/I：通过场景组合入口挂载专业分页表、依据、解释、XLSX/JSON同版；partial无完整合计；幂等、取消及重启旧答案回读 |
| B-AC09 | US-021,022；FR-24,30,33,34 | U/I/E：同输入同口径人工gold按行/类别比较；阈值未确认不passed；接受/退回绑定exact版本，改输入不继承签核；反馈仅建立经授权提案，原行业包／报价不变 |
| B-AC10 | US-023；FR-5,16,17 | I/E：两客户不同列名/单位映射同语义合成输入一致；共享包无客户价格；跨项目/租户refs、导出及模型上下文拒绝 |
| B-AC11 | US-024；FR-1～35 | E：正常双助手端到端、1001行后页证据、缺价修复、改输入重算、回读、导出和反馈提案；实际UI/API/Worker/Controller/store及命名资源清理 |
| B-AC12 | US-004,006,008,016～024；FR-4,8,12,24～33 | R：实际模型提参评测、权威函数conformance、保留配对项目逐行对比及授权造价师签核；客户/MVP验收另列 |

另以B-AC13覆盖P.US-009及P.FR-5：在本体工作台基于桥架草稿／发布版本生成A的syntheticExampleSetRef，并持续显示“合成测试”标记、规则匹配及注册动作试算，覆盖缺参、同名异物、冲突、错单位、缺能力与缺价。它与FewShotExampleSet、真实项目输入及业务gold区分；不能被直接批准为客户价格／工程量，跨合成／真实项目引用被拒绝。B-AC01同时显式核对P.US-002的桥架目标问题、P.US-005定义编辑／拒绝／合并／拆分及影响差异、P.US-006完整条件／例外、P.US-011行业包导出／重挂载和语义发布／部署可执行状态；这些A既有机制在B的桥架资产上回归，不能用FR-1～17概括行代替实际断言。

P.US-001～024均须有直接验收映射；P.FR-1～17主要由A交付公共机制，B-AC01/02/10/13证明桥架接入与隔离；P.FR-18～27由B-AC02～07证明实际批准输入、参数/价格/口径及执行/核验；P.FR-28～35由B-AC08～11证明结果、历史、取消、导出、签核、反馈提案和场景挂载。B-AC11的整栈范围不能替代这些独立失败／边界用例。P为总体PRD namespace，避免与A分册US/FR混同。

真实函数未就绪时 B-AC05/06 的内部合成路径可证明机制，B-AC12 保持未验证并阻止宣称合格客户报价。测试样例来自独立业务推导和客户认可结果，不以客户端代码或被测函数自动计算期望。客户资料在授权存储，公共 fixture 仅使用合成／获准脱敏数据。

### 10.2 实际测试入口与交付证据

实施时在 platform/ 按改动运行 lint、typecheck、受影响 Vitest 单元／集成及 boundaries；交付检查使用 pnpm run verify。实际浏览器脚本为 pnpm run build:web，然后 pnpm run test:e2e；[platform/package.json](../platform/package.json)的test:e2e运行[vitest.e2e.config.ts](../platform/vitest.e2e.config.ts)，匹配 tests/e2e/**/*.e2e.ts，测试内从 @playwright/test 启动 chromium。仓库没有 playwright.config.ts，不用不存在的Playwright runner命令冒充执行证据。verify不含需要Web构建和浏览器二进制的独立E2E。

B新增正常装配的 tests/e2e/costing.browser.e2e.ts 及相应集成／契约测试（拟定文件名）；浏览器驱动真实HTTP、A task/Worker/Controller与持久层、B UI，而非复制当前遗留workbench fixture作“报价全链路”。测试报告逐项记录命令、数据模式、真实调用范围、资源清理与未验证项；R层采用授权资源专用suite，不能在普通CI凭缺凭据标passed。本次仅读脚本及写SPEC，没有运行这些命令。

### 10.3 任务与正式依赖

本批 GitHub Issues 及对应 V03 文件见[v0.3 任务索引](../.autoresearch/batches/v0.3-assistants/INDEX.md)及 manifest；V03 编号不等于 GitHub Issue 数字。A 为 V03-001～047，以下 25 项 B 任务为 V03-048～072。状态均为 planned，已创建 GitHub Issues，尚未开始实现。

V03-048～050 可先完成内部验证范围／端口契约／独立样例与外部资料盘点；盘点完成不改变真实范围、函数、价源、配对 gold 的 external_unconfirmed 状态。V03-051 必须取得 A 已验收 main 基线。后续 B 代码全部依赖此门槛。

内部机制使用持续标注 synthetic 的行业包、价源、两适配与独立比较样例；V03-069 证明该正常闭环。真实客户 adapter 单列 V03-070，只有正式资源/许可/版本契约就绪才能完成；V03-071 强制依赖它及真实配对 gold／验收人，不以 synthetic 关闭。V03-072 才是完整 MVP 退出。

| 本地任务 | 内容 | 依赖 |
| --- | --- | --- |
| V03-048 | 确认桥架报价的输入、品类、费用与图纸覆盖 | 资料盘点／内部验证契约可先行 |
| V03-049 | 确认权威报价函数、价格版本与复用权限 | 资料盘点／内部验证契约可先行 |
| V03-050 | 取得配对人工报价、比较口径与授权验收人 | 资料盘点／内部验证契约可先行 |
| V03-051 | 同步已验收 main 并完成造价分支兼容门槛 | V03-047 |
| V03-052 | 通过本体助手生成审核桥架行业包与动作声明 | V03-051、V03-048 |
| V03-053 | 实现版本化价表、授权补价与项目采用接口 | V03-051、V03-049、V03-052 |
| V03-054 | 实现可替换报价端口与两种合成适配的契约套件 | V03-051、V03-049、V03-052、V03-053 |
| V03-055 | 实现桥架清单映射与不可变报价输入 | V03-051、V03-052 |
| V03-056 | 实现规格、数量、单位与必需字段确认校验 | V03-055 |
| V03-057 | 实现费用范围、税费、舍入与计价就绪策略 | V03-053、V03-056 |
| V03-058 | 将 costing.quote 接入公共 task、compute 与正常报价入口 | V03-052、V03-054、V03-055、V03-057 |
| V03-059 | 实现报价输入结果策略、金额证据与完整发布门槛 | V03-058 |
| V03-060 | 挂载桥架资料、清单与专业参数确认页面 | V03-051、V03-055、V03-056 |
| V03-061 | 实现价源、计价口径与缺价修复专业界面 | V03-053、V03-057、V03-060 |
| V03-062 | 实现已核验逐项报价、费用范围与业务状态工作台 | V03-058、V03-059、V03-060、V03-061 |
| V03-063 | 实现金额、规格、价格规则与函数版本的逐项溯源 | V03-059、V03-062 |
| V03-064 | 实现与已核验版本一致的 XLSX 和 JSON 报价导出 | V03-059、V03-062 |
| V03-065 | 实现配对比较、业务签核与行业反馈提案服务 | V03-050、V03-059 |
| V03-066 | 实现人工差异、接受退回与资产反馈专业界面 | V03-062、V03-065 |
| V03-067 | 完成重报价、版本差异、取消与 unknown 恢复闭环 | V03-058、V03-062、V03-065 |
| V03-068 | 验证两个客户结构映射与独立报价对照测试 | V03-055、V03-058、V03-065 |
| V03-069 | 完成造价双助手正常入口的合成整栈浏览器 E2E | V03-052、V03-053、V03-054、V03-055、V03-056、V03-057、V03-058、V03-059、V03-060、V03-061、V03-062、V03-063、V03-064、V03-065、V03-066、V03-067、V03-068 |
| V03-070 | 实现并核对已授权的真实客户报价适配器 | V03-049、V03-054 |
| V03-071 | 完成真实模型、权威函数与保留样本的业务验收 | V03-049、V03-050、V03-069、V03-070 |
| V03-072 | 完成造价 MVP 使用文档、交接与最终交付门槛 | V03-069、V03-071 |

V03-048 若确认必须图纸量算而能力尚缺，独立拆经客户认可的量算实现／验收卡并更新 PRD／SPEC／本批依赖；未确认正式范围时不单方面删需求，V03-069 清单机制验证不能代替它。当前任务不声称所有图纸格式已可实现。

阶段 B 完成要求主线兼容门槛、适用 U/I/E、B-AC12 真实样本签核及明确的客户／内部 MVP 验收均满足。main 合入、合成 E2E 与真实业务通过分别记录。

## 11. 外部依赖、图纸与未验证风险

| 依赖 | 必须取得的证据 | 未满足时 |
| --- | --- | --- |
| 品类／费用／报价性质 | 项目负责人及造价师签核范围版本 | B设计可持续，正式计价not ready |
| 权威函数与许可 | 算法/接口身份、版本、授权、输入输出及read-only能力 | 客户adapter discovery；合成机制不冒充真实 |
| 价格/税费/舍入 | 权威来源、内容/适用日期、收费基准/顺序及舍入stage | 缺价／冲突阻断，不能套演示默认值 |
| 配对gold及验收 | 同原资料/参数/口径人工结果、保留集、容差/验收人 | 无业务通过结论 |
| 分组/配件路径 | 已认可的行对应、配件计价、缺价与分配规则 | grouping/coverage阻断，不静默遗漏 |
| 图纸覆盖 | 客户确认是否必须仅凭图纸量算及代表性格式/单位/位置证据 | 保持明确未覆盖，不单方面从MVP删除 |

图纸探索按客户约定分为专业导出明细、DXF几何、图层／块／文字和扫描/OCR路径。A 的 UTF-8/JSON/CSV/XLSX支持不证明PDF/DWG量算可用；上传成功不等于量算通过。若本期验收必须由图纸给工程量，需真实代表图验证及独立解析／单位／数量验收，清单fallback或人工录入由客户确认，不擅自认为新增需求。

真实客户服务若无法固定价格／算法版本，历史响应可以归档但不能承诺同版本复算；如果正式报价契约要求的版本与依据不可证明，保持系统／业务未就绪。外部依赖不阻断 A，B 内部机制通过也不解除客户验收依赖。

## 12. 当前代码参照与文档交付

本设计与现有公共入口相衔接：ComputeOperationHandler／data_query.kind=compute、Money／DecimalQuantity、不可变工件及 scoped reader、WorkflowController／AnswerPublicationService。当前 facts 专用装配、只接受facts的writer/validity及旧@2 renderer缺口由A解决，不能在B假设今天已完成。

代码参照：

- [当前compute handler装配契约](../platform/packages/tool-services/src/handlers/data-query.ts)与[操作授权](../platform/packages/tool-services/src/catalogue.ts)。
- [现有公共数值和工件类型](../platform/packages/contracts/src/generated/contracts.ts)；类型以运行时Schema为权威。
- [现有主线正常HTTP回归](../platform/tests/integration/core-local-host-postgres.spec.ts)；B必须新增正常报价路径。
- [第一单方案](../docs/poc/electrical-costing/first-poc-plan-2026-09-29.md)仅作为客户资料静态核对与业务风险依据。

本轮只生成SPEC与任务候选；没有复制或执行客户源码、读取实际价格、调用客户API、运行模型／测试／服务或合并分支。进入实现前根SPEC／任务队列把A门槛、B外部discovery、本文AC和正式Issue编号逐项对齐。
