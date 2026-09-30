import {
  DEFAULT_TABLE_HARD_VERIFICATION_POLICY,
  TABLE_VERIFICATION_RECEIPT_SCHEMA_VERSION,
  TABLE_VERIFICATION_PROGRESS_SCHEMA_VERSION,
  assertTableHardVerificationReportShape,
  assertTableVerificationProgressShape,
  isToolContext,
  sha256OfCanonical,
  tableArtifactContentDigest,
  tableManifestContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  EvidenceRecord,
  EvidenceStorePort,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  TableArtifactManifest,
  TableArtifactPage,
  TableArtifactPageBody,
  TableArtifactPageStore,
  TableArtifactRow,
  TableCellBinding,
  TableColumnDescriptor,
  TableHardVerificationFinding,
  TableHardVerificationOutcome,
  TableHardVerificationPolicy,
  TableHardVerificationReport,
  TableHardVerificationRequest,
  TableVerificationBatchRecord,
  TableVerificationProgress,
  TableVerificationProgressStore,
  TableVerificationReceipt,
  TableVerificationReceiptStore,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalDecimal, numericText, resolveJsonPointer } from '../verification'
import type { VerificationArtifactStore } from '../verification'

/**
 * Batched full-table hard verification (SPEC v0.3a execution-evidence §EX-7.1, §5.1 step 4,
 * issue V03-033 / #204).
 *
 * The formal table is a set of immutable page artifacts bound together by a manifest. This
 * service re-reads every declared row — not one page, not the first row of every page — and
 * proves the value/unit/currency/subject/time of each cell against the exact archived evidence
 * the binding points at, while reconciling the global page set, row order, row identities and
 * totals. A wrong amount, a swapped row, a missing row, a tampered manifest, a truncated page
 * or a wrong rule judgement blocks the whole table: a `fail`/`incomplete` outcome never yields
 * a receipt, and publication validity re-checks that the receipt exists.
 *
 * Two properties are load-bearing and encoded here:
 *
 *  - **Exactness.** Numeric cells are compared as exact decimals (never through IEEE-754).
 *    A non-integer JSON number is refused as `precision_unsupported` rather than silently
 *    re-printed to a substring of its binary approximation.
 *  - **Bounded batches.** Rows are checked in `maxRowsPerBatch` batches that share the run
 *    deadline and the policy row/cell limits. Progress is persisted after each batch so an
 *    interrupted verification resumes without skipping a row or weakening a later check.
 */
export interface TableHardVerificationDependencies {
  readonly pages: TableArtifactPageStore
  readonly evidence: EvidenceStorePort
  readonly artifacts: VerificationArtifactStore
  readonly policy?: TableHardVerificationPolicy
  readonly receipts?: TableVerificationReceiptStore
  readonly progress?: TableVerificationProgressStore
  readonly now?: () => Rfc3339UtcTimestamp
  readonly newId?: () => Uuid
}

interface ResolvedEvidence {
  readonly record: EvidenceRecord
  readonly payload?: unknown
  readonly unreadable: boolean
}

