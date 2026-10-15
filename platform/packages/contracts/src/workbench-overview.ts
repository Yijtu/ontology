import type {
  IndustryWorkspaceState,
  ProjectReadinessKind,
  ProjectReadinessState,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isRevisionString, isSha256Digest, isUuid } from './asset-workspace'

/**
 * The knowledge-workbench overview (design §2.1, A-R01). It is a **deterministic, fixed-revision
 * read-only projection**: the counts, the next step and the blockers are derived server-side from
 * persisted workspace/project/candidate/job state, never guessed by a model, and every step links
 * to a concrete recovery target. The projection is not a new approval truth: executing a step
 * re-authorizes and re-validates in the owning service.
 */

export type WorkbenchSubjectKind = 'space' | 'industry_workspace' | 'project'

/** The work object an overview describes, with the fixed revision it was projected from. */
export type WorkbenchSubject =
  | { readonly kind: 'space' }
  | { readonly kind: 'industry_workspace'; readonly workspaceId: Uuid; readonly revision: RevisionString }
  | { readonly kind: 'project'; readonly projectId: Uuid; readonly revision: RevisionString }

/** Explicit stage counts. No unexplained percentage is ever produced from these. */
export interface WorkbenchCounts {
  readonly proposedSources: number
  readonly approvedSourcesNotAdmitted: number
  readonly candidatesPendingReview: number
  readonly recordsPendingConfirmation: number
  readonly blockedTasks: number
}

export type WorkbenchNextStepAction =
  | 'choose_source'
  | 'confirm_sources'
  | 'admit_sources'
  | 'generate_candidates'
  | 'review_candidates'
  | 'validate_and_publish'
  | 'map_project_data'
  | 'confirm_records'
  | 'run_task'

export type WorkbenchTargetKind = 'industry_workspace' | 'project' | 'source' | 'candidate' | 'task' | 'research_run'

export interface WorkbenchTargetRef {
  readonly kind: WorkbenchTargetKind
  readonly id: Uuid
}

export interface WorkbenchNextStep {
  readonly action: WorkbenchNextStepAction
  readonly label: string
  readonly reason: string
  readonly target?: WorkbenchTargetRef
}

export interface WorkbenchBlocker {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly recoveryAction?: WorkbenchNextStepAction
  readonly target?: WorkbenchTargetRef
}

/** A capability the overview reports; an unavailable one carries a concrete reason, never a blank. */
export type WorkbenchAbility =
  | 'generation'
  | 'research'
  | 'decision_jev'
  | 'archive'
  | 'structured_ingestion'

export interface WorkbenchCapability {
  readonly ability: WorkbenchAbility
  readonly available: boolean
  readonly unavailableReason?: string
}

export interface WorkbenchOverview {
  readonly schemaVersion: 'workbench-overview@1'
  readonly scopeRef: ScopeRef
  readonly subject: WorkbenchSubject
  /** The exact revision the projection was read at; a reader can detect a moved subject. */
  readonly revision: RevisionString
  /** A digest pinning the projection content. */
  readonly digest: Sha256Digest
  readonly summary: string
  readonly counts: WorkbenchCounts
  readonly nextSteps: readonly WorkbenchNextStep[]
  readonly blockers: readonly WorkbenchBlocker[]
  readonly capabilities: readonly WorkbenchCapability[]
  readonly asOf: Rfc3339UtcTimestamp
}

export type WorkbenchOverviewErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'SCOPE_MISMATCH' | 'STORE_FAILED'

export class WorkbenchOverviewError extends Error {
  constructor(readonly code: WorkbenchOverviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkbenchOverviewError'
  }
}

/** Read-only projection port. It never writes and never returns another scope's counts. */
export interface WorkbenchOverviewReader {
  readOverview(scopeRef: ScopeRef, subject: WorkbenchSubject, ctx: ToolContext): Promise<WorkbenchOverview>
}

/**
 * One readiness projection summarised for the overview (design §2.4/§2.5). The error summary is
 * carried so a caller can return a concrete recovery target instead of a generic prompt.
 */
export interface WorkbenchReadinessSummary {
  readonly kind: ProjectReadinessKind
  readonly state: ProjectReadinessState
  readonly retryable: boolean
  readonly errorCode?: string
}

/**
 * The raw, scope-isolated workspace facts the deterministic overview derives from. Every count is
 * an aggregate over persisted state; none of it is guessed by a model. It carries no proposal or
 * approval truth beyond what the owning services already persist.
 */
export interface WorkbenchWorkspaceState {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly state: IndustryWorkspaceState
  readonly sourceCount: number
  readonly proposedSourceCount: number
  readonly approvedSourceCount: number
  readonly admittedSourceCount: number
  readonly candidateCount: number
  readonly candidatesPendingReview: number
  /** Whether a publishable synthetic validation exists for this workspace revision. */
  readonly validationSatisfied: boolean
  readonly publishedPackRef?: VersionRef
}

/** The raw, scope-isolated project facts the deterministic overview derives from. */
export interface WorkbenchProjectState {
  readonly projectId: Uuid
  readonly revision: RevisionString
  readonly mountedPackRef?: VersionRef
  readonly recordsPendingConfirmation: number
  readonly readiness: readonly WorkbenchReadinessSummary[]
  readonly availableTaskCount: number
}

