import type {
  CompletenessStatus,
  DocumentSpan,
  ReadSpanRequest,
  ReadSpanResponse,
  Rfc3339UtcTimestamp,
  ResourceRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  SourceRef,
  Uuid,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Document extraction port (SPEC D3.2/D4.1, C3). The search contract
 * (`DocumentSearchPort`) locates chunks; this contract produces them and maps
 * every chunk back to the original document version.
 *
 * The port is genuinely separate from `DocumentSearchPort` because parsing and
 * span reading must exist before any keyword/vector index does: `DocumentSearchPort.search`
 * is LOCAL-024, while parse + `readSpan` are LOCAL-023. A search backend composes
 * this reader instead of re-deriving spans.
 */

/** Structure the chunker preserves. `page` is the fallback for unclassified text. */
export type ChunkKind = 'section' | 'clause' | 'table' | 'paragraph' | 'page'

/** Parse outcome. `partial` must never be reported as `complete` (SPEC D4.1/§9). */
export type ParseStatus = 'complete' | 'partial' | 'failed'

/**
 * Whether a span can be reproduced exactly from the source, or whether it only
 * approximates it (OCR / image-only page). An approximate locator must never be
 * presented as exact in-page evidence (D3.2).
 */
export type SpanPrecision = 'exact' | 'approximate'

/**
 * What `startOffset`/`endOffset` count. Plain text uses byte offsets into the
 * immutable original so a span round-trips to the source bytes; a PDF has no
 * byte-addressable text, so it uses character offsets into the normalized text
 * artifact and carries `normalizationMapRef`.
 */
export type OffsetUnit = 'byte' | 'character'

export type DocumentMediaKind = 'pdf' | 'text'

/** What the parser covered, what it skipped and why (SPEC D4.1/D4.3). */
export interface ParseCoverage {
  readonly status: ParseStatus
  readonly completeness: CompletenessStatus
  readonly totalUnits: number
  readonly parsedUnits: number
  readonly skippedUnits: number
  readonly skippedReasons: readonly string[]
  readonly notes: readonly string[]
}

/** A page of the source, with the range it occupies in the normalized text. */
export interface DocumentPageRecord {
  readonly page: number
  readonly startOffset: number
  readonly endOffset: number
  /** True when the page text came from OCR, so its locations are approximate. */
  readonly approximate: boolean
}

/**
 * One retrievable chunk. `text` is the full chunk (qualifier included), while
 * `conditions`/`exceptions`/`caption`/`tableHeader` expose the context the
 * chunker deliberately kept attached instead of splitting off.
 */
export interface DocumentChunkRecord {
  readonly chunkId: Uuid
  readonly ordinal: number
  readonly chunkKind: ChunkKind
  readonly heading?: string
  readonly text: string
  readonly textDigest: Sha256Digest
  readonly locator: DocumentSpan['locator']
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: SpanPrecision
  readonly quoteDigest: Sha256Digest
  readonly conditions: readonly string[]
  readonly exceptions: readonly string[]
  readonly caption?: string
  readonly tableHeader?: string
  readonly parentChunkId?: Uuid
}

/** A durable parse run: parser identity, coverage and the artifacts it produced. */
export interface DocumentParseRecord {
  readonly parseId: Uuid
  readonly scopeRef: ScopeRef
  readonly mediaKind: DocumentMediaKind
  readonly originalMediaType: string
  /** The immutable original bytes. Never rewritten by parsing. */
  readonly originalRef: ResourceRef
  readonly normalizedMediaType: string
  readonly normalizedByteSize: number
  /** Derived normalized text artifact. */
  readonly normalizedRef: ResourceRef
  readonly spanMapMediaType: string
  /** Derived span-map artifact: original ↔ normalized ↔ chunks. */
  readonly spanMapRef: ResourceRef
  readonly parserId: string
  readonly parserVersion: Semver
  readonly offsetUnit: OffsetUnit
  readonly coverage: ParseCoverage
  readonly pages: readonly DocumentPageRecord[]
  readonly sourceRef?: SourceRef
  readonly documentVersionRef?: ResourceRef
  readonly createdAt: Rfc3339UtcTimestamp
}

/** The parse result returned to a caller, including the chunks to index. */
export interface ParsedDocument extends DocumentParseRecord {
  readonly chunks: readonly DocumentChunkRecord[]
  /** True when an existing parse of the same bytes + parser version was reused. */
  readonly reused: boolean
}

export interface DocumentParseRequest {
  /** Scope of the original. Cross-checked against the trusted context. */
  readonly scopeRef: ScopeRef
  readonly originalRef: ResourceRef
  readonly parserVersion?: Semver
  readonly sourceRef?: SourceRef
  readonly documentVersionRef?: ResourceRef
  /** Bounded page budget. Pages beyond it are skipped, not silently dropped. */
  readonly maxPages?: number
}

/** Parses an immutable original into traceable chunks. Never mutates the original. */
export interface DocumentParserPort {
  parse(request: DocumentParseRequest, ctx: ToolContext): Promise<ParsedDocument>
}

/**
 * Reads the exact source text for a span. A byte-offset span on plain text
 * returns the original bytes; a page span returns the normalized text range and
 * the caller learns from `DocumentSpan` whether the location is approximate.
 */
export interface DocumentSpanReaderPort {
  readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse>
}

export interface RecordDocumentParseResult {
  readonly created: boolean
}

/**
 * Control persistence for parse runs and chunks (D3.2/D4.1). Every method runs
 * in the trusted tenant/space scope; RLS is a second layer behind the explicit
 * scope predicate. Chunks stay queryable so a later search node can index them
 * without re-parsing.
 */
export interface DocumentParseStore {
  /** Idempotent on (tenant, space, original digest, parser version). */
  recordParse(
    record: DocumentParseRecord,
    chunks: readonly DocumentChunkRecord[],
    ctx: ToolContext,
  ): Promise<RecordDocumentParseResult>
  /**
   * The latest parse of these bytes, or the exact parser version when given.
   * A reader resolves the latest; the parser resolves its own version so a
   * re-parse under a new parser version never reuses the wrong record.
   */
  findParseByDigest(
    scopeRef: ScopeRef,
    originalDigest: Sha256Digest,
    parserVersion: Semver | undefined,
    ctx: ToolContext,
  ): Promise<DocumentParseRecord | undefined>
  listChunks(scopeRef: ScopeRef, parseId: Uuid, ctx: ToolContext): Promise<DocumentChunkRecord[]>
  /** Bounded enumeration for an indexer; never an unbounded full-table read. */
  listChunksByScope(
    scopeRef: ScopeRef,
    limit: number,
    ctx: ToolContext,
  ): Promise<DocumentChunkRecord[]>
  close(): Promise<void>
}
