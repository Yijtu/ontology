import { createHash } from 'node:crypto'
import type {
  DataMode,
  DomainResultStatus,
  NonEmptyString,
  OpaqueCursor,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  TaskKind,
  ToolCoverage,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isSha256Digest, isUuid, isVersionRef } from './asset-workspace'

/**
 * Typed result manifest and the large-table artifact read contract (SPEC v0.3a
 * execution-evidence §EX-7.1, issue V03-032 / #203).
 *
 * A formal table is never rendered from a raw artifact: the writer archives the verified
 * pages as immutable artifacts, the manifest fixes each page ref/digest plus bounded
 * row/column bindings, and the reader returns exactly one page of one *fixed verified
 * revision*. The control store keeps only refs/counts/digests; the rows live in the
 * immutable artifact store.
 *
 * Two separations are load-bearing and therefore encoded in the types:
 *
 *  - **Body vs read envelope.** A `TableArtifactPageBody` fixes `tableId`, column refs,
 *    output schema and row identity, but never points back at the parent result manifest
 *    that will reference it. The manifest is archived *after* its pages, so it can fix the
 *    page refs/digests without a manifest↔page digest cycle.
 *  - **Cursor vs content.** A `TableReadCursor` pins the fixed revision digest and the
 *    scope, so a rebuild that activates a newer generation is refused as `REVISION_CHANGED`
 *    instead of silently concatenating pages from two revisions.
 *
 * Ports are data-only. The executing reader lives in `@ontology/application`, the durable
 * store in an adapter; `contracts` imports no driver and never opens a connection.
 */

export const TABLE_ARTIFACT_MANIFEST_SCHEMA_VERSION = 'table-artifact-manifest@1'
export const TABLE_ARTIFACT_PAGE_SCHEMA_VERSION = 'table-artifact-page@1'
export const TABLE_VERIFICATION_RECEIPT_SCHEMA_VERSION = 'table-verification-receipt@1'
export const TYPED_RESULT_MANIFEST_SCHEMA_VERSION = 'typed-result-manifest@1'

/** Frozen page size (SPEC EX-10: 250 rows per page, total result cap 10,000 rows / 32 columns). */
export const MAX_TABLE_PAGE_ROWS = 250
export const MAX_TABLE_RESULT_ROWS = 10_000
export const MAX_TABLE_COLUMNS = 32

/** The distinguished value kinds a table cell can bind to. */
export type TableValueType =
  | 'decimal'
  | 'quantity'
  | 'money'
  | 'string'
  | 'boolean'
  | 'entity_ref'
  | 'relation_ref'
  | 'rule_judgement'
  | 'document_quote'

const TABLE_VALUE_TYPES: readonly TableValueType[] = [
  'decimal',
  'quantity',
  'money',
  'string',
  'boolean',
  'entity_ref',
  'relation_ref',
  'rule_judgement',
  'document_quote',
]

/**
 * One column descriptor. It owns the `columnRef` identity and the semantic predicate, and
 * fixes which required context pointers (unit for a quantity, currency for money, …) every
 * cell binding in that column must carry. A reader must never infer a column identity from
 * array position.
 */
export interface TableColumnDescriptor {
  readonly columnRef: NonEmptyString
  readonly semanticPredicate: NonEmptyString
  readonly valueType: TableValueType
  /** JSON pointer into the registered output schema that declares the value shape. */
  readonly schemaPointer: NonEmptyString
  readonly displayLabel?: NonEmptyString
  /** Pointers that must be present on every cell binding of this column (e.g. unitPointer). */
  readonly requiredContextPointers?: readonly NonEmptyString[]
}

/**
 * One fixed page of a table. The page content is an immutable artifact, so the descriptor
 * fixes the artifact ref/digest and the boundary row keys that make the page order provable.
 * `artifactDigest` must equal the archived page digest a reader re-computes.
 */
export interface TablePageDescriptor {
  readonly pageIndex: number
  readonly artifactRef: ResourceRef
  readonly artifactDigest: Sha256Digest
  readonly rowCount: number
  readonly firstRowKey: NonEmptyString
  readonly lastRowKey: NonEmptyString
  /** Digest over the page rows/coverage used by the table-verification receipt. */
  readonly pageCoverageDigest: Sha256Digest
}

