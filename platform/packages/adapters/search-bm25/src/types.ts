import type {
  BudgetLedgerPort,
  CompletenessStatus,
  ConsistencyLevel,
  DocumentSearchResponse,
  DocumentSpan,
  DocumentSearchOutput,
  DocumentParseRecord,
  JobAttemptRecord,
  JobStageCounts,
  LogicalJobRecord,
  NewOutboxMessage,
  PipelineStage,
  ResultLimits,
  RevisionString,
  Rfc3339UtcTimestamp,
  ResourceRef,
  RunnableJobStage,
  ScopeRef,
  Sha256Digest,
  SourceRef,
  SourceWatermark,
  SpanPrecision,
  ToolContext,
  ToolCoverage,
  ToolId,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

/**
 * One retrievable chunk in a keyword index generation. The span fields come
 * straight from the LOCAL-023 parse contract (`DocumentChunkRecord`), so a search
 * hit round-trips to the original document through the same locator without the
 * search backend re-parsing anything.
 */
export interface IndexedDocument {
  readonly chunkId: Uuid
  readonly parseId: Uuid
  /** The immutable original the span points at (`kind: 'document'`). */
  readonly documentRef: ResourceRef
  /**
   * Content digest of the underlying document. Two copies of identical bytes share
   * it, so it is the lineage key used to stop duplicates counting as independent
   * evidence (SPEC D3.2).
   */
  readonly documentDigest: Sha256Digest
  readonly sourceRef?: SourceRef
  readonly mediaType: string
  readonly text: string
  readonly textDigest: Sha256Digest
  readonly locator: DocumentSpan['locator']
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: SpanPrecision
  readonly quoteDigest: Sha256Digest
  readonly ordinal: number
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly length: number
  readonly termFrequencies: ReadonlyMap<string, number>
}

export type KeywordIndexState = 'staged' | 'active' | 'superseded'

/** One immutable, versioned keyword index over one authorized collection. */
export interface KeywordIndexGeneration {
  readonly collectionRef: string
  /** Monotonic per collection, rendered as a decimal string (`RevisionString`). */
  readonly generation: RevisionString
  /** Digest of the indexed corpus; a changed corpus yields a different digest. */
  readonly indexDigest: Sha256Digest
  readonly indexRef: VersionRef
  readonly docCount: number
  readonly avgDocLength: number
  /** Whether the build covered every requested chunk (`complete`) or not. */
  readonly completeness: CompletenessStatus
  readonly state: KeywordIndexState
  readonly builtAt: Rfc3339UtcTimestamp
}

export interface WriteGenerationInput {
  readonly collectionRef: string
  readonly generation: RevisionString
  readonly indexDigest: Sha256Digest
  readonly indexRef: VersionRef
  readonly docCount: number
  readonly avgDocLength: number
  readonly completeness: CompletenessStatus
  readonly builtAt: Rfc3339UtcTimestamp
  readonly documents: readonly IndexedDocument[]
}

export interface GenerationWriteResult {
  readonly generation: KeywordIndexGeneration
  /** `false` when an identical generation already existed and was reused. */
  readonly created: boolean
}

export interface MatchingDocumentPage {
  readonly documents: readonly IndexedDocument[]
  /** True when the corpus held more matching documents than the bounded page. */
  readonly truncated: boolean
}

/**
 * Persistence port for versioned keyword indexes. It is deliberately adapter-local
 * (not a cross-process contract): the public contract is `DocumentSearchPort`, and
 * only the BM25 adapter needs to read its own index. Every method runs inside the
 * trusted tenant/space scope, and RLS is a second line behind the explicit scope
 * predicate.
 */
export interface KeywordIndexStore {
  /**
   * Atomically commit one generation. Either the generation row and all of its
   * documents and postings become visible together, or none do, so a crash while
   * writing can never leave a half-built generation to be published.
   */
  writeGeneration(
    scopeRef: ScopeRef,
    input: WriteGenerationInput,
    ctx: ToolContext,
  ): Promise<GenerationWriteResult>
  getGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined>
  findGenerationByDigest(
    scopeRef: ScopeRef,
    collectionRef: string,
    indexDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined>
  getActiveGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined>
  activateGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    activatedAt: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration>
  listGenerations(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration[]>
  /** Documents containing at least one of `terms`, bounded by `limit`. */
  listMatchingDocuments(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    terms: readonly string[],
    limit: number,
    ctx: ToolContext,
  ): Promise<MatchingDocumentPage>
  close(): Promise<void>
}

export interface IndexBuildRequest {
  readonly collectionRef: string
  /**
   * The parsed documents that make up this collection. The builder consumes the
   * LOCAL-023 parse/chunk contract and never re-parses; the composition root (the
   * index-build job stage) resolves which parses belong to the collection.
   */
  readonly parses: readonly DocumentParseRecord[]
}

export interface IndexBuildResult {
  readonly generation: KeywordIndexGeneration
  /** `false` when the identical corpus was already indexed and reused. */
  readonly created: boolean
  readonly documentCount: number
}

/**
 * Richer search result used by the tool handler. The public `DocumentSearchPort`
 * response has no coverage field (coverage is a unified `ToolResult` concern), so
 * the adapter exposes the recall-range statistics the handler needs to build an
 * honest `ToolCoverage`.
 */
export interface DocumentSearchDetail {
  readonly response: DocumentSearchResponse
  /** Distinct documents matching the query in the recall range (dedup aware). */
  readonly matchedTotal: number
  readonly truncated: boolean
  readonly indexDocumentCount: number
  /** Duplicate copies collapsed so they do not count as independent evidence. */
  readonly duplicatesCollapsed: number
}

/**
 * Structural mirror of the application layer's job-stage handler contract
 * (`@ontology/application`). It is re-declared here because an adapter may not
 * import the application layer (SPEC §2); the shapes are identical, so the
 * composition root can register this handler with the real `JobWorker`.
 */
export interface IndexBuildStageContext {
  readonly job: LogicalJobRecord
  readonly attempt: JobAttemptRecord
  readonly budget: BudgetLedgerPort
  readonly ledgerId: Uuid
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}

export interface IndexBuildPublicationIntent {
  readonly publicationKey: string
  readonly versionRef: VersionRef
  readonly outboxTopic: string
  readonly outboxPayload: Readonly<Record<string, unknown>>
}

export interface IndexBuildStageOutcome {
  readonly nextStage: PipelineStage
  readonly counts: JobStageCounts
  readonly outbox?: NewOutboxMessage
  readonly publication?: IndexBuildPublicationIntent
}

export interface IndexBuildStageHandler {
  readonly stage: RunnableJobStage
  run(context: IndexBuildStageContext): Promise<IndexBuildStageOutcome>
}

/**
 * Structural mirror of the tool-services `ToolHandler` contract. Re-declared for
 * the same layer reason: the adapter depends on `contracts`/`core` only.
 */
export interface DocumentSearchToolRequest {
  readonly callId: Uuid
  readonly toolId: ToolId
  readonly arguments: Readonly<Record<string, unknown>>
  readonly resultLimits: ResultLimits
  readonly deadline: Rfc3339UtcTimestamp
  readonly traceId: string
  readonly signal: AbortSignal
}

export interface DocumentSearchToolSourceObservation {
  readonly sourceRef: SourceRef
  readonly schemaVersion: string
  readonly asOf?: Rfc3339UtcTimestamp
  readonly watermark?: SourceWatermark
  readonly consistency: ConsistencyLevel
  readonly resultDigest?: string
}

export interface DocumentSearchToolWarning {
  readonly code: string
  readonly message: string
}

export interface DocumentSearchToolOutcome {
  readonly payload: DocumentSearchOutput
  readonly status: 'ok' | 'partial' | 'empty'
  readonly coverage: ToolCoverage
  readonly sources: readonly DocumentSearchToolSourceObservation[]
  readonly warnings?: readonly DocumentSearchToolWarning[]
}

export interface DocumentSearchToolHandler {
  readonly toolId: ToolId
  execute(request: DocumentSearchToolRequest): Promise<DocumentSearchToolOutcome>
}
