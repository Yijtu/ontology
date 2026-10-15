import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createCoreTableResults } from '@ontology/app-api'
import { InMemoryTableArtifactStore, InMemoryTableVerificationStore, TableHardVerificationService, answerDraftContentHash, buildTypedResultManifest, canonicalJson, typedResultManifestContentDigest } from '@ontology/application'
import type { VerificationArtifactStore } from '@ontology/application'
import { createToolContext, sha256OfCanonical, tableArtifactContentDigest, tableManifestContentDigest, tablePageCoverageDigest } from '@ontology/contracts'
import type { AnswerDraft, ArchivedTableVerificationReceipt, EvidenceRecord, ImmutableArtifactWriter, PublishedAnswer, ResourceRef, TableArtifactManifest, TableArtifactPageBody } from '@ontology/contracts'

const hash = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function fixture(coverage: unknown = { returned: 251, truncated: false, completeness: 'complete' }) {
  const scope = { tenantId: randomUUID(), spaceId: randomUUID() }, runId = randomUUID(), now = new Date().toISOString(), deadline = new Date(Date.now() + 60_000).toISOString()
  const ctx = createToolContext({ principal: { tenantId: scope.tenantId, subjectId: 'table-owner', roles: ['operator'], scopes: [], authEpoch: 1 }, runId, resolvedProfileHash: sha256OfCanonical('profile'), policyVersion: '1.0.0', deadline,
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: now, expiresAt: deadline }, allowedResources: { ...scope, resourceKinds: ['artifact', 'evidence'], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 1000 }, traceId: randomUUID() })
  const bytes = new Map<string, Uint8Array>(), refs = new Map<string, ResourceRef>()
  const writer: ImmutableArtifactWriter = { putBytes: async (input) => {
    const digest = hash(input.content), ref: ResourceRef = { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' }
    bytes.set(ref.id, input.content); refs.set(digest, ref)
    return { blobRef: ref, contentDigest: digest, integrity: { algorithm: 'sha256', digest, verifiedAt: now } }
  } }
  const archive = async (body: unknown) => (await writer.putBytes({ scopeRef: scope, content: new TextEncoder().encode(canonicalJson(body)), mediaType: 'application/json' }, ctx)).blobRef
  const artifacts: VerificationArtifactStore = {
    getAuthorized: async (request) => { const value = bytes.get(request.blobRef.id); if (value === undefined) throw new Error('not found'); return { blobRef: request.blobRef, contentDigest: hash(value), byteSize: value.length, mediaType: 'application/json', integrityVerified: hash(value) === request.blobRef.digest } },
    readAuthorized: async (request) => { const value = bytes.get(request.blobRef.id); if (value === undefined) throw new Error('not found'); return value },
  }
  const payload = { resultKind: 'table', table: { columns: [{ name: 'record_id', type: 'string' }, { name: 'amount', type: 'decimal', semanticFieldRef: 'meter.energy', unit: 'kWh' }, { name: 'enabled', type: 'boolean', semanticFieldRef: 'meter.enabled' }, { name: 'sources_json', type: 'string' }],
    rows: Array.from({ length: 251 }, (_, index) => [`record-${String(250 - index).padStart(4, '0')}`, '9.000000000000000001', index % 2 === 0, '["original-input"]']) }, ...(coverage === 'omit' ? {} : { coverage }) }
  const outputRef = await archive(payload), evidenceRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: sha256OfCanonical('evidence'), kind: 'evidence' }
  const record: EvidenceRecord = { evidenceRef, revision: '1', envelopeDigest: sha256OfCanonical('envelope'), recordedAt: now,
    envelope: { evidenceId: evidenceRef.id, kind: 'observation', scopeRef: scope, producedBy: { componentRef: { id: 'tool-gateway', version: '1.0.0', digest: sha256OfCanonical('gateway') }, runId }, observedAt: now, resultDigest: outputRef.digest, sourceSnapshots: [], dependencies: [], dataMode: 'observed', payloadRef: outputRef, integrity: { algorithm: 'sha256', digest: sha256OfCanonical('envelope'), verifiedAt: now } } }
  const evidence = { get: async (_scope: unknown, id: string) => id === evidenceRef.id ? record : undefined }
  const pages = new InMemoryTableArtifactStore(), receipts = new InMemoryTableVerificationStore(), earned: ArchivedTableVerificationReceipt[] = []
  const receiptPort = { getReceipt: receipts.getReceipt.bind(receipts), putReceipt: async (...args: Parameters<typeof receipts.putReceipt>) => { await receipts.putReceipt(...args); earned.push({ ref: args[1], receipt: args[2] }) } }
  const verifier = new TableHardVerificationService({ pages, receipts: receiptPort, progress: receipts, artifacts, evidence: { ...evidence, record: async () => record, listByRun: async () => [record] } })
  const schemaBody = { $defs: { TableData: { properties: { rows: { items: { items: {} } } } } } }, schemaRef = await archive(schemaBody)
  const bridge = createCoreTableResults({ pages, receipts, manifests: pages, verifier, artifacts, evidence, writer,
    tableOutputSchema: { ref: schemaRef, body: schemaBody }, findArtifact: async (_scope, digest) => refs.get(digest) })
  const executionBindingRef = await archive({ schemaVersion: 'unit-execution-input', runId }), inputSnapshotRef = await archive({ schemaVersion: 'unit-input', runId })
  const outputSchemaRef = { id: 'typed-result-manifest', version: '1.0.0', digest: sha256OfCanonical('format') }, taskBindingRef = { id: 'structured-query', version: '1.0.0', digest: sha256OfCanonical('task') }
  const buildInput = { runId, executionBindingRef, inputSnapshotRef, outputSchemaRef, taskBindingRef, resultKind: 'structured_query' as const, evidence: [{ ref: evidenceRef, outputRef, resultDigest: outputRef.digest }] }
  const draftFor = async (tables: readonly TableArtifactManifest[]): Promise<AnswerDraft> => {
    const manifest = buildTypedResultManifest({ executionBindingRef, inputSnapshotRef, outputSchemaRef, taskBindingRef, resultKind: 'structured_query', tables, outputDigest: outputRef.digest, evidence: [] })
    const resultManifestRef = await archive(manifest), parametersRef = await archive({})
    const finalizationReceiptRef = await archive({ schemaVersion: 'task-finalization-receipt@1', executionBindingRef, taskBindingRef, inputSnapshotRef, inputSnapshotDigest: inputSnapshotRef.digest, parametersRef, parametersDigest: parametersRef.digest, outputArtifactRefs: [outputRef], outputDigests: [outputRef.digest], typedResultManifestRef: resultManifestRef, typedResultManifestDigest: resultManifestRef.digest, requiredPolicyBindings: [], policyReportRefs: [] })
    const body = { schemaVersion: 'answer-draft@3' as const, limitations: [], resultManifestRef, resultManifestDigest: typedResultManifestContentDigest(manifest), finalizationReceiptRef, finalizationReceiptDigest: finalizationReceiptRef.digest, executionBindingRef }
    return { ...body, draftId: randomUUID(), runId, blocks: [{ text: '真实查询表' }], claims: [], assertions: [], evidenceManifestHash: evidenceRef.digest, contentHash: answerDraftContentHash(runId, [{ text: '真实查询表' }], evidenceRef.digest, [], [], body), producedInPhase: 'drafting', createdAt: now }
  }
  const replaceLastPage = async (table: TableArtifactManifest, mutate: (body: TableArtifactPageBody) => TableArtifactPageBody) => {
    const last = table.pages.at(-1); if (last === undefined) throw new Error('missing page')
    const page = await pages.getPage(scope, last.artifactRef, ctx); if (page === undefined) throw new Error('missing saved page')
    const body = mutate(structuredClone(page.body)), ref = await archive(body)
    expect(ref.digest).toBe(tableArtifactContentDigest(body))
    await pages.putPage(scope, ref, body, ctx)
    const changed = { ...table, pages: [...table.pages.slice(0, -1), { ...last, artifactRef: ref, artifactDigest: ref.digest, pageCoverageDigest: tablePageCoverageDigest(body) }] }
    await archive(changed)
    return changed
  }
  return { bridge, ctx, scope, archive, buildInput, pages, receipts, earned, draftFor, replaceLastPage }
}

