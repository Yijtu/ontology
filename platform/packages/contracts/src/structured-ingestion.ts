import type {
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  SourceRef,
  Uuid,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import type { ParseCoverage } from './document-parse'
import type {
  SourceLocator,
  StructuredFormat,
  StructuredParseIssue,
  StructuredParseOptions,
  StructuredParseStatus,
  StructuredSheetInfo,
} from './structured-parse'

/**
 * Structured ingestion row reconciliation (SPEC v0.3 A §5, A.US-002/P.US-003/P.US-013).
 *
 * The standalone parser (`structured-parse.ts`) is pure over bytes. This contract is the
 * durable side of it through the **existing** jobs/outbox machinery: one ingestion job runs
 * `received → parsed` and records, for the selected table/JSON records, the total rows it saw,
 * how many were captured, how many stayed pending and how many failed, with a locator back to
 * the immutable original for every row. A partial parse is persisted as partial and never
 * reported as a full success (SPEC D4.1/§9).
 *
 * Record identity is stable: `recordId` is derived from the trusted scope + original content
 * digest + source row key, so re-uploading identical bytes resolves to the same logical parse
 * and the same original-record identities. Two rows of the same entity are always two record
 * ids; distinct business records are never collapsed into one.
 */

/** The lifecycle of one source row in a structured parse. */
export type StructuredRecordState = 'parsed' | 'pending' | 'failed' | 'skipped'

/**
 * Queryable row reconciliation. `total = succeeded + pending + failed + skipped` is the
 * accounting the UI reads; a state is never silently folded into another (SPEC A.US-002.AC-02).
 */
export interface StructuredRecordCounts {
  readonly total: number
  readonly succeeded: number
  readonly pending: number
  readonly failed: number
  readonly skipped: number
}

/** A located row failure: the code/message plus the locator into the immutable original. */
export interface StructuredRecordError {
  readonly code: string
  readonly message: string
  readonly locator?: SourceLocator
}

/**
 * One reconciled source row. `sourceRowKey` is stable within the original file revision
 * (sheet + physical row, JSON pointer or text line), and `recordId` is derived from the scope
 * and the original digest so a duplicate import reads back the same original-record identity.
 * The row's values are not copied into the control database — `locator` addresses the exact
 * original cell/row and `rowDigest` is a fingerprint for change detection. A downstream stage
 * re-reads the values through the immutable original, never through a duplicated long table
 * (SPEC §4.1/§5.2).
 */
export interface StructuredRecordEntry {
  readonly recordId: Uuid
  readonly sourceRowKey: string
  /** 1-based record index within the parsed selection. */
  readonly recordIndex: number
  /** 1-based original row number (CSV/XLSX) or record index (JSON/text). */
  readonly row: number
  readonly state: StructuredRecordState
  readonly locator: SourceLocator
  readonly rowDigest: Sha256Digest
  readonly columnCount: number
  readonly error?: StructuredRecordError
}

/** The durable parse run: parser identity, coverage and the reconciliation counters. */
export interface StructuredParseRecord {
  readonly parseId: Uuid
  readonly scopeRef: ScopeRef
  readonly format: StructuredFormat
  readonly originalMediaType: string
  readonly originalRef: ResourceRef
  readonly parserId: string
  readonly parserVersion: Semver
  /** Actual captured native selection; missing only on legacy records, never an implicit default. */
  readonly parseOptions?: Omit<StructuredParseOptions, 'mediaType'>
  readonly status: StructuredParseStatus
  readonly coverage: ParseCoverage
  readonly counts: StructuredRecordCounts
  readonly sheets: readonly StructuredSheetInfo[]
  readonly diagnostics: readonly StructuredParseIssue[]
  readonly sourceRef?: SourceRef
  readonly documentVersionRef?: ResourceRef
  readonly createdAt: Rfc3339UtcTimestamp
}

/** One keyset page of reconciled rows. `nextCursor` is opaque and bound to the parse. */
export interface StructuredRecordPage {
  readonly records: readonly StructuredRecordEntry[]
  readonly total: number
  readonly nextCursor?: string
}

export interface StructuredRecordPageRequest {
  readonly limit: number
  /** Opaque cursor from the previous page; a stale cursor is refused, never silently restarted. */
  readonly cursor?: string
}

export interface StructuredIngestionRequest {
  /** Scope of the original. Cross-checked against the trusted context. */
  readonly scopeRef: ScopeRef
  readonly originalRef: ResourceRef
  /**
   * Selection options (delimiter/quote/sheet/header/range/cap mode). The media type is read
   * from the stored original, never trusted from the request, and is added by the service.
   */
  readonly options: Omit<StructuredParseOptions, 'mediaType'>
  readonly parserVersion?: Semver
  readonly sourceRef?: SourceRef
  readonly documentVersionRef?: ResourceRef
}

/**
 * A parse run as produced by the ingestion service. The reconciled rows are not bundled in:
 * they are read back through `StructuredIngestionStore.listRecords`, so a large import is
 * never hoisted into memory just to answer "did this parse" (SPEC §6: bounded paging).
 */
export interface StructuredIngestionResult {
  readonly parse: StructuredParseRecord
  /** True when an existing parse of the same bytes + parser version was reused. */
  readonly reused: boolean
}

export interface RecordStructuredParseResult {
  readonly created: boolean
}

/**
 * Reads an immutable original, runs the structured parser and persists the parse run plus the
 * reconciled rows. It is idempotent on `(scope, original digest, parser version)`, so a
 * crash-reclaim or a duplicate upload converges on one logical parse.
 */
export interface StructuredIngestionPort {
  parse(request: StructuredIngestionRequest, ctx: ToolContext): Promise<StructuredIngestionResult>
}

/**
 * Control persistence for structured parse runs and reconciled rows. Every method runs in the
 * trusted tenant/space scope; RLS is a second line behind the explicit scope predicate.
 */
export interface StructuredIngestionStore {
  /** Idempotent on (tenant, space, original digest, parser version). Rows are inserted once. */
  recordParse(
    record: StructuredParseRecord,
    entries: readonly StructuredRecordEntry[],
    ctx: ToolContext,
  ): Promise<RecordStructuredParseResult>
  /** The latest parse of these bytes for the exact parser version when given. */
  findParseByDigest(
    scopeRef: ScopeRef,
    originalDigest: Sha256Digest,
    parserVersion: Semver | undefined,
    ctx: ToolContext,
  ): Promise<StructuredParseRecord | undefined>
  /** Bounded keyset page of rows ordered by record index. Never an unbounded read. */
  listRecords(
    scopeRef: ScopeRef,
    parseId: Uuid,
    page: StructuredRecordPageRequest,
    ctx: ToolContext,
  ): Promise<StructuredRecordPage>
  /**
   * Counts over the **materialized** rows by state. This is not the full reconciliation: a
   * truncated parse has pending units with no materialized row, so `StructuredParseRecord.counts`
   * remains the authoritative total.
   */
  countRecords(scopeRef: ScopeRef, parseId: Uuid, ctx: ToolContext): Promise<StructuredRecordCounts>
  /** The located failed rows of one parse, bounded. */
  listFailures(
    scopeRef: ScopeRef,
    parseId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<readonly StructuredRecordEntry[]>
  close(): Promise<void>
}
