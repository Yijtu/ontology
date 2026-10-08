import type {
  ErrorCode,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
  ProjectRevisionRef,
} from './generated/contracts'
import type { CandidateKind } from './extraction'
import type { NewOutboxMessage } from './job-store'
import type { RuleConclusionBinding, RuleExceptionNode, RuleExpressionNode, RuleImpact } from './rule-extraction'
import type { ToolContext } from './trusted'
import type { ProjectFactPublicationFence } from './project-mapping'
import type { RuleDependencyReference } from './rule-action-candidates'

/**
 * Semantic publication and candidate review (SPEC D4.6/D5/D6, C6, US-011/US-012/US-015,
 * FR-13/FR-14).
 *
 * Publication is the *only* transition from an approved candidate to a versioned fact or
 * rule. Three invariants shape this contract:
 *
 *  - **Candidate state and the official read view are separate.** A candidate lives in
 *    `extraction_candidates`; a published fact/rule lives in its own immutable table. There
 *    is no query that reads both, so an unapproved, failed or conflicted candidate is
 *    structurally unreachable from computation (D4.6/FR-14).
 *  - **One transaction.** The versioned facts, the identity-constraint checks, the rule
 *    versions and the outbox event commit together. A retry with the same idempotency key
 *    returns the existing publication and writes nothing again (D5/D6).
 *  - **History is preserved.** A revision or retraction appends a new statement version and
 *    closes the old one; it never deletes the earlier version, and a conclusion still
 *    supported by another active statement stays in the current view (INV-06/D5).
 *
 * The port lives in `contracts` so an adapter implements it while depending on `contracts`
 * alone (SPEC §2: adapters → contracts). The service receives it by construction injection
 * and never imports an adapter or driver.
 */

/** The review decision a semantic reviewer records for one candidate. */
export type CandidateReviewDecision = 'approve' | 'reject'

/** What a reviewer submits for one candidate (C6 `POST /candidates/{id}/reviews`). */
export interface CandidateReviewRequest {
  readonly candidateId: Uuid
  readonly decision: CandidateReviewDecision
  readonly reason: string
  readonly evidenceRefs?: readonly ResourceRef[]
  /**
   * The review head revision the reviewer read. `undefined` means the `If-Match` header was
   * absent and the call is rejected with `REVISION_REQUIRED` (428).
   */
  readonly expectedRevision: RevisionString | undefined
}

/** One immutable review version. A new review is a new record, never an update. */
export interface CandidateReviewRecord {
  readonly reviewId: Uuid
  readonly candidateId: Uuid
  readonly decision: CandidateReviewDecision
  readonly revision: RevisionString
  readonly reason: string
  readonly evidenceRefs: readonly ResourceRef[]
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly actor: string
  /** Exact reviewed content. Legacy records stay readable but cannot approve a definition pack. */
  readonly contentDigest?: Sha256Digest
  /** The revision this version supersedes, absent for the first review. */
  readonly supersedesRevision?: RevisionString
}

/** A review before the store assigns its monotonic revision. */
export type CandidateReviewDraft = Omit<CandidateReviewRecord, 'revision' | 'supersedesRevision'>

/** Everything one `appendReview` applies in a single compare-and-swap transaction. */
export interface AppendCandidateReviewInput {
  /** The revision the caller last read; `0` means "no review yet". */
  readonly expectedRevision: RevisionString
  readonly draft: CandidateReviewDraft
}

/** One candidate a publication claims is approved. */
export interface PublicationCandidateRef {
  readonly candidateId: Uuid
  readonly kind: CandidateKind
}

