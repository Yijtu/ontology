# 能力问题声明与独立金标

GAP-006 / #256 固定声明契约和合成资料。GAP-007 可读取已批准的有限 CQ 作为生成边界；GAP-016 负责通过实际查询、规则、compute 和证据读取执行它们，再决定发布门。声明校验通过不等于答案、证据或发布通过。

权威 Schema：`platform/packages/contracts/schema/competency-questions.schema.json`。生成类型与 bundle 由现有 `generate:contracts` 维护；不要建立另一份 schema 或用类型断言替代边界校验。

## 版本和边界

`CompetencyQuestionSet = {ref,body}`。`body.schemaVersion=competency-questions@1`，`ref` 包含 id/version/实际 canonical body digest。body 仅有合成示例标识、`execution=not_run`、声明 inventory、能力允许范围、问题和未验证的外部金标资源位。没有 `passed`、运行回执或业务批准标志。

每题包含自然问题、既有 `TaskKind`、固定 definition/rule 引用、合成观察/已声明关系/记录点、结构化 intent、所需来源定位、预期和独立推导。Intent 按 attribute / quantity_sum / rule / relation 各自限定必需和允许字段，不接受 SQL、脚本、任意端点或相互矛盾的 selector。

`CompetencyQuestionBoundary` 由宿主编译 canonical Schema 并提供 canonical body hash。`assertCompetencyQuestionSet` 在任何消费前检查 schema、请求/内容摘要、唯一问题 ID、完整 inventory pins、允许能力，以及所有输入 source pins 与问题证据范围。未知 pin、未声明能力、空/倒置范围显式失败。

来源是声明要求，不是伪造运行证据：固定版本与文件摘要，`offsetUnit=utf8_byte`，半开原始 byte 范围和 quote digest。消费时需通过授权来源端口回读 bytes，再形成真实证据；如果运行时 parser 使用字符/归一化 locator，必须明确转换并保留原始摘要关系，不能把 byte 下标直接冒充字符下标。

## 金标语义

数量使用 `DecimalQuantity`，不放 JSON 浮点数。规则预期分别保存 condition、applicability、proposition 四态；false 条件、缺观察 unknown、冲突与例外阻断不能合并。记录点和当前状态分开：后来撤回不改变此前记录点的预期。

跨项目负例保留 intent/input 项目不相同，这是要由实际授权链拒绝的输入；不得“修正”成成功请求。v2 新增字段不准默默变成 v1 字段。版本迁移和撤回必须保留旧 source、定义和金标回读。

21 个原始声明位于 `platform/tests/fixtures/competency-questions/`，两个合成行业均不是标准。每题的 derivation 描述独立业务推导，不包含运行器布局、证明条数或实现的输出。loader 仅验证数据和摘要，禁止导入 evaluator/query/materializer 来反算预期。

## 消费与外部验收

`ApprovedCompetencyQuestionReader.readApproved(scope,ref,ctx)` 是已批准资源的注入端口。批准由现有可信资源/审查宿主负责；声明内没有另一套批准真相。GAP-007 不得把未批准声明或 fixture 文件的存在当授权。GAP-016 需要冻结实际定义/规则/项目 snapshot，执行正常工具与领域服务，比较值、状态、单位及来源；另存实际执行证据和回执。

`ExternalCompetencyGoldReader` 读取单独授权的人工报价资源与 review ref。资源可用仍不代表验收通过；必须执行真实绑定和独立对比。本批缺授权报价输入、人工报价 gold 和客户 compute binding，接口返回缺资源，外部质量保持 unverified，不能用两行业合成值代填。

支持当前有限四类 intent。更多工具/任务或 fixture 版本要显式新增声明与边界，不扩展为任意脚本执行器。真实模型质量、客户价格与真实业务收益没有在本节点验证。