/** The scope-wide summary counts for the first-screen overview. No per-subject identity is exposed. */
export interface WorkbenchSpaceState {
  readonly workspaceCount: number
  readonly projectCount: number
  readonly proposedSources: number
  readonly approvedSourcesNotAdmitted: number
  readonly candidatesPendingReview: number
  readonly recordsPendingConfirmation: number
  readonly blockedTasks: number
}

/**
 * The read port the deterministic overview service composes (design §2.4/§2.5). A reader runs
 * every query inside the trusted scope, so a subject that is not visible in the caller's
 * tenant/space is `undefined` (a `NOT_FOUND`) rather than another scope's counts.
 */
export interface WorkbenchStateReader {
  readSpaceState(scopeRef: ScopeRef, ctx: ToolContext): Promise<WorkbenchSpaceState>
  readWorkspaceState(scopeRef: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<WorkbenchWorkspaceState | undefined>
  readProjectState(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<WorkbenchProjectState | undefined>
}

/**
 * The capability projection port. Capabilities depend on deployment configuration (a configured
 * model, search provider or structured-ingestion backend), so they are read fresh rather than
 * frozen at construction; an unavailable ability always carries a concrete reason.
 */
export interface WorkbenchCapabilitySource {
  readCapabilities(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly WorkbenchCapability[]>
}

export const WORKBENCH_NEXT_STEP_ACTIONS: readonly WorkbenchNextStepAction[] = [
  'choose_source',
  'confirm_sources',
  'admit_sources',
  'generate_candidates',
  'review_candidates',
  'validate_and_publish',
  'map_project_data',
  'confirm_records',
  'run_task',
]
export const WORKBENCH_ABILITIES: readonly WorkbenchAbility[] = [
  'generation',
  'research',
  'decision_jev',
  'archive',
  'structured_ingestion',
]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function assertSubject(value: unknown): void {
  if (!isRecord(value)) throw new WorkbenchOverviewError('INVALID_REQUEST', 'a workbench subject must be an object')
  switch (value['kind']) {
    case 'space':
      return
    case 'industry_workspace':
      if (!isUuid(value['workspaceId']) || !isRevisionString(value['revision'])) {
        throw new WorkbenchOverviewError('INVALID_REQUEST', 'an industry workspace subject needs workspaceId and revision')
      }
      return
    case 'project':
      if (!isUuid(value['projectId']) || !isRevisionString(value['revision'])) {
        throw new WorkbenchOverviewError('INVALID_REQUEST', 'a project subject needs projectId and revision')
      }
      return
    default:
      throw new WorkbenchOverviewError('INVALID_REQUEST', 'unknown workbench subject kind')
  }
}

/** Runtime validation of the read-only overview projection. */
export function assertWorkbenchOverviewShape(value: unknown): asserts value is WorkbenchOverview {
  if (!isRecord(value) || value.schemaVersion !== 'workbench-overview@1' || !isRecord(value.scopeRef)
    || !isUuid(value.scopeRef.tenantId) || !isUuid(value.scopeRef.spaceId)
    || !isRevisionString(value.revision) || !isSha256Digest(value.digest)
    || !isNonEmptyString(value.summary) || !isNonEmptyString(value.asOf)) {
    throw new WorkbenchOverviewError('INVALID_REQUEST', 'invalid workbench overview')
  }
  assertSubject(value.subject)
  const counts = value.counts
  if (!isRecord(counts)
    || !['proposedSources', 'approvedSourcesNotAdmitted', 'candidatesPendingReview', 'recordsPendingConfirmation', 'blockedTasks'].every((key) => isCount(counts[key]))) {
    throw new WorkbenchOverviewError('INVALID_REQUEST', 'workbench counts must be non-negative integers')
  }
  if (!Array.isArray(value.nextSteps) || !value.nextSteps.every((step) => isRecord(step)
    && WORKBENCH_NEXT_STEP_ACTIONS.includes(step['action'] as WorkbenchNextStepAction)
    && isNonEmptyString(step['label']) && isNonEmptyString(step['reason']))) {
    throw new WorkbenchOverviewError('INVALID_REQUEST', 'workbench next steps must carry a known action, label and reason')
  }
  if (!Array.isArray(value.blockers) || !value.blockers.every((blocker) => isRecord(blocker)
    && isNonEmptyString(blocker['code']) && isNonEmptyString(blocker['message']) && typeof blocker['retryable'] === 'boolean')) {
    throw new WorkbenchOverviewError('INVALID_REQUEST', 'workbench blockers must carry a code, message and retryable flag')
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((capability) => isRecord(capability)
    && WORKBENCH_ABILITIES.includes(capability['ability'] as WorkbenchAbility)
    && typeof capability['available'] === 'boolean'
    && (capability['available'] === true || isNonEmptyString(capability['unavailableReason'])))) {
    throw new WorkbenchOverviewError('INVALID_REQUEST', 'workbench capabilities must be known abilities with a reason when unavailable')
  }
}
