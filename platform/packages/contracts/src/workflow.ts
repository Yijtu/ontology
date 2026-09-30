import type {
  BudgetRemaining,
  EvidenceKind,
  NonEmptyString,
  ResourceRef,
  ResolvedProfileRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  RunState,
  Sha256Digest,
  ToolUsage,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type {
  DecisionPort,
  GenerationPort,
  RuntimeAdapter,
  RuntimeCheckpointPort,
  ToolGateway,
} from './ports'
import type { ToolContext } from './trusted'
import type { WorkflowDispatchFence } from './workflow-dispatch'
import { isRecord, isResourceRef, isSha256Digest } from './asset-workspace'
import type {
  ClaimExplanation,
  DraftClaim,
  SemanticReviewDisposition,
  VerifiedAssertion,
  VerificationFinding,
  VerificationFindingAxis,
} from './verification'

/**
 * Workflow controller ports and records (SPEC D7, ADR-14, INV-09).
 *
 * ADR-14 fixes three run-wide things: **one run manifest**, **one shared budget
 * ledger** and **one evidence-loop owner**. These types make that explicit. The
 * `WorkflowController` (in `@ontology/application`) owns the outer phase machine and
 * delegates the collection loop to exactly one selected `RuntimeAdapter`; the draft
 * writer and verifier are bounded, port-injected steps, never autonomous agents.
 *
 * `contracts` only defines the records and the ports. No persistence, framework or
 * industry implementation lives here, and every port takes the host-minted
 * `ToolContext` so scope and identity are never read from the request.
 */

/**
 * The immutable manifest a run is created under (ADR-14). It pins the exact resolved
 * profile and runtime version, and names the single budget ledger and input manifest
 * that every later phase and re-collection must share.
 */
export interface RunManifest {
  readonly runId: Uuid
  readonly resolvedProfileRef: ResolvedProfileRef
  readonly runtimeRef: VersionRef
  /** The one shared budget ledger for the whole run (ADR-14). */
  readonly budgetLedgerId: Uuid
  /** The one input manifest shared across phases and re-collection. */
  readonly inputManifestId: Uuid
  readonly createdAt: Rfc3339UtcTimestamp
}

export type WorkflowInputKind = 'confirmed_context' | 'evidence' | 'clarification'

/**
 * One entry of the run input manifest. `readAt` is the instant the referenced data was
 * read, so a resume can detect a stale input instead of silently trusting it.
 */
export interface WorkflowInputEntry {
  readonly entryId: Uuid
  readonly kind: WorkflowInputKind
  readonly label: NonEmptyString
  readonly ref?: ResourceRef
  readonly addedInPhase: RunState
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly readAt?: Rfc3339UtcTimestamp
}

/**
 * The input manifest shared by preflight, collection, drafting, verification and any
 * re-collection. It is append-only: a new round adds entries and advances `revision`,
 * it never resets the list or the digest.
 */
export interface WorkflowInputManifest {
  readonly manifestId: Uuid
  readonly runId: Uuid
  readonly revision: RevisionString
  readonly entries: readonly WorkflowInputEntry[]
  readonly digest: Sha256Digest
}

/** Mutable, persisted workflow coordination counters (never a second event ledger). */
export interface WorkflowRunState {
  readonly runId: Uuid
  /** Monotonic CAS token for updates to the mutable controller state. */
  readonly revision: RevisionString
  readonly draftAttempts: number
  readonly recheckCount: number
  readonly staleEntryIds: readonly Uuid[]
  /** A possibly-billed remote call was left unresolved; it is never treated as free. */
  readonly usageUnknown: boolean
  /**
   * Whether the bounded draft repair budget was exhausted and the controller already fell
   * back to composing one limited factual/gap result. It is set once so the fallback can
   * never loop or silently retry the same repair.
   */
  readonly limitedResultAttempted: boolean
  readonly updatedAt: Rfc3339UtcTimestamp
}

/** Bounded draft writer output. `evidenceRefs` are the persisted draft artifact refs. */
export interface AnswerDraft {
  readonly draftId: Uuid
  readonly runId: Uuid
  /**
   * V2 hashes bind assertions and limitations as well as blocks and numeric claims. V3
   * additionally binds the archived typed result manifest and the pre-draft finalization
   * receipt, so a published @3 body can never be detached from the exact typed result and
   * evidence it was verified against.
   */
  readonly schemaVersion?: 'answer-draft@2' | 'answer-draft@3'
  readonly blocks: readonly unknown[]
  /**
   * The structured, result-bound claims of the draft (D7.4). A draft written by the
   * combined verification path always carries them; they are part of `contentHash`, so a
   * revision of any claim produces a new draft hash and invalidates an older verdict.
   */
  readonly claims?: readonly DraftClaim[]
  readonly assertions?: readonly VerifiedAssertion[]
  readonly evidenceManifestHash: Sha256Digest
  readonly contentHash: Sha256Digest
  readonly limitations: readonly string[]
  readonly producedInPhase: RunState
  readonly createdAt: Rfc3339UtcTimestamp
  /**
   * The V3 typed-manifest bindings. They are present exactly when `schemaVersion` is
   * `answer-draft@3` (and absent for the legacy `@1`/`@2` drafts). They are part of the V3
   * content hash, so a later edit to the referenced manifest/receipt or the body requires a
   * new draft hash and therefore a fresh verification.
   */
  readonly resultManifestRef?: ResourceRef
  readonly resultManifestDigest?: Sha256Digest
  readonly finalizationReceiptRef?: ResourceRef
  readonly finalizationReceiptDigest?: Sha256Digest
  readonly executionBindingRef?: ResourceRef
}

/**
 * The draft-writer request contract version (FR-29, D7.4).
 *
 * `@1` is the original request: it carries no verification feedback. `@2` adds the located
 * `failedChecks` a bounded repair draws on. A request that omits `requestVersion` is read as
 * `@1`, so an existing caller that never sets it and never sends `failedChecks` is unchanged;
 * only the controller, which now feeds the previous verdict back, stamps `@2`.
 */
export type DraftWriterRequestVersion = 'draft-writer-request@1' | 'draft-writer-request@2'

/** The version a repair-aware caller stamps on the request. */
export const DRAFT_WRITER_REQUEST_VERSION: DraftWriterRequestVersion = 'draft-writer-request@2'

/**
 * The effective version of a request: an absent marker is the backward-compatible `@1`.
 * This is the single place the default is applied, so a reader never re-derives it.
 */
export function draftWriterRequestVersionOf(request: {
  readonly requestVersion?: DraftWriterRequestVersion
}): DraftWriterRequestVersion {
  return request.requestVersion ?? 'draft-writer-request@1'
}

/**
 * One located verification failure fed back into a bounded repair draft (FR-29).
 *
 * It mirrors the verifier's own `VerificationFinding`: when the finding is available the
 * claim, field, evidence and JSON pointer identify exactly what failed. `code` stays a plain
 * string so a recorded `failedChecks` code from a verifier that returns no located finding is
 * carried through verbatim rather than dropped or guessed. It is delivered only to the
 * in-process `DraftWriterPort`; it is never appended to the business event stream (C6.1).
 */
export interface DraftRepairFeedback {
  /** The verifier's finding code, or the recorded `failedChecks` code. */
  readonly code: string
  /** Present when the feedback came from a located finding. */
  readonly axis?: VerificationFindingAxis
  readonly claimId?: Uuid
  readonly field?: string
  readonly evidenceRef?: ResourceRef
  readonly pointer?: string
  readonly expected?: string
  readonly actual?: string
}

export interface DraftWriterRequest {
  readonly runId: Uuid
  readonly question: NonEmptyString
  readonly inputManifest: WorkflowInputManifest
  readonly deficits: readonly string[]
  readonly remainingBudget: BudgetRemaining
  /** 1 for the first draft; greater than 1 for a bounded repair attempt. */
  readonly attempt: number
  /**
   * The request contract version. Optional so a `@1` caller is unaffected; see
   * `draftWriterRequestVersionOf`. A repair attempt sends `@2`.
   */
  readonly requestVersion?: DraftWriterRequestVersion
  /**
   * The located checks a bounded repair must fix. Present only on a repair attempt
   * (`attempt > 1`) of a `@2` request; absent on the first draft. Each entry names the
   * claim/field/evidence it came from, so the repair is targeted rather than a blind retry.
   */
  readonly failedChecks?: readonly DraftRepairFeedback[]
}

export interface DraftWriterResult {
  readonly draft: AnswerDraft
  readonly usage?: ToolUsage
  /** Persisted artifact refs for the draft, when the writer archived it. */
  readonly evidenceRefs?: readonly ResourceRef[]
  /**
   * Trusted limitation codes the writer declares on the draft (for example a truncated result
   * that was deliberately not rendered as complete). The controller forwards them to the
   * verifier as `trustedLimitations`, so only codes the host actually produced are accepted;
   * a model or request can never inject an arbitrary limitation. They must match
   * `draft.limitations`.
   */
  readonly limitations?: readonly string[]
}

/**
 * Bounded draft-writing step (GenerationRole `draft_writer`). It is a single-shot port
 * call: it may iterate inside its own deterministic algorithm but it must not start an
 * autonomous Agent loop (SPEC §4.2).
 */
export interface DraftWriterPort {
  /** Set to idempotent only when repeating the exact same request cannot repeat external effects. */
  readonly recoverySafety?: 'idempotent' | 'non_replayable'
  writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult>
}

export interface VerificationResult {
  readonly verificationId: Uuid
  readonly draftId?: Uuid
  readonly draftHash: Sha256Digest
  readonly evidenceManifestHash: Sha256Digest
  readonly verdict: 'pass' | 'fail'
  readonly failedChecks: readonly string[]
  readonly policyVersion: NonEmptyString
  readonly verifiedAt: Rfc3339UtcTimestamp
  /** Claim ids that passed every hard check (D7.4 `supportedClaims`). */
  readonly supportedClaimIds?: readonly Uuid[]
  readonly supportedAssertionIds?: readonly Uuid[]
  /** Evidence ids a claim referenced but the verifier could not resolve. */
  readonly missingEvidence?: readonly Uuid[]
  /** Located hard/semantic/policy findings; empty on a clean pass. */
  readonly findings?: readonly VerificationFinding[]
  /** Restricted-template explanations of the findings, never model/JEV prose. */
  readonly explanations?: readonly ClaimExplanation[]
  /** Explicitly states when the optional semantic decision step did not run. */
  readonly semanticReview?: SemanticReviewDisposition
}

export interface VerifierRequest {
  readonly runId: Uuid
  /** The original user question the bounded semantic review must see. */
  readonly question?: string
  readonly draft: AnswerDraft
  readonly inputManifest: WorkflowInputManifest
  /** Trusted controller-supplied limitation codes for a deterministic limited fallback only. */
  readonly trustedLimitations?: readonly string[]
}

/**
 * Bounded verification step. It performs hard checks and returns an explicit verdict;
 * a framework event or a runtime message can never stand in for it (INV-09).
 */
export interface AnswerVerifierPort {
  verify(request: VerifierRequest, ctx: ToolContext): Promise<VerificationResult>
}

/**
 * The unforgeable handle the controller mints only after a passing verification. The
 * publisher accepts nothing else, so a draft, a runtime event or a framework message
 * cannot be published directly.
 *
 * `scenarioManifestHash` binds the answer to the locked scenario (resolved profile snapshot,
 * runtime version and input manifest digest), so an answer id can never be detached from the
 * exact scenario version that produced it (SPEC §4.1).
 */
export interface PublicationGrant {
  readonly grantId: Uuid
  readonly runId: Uuid
  readonly draftId: Uuid
  readonly draftHash: Sha256Digest
  readonly verificationId: Uuid
  readonly evidenceManifestHash: Sha256Digest
  readonly scenarioManifestHash: Sha256Digest
  readonly expectedRunRevision: RevisionString
  /** The unexpired durable worker lease that is atomically checked with answer insertion. */
  readonly workflowDispatchFence?: WorkflowDispatchFence
  readonly issuedBy: 'workflow-controller'
  readonly issuedAt: Rfc3339UtcTimestamp
}

/**
 * How the published answer relates to the current world. `verified` is a current,
 * still-valid result; `history_limited` is the same verified content published with an
 * explicit as-of point because the supporting data moved on after verification (D7.4). The
 * marker is part of the answer, so an older result is never presented as current.
 */
export type PublicationKind = 'verified' | 'history_limited'

/** Immutable, verified body stored with a newly published answer. */
export interface PublishedAnswerBody {
  readonly schemaVersion: 'answer-draft@1' | 'answer-draft@2'
  readonly blocks: readonly unknown[]
  readonly claims: readonly DraftClaim[]
  readonly assertions: readonly VerifiedAssertion[]
}

/**
 * Runtime guard for the legacy `answer-draft@1`/`@2` published body. The body is archived
 * bytes (JSONB round-trips through storage), so a reader validates the shape instead of
 * trusting a TypeScript assertion.
 */
export function isPublishedAnswerBody(value: unknown): value is PublishedAnswerBody {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== 'answer-draft@1' && value['schemaVersion'] !== 'answer-draft@2') return false
  return Array.isArray(value['blocks']) && Array.isArray(value['claims']) && Array.isArray(value['assertions'])
}

