import type {
  ModelRef,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Uuid,
  VersionRef,
  ProjectRevisionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Entity identity decisions and reversible identity records (SPEC D4.5/D4.6, C6,
 * US-014/US-015, FR-14/16/17).
 *
 * A decision is the *adjudication* half of identity resolution: recall (LOCAL-029)
 * proposes candidate entities, a human reviewer or the policy decides one of
 * `match` / `create_pending` / `clarify` / `reject` (plus the corrective `split`).
 *
 * Four invariants shape this contract:
 *
 *  - A `match` needs a strong identity (a native id or a confirmed alias) **or** an
 *    explicit human justification. A model/JEV score is supporting evidence only: it
 *    can never merge two entities on its own, and a below-threshold score is refused.
 *  - A `cannot-link` constraint blocks the merge; it is never silently dropped. The
 *    identity scope/type declared by the published definition blocks merging a
 *    `device` with a `sensor` even when their display names are identical.
 *  - A decision is an **append-only version**. Every revision is a distinct immutable
 *    record; the previous revision stays readable and is never overwritten.
 *  - The merge membership is a time-bounded `identity_assertion`. A `split` closes
 *    the open assertion, separates the source records and enqueues a downstream
 *    invalidation event through the real transactional outbox, so dependent
 *    conclusions are invalidated rather than silently kept.
 *
 * The port lives in `contracts` so an adapter implements it while depending on
 * `contracts` alone (SPEC §2: adapters → contracts). The service layer receives it by
 * construction injection and never imports an adapter or driver.
 */

/** The adjudication kinds. `split` is the corrective reversal of a bad `match`. */
export type IdentityDecisionKind = 'match' | 'create_pending' | 'clarify' | 'reject' | 'split'

/**
 * Lifecycle of a canonical entity. `pending` is an entity created by a decision that
 * is not yet confirmed; `confirmed` is a reviewer-approved identity; `retired` is a
 * merged-away or corrected identity. A state change is a new decision, never an
 * in-place overwrite of history.
 */
export type IdentityEntityState = 'pending' | 'confirmed' | 'retired'

/** A canonical entity (or a pending placeholder) created and referenced by decisions. */
export interface IdentityEntityRecord {
  readonly entityId: string
  readonly objectId: string
  readonly identityScopeId: string
  /** Exact values for every identity-scope dimension declared by the pinned definition. */
  readonly scopeDimensions: Readonly<Record<string, string>>
  /** Source candidate that created this pending entity, used only to confirm its own identity. */
  readonly createdFromCandidateId?: Uuid
  readonly displayName?: string
  readonly state: IdentityEntityState
  readonly revision: RevisionString
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
}

/**
 * A reviewer-confirmed identity value attached to a `match`. A native ID is checked
 * against the pinned candidate identity attributes; a confirmed alias must occur in the
 * candidate and already be recorded by a reviewer on the target cluster. Supplying this
 * shape is never an automatic match request: the service validates both source and target
 * evidence before it can authorize the merge.
 */
export interface IdentityStrongIdentity {
  readonly kind: 'native_id' | 'confirmed_alias'
  readonly value: string
  /** Optional only when the pinned schema identifies one unambiguous matching attribute. */
  readonly attributeId?: string
}

/**
 * A model/JEV similarity score attached to a decision. It is **supporting evidence
 * only**: it is recorded verbatim for audit and never authorises a merge by itself.
 */
export interface IdentityScoreEvidence {
  readonly score: number
  readonly backendRef: VersionRef
  readonly modelRef?: ModelRef
}

/** One immutable decision version. A revision is a new record, never an update. */
export interface IdentityDecisionRecord {
  readonly decisionId: Uuid
  readonly candidateId: Uuid
  readonly objectId: string
  readonly identityScopeId: string
  readonly kind: IdentityDecisionKind
  readonly revision: RevisionString
  /** The entity a `match`/`split` targets. For `create_pending` it is the new entity. */
  readonly targetEntityId?: string
  /** For `split`: the candidate source records separated back out. */
  readonly separatedCandidateIds?: readonly Uuid[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly justification?: string
  readonly strongIdentity?: IdentityStrongIdentity
  readonly scoreEvidence?: IdentityScoreEvidence
  /** Business valid interval `[validFrom, validTo)` the decision applies to. */
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  /** When the platform recorded the decision (`recorded_at`, D3.1 dual time). */
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly actor: string
  /** The revision this version supersedes, absent for the first decision. */
  readonly supersedesRevision?: RevisionString
  /** The outbox message id enqueued by a `split`, when one was produced. */
  readonly invalidationOutboxId?: Uuid
}

/** A decision before the store assigns its monotonic revision. */
export type IdentityDecisionDraft = Omit<
  IdentityDecisionRecord,
  'revision' | 'supersedesRevision' | 'invalidationOutboxId'
>

/**
 * A time-bounded merge membership: the candidate's source record was asserted to be
 * the entity inside `[validFrom, validTo)`. A `split` sets `validTo`; the row is never
 * deleted, so the earlier binding stays auditable.
 */
export interface IdentityAssertionRecord {
  readonly assertionId: Uuid
  readonly candidateId: Uuid
  readonly entityId: string
  readonly objectId: string
  readonly identityScopeId: string
  readonly decisionId: Uuid
  readonly validFrom: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** A hard negative link: the candidate's source must never be merged with `entityId`. */
export interface IdentityLinkConstraintRecord {
  readonly constraintId: Uuid
  readonly candidateId: Uuid
  readonly entityId: string
  readonly kind: 'cannot_link'
  readonly decisionId: Uuid
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * The downstream invalidation event a `split` emits. It is written to the real
 * transactional outbox in the same transaction as the decision, so a dependent
 * conclusion can never be silently kept after the merge it relied on is reversed.
 */
export interface IdentityInvalidationEvent {
  readonly eventId: Uuid
  readonly topic: 'identity.decision.split'
  /** Pre-opened scope fence written atomically with this event and the split decision. */
  readonly materializationFenceId: Uuid
  readonly decisionId: Uuid
  readonly entityId: string
  readonly objectId: string
  readonly identityScopeId: string
  readonly separatedCandidateIds: readonly Uuid[]
  readonly reason: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly actor: string
}

export interface IdentityEntityFilter {
  readonly objectId?: string
  readonly projectId?: Uuid
  readonly state?: IdentityEntityState
  /** Bounded page size; a caller never reads an unbounded entity table. */
  readonly limit?: number
}

export interface IdentityAssertionFilter {
  readonly entityId?: string
  readonly candidateId?: Uuid
  readonly openOnly?: boolean
}

export interface IdentityPublishedBinding {
  readonly candidateId: Uuid
  readonly openAssertions: readonly IdentityAssertionRecord[]
  readonly cannotLinkEntityIds: readonly string[]
}

/** A bounded identity binding page pinned to one scope read-head revision. */
export interface IdentityPublishedBindingSnapshot {
  readonly readRevision: RevisionString
  readonly bindings: readonly IdentityPublishedBinding[]
  /** False when the requested candidate set exceeded the store's page cap. */
  readonly complete: boolean
}

export interface IdentityDecisionCloseAssertion {
  readonly assertionId: Uuid
  readonly validTo: Rfc3339UtcTimestamp
}

/** Host-read fixed point rechecked atomically with an instance identity decision. */
export interface IdentityDecisionProjectFence {
  readonly projectRevisionRef: ProjectRevisionRef
  readonly definitionRef: VersionRef
  readonly documentId: Uuid
  readonly parseId: Uuid
  readonly membershipRevision: RevisionString
  readonly visibilityEpoch: RevisionString
}

/**
 * Everything one `appendDecision` applies in a single transaction: the new immutable
 * decision version, any entity/assertion/link-constraint side effect and, for a
 * `split`, the outbox invalidation message. Splitting this across transactions would
 * let a committed decision lose its side effect (SPEC D6/§8).
 */
export interface AppendIdentityDecisionInput {
  readonly projectFence?: IdentityDecisionProjectFence
  /** The revision the caller last read; `0` means "no decision yet". */
  readonly expectedRevision: RevisionString
  /** Target entity/cluster head the caller read; required for match, split and cannot-link writes. */
  readonly expectedTargetEntityRevision?: RevisionString
  readonly draft: IdentityDecisionDraft
  /** Insert or advance the entity (used by `create_pending`). */
  readonly entity?: IdentityEntityRecord
  /** Open a merge membership (`match`/`create_pending`). */
  readonly openAssertion?: IdentityAssertionRecord
  /** Close merge memberships (`split`). */
  readonly closeAssertions?: readonly IdentityDecisionCloseAssertion[]
  /** Record a hard negative link (`reject` with a target). */
  readonly linkConstraint?: IdentityLinkConstraintRecord
  /** The downstream invalidation event (`split`). */
  readonly invalidation?: IdentityInvalidationEvent
  /** The job that anchors the outbox message (the candidate's ingestion job). */
  readonly outboxJobId?: Uuid
}

/**
 * Control persistence for identity decisions (D2/D4). Every method runs in the trusted
 * tenant/space scope and RLS is a second layer behind the explicit scope predicate.
 * `appendDecision` is compare-and-swap on the candidate's decision head: a concurrent
 * decision with a stale `expectedRevision` fails with `REVISION_CONFLICT` instead of
 * overwriting the winner.
 */
export interface IdentityDecisionStore {
  /** Exact scoped immutable decision lookup for trusted outbox admission. */
  getDecisionById?(scopeRef: ScopeRef, decisionId: Uuid, ctx: ToolContext): Promise<IdentityDecisionRecord | undefined>
  getEntity(
    scopeRef: ScopeRef,
    entityId: string,
    ctx: ToolContext,
  ): Promise<IdentityEntityRecord | undefined>
  listEntities(
    scopeRef: ScopeRef,
    filter: IdentityEntityFilter,
    ctx: ToolContext,
  ): Promise<IdentityEntityRecord[]>
  /** The current decision head revision for a candidate; `0` when there is none. */
  latestRevision(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<RevisionString>
  /** Monotonic scope read head; advances with each committed identity decision transaction. */
  latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString>
  /** Batch read current open assignments and hard negative links at one pinned revision. */
  readPublishedBindings(
    scopeRef: ScopeRef,
    candidateIds: readonly Uuid[],
    ctx: ToolContext,
  ): Promise<IdentityPublishedBindingSnapshot>
  appendDecision(
    scopeRef: ScopeRef,
    input: AppendIdentityDecisionInput,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord>
  getDecision(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord | undefined>
  /** Every decision version for a candidate, oldest first. History is never rewritten. */
  listDecisions(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<IdentityDecisionRecord[]>
  listAssertions(
    scopeRef: ScopeRef,
    filter: IdentityAssertionFilter,
    ctx: ToolContext,
  ): Promise<IdentityAssertionRecord[]>
  listLinkConstraints(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<IdentityLinkConstraintRecord[]>
  /** True only when a prior reviewer match recorded this exact identity on an open target assertion. */
  hasReviewedIdentity(
    scopeRef: ScopeRef,
    entityId: string,
    identity: IdentityStrongIdentity,
    ctx: ToolContext,
  ): Promise<boolean>
}

export type IdentityDecisionStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'ENTITY_NOT_FOUND'
  | 'DECISION_STORE_FAILED'
  | 'PROJECT_FENCE_STALE'
  | 'PROJECT_FENCE_UNSUPPORTED'

export class IdentityDecisionStoreError extends Error {
  readonly code: IdentityDecisionStoreErrorCode

  constructor(code: IdentityDecisionStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IdentityDecisionStoreError'
    this.code = code
  }
}