/**
 * The table artifact manifest: the immutable description of one table of one fixed result
 * revision. It fixes the columns, the ascending row key order, the page set and the explicit
 * completeness; it carries only refs/counts/digests and never the rows themselves.
 */
export interface TableArtifactManifest {
  readonly schemaVersion: 'table-artifact-manifest@1'
  readonly tableId: NonEmptyString
  readonly outputSchemaRef: VersionRef
  readonly columns: readonly TableColumnDescriptor[]
  readonly totalRows: number
  /** Pages are ordered by a strictly ascending row key; this is frozen, never "as returned". */
  readonly rowKeyOrder: 'ascending'
  readonly pages: readonly TablePageDescriptor[]
  readonly coverage: ToolCoverage
  /** `true` only when the page set is the full table and every bound held. */
  readonly complete: boolean
}

/** The typed result manifest body referenced by an `answer-draft@3`. */
export interface TypedResultManifest {
  readonly schemaVersion: 'typed-result-manifest@1'
  readonly executionBindingRef: ResourceRef
  readonly taskBindingRef: VersionRef
  readonly resultKind: TaskKind
  readonly outputSchemaRef: VersionRef
  readonly inputSnapshotRef: ResourceRef
  readonly outputDigest: Sha256Digest
  readonly tables: readonly TableArtifactManifest[]
  readonly limitations: readonly string[]
  readonly coverage: ToolCoverage
  readonly domainStatus: DomainResultStatus
  readonly dataMode: DataMode
}

/** One cell's binding into its exact evidence payload. `rowKey`/`columnRef` are mandatory. */
export interface TableCellBinding {
  readonly rowKey: NonEmptyString
  readonly columnRef: NonEmptyString
  readonly evidenceRef: ResourceRef
  readonly resultDigest: Sha256Digest
  readonly valuePointer: NonEmptyString
  readonly subjectPointer: NonEmptyString
  readonly fieldRefPointer?: NonEmptyString
  readonly timePointer?: NonEmptyString
  readonly status?: DomainResultStatus
  readonly coverage?: ToolCoverage
  readonly unitPointer?: NonEmptyString
  readonly currencyPointer?: NonEmptyString
  readonly judgementAxis?: 'applicability' | 'business_proposition'
  readonly rulePointer?: NonEmptyString
  readonly computationPointer?: NonEmptyString
  readonly documentRef?: ResourceRef
  readonly locatorPointer?: NonEmptyString
  readonly textDigestPointer?: NonEmptyString
  readonly quoteDigestPointer?: NonEmptyString
}

/**
 * One archived row of a table page: the stable `rowKey`, the raw cell values keyed by column
 * ref and the per-cell evidence bindings. Values and bindings are both required so a value can
 * never be rendered without the evidence that proves it.
 */
export interface TableArtifactRow {
  readonly rowKey: NonEmptyString
  readonly cells: Readonly<Record<NonEmptyString, unknown>>
  readonly bindings: readonly TableCellBinding[]
}

/**
 * The immutable body of one table page. It fixes the table/column identity and the page
 * index, but never references the parent result manifest, so the manifest may point at this
 * page without a digest cycle.
 */
export interface TableArtifactPageBody {
  readonly schemaVersion: 'table-artifact-page@1'
  readonly tableId: NonEmptyString
  readonly outputSchemaRef: VersionRef
  readonly pageIndex: number
  /** The exact ordered column refs of this page; must match the manifest descriptor. */
  readonly columnRefs: readonly NonEmptyString[]
  readonly rowKeyOrder: 'ascending'
  readonly rows: readonly TableArtifactRow[]
  readonly coverage: ToolCoverage
}

/** One archived page and the ref it is addressed by. */
export interface TableArtifactPage {
  readonly ref: ResourceRef
  readonly body: TableArtifactPageBody
}

/** One archived table manifest and the receipt that proves the full table was verified. */
export interface ArchivedTableArtifactManifest {
  readonly ref: ResourceRef
  readonly manifest: TableArtifactManifest
  /**
   * The `table-verification-receipt@1` ref. A formal table is never served without one; a
   * resolver that has only a raw unverified artifact leaves this absent (or returns
   * `undefined`), and the reader refuses to render it.
   */
  readonly verificationReceiptRef?: ResourceRef
}

/**
 * The independent full-table verification receipt (SPEC §EX-7.1). It binds the draft hash,
 * the result manifest digest and every page digest to the exact row/cell counts checked.
 * It is archived *after* the draft and lives on the read envelope, so it may reference the
 * draft hash without the draft depending on it.
 */
