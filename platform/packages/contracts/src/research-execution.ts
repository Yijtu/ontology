import type {
  ByteSize,
  NonEmptyString,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  Semver,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { AssetCandidateState } from './asset-candidates'
import type { ModelingBrief } from './modeling-brief'
import type { CandidateSubmissionKind } from './submit-candidates'
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
 * A link from a research execution to one candidate source it registered. `sourceId` is the
 * `CandidateSource` id and `url` its origin page, so a reader can open the source a run proposed
 * without re-deriving the relationship from a page list. It carries no snapshot bytes.
 */
export interface ResearchSourceRef {
  readonly sourceId: Uuid
  readonly url: string
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
  /** The candidate sources this run proposed, so the sources are readable back from the run. */
  readonly sources?: readonly ResearchSourceRef[]
  readonly stopReason?: ResearchStopReason
  /**
   * When this run was started as an explicit continuation of an earlier **ended** run, the run it
   * was grounded on (design §3/§10). It is informational linkage, never a budget/authorization
   * reuse: the continuation starts a new execution with its own authorization, budget and id, and
   * the previous run stays frozen. Absent for an ordinary run.
   */
  readonly continuedFromResearchId?: Uuid
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface ResearchExecutionPage {
  readonly executions: readonly ResearchExecutionAny[]
  readonly nextCursor?: string
}

export type ResearchErrorCode =
  | 'INVALID_REQUEST' | 'NOT_FOUND' | 'SCOPE_MISMATCH' | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT' | 'BUDGET_EXHAUSTED' | 'STORE_FAILED'
  /** The catalogue has no usable public-search binding for this run (stable capability reason). */
  | 'CAPABILITY_NOT_CONFIGURED'

export class ResearchError extends Error {
  constructor(readonly code: ResearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResearchError'
  }
}

/**
 * Control persistence for research executions. It stores no secrets and no provider body; the
 * archived bytes live in immutable artifacts referenced by the registered candidate sources.
 *
 * The store keeps both projection versions: a legacy `@1` record and an agentic `@2` run
 * projection. Writes and reads use the discriminated `ResearchExecutionAny`, so a reader branches
 * on `schemaVersion` without a migration; a legacy `@1` record is never rewritten into `@2`.
 */
export interface ResearchExecutionStore {
  putExecution(scopeRef: ScopeRef, execution: ResearchExecutionAny, ctx: ToolContext): Promise<ResearchExecutionAny>
  getExecution(scopeRef: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny | undefined>
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
    || (value.continuedFromResearchId !== undefined && !isUuid(value.continuedFromResearchId))
    || (value.stopReason !== undefined && !RESEARCH_STOP_REASONS.includes(value.stopReason as ResearchStopReason))
    || (value['sources'] !== undefined && !isSourceRefs(value['sources']))) {
    throw new ResearchError('INVALID_REQUEST', 'invalid research execution')
  }
  assertResearchLimits(value.limits)
  assertCoverage(value.coverage)
}

function isSourceRefs(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 200
    && value.every((entry) => isRecord(entry) && isUuid(entry['sourceId']) && isNonEmptyString(entry['url']))
}

/* ----------------------------------------------------------------------------------------- */
/* research-execution@2: the agentic-research run projection (design §8)                      */
/* ----------------------------------------------------------------------------------------- */

/**
 * The run goal is a discriminated union: a bounded project Q&A, or an industry-workspace research
 * run pinned to a fixed workspace draft revision. A research run is not an answer publication, so
 * the goal is modelled explicitly instead of reusing the project question field.
 */
export type ResearchExecutionGoal =
  | { readonly kind: 'project_qa'; readonly projectId?: Uuid; readonly question: NonEmptyString }
  | {
      readonly kind: 'industry_workspace_research'
      readonly workspaceId: Uuid
      /** The fixed draft revision the run models; it never tracks a moving head. */
      readonly draftRevision: RevisionString
    }

/** One human action a research run is waiting on; the run itself never blocks a worker on it. */
export type ResearchHumanTodoKind =
  | 'source_review'
  | 'candidate_review'
  | 'terminology_confirmation'
  | 'external_wait'

export interface ResearchHumanTodo {
  readonly todoId: Uuid
  readonly kind: ResearchHumanTodoKind
  readonly message: NonEmptyString
  readonly targetRef?: ResourceRef
  readonly createdAt: Rfc3339UtcTimestamp
}

/**
 * The per-`mustCover` coverage state (design §3). `material_found` explicitly does **not** mean the
 * proposition is proven; it means material was located. A conflict and a pending human confirmation
 * stay separate from "nothing found".
 */
export type ResearchCoverageGapState =
  | 'unresearched'
  | 'material_found'
  | 'conflicting'
  | 'pending_confirmation'

export interface ResearchCoverageGap {
  readonly kind: string
  readonly name: string
  readonly state: ResearchCoverageGapState
  readonly evidenceCount: number
  readonly note?: string
}

/** One evidence item the run collected; `archived` is false for a link-only discovery. */
export interface ResearchEvidenceItem {
  readonly sourceRef: ResourceRef
  readonly locatorKind: 'web_page' | 'document_span' | 'table_row' | 'ontology_definition'
  readonly digest: Sha256Digest
  readonly parserVersion?: Semver
  readonly archived: boolean
}

/** The candidate write receipts a run produced, projected for the run view. */
export interface ResearchCandidateReceiptSummary {
  readonly candidateId: Uuid
  readonly kind: CandidateSubmissionKind
  readonly state: AssetCandidateState | 'proposed' | 'approved' | 'rejected'
  readonly pendingConfirmation: boolean
  readonly issueCodes: readonly string[]
}

/** The bounded usage the run actually consumed (design §8: one ledger, honest usage). */
export interface ResearchUsage {
  readonly searchCalls: number
  readonly archivedSnapshots: number
  readonly modelTokens: number
  readonly modelTurns: number
  readonly candidatesSubmitted: number
  readonly bytesDownloaded: ByteSize
  readonly bytesRead: ByteSize
  readonly repairAttempts: number
  readonly usageUnknown: boolean
}

/**
 * The pinned budget dimensions (design §8). A deployment research policy is the ceiling; a user may
 * only tighten it. Archive downloads, pagination and retries all draw from the single ledger.
 */
export interface ResearchBudgetDimensions {
  readonly maxTotalCalls: number
  readonly maxSearchCalls: number
  readonly maxModelTokens: number
  readonly maxModelTurns: number
  readonly maxSources: number
  readonly maxCandidates: number
  readonly maxDownloadBytes: ByteSize
  readonly maxReadBytes: ByteSize
  readonly maxConcurrency: number
  readonly maxRepairAttempts: number
  readonly deadline: Rfc3339UtcTimestamp
}

/**
 * The agentic-research run projection. It keeps the execution status, the human todos, the stop
 * reason, the candidate receipts, the evidence list, the per-`mustCover` gaps and the usage
 * **separate**, so a reader never re-derives one from another and never reads a plan step as
 * progress. `research-execution@1` records stay readable unchanged.
 */
export interface ResearchExecutionV2 {
  readonly schemaVersion: 'research-execution@2'
  readonly researchId: Uuid
  readonly workspaceId: Uuid
  /** The controller run this projection belongs to. */
  readonly runId: Uuid
  readonly jobId?: Uuid
  readonly goal: ResearchExecutionGoal
  readonly status: ResearchStatus
  readonly stage: ResearchStage
  readonly briefRef: ResourceRef
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  readonly budget: ResearchBudgetDimensions
  readonly limits: ResearchLimits
  readonly coverage: ResearchCoverage
  readonly coverageGaps: readonly ResearchCoverageGap[]
  readonly humanTodos: readonly ResearchHumanTodo[]
  readonly evidence: readonly ResearchEvidenceItem[]
  readonly candidateReceipts: readonly ResearchCandidateReceiptSummary[]
  readonly sourceCount: number
  readonly candidateCount: number
  readonly usage: ResearchUsage
  readonly stopReason?: ResearchStopReason
  /** The candidate sources this run proposed, so the sources are readable back from the run. */
  readonly sources?: readonly ResearchSourceRef[]
  /**
   * When this `@2` run was started as an explicit continuation of an earlier ended run, the run it
   * was grounded on (design §3/§10). Like the `@1` linkage it is informational: the continuation
   * keeps its own authorization, budget and id, and the predecessor stays frozen.
   */
  readonly continuedFromResearchId?: Uuid
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** Either supported execution projection version. An `@1` record is never rewritten into `@2`. */
export type ResearchExecutionAny = ResearchExecution | ResearchExecutionV2

/**
 * The run manifest a research run is created under (design §8): it fixes the brief, the purpose,
 * the runtime, the model binding, the tool bindings, the authorization receipt, the single ledger
 * and the input manifest. It is the research extension of the core `RunManifest`, not a second
 * controller.
 */
export interface ResearchRunManifest {
  readonly schemaVersion: 'research-run-manifest@1'
  readonly runId: Uuid
  readonly purpose: ResearchExecutionGoal['kind']
  readonly goal: ResearchExecutionGoal
  readonly briefRef: ResourceRef
  readonly runtimeRef: VersionRef
  /** The archived `ExecutionModelBinding` the run is pinned to. */
  readonly modelBindingRef: ResourceRef
  /** The archived `ExecutionToolBinding` refs the run is pinned to. */
  readonly toolBindingRefs: readonly ResourceRef[]
  /** The authorization receipt (effective range/limits/recipients) fixed before the run. */
  readonly authorizationReceiptRef: ResourceRef
  readonly budgetLedgerId: Uuid
  readonly inputManifestId: Uuid
  readonly createdAt: Rfc3339UtcTimestamp
}

export const RESEARCH_EXECUTION_GOAL_KINDS: readonly ResearchExecutionGoal['kind'][] = [
  'project_qa',
  'industry_workspace_research',
]

export const RESEARCH_COVERAGE_GAP_STATES: readonly ResearchCoverageGapState[] = [
  'unresearched',
  'material_found',
  'conflicting',
  'pending_confirmation',
]

export const RESEARCH_HUMAN_TODO_KINDS: readonly ResearchHumanTodoKind[] = [
  'source_review',
  'candidate_review',
  'terminology_confirmation',
  'external_wait',
]

/** The projection version of a research execution, or `undefined` when it is not one. */
export function researchExecutionSchemaVersion(
  value: unknown,
): 'research-execution@1' | 'research-execution@2' | undefined {
  if (!isRecord(value)) return undefined
  return value['schemaVersion'] === 'research-execution@1' || value['schemaVersion'] === 'research-execution@2'
    ? value['schemaVersion']
    : undefined
}

export function isResearchExecutionV2(value: unknown): value is ResearchExecutionV2 {
  return researchExecutionSchemaVersion(value) === 'research-execution@2'
}

/**
 * Accept either projection version, so a legacy `@1` research record and a `@2` run projection are
 * both readable without a migration. The caller branches on `schemaVersion` for the richer `@2`
 * fields.
 */
export function assertResearchExecutionAnyShape(value: unknown): asserts value is ResearchExecutionAny {
  const version = researchExecutionSchemaVersion(value)
  if (version === 'research-execution@1') {
    assertResearchExecutionShape(value)
    return
  }
  if (version === 'research-execution@2') {
    assertResearchExecutionV2Shape(value)
    return
  }
  throw new ResearchError('INVALID_REQUEST', 'invalid research execution')
}

function assertGoal(value: unknown): asserts value is ResearchExecutionGoal {
  if (!isRecord(value)) throw new ResearchError('INVALID_REQUEST', 'a research goal must be an object')
  if (value['kind'] === 'project_qa') {
    if (!isNonEmptyString(value['question']) || (value['projectId'] !== undefined && !isUuid(value['projectId']))) {
      throw new ResearchError('INVALID_REQUEST', 'a project qa goal requires a question')
    }
    return
  }
  if (value['kind'] === 'industry_workspace_research') {
    if (!isUuid(value['workspaceId']) || typeof value['draftRevision'] !== 'string' || !/^(0|[1-9]\d*)$/.test(value['draftRevision'])) {
      throw new ResearchError('INVALID_REQUEST', 'an industry workspace research goal requires a workspace and a draft revision')
    }
    return
  }
  throw new ResearchError('INVALID_REQUEST', 'unknown research goal kind')
}

function assertBudgetDimensions(value: unknown): void {
  if (!isRecord(value)) throw new ResearchError('INVALID_REQUEST', 'research budget must be an object')
  const counts = [
    'maxTotalCalls', 'maxSearchCalls', 'maxModelTokens', 'maxModelTurns',
    'maxSources', 'maxCandidates', 'maxDownloadBytes', 'maxReadBytes',
    'maxConcurrency', 'maxRepairAttempts',
  ] as const
  for (const key of counts) {
    if (!isCount(value[key], Number.MAX_SAFE_INTEGER)) {
      throw new ResearchError('INVALID_REQUEST', `research budget ${key} must be a non-negative integer`)
    }
  }
  if (!isNonEmptyString(value['deadline'])) throw new ResearchError('INVALID_REQUEST', 'research budget requires a deadline')
}

function assertUsage(value: unknown): void {
  if (!isRecord(value)) throw new ResearchError('INVALID_REQUEST', 'research usage must be an object')
  for (const key of ['searchCalls', 'archivedSnapshots', 'modelTokens', 'modelTurns', 'candidatesSubmitted', 'bytesDownloaded', 'bytesRead', 'repairAttempts'] as const) {
    if (!isCount(value[key], Number.MAX_SAFE_INTEGER)) throw new ResearchError('INVALID_REQUEST', `research usage ${key} must be a non-negative integer`)
  }
  if (typeof value['usageUnknown'] !== 'boolean') throw new ResearchError('INVALID_REQUEST', 'research usage requires a usageUnknown flag')
}

function assertCoverageGaps(value: unknown): void {
  if (!Array.isArray(value) || value.length > 200) throw new ResearchError('INVALID_REQUEST', 'research coverage gaps must be a bounded array')
  for (const gap of value) {
    if (!isRecord(gap) || typeof gap['kind'] !== 'string' || !isNonEmptyString(gap['name'])
      || !RESEARCH_COVERAGE_GAP_STATES.includes(gap['state'] as ResearchCoverageGapState)
      || !isCount(gap['evidenceCount'], Number.MAX_SAFE_INTEGER)) {
      throw new ResearchError('INVALID_REQUEST', 'a research coverage gap needs a kind, name, state and evidence count')
    }
  }
}

function assertHumanTodos(value: unknown): void {
  if (!Array.isArray(value) || value.length > 200) throw new ResearchError('INVALID_REQUEST', 'research human todos must be a bounded array')
  for (const todo of value) {
    if (!isRecord(todo) || !isUuid(todo['todoId'])
      || !RESEARCH_HUMAN_TODO_KINDS.includes(todo['kind'] as ResearchHumanTodoKind)
      || !isNonEmptyString(todo['message']) || !isNonEmptyString(todo['createdAt'])
      || (todo['targetRef'] !== undefined && !isResourceRef(todo['targetRef']))) {
      throw new ResearchError('INVALID_REQUEST', 'a research human todo needs an id, kind, message and timestamp')
    }
  }
}

function assertEvidenceItems(value: unknown): void {
  if (!Array.isArray(value) || value.length > 1000) throw new ResearchError('INVALID_REQUEST', 'research evidence must be a bounded array')
  for (const item of value) {
    if (!isRecord(item) || !isResourceRef(item['sourceRef'])
      || !['web_page', 'document_span', 'table_row', 'ontology_definition'].includes(String(item['locatorKind']))
      || typeof item['digest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item['digest'])
      || typeof item['archived'] !== 'boolean'
      || (item['parserVersion'] !== undefined && typeof item['parserVersion'] !== 'string')) {
      throw new ResearchError('INVALID_REQUEST', 'a research evidence item is malformed')
    }
  }
}

function assertCandidateReceipts(value: unknown): void {
  if (!Array.isArray(value) || value.length > 500) throw new ResearchError('INVALID_REQUEST', 'research candidate receipts must be a bounded array')
  for (const receipt of value) {
    if (!isRecord(receipt) || !isUuid(receipt['candidateId'])
      || !['source', 'definition', 'rule', 'action'].includes(String(receipt['kind']))
      || !isNonEmptyString(receipt['state'])
      || typeof receipt['pendingConfirmation'] !== 'boolean'
      || !Array.isArray(receipt['issueCodes']) || !receipt['issueCodes'].every((code) => typeof code === 'string')) {
      throw new ResearchError('INVALID_REQUEST', 'a research candidate receipt is malformed')
    }
  }
}

/** Runtime validation of a persisted `research-execution@2` run projection. */
export function assertResearchExecutionV2Shape(value: unknown): asserts value is ResearchExecutionV2 {
  if (!isRecord(value) || value['schemaVersion'] !== 'research-execution@2' || !isUuid(value['researchId'])
    || !isUuid(value['workspaceId']) || !isUuid(value['runId'])
    || (value['jobId'] !== undefined && !isUuid(value['jobId']))
    || !RESEARCH_STATUSES.includes(value['status'] as ResearchStatus)
    || !RESEARCH_STAGES.includes(value['stage'] as ResearchStage)
    || !isResourceRef(value['briefRef']) || !isVersionRef(value['policyRef']) || !isVersionRef(value['budgetRef'])
    || !isCount(value['sourceCount'], Number.MAX_SAFE_INTEGER) || !isCount(value['candidateCount'], Number.MAX_SAFE_INTEGER)
    || !isNonEmptyString(value['recordedAt'])
    || (value['stopReason'] !== undefined && !RESEARCH_STOP_REASONS.includes(value['stopReason'] as ResearchStopReason))
    || (value['continuedFromResearchId'] !== undefined && !isUuid(value['continuedFromResearchId']))
    || (value['sources'] !== undefined && !isSourceRefs(value['sources']))) {
    throw new ResearchError('INVALID_REQUEST', 'invalid research execution @2')
  }
  assertGoal(value['goal'])
  assertResearchLimits(value['limits'])
  assertCoverage(value['coverage'])
  assertBudgetDimensions(value['budget'])
  assertUsage(value['usage'])
  assertCoverageGaps(value['coverageGaps'])
  assertHumanTodos(value['humanTodos'])
  assertEvidenceItems(value['evidence'])
  assertCandidateReceipts(value['candidateReceipts'])
}

/** Runtime validation of a research run manifest before a run is created from it. */
export function assertResearchRunManifestShape(value: unknown): asserts value is ResearchRunManifest {
  if (!isRecord(value) || value['schemaVersion'] !== 'research-run-manifest@1' || !isUuid(value['runId'])
    || !isResourceRef(value['briefRef']) || !isVersionRef(value['runtimeRef'])
    || !isResourceRef(value['modelBindingRef']) || !Array.isArray(value['toolBindingRefs'])
    || value['toolBindingRefs'].length > 16 || !value['toolBindingRefs'].every(isResourceRef)
    || !isResourceRef(value['authorizationReceiptRef'])
    || !isUuid(value['budgetLedgerId']) || !isUuid(value['inputManifestId'])
    || !isNonEmptyString(value['createdAt'])) {
    throw new ResearchError('INVALID_REQUEST', 'invalid research run manifest')
  }
  assertGoal(value['goal'])
  if (value['purpose'] !== value['goal'].kind) {
    throw new ResearchError('INVALID_REQUEST', 'a research run manifest purpose must match its goal kind')
  }
}
