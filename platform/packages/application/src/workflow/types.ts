import type {
  AnswerPublisherPort,
  AnswerVerifierPort,
  AuthoringCommandKind,
  AuthoringCommandReceiptStatus,
  BudgetLedgerLimits,
  BudgetLedgerPort,
  BudgetRemaining,
  CreateRunContext,
  DraftWriterPort,
  InputValidityPort,
  LimitedAnswerPort,
  ProfileRef,
  PublishedAnswer,
  ResearchExecutionGoal,
  ResourceRef,
  RevisionString,
  ToolContext,
  RunPreferences,
  RunState,
  RuntimeSelectorPort,
  Sha256Digest,
  Uuid,
  VersionRef,
  VerificationStorePort,
  WorkflowLimits,
  WorkflowManifestStore,
  WorkflowDispatchFence,
} from '@ontology/contracts'
import type { RuntimeCapabilityFactoryPort } from '@ontology/contracts'
import type { RunService } from '../runs'
import type { RunPhaseDriver } from './phase-driver'
import type { QuestionRewriter } from './question-rewriting'

export interface WorkflowControllerDependencies {
  /** Run creation, cancellation, clarification and the public event log (LOCAL-009). */
  readonly runs: RunService
  /** Outer phase transitions over the same run store and control ledger. */
  readonly phase: RunPhaseDriver
  /** The run's one shared budget ledger (LOCAL-010). */
  readonly budget: BudgetLedgerPort
  /** The one run manifest and the shared input manifest. */
  readonly manifests: WorkflowManifestStore
  /** Selects exactly one runtime adapter for the run's locked runtime ref. */
  readonly runtimes: RuntimeSelectorPort
  /** Builds the host-injected restricted runtime closure for one run. */
  readonly capabilities: RuntimeCapabilityFactoryPort
  readonly draftWriter: DraftWriterPort
  /**
   * Bounded deterministic fallback used when the shared draft-repair budget is exhausted:
   * it keeps only already-supported claims and states the gaps, so the controller never
   * publishes unverified prose.
   */
  readonly limited: LimitedAnswerPort
  readonly verifier: AnswerVerifierPort
  readonly verifications: VerificationStorePort
  readonly publisher: AnswerPublisherPort
  readonly validity: InputValidityPort
  /**
   * Current durable worker lease used to fence publication. The host refreshes this value
   * as the dispatch lease is renewed; the answer store re-checks it in the publication
   * transaction. User-driven in-process callers may omit it.
   */
  readonly publicationFence?: (runId: Uuid, ctx: ToolContext) => Promise<WorkflowDispatchFence | undefined>
  /**
   * The bounded question-rewriting pre-step (LOCAL-074/LOCAL-080). When present the
   * controller runs it once during preflight, before it selects a runtime or starts
   * collection: a successful rewrite is persisted on the durable run record, an ambiguity
   * takes the existing `clarification_requested` path, and a failure fails the run
   * explicitly. When absent the run path is unchanged.
   */
  readonly rewriter?: QuestionRewriter
  /**
   * The durable candidate-submission receipts of a research run (design §8: 持久候选回执). When
   * present the controller reads the candidates a research run actually wrote from storage, so a
   * resumed or restarted run reports the same delivery. It is the single truth: an empty result
   * means the run wrote no candidates. When absent the controller reports no receipts (not a
   * fabricated candidate).
   */
  readonly researchReceipts?: ResearchCandidateReceiptReader
  /**
   * The durable completion projection of a research run (design §8, S09). When present the
   * controller persists the bounded delivery and the goal-aware `research-execution@2` projection
   * over the run's durable cancellation/dispatch fence, before it parks the run on a human.
   */
  readonly researchProjection?: ResearchDeliveryProjectionPort
  readonly now?: () => string
  readonly newId?: () => string
  readonly limits?: Partial<WorkflowLimits>
}

export interface StartWorkflowInput {
  readonly runId: Uuid
  readonly profileRef: ProfileRef
  readonly question: string
  readonly context: CreateRunContext
  readonly preferences: RunPreferences
  readonly idempotencyKey: string
  /** Deployment/scenario budget tightening; it can only make the budget stricter. */
  readonly budgetOverrides?: Partial<BudgetLedgerLimits>
  /**
   * The research goal this run is created under (design §4/§8). Its presence turns the run into a
   * research run whose completion is a delivery list, not a published answer. Absent for the
   * ordinary project-Q&A route.
   */
  readonly goal?: ResearchExecutionGoal
  /** The authorization receipt fixed before a research run (design §8). Absent for non-research. */
  readonly authorizationReceiptRef?: ResourceRef
}

export interface RespondWorkflowInput {
  readonly runId: Uuid
  readonly clarificationId: Uuid
  readonly typedResponse: Readonly<Record<string, unknown>>
  readonly expectedRevision: RevisionString | undefined
}

export interface CancelWorkflowInput {
  readonly runId: Uuid
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
}

export interface WorkflowView {
  readonly runId: Uuid
  readonly state: RunState
  readonly revision: RevisionString
  readonly runtimeRef: VersionRef
  readonly resolvedProfileHash: Sha256Digest
  readonly budgetLedgerId: Uuid
  readonly inputManifestRevision: RevisionString
  readonly evidenceCount: number
  readonly draftAttempts: number
  readonly usageUnknown: boolean
  readonly pendingClarificationId?: Uuid
  readonly cancelReason?: string
  readonly answer?: PublishedAnswer
}

/** One candidate write receipt the run produced, projected onto the research delivery list. */
export interface ResearchDeliveryCandidateReceipt {
  readonly callId: Uuid
  readonly commandKind: AuthoringCommandKind
  readonly status: AuthoringCommandReceiptStatus
  readonly candidateIds: readonly Uuid[]
  readonly issueCodes: readonly string[]
}

/**
 * The durable candidate write receipts of one run (design §8). The run-completion projection reads
 * these from storage rather than from the in-memory transcript, so a resumed/restarted run reports
 * the candidates it actually wrote. The implementation lives in the composition/adapters; the
 * controller only sees the port.
 */
export interface ResearchCandidateReceiptReader {
  listForRun(runId: Uuid, ctx: ToolContext): Promise<readonly ResearchDeliveryCandidateReceipt[]>
}

/**
 * The bounded outcome of a research run (design §8: 候选回执/证据清单/用量). It is **not** a
 * published answer or an industry pack — a research run never maps its completion to an answer
 * publication. The single ledger's remaining projection is reported as usage. When the run also
 * produces a user-facing factual summary, that summary must still pass the same-draft
 * verification step; this delivery list carries no such prose.
 */
export interface ResearchDelivery {
  readonly runId: Uuid
  readonly candidateReceipts: readonly ResearchDeliveryCandidateReceipt[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly stopReason: string
  readonly usage: BudgetRemaining
}

/**
 * Persists the goal-aware completion projection of a research run (design §8, S09). The controller
 * calls it once at the collection-end boundary, before the run parks on a human: it commits the
 * delivery and the `research-execution@2` projection from the durable receipts/evidence/ledger. A
 * host that mounts no projection store leaves it absent, and the in-memory delivery is still
 * returned.
 */
export interface ResearchDeliveryProjectionPort {
  recordDelivery(runId: Uuid, delivery: ResearchDelivery, ctx: ToolContext): Promise<void>
}
