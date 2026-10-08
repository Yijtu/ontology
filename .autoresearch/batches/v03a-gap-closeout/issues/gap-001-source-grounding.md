# GAP-001 · 读取原文片段与表头，提供有界生成上下文

Batch: v03a-gap-closeout
Target: main
Priority: P0
Type: backend

## Scope

- `platform/packages/contracts/src/source-grounding.ts（新增）`
- `platform/packages/application/src/assets/source-grounding/（新增）`
- `platform/packages/adapters/extraction-document/src/（来源读取适配）`
- `platform/tests/unit/source-grounding.spec.ts（新增）`

## Acceptance

- [ ] 按可信 tenant/space、workspace documentSet、sourceRef/version/digest 读取已批准资料，拒绝跨域、错摘要、未完成解析；不让请求 body 替代授权上下文。
- [ ] 复用现有文档解析、结构化解析和 CandidateSourceSpan，返回文本/PDF 片段、CSV/XLSX 表头与有限样例行及可回读定位；缺原文或不支持的媒体类型显式拒绝。
- [ ] 片段数、字节、输入 token、分页、取消有共同预算；超限返回明确 coverage/截断原因，禁止把读取失败变成空 Sources。
- [ ] 可验证 quote/row digest 与原文定位；覆盖来源指令注入、近似 OCR、空表、超限、跨租户和已撤回资料，提供装配工厂供 #19 注入。

## Dependencies

None

## Scope boundary

不修改 TBox 与规则候选生成逻辑；不新增通用检索平台。

## Evidence at 43525be

- `packages/application/src/assets/definition-candidates/service.ts:751`
- `packages/adapters/extraction-document/src/span-reader.ts:58`
- `packages/contracts/src/extraction.ts:118`

## Delivery

Implement → applicable checks → review-it → ship-it, isolated worktree. Production composition owner: GAP-019. Preserve existing workspaces and legacy manifests.

## GitHub mapping

Issue: #251

Dependencies: None