export interface TableVerificationReceipt {
  readonly schemaVersion: 'table-verification-receipt@1'
  readonly draftHash: Sha256Digest
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly tableId: NonEmptyString
  readonly pageDigests: readonly Sha256Digest[]
  readonly checkedRows: number
  readonly expectedRows: number
  readonly checkedCells: number
  readonly expectedCells: number
  readonly checksDigest: Sha256Digest
  readonly policyVersion: NonEmptyString
}

/**
 * An opaque pagination cursor bound to one fixed verified revision and one scope. The
 * `scopeDigest` and `resultManifestDigest` are what let a reader refuse a cursor minted in
 * another tenant/space or against another generation.
 */
export interface TableReadCursor {
  readonly version: 1
  readonly answerId: Uuid
  readonly tableId: NonEmptyString
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly scopeDigest: Sha256Digest
  /** The page this cursor would return next (0-based). */
  readonly pageIndex: number
  /** Boundary row key of the previous page; absent for the first page. */
  readonly lastRowKey?: NonEmptyString
}

/**
 * The persisted page-tab progress for one (answer, table) in one scope. A reader advances
 * this monotonically, so a duplicate or backward cursor is refused instead of being served
 * again and concatenated.
 */
export interface TableReadProgress {
  readonly highestServedPageIndex: number
  readonly consumedCursorDigests: readonly Sha256Digest[]
}

/** A request to read one page of one fixed verified table revision. */
export interface TablePageReadRequest {
  readonly answerId: Uuid
  readonly tableId: NonEmptyString
  /** Absent on the first read; the returned `nextCursor` must be supplied thereafter. */
  readonly cursor?: OpaqueCursor
}

