import { isTableArtifactPageBody, isTableVerificationReceipt, isTypedResultManifest, sha256OfCanonical, tableArtifactContentDigest, tableManifestContentDigest, tablePageCoverageDigest } from '@ontology/contracts'
import type { ArchivedRunExecutionBinding, PublishedAnswer, ResourceRef, ScopeRef, TableArtifactPageStore, TableCellBinding, TableColumnDescriptor, TableVerificationReceiptStore, ToolContext, VerifiedTableManifestSource } from '@ontology/contracts'

export interface SavedCellSelector { readonly tableId: string; readonly rowKey: string; readonly columnRef: string }
export interface SavedCellRead { readonly selector: SavedCellSelector; readonly binding: TableCellBinding; readonly column: TableColumnDescriptor; readonly subject: string; readonly value: unknown }
export interface SavedCellPorts {
  readonly verifiedTables?: VerifiedTableManifestSource
  readonly tablePages?: Pick<TableArtifactPageStore, 'getPage'>
  readonly tableReceipts?: Pick<TableVerificationReceiptStore, 'getReceipt'>
}
const same = (left: unknown, right: unknown) => sha256OfCanonical(left) === sha256OfCanonical(right)
const requireCell = (condition: unknown, message: string): void => { if (!condition) throw Object.assign(new Error(message), { code: 'SOURCE_UNVERIFIABLE', httpStatus: 409 }) }
function found<T>(value: T | undefined, message: string): T { if (value === undefined) throw Object.assign(new Error(message), { code: 'SOURCE_NOT_FOUND', httpStatus: 404 }); return value }

