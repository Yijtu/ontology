import type {
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ModelingBrief } from './modeling-brief'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid, isVersionRef } from './asset-workspace'

/**
 * Bounded AI-research contracts (design §2.1/§2.3, A-R02).
 *
 * A research request **separates the source count from the candidate count**: `sourceLimit`
 * bounds how many public sources the run may discover and archive, `candidateLimit` bounds how
 * many definition/rule-action candidates a later generation may propose. The two are never
 * collapsed into one `candidateLimit` again. Both counts, the brief, the research policy and the
 * budget are pinned before the run starts, and the execution record is immutable.
 *
 * The run only *proposes* sources (`agent_researched`, `proposed`): it can never publish, ground
 * a candidate directly, or become a project fact. Candidate generation after a source review is a
 * new, explicitly authorized operation with its own budget, not a retry of the research run.
 */

/** Where a run is, mirroring the state vocabulary of §1.3: 检索/归档→待确认来源→纳入建模→生成候选. */
export type ResearchStage =
  | 'planning'
  | 'searching'
  | 'archiving'
  | 'awaiting_source_review'
  | 'generating_candidates'
  | 'completed'

export type ResearchStatus = 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'cancelled' | 'failed'

/** Why a run stopped. `partial_results` is an honest bounded outcome, never a silent success. */
export type ResearchStopReason =
  | 'completed'
  | 'partial_results'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'budget_exhausted'
  | 'no_results'
  | 'provider_failed'

/** The two distinct counts, and the time window the run may operate in. */
export interface ResearchLimits {
  /** Maximum research sources to discover and archive (1..200). */
  readonly sourceLimit: number
  /** Maximum candidates a later generation may propose (1..500); never reused as the source cap. */
  readonly candidateLimit: number
  /** Hard wall-clock deadline; the run must abort at or before it. */
  readonly deadline: Rfc3339UtcTimestamp
}

/**
 * The immutable request that starts a bounded research run. `allowedDomains` is the effective
 * allowlist (deployment/space policy ∩ the user's selection); a provider must never widen it.
 */
export interface ResearchRequest {
  readonly schemaVersion: 'research-request@1'
  readonly workspaceId: Uuid
  readonly brief: ModelingBrief
  readonly limits: ResearchLimits
  readonly allowedDomains: readonly string[]
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  readonly idempotencyKey: string
}

/** Honest coverage statistics; every skipped/truncated/failed item is reported, never hidden. */
export interface ResearchCoverage {
  readonly queriesPlanned: number
  readonly searchCalls: number
  readonly pagesDiscovered: number
  readonly archivedSnapshots: number
  /** Pages seen without an archived snapshot: links only, never citable as a formal basis. */
  readonly skippedWithoutSnapshot: number
  readonly excludedCount: number
  readonly failedCount: number
  readonly truncated: boolean
}

/**
 * One immutable research execution. It pins the brief/policy/budget it ran under, references the
 * job that owns progress/cancellation, and carries the coverage and both counts so a reader never
 * re-derives them from a page. `sourceCount`/`candidateCount` are deliberately separate.
 */