/**
 * Runtime guard for the `answer-draft@3` body. It pins the typed result manifest and the
 * pre-draft finalization receipt by full ref and digest, and requires the narrative blocks,
 * claims, assertions and limitations to be present.
 */
export function isAnswerDraftV3Body(value: unknown): value is AnswerDraftV3Body {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== 'answer-draft@3') return false
  if (!isResourceRef(value['resultManifestRef'])) return false
  if (!isSha256Digest(value['resultManifestDigest'])) return false
  if (!isResourceRef(value['finalizationReceiptRef'])) return false
  if (!isSha256Digest(value['finalizationReceiptDigest'])) return false
  if (!isResourceRef(value['executionBindingRef'])) return false
  if (!Array.isArray(value['blocks'])) return false
  if (!Array.isArray(value['claims'])) return false
  if (!Array.isArray(value['assertions'])) return false
  if (!Array.isArray(value['limitations']) || !value['limitations'].every((entry) => typeof entry === 'string')) {
    return false
  }
  return true
}

/**
 * The canonical hash body of an `answer-draft@3` (SPEC v0.3a §EX-7.1).
 *
 * It binds the verified typed result manifest, the finalization receipt archived *before* the
 * draft, the execution binding and the narrative blocks/claims/assertions/limitations. It
 * deliberately contains no `contentHash`, no `verificationId` and no table/verification
 * receipt: those are produced after this body is hashed and live only on the read envelope
 * `PublishedAnswerV3Envelope`. Counting them back into the body would make the draft hash
 * depend on the verification that itself references the draft hash. `answer-draft@1`/`@2`
 * bodies remain valid and are read unchanged through `PublishedAnswerBody`.
 */
