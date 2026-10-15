import type {
  DecimalQuantity,
  DecimalString,
  DomainResultStatus,
  ProjectionState,
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  SourceWatermark,
  Uuid,
  ValidityInterval,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import type { RuleComputationArtifact } from './rule-extraction'

/**
 * Incremental materialisation, bitemporal projection and invalidation fence (SPEC D3.1/D5/D5.1,
 * ADR-13, US-016/US-017, FR-18/FR-19/FR-20).
 *
 * Three ideas shape this contract:
 *
 *  - **Change-driven.** A new assertion, a correction, a retraction, a rule change, an identity
 *    change or a natural valid-time expiry is a `MaterializationChange`. The dependency index
 *    turns one change into the *affected* rule set, so materialisation never replays the whole
 *    library (D5/ADR-13).
 *  - **Fence before advance.** A change first opens an invalidation fence and only then advances
 *    the projection asynchronously. A read that hits an open fence or a dirty scope returns
 *    `pending`/`dirty`, never an out-of-date value (D5.1/FR-20).
 *  - **Bitemporal.** A projection slice carries both its business `validity` interval and the
 *    `recordedSeq` it was derived from. The two are independent, so a partial-interval
 *    correction appends a slice for that interval only and never overwrites another interval
 *    (D3.1).
 *
 * The port lives in `contracts` so an adapter can implement it while depending on `contracts`
 * alone (SPEC §2: adapters → contracts). The `semantic-engine` service receives it by
 * construction injection and never imports an adapter or driver.
 */

/** An exact decimal, categorical string or boolean materialised value. Floats are never exact. */
export interface ExactScalarDecimal {
  readonly kind: 'scalar_decimal'
  readonly amount: DecimalString
}

export type MaterializedValue = DecimalQuantity | ExactScalarDecimal | string | boolean

/** A pinned reference to the exact fact version that supported a materialised conclusion. */
export interface MaterializedFactRef {
  readonly assertionId: string
  readonly logicalAssertionId: string
  readonly recordedSeq: RevisionString
  readonly digest: Sha256Digest
}

/** Which alternatives of a premise group a materialised conclusion rests on. */
export interface MaterializedSatisfiedBy {
  readonly groupId: string
  readonly alternativeIds: readonly string[]
}

/**
 * A persisted derived conclusion. It mirrors the evaluator's result with contract-level types so
 * a store never depends on `semantic-engine`: the same query answered on demand and from the
 * projection compares equal (D5.1, US-016.A2).
 */
export interface MaterializedConclusion {
  readonly propositionKey: string
  readonly qualifiedPropositionKey: Sha256Digest
  readonly predicate: string
  readonly domainStatus: DomainResultStatus
  readonly value?: MaterializedValue
  readonly satisfiedBy: readonly MaterializedSatisfiedBy[]
  readonly ruleRefs: readonly VersionRef[]
  readonly factRefs: readonly MaterializedFactRef[]
  readonly supportNodeId: string
  /** Typed rule computation results captured in the same immutable projection slice. */
  readonly ruleArtifacts?: readonly RuleComputationArtifact[]
}

/** What caused an affected evaluation. Every kind is a distinct trigger class (D5.1). */
export type MaterializationChangeKind =
  | 'assertion_published'
  | 'assertion_corrected'
  | 'assertion_retracted'
  | 'rule_changed'
  | 'identity_changed'
  | 'validity_expired'

interface MaterializationChangeBase {
  readonly changeId: Uuid
  readonly scopeRef: ScopeRef
  /** The platform record sequence of the change; the projection records it as its watermark. */
  readonly recordedSeq: RevisionString
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * A published, corrected or retracted explicit assertion. `validity` is the interval the change
 * acts on: a partial correction touches only that interval (D3.1).
 */
export interface AssertionMaterializationChange extends MaterializationChangeBase {
  readonly kind: 'assertion_published' | 'assertion_corrected' | 'assertion_retracted'
  readonly logicalAssertionId: string
  readonly predicate: string
  readonly subjectEntityId?: string
  readonly validity: ValidityInterval
}

/** A published or revised rule. Its conclusion and every downstream rule are affected. */
export interface RuleMaterializationChange extends MaterializationChangeBase {
  readonly kind: 'rule_changed'
  readonly ruleId: string
  readonly propositionKey: string
}

/** An identity decision (match/split) that rebinds the facts a conclusion rests on (D4.6). */
export interface IdentityMaterializationChange extends MaterializationChangeBase {
  readonly kind: 'identity_changed'
  readonly entityId: string
  readonly objectId?: string
  readonly separatedCandidateIds: readonly Uuid[]
  readonly reason: string
}

/**
 * A valid-time boundary reached by the clock, not by a write. The publish transaction registers
 * it so a natural expiry triggers affected evaluation instead of being missed (D3.1).
 */
export interface ValidityExpiryMaterializationChange extends MaterializationChangeBase {
  readonly kind: 'validity_expired'
  readonly logicalAssertionId: string
  readonly predicate: string
  readonly validAt: Rfc3339UtcTimestamp
}

export type MaterializationChange =
  | AssertionMaterializationChange
  | RuleMaterializationChange
  | IdentityMaterializationChange
  | ValidityExpiryMaterializationChange

export type MaterializationFenceState = 'open' | 'closed'

/**
 * An invalidation fence. While it is open, a read of a covered proposition must not return a
 * stale conclusion. An empty `propositionKeys` means the fence covers the whole scope, which is
 * how a conservatively dirty large fan-out is guarded.
 */
export interface MaterializationFence {
  readonly fenceId: Uuid
  readonly scopeRef: ScopeRef
  readonly generation: RevisionString
  readonly reason: string
  readonly propositionKeys: readonly string[]
  readonly state: MaterializationFenceState
  readonly openedAt: Rfc3339UtcTimestamp
  readonly closedAt?: Rfc3339UtcTimestamp
}

export interface OpenMaterializationFenceInput {
  readonly fenceId: Uuid
  readonly reason: string
  readonly propositionKeys: readonly string[]
  readonly openedAt: Rfc3339UtcTimestamp
}

/**
 * One append-only projection slice. `validity` is the business interval the conclusion holds for
 * and `recordedSeq` the system version it was derived from, so the two time axes stay
 * independent. A newer slice for one interval never rewrites the slice for another interval.
 */
export interface ProjectionSlice {
  readonly scopeRef: ScopeRef
  readonly generation: RevisionString
  readonly propositionKey: string
  readonly qualifiedPropositionKey: Sha256Digest
  readonly predicate: string
  readonly domainStatus: DomainResultStatus
  readonly value?: MaterializedValue
  readonly validity: ValidityInterval
  readonly recordedSeq: RevisionString
  readonly conclusion: MaterializedConclusion
}

export interface ReadProjectionSlicesRequest {
  /** Restrict the read to these propositions; `undefined` reads every materialised proposition. */
  readonly propositionKeys?: readonly string[]
  readonly validAt?: Rfc3339UtcTimestamp
  readonly asOfRecordedSeq?: RevisionString
  /** Bounded page size; a caller never reads an unbounded slice table. */
  readonly limit?: number
}

export interface CommitProjectionInput {
  /** The fence this commit closes; `undefined` when no fence was opened. */
  readonly fenceId?: Uuid
  /** Up to seven other fences closed atomically for one bounded worker batch. */
  readonly additionalFenceIds?: readonly Uuid[]
  readonly expectedGeneration: RevisionString
  readonly recordedSeq: RevisionString
  readonly watermark: SourceWatermark
  readonly slices: readonly ProjectionSlice[]
  readonly committedAt: Rfc3339UtcTimestamp
}

export interface ProjectionCommitResult {
  readonly state: ProjectionState
  readonly appendedSlices: number
}

export interface MarkProjectionDirtyInput {
  readonly reason: string
  readonly recordedSeq: RevisionString
  readonly markedAt: Rfc3339UtcTimestamp
}

export type MaterializationStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FENCE_NOT_FOUND'
  | 'GENERATION_CONFLICT'
  | 'MATERIALIZATION_STORE_FAILED'

export class MaterializationStoreError extends Error {
  readonly code: MaterializationStoreErrorCode

  constructor(code: MaterializationStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MaterializationStoreError'
    this.code = code
  }
}

/**
 * Control persistence for the invalidation fence, the dirty flag, the projection state and the
 * append-only projection slices (D2 `projection_state`/`projection_slices`). Every method runs in
 * the trusted tenant/space scope and RLS is a second layer behind the explicit scope predicate.
 * `commitProjection` is one transaction: it appends the slices, advances the generation and
 * watermark, clears the dirty flag and closes the fence together, so a committed generation can
 * never be observed with an open fence.
 */
export interface MaterializationStore {
  /** The scope projection state; `undefined` before the first materialisation. */
  getProjectionState(scopeRef: ScopeRef, ctx: ToolContext): Promise<ProjectionState | undefined>
  /** Conservatively mark the whole scope dirty (a fan-out too large to enumerate). */
  markDirty(
    scopeRef: ScopeRef,
    input: MarkProjectionDirtyInput,
    ctx: ToolContext,
  ): Promise<ProjectionState>

  openFence(
    scopeRef: ScopeRef,
    input: OpenMaterializationFenceInput,
    ctx: ToolContext,
  ): Promise<MaterializationFence>
  closeFence(
    scopeRef: ScopeRef,
    fenceId: Uuid,
    closedAt: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<MaterializationFence>
  getFence(
    scopeRef: ScopeRef,
    fenceId: Uuid,
    ctx: ToolContext,
  ): Promise<MaterializationFence | undefined>
  listOpenFences(scopeRef: ScopeRef, ctx: ToolContext): Promise<MaterializationFence[]>

  readSlices(
    scopeRef: ScopeRef,
    request: ReadProjectionSlicesRequest,
    ctx: ToolContext,
  ): Promise<ProjectionSlice[]>
  /** Append slices, advance generation/watermark, clear dirty and close the fence atomically. */
  commitProjection(
    scopeRef: ScopeRef,
    input: CommitProjectionInput,
    ctx: ToolContext,
  ): Promise<ProjectionCommitResult>
}
