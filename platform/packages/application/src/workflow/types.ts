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
