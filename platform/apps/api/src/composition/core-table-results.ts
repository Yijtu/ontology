import { createHash } from 'node:crypto'
import { answerDraftContentHash, canonicalJson, resolveJsonPointer, typedResultManifestContentDigest } from '@ontology/application'
import type { TableHardVerificationService, TypedResultContextSourceDependencies, VerificationArtifactStore } from '@ontology/application'
import { MAX_TABLE_COLUMNS, MAX_TABLE_PAGE_ROWS, MAX_TABLE_RESULT_ROWS, assertTableArtifactManifestShape, assertTableArtifactPageBodyShape, assertTypedResultManifestShape, isRecord, isResourceRef, isTaskFinalizationReceipt, isToolContext, sha256OfCanonical, tableArtifactContentDigest, tableManifestContentDigest, tablePageCoverageDigest } from '@ontology/contracts'
import type { AnswerDraft, EvidenceStorePort, ImmutableArtifactWriter, PublicationTableVerificationRequirement, PublishedAnswer, ResourceRef, ScopeRef, Sha256Digest, TableArtifactManifest, TableArtifactManifestStore, TableArtifactPageBody, TableArtifactPageStore, TableArtifactRow, TableColumnDescriptor, TableHardVerificationOutcome, TableVerificationReceiptStore, TaskFinalizationReceiptStore, ToolContext, ToolCoverage, Uuid, VersionRef } from '@ontology/contracts'

export type CoreTableBuildInput = Parameters<NonNullable<TypedResultContextSourceDependencies['tables']>>[0]

export interface CoreTableResultsOptions {
  readonly evidence: Pick<EvidenceStorePort, 'get'>
  readonly artifacts: VerificationArtifactStore
  readonly writer: ImmutableArtifactWriter
  readonly pages: TableArtifactPageStore
  readonly manifests: TableArtifactManifestStore
  readonly receipts: TableVerificationReceiptStore
  readonly finalizationReceipts?: Pick<TaskFinalizationReceiptStore, 'getReceipt'>
  /** Display-only names from this run's fixed published definition and original CIDs. */
  readonly columnLabels?: (input: CoreTableBuildInput, ctx: ToolContext) => Promise<Readonly<Record<string,string>>>
  readonly verifier: Pick<TableHardVerificationService, 'verifyTable'>
  /** Actual archived canonical tools schema, independent from the outer result-format token. */
  readonly tableOutputSchema: { readonly ref: ResourceRef; readonly body: Readonly<Record<string, unknown>> }
  /** Exact scoped lookup of a real previously archived artifact, never a hash-only ref. */
  readonly findArtifact: (scope: ScopeRef, digest: Sha256Digest, ctx: ToolContext) => Promise<ResourceRef | undefined>
}

export class CoreTableResultError extends Error {
  readonly code: 'INVALID_RESULT' | 'TABLE_UNVERIFIED' | 'REGISTRATION_CONFLICT'
  constructor(code: CoreTableResultError['code'], message: string) {
    super(message)
    this.name = 'CoreTableResultError'
    this.code = code
  }
}

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)
const digestBytes = (bytes: Uint8Array): Sha256Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const invalid = (message: string): never => { throw new CoreTableResultError('INVALID_RESULT', message) }

function scopeFor(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId || Date.now() >= Date.parse(ctx.deadline)) invalid('formal tables require a live trusted scoped context')
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

interface SavedColumn { readonly name: string; readonly type: string; readonly semanticFieldRef?: string; readonly unit?: string }

function columnsOf(value: unknown): readonly SavedColumn[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TABLE_COLUMNS + 2) return invalid('the archived query column set is missing or exceeds table bounds')
  const names = new Set<string>()
  return value.map((column: unknown) => {
    if (!isRecord(column) || typeof column['name'] !== 'string' || column['name'].length === 0 || names.has(column['name']) || typeof column['type'] !== 'string') return invalid('the archived query has an invalid or duplicate column')
    names.add(column['name'])
    const field = column['semanticFieldRef'], unit = column['unit']
    if ((field !== undefined && (typeof field !== 'string' || field.length === 0)) || (unit !== undefined && (typeof unit !== 'string' || unit.length === 0))) return invalid('the archived semantic field or unit is malformed')
    return { name: column['name'], type: column['type'], ...(typeof field === 'string' ? { semanticFieldRef: field } : {}), ...(typeof unit === 'string' ? { unit } : {}) }
  })
}