/** Reads one exact earned table cell without consuming or changing the table pagination cursor. */
export async function readSavedCell(input: {
  readonly ports: SavedCellPorts
  readonly answer: PublishedAnswer
  readonly archived: ArchivedRunExecutionBinding
  readonly scope: ScopeRef
  readonly ctx: ToolContext
  readonly selector: SavedCellSelector
  readonly evidenceRef: ResourceRef
  readonly readJson: (ref: ResourceRef, cap: number) => Promise<unknown>
  readonly check: () => void
}): Promise<SavedCellRead> {
  input.check()
  const body = input.answer.v3Body
  if (body === undefined || input.ports.verifiedTables === undefined || input.ports.tablePages === undefined || input.ports.tableReceipts === undefined) throw Object.assign(new Error('saved cell source reads require the actual verified table/page/receipt readers'), { code: 'SOURCE_UNVERIFIABLE', httpStatus: 409 })
  requireCell(body.resultManifestRef.digest === body.resultManifestDigest && same(body.executionBindingRef, input.archived.ref), 'the saved answer table is detached from its immutable execution')
  const manifest = await input.readJson(body.resultManifestRef, 1_048_576)
  if (!isTypedResultManifest(manifest)) throw Object.assign(new Error('the saved typed result manifest is malformed'), { code: 'SOURCE_UNVERIFIABLE', httpStatus: 409 })
  requireCell(same(manifest.executionBindingRef, input.archived.ref) && same(manifest.inputSnapshotRef, input.archived.binding.request.inputSnapshotRef), 'the result manifest has different execution/input pins')
  requireCell(input.archived.binding.allowedTaskBindingRefs.some((ref) => same(ref, manifest.taskBindingRef)) && (input.archived.binding.request.mode !== 'task' || same(input.archived.binding.request.taskBindingRef, manifest.taskBindingRef)), 'the saved table belongs to another task binding')
  requireCell(manifest.tables.filter((table) => table.tableId === input.selector.tableId).length === 1, 'the saved table identity is missing or ambiguous')
  const table = found(manifest.tables.find((table) => table.tableId === input.selector.tableId), 'this table is not in the saved answer')
  // The table fixes its actual cell schema; the outer manifest fixes the Core
  // result format. These are intentionally independent schema references.
  requireCell(table.columns.filter((column) => column.columnRef === input.selector.columnRef).length === 1 && new Set(table.columns.map((column) => column.columnRef)).size === table.columns.length, 'the saved column identity is ambiguous')
  const column = found(table.columns.find((column) => column.columnRef === input.selector.columnRef), 'this column is not in the saved table')
  requireCell(table.complete && table.totalRows <= 10_000 && table.pages.length <= 40 && table.columns.length <= 32, 'the saved table is not complete within its declared bounds')
  requireCell(table.pages.reduce((count, page) => count + page.rowCount, 0) === table.totalRows && table.pages.every((page, index) => page.pageIndex === index && page.rowCount <= 250 && page.firstRowKey <= page.lastRowKey && (index === 0 || table.pages[index - 1]!.lastRowKey < page.firstRowKey)), 'the saved table page coverage is malformed or overlaps')
  const verified = found(await input.ports.verifiedTables.resolve(input.scope, input.answer.answerId, table.tableId, input.ctx), 'the table is not published for this saved answer')
  const tableDigest = tableManifestContentDigest(table)
  requireCell(verified.ref.digest === tableDigest && tableManifestContentDigest(verified.manifest) === tableDigest && verified.verificationReceiptRef !== undefined, 'the saved table body/manifest/receipt identity changed')
  const receiptRef = found(verified.verificationReceiptRef, 'the table has no earned verification receipt')
  const receipt = found(await input.ports.tableReceipts.getReceipt(input.scope, receiptRef, input.ctx), 'the exact table verification receipt is unavailable')
  requireCell(same(receipt.ref, receiptRef) && isTableVerificationReceipt(receipt.receipt) && sha256OfCanonical(receipt.receipt) === receiptRef.digest && receipt.receipt.draftHash === input.answer.contentHash && same(receipt.receipt.resultManifestRef, verified.ref) && receipt.receipt.resultManifestDigest === tableDigest && receipt.receipt.tableId === table.tableId && receipt.receipt.checkedRows === table.totalRows && receipt.receipt.expectedRows === table.totalRows && receipt.receipt.checkedCells === table.totalRows * table.columns.length && receipt.receipt.expectedCells === receipt.receipt.checkedCells && same(receipt.receipt.pageDigests, table.pages.map((page) => page.artifactDigest)), 'the actual earned full-table receipt does not bind this answer/table/page set')
  const candidates = table.pages.filter((page) => input.selector.rowKey >= page.firstRowKey && input.selector.rowKey <= page.lastRowKey)
  requireCell(candidates.length === 1, 'the opaque row key is not uniquely in a saved page descriptor')
  const descriptor = found(candidates[0], 'the selected row has no saved page')
  const page = found(await input.ports.tablePages.getPage(input.scope, descriptor.artifactRef, input.ctx), 'the exact saved page is unavailable')
  requireCell(isTableArtifactPageBody(page.body) && same(page.ref, descriptor.artifactRef) && page.ref.digest === descriptor.artifactDigest && tableArtifactContentDigest(page.body) === descriptor.artifactDigest && tablePageCoverageDigest(page.body) === descriptor.pageCoverageDigest && page.body.tableId === table.tableId && page.body.pageIndex === descriptor.pageIndex && same(page.body.outputSchemaRef, table.outputSchemaRef) && same(page.body.columnRefs, table.columns.map((column) => column.columnRef)) && page.body.rows.length === descriptor.rowCount && page.body.rows[0]?.rowKey === descriptor.firstRowKey && page.body.rows.at(-1)?.rowKey === descriptor.lastRowKey, 'the original saved table page failed its full identity/hash/coverage binding')
  const row = found(page.body.rows.find((row) => row.rowKey === input.selector.rowKey), 'the selected row is absent from its saved page')
  const bindings = row.bindings.filter((binding) => binding.rowKey === row.rowKey && binding.columnRef === column.columnRef)
  requireCell(bindings.length === 1, 'the saved cell binding is missing or ambiguous')
  const binding = found(bindings[0], 'the saved cell has no evidence binding')
  const subject = found(row.subject, 'the selected saved cell has no actual subject')
  requireCell(same(binding.evidenceRef, input.evidenceRef) && subject.length > 0, 'the saved cell is bound to another evidence or has no actual subject')
  input.check()
  // Complete source reads recheck this exact receipt/page again after native I/O.
  return { selector: input.selector, binding, column, subject, value: row.cells[column.columnRef] }
}

/** RFC6901 data access only: no expressions, inherited properties or ordinal inference. */
export function savedPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/') || pointer.length > 2_048) return undefined
  const tokens = pointer.slice(1).split('/')
  if (tokens.length > 32 || tokens.some((token) => /~(?![01])/u.test(token))) return undefined
  let current: unknown = value
  for (const encoded of tokens) {
    const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) { if (!/^(0|[1-9][0-9]*)$/u.test(token)) return undefined; current = current[Number(token)] }
    else if (typeof current === 'object' && current !== null && Object.hasOwn(current, token)) current = Reflect.get(current, token)
    else return undefined
  }
  return current
}
