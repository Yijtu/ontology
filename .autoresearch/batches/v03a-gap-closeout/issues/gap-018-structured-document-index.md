# GAP-018 · 把结构化导入接入项目文档索引

Batch: v03a-gap-closeout
Target: main
Priority: P1
Type: backend

## Scope

- `platform/apps/api/src/composition/core-structured-import-service.ts（从装配根抽出新增叶模块）`
- `platform/packages/adapters/extraction-document/src/structured/（文档投影桥）`
- `platform/packages/adapters/search-bm25/src/（结构化 membership 桥）`
- `platform/tests/integration/project-document-index-postgres.spec.ts`

## Acceptance

- [ ] 正常 structured import 将可授权解析投影注册到 ProjectDocumentIndexService，同一 project/documentSet/原文摘要与结构化 parse/cell 来源保持一致。
- [ ] 建立有限表头/行文本索引并保留表格定位与近似精度，覆盖 CSV/XLSX；不能将全部原文/客户资料复制进行业包或公共 fixture。
- [ ] 索引 ready 与确认事实 ready 独立且可见，撤回先 fence 后更新；迟到构建不能复活已撤回资料，document_qa 固定运行文档集合。
- [ ] 真实 PG/BM25 正常导入→索引→任务问答→单元格来源闭环，覆盖版本替换、跨项目、截断、失败重试与取消。

## Dependencies

GAP-001, GAP-010

## Scope boundary

不与 #10 共同修改 mapping/事实逻辑；装配根唯一逻辑改动由 #19 统一完成。

## Evidence at 43525be

- `apps/api/src/composition/core-local-composition.ts:2230`
- `apps/api/src/composition/core-local-composition.ts:1651`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #268

Dependencies: #251 (GAP-001), #260 (GAP-010)