/** The verified page read envelope. `verified` is `true` by construction of the source. */
export interface TablePageReadView {
  readonly answerId: Uuid
  readonly tableId: NonEmptyString
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly tableVerificationReceiptRef: ResourceRef
  readonly pageIndex: number
  readonly pageCount: number
  readonly totalRows: number
  readonly columns: readonly TableColumnDescriptor[]
  readonly rows: readonly TableArtifactRow[]
  readonly coverage: ToolCoverage
  /** Present only while more pages remain; bound to this exact fixed revision. */
  readonly cursor?: OpaqueCursor
  readonly complete: boolean
  /** Read-envelope validity metadata; never written back into the hashed body. */
  readonly currentValidity?: {
    readonly state: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'
    readonly reason?: string
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Ports                                                                                      */
/* ----------------------------------------------------------------------------------------- */

/**
 * Resolves the fixed verified table manifest for one published answer. A source only returns
 * a manifest that carries a verification receipt; an unverified raw artifact must resolve to
 * `undefined` so it can never be rendered as a formal table.
 */
export interface VerifiedTableManifestSource {
  resolve(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<ArchivedTableArtifactManifest | undefined>
}

/** Immutable persistence for table artifact manifests, keyed by exact ref digest. */
export interface TableArtifactManifestStore {
  putManifest(
    scopeRef: ScopeRef,
    answerId: Uuid,
    manifestRef: ResourceRef,
    manifest: TableArtifactManifest,
    verificationReceiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<void>
  getManifest(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTableArtifactManifest | undefined>
}

/** Immutable persistence for table page artifacts, keyed by exact ref digest. */
export interface TableArtifactPageStore {
  putPage(
    scopeRef: ScopeRef,
    pageRef: ResourceRef,
    body: TableArtifactPageBody,
    ctx: ToolContext,
  ): Promise<void>
  getPage(
    scopeRef: ScopeRef,
    pageRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<TableArtifactPage | undefined>
}

/** Persistence for the per-(answer, table) page-tab progress. */
export interface TableReadProgressStore {
  get(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<TableReadProgress | undefined>
  save(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    progress: TableReadProgress,
    ctx: ToolContext,
  ): Promise<void>
}

/* ----------------------------------------------------------------------------------------- */
/* Errors                                                                                     */
/* ----------------------------------------------------------------------------------------- */

export type TableArtifactReadErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SCOPE_MISMATCH'
  | 'TABLE_NOT_FOUND'
  | 'TABLE_UNVERIFIED'
  | 'TABLE_REVISION_CHANGED'
  | 'CURSOR_INVALID'
  | 'CURSOR_REPLAY'
  | 'CURSOR_BACKWARD'
  | 'CURSOR_GAP'
  | 'PAGE_NOT_FOUND'
  | 'PAGE_DIGEST_MISMATCH'
  | 'PAGE_ROW_ORDER_VIOLATION'

export class TableArtifactReadError extends Error {
  readonly code: TableArtifactReadErrorCode

  constructor(code: TableArtifactReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TableArtifactReadError'
    this.code = code
  }
}

export function isTableArtifactReadError(value: unknown): value is TableArtifactReadError {
  return value instanceof TableArtifactReadError
}

/* ----------------------------------------------------------------------------------------- */
/* Cursor encoding                                                                            */
/* ----------------------------------------------------------------------------------------- */

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function sha256OfCanonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

/**
 * The content digest of a table page artifact. It canonicalizes key order, so a page that
 * round-tripped through JSONB storage still recomputes to the same digest. Writers MUST set
 * `TablePageDescriptor.artifactDigest` and the page `ResourceRef.digest` to this value.
 */
export function tableArtifactContentDigest(body: TableArtifactPageBody): Sha256Digest {
  return sha256OfCanonical({
    schemaVersion: body.schemaVersion,
    tableId: body.tableId,
    outputSchemaRef: body.outputSchemaRef,
    pageIndex: body.pageIndex,
    columnRefs: body.columnRefs,
    rowKeyOrder: body.rowKeyOrder,
    rows: body.rows,
    coverage: body.coverage,
  })
}

/**
 * The coverage digest of one page. It binds the ordered row keys and the page coverage, so a
 * reader can prove the page it read is the page the table-verification receipt checked.
 */
export function tablePageCoverageDigest(body: TableArtifactPageBody): Sha256Digest {
  return sha256OfCanonical({
    tableId: body.tableId,
    pageIndex: body.pageIndex,
    rowKeys: body.rows.map((row) => row.rowKey),
    coverage: body.coverage,
  })
}

/** The digest of one cursor's binding; the progress ledger records which digests were served. */
export function tableReadCursorDigest(cursor: TableReadCursor): Sha256Digest {
  return sha256OfCanonical(cursor)
}

export function encodeTableReadCursor(cursor: TableReadCursor): OpaqueCursor {
  if (!isTableReadCursor(cursor)) {
    throw new TableArtifactReadError('CURSOR_INVALID', 'cannot encode a malformed table read cursor')
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeTableReadCursor(value: OpaqueCursor): TableReadCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch (error) {
    throw new TableArtifactReadError('CURSOR_INVALID', 'the cursor is not a valid opaque cursor', {
      cause: error,
    })
  }
  if (!isTableReadCursor(parsed)) {
    throw new TableArtifactReadError('CURSOR_INVALID', 'the cursor does not match table-read-cursor@1')
  }
  return parsed
}

/* ----------------------------------------------------------------------------------------- */
/* Runtime guards                                                                             */
/* ----------------------------------------------------------------------------------------- */

const DOMAIN_STATUSES: readonly DomainResultStatus[] = [
  'known',
  'unknown',
  'conflict',
  'infeasible',
  'not_applicable',
]

const DATA_MODES: readonly DataMode[] = ['synthetic', 'observed', 'forecast', 'simulation', 'live']

const TASK_KINDS: readonly TaskKind[] = [
  'published_facts',
  'relations',
  'rule_judgement',
  'structured_query',
  'document_qa',
  'compute',
]

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value)
}

function isNonEmptyString(value: unknown): value is NonEmptyString {
  return typeof value === 'string' && value.length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value)
}

function isNonEmptyStringArray(value: unknown): value is NonEmptyString[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isToolCoverage(value: unknown): value is ToolCoverage {
  return (
    isRecord(value) && typeof value['returned'] === 'number' && typeof value['truncated'] === 'boolean'
  )
}

function isTableValueType(value: unknown): value is TableValueType {
  return typeof value === 'string' && (TABLE_VALUE_TYPES as readonly string[]).includes(value)
}

function isDomainStatus(value: unknown): value is DomainResultStatus {
  return typeof value === 'string' && (DOMAIN_STATUSES as readonly string[]).includes(value)
}

function isDataMode(value: unknown): value is DataMode {
  return typeof value === 'string' && (DATA_MODES as readonly string[]).includes(value)
}

export function isTableColumnDescriptor(value: unknown): value is TableColumnDescriptor {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['columnRef'])) return false
  if (!isNonEmptyString(value['semanticPredicate'])) return false
  if (!isTableValueType(value['valueType'])) return false
  if (!isNonEmptyString(value['schemaPointer'])) return false
  if (!isOptionalNonEmptyString(value['displayLabel'])) return false
  if (value['requiredContextPointers'] !== undefined && !isNonEmptyStringArray(value['requiredContextPointers'])) {
    return false
  }
  return true
}

export function isTablePageDescriptor(value: unknown): value is TablePageDescriptor {
  if (!isRecord(value)) return false
  if (!isNonNegativeInteger(value['pageIndex'])) return false
  if (!isResourceRef(value['artifactRef'])) return false
  if (!isSha256Digest(value['artifactDigest'])) return false
  if (!isPositiveInteger(value['rowCount'])) return false
  if (!isNonEmptyString(value['firstRowKey'])) return false
  if (!isNonEmptyString(value['lastRowKey'])) return false
  if (!isSha256Digest(value['pageCoverageDigest'])) return false
  return true
}

export function isTableArtifactManifest(value: unknown): value is TableArtifactManifest {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== TABLE_ARTIFACT_MANIFEST_SCHEMA_VERSION) return false
  if (!isNonEmptyString(value['tableId'])) return false
  if (!isVersionRef(value['outputSchemaRef'])) return false
  if (!Array.isArray(value['columns']) || value['columns'].length === 0) return false
  if (value['columns'].length > MAX_TABLE_COLUMNS) return false
  if (!value['columns'].every(isTableColumnDescriptor)) return false
  const pages = value['pages']
  if (!Array.isArray(pages) || !pages.every(isTablePageDescriptor)) return false
  if (!isNonNegativeInteger(value['totalRows'])) return false
  if (value['rowKeyOrder'] !== 'ascending') return false
  if (!isToolCoverage(value['coverage'])) return false
  if (typeof value['complete'] !== 'boolean') return false
  return true
}

export function isTypedResultManifest(value: unknown): value is TypedResultManifest {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== TYPED_RESULT_MANIFEST_SCHEMA_VERSION) return false
  if (!isResourceRef(value['executionBindingRef'])) return false
  if (!isVersionRef(value['taskBindingRef'])) return false
  if (!isTaskKind(value['resultKind'])) return false
  if (!isVersionRef(value['outputSchemaRef'])) return false
  if (!isResourceRef(value['inputSnapshotRef'])) return false
  if (!isSha256Digest(value['outputDigest'])) return false
  if (!Array.isArray(value['tables']) || !value['tables'].every(isTableArtifactManifest)) return false
  if (!Array.isArray(value['limitations']) || !value['limitations'].every((entry) => typeof entry === 'string')) {
    return false
  }
  if (!isToolCoverage(value['coverage'])) return false
  if (!isDomainStatus(value['domainStatus'])) return false
  if (!isDataMode(value['dataMode'])) return false
  return true
}

export function isTableCellBinding(value: unknown): value is TableCellBinding {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['rowKey'])) return false
  if (!isNonEmptyString(value['columnRef'])) return false
  if (!isResourceRef(value['evidenceRef'])) return false
  if (!isSha256Digest(value['resultDigest'])) return false
  if (!isNonEmptyString(value['valuePointer'])) return false
  if (!isNonEmptyString(value['subjectPointer'])) return false
  if (!isOptionalNonEmptyString(value['fieldRefPointer'])) return false
  if (!isOptionalNonEmptyString(value['timePointer'])) return false
  if (value['status'] !== undefined && !isDomainStatus(value['status'])) return false
  if (value['coverage'] !== undefined && !isToolCoverage(value['coverage'])) return false
  if (!isOptionalNonEmptyString(value['unitPointer'])) return false
  if (!isOptionalNonEmptyString(value['currencyPointer'])) return false
  if (value['judgementAxis'] !== undefined && value['judgementAxis'] !== 'applicability' && value['judgementAxis'] !== 'business_proposition') {
    return false
  }
  if (!isOptionalNonEmptyString(value['rulePointer'])) return false
  if (!isOptionalNonEmptyString(value['computationPointer'])) return false
  if (value['documentRef'] !== undefined && !isResourceRef(value['documentRef'])) return false
  if (!isOptionalNonEmptyString(value['locatorPointer'])) return false
  if (!isOptionalNonEmptyString(value['textDigestPointer'])) return false
  if (!isOptionalNonEmptyString(value['quoteDigestPointer'])) return false
  return true
}

