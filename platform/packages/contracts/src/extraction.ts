import type {
  DecimalString,
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
import type { SourceLocator } from './structured-parse'
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
  | 'INVALID_DECIMAL'
  | 'ENUM_VALUE_INVALID'
  | 'UNIT_MISMATCH'
  | 'CARDINALITY_VIOLATION'
  | 'MISSING_IDENTITY_ATTRIBUTE'
  | 'UNKNOWN_RELATION'
  | 'DANGLING_REFERENCE'
  | 'UNRESOLVED_ENDPOINT'
  | 'ENDPOINT_TYPE_MISMATCH'
  | 'SPAN_NOT_RESOLVED'
  | 'TRUNCATED_CHUNK'
  | 'RULE_UNSUPPORTED_EXPRESSION'
  | 'INVALID_RULE_CONCLUSION'
  | 'RULE_UNRESOLVED_REFERENCE'
  | 'CONFLICTING_RULE'

export interface CandidateIssue {
  readonly code: CandidateIssueCode
  readonly message: string
  /** Dotted path to the offending field, e.g. `attributes[2].value`. */
  readonly field?: string
}

/**
 * One attribute value on an entity candidate. `unitCode` is required for a quantity.
 *
 * Both the canonical value and, when the source carried one, the raw lexical token are
 * preserved (SPEC v0.3 A §5.3, P.US-008.AC-02). A quantity is never first coerced to a
 * lossy JavaScript `Number`: the canonical value is the exact `DecimalString` and `raw`
 * keeps the verbatim source token, so a precision-preserving reader can round-trip it.
 */
export interface CandidateAttributeValue {
  readonly attributeId: string
  /**
   * The canonical value. For a quantity this is the exact decimal string (`DecimalString`);
   * a finite `number` is only accepted for legacy historical records, never for new input.
   */
  readonly value: string | number | boolean
  /** The verbatim source token the value was derived from, when the source supplied one. */
  readonly raw?: string
  /** Present for an exactly parsed quantity; never produced through a lossy `Number`. */
  readonly decimal?: DecimalString
  readonly unitCode?: string
}

/**
 * A candidate's provenance. It references a chunk from the immutable parse (LOCAL-023) by
 * id, keeps the chunk's locator/digests verbatim and never re-parses or rewrites the
 * original. `precision` stays `approximate` for an OCR span, so an approximate locator can
 * never be presented as exact in-page evidence (D3.2).
 *
 * `kind` is optional and defaults to a text/PDF chunk span; a structured row span carries
 * `kind: 'structured'` instead, so the two families are never confused when a locator is
 * read back (SPEC v0.3 A §5.2).
 */
export interface TextCandidateSourceSpan {
  readonly kind?: 'text'
  readonly parseId: Uuid
  readonly chunkId: Uuid
  readonly locator: DocumentSpan['locator']
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: DocumentChunkRecord['precision']
  readonly quoteDigest: Sha256Digest
  readonly textDigest: Sha256Digest
}

/**
 * The provenance of a candidate derived from one reconciled structured row (V03-006). It
 * carries the durable record identity and the exact `SourceLocator` (JSON pointer / table
 * cell / table row) rather than a text chunk, so a reviewer can resolve the original cell.
 */
export interface StructuredCandidateSourceSpan {
  readonly kind: 'structured'
  readonly parseId: Uuid
  readonly recordId: Uuid
  readonly sourceRowKey: string
  readonly locator: SourceLocator
  readonly rowDigest: Sha256Digest
}

export type CandidateSourceSpan = TextCandidateSourceSpan | StructuredCandidateSourceSpan

/**
 * Reduce a candidate source span to the immutable artifact reference it is grounded in.
 * A text/PDF span points at its chunk; a structured span points at the located original
 * record. Centralising this keeps publication, recall and identity evidence consistent.
 */
export function candidateSourceRef(span: CandidateSourceSpan, parserVersion: Semver): ResourceRef {
  return span.kind === 'structured'
    ? { id: span.recordId, version: parserVersion, digest: span.rowDigest, kind: 'chunk' }
    : { id: span.chunkId, version: parserVersion, digest: span.quoteDigest, kind: 'chunk' }
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
  /**
   * Why the endpoint could not be resolved to a produced entity or a strong native id.
   * `dangling_index` is a fabricated reference (a hard failure); `missing_reference` means
   * the entity was named but not identified, so it stays in review instead of being dropped
   * and is never published (P.US-008.AC-03).
   */
  readonly unresolvedReason?: 'dangling_index' | 'missing_reference'
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
  /** The fixed prompt/schema-context template version the request was built from (A §5.3). */
  readonly promptVersion?: string
  /** The canonical schema-context digest injected into the model request (A §5.3). */
  readonly schemaDigest?: Sha256Digest
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
  /** Raw model proposal; validated against the pinned definition before a rule can publish it. */
  readonly conclusion?: unknown
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

/**
 * The frozen rule grammar the extractor may represent (SPEC v0.3 A §5.3, EX-4.1/§5.2).
 * It is a fixed, declarative description of the supported subset: typed all/any/not,
 * explicit comparisons, numeric ranges, one relation premise and no cyclic rules. The
 * schema context injected into the model request states it so the model never proposes an
 * unsupported form only to have it rejected after the fact.
 */
export interface IndustryRuleGrammar {
  /** The declared comparison operators the semantic engine can publish and evaluate. */
  readonly comparisonOperators: readonly string[]
  /** The expression operators a rule may use. */
  readonly operators: readonly string[]
  /** Maximum relation navigation depth across rule premises. */
  readonly maxRelationDepth: number
  /** Whether a rule may reference another rule (cycles are never allowed). */
  readonly allowsRuleReferences: boolean
  /** Maximum number of linked rule levels in a dependency chain. */
  readonly maxRuleDependencyLevels: number
}

/** A published rule constraint projected for the extraction contract. */
export interface IndustryRuleConstraintSchema {
  readonly ruleId: string
  readonly objectId: string
  readonly severity: 'hard' | 'soft'
  readonly expression: IndustryRuleExpression
}

export type IndustryRuleExpression =
  | { readonly op: 'all'; readonly operands: readonly IndustryRuleExpression[] }
  | { readonly op: 'any'; readonly operands: readonly IndustryRuleExpression[] }
  | { readonly op: 'not'; readonly operand: IndustryRuleExpression }
  | {
      readonly op: 'compare'
      readonly attributeId: string
      readonly operator: string
      readonly value: string | number | boolean
    }
  | {
      readonly op: 'range'
      readonly attributeId: string
      readonly min?: number
      readonly max?: number
      readonly unitCode?: string
    }
  | { readonly op: 'relation'; readonly relationId: string }

export interface IndustrySchema {
  readonly namespace: string
  readonly definitionRef: VersionRef
  readonly objects: readonly IndustryObjectSchema[]
  readonly relations: readonly IndustryRelationSchema[]
  readonly identityScopes: readonly IndustryIdentityScopeSchema[]
  /**
   * The rule constraints declared by the published definition version. Optional so a
   * reader that predates rule projection still validates; the extractor injects them when
   * present (A §5.3).
   */
  readonly ruleConstraints?: readonly IndustryRuleConstraintSchema[]
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
