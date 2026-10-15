# 按原文生成定义与人工来源确认

定义生成读取工作区当前草稿所固定的批准文档集，通过 `SourceGroundingPort` 取得真实文本、PDF 片段或表头与样本行。原文与候选载荷均作为不可信数据进入请求；业务边界、当前草稿候选和已挂载定义分别标注。候选不是已发布事实。可选的 `competencyQuestionRef` 由宿主 `ApprovedCompetencyQuestionReader` 读取准确的批准版本，只发送有限问题、意图与能力声明，不发送期望金标准。

`POST /api/v1/industry-workspaces/:workspaceId/generations` 继续要求 `If-Match` 与 `Idempotency-Key`。请求接受 `kinds`、`generationPolicyRef`、`sourceRefs`、准确的 `documentSetRef`，以及可选的 `candidateLimit`（1–500，默认 100）和 `competencyQuestionRef`。文档集必须等于当前草稿的文档集；不存在的批准 CQ 版本明确失败，不替换成演示问题。

模型只能以 `sourceIndex` 和 `fragmentIndex` 选择服务已经回读的片段。服务保存该片段的实际 `sourceRefs`、`sourceSpans` 与摘要，不接受模型自行构造的定位信息。仅有来源编号、虚构片段或只有表头而没有数据行时，候选保留为 `pending_confirmation`。未批准、已撤回或不可读的完整请求不会被包装成可用的空来源。部分读取的状态与原因保留在模型上下文中，只有实际读取到的片段可被选中。

生成按本次上限分批，每批最多 25 个候选，输出预算随批大小调整。单次模型上下文最多 256 KiB。新的逻辑操作使用自己的宿主预算账本；同键重放在打开账本前返回。所有批次只解析一次宿主模型端口，使用同一预算账本和取消信号；不会通过换账本或重试重置额度。截断、未收到完成事件、异常 JSON、未声明字段、工具调用、超大输出与取消均明确失败，HTTP 客户端断开也传递同一个取消信号。失败批次不保存部分候选。模型未配置时不调用供应商，也不创建伪模型调用批次。

重生成相对当前候选替换链和准确挂载的已发布定义处理。完整载荷、冲突、输入草稿/上下文、来源、验证问题、生命周期与待确认结果均相同时，复用原候选 ID；新批次的 `reusedCandidateIds` 只引用原版本，原生产批次和审核历史不变。任何上下文或验证变化都追加新版本。模型消费的当前草稿按种类、logicalId 与稳定语义内容排序，不包含自引用候选 ID、上下文摘要或审计替代摘要；具体版本另在提交时固定。空草稿变为已填充草稿是实际的上下文变化，需要一次新版本，之后相同上下文才复用。人工冲突以有限的替代定义表达，审计摘要与模型语义上下文分开，避免每次重生成都产生自变化的哈希链。不同模型建议遇到人工内容时保留人工载荷，记录明确的内容/上下文冲突，要求重新审核。旧审核不会复制到新 ID。旧记录缺少 `contextDigest` 仍能读取，但不能猜测它对应的新生成上下文。

生成与确认写入在同一数据库事务内锁定工作区，复核期望 head 以及所有当前候选的内容、来源和验证结果，避免模型执行期间的编辑或验证变化被覆盖。历史读取有显式 2000 个版本上限，模型上下文有 500 个当前候选上限；超过时拒绝，不能把默认短页当完整投影。当前草稿使用生产存储的 `DESC LIMIT 1` 精确查找，发布推进 head 而没有新草稿时仍读取准确的最后草稿，不受 100 个历史版本限制。

## 人工来源确认

`POST /api/v1/industry-workspaces/:workspaceId/source-grounding` 以 `sourceRefs` 读取实际可选择片段，可用 `If-Match` 固定当前 head。响应含文档集、来源状态、真实片段及工作区 revision；它不调用模型、不改变审批或候选。确认操作会独立重新读取，不能把预览当成写入授权。

`POST /api/v1/industry-workspaces/:workspaceId/candidates/:candidateId/source-confirmations` 接受 `contentDigest`、`sourceRef`、`fragmentIndex`（0–63）和 `reason`，同样要求 `If-Match`、幂等键及编辑角色。服务再次经 `SourceGroundingPort` 回读当前批准文档集，确认候选仍为当前待确认版本、摘要一致，且片段确实存在。

确认追加一个保留原人工载荷的新候选版本，固定真实 span，移除已解决的缺来源问题，保存 `replacesCandidateId`。它不修改旧版本、不只是清标志，也不产生模型调用引用。新 ID 必须在既有 `semantic_candidate_reviews` 中取得自己的批准决定，才能继续验证/发布；对旧待确认候选的 approve 不代表完成来源确认。

宿主注入 `DefinitionCandidateGenerationDependencies.sourceGrounding` 与可选的 `competencyQuestions`。普通 Core 已连接现有来源读取适配器；批准 CQ 资源装配沿用宿主授权端口。迁移 081 仅给既有生成批次添加复用 ID 数组，不增加审批真值表。受控模型、真实 PostgreSQL/HTTP 和普通 Core 链验证证明这些结构与拒绝行为；真实模型质量及真实客户报价金标准仍未验证。