function isTableArtifactRow(value: unknown): value is TableArtifactRow {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['rowKey'])) return false
  if (!isRecord(value['cells'])) return false
  if (!Array.isArray(value['bindings']) || !value['bindings'].every(isTableCellBinding)) return false
  return true
}

export function isTableArtifactPageBody(value: unknown): value is TableArtifactPageBody {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== TABLE_ARTIFACT_PAGE_SCHEMA_VERSION) return false
  if (!isNonEmptyString(value['tableId'])) return false
  if (!isVersionRef(value['outputSchemaRef'])) return false
  if (!isNonNegativeInteger(value['pageIndex'])) return false
  if (!isNonEmptyStringArray(value['columnRefs']) || value['columnRefs'].length === 0) return false
  if (value['columnRefs'].length > MAX_TABLE_COLUMNS) return false
  if (value['rowKeyOrder'] !== 'ascending') return false
  if (!Array.isArray(value['rows']) || value['rows'].length > MAX_TABLE_PAGE_ROWS) return false
  if (!value['rows'].every(isTableArtifactRow)) return false
  if (!isToolCoverage(value['coverage'])) return false
  return true
}

export function isTableVerificationReceipt(value: unknown): value is TableVerificationReceipt {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== TABLE_VERIFICATION_RECEIPT_SCHEMA_VERSION) return false
  if (!isSha256Digest(value['draftHash'])) return false
  if (!isResourceRef(value['resultManifestRef'])) return false
  if (!isSha256Digest(value['resultManifestDigest'])) return false
  if (!isNonEmptyString(value['tableId'])) return false
  if (!Array.isArray(value['pageDigests']) || !value['pageDigests'].every(isSha256Digest)) return false
  if (!isNonNegativeInteger(value['checkedRows'])) return false
  if (!isNonNegativeInteger(value['expectedRows'])) return false
  if (!isNonNegativeInteger(value['checkedCells'])) return false
  if (!isNonNegativeInteger(value['expectedCells'])) return false
  if (!isSha256Digest(value['checksDigest'])) return false
  if (!isNonEmptyString(value['policyVersion'])) return false
  return true
}