export interface AnswerDraftV3Body {
  readonly schemaVersion: 'answer-draft@3'
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly finalizationReceiptRef: ResourceRef
  readonly finalizationReceiptDigest: Sha256Digest
  readonly executionBindingRef: ResourceRef
  readonly blocks: readonly unknown[]
  readonly claims: readonly DraftClaim[]
  readonly assertions: readonly VerifiedAssertion[]
  readonly limitations: readonly string[]
}

/**
 * Read envelope for an `answer-draft@3`. `contentHash` is the digest of `body`; the
 * verification and table-verification receipts are attached here, outside the hashed body, so
 * a receipt may reference the draft hash without the draft depending on the receipt. Like
 * `currentValidity`, this envelope metadata is never written back into the body.
 */
export interface PublishedAnswerV3Envelope {
  readonly answerId: Uuid
  readonly runId: Uuid
  readonly contentHash: Sha256Digest
  readonly verificationId: Uuid
  readonly body: AnswerDraftV3Body
  /** Archived after the draft; kept out of the body to avoid a draft↔verification cycle. */
  readonly verificationReceiptRef?: ResourceRef
  readonly tableVerificationReceiptRef?: ResourceRef
  /** Current-world validity is envelope metadata; it never changes the body or its hash. */
  readonly currentValidity?: {
    readonly state: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'
    readonly reason?: string
  }
}