export interface ResearchExecution {
  readonly schemaVersion: 'research-execution@1'
  readonly researchId: Uuid
  readonly workspaceId: Uuid
  readonly jobId: Uuid
  readonly status: ResearchStatus
  readonly stage: ResearchStage
  readonly briefRef: ResourceRef
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  readonly limits: ResearchLimits
  readonly coverage: ResearchCoverage
  /** Candidate sources registered by this run. */
  readonly sourceCount: number
  /** Candidates generated from confirmed sources; zero until a separate generation runs. */
  readonly candidateCount: number
  readonly stopReason?: ResearchStopReason
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface ResearchExecutionPage {
  readonly executions: readonly ResearchExecution[]
  readonly nextCursor?: string
}

export type ResearchErrorCode =
  | 'INVALID_REQUEST' | 'NOT_FOUND' | 'SCOPE_MISMATCH' | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT' | 'BUDGET_EXHAUSTED' | 'STORE_FAILED'

export class ResearchError extends Error {
  constructor(readonly code: ResearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResearchError'
  }
}

/**
 * Control persistence for research executions. It stores no secrets and no provider body; the
 * archived bytes live in immutable artifacts referenced by the registered candidate sources.
 */
export interface ResearchExecutionStore {
  putExecution(scopeRef: ScopeRef, execution: ResearchExecution, ctx: ToolContext): Promise<ResearchExecution>
  getExecution(scopeRef: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecution | undefined>
  listExecutions(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    page: { readonly limit: number; readonly cursor?: string },
    ctx: ToolContext,
  ): Promise<ResearchExecutionPage>
}

export const RESEARCH_STAGES: readonly ResearchStage[] = [
  'planning',
  'searching',
  'archiving',
  'awaiting_source_review',
  'generating_candidates',
  'completed',
]
export const RESEARCH_STATUSES: readonly ResearchStatus[] = [
  'queued',
  'running',
  'awaiting_confirmation',
  'completed',
  'cancelled',
  'failed',
]
export const RESEARCH_STOP_REASONS: readonly ResearchStopReason[] = [
  'completed',
  'partial_results',
  'cancelled',
  'deadline_exceeded',
  'budget_exhausted',
  'no_results',
  'provider_failed',
]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCount(value: unknown, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
}

function assertResearchLimits(value: unknown): void {
  if (!isRecord(value) || !isCount(value['sourceLimit'], 200) || (value['sourceLimit'] as number) < 1
    || !isCount(value['candidateLimit'], 500) || (value['candidateLimit'] as number) < 1
    || !isNonEmptyString(value['deadline'])) {
    throw new ResearchError('INVALID_REQUEST', 'research limits require a source limit of 1..200, a candidate limit of 1..500 and a deadline')
  }
}

function assertCoverage(value: unknown): void {
  if (!isRecord(value)) throw new ResearchError('INVALID_REQUEST', 'research coverage must be an object')
  for (const key of ['queriesPlanned', 'searchCalls', 'pagesDiscovered', 'archivedSnapshots', 'skippedWithoutSnapshot', 'excludedCount', 'failedCount'] as const) {
    if (!isCount(value[key], Number.MAX_SAFE_INTEGER)) throw new ResearchError('INVALID_REQUEST', `research coverage ${key} must be a non-negative integer`)
  }
  if (typeof value['truncated'] !== 'boolean') throw new ResearchError('INVALID_REQUEST', 'research coverage truncated must be a boolean')
}

/** Runtime validation of a research request before a run is created. */
export function assertResearchRequestShape(value: unknown): asserts value is ResearchRequest {
  if (!isRecord(value) || value.schemaVersion !== 'research-request@1' || !isUuid(value.workspaceId)
    || !isRecord(value.brief) || !Array.isArray(value.allowedDomains) || value.allowedDomains.length === 0 || value.allowedDomains.length > 32
    || !value.allowedDomains.every((domain) => typeof domain === 'string' && domain.length > 0)
    || !isVersionRef(value['policyRef']) || !isVersionRef(value['budgetRef'])
    || !isNonEmptyString(value['idempotencyKey'])) {
    throw new ResearchError('INVALID_REQUEST', 'invalid research request')
  }
  assertResearchLimits(value['limits'])
}

/** Runtime validation of a persisted research execution. */
export function assertResearchExecutionShape(value: unknown): asserts value is ResearchExecution {
  if (!isRecord(value) || value.schemaVersion !== 'research-execution@1' || !isUuid(value.researchId)
    || !isUuid(value.workspaceId) || !isUuid(value.jobId)
    || !RESEARCH_STATUSES.includes(value.status as ResearchStatus)
    || !RESEARCH_STAGES.includes(value.stage as ResearchStage)
    || !isResourceRef(value.briefRef) || !isVersionRef(value.policyRef) || !isVersionRef(value.budgetRef)
    || !isCount(value.sourceCount, Number.MAX_SAFE_INTEGER) || !isCount(value.candidateCount, Number.MAX_SAFE_INTEGER)
    || !isNonEmptyString(value.recordedAt)
    || (value.stopReason !== undefined && !RESEARCH_STOP_REASONS.includes(value.stopReason as ResearchStopReason))) {
    throw new ResearchError('INVALID_REQUEST', 'invalid research execution')
  }
  assertResearchLimits(value.limits)
  assertCoverage(value.coverage)
}