/** What a publisher submits (C6 `POST /semantic-publications`). */
export interface SemanticPublicationRequest {
  readonly approvedCandidateRefs: readonly PublicationCandidateRef[]
  /** The published definition version the candidates were extracted against. */
  readonly schemaRef: VersionRef
  /**
   * The scope publication head the caller read. `undefined` means the `If-Match` header was
   * absent and the call is rejected with `REVISION_REQUIRED` (428).
   */
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export type PublishedStatementStatus = 'active' | 'retracted'

/**
 * A versioned published fact. `statementId` is stable across revisions (it is the source
 * candidate id), so a correction produces a new version of the same statement rather than a
 * second statement. `propositionKey` groups the statements that assert the same proposition
 * from different evidence, which is what lets a retraction keep a conclusion that another
 * active statement still supports (D5/INV-06).
 */
export interface PublishedStatement {
  readonly statementId: Uuid
  readonly propositionKey: string
  readonly kind: 'entity' | 'relation'
  readonly objectId?: string
  readonly relationId?: string
  readonly subjectEntityId?: string
  readonly predicate: string
  readonly value: Readonly<Record<string, unknown>>
  readonly unitCode?: string
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly sourceCandidateId: Uuid
  readonly sourceRefs: readonly ResourceRef[]
  readonly publicationId: Uuid
  readonly version: RevisionString
  readonly status: PublishedStatementStatus
}

/** A versioned published rule. It carries the bounded AST and its exceptions verbatim. */
export interface PublishedRuleVersion {
  readonly ruleVersionId: Uuid
  readonly ruleId: string
  readonly version: RevisionString
  readonly objectId: string
  readonly severity: 'hard' | 'soft'
  readonly impact: RuleImpact
  readonly expression: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  /** Optional human-reviewed business consequence; absence means applicability only. */
  readonly conclusion?: RuleConclusionBinding
  readonly ruleDependencies?: readonly string[]
  readonly dependencyRefs?: readonly RuleDependencyReference[]
  readonly projectId?: Uuid
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly sourceCandidateId: Uuid
  readonly publicationId: Uuid
}

/** A published pack rule retains its real origin; it is never a fabricated extraction publication. */
export interface PublishedPackRuleVersion extends Omit<PublishedRuleVersion, 'publicationId'> {
  readonly publishedPackRef: VersionRef
  readonly ruleRef: VersionRef
}
export type PublishedExecutableRule = PublishedRuleVersion | PublishedPackRuleVersion

export interface PublishedRuleDeclarationRequest {
  /** Host-selected from an authorized immutable historical binding; never an HTTP request flag. */
  readonly readMode?: 'current' | 'published_snapshot'
  readonly projectRevisionRef?: ProjectRevisionRef
  readonly packRef: VersionRef
  readonly definitionRef: VersionRef
  readonly projectId?: Uuid
}
export interface PublishedRuleDeclarationReader {
  read(scopeRef: ScopeRef, request: PublishedRuleDeclarationRequest, ctx: ToolContext): Promise<readonly PublishedPackRuleVersion[]>
}

/** A published semantic version: the facts, the rules and the outbox event, one transaction. */
export interface SemanticPublicationVersion {
  readonly ruleProjectPins?: readonly PublicationRuleProjectPin[]
  readonly publicationId: Uuid
  readonly versionRef: VersionRef
  readonly revision: RevisionString
  readonly schemaRef: VersionRef
  readonly approvedCandidateRefs: readonly PublicationCandidateRef[]
  readonly statements: readonly PublishedStatement[]
  readonly ruleVersions: readonly PublishedRuleVersion[]
  readonly outboxId: Uuid
  readonly publishedAt: Rfc3339UtcTimestamp
  readonly actor: string
}

/** A candidate→entity binding the publication transaction re-checks before it commits. */
export interface PublicationIdentityBinding {
  readonly candidateId: Uuid
  readonly entityId: string
}

/** Server-loaded project authority for a tagged extracted rule, rechecked at commit. */
export interface PublicationRuleProjectPin {
  readonly candidateId: Uuid
  readonly candidateDigest: Sha256Digest
  readonly reviewRevision: RevisionString
  readonly projectRevisionRef: ProjectRevisionRef
  readonly definitionRef: VersionRef
}

/**
 * A materialisation invalidation fence opened inside the publication transaction (SPEC D5.1,
 * ADR-13, LOCAL-070).
 *
 * The fence is committed atomically with the publication and its outbox event, so a reader that
 * observes the committed publication immediately meets an open fence instead of a stale
 * conclusion; the worker only advances the projection afterwards. `changeId` is the change the
 * fence guards (a statement id or a rule-version id), which is what lets the consumer bind the
 * fence to the asynchronous advance request. At publication time the affected fan-out has not
 * been enumerated yet, so `propositionKeys` is empty: the fence conservatively covers the whole
 * scope, exactly as D5.1 prescribes when the affected set is not yet exhausted.
 */
export interface PublicationMaterializationFence {
  readonly changeId: Uuid
  readonly fenceId: Uuid
  readonly reason: string
  readonly propositionKeys: readonly string[]
  readonly openedAt: Rfc3339UtcTimestamp
}

/**
 * Everything `publish` applies in one transaction. Splitting any part across transactions
 * would let a committed fact lose its outbox event, or an identity conflict slip past the
 * check (SPEC D5/D6/§8).
 */
export interface PublishSemanticPublicationInput {
  readonly ruleProjectPins?: readonly PublicationRuleProjectPin[]
  readonly projectFactFences?: readonly ProjectFactPublicationFence[]
  readonly expectedRevision: RevisionString
  /** The publication content, before the store assigns its revision. */
  readonly publication: Omit<SemanticPublicationVersion, 'revision'>
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly identityBindings: readonly PublicationIdentityBinding[]
  readonly outbox: NewOutboxMessage
  /** The ingestion job that anchors the outbox message (the first candidate's job). */
  readonly outboxJobId: Uuid
  /**
   * The invalidation fences to open in the same transaction as the publication and its outbox
   * event (LOCAL-070). Empty or absent means the caller opened no fence, which is only valid for
   * a caller that does not drive the materialisation window.
   */
  readonly materializationFences?: readonly PublicationMaterializationFence[]
}

export interface PublicationPublishResult {
  readonly publication: SemanticPublicationVersion
  /** `false` when the idempotency key replayed an existing publication. */
  readonly created: boolean
}

export type StatementRevisionKind = 'correction' | 'retraction'

/** What a publisher submits (C6 `POST /statements/{id}/revisions`). */
export interface StatementRevisionRequest {
  readonly statementId: Uuid
  readonly kind: StatementRevisionKind
  readonly reason: string
  readonly correctedValue?: Readonly<Record<string, unknown>>
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  /** The statement version the caller read. Absent means 428. */
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

/** One immutable statement revision. History is never rewritten. */
export interface StatementRevisionRecord {
  readonly revisionId: Uuid
  readonly statementId: Uuid
  readonly version: RevisionString
  readonly kind: StatementRevisionKind
  readonly reason: string
  readonly correctedValue?: Readonly<Record<string, unknown>>
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly actor: string
  /** The version this revision supersedes. */
  readonly supersedesVersion?: RevisionString
  /** The outbox invalidation message enqueued in the same transaction. */
  readonly invalidationOutboxId: Uuid
}

/** Everything `reviseStatement` applies in one transaction. */
export interface ReviseStatementInput {
  readonly expectedRevision: RevisionString
  readonly revisionId: Uuid
  readonly statementId: Uuid
  readonly kind: StatementRevisionKind
  readonly reason: string
  readonly correctedValue?: Readonly<Record<string, unknown>>
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly actor: string
  readonly outbox: NewOutboxMessage
  /**
   * The invalidation fence to open in the same transaction as the revision and its outbox event
   * (LOCAL-070). The affected fan-out is not enumerated here, so it conservatively covers the
   * scope (SPEC D5.1).
   */
  readonly materializationFences?: readonly PublicationMaterializationFence[]
}

export interface PublishedStatementFilter {
  readonly propositionKey?: string
  readonly objectId?: string
  readonly sourceCandidateId?: Uuid
  readonly publicationId?: Uuid
  readonly status?: PublishedStatementStatus
  /** Exclusive keyset cursor over the stable statement_id ordering. */
  readonly afterStatementId?: Uuid
  /** Bounded page size; a caller never reads an unbounded table. */
  readonly limit?: number
}

export interface PublishedRuleFilter {
  readonly objectId?: string
  readonly sourceCandidateId?: Uuid
  readonly publicationId?: Uuid
  /** Exclusive keyset cursor over stable (ruleId, numeric revision) ordering. */
  readonly afterRule?: { readonly ruleId: string; readonly version: RevisionString }
  readonly limit?: number
}

/**
 * The proposition-level read view. `supported` means at least one active statement still
 * asserts the proposition; `withdrawn` means every statement was retracted. It is the
 * evidence-preserving form of INV-06.
 */
export interface PropositionView {
  readonly propositionKey: string
  readonly status: 'supported' | 'withdrawn'
  readonly activeStatements: readonly PublishedStatement[]
  readonly statements: readonly PublishedStatement[]
}

/**
 * Control persistence for candidate reviews, publications, published facts/rules and
 * statement revisions (D4.6/D5/D6). Every method runs in the trusted tenant/space scope and
 * RLS is a second layer behind the explicit scope predicate. `publish` and `reviseStatement`
 * are single transactions; `appendReview` is compare-and-swap on the candidate review head.
 */
export interface SemanticPublicationStore {
  latestReviewRevision(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<RevisionString>
  appendReview(
    scopeRef: ScopeRef,
    input: AppendCandidateReviewInput,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord>
  getReview(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord | undefined>
  /** Every review version for one candidate, oldest first. History is never rewritten. */
  listReviews(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<CandidateReviewRecord[]>

  /** The scope publication head revision; `0` when nothing is published yet. */
  latestPublicationRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString>
  /** Monotonic token for all published-statement/rule read-view writes, including corrections and retractions. */
  latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString>
  publish(
    scopeRef: ScopeRef,
    input: PublishSemanticPublicationInput,
    ctx: ToolContext,
  ): Promise<PublicationPublishResult>
  getPublication(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion | undefined>
  listPublications(scopeRef: ScopeRef, limit: number, ctx: ToolContext): Promise<SemanticPublicationVersion[]>

  getStatement(scopeRef: ScopeRef, statementId: Uuid, ctx: ToolContext): Promise<PublishedStatement | undefined>
  listStatements(
    scopeRef: ScopeRef,
    filter: PublishedStatementFilter,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]>
  listRuleVersions(
    scopeRef: ScopeRef,
    filter: PublishedRuleFilter,
    ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]>

  reviseStatement(
    scopeRef: ScopeRef,
    input: ReviseStatementInput,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord>
  getStatementRevision(
    scopeRef: ScopeRef,
    statementId: Uuid,
    version: RevisionString,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord | undefined>
  listStatementRevisions(
    scopeRef: ScopeRef,
    statementId: Uuid,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord[]>
}

export type SemanticPublicationStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PUBLICATION_NOT_FOUND'
  | 'STATEMENT_NOT_FOUND'
  | 'REVIEW_NOT_FOUND'
  | 'IDENTITY_CONSTRAINT_BLOCKED'
  | 'PUBLICATION_STORE_FAILED'

export class SemanticPublicationStoreError extends Error {
  readonly code: SemanticPublicationStoreErrorCode

  constructor(code: SemanticPublicationStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SemanticPublicationStoreError'
    this.code = code
  }
}

/** The platform error catalogue codes a publication failure maps onto. */
export type SemanticPublicationPlatformCode = ErrorCode
