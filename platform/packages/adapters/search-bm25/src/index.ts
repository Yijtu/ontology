/**
 * @ontology/adapter-search-bm25 — the first real `DocumentSearchPort` (SPEC
 * ADR-07, C3/C4).
 *
 * It builds a versioned BM25 keyword index per authorized collection from the
 * LOCAL-023 parse/chunk contract, ranks with a genuine Okapi BM25 score, returns
 * original spans with `scoreKind` and the exact index generation, and delegates
 * `readSpan` to the existing span reader instead of re-parsing. Only the keyword
 * mode is registered: `vector` and `hybrid` are refused with `UNSUPPORTED_QUERY`
 * rather than silently degraded. The corpus is isolated per tenant/space, and
 * duplicate copies of identical content collapse to one independent evidence span.
 *
 * The package depends on `contracts`/`core` and `pg` only; it never imports
 * another adapter, an extension, the application layer or a service layer.
 */
export {
  DocumentSearchError,
  asStoreFailure,
  httpStatusForDocumentSearchError,
  isConnectionFailure,
  isDocumentSearchError,
} from './errors'
export type { DocumentSearchErrorCode } from './errors'

export {
  BM25_B,
  BM25_K1,
  bm25Idf,
  bm25TermScore,
  canonicalIndexDigest,
  termFrequencies,
  tokenize,
} from './bm25'
export type { IndexDigestDocument } from './bm25'

export {
  Bm25DocumentSearchService,
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_SEARCH_LIMIT,
  INDEX_REF_VERSION,
  KEYWORD_INDEX_NAMESPACE,
  KEYWORD_INDEX_SCHEMA_VERSION,
  MAX_SEARCH_LIMIT,
} from './service'
export type { Bm25DocumentSearchDependencies } from './service'

export { Bm25IndexBuilder } from './builder'
export type { Bm25IndexBuilderDependencies } from './builder'

export { KEYWORD_INDEX_ACTIVATED_TOPIC, createBm25IndexBuildHandler } from './index-build-stage'
export type { Bm25IndexBuildStageDependencies } from './index-build-stage'

export { createBm25DocumentSearchToolHandler } from './tool-handler'
export type { Bm25DocumentSearchToolDependencies } from './tool-handler'

export { parseDocumentSearchRequest } from './parse'

export { InMemoryKeywordIndexStore } from './memory-store'
export { PostgresKeywordIndexStore } from './postgres-store'
export type { PostgresKeywordIndexStoreConfig } from './postgres-store'

export { decodeCursor, encodeCursor } from './cursor'
export type { SearchCursor, SearchCursorCollection } from './cursor'

export { resolveTrustedScope, scopeKey, trustedScope } from './scope'

export type {
  DocumentSearchDetail,
  DocumentSearchToolHandler,
  DocumentSearchToolOutcome,
  DocumentSearchToolRequest,
  DocumentSearchToolSourceObservation,
  DocumentSearchToolWarning,
  GenerationWriteResult,
  IndexBuildPublicationIntent,
  IndexBuildRequest,
  IndexBuildResult,
  IndexBuildStageContext,
  IndexBuildStageHandler,
  IndexBuildStageOutcome,
  IndexedDocument,
  KeywordIndexGeneration,
  KeywordIndexState,
  KeywordIndexStore,
  MatchingDocumentPage,
  WriteGenerationInput,
} from './types'
