# V03-007：将固定行业 Schema 注入抽取并保留精确值

阶段 A · backend · P1 · 状态 planned · GitHub [#179](https://github.com/Yijtu/ontology/issues/179)

执行工作线：feat/core-planning-provenance；目标：main。本批尚未开始实现；V03 是规划 ID，GitHub 编号见上述链接与 manifest。

## 目标与范围

- 实际生成模型请求包含固定类型/属性/关系/单位/支持规则与来源修订，受控 HTTP 服务断言消息内容。
- quantity/尺寸等从原始表示到规范值保持精确；未知字段和关系端点进入待确认而非自动发布。
- 沿用身份与审核/发布链，generation 重试不覆盖人工确认或绕过客户/项目范围。

## 依赖与进入条件

Dependencies: #173, #178

依赖：[V03-002](issue-002-public-contracts.md)、[V03-006](issue-006-ingestion-coverage.md)。
开工先核对 V03-001 的能力/旧任务/WIP记录，复用已完成实现，只补本卡缺口。完成能力按独立审查合入 main，保留场景边界。

## 验收条件

- [ ] 实际生成模型请求包含固定类型/属性/关系/单位/支持规则与来源修订，受控 HTTP 服务断言消息内容。
- [ ] quantity/尺寸等从原始表示到规范值保持精确；未知字段和关系端点进入待确认而非自动发布。
- [ ] 沿用身份与审核/发布链，generation 重试不覆盖人工确认或绕过客户/项目范围。
- [ ] 实际结果与证据写入完成记录；同步必要契约、使用说明和本批状态，不因源码存在或受控模型响应而虚报完成。

## 需求与规格

- [asset-data-ui.md](../../../../../tasks/spec-v0.3a/asset-data-ui.md)

故事范围：A.US-004。逐项覆盖见[覆盖表](../../coverage.md)。

- A.US-004.AC-01 → A-T004-01：模型请求包含固定类型、属性、关系、单位和支持规则约束；受控服务检查实际请求内容。
- A.US-004.AC-02 → A-T004-02：保留原始／规范值和来源；精确数量不先转有损 Number，未知字段和关系端点进入待确认。
- A.FR-7 → A-F07：系统必须让实例抽取请求获得固定行业 Schema。
- P.US-008.AC-01 → P-T008-01：抽取请求使用固定版本的类型、属性、关系、单位和规则约束；不得仅在响应之后才做 Schema 校验。
- P.US-008.AC-02 → P-T008-02：属性保留原始值、规范值与来源位置，数量和尺寸不得先经有损浮点转换。
- P.US-008.AC-03 → P-T008-03：未知字段或无法确认的关系端点进入待处理，不由模型自行发布。
- P.FR-12 → P-F12：系统必须让抽取请求获得当前固定版本的行业约束。

## 验证方法

- 在 platform/ 运行受影响行为测试、pnpm run typecheck；相应包的 lint 与 pnpm run boundaries 适用时必须通过。
- 测试期望来自固定需求和独立样例，负例必须保持阻断；计划 ID 不是测试已通过。

## 失败与边界

- 保留已有 WIP、旧 Issue 和 loop 状态；不整枝合并未完成研发，不自动 stash/reset 或覆盖工作区。
- 授权来自可信上下文，行业包、输入/结果 refs、缓存、任务及导出均保持客户/项目隔离。
- 不跳过失败/未知/不完整、不静默删规则或漏行、不用模型概率代替硬核验。
- 本卡不默认授权对外发送报价、调用未授权服务或复制客户资料；所需真实资源按进入条件取得。

## 完成记录

- 当前：已实现，验证已运行。GitHub Issue：[#179](https://github.com/Yijtu/ontology/issues/179)。
- 分支：`feat/v03-007-schema-extraction`（合入基线 `feat/v03-assistants-core`）。
- 满足的验收：
  - A.US-004.AC-01／A-T004-01／A.FR-7／P.US-008.AC-01／P.FR-12：`buildSchemaContext` 把固定对象/属性类型、cardinality、单位、enum、关系端点、identityScope、已发布 ruleConstraints 与冻结规则语法/上限和 exact-decimal 规则，序列化为 canonical `extraction-schema-context@1` 工件并注入 system 消息；`ExtractionInputVersion.promptVersion/schemaDigest` 随候选记录。受控公司 HTTP 服务断言实际收到该内容（`tests/unit/extraction-adapter-accounting.spec.ts`）。
  - A.US-004.AC-02／P.US-008.AC-02：`CandidateAttributeValue` 保留 `value`（quantity 为 exact `DecimalString`）＋`raw`＋`decimal`＋`unitCode`；校验拒绝非规范十进制（`INVALID_DECIMAL`），数量不先经有损 `Number`。
  - P.US-008.AC-03：未知字段（`UNKNOWN_ATTRIBUTE`）与命名但未识别的关系端点（`UNRESOLVED_ENDPOINT`）进入 `pending_review`，不自动发布；伪造的越界引用仍为硬 `DANGLING_REFERENCE`。
  - V03-006 NEW_WORK：新增结构化 `parsed → extracted` 处理器与 `ParsedStageDispatcher`，消费 `StructuredExtractionRef.parseId`＋`document_structured_records`，按 locator 从不可变原文回读单元格并批量写入带 `StructuredCandidateSourceSpan` 的候选；结构化 job 继续复用确定性 `extracted → validated → awaiting_review` 链。
- 验证命令与结果（`platform/`）：
  - `pnpm run typecheck` → 0
  - `pnpm run lint` → 0
  - `pnpm run boundaries` → 8 passed
  - `pnpm exec vitest run tests/unit` → 113 files / 1301 tests passed
  - `pnpm exec vitest run tests/integration/structured-extraction-postgres.spec.ts` → 1 passed（真实 PostgreSQL＋blob，含 exact decimal、structured locator、job 到 `awaiting_review`）
  - `tests/integration/{extraction-postgres,structured-ingestion-postgres,ingestion-pipeline-postgres}` → 17 passed
  - `tests/integration/{identity-recall,identity-decisions,rule-extraction,semantic-publications,publication-fence}-postgres` → 27 passed
- 迁移与兼容：新增 `migrations/control/060_structured_extraction_candidates.sql`，仅解除 `extraction_candidates.parse_id` 对文本 `document_parse_runs` 的单列 FK 并加索引，使结构化 parse id 可落库；job FK、idempotency 唯一约束与 RLS 不变，parse 绑定仍由 `input_version.parseId`＋locator span 显式表达（详见迁移注释）。
- 范围说明：为使 `CandidateSourceSpan` 判别联合通过类型检查，同步了 `apps/api/src/http/decisions.ts` 的只读候选来源读取（新增 `structured` 状态分支）；未改动 `apps/web`。
- 未验证/外部条件：未调用真实模型；真实模型抽取质量按 SPEC §7.3 单独评测，本卡不声明。