/**
 * The final answer version. Its id binds the exact `draftHash`, `evidenceManifestHash`,
 * `verificationId` and scenario manifest the controller published, so a mismatched binding
 * can be detected instead of trusted (SPEC §4.1, INV-09).
 */
export interface PublishedAnswer {
  readonly answerId: Uuid
  readonly runId: Uuid
  readonly draftId: Uuid
  readonly verificationId: Uuid
  /** The verified draft content hash. */
  readonly contentHash: Sha256Digest
  readonly evidenceManifestHash: Sha256Digest
  readonly scenarioManifestHash: Sha256Digest
  readonly publicationKind: PublicationKind
  /** The explicit history point; present only for a `history_limited` publication. */
  readonly asOf?: Rfc3339UtcTimestamp
  /** Explicit gaps/limitations the verified content carries; never hidden by rendering. */
  readonly limitations: readonly string[]
  /** The semantic axis state, kept separate from the verified business body. */
  readonly semanticReview?: SemanticReviewDisposition
  /** Absent only for legacy metadata-only rows; readers must display that body is unavailable. */
  readonly body?: PublishedAnswerBody
  /**
   * The verified `answer-draft@3` body. A @3 publication carries this instead of the legacy
   * `body`; both are never set on one answer. It is the exact body the content hash was
   * computed from, so reading it back returns the same verified version.
   */
  readonly v3Body?: AnswerDraftV3Body
  readonly bodyUnavailableReason?: 'legacy_metadata_only'
  readonly publishedAt: Rfc3339UtcTimestamp
}

