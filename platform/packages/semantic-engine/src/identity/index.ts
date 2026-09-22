/**
 * Entity-candidate recall and identity scoping (SPEC D4.4, US-014.A1).
 *
 * The module resolves the identity scope from the published definition, layers bounded
 * recall strategies (strong identifier → confirmed valid-time alias → type/site/context)
 * and an optional, explicitly-mounted similarity pass. It never scans the corpus pairwise,
 * never decides identity and never publishes.
 */
export { EntityCandidateRecallService, DEFAULT_RECALL_LIMIT, MAX_RECALL_LIMIT } from './recall-service'
export { InMemoryIdentityIndexReader, IDENTITY_INDEX_NAMESPACE } from './in-memory-reader'
export { StructuredIdentityIndexReader } from './structured-reader'
export { containsValidAt, normalizeIdentityText, uniqueStrings } from './canonical'
export { IdentityRecallError, isIdentityRecallError } from './errors'
export type { IdentityRecallErrorCode } from './errors'
export type {
  EntityCandidateRecallDependencies,
  EntityRecallRequest,
  IdentityCandidate,
  IdentityDocumentContext,
  IdentityIndexEntry,
  IdentityIndexFieldRefs,
  IdentityIndexMatch,
  IdentityIndexPage,
  IdentityIndexProfile,
  IdentityIndexQuery,
  IdentityIndexReader,
  IdentityRecallCoverage,
  IdentityRecallOutcome,
  IdentityRecallResult,
  IdentityRecallTruncation,
  IdentityScopeDimension,
  IdentitySimilarityInfo,
  IdentityUndecidedReason,
  RecallStrategy,
  SimilarityBackend,
  SimilarityCandidateScore,
  SimilarityComparison,
  SimilarityComparisonRequest,
  StructuredIdentityIndexReaderDependencies,
} from './types'