describe('actual table producer bindings and hard-verification bridge', () => {
  it('keeps exact saved row pointers across sorting/pages, earns receipts for the real draft and preserves an existing owner on retry', async () => {
    const f = await fixture(), tables = await f.bridge.build(f.buildInput, f.ctx), table = tables[0]
    expect(table?.pages.map((page) => page.rowCount)).toEqual([250, 1])
    if (table === undefined) throw new Error('no table')
    expect(table.columns.map((column) => column.semanticPredicate)).toEqual(['meter.energy', 'meter.enabled'])
    const first = await f.pages.getPage(f.scope, table.pages[0]!.artifactRef, f.ctx)
    expect(first?.body.rows[0]?.bindings[0]).toMatchObject({ valuePointer: '/table/rows/250/1', subjectPointer: '/table/rows/250/0', fieldRefPointer: '/table/columns/1', unitPointer: '/table/columns/1/unit' })
    expect(first?.body.rows[0]?.cells['field.1']).toEqual({ value: '9.000000000000000001', unit: 'kWh' })
    const draft = await f.draftFor(tables)
    await expect(f.bridge.requirements(draft, f.ctx)).rejects.toMatchObject({ code: 'TABLE_UNVERIFIED' })
    const outcomes = await f.bridge.verify(draft, f.ctx)
    expect(outcomes[0]?.status).toBe('pass')
    expect(f.earned[0]?.receipt).toMatchObject({ draftHash: draft.contentHash, checkedRows: 251, expectedRows: 251, checkedCells: 502, expectedCells: 502 })
    const requirements = await f.bridge.requirements(draft, f.ctx)
    expect(requirements[0]?.resultManifestDigest).toBe(tableManifestContentDigest(table))
    expect(requirements[0]?.resultManifestDigest).not.toBe(draft.resultManifestDigest)
    const answer: PublishedAnswer = { answerId: randomUUID(), runId: draft.runId, draftId: draft.draftId, verificationId: randomUUID(), contentHash: draft.contentHash, evidenceManifestHash: draft.evidenceManifestHash, scenarioManifestHash: sha256OfCanonical('scenario'), publicationKind: 'verified', limitations: [], publishedAt: new Date().toISOString(), v3Body: { schemaVersion: 'answer-draft@3', resultManifestRef: draft.resultManifestRef!, resultManifestDigest: draft.resultManifestDigest!, finalizationReceiptRef: draft.finalizationReceiptRef!, finalizationReceiptDigest: draft.finalizationReceiptDigest!, executionBindingRef: draft.executionBindingRef!, blocks: draft.blocks, claims: [], assertions: [], limitations: [] } }
    expect(await f.bridge.register(answer, draft, f.ctx)).toBe(answer.answerId)
    const originalReceipt = f.earned[0]
    if (originalReceipt === undefined) throw new Error('no earned receipt')
    await f.receipts.putReceipt(f.scope, { ...originalReceipt.ref, id: '00000000-0000-4000-8000-000000000001' }, originalReceipt.receipt, f.ctx)
    expect((await f.bridge.requirements(draft, f.ctx))[0]?.receiptRef).toEqual(originalReceipt.ref)
    expect(await f.bridge.register({ ...answer, answerId: randomUUID() }, draft, f.ctx)).toBe(answer.answerId)
  })

  it.each(['value', 'unit', 'row', 'source'] as const)('refuses a correctly rehashed later-page %s mutation without an earned receipt', async (kind) => {
    const f = await fixture(), table = (await f.bridge.build(f.buildInput, f.ctx))[0]
    if (table === undefined) throw new Error('no table')
    const changed = await f.replaceLastPage(table, (body) => ({ ...body, rows: body.rows.map((row) => kind === 'value' ? { ...row, cells: { ...row.cells, 'field.1': { value: '10', unit: 'kWh' } } } : kind === 'unit' ? { ...row, cells: { ...row.cells, 'field.1': { value: '9.000000000000000001', unit: 'MWh' } } } : { ...row, bindings: row.bindings.map((binding) => kind === 'row' ? { ...binding, subjectPointer: '/table/rows/250/0' } : { ...binding, evidenceRef: { ...binding.evidenceRef, id: randomUUID() } }) }) }))
    const draft = await f.draftFor([changed])
    await expect(f.bridge.verify(draft, f.ctx)).rejects.toThrow(kind === 'value' ? 'value_mismatch' : kind === 'unit' ? 'unit_mismatch' : kind === 'row' ? 'cross_row_binding' : 'outside this exact run finalization')
    expect(f.earned).toHaveLength(0)
  })

  it('does not turn a truncated query into a complete formal table', async () => {
    const f = await fixture({ returned: 251, truncated: true, completeness: 'truncated' }), table = (await f.bridge.build(f.buildInput, f.ctx))[0]
    expect(table?.complete).toBe(false)
    if (table === undefined) throw new Error('no table')
    await expect(f.bridge.verify(await f.draftFor([table]), f.ctx)).rejects.toThrow('coverage_truncated')
    expect(f.earned).toHaveLength(0)
  })

  it('refuses legacy payloads without saved coverage and keeps explicit unknown coverage incomplete', async () => {
    const missing = await fixture('omit')
    await expect(missing.bridge.build(missing.buildInput, missing.ctx)).rejects.toThrow('no matching archived coverage')
    const unknown = await fixture({ returned: 251, truncated: false, completeness: 'unknown' })
    const tables = await unknown.bridge.build(unknown.buildInput, unknown.ctx)
    expect(tables[0]?.complete).toBe(false)
    await expect(unknown.bridge.verify(await unknown.draftFor(tables), unknown.ctx)).rejects.toThrow('manifest_incomplete')
    expect(unknown.earned).toHaveLength(0)
  })

  it('locates only the exact earned receipt, chooses a stable minimum actual id and refuses conflicting bodies', async () => {
    const f = await fixture(), tables = await f.bridge.build(f.buildInput, f.ctx), draft = await f.draftFor(tables)
    await f.bridge.verify(draft, f.ctx)
    const earned = f.earned[0]
    if (earned === undefined) throw new Error('no earned receipt')
    const input = { resultManifestRef: earned.receipt.resultManifestRef, draftHash: draft.contentHash, tableId: earned.receipt.tableId }
    const ref = { ...earned.ref, id: '00000000-0000-4000-8000-000000000001' }
    await f.receipts.putReceipt(f.scope, ref, earned.receipt, f.ctx)
    expect((await f.receipts.findReceipt(f.scope, input, f.ctx))?.ref.id).toBe(ref.id)
    expect(await f.receipts.findReceipt(f.scope, { ...input, draftHash: sha256OfCanonical('other draft') }, f.ctx)).toBeUndefined()
    const changed = { ...earned.receipt, checksDigest: sha256OfCanonical('forged check inventory') }
    await f.receipts.putReceipt(f.scope, { ...earned.ref, id: randomUUID(), digest: sha256OfCanonical(changed) }, changed, f.ctx)
    await expect(f.receipts.findReceipt(f.scope, input, f.ctx)).rejects.toThrow('conflicting immutable bodies')
  })
})