export interface PublishRequest {
  readonly grant: PublicationGrant
  readonly draft: AnswerDraft
  readonly verification: VerificationResult
}

export interface AnswerPublisherPort {
  publish(request: PublishRequest, ctx: ToolContext): Promise<PublishedAnswer>
  /** The published answer for a run, or `undefined` when none was published. */
  findAnswer(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined>
}

/**
 * Persistence for published answers. It is separate from `AnswerPublisherPort` so the gate
 * (hash binding, invalidation, history limit) is application logic while the durable,
 * idempotent, scope-checked write is an adapter. `record` re-checks the run state and
 * revision in the same transaction as the insert, so a run cancelled between verification
 * and publication can never leave an answer row behind.
 */
export interface RecordAnswerInput {
  readonly answer: PublishedAnswer
  readonly expectedRunState: RunState
  readonly expectedRunRevision: RevisionString
  readonly workflowDispatchFence?: WorkflowDispatchFence
  /**
   * The exact evidence versions the verified draft depended on. When present, the store
   * re-reads each dependency row inside the same transaction as the answer insert, so a
   * dependency that was retracted or edited between the validity check and the commit
   * (the publication transaction fence) rejects the answer and nothing partial is written.
   */
  readonly dependencyPins?: readonly PublicationDependencyPin[]
}

export type AnswerStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_PUBLISHABLE'
  | 'ANSWER_BODY_REQUIRED'
  | 'ANSWER_IDEMPOTENCY_CONFLICT'
  | 'ANSWER_PERSIST_FAILED'

export class AnswerStoreError extends Error {
  readonly code: AnswerStoreErrorCode