interface RowContext {
  readonly manifest: TableArtifactManifest
  readonly descriptorIndex: number
  readonly body: TableArtifactPageBody
  readonly row: TableArtifactRow
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new Error('a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new Error('the trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The row index of a `/table/rows/<row>/...` pointer, or undefined for another shape. */
function tableRowIndex(pointer: string): number | undefined {
  const parts = pointer.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (parts.length < 4 || parts[0] !== 'table' || parts[1] !== 'rows') return undefined
  if (!/^(0|[1-9]\d*)$/u.test(parts[2] ?? '')) return undefined
  const row = Number(parts[2])
  return Number.isSafeInteger(row) ? row : undefined
}

/** The `/table/columns/<column>` pointer that owns a `/table/rows/<row>/<column>` value. */
function tableColumnPointer(pointer: string): string | undefined {
  const parts = pointer.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (parts.length < 4 || parts[0] !== 'table' || parts[1] !== 'rows') return undefined
  if (!/^(0|[1-9]\d*)$/u.test(parts[2] ?? '') || !/^(0|[1-9]\d*)$/u.test(parts[3] ?? '')) return undefined
  return `/table/columns/${parts[3]}`
}

/** A numeric cell must be an exact string; a non-integer number cannot be trusted losslessly. */
function exactNumericCell(value: unknown): { readonly text: string | undefined; readonly lossy: boolean } {
  if (typeof value === 'string') {
    const text = canonicalDecimal(value)
    return { text, lossy: text === undefined }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isSafeInteger(value)) return { text: undefined, lossy: true }
    return { text: canonicalDecimal(String(value)), lossy: false }
  }
  return { text: undefined, lossy: false }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function shaOf(value: unknown): Sha256Digest {
  return sha256OfCanonical(value)
}

function sorter(left: { readonly code: string }, right: { readonly code: string }): number {
  return left.code.localeCompare(right.code)
}

export class TableHardVerificationService {
  readonly #pages: TableArtifactPageStore
  readonly #evidence: EvidenceStorePort
  readonly #artifacts: VerificationArtifactStore
  readonly #policy: TableHardVerificationPolicy
  readonly #receipts: TableVerificationReceiptStore | undefined
  readonly #progress: TableVerificationProgressStore | undefined
  readonly #now: () => Rfc3339UtcTimestamp
  readonly #newId: () => Uuid

  constructor(dependencies: TableHardVerificationDependencies) {
    this.#pages = dependencies.pages
    this.#evidence = dependencies.evidence
    this.#artifacts = dependencies.artifacts
    this.#policy = dependencies.policy ?? DEFAULT_TABLE_HARD_VERIFICATION_POLICY
    this.#receipts = dependencies.receipts
    this.#progress = dependencies.progress
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async verifyTable(
    request: TableHardVerificationRequest,
    ctx: ToolContext,
  ): Promise<TableHardVerificationOutcome> {
    const scopeRef = scopeOf(ctx)
    const findings: TableHardVerificationFinding[] = []
    const tableId = request.tableId

    // A tampered manifest never matches its own ref digest, so it is refused before any page
    // is read; this is the only place the manifest body is trusted at all.
    if (tableManifestContentDigest(request.manifest) !== request.resultManifestDigest) {
      findings.push({ code: 'manifest_digest_mismatch', tableId })
    }
    const manifest = request.manifest
    if (manifest.tableId !== tableId) {
      findings.push({ code: 'page_descriptor_mismatch', tableId, expected: tableId, actual: manifest.tableId })
    }
    if (manifest.complete !== true) {
      findings.push({ code: 'manifest_incomplete', tableId })
    }
    if (manifest.coverage.truncated) {
      findings.push({ code: 'coverage_truncated', tableId })
    }
    if (manifest.columns.length === 0 || manifest.columns.length > this.#policy.maxColumns) {
      findings.push({
        code: 'column_mapping_mismatch',
        tableId,
        expected: `1..${String(this.#policy.maxColumns)} columns`,
        actual: String(manifest.columns.length),
      })
    }
    if (manifest.pages.length === 0) {
      findings.push({ code: 'no_pages', tableId })
    }

    findings.push(...this.#checkPageSequence(manifest))

    const evidenceCache = new Map<string, ResolvedEvidence>()
    const boundSubjects = new Set<string>()
    const counts = { rows: 0, cells: 0 }
    let checksDigest = shaOf({ tableId, seed: true })
    const batches: TableVerificationBatchRecord[] = []
    let incomplete = false

    const resume =
      request.resume === true && this.#progress !== undefined && !findings.some((finding) => finding.code === 'manifest_digest_mismatch')
        ? await this.#progress.getProgress(scopeRef, request.resultManifestRef, tableId, ctx)
        : undefined
    const startPage = resume !== undefined ? Math.min(resume.nextPageIndex, manifest.pages.length) : 0
    const startRowInPage = resume !== undefined ? resume.nextRowInPage : 0
    if (resume !== undefined) {
      counts.rows = resume.checkedRows
      counts.cells = resume.checkedCells
      checksDigest = resume.checksDigest
      for (const subject of resume.boundSubjects) boundSubjects.add(subject)
      batches.push(...resume.batches)
    }

    const deadlineMs = Date.parse(ctx.deadline)
    let previousLastRowKey: string | undefined =
      startPage > 0 ? manifest.pages[startPage - 1]?.lastRowKey : undefined

    for (let descriptorIndex = startPage; descriptorIndex < manifest.pages.length; descriptorIndex += 1) {
      const descriptor = manifest.pages[descriptorIndex]
      if (descriptor === undefined) continue
      const page = await this.#pages.getPage(scopeRef, descriptor.artifactRef, ctx)
      if (page === undefined) {
        findings.push({ code: 'page_not_found', tableId, pageIndex: descriptor.pageIndex })
        continue
      }
      this.#checkPage(manifest, descriptor, page, findings)
      const boundary = this.#checkRowOrder(manifest.tableId, descriptor, page.body, previousLastRowKey, findings)
      if (boundary.ordered) previousLastRowKey = boundary.lastRowKey

      const skipRows = descriptorIndex === startPage ? startRowInPage : 0
      for (let offset = 0; offset < page.body.rows.length; offset += this.#policy.maxRowsPerBatch) {
        const slice = page.body.rows.slice(offset, offset + this.#policy.maxRowsPerBatch)
        const rowsToCheck = offset < skipRows ? slice.slice(Math.max(0, skipRows - offset)) : slice
        if (rowsToCheck.length === 0) continue
        if (Number.isFinite(deadlineMs) && Date.parse(this.#now()) >= deadlineMs) {
          findings.push({ code: 'batch_deadline_exceeded', tableId, pageIndex: descriptor.pageIndex })
          incomplete = true
          break
        }
        if (counts.rows + rowsToCheck.length > this.#policy.maxRows) {
          findings.push({
            code: 'row_limit_exceeded',
            tableId,
            pageIndex: descriptor.pageIndex,
            expected: String(this.#policy.maxRows),
            actual: String(counts.rows + rowsToCheck.length),
          })
          incomplete = true
          break
        }
        if (counts.cells + rowsToCheck.length * manifest.columns.length > this.#policy.maxCells) {
          findings.push({
            code: 'cell_limit_exceeded',
            tableId,
            pageIndex: descriptor.pageIndex,
            expected: String(this.#policy.maxCells),
            actual: String(counts.cells + rowsToCheck.length * manifest.columns.length),
          })
          incomplete = true
          break
        }

        const firstRowKey = rowsToCheck[0]?.rowKey ?? ''
        const lastRowKey = rowsToCheck[rowsToCheck.length - 1]?.rowKey ?? ''
        for (const row of rowsToCheck) {
          const rowFindings = await this.#verifyRow(
            { manifest, descriptorIndex, body: page.body, row },
            evidenceCache,
            boundSubjects,
            scopeRef,
            ctx,
          )
          findings.push(...rowFindings)
          counts.rows += 1
          counts.cells += manifest.columns.length
        }

        const processedThrough = offset + slice.length
        const pageDone = processedThrough >= page.body.rows.length
        const batch: TableVerificationBatchRecord = {
          batchIndex: batches.length,
          firstPageIndex: descriptor.pageIndex,
          lastPageIndex: descriptor.pageIndex,
          rowCount: rowsToCheck.length,
          cellCount: rowsToCheck.length * manifest.columns.length,
          firstRowKey,
          lastRowKey,
        }
        batches.push(batch)
        checksDigest = shaOf({ previous: checksDigest, batch })
        await this.#saveProgress(
          scopeRef,
          request,
          manifest,
          counts,
          pageDone ? descriptorIndex + 1 : descriptorIndex,
          pageDone ? 0 : processedThrough,
          boundSubjects,
          batches,
          checksDigest,
          ctx,
        )
      }
      if (incomplete) break
    }

    const expectedRows = manifest.totalRows
    const expectedCells = manifest.totalRows * manifest.columns.length
    if (counts.rows !== expectedRows) {
      findings.push({
        code: 'row_count_mismatch',
        tableId,
        expected: String(expectedRows),
        actual: String(counts.rows),
      })
    }
    if (counts.cells !== expectedCells) {
      findings.push({
        code: 'cell_count_mismatch',
        tableId,
        expected: String(expectedCells),
        actual: String(counts.cells),
      })
    }

    findings.sort(sorter)
    const status: TableHardVerificationReport['status'] = incomplete
      ? 'incomplete'
      : findings.length > 0
        ? 'fail'
        : 'pass'
    const pageDigests = manifest.pages.map((page) => page.artifactDigest)
    const checksDigestFinal = shaOf({ checksDigest, tableId, pageDigests, findings })

    const report: TableHardVerificationReport = {
      schemaVersion: 'table-hard-verification-report@1',
      resultManifestRef: request.resultManifestRef,
      resultManifestDigest: request.resultManifestDigest,
      draftHash: request.draftHash,
      tableId,
      status,
      checkedRows: counts.rows,
      checkedCells: counts.cells,
      expectedRows,
      expectedCells,
      pageDigests,
      checksDigest: checksDigestFinal,
      policyVersion: this.#policy.policyVersion,
      findings,
    }
    assertTableHardVerificationReportShape(report)

    if (status !== 'pass') {
      return { status, report }
    }

    const receipt: TableVerificationReceipt = {
      schemaVersion: TABLE_VERIFICATION_RECEIPT_SCHEMA_VERSION,
      draftHash: request.draftHash,
      resultManifestRef: request.resultManifestRef,
      resultManifestDigest: request.resultManifestDigest,
      tableId,
      pageDigests,
      checkedRows: counts.rows,
      expectedRows,
      checkedCells: counts.cells,
      expectedCells,
      checksDigest: checksDigestFinal,
      policyVersion: this.#policy.policyVersion,
    }
    const receiptRef: ResourceRef = {
      id: this.#newId(),
      version: '1.0.0',
      digest: shaOf(receipt),
      kind: 'artifact',
    }
    if (this.#receipts !== undefined) {
      await this.#receipts.putReceipt(scopeRef, receiptRef, receipt, ctx)
    }
    return { status: 'pass', report, receipt: { ref: receiptRef, receipt } }
  }

  async #saveProgress(
    scopeRef: ScopeRef,
    request: TableHardVerificationRequest,
    manifest: TableArtifactManifest,
    counts: { readonly rows: number; readonly cells: number },
    nextPageIndex: number,
    nextRowInPage: number,
    boundSubjects: ReadonlySet<string>,
    batches: readonly TableVerificationBatchRecord[],
    checksDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<void> {
    if (this.#progress === undefined) return
    const progress: TableVerificationProgress = {
      schemaVersion: TABLE_VERIFICATION_PROGRESS_SCHEMA_VERSION,
      resultManifestRef: request.resultManifestRef,
      resultManifestDigest: request.resultManifestDigest,
      tableId: manifest.tableId,
      totalRows: manifest.totalRows,
      checkedRows: counts.rows,
      checkedCells: counts.cells,
      nextPageIndex,
      nextRowInPage,
      boundSubjects: [...boundSubjects].sort(),
      batches: [...batches],
      checksDigest,
      updatedAt: this.#now(),
    }
    assertTableVerificationProgressShape(progress)
    await this.#progress.saveProgress(scopeRef, request.resultManifestRef, manifest.tableId, progress, ctx)
  }

  #checkPageSequence(manifest: TableArtifactManifest): TableHardVerificationFinding[] {
    const findings: TableHardVerificationFinding[] = []
    if (manifest.pages.some((page, index) => page.pageIndex !== index)) {
      findings.push({ code: 'page_sequence_mismatch', tableId: manifest.tableId })
    }
    const totalRows = manifest.pages.reduce((sum, page) => sum + page.rowCount, 0)
    if (totalRows !== manifest.totalRows) {
      findings.push({
        code: 'row_count_mismatch',
        tableId: manifest.tableId,
        expected: String(manifest.totalRows),
        actual: String(totalRows),
      })
    }
    return findings
  }

  #checkPage(
    manifest: TableArtifactManifest,
    descriptor: { readonly pageIndex: number; readonly artifactRef: ResourceRef; readonly artifactDigest: Sha256Digest; readonly rowCount: number; readonly firstRowKey: string; readonly lastRowKey: string; readonly pageCoverageDigest: Sha256Digest },
    page: TableArtifactPage,
    findings: TableHardVerificationFinding[],
  ): void {
    const body = page.body
    const tableId = manifest.tableId
    if (page.ref.id !== descriptor.artifactRef.id || page.ref.digest !== descriptor.artifactDigest) {
      findings.push({ code: 'page_digest_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
    if (tableArtifactContentDigest(body) !== descriptor.artifactDigest) {
      findings.push({ code: 'page_digest_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
    if (tablePageCoverageDigest(body) !== descriptor.pageCoverageDigest) {
      findings.push({ code: 'page_coverage_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
    if (body.tableId !== tableId || body.pageIndex !== descriptor.pageIndex) {
      findings.push({ code: 'page_descriptor_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
    if (
      body.outputSchemaRef.id !== manifest.outputSchemaRef.id ||
      body.outputSchemaRef.version !== manifest.outputSchemaRef.version
    ) {
      findings.push({ code: 'page_descriptor_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
    const manifestColumns = manifest.columns.map((column) => column.columnRef)
    if (
      body.columnRefs.length !== manifestColumns.length ||
      body.columnRefs.some((columnRef, index) => columnRef !== manifestColumns[index])
    ) {
      findings.push({ code: 'column_mapping_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
    if (body.rows.length !== descriptor.rowCount) {
      findings.push({ code: 'row_count_mismatch', tableId, pageIndex: descriptor.pageIndex })
    }
  }

  #checkRowOrder(
    tableId: string,
    descriptor: { readonly firstRowKey: string; readonly lastRowKey: string },
    body: TableArtifactPageBody,
    previousLastRowKey: string | undefined,
    findings: TableHardVerificationFinding[],
  ): { readonly ordered: boolean; readonly lastRowKey: string } {
    const rows = body.rows
    const last = rows[rows.length - 1]?.rowKey ?? ''
    let ordered = true
    const seen = new Set<string>()
    let previous: string | undefined
    for (const row of rows) {
      if (seen.has(row.rowKey)) {
        findings.push({ code: 'duplicate_row_key', tableId, pageIndex: body.pageIndex, rowKey: row.rowKey })
        ordered = false
      }
      seen.add(row.rowKey)
      if (previous !== undefined && row.rowKey <= previous) {
        findings.push({ code: 'row_key_out_of_order', tableId, pageIndex: body.pageIndex, rowKey: row.rowKey })
        ordered = false
      }
      previous = row.rowKey
    }
    if (rows[0]?.rowKey !== descriptor.firstRowKey || last !== descriptor.lastRowKey) {
      findings.push({ code: 'row_key_out_of_order', tableId, pageIndex: body.pageIndex })
      ordered = false
    }
    if (previousLastRowKey !== undefined && !(descriptor.firstRowKey > previousLastRowKey)) {
      findings.push({ code: 'row_key_out_of_order', tableId, pageIndex: body.pageIndex })
      ordered = false
    }
    return { ordered, lastRowKey: last }
  }

  async #verifyRow(
    context: RowContext,
    evidenceCache: Map<string, ResolvedEvidence>,
    boundSubjects: Set<string>,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<TableHardVerificationFinding[]> {
    const findings: TableHardVerificationFinding[] = []
    const { manifest, row, body } = context
    const tableId = manifest.tableId
    const pageIndex = body.pageIndex
    const columns = new Map(manifest.columns.map((column) => [column.columnRef, column]))

    if (row.subject === undefined || row.subject.length === 0) {
      findings.push({ code: 'row_identity_missing', tableId, pageIndex, rowKey: row.rowKey })
    } else if (boundSubjects.has(row.subject)) {
      findings.push({ code: 'duplicate_row_identity', tableId, pageIndex, rowKey: row.rowKey, expected: row.subject })
    } else {
      boundSubjects.add(row.subject)
    }

    const boundColumns = new Set<string>()
    for (const binding of row.bindings) {
      if (!columns.has(binding.columnRef)) {
        findings.push({ code: 'column_mapping_mismatch', tableId, pageIndex, rowKey: row.rowKey, columnRef: binding.columnRef })
      }
      if (boundColumns.has(binding.columnRef)) {
        findings.push({ code: 'column_duplicate_binding', tableId, pageIndex, rowKey: row.rowKey, columnRef: binding.columnRef })
      }
      boundColumns.add(binding.columnRef)
      if (binding.rowKey !== row.rowKey) {
        findings.push({
          code: 'row_binding_mismatch',
          tableId,
          pageIndex,
          rowKey: row.rowKey,
          columnRef: binding.columnRef,
          expected: row.rowKey,
          actual: binding.rowKey,
        })
      }
    }

    for (const column of manifest.columns) {
      const binding = row.bindings.find((candidate) => candidate.columnRef === column.columnRef)
      if (binding === undefined) {
        findings.push({ code: 'column_unbound', tableId, pageIndex, rowKey: row.rowKey, columnRef: column.columnRef })
        continue
      }
      if (!(column.columnRef in row.cells)) {
        findings.push({ code: 'column_unbound', tableId, pageIndex, rowKey: row.rowKey, columnRef: column.columnRef })
      }
      const cellFindings = await this.#verifyCell(
        { manifest, descriptorIndex: context.descriptorIndex, body, row },
        column,
        binding,
        evidenceCache,
        scopeRef,
        ctx,
      )
      findings.push(...cellFindings)
    }
    return findings
  }

  async #verifyCell(
    context: RowContext,
    column: TableColumnDescriptor,
    binding: TableCellBinding,
    evidenceCache: Map<string, ResolvedEvidence>,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<TableHardVerificationFinding[]> {
    const findings: TableHardVerificationFinding[] = []
    const tableId = context.manifest.tableId
    const pageIndex = context.body.pageIndex
    const rowKey = context.row.rowKey
    const base = { tableId, pageIndex, rowKey, columnRef: column.columnRef }
    const evidence = await this.#resolveEvidence(scopeRef, binding.evidenceRef, evidenceCache, ctx)
    if (evidence === undefined) {
      return [{ code: 'evidence_not_found', ...base, pointer: binding.valuePointer }]
    }
    if (evidence.record.envelope.resultDigest !== binding.resultDigest) {
      findings.push({
        code: 'result_digest_mismatch',
        ...base,
        expected: evidence.record.envelope.resultDigest,
        actual: binding.resultDigest,
      })
    }
    if (evidence.unreadable || evidence.payload === undefined) {
      findings.push({ code: 'evidence_unreadable', ...base })
      return findings
    }
    const payload = evidence.payload

    const rowIndex = tableRowIndex(binding.valuePointer)
    if (rowIndex !== undefined) {
      const subjectRow = tableRowIndex(binding.subjectPointer)
      if (subjectRow === undefined || subjectRow !== rowIndex) {
        findings.push({ code: 'cross_row_binding', ...base, pointer: binding.subjectPointer, expected: String(rowIndex) })
      }
      if (binding.unitPointer !== undefined) {
        const unitRow = tableRowIndex(binding.unitPointer)
        if (unitRow !== undefined && unitRow !== rowIndex) {
          findings.push({ code: 'cross_row_binding', ...base, pointer: binding.unitPointer, expected: String(rowIndex) })
        }
      }
      if (binding.timePointer !== undefined) {
        const timeRow = tableRowIndex(binding.timePointer)
        if (timeRow !== undefined && timeRow !== rowIndex) {
          findings.push({ code: 'cross_row_binding', ...base, pointer: binding.timePointer, expected: String(rowIndex) })
        }
      }
      const expectedColumnPointer = tableColumnPointer(binding.valuePointer)
      if (expectedColumnPointer !== undefined && binding.fieldRefPointer !== expectedColumnPointer) {
        findings.push({ code: 'column_mapping_mismatch', ...base, pointer: binding.fieldRefPointer ?? binding.valuePointer })
      } else if (expectedColumnPointer !== undefined) {
        const declared = resolveJsonPointer(payload, expectedColumnPointer)
        if (!declared.found || !isRecord(declared.value)) {
          findings.push({ code: 'column_mapping_mismatch', ...base, pointer: expectedColumnPointer })
        } else {
          const name = declared.value['semanticFieldRef'] ?? declared.value['name']
          if (name !== column.semanticPredicate) {
            findings.push({
              code: 'column_mapping_mismatch',
              ...base,
              pointer: expectedColumnPointer,
              expected: column.semanticPredicate,
              actual: typeof name === 'string' ? name : 'absent',
            })
          }
        }
      }
    }

    const subject = resolveJsonPointer(payload, binding.subjectPointer)
    if (!subject.found || typeof subject.value !== 'string' || subject.value.length === 0) {
      findings.push({ code: 'subject_pointer_missing', ...base, pointer: binding.subjectPointer })
    } else if (context.row.subject !== undefined && context.row.subject !== subject.value) {
      findings.push({
        code: 'subject_mismatch',
        ...base,
        pointer: binding.subjectPointer,
        expected: context.row.subject,
        actual: subject.value,
      })
    }

    const value = resolveJsonPointer(payload, binding.valuePointer)
    if (!value.found) {
      findings.push({ code: 'value_pointer_missing', ...base, pointer: binding.valuePointer })
      return findings
    }
    const cell = context.row.cells[column.columnRef]

    switch (column.valueType) {
      case 'decimal':
        findings.push(...this.#checkDecimal(base, cell, value.value, binding))
        break
      case 'quantity':
        findings.push(...this.#checkDecimal(base, cell, value.value, binding))
        findings.push(...this.#checkUnit(base, column, cell, payload, binding))
        break
      case 'money':
        findings.push(...this.#checkMoney(base, cell, payload, binding))
        break
      case 'rule_judgement':
        findings.push(...this.#checkRuleJudgement(base, cell, value.value, binding))
        break
      case 'document_quote':
        findings.push(...this.#checkCitation(base, cell, payload, value.value, binding))
        break
      case 'string':
      case 'boolean':
      case 'entity_ref':
      case 'relation_ref':
        if (canonicalJson(value.value) !== canonicalJson(cell)) {
          findings.push({
            code: 'value_mismatch',
            ...base,
            pointer: binding.valuePointer,
            expected: canonicalJson(value.value),
            actual: canonicalJson(cell),
          })
        }
        break
    }

    if (binding.timePointer !== undefined) {
      const time = resolveJsonPointer(payload, binding.timePointer)
      if (!time.found) {
        findings.push({ code: 'time_pointer_missing', ...base, pointer: binding.timePointer })
      } else if (isRecord(cell) && typeof cell['time'] === 'string' && cell['time'] !== time.value) {
        findings.push({
          code: 'time_mismatch',
          ...base,
          pointer: binding.timePointer,
          expected: String(time.value),
          actual: cell['time'],
        })
      }
    }
    return findings
  }

  #checkDecimal(
    base: { readonly tableId: string; readonly pageIndex: number; readonly rowKey: string; readonly columnRef: string },
    cell: unknown,
    observed: unknown,
    binding: TableCellBinding,
  ): TableHardVerificationFinding[] {
    const actualRaw = isRecord(cell) && 'value' in cell ? cell['value'] : cell
    const claim = exactNumericCell(actualRaw)
    if (claim.lossy) return [{ code: 'precision_unsupported', ...base, pointer: binding.valuePointer }]
    const observedText = numericText(observed)
    if (claim.text === undefined || observedText === undefined) {
      return [{ code: 'value_mismatch', ...base, pointer: binding.valuePointer, expected: String(observed), actual: canonicalJson(cell) }]
    }
    if (claim.text !== observedText) {
      return [{ code: 'value_mismatch', ...base, pointer: binding.valuePointer, expected: observedText, actual: claim.text }]
    }
    return []
  }

  #checkUnit(
    base: { readonly tableId: string; readonly pageIndex: number; readonly rowKey: string; readonly columnRef: string },
    column: TableColumnDescriptor,
    cell: unknown,
    payload: unknown,
    binding: TableCellBinding,
  ): TableHardVerificationFinding[] {
    const required =
      binding.unitPointer !== undefined || (column.requiredContextPointers ?? []).includes('unitPointer')
    if (!required) return []
    if (binding.unitPointer === undefined) {
      return [{ code: 'unit_pointer_missing', ...base }]
    }
    const unit = resolveJsonPointer(payload, binding.unitPointer)
    if (!unit.found || typeof unit.value !== 'string' || unit.value.length === 0) {
      return [{ code: 'unit_pointer_missing', ...base, pointer: binding.unitPointer }]
    }
    if (isRecord(cell) && typeof cell['unit'] === 'string' && cell['unit'] !== unit.value) {
      return [
        { code: 'unit_mismatch', ...base, pointer: binding.unitPointer, expected: unit.value, actual: cell['unit'] },
      ]
    }
    return []
  }

  #checkMoney(
    base: { readonly tableId: string; readonly pageIndex: number; readonly rowKey: string; readonly columnRef: string },
    cell: unknown,
    payload: unknown,
    binding: TableCellBinding,
  ): TableHardVerificationFinding[] {
    const findings: TableHardVerificationFinding[] = []
    if (!isRecord(cell) || typeof cell['amount'] !== 'string' || typeof cell['currency'] !== 'string') {
      return [{ code: 'value_mismatch', ...base, pointer: binding.valuePointer, expected: '{amount, currency}' }]
    }
    const amount = resolveJsonPointer(payload, binding.valuePointer)
    const amountText = numericText(amount.value)
    const claimText = canonicalDecimal(cell['amount'])
    if (amountText === undefined || claimText === undefined || amountText !== claimText) {
      findings.push({
        code: 'value_mismatch',
        ...base,
        pointer: binding.valuePointer,
        expected: amountText ?? 'absent',
        actual: cell['amount'],
      })
    }
    if (binding.currencyPointer === undefined) {
      findings.push({ code: 'currency_pointer_missing', ...base })
    } else {
      const currency = resolveJsonPointer(payload, binding.currencyPointer)
      if (!currency.found || typeof currency.value !== 'string' || currency.value.length === 0) {
        findings.push({ code: 'currency_pointer_missing', ...base, pointer: binding.currencyPointer })
      } else if (currency.value !== cell['currency']) {
        findings.push({
          code: 'currency_mismatch',
          ...base,
          pointer: binding.currencyPointer,
          expected: currency.value,
          actual: cell['currency'],
        })
      }
    }
    return findings
  }

  #checkRuleJudgement(
    base: { readonly tableId: string; readonly pageIndex: number; readonly rowKey: string; readonly columnRef: string },
    cell: unknown,
    observed: unknown,
    binding: TableCellBinding,
  ): TableHardVerificationFinding[] {
    const findings: TableHardVerificationFinding[] = []
    if (binding.judgementAxis === undefined) {
      findings.push({ code: 'rule_binding_missing', ...base, expected: 'judgementAxis' })
    }
    if (binding.rulePointer === undefined && binding.computationPointer === undefined) {
      findings.push({ code: 'rule_binding_missing', ...base, expected: 'rulePointer or computationPointer' })
    }
    const declared = typeof cell === 'string' ? cell : undefined
    if (declared !== 'true' && declared !== 'false' && declared !== 'unknown' && declared !== 'conflict') {
      findings.push({ code: 'rule_judgement_mismatch', ...base, expected: 'true|false|unknown|conflict' })
      return findings
    }
    if (observed !== declared) {
      findings.push({
        code: 'rule_judgement_mismatch',
        ...base,
        pointer: binding.valuePointer,
        expected: typeof observed === 'string' ? observed : canonicalJson(observed),
        actual: declared,
      })
    }
    return findings
  }

  #checkCitation(
    base: { readonly tableId: string; readonly pageIndex: number; readonly rowKey: string; readonly columnRef: string },
    cell: unknown,
    payload: unknown,
    observed: unknown,
    binding: TableCellBinding,
  ): TableHardVerificationFinding[] {
    const findings: TableHardVerificationFinding[] = []
    if (
      binding.documentRef === undefined ||
      binding.locatorPointer === undefined ||
      binding.textDigestPointer === undefined ||
      binding.quoteDigestPointer === undefined
    ) {
      findings.push({ code: 'citation_pointer_missing', ...base })
      return findings
    }
    const expectedQuote = isRecord(cell) && typeof cell['quote'] === 'string' ? cell['quote'] : typeof cell === 'string' ? cell : undefined
    if (expectedQuote !== undefined && observed !== expectedQuote) {
      findings.push({
        code: 'citation_mismatch',
        ...base,
        pointer: binding.valuePointer,
        expected: expectedQuote,
        actual: typeof observed === 'string' ? observed : canonicalJson(observed),
      })
    }
    const textDigest = resolveJsonPointer(payload, binding.textDigestPointer)
    const quoteDigest = resolveJsonPointer(payload, binding.quoteDigestPointer)
    if (typeof textDigest.value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(textDigest.value)) {
      findings.push({ code: 'citation_pointer_missing', ...base, pointer: binding.textDigestPointer })
    }
    if (typeof quoteDigest.value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(quoteDigest.value)) {
      findings.push({ code: 'citation_pointer_missing', ...base, pointer: binding.quoteDigestPointer })
    }
    return findings
  }

  async #resolveEvidence(
    scopeRef: ScopeRef,
    ref: ResourceRef,
    cache: Map<string, ResolvedEvidence>,
    ctx: ToolContext,
  ): Promise<ResolvedEvidence | undefined> {
    const cached = cache.get(ref.id)
    if (cached !== undefined) return cached
    const record = await this.#evidence.get(scopeRef, ref.id, ctx)
    if (record === undefined) return undefined
    const resolved = await this.#readEvidence(scopeRef, record, ctx)
    cache.set(ref.id, resolved)
    return resolved
  }

  async #readEvidence(scopeRef: ScopeRef, record: EvidenceRecord, ctx: ToolContext): Promise<ResolvedEvidence> {
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) return { record, unreadable: true }
    try {
      const authorized = await this.#artifacts.getAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      if (!authorized.integrityVerified) return { record, unreadable: true }
      const bytes = await this.#artifacts.readAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
      return { record, payload, unreadable: false }
    } catch {
      return { record, unreadable: true }
    }
  }
}
