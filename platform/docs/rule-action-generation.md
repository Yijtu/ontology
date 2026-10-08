# 来源约束的规则与动作候选

GAP-008 的叶服务是 `RuleActionCandidateGenerationService`。普通宿主装配由 GAP-019 注入工作区、原文读取、当前定义候选、动态术语、既有规则/动作存储、操作登记和预算化模型端口。模型关闭时仍可挂载人工来源确认；生成返回明确的未配置错误。受控模型测试证明机制，真实模型的语义质量仍未验证。

## 普通 HTTP

- `POST /api/v1/industry-workspaces/:workspaceId/rule-action-generations`：`sourceRefs`、`kinds`（rule/action）、`selectedDefinitionCandidateIds`、`generationPolicyRef`、可选 `candidateLimit`（1–100）；需要 `If-Match` 和 `Idempotency-Key`。
- 既有 `/rule-action-candidates/ingest` 保留为显式导入。它不调用模型，不能显示为平台生成。
- `POST /api/v1/industry-workspaces/:workspaceId/rule-action-candidates/:candidateId/source-confirmations`：固定 `contentDigest`，提交真实 `sourceRefs`、`sourceSelections` 和人工 `reason`；同样需要两个条件头。

`sourceSelections` 是 `{path, sourceIndex, fragmentIndex}`，只选择服务端有界回读的原文片段。条件叶节点、关系及目标条件、每个例外及其条件、`dependencyRefs[i]`、适用范围和结论均分别定位；动作定位 `declaration` 和每条 `declaration.preconditions[i]`。模型不能填写 locator、摘要或处理器。表格行保留原始结构化 span；文本 AST 保留真实 parse/chunk/quote/precision。

不可变上下文同时保留原始有序 `inputSourceRefs` 及每条路径的实际 `sourceBindings:{path,sourceRef,sourceSpan}`；候选来源列表即使压缩／重排，也不影响逐条件定位。当前规则 AST 的来源类型只支持文本；仅凭 CSV/XLSX 行定位生成的规则保留真实结构化依据并明确待确认，不能启用或发布，须补选支持的文本证据。结构化事实前提和动作声明的真实表格定位不受此限制。

生成结果始终是 draft。条件、例外、依赖和不支持的有限语法原样保留；来源缺口、截断、未选择术语、错误类型/单位和未固定依赖成为显式阻断项。只有已登记、已授权、Schema 相符且真实构建摘要相符的动作能够得到 executable binding。生成不审核、启用或发布。

解析器关闭响应、候选、AST、例外、声明和引用的字段集合，并限制深度、节点、字符串、数组和响应字节。未声明的语义条件（例如 `minCount:2`）是分类失败，不会变成一条边存在的弱化规则；失败批次保留有界的本地校验路径／原因且没有半成品候选，外部模型／传输错误继续隐藏任意提供方文本。

编辑产生新候选，并使旧来源确认过期。确认重新读取当前批准的原文与术语，保留保存的人工作品，追加新的候选 ID/contentDigest/replacesCandidateId，不继承旧审核，也不记录虚构模型调用。用户再通过既有审核账本批准新修订，然后显式启用并执行合成验核和发布。不能通过清空标记来解决缺依据的问题。

## 固定上下文与存储

每次新生成只解析一次宿主模型端口，所有分批调用共用它的预算和取消信号。最多 100 个候选、64 个来源、128 个定位/候选、256 KiB 模型输入；输出分批受模型 token 和字节预算约束。当前定义历史最多 2000 个版本，规则/动作历史到 250 条覆盖界限即显式拒绝，避免把不完整第一页当全集。

082 在既有 `asset_candidate_batches` 增加 generation family 与有界规则/动作结果元数据，在既有候选表增加 generation context；没有第二套审批或语义真相表。TBox 批次读取明确筛选 definition family。规则/动作批次和所有 draft 在同一事务提交。工作区头、最新发布包、真实 draft/document set、定义投影、规则/动作版本与生命周期在现有工作区锁下重新核对。

同幂等键重放保存结果，不重新调用模型；换输入拒绝。失败批次没有半成品候选。HTTP 断开、取消或截断不会返回迟到的成功。启用及应用／PG 发布门均要求生成／人工确认所绑定的真实 draft revision/digest 与当前草稿一致；草稿推进后须重新确认并审核新候选，不能沿用已启用状态绕过。发布完整冻结逐条件来源与生成/确认上下文，已有 P1 运行和历史绑定继续读取其固定版本。
