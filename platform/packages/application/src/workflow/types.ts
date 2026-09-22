import type {
  AnswerPublisherPort,
  AnswerVerifierPort,
  BudgetLedgerLimits,
  BudgetLedgerPort,
  CreateRunContext,
  DraftWriterPort,
  InputValidityPort,
  LimitedAnswerPort,
  ProfileRef,
  PublishedAnswer,
  RevisionString,
  RunPreferences,
  RunState,
  RuntimeSelectorPort,
  Sha256Digest,
  Uuid,
  VersionRef,
  VerificationStorePort,
  WorkflowLimits,
  WorkflowManifestStore,
} from '@ontology/contracts'
import type { RuntimeCapabilityFactoryPort } from '@ontology/contracts'
import type { RunService } from '../runs'
import type { RunPhaseDriver } from './phase-driver'

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
