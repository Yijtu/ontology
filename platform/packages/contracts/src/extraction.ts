import type {
  DocumentSpan,
  GenerationUsage,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { DocumentChunkRecord } from './document-parse'
import type { ToolContext } from './trusted'
import type {
  RuleConflict,
  RuleExceptionNode,
  RuleExpressionNode,
  RuleImpact,
  RuleReviewRequirement,
  RuleUnhandledReason,
} from './rule-extraction'

/**
 * Entity/relation candidate extraction contracts (SPEC D4, C2/C3, US-012/US-015).
 *
 * This module defines the wire shapes for the extraction pipeline and the two ports it
 * depends on, but no implementation. The pipeline lives in `@ontology/application` and
 * receives `IndustrySchemaSource`, `GenerationPort`, `BudgetLedgerPort` and `CandidateStore`
 * by construction injection, so it imports no adapter, driver or industry package.
 *
 * D4 boundary: extraction is **append-only candidate production**. A candidate is never
 * published truth and can never mutate a definition version or a published fact. It carries
 * the exact source spans it was derived from and the input version it was produced under, so
 * a reviewer can locate the evidence and a later stage can pin the version.
 */

/**
 * The candidate families the extraction pipeline produces. LOCAL-027 produces `entity` and
 * `relation`; LOCAL-028 extends the same pipeline with `rule` (a representable bounded rule
 * AST) and `rule_unhandled` (an expression that could not be represented faithfully).
 */
export type CandidateKind = 'entity' | 'relation' | 'rule' | 'rule_unhandled'

/**
 * Candidate review lifecycle. `produced` is the state an extraction stage writes; the
 * validation stage moves a candidate to `pending_review` (valid, awaiting a human decision)
 * or `failed` (schema/type/reference/span problem). `rejected` is a later review outcome.
 * A candidate is never silently promoted to published truth (D4.6).
 */
export type CandidateState = 'produced' | 'pending_review' | 'failed' | 'rejected'

/**
 * Why a candidate did not cleanly validate. Every code is an explicit, queryable state
 * instead of a dropped row or a coerced value.
 */
export type CandidateIssueCode =
  | 'UNKNOWN_OBJECT'
  | 'UNKNOWN_ATTRIBUTE'
  | 'ATTRIBUTE_NOT_ON_OBJECT'
  | 'TYPE_MISMATCH'
  | 'ENUM_VALUE_INVALID'
  | 'UNIT_MISMATCH'
  | 'CARDINALITY_VIOLATION'
  | 'MISSING_IDENTITY_ATTRIBUTE'
  | 'UNKNOWN_RELATION'
  | 'DANGLING_REFERENCE'
  | 'ENDPOINT_TYPE_MISMATCH'
  | 'SPAN_NOT_RESOLVED'
  | 'TRUNCATED_CHUNK'
  | 'RULE_UNSUPPORTED_EXPRESSION'
  | 'RULE_UNRESOLVED_REFERENCE'
  | 'CONFLICTING_RULE'

export interface CandidateIssue {
  readonly code: CandidateIssueCode
  readonly message: string
  /** Dotted path to the offending field, e.g. `attributes[2].value`. */
  readonly field?: string
}

/** One attribute value on an entity candidate. `unitCode` is required for a quantity. */
export interface CandidateAttributeValue {
  readonly attributeId: string
  readonly value: string | number | boolean
  readonly unitCode?: string
}

/**
 * A candidate's provenance. It references a chunk from the immutable parse (LOCAL-023) by
 * id, keeps the chunk's locator/digests verbatim and never re-parses or rewrites the
 * original. `precision` stays `approximate` for an OCR span, so an approximate locator can
 * never be presented as exact in-page evidence (D3.2).
 */
export interface CandidateSourceSpan {
  readonly parseId: Uuid
  readonly chunkId: Uuid
  readonly locator: DocumentSpan['locator']
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: DocumentChunkRecord['precision']
  readonly quoteDigest: Sha256Digest
  readonly textDigest: Sha256Digest
}

/**
 * A relation endpoint. A new entity in the same run is referenced by `candidateId`; a
 * strong native identifier is referenced by `nativeId`. An endpoint with neither is a
 * dangling reference and must be rejected (D4.3/D4.5).
 */
export interface CandidateEndpoint {
  readonly objectId: string
  readonly candidateId?: Uuid
  readonly nativeId?: string
}

/**
 * The exact input version an extraction was produced under (D3.2/D6): the published
 * definition version, the parse and parser version, the pipeline version and, when known,
 * the document version. A later definition publication never rewrites this binding.
 */
export interface ExtractionInputVersion {
  readonly definitionRef: VersionRef
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly pipelineVersion: Semver
  readonly documentVersionRef?: ResourceRef
}

interface CandidateCommon {
  readonly candidateId: Uuid
  readonly jobId: Uuid
  readonly sourceSpans: readonly CandidateSourceSpan[]
  /**
   * True when a native strong identifier was mapped deterministically and no generation
   * call was made for this candidate (D4.2/D4.4).
   */
  readonly deterministic: boolean
  readonly state: CandidateState
  readonly issues: readonly CandidateIssue[]
  readonly inputVersion: ExtractionInputVersion
  /** Model usage when a generation call produced this candidate. */
  readonly usage?: GenerationUsage
  /** Stable idempotency key derived from the job, chunk, kind and canonical value. */
  readonly idempotencyKey: Sha256Digest
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface EntityCandidate extends CandidateCommon {
  readonly kind: 'entity'
  readonly objectId: string
  readonly identityScopeId?: string
  readonly nativeId?: string
  readonly attributes: readonly CandidateAttributeValue[]
}

export interface RelationCandidate extends CandidateCommon {
  readonly kind: 'relation'
  readonly relationId: string
  readonly from: CandidateEndpoint
  readonly to: CandidateEndpoint
}

/**
 * A representable rule candidate (D4.3/D5, US-013). It carries a bounded AST whose every
 * element is span-linked, the exceptions kept attached to the rule, the applicability scope
 * (`objectId`), the review requirement and any conflicts. It is a candidate only: it can never
 * be published just because its JSON is valid (D4.6).
 */
export interface RuleCandidate extends CandidateCommon {
  readonly kind: 'rule'
  readonly ruleId: string
  /** The applicability scope: the object the constraint applies to. */
  readonly objectId: string
  readonly severity: 'hard' | 'soft'
  readonly impact: RuleImpact
  readonly reviewRequirement: RuleReviewRequirement
  readonly expression: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  /** Contradictory rules on the same scope, surfaced explicitly and never auto-resolved. */
  readonly conflicts: readonly RuleConflict[]
}

/**
 * A rule the extractor could not represent faithfully. It is never weakened into a looser
 * rule; the offending expression is kept verbatim with a classified reason and the candidate
 * enters review (`pending_review`). It carries no executable expression.
 */
export interface RuleUnhandledCandidate extends CandidateCommon {
  readonly kind: 'rule_unhandled'
  readonly ruleId?: string
  readonly reason: RuleUnhandledReason
  readonly detail: string
  /** The offending model expression, preserved verbatim so nothing is lost. */
  readonly rawExpression: string
}

export type CandidateRecord =
  | EntityCandidate
  | RelationCandidate
  | RuleCandidate
  | RuleUnhandledCandidate

export interface CandidateInsertResult {
  readonly inserted: number
  readonly existing: number
  /** Ids of every candidate now stored, whether inserted or already present. */
  readonly candidateIds: readonly Uuid[]
}

export interface CandidateQuery {
  readonly jobId?: Uuid
  readonly state?: CandidateState
  readonly kind?: CandidateKind
  /** Bounded page size; a caller never reads an unbounded candidate table. */
  readonly limit?: number
}

/** An explicit, idempotent state transition. The candidate payload is never mutated. */
export interface CandidateStateTransition {
  readonly state: CandidateState
  readonly issues: readonly CandidateIssue[]
  readonly transitionedAt: Rfc3339UtcTimestamp
}

export interface CandidateStateCounts {
  readonly total: number
  readonly produced: number
  readonly pendingReview: number
  readonly failed: number
  readonly rejected: number
}

/**
 * Control persistence for extraction candidates (D2/D4). Every method runs in the trusted
 * tenant/space scope and RLS is a second layer behind the explicit scope predicate.
 * `insertCandidates` is idempotent on `idempotencyKey`, so a re-run after a crash (or a
 * stage-precise retry) never duplicates a candidate.
 */
export interface CandidateStore {
  insertCandidates(
    scopeRef: ScopeRef,
    candidates: readonly CandidateRecord[],
    ctx: ToolContext,
  ): Promise<CandidateInsertResult>
  getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateRecord | undefined>
  listCandidates(scopeRef: ScopeRef, query: CandidateQuery, ctx: ToolContext): Promise<CandidateRecord[]>
  transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: CandidateStateTransition,
    ctx: ToolContext,
  ): Promise<CandidateRecord>
  countCandidates(scopeRef: ScopeRef, jobId: Uuid, ctx: ToolContext): Promise<CandidateStateCounts>
}

export type CandidateStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_STORE_FAILED'

export class CandidateStoreError extends Error {
  readonly code: CandidateStoreErrorCode

  constructor(code: CandidateStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CandidateStoreError'
    this.code = code
  }
}

/**
 * Read-only projection of a published definition version, narrowed to what candidate
 * validation and deterministic native mapping need. The authoritative definition model
 * lives in `@ontology/semantic-engine`; this view is the cross-boundary contract the
 * application layer consumes without importing that service package.
 */
export type IndustryAttributeValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'enum'
  | 'quantity'
  | 'reference'

export interface IndustryAttributeSchema {
  readonly attributeId: string
  readonly valueType: IndustryAttributeValueType
  readonly minCardinality: number
  readonly maxCardinality: number | 'unbounded'
  readonly identityKey: boolean
  readonly unitCode?: string
  readonly dimension?: string
  readonly enumValues?: readonly string[]
  readonly referencesObjectId?: string
}

export interface IndustryObjectSchema {
  readonly objectId: string
  readonly displayName: string
  readonly identityScopeId: string
  readonly attributes: readonly IndustryAttributeSchema[]
}

export interface IndustryRelationSchema {
  readonly relationId: string
  readonly fromObjectId: string
  readonly toObjectId: string
  readonly minCardinality: number
  readonly maxCardinality: number | 'unbounded'
}

export interface IndustryIdentityScopeSchema {
  readonly identityScopeId: string
  readonly objectId: string
  readonly scopeDimensions: readonly string[]
  readonly identityAttributeIds: readonly string[]
}

export interface IndustrySchema {
  readonly namespace: string
  readonly definitionRef: VersionRef
  readonly objects: readonly IndustryObjectSchema[]
  readonly relations: readonly IndustryRelationSchema[]
  readonly identityScopes: readonly IndustryIdentityScopeSchema[]
}

/**
 * Resolves the published definition version a run extracts against. Returning `undefined`
 * means the version is not visible in the scope and the pipeline must fail explicitly
 * rather than invent a schema.
 */
export interface IndustrySchemaSource {
  getSchema(
    scopeRef: ScopeRef,
    definitionRef: VersionRef,
    ctx: ToolContext,
  ): Promise<IndustrySchema | undefined>
}