function coverageOf(value: unknown, rows: number): ToolCoverage {
  if (!isRecord(value) || value['returned'] !== rows || typeof value['truncated'] !== 'boolean') return invalid('the query has no matching archived coverage')
  const completeness = value['completeness']
  if (completeness !== undefined && completeness !== 'complete' && completeness !== 'partial' && completeness !== 'truncated' && completeness !== 'unknown') return invalid('the archived query completeness is unsupported')
  return { returned: rows, truncated: value['truncated'], ...(completeness === undefined ? {} : { completeness }) }
}

function descriptorOf(column: SavedColumn, index: number): TableColumnDescriptor {
  if (column.semanticFieldRef === undefined) return invalid('a formal query column must carry its actual semantic field')
  const base = { columnRef: `field.${index}`, semanticPredicate: column.semanticFieldRef, schemaPointer: '/$defs/TableData/properties/rows/items/items', displayLabel: column.name }
  if (column.type === 'decimal' || column.type === 'integer') return { ...base, valueType: column.unit === undefined ? 'decimal' : 'quantity', ...(column.unit === undefined ? {} : { requiredContextPointers: ['unitPointer'] }) }
  if (column.unit !== undefined) return invalid('a unit may only qualify an exact numeric query column')
  if (column.type === 'boolean') return { ...base, valueType: 'boolean' }
  if (column.type === 'string' || column.type === 'timestamp') return { ...base, valueType: 'string' }
  return invalid('this archived query column type has no supported formal cell representation')
}

function cellOf(value: unknown, column: SavedColumn): unknown {
  if (column.type === 'decimal' || column.type === 'integer') {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return invalid('formal numeric query values must be exact decimal strings')
    return column.unit === undefined ? value : { value, unit: column.unit }
  }
  if ((column.type === 'boolean' && typeof value !== 'boolean') || ((column.type === 'string' || column.type === 'timestamp') && typeof value !== 'string')) return invalid('the archived query value does not match its declared type')
  return value
}