export function isTableReadCursor(value: unknown): value is TableReadCursor {
  if (!isRecord(value)) return false
  if (value['version'] !== 1) return false
  if (!isUuid(value['answerId'])) return false
  if (!isNonEmptyString(value['tableId'])) return false
  if (!isResourceRef(value['resultManifestRef'])) return false
  if (!isSha256Digest(value['resultManifestDigest'])) return false
  if (!isSha256Digest(value['scopeDigest'])) return false
  if (!isNonNegativeInteger(value['pageIndex'])) return false
  if (!isOptionalNonEmptyString(value['lastRowKey'])) return false
  return true
}

export function isTablePageReadRequest(value: unknown): value is TablePageReadRequest {
  if (!isRecord(value)) return false
  if (!isUuid(value['answerId'])) return false
  if (!isNonEmptyString(value['tableId'])) return false
  if (value['cursor'] !== undefined && typeof value['cursor'] !== 'string') return false
  return true
}

export function assertTableArtifactManifestShape(value: unknown): asserts value is TableArtifactManifest {
  if (!isTableArtifactManifest(value)) {
    throw invalidTypedResult('table artifact manifest does not match table-artifact-manifest@1')
  }
}

export function assertTypedResultManifestShape(value: unknown): asserts value is TypedResultManifest {
  if (!isTypedResultManifest(value)) {
    throw invalidTypedResult('typed result manifest does not match typed-result-manifest@1')
  }
}

export function assertTableArtifactPageBodyShape(value: unknown): asserts value is TableArtifactPageBody {
  if (!isTableArtifactPageBody(value)) {
    throw invalidTypedResult('table artifact page does not match table-artifact-page@1')
  }
}

export function assertTableVerificationReceiptShape(value: unknown): asserts value is TableVerificationReceipt {
  if (!isTableVerificationReceipt(value)) {
    throw invalidTypedResult('table verification receipt does not match table-verification-receipt@1')
  }
}

function invalidTypedResult(message: string): Error {
  return Object.assign(new Error(message), { name: 'TypedResultContractError' })
}