  constructor(code: AnswerStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AnswerStoreError'
    this.code = code
  }
}

export interface AnswerStorePort {
  record(input: RecordAnswerInput, ctx: ToolContext): Promise<PublishedAnswer>
  findByRun(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined>
}

/** Why a post-verification publication check refused or downgraded a publication. */
export type PublicationBlockReason =
  | 'run_cancelled'
  | 'permission_revoked'
  | 'evidence_retracted'
  | 'evidence_unverifiable'
  | 'data_stale'
  /** A dependency was edited after verification; its verified version no longer holds. */
  | 'dependency_edited'
  /** A formal table in the verified result has no earned full-table verification receipt. */
  | 'table_verification_missing'
  /** A registered validation-policy report is missing, failed, or bound to another revision. */
  | 'policy_report_missing'

/**
 * One exact evidence version the verified draft depended on, pinned to the revision and
 * digests it was verified against. It spans every evidence kind (observation, document span,
 * rule derivation, computation, identity decision, model output, web page). A later edit to
 * the archived version, or a retraction of it, makes the pin fail so only the same verified
 * version can be published.
 */
export interface PublicationDependencyPin {
  readonly evidenceRef: ResourceRef
  readonly evidenceKind: EvidenceKind
  readonly resultDigest: Sha256Digest
  readonly envelopeDigest: Sha256Digest
  readonly revision: RevisionString
}

/**
 * One formal table of the verified result that must carry an earned full-table verification
 * receipt before publication (SPEC v0.3a §EX-7.1). The receipt is bound to the draft hash and
 * the exact result manifest digest, so a partial/truncated/tampered table can never publish.
 */
export interface PublicationTableVerificationRequirement {
  readonly draftHash: Sha256Digest
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly tableId: NonEmptyString
  /** The archived `table-verification-receipt@1` the result must carry for this table. */
  readonly receiptRef: ResourceRef
}

/**
 * One registered task-validation-policy report the verified result depends on (SPEC v0.3a
 * §EX-6.1). Publication re-reads the archived report and proves it is the same policy,
 * registry revision and execution it was verified against, and that it passed; a
 * `fail`/`unknown`/`incomplete` policy report or a missing one blocks publication.
 */
export interface PublicationPolicyReportRequirement {
  readonly policyRef: VersionRef
  readonly registryDigest: Sha256Digest
  readonly executionBindingRef: ResourceRef
  readonly inputSnapshotRef: ResourceRef
  readonly inputSnapshotDigest: Sha256Digest
  readonly parametersRef: ResourceRef
  readonly parametersDigest: Sha256Digest
  readonly reportRef: ResourceRef
}

/**
 * The post-verification validity check (D7.4: 发布前复核权限/当前有效性/fence). The evidence
 * hash and refs are re-read so the check is about the exact verified content, not a
 * re-derived one.
 */
export interface PublicationValidityRequest {
  readonly runId: Uuid
  readonly runRevision: RevisionString
  readonly verificationId: Uuid
  readonly evidenceManifestHash: Sha256Digest
  readonly evidenceRefs: readonly ResourceRef[]
  readonly verifiedAt: Rfc3339UtcTimestamp
  /**
   * The exact versions the draft was verified against, when known. A request that names them
   * gets a revision/digest re-check (later edits block as `dependency_edited`); a request that
   * omits them still re-reads the referenced evidence for permission/visibility.
   */
  readonly dependencies?: readonly PublicationDependencyPin[]
  /** Formal tables that must carry an earned full-table verification receipt. */
  readonly tableVerifications?: readonly PublicationTableVerificationRequirement[]
  /** Registered validation-policy reports the result must still be supported by. */
  readonly policyReports?: readonly PublicationPolicyReportRequirement[]
}

/**
 * The result of the validity check. `historyLimited` is set only when the support still
 * exists but the world moved on, so the caller may publish the older result **explicitly
 * marked** with `asOf`. A retracted basis, a revoked permission, an edited dependency or a
 * cancelled run sets `historyLimited` to `false`: those can never be published, not even
 * historically.
 */
export interface PublicationValidityReport {
  readonly publishable: boolean
  readonly blockedReasons: readonly PublicationBlockReason[]
  readonly historyLimited: boolean
  readonly asOf?: Rfc3339UtcTimestamp
  readonly details: readonly string[]
  /**
   * The exact pins the check actually re-read. A publisher forwards them to the answer store
   * so the same dependency versions are re-checked inside the publication transaction fence.
   */
  readonly dependencies?: readonly PublicationDependencyPin[]
}

export interface PublicationValidityPort {
  check(
    request: PublicationValidityRequest,
    ctx: ToolContext,
  ): Promise<PublicationValidityReport>
}

/**
 * A bounded, deterministic limited-answer composer (D7.3/D7.4: 局部正确但证据不足返回有限事实
 * 与缺口). It is a single-shot port like the draft writer: it never starts an agent and it
 * never invents a claim — it may only keep claims that already passed every hard check and
 * mark the rest as explicit gaps.
 */
export interface LimitedAnswerRequest {
  readonly runId: Uuid
  readonly question: NonEmptyString
  readonly inputManifest: WorkflowInputManifest
  /** The last draft the bounded repair produced, if any. */
  readonly previousDraft?: AnswerDraft
  /** The last recorded verdict; only its supported claims may survive into the limited result. */
  readonly failedVerification?: VerificationResult
  readonly remainingBudget: BudgetRemaining
}

export interface LimitedAnswerResult {
  readonly draft: AnswerDraft
  /** The explicit gaps the limited result declares; never empty when facts were dropped. */
  readonly gaps: readonly string[]
  readonly usage?: ToolUsage
  readonly evidenceRefs?: readonly ResourceRef[]
}

export interface LimitedAnswerPort {
  compose(request: LimitedAnswerRequest, ctx: ToolContext): Promise<LimitedAnswerResult>
}

export interface VerificationRecord {
  readonly runId: Uuid
  readonly verification: VerificationResult
}

/**
 * Persistence for verification results. The publisher re-reads the recorded verification
 * by id, so a verdict that was never actually produced by the verifier cannot be used to
 * publish (D2.1: 不能只凭模型返回 pass 插入答案).
 */
export interface VerificationStorePort {
  record(record: VerificationRecord, ctx: ToolContext): Promise<void>
  find(verificationId: Uuid, ctx: ToolContext): Promise<VerificationRecord | undefined>
}

export interface StaleInput {
  readonly entryId: Uuid
  readonly reason: NonEmptyString
}

export interface WorkflowInputValidityReport {
  readonly valid: boolean
  readonly staleEntries: readonly StaleInput[]
}

/**
 * Re-checks that the referenced inputs are still valid (not stale) before a resume is
 * allowed to continue. A stale input forces re-collection on the same budget/manifest.
 */
export interface InputValidityPort {
  validate(entries: readonly WorkflowInputEntry[], ctx: ToolContext): Promise<WorkflowInputValidityReport>
}

/** Selects exactly one runtime adapter for a run's locked runtime ref. */
export interface RuntimeSelectorPort {
  select(runtimeRef: VersionRef, ctx: ToolContext): Promise<RuntimeAdapter>
}

export interface RuntimeCapabilityContext {
  readonly runId: Uuid
  readonly resolvedProfileRef: ResolvedProfileRef
  readonly runtimeRef: VersionRef
  readonly budgetLedgerId: Uuid
  /** The controller's real collection signal; optional only for source compatibility with older hosts. */
  readonly signal?: AbortSignal
}

/**
 * Host-injected restricted closure for one run. It is built in process from real adapters
 * and is never deserialized from model-serializable parameters. `ctx` and the budget
 * projection are supplied by the controller, not by this factory.
 */
export interface RuntimeCapabilitySet {
  readonly gateway: ToolGateway
  readonly generation: GenerationPort
  readonly decision: DecisionPort
  readonly checkpoints: RuntimeCheckpointPort
}

export interface RuntimeCapabilityFactoryPort {
  forRun(context: RuntimeCapabilityContext, ctx: ToolContext): Promise<RuntimeCapabilitySet>
}

/**
 * Persistence for the one run manifest, the shared input manifest and the small mutable
 * workflow counters. It is not an event or budget ledger: those stay in
 * `ControlRepository` and `BudgetLedgerStore`.
 */
export interface WorkflowManifestStore {
  saveRunManifest(manifest: RunManifest, ctx: ToolContext): Promise<RunManifest>
  getRunManifest(runId: Uuid, ctx: ToolContext): Promise<RunManifest | undefined>
  saveInputManifest(manifest: WorkflowInputManifest, ctx: ToolContext): Promise<WorkflowInputManifest>
  getInputManifest(manifestId: Uuid, ctx: ToolContext): Promise<WorkflowInputManifest | undefined>
  saveRunState(state: WorkflowRunState, expectedRevision: RevisionString, ctx: ToolContext): Promise<WorkflowRunState>
  getRunState(runId: Uuid, ctx: ToolContext): Promise<WorkflowRunState | undefined>
}

/** Bounded workflow policy. A model or request can never loosen it. */
export interface WorkflowLimits {
  /** Maximum draft attempts (initial draft plus bounded repairs). */
  readonly maxDraftAttempts: number
  /**
   * Maximum times the controller may re-enter the collection loop before it stops with a
   * persisted `NO_PROGRESS`. This is the outer safety bound for a runtime that keeps
   * returning without a terminal event; the runtime still owns its own bounded
   * round/budget/deadline stop. It never resets the shared ledger.
   */
  readonly maxCollectionRounds: number
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxDraftAttempts: 2,
  // SPEC §EX-10 caps the Pi loop at 6 rounds; the controller admits a small margin so a
  // legitimate clarification/re-collection cycle does not collide with the hard stop.
  maxCollectionRounds: 8,
}