/** Host bridge from archived query evidence to immutable pages, earned verification and publication. */
export function createCoreTableResults(options: CoreTableResultsOptions) {
  const read = async (ref: ResourceRef, ctx: ToolContext): Promise<unknown> => {
    const scope = scopeFor(ctx)
    if (ref.kind !== 'artifact' || !(await options.artifacts.getAuthorized({ scopeRef: scope, blobRef: ref }, ctx)).integrityVerified) return invalid('the actual table artifact is unavailable or unverified')
    const bytes = await options.artifacts.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
    if (digestBytes(bytes) !== ref.digest) return invalid('the actual table artifact bytes changed')
    scopeFor(ctx)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  }
  const find = async (digest: Sha256Digest, ctx: ToolContext): Promise<ResourceRef | undefined> => {
    const ref = await options.findArtifact(scopeFor(ctx), digest, ctx)
    if (ref !== undefined && (!isResourceRef(ref) || ref.kind !== 'artifact' || ref.digest !== digest)) return invalid('the artifact lookup did not retain the full actual digest pin')
    return ref
  }
  const archive = async (body: unknown, digest: Sha256Digest, ctx: ToolContext): Promise<ResourceRef> => {
    const existing = await find(digest, ctx)
    const ref = existing ?? (await options.writer.putBytes({ scopeRef: scopeFor(ctx), mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson(body)) }, ctx)).blobRef
    if (ref.digest !== digest || !same(await read(ref, ctx), body)) return invalid('the archived table body does not match its actual ref')
    return ref
  }
  const tableRef = async (table: TableArtifactManifest, ctx: ToolContext): Promise<ResourceRef> => {
    const digest = tableManifestContentDigest(table), ref = await find(digest, ctx)
    if (ref === undefined || !same(await read(ref, ctx), table)) return invalid('the draft table has no actual saved manifest body')
    return ref
  }
  const tableSchema = async (ctx: ToolContext): Promise<VersionRef> => {
    const { ref, body } = options.tableOutputSchema
    if (!same(await read(ref, ctx), body) || !resolveJsonPointer(body, '/$defs/TableData/properties/rows/items/items').found) return invalid('the actual stored table output schema or cell shape is unavailable')
    return { id: ref.id, version: ref.version, digest: ref.digest }
  }
  const tablesFor = async (draft: AnswerDraft, ctx: ToolContext): Promise<readonly TableArtifactManifest[]> => {
    if (draft.schemaVersion !== 'answer-draft@3') return []
    if (draft.runId !== ctx.runId || draft.resultManifestRef === undefined || draft.resultManifestDigest === undefined || draft.finalizationReceiptRef === undefined || draft.finalizationReceiptDigest === undefined || draft.executionBindingRef === undefined) return invalid('the formal draft bindings are incomplete')
    const contentHash = answerDraftContentHash(draft.runId, draft.blocks, draft.evidenceManifestHash, draft.claims ?? [], draft.assertions ?? [], { schemaVersion: 'answer-draft@3', limitations: draft.limitations, resultManifestRef: draft.resultManifestRef, resultManifestDigest: draft.resultManifestDigest, finalizationReceiptRef: draft.finalizationReceiptRef, finalizationReceiptDigest: draft.finalizationReceiptDigest, executionBindingRef: draft.executionBindingRef })
    if (contentHash !== draft.contentHash) return invalid('the table draft content hash does not recompute')
    const manifest = await read(draft.resultManifestRef, ctx)
    assertTypedResultManifestShape(manifest)
    if (typedResultManifestContentDigest(manifest) !== draft.resultManifestDigest || draft.resultManifestRef.digest !== draft.resultManifestDigest || !same(manifest.executionBindingRef, draft.executionBindingRef)) return invalid('the outer typed result manifest does not match the exact draft')
    if (new Set(manifest.tables.map((table) => table.tableId)).size !== manifest.tables.length) return invalid('the result repeats a formal table identity')
    if (manifest.tables.length > 0) {
      const schema = await tableSchema(ctx)
      if (manifest.tables.some((table) => !same(table.outputSchemaRef, schema))) return invalid('the table schema differs from its actual registered schema body')
      const actualFinalization = await options.finalizationReceipts?.getReceipt(scopeFor(ctx),draft.finalizationReceiptRef,ctx)
      if (options.finalizationReceipts !== undefined && (actualFinalization === undefined || !same(actualFinalization.ref,draft.finalizationReceiptRef) || sha256OfCanonical(actualFinalization.receipt) !== draft.finalizationReceiptDigest)) return invalid('the actual scoped finalization ledger entry does not match this exact draft receipt')
      const receipt = options.finalizationReceipts === undefined ? await read(draft.finalizationReceiptRef, ctx) : actualFinalization?.receipt
      if (!isTaskFinalizationReceipt(receipt) || draft.finalizationReceiptRef.digest !== draft.finalizationReceiptDigest || !same(receipt.executionBindingRef, manifest.executionBindingRef) || !same(receipt.taskBindingRef, manifest.taskBindingRef) || !same(receipt.inputSnapshotRef, manifest.inputSnapshotRef) || receipt.inputSnapshotDigest !== manifest.inputSnapshotRef.digest || !same(receipt.typedResultManifestRef, draft.resultManifestRef) || receipt.typedResultManifestDigest !== draft.resultManifestDigest || receipt.outputArtifactRefs.length !== receipt.outputDigests.length || receipt.outputArtifactRefs.some((ref, index) => ref.digest !== receipt.outputDigests[index])) return invalid('the tables do not retain the actual task finalization output pins')
      const checkedEvidence = new Set<string>()
      for (const table of manifest.tables) for (const descriptor of table.pages) {
        const page = await options.pages.getPage(scopeFor(ctx), descriptor.artifactRef, ctx)
        if (page === undefined || tableArtifactContentDigest(page.body) !== descriptor.artifactDigest || descriptor.artifactRef.digest !== descriptor.artifactDigest || !same(page.body.outputSchemaRef, table.outputSchemaRef)) return invalid('a saved formal table page no longer matches its exact artifact or schema pin')
        for (const row of page.body.rows) for (const binding of row.bindings) {
          const key = canonicalJson({ ref: binding.evidenceRef, digest: binding.resultDigest })
          if (checkedEvidence.has(key)) continue
          const record = await options.evidence.get(scopeFor(ctx), binding.evidenceRef.id, ctx)
          if (record === undefined || !same(record.evidenceRef, binding.evidenceRef) || record.envelope.producedBy.runId !== draft.runId || !same(record.envelope.scopeRef, scopeFor(ctx)) || record.envelope.resultDigest !== binding.resultDigest || !receipt.outputArtifactRefs.some((ref) => same(ref, record.envelope.payloadRef))) return invalid('a table cell references evidence outside this exact run finalization')
          checkedEvidence.add(key)
        }
      }
    }
    return manifest.tables
  }
  const earned = async (draft: AnswerDraft, table: TableArtifactManifest, ctx: ToolContext): Promise<PublicationTableVerificationRequirement> => {
    const ref = await tableRef(table, ctx)
    const saved = await options.receipts.findReceipt?.(scopeFor(ctx), { resultManifestRef: ref, draftHash: draft.contentHash, tableId: table.tableId }, ctx)
    let actual = saved === undefined ? undefined : await options.receipts.getReceipt(scopeFor(ctx), saved.ref, ctx)
    const receipt = actual?.receipt
    if (actual === undefined || receipt === undefined || !same(actual, saved) || receipt.draftHash !== draft.contentHash || !same(receipt.resultManifestRef, ref) || receipt.resultManifestDigest !== tableManifestContentDigest(table) || receipt.tableId !== table.tableId || receipt.checkedRows !== table.totalRows || receipt.expectedRows !== table.totalRows || receipt.checkedCells !== table.totalRows * table.columns.length || receipt.expectedCells !== receipt.checkedCells || !same(receipt.pageDigests, table.pages.map((page) => page.artifactDigest))) throw new CoreTableResultError('TABLE_UNVERIFIED', 'the exact complete table has no earned receipt for this draft')
    const registered = await options.manifests.getManifest(scopeFor(ctx), ref, ctx)
    if (registered !== undefined) {
      const prior = registered.verificationReceiptRef === undefined ? undefined : await options.receipts.getReceipt(scopeFor(ctx), registered.verificationReceiptRef, ctx)
      if (!same(registered.manifest, table) || prior === undefined || !same(prior.receipt, receipt)) throw new CoreTableResultError('REGISTRATION_CONFLICT', 'the existing table registration has a different immutable verification body')
      actual = prior
    }
    scopeFor(ctx)
    return { draftHash: draft.contentHash, resultManifestRef: ref, resultManifestDigest: receipt.resultManifestDigest, tableId: table.tableId, receiptRef: actual.ref }
  }
  const requirements = async (draft: AnswerDraft, ctx: ToolContext): Promise<readonly PublicationTableVerificationRequirement[]> => {
    const result: PublicationTableVerificationRequirement[] = []
    for (const table of await tablesFor(draft, ctx)) result.push(await earned(draft, table, ctx))
    scopeFor(ctx)
    return result
  }
  return {
    async build(input: CoreTableBuildInput, ctx: ToolContext): Promise<readonly TableArtifactManifest[]> {
      const scope = scopeFor(ctx)
      if (input.runId !== ctx.runId) return invalid('the query table belongs to another run')
      if (input.resultKind !== 'structured_query') return []
      const labels = await options.columnLabels?.(input,ctx)
      const outputSchemaRef = await tableSchema(ctx)
      const result: TableArtifactManifest[] = []
      for (const entry of input.evidence) {
        const record = await options.evidence.get(scope, entry.ref.id, ctx)
        if (record === undefined || !same(record.evidenceRef, entry.ref) || record.envelope.producedBy.runId !== input.runId || !same(record.envelope.scopeRef, scope) || record.envelope.kind !== 'observation' || record.envelope.resultDigest !== entry.resultDigest || !same(record.envelope.payloadRef, entry.outputRef)) return invalid('the query evidence is not the exact scoped run output')
        const payload = await read(entry.outputRef, ctx)
        if (digestBytes(new TextEncoder().encode(canonicalJson(payload))) !== entry.resultDigest) return invalid('the query result digest does not match its archived payload')
        if (!isRecord(payload) || payload['resultKind'] !== 'table') continue
        const table = payload['table']
        if (!isRecord(table) || !Array.isArray(table['rows']) || table['rows'].length > Math.min(MAX_TABLE_RESULT_ROWS, ctx.allowedResources.maxRows)) return invalid('the query table rows are missing or exceed the existing table or run policy')
        const columns = columnsOf(table['columns']), rows: readonly unknown[] = table['rows']
        const coverage = coverageOf(payload['coverage'], rows.length)
        if (rows.length === 0) continue
        const subjectIndex = columns.findIndex((column) => column.name === 'record_id')
        if (subjectIndex < 0 || !columns.some((column) => column.name === 'sources_json')) return invalid('the query did not archive real row identity and source lineage')
        const visible = columns.flatMap((column,index) => {
          if (column.name === 'record_id' || column.name === 'sources_json') return []
          const label = column.semanticFieldRef === undefined ? undefined : labels?.[column.semanticFieldRef]
          if (label !== undefined && (typeof label !== 'string' || label.length === 0 || label.length > 512)) return invalid('an actual saved semantic column label is malformed')
          return [{ column,index,descriptor: { ...descriptorOf(column,index),...(label === undefined ? {} : { displayLabel: label }) } }]
        })
        if (visible.length === 0 || visible.length > MAX_TABLE_COLUMNS) return invalid('the query has no bounded visible semantic column set')
        const tableId = `query.${sha256OfCanonical({ evidenceRef: entry.ref, outputRef: entry.outputRef, inputSnapshotRef: input.inputSnapshotRef, outputSchemaRef, resultFormatRef: input.outputSchemaRef }).slice(7)}`
        const boundRows: TableArtifactRow[] = rows.map((row: unknown, rowIndex) => {
          if (!Array.isArray(row) || row.length !== columns.length) return invalid('the query row width does not match its saved columns')
          const subject = row[subjectIndex]
          if (typeof subject !== 'string' || subject.length === 0) return invalid('the query row has no actual record identity')
          return { rowKey: subject, subject, cells: Object.fromEntries(visible.map(({ column, index, descriptor }) => [descriptor.columnRef, cellOf(row[index], column)])), bindings: visible.map(({ column, index, descriptor }) => ({ rowKey: subject, columnRef: descriptor.columnRef, evidenceRef: entry.ref, resultDigest: entry.resultDigest, valuePointer: `/table/rows/${rowIndex}/${index}`, subjectPointer: `/table/rows/${rowIndex}/${subjectIndex}`, fieldRefPointer: `/table/columns/${index}`, ...(column.unit === undefined ? {} : { unitPointer: `/table/columns/${index}/unit` }) })) }
        }).sort((left, right) => left.rowKey < right.rowKey ? -1 : left.rowKey > right.rowKey ? 1 : 0)
        if (new Set(boundRows.map((row) => row.subject)).size !== boundRows.length) return invalid('the query repeats a row identity')
        const pages: TableArtifactManifest['pages'][number][] = []
        for (let offset = 0; offset < boundRows.length; offset += MAX_TABLE_PAGE_ROWS) {
          const pageRows = boundRows.slice(offset, offset + MAX_TABLE_PAGE_ROWS)
          const body: TableArtifactPageBody = { schemaVersion: 'table-artifact-page@1', tableId, outputSchemaRef, pageIndex: pages.length, columnRefs: visible.map((column) => column.descriptor.columnRef), rowKeyOrder: 'ascending', rows: pageRows, coverage: { returned: pageRows.length, truncated: coverage.truncated } }
          assertTableArtifactPageBodyShape(body)
          const ref = await archive(body, tableArtifactContentDigest(body), ctx)
          await options.pages.putPage(scope, ref, body, ctx)
          pages.push({ pageIndex: body.pageIndex, artifactRef: ref, artifactDigest: ref.digest, rowCount: pageRows.length, firstRowKey: pageRows[0]!.rowKey, lastRowKey: pageRows[pageRows.length - 1]!.rowKey, pageCoverageDigest: tablePageCoverageDigest(body) })
        }
        const manifest: TableArtifactManifest = { schemaVersion: 'table-artifact-manifest@1', tableId, outputSchemaRef, columns: visible.map((column) => column.descriptor), totalRows: boundRows.length, rowKeyOrder: 'ascending', pages, coverage, complete: !coverage.truncated && coverage.completeness === 'complete' }
        assertTableArtifactManifestShape(manifest)
        await archive(manifest, tableManifestContentDigest(manifest), ctx)
        result.push(manifest)
      }
      scopeFor(ctx)
      return result
    },
    async verify(draft: AnswerDraft, ctx: ToolContext): Promise<readonly TableHardVerificationOutcome[]> {
      const outcomes: TableHardVerificationOutcome[] = []
      for (const table of await tablesFor(draft, ctx)) {
        const ref = await tableRef(table, ctx)
        const outcome = await options.verifier.verifyTable({ resultManifestRef: ref, resultManifestDigest: tableManifestContentDigest(table), draftHash: draft.contentHash, tableId: table.tableId, manifest: table }, ctx)
        outcomes.push(outcome)
        if (outcome.status !== 'pass') throw new CoreTableResultError('TABLE_UNVERIFIED', `the complete table verification ${outcome.status}: ${outcome.report.findings.map((finding) => finding.code).join(', ')}`)
        await earned(draft, table, ctx)
      }
      scopeFor(ctx)
      return outcomes
    },
    requirements,
    async register(answer: PublishedAnswer, draft: AnswerDraft, ctx: ToolContext): Promise<Uuid> {
      if (answer.runId !== draft.runId || answer.draftId !== draft.draftId || answer.contentHash !== draft.contentHash || answer.v3Body?.resultManifestDigest !== draft.resultManifestDigest || !same(answer.v3Body?.resultManifestRef, draft.resultManifestRef)) return invalid('the allocated answer does not retain the verified draft table bindings')
      const tables = await tablesFor(draft, ctx), required = await requirements(draft, ctx)
      let owner: Uuid | undefined
      for (const requirement of required) {
        const existing = await options.manifests.getManifest(scopeFor(ctx), requirement.resultManifestRef, ctx)
        if (existing === undefined) continue
        const table = tables.find((candidate) => candidate.tableId === requirement.tableId)
        if (existing.answerId === undefined || table === undefined || !same(existing.manifest, table) || !same(existing.verificationReceiptRef, requirement.receiptRef) || (owner !== undefined && owner !== existing.answerId)) throw new CoreTableResultError('REGISTRATION_CONFLICT', 'an existing table registration belongs to another receipt, body or answer')
        owner = existing.answerId
      }
      const answerId = owner ?? answer.answerId
      for (const requirement of required) {
        const table = tables.find((candidate) => candidate.tableId === requirement.tableId)
        if (table === undefined) return invalid('the actual publication lost its table')
        await options.manifests.putManifest(scopeFor(ctx), answerId, requirement.resultManifestRef, table, requirement.receiptRef, ctx)
        const saved = await options.manifests.getManifest(scopeFor(ctx), requirement.resultManifestRef, ctx)
        if (saved?.answerId !== answerId || !same(saved.manifest, table) || !same(saved.verificationReceiptRef, requirement.receiptRef)) throw new CoreTableResultError('REGISTRATION_CONFLICT', 'the actual table registration did not read back with the same owner and earned receipt')
      }
      scopeFor(ctx)
      return answerId
    },
  }
}

export type CoreTableResults = ReturnType<typeof createCoreTableResults>
