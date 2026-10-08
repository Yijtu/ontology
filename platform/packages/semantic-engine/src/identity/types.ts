import type {
  BudgetLedgerPort,
  CatalogPort,
  CompletenessStatus,
  ConsistencyLevel,
  DocumentSearchPort,
  EntityCandidate,
  GenerationUsage,
  IndustrySchemaSource,
  ModelRef,
  Rfc3339UtcTimestamp,
  ResourceRef,
  SourceSnapshot,
  StructuredQueryPort,
  ToolContext,
  ToolUsage,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { CompilationBudget, SemanticMappingRegistry } from '../mapping'

/**
 * Entity-candidate recall and identity scoping (SPEC D4.4, US-014.A1, C3).
 *
 * This module owns the *retrieval* half of identity resolution: given one extracted
 * entity candidate (a mention), it returns a bounded, ranked set of already-known
 * entities the mention might denote. It never decides `match/create/clarify/reject`
 * (that is LOCAL-030) and it never publishes.
 *
 * Three invariants shape every type here:
 *  - The recall is scoped by the trusted tenant/space **and** by the identity scope
 *    declared in the published definition, never by a display name. A stable native id
 *    and a confirmed alias always outrank a fuzzy name match.
 *  - The pre-normalisation text, the strategy that produced each candidate and the
 *    truncation state are preserved, so a caller can audit the recall.
 *  - A bounded top-k recall that returns no candidate is `undecided`; it is never proof
 *    that the entity does not exist (`coverage.boundedRecall`).
 */

/** Which recall layer produced a candidate. Earlier layers always outrank later ones. */
export type RecallStrategy = 'strong_identifier' | 'confirmed_alias' | 'context' | 'similarity'

/**
 * `candidates`: at least one known entity was recalled.
 * `undecided`: the bounded recall returned nothing; the caller must clarify, not assume
 * the entity is absent.
 */
export type IdentityRecallOutcome = 'candidates' | 'undecided'

export type IdentityUndecidedReason = 'NO_CANDIDATE'

/** A value for one dimension the identity scope declares (source/site/type/...). */
export interface IdentityScopeDimension {
  readonly dimension: string
  readonly value: string
}

/**
 * One denormalised identity-index row: a known entity, optionally observed under one
 * confirmed alias with its own valid interval. A relation can hold several alias rows per
 * entity; the readers collapse them by `entityId` before ranking.
 */
export interface IdentityIndexEntry {
  readonly tenantId: string
  readonly spaceId: string
  readonly entityId: string
  readonly objectId: string
  readonly identityScopeId: string
  readonly nativeId?: string
  readonly displayName: string
  readonly normalizedName: string
  readonly alias?: string
  readonly aliasNormalized?: string
  readonly aliasConfirmed: boolean
  readonly aliasValidFrom?: Rfc3339UtcTimestamp
  readonly aliasValidTo?: Rfc3339UtcTimestamp
  readonly site?: string
  readonly entityType?: string
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  /** Values for the scope dimensions, used by the in-memory reference reader. */
  readonly dimensions?: Readonly<Record<string, string>>
}

/**
 * The layered match a reader must apply. A strong identifier is an exact native id; a
 * confirmed alias is an exact normalised alias that is valid at `validAt`; a context
 * match is a bounded lookup by object type / site / normalised name, used only when the
 * two stronger layers produced nothing.
 */
export type IdentityIndexMatch =
  | { readonly kind: 'strong_identifier'; readonly nativeId: string }
  | {
      readonly kind: 'confirmed_alias'
      readonly normalizedAlias: string
      readonly validAt?: Rfc3339UtcTimestamp
    }
  | {
      readonly kind: 'context'
      readonly normalizedName?: string
      readonly entityType?: string
      readonly site?: string
      readonly validAt?: Rfc3339UtcTimestamp
    }

/**
 * A bounded, fully-scoped identity-index query. `tenantId`/`spaceId` and every declared
 * scope dimension are always present, so a reader can never widen the scope on its own.
 */
export interface IdentityIndexQuery {
  readonly objectId: string
  readonly identityScopeId: string
  readonly tenantId: string
  readonly spaceId: string
  readonly scopeDimensions: readonly IdentityScopeDimension[]
  readonly match: IdentityIndexMatch
  readonly limit: number
}

export interface IdentityIndexPage {
  readonly entries: readonly IdentityIndexEntry[]
  /** True when more rows matched than the bounded page returned. */
  readonly truncated: boolean
  /** Distinct entities matching in the recall range, when the reader can compute it. */
  readonly knownTotal?: number
  readonly schemaRevision?: string
  readonly snapshot: SourceSnapshot
}

/**
 * Read side of the identity index. Implementations receive the query fully scoped and
 * must apply every scope dimension; they never read the request scope from anywhere else.
 * The production reader goes through `StructuredQueryPort`; the in-memory reference reader
 * backs unit tests and never touches a database.
 */
export interface IdentityIndexReader {
  query(query: IdentityIndexQuery, ctx: ToolContext): Promise<IdentityIndexPage>
}

/** Logical identity-index roles the structured reader resolves to confirmed mapping fields. */
export interface IdentityIndexFieldRefs {
  readonly entityId: string
  readonly objectId: string
  readonly identityScopeId: string
  readonly nativeId: string
  readonly displayName: string
  readonly normalizedName: string
  readonly alias: string
  readonly aliasNormalized: string
  readonly aliasConfirmed: string
  readonly aliasValidFrom: string
  readonly aliasValidTo: string
  readonly site: string
  readonly entityType: string
  readonly validFrom: string
  readonly validTo: string
  readonly tenantId: string
  readonly spaceId: string
}

/**
 * Deployment-side mapping from the logical identity index to a confirmed semantic mapping.
 * It carries no physical column name itself: the mapping version pins those (INV-03).
 */
export interface IdentityIndexProfile {
  readonly mappingRef: VersionRef
  readonly conceptId: string
  readonly fields: IdentityIndexFieldRefs
  /** Scope dimension name (from the definition) → confirmed field ref. */
  readonly dimensionFieldRefs: Readonly<Record<string, string>>
}

export interface StructuredIdentityIndexReaderDependencies {
  readonly query: StructuredQueryPort
  /** Optional catalog check that the mapped resources are visible in the scope. */
  readonly catalog?: CatalogPort
  readonly mappings: SemanticMappingRegistry
  readonly profile: IdentityIndexProfile
  readonly compileBudget: CompilationBudget
  readonly consistency?: ConsistencyLevel
  readonly now?: () => string
}

/** One bounded comparison request. `candidates` is already bounded by the recall limit. */
export interface SimilarityComparisonRequest {
  readonly mentionId: Uuid
  readonly mentionText: string
  readonly candidates: readonly { readonly entityId: string; readonly label: string }[]
}

export interface SimilarityCandidateScore {
  readonly entityId: string
  readonly score: number
}

export interface SimilarityComparison {
  readonly scores: readonly SimilarityCandidateScore[]
  readonly backendRef: VersionRef
  readonly modelRef?: ModelRef
  readonly usage: GenerationUsage
}

/**
 * Optional model-backed similarity backend (D4.4 layer 4). It is used only when it is
 * explicitly mounted; when it is absent the recall reports `similarity.available=false`
 * instead of presenting a keyword-only result as a similarity result. A backend receives
 * the already-generated, bounded candidate set and never the whole corpus.
 */
export interface SimilarityBackend {
  readonly backendRef: VersionRef
  compare(request: SimilarityComparisonRequest, ctx: ToolContext): Promise<SimilarityComparison>
}

/** One extracted entity mention to recall known identities for. */
export interface EntityRecallRequest {
  /** Host-pinned project isolation; the index must have a confirmed `project` dimension mapping. */
  readonly projectId?: Uuid
  /** The published definition version the candidate was extracted under. */
  readonly definitionRef: VersionRef
  readonly candidate: EntityCandidate
  /** Text exactly as observed, before any normalisation. Preserved verbatim in the result. */
  readonly observedText: string
  /** One value per identity-scope dimension declared by the definition. */
  readonly scopeDimensionValues: Readonly<Record<string, string>>
  readonly validAt?: Rfc3339UtcTimestamp
  /** Bounded recall size; clamped to the service ceiling. */
  readonly limit?: number
  /** Authorized document collections used for context evidence. */
  readonly contextCollections?: readonly string[]
  /** When false, the optional similarity layer is skipped even if a backend is mounted. */
  readonly allowSimilarity?: boolean
  readonly ledgerId?: Uuid
}

export interface IdentityCandidate {
  readonly entityId: string
  readonly objectId: string
  readonly identityScopeId: string
  readonly strategy: RecallStrategy
  readonly matchedValue: string
  readonly stableId: boolean
  readonly aliasConfirmed: boolean
  readonly displayName?: string
  readonly alias?: string
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly aliasValidFrom?: Rfc3339UtcTimestamp
  readonly aliasValidTo?: Rfc3339UtcTimestamp
  readonly score?: number
  /** 1-based position after precedence ranking. */
  readonly rank: number
  readonly evidenceRefs: readonly ResourceRef[]
}

export interface IdentityRecallTruncation {
  readonly truncated: boolean
  readonly limit: number
  /** Candidate generation is always bounded; it never scans the whole corpus pairwise. */
  readonly boundedCandidateGeneration: true
}

export interface IdentityDocumentContext {
  readonly performed: boolean
  readonly spans: number
  readonly completeness: CompletenessStatus
}

export interface IdentitySimilarityInfo {
  readonly available: boolean
  readonly reason?: 'NOT_CONFIGURED' | 'NO_CANDIDATES' | 'SKIPPED'
  readonly backendRef?: VersionRef
  readonly modelRef?: ModelRef
  /** Number of bounded comparison calls made (0 when the backend is absent). */
  readonly comparisons: number
}

/**
 * Coverage of the bounded recall. `boundedRecall` is a literal `true` so a caller cannot
 * read the result as a complete enumeration of the corpus (C4: top-k recall is not proof
 * of non-existence).
 */
export interface IdentityRecallCoverage {
  readonly returned: number
  readonly knownTotal?: number
  readonly truncated: boolean
  readonly completeness: CompletenessStatus
  readonly boundedRecall: true
  readonly strategies: readonly RecallStrategy[]
  readonly documentContext: IdentityDocumentContext
}

export interface IdentityRecallResult {
  readonly outcome: IdentityRecallOutcome
  readonly reason?: IdentityUndecidedReason
  readonly candidateId: Uuid
  readonly objectId: string
  readonly identityScopeId: string
  readonly observedText: string
  readonly normalizedText: string
  readonly candidates: readonly IdentityCandidate[]
  /** Layers attempted, in precedence order; each candidate names the layer that produced it. */
  readonly strategiesUsed: readonly RecallStrategy[]
  readonly truncation: IdentityRecallTruncation
  readonly coverage: IdentityRecallCoverage
  readonly sourceSnapshots: readonly SourceSnapshot[]
  readonly documentContext: IdentityDocumentContext
  readonly similarity: IdentitySimilarityInfo
  readonly usage?: ToolUsage
}

export interface EntityCandidateRecallDependencies {
  /** Published definitions; the identity scope is resolved from here, never from a name. */
  readonly schemaSource: IndustrySchemaSource
  /** Bounded identity-index reader (production: StructuredQueryPort; tests: in-memory). */
  readonly index: IdentityIndexReader
  /** Optional document context evidence via the real `DocumentSearchPort`. */
  readonly documents?: DocumentSearchPort
  /** Optional model-backed similarity layer; absent means the path is unavailable. */
  readonly similarity?: SimilarityBackend
  /** Shared budget ledger, required when a model-backed comparison runs. */
  readonly budget?: BudgetLedgerPort
  /** Conservative token estimate reserved before a similarity comparison. */
  readonly similarityTokenEstimate?: number
}
