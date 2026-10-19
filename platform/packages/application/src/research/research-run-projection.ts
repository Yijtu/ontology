import type {
  BudgetConsumption,
  BudgetLedgerLimits,
  ResearchBudgetDimensions,
  ResearchCandidateReceiptSummary,
  ResearchCoverage,
  ResearchCoverageGap,
  ResearchEvidenceItem,
  ResearchExecutionGoal,
  ResearchExecutionV2,
  ResearchHumanTodo,
  ResearchLimits,
  ResearchStopReason,
  ResearchUsage,
  ResourceRef,
  Rfc3339UtcTimestamp,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { ModelingBriefMustCover } from '@ontology/contracts'
import type { ResearchDeliveryCandidateReceipt } from '../workflow/types'
import { deterministicUuid } from './run-ledger'

/**
 * The goal-aware completion projection of a workspace-research run (design §8, S09).
 *
 * The controller's completion branch hands its bounded `ResearchDelivery` here; this pure builder
 * turns that delivery plus the **durable** inputs the run was accepted under (admission, archived
 * brief, frozen config, the single ledger and the persisted candidate receipts) into a
 * `research-execution@2` projection. It never reads the SDK's last natural-language message: every
 * count is derived from a persisted receipt, evidence ref or ledger measurement, and a value it
 * cannot derive stays honest (zero / `unresearched`) rather than being invented.
 *
 * `material_found` explicitly does **not** mean a proposition is proven; it means material was
 * located. Human todos are what the run is waiting on, and the stop reason is the run's own recorded
 * reason, never a plan step.
 */
export interface ResearchProjectionInput {
  readonly researchId: Uuid
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly goal: ResearchExecutionGoal
  readonly briefRef: ResourceRef
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  readonly limits: ResearchLimits
  /** The frozen `mustCover` items of the archived brief; every one is projected, none dropped. */
  readonly mustCover: readonly ModelingBriefMustCover[]
  readonly budgetLimits: BudgetLedgerLimits | undefined
  readonly ledgerDeadline: Rfc3339UtcTimestamp
  readonly consumed: BudgetConsumption | undefined
  readonly usageUnknown: boolean
  readonly candidateReceipts: readonly ResearchCandidateReceiptSummary[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly stopReason: ResearchStopReason
  readonly recordedAt: Rfc3339UtcTimestamp
}

const ZERO_BUDGET: ResearchBudgetDimensions = {
  maxTotalCalls: 0,
  maxSearchCalls: 0,
  maxModelTokens: 0,
  maxModelTurns: 0,
  maxSources: 0,
  maxCandidates: 0,
  maxDownloadBytes: 0,
  maxReadBytes: 0,
  maxConcurrency: 0,
  maxRepairAttempts: 0,
  deadline: '1970-01-01T00:00:00Z',
}

function budgetDimensions(limits: BudgetLedgerLimits | undefined, deadline: Rfc3339UtcTimestamp): ResearchBudgetDimensions {
  if (limits === undefined) return { ...ZERO_BUDGET, deadline }
  return {
    maxTotalCalls: limits.maxToolCalls,
    maxSearchCalls: limits.maxSearches ?? 0,
    maxModelTokens: limits.maxModelTokens ?? 0,
    maxModelTurns: limits.maxModelRounds ?? 0,
    maxSources: limits.maxSources ?? 0,
    maxCandidates: limits.maxCandidates ?? 0,
    maxDownloadBytes: limits.maxDownloadBytes ?? 0,
    maxReadBytes: limits.maxReadBytes ?? 0,
    maxConcurrency: limits.maxParallelTools,
    maxRepairAttempts: limits.maxRepairAttempts,
    deadline,
  }
}

function evidenceOf(evidenceRefs: readonly ResourceRef[]): ResearchEvidenceItem[] {
  // Every archived research page is read back as a web_page evidence item bound to its immutable
  // ref digest, so a reader can re-open exactly what grounded the run.
  return evidenceRefs.map((sourceRef) => ({
    sourceRef,
    locatorKind: 'web_page',
    digest: sourceRef.digest,
    archived: true,
  }))
}

function coverageGapsOf(mustCover: readonly ModelingBriefMustCover[], archivedCount: number): ResearchCoverageGap[] {
  return mustCover.map((item) => ({
    kind: item.kind,
    name: item.name,
    // Material found is exactly that: material was located for this item. It is not a proof, and an
    // item with no located material stays honestly `unresearched`.
    state: archivedCount > 0 ? 'material_found' : 'unresearched',
    evidenceCount: archivedCount,
    ...(item.note === undefined ? {} : { note: item.note }),
  }))
}

function humanTodosOf(
  runId: Uuid,
  archivedCount: number,
  receipts: readonly ResearchCandidateReceiptSummary[],
  recordedAt: Rfc3339UtcTimestamp,
): ResearchHumanTodo[] {
  const todos: ResearchHumanTodo[] = []
  if (archivedCount > 0) {
    todos.push({
      todoId: deterministicUuid('research-human-todo', `${runId}:source_review`),
      kind: 'source_review',
      message: 'research sources are proposed and await human source/admission review',
      createdAt: recordedAt,
    })
  }
  if (receipts.some((receipt) => receipt.pendingConfirmation)) {
    todos.push({
      todoId: deterministicUuid('research-human-todo', `${runId}:candidate_review`),
      kind: 'candidate_review',
      message: 'candidate assets cite an unconfirmed source and await review',
      createdAt: recordedAt,
    })
  }
  return todos
}

function usageOf(
  consumed: BudgetConsumption | undefined,
  archivedCount: number,
  usageUnknown: boolean,
): ResearchUsage {
  return {
    searchCalls: consumed?.searches ?? 0,
    archivedSnapshots: archivedCount,
    modelTokens: consumed?.modelTokens ?? 0,
    modelTurns: consumed?.modelRounds ?? 0,
    candidatesSubmitted: consumed?.candidates ?? 0,
    bytesDownloaded: consumed?.downloadBytes ?? 0,
    bytesRead: consumed?.readBytes ?? 0,
    repairAttempts: consumed?.repairAttempts ?? 0,
    usageUnknown,
  }
}

function coverageOf(consumed: BudgetConsumption | undefined, archivedCount: number): ResearchCoverage {
  return {
    queriesPlanned: archivedCount > 0 ? 1 : 0,
    searchCalls: consumed?.searches ?? 0,
    pagesDiscovered: archivedCount,
    archivedSnapshots: archivedCount,
    skippedWithoutSnapshot: 0,
    excludedCount: 0,
    failedCount: 0,
    truncated: false,
  }
}

/**
 * The initial, in-flight `research-execution@2` projection written at accept time (design §8/§10).
 *
 * It gives the run a durable, readable projection the moment it is admitted — status `queued`,
 * stage `planning`, no evidence/candidates yet — so the research entry can answer a read (or a
 * cancel/resume) by `researchId` without a second source of truth. It carries the exact frozen
 * goal, brief, config policy and the ledger's real ceilings/deadline; nothing is fabricated and
 * the completion `recordDelivery` simply advances the same row (a monotonic upsert).
 */
export interface InitialResearchProjectionInput {
  readonly researchId: Uuid
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly jobId?: Uuid
  readonly goal: ResearchExecutionGoal
  readonly briefRef: ResourceRef
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  readonly limits: ResearchLimits
  readonly mustCover: readonly ModelingBriefMustCover[]
  readonly budgetLimits: BudgetLedgerLimits | undefined
  readonly ledgerDeadline: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** Build the queued `research-execution@2` projection of a freshly-admitted run. */
export function initialResearchExecutionProjection(input: InitialResearchProjectionInput): ResearchExecutionV2 {
  return {
    schemaVersion: 'research-execution@2',
    researchId: input.researchId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    goal: input.goal,
    status: 'queued',
    stage: 'planning',
    briefRef: input.briefRef,
    policyRef: input.policyRef,
    budgetRef: input.budgetRef,
    budget: budgetDimensions(input.budgetLimits, input.ledgerDeadline),
    limits: input.limits,
    coverage: coverageOf(undefined, 0),
    coverageGaps: input.mustCover.map((item) => ({
      kind: item.kind,
      name: item.name,
      state: 'unresearched' as const,
      evidenceCount: 0,
      ...(item.note === undefined ? {} : { note: item.note }),
    })),
    humanTodos: [],
    evidence: [],
    candidateReceipts: [],
    sourceCount: 0,
    candidateCount: 0,
    usage: usageOf(undefined, 0, false),
    recordedAt: input.recordedAt,
  }
}

/**
 * Advance an existing `@2` projection to a terminal stop that produced **no** delivery
 * (design §3/§8: failed, cancelled, deadline/budget exhaustion).
 *
 * The completion path (`buildResearchExecutionProjection`) describes a run that ended by handing
 * material to a human. A run that died in the worker, was cancelled by the user, or ran out of
 * deadline/budget never reaches it — without this the row would stay `queued/running` forever and a
 * reader would see a live run that no worker owns. The projection is *not* rebuilt from scratch:
 * the frozen goal/brief/policy/budget/limits and whatever evidence and candidates were already
 * persisted stay exactly as they were. Only the honest stop verdict changes, and the stage is kept
 * at the phase the run actually died in rather than being relabelled `completed`.
 */
export interface TerminalResearchProjectionInput {
  readonly projection: ResearchExecutionV2
  readonly status: 'cancelled' | 'failed'
  readonly stopReason: ResearchStopReason
  readonly recordedAt: Rfc3339UtcTimestamp
}

export function terminalResearchExecutionProjection(input: TerminalResearchProjectionInput): ResearchExecutionV2 {
  const { projection } = input
  const humanTodos = projection.humanTodos.filter((todo) => todo.kind !== 'source_review' && todo.kind !== 'candidate_review')
  return {
    ...projection,
    status: input.status,
    // The run stopped where it stopped; a terminal failure is not the `completed` stage.
    stage: projection.stage === 'completed' ? 'planning' : projection.stage,
    humanTodos,
    stopReason: input.stopReason,
    recordedAt: input.recordedAt,
  }
}

/**
 * Map a terminal controller run onto the canonical research stop reason. The controller records a
 * bounded, canonical reason on the run (`cancelReason`); an unrecognised value stays honest as
 * `provider_failed` rather than being reported as a successful completion.
 */
export function stopReasonOfTerminalRun(state: 'cancelled' | 'failed', reason: string | undefined): ResearchStopReason {
  if (state === 'cancelled') return 'cancelled'
  const value = reason ?? ''
  if (/deadline/i.test(value)) return 'deadline_exceeded'
  if (/budget|quota|exhaust/i.test(value)) return 'budget_exhausted'
  // Anything else is an unmapped execution failure. Reporting it as `partial_results` or
  // `completed` would claim material the run never delivered.
  return 'provider_failed'
}

/** Build the deterministic `research-execution@2` projection of a completed run. */
export function buildResearchExecutionProjection(input: ResearchProjectionInput): ResearchExecutionV2 {
  const evidence = evidenceOf(input.evidenceRefs)
  const archivedCount = evidence.filter((item) => item.archived).length
  const receiptSummaries = dedupeReceipts(input.candidateReceipts)
  const candidateIds = new Set(receiptSummaries.map((receipt) => receipt.candidateId))
  const humanTodos = humanTodosOf(input.runId, archivedCount, receiptSummaries, input.recordedAt)
  const waitingOnHuman = humanTodos.length > 0
  return {
    schemaVersion: 'research-execution@2',
    researchId: input.researchId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    goal: input.goal,
    status: waitingOnHuman ? 'awaiting_confirmation' : 'completed',
    stage: waitingOnHuman ? 'awaiting_source_review' : 'completed',
    briefRef: input.briefRef,
    policyRef: input.policyRef,
    budgetRef: input.budgetRef,
    budget: budgetDimensions(input.budgetLimits, input.ledgerDeadline),
    limits: input.limits,
    coverage: coverageOf(input.consumed, archivedCount),
    coverageGaps: coverageGapsOf(input.mustCover, archivedCount),
    humanTodos,
    evidence,
    candidateReceipts: receiptSummaries,
    sourceCount: archivedCount,
    candidateCount: candidateIds.size,
    usage: usageOf(input.consumed, archivedCount, input.usageUnknown),
    stopReason: input.stopReason,
    recordedAt: input.recordedAt,
  }
}

function dedupeReceipts(
  receipts: readonly ResearchCandidateReceiptSummary[],
): ResearchCandidateReceiptSummary[] {
  const byCandidate = new Map<Uuid, ResearchCandidateReceiptSummary>()
  for (const receipt of receipts) {
    const existing = byCandidate.get(receipt.candidateId)
    // A candidate may be re-proposed; keep the first deterministic summary per candidate id.
    if (existing === undefined) byCandidate.set(receipt.candidateId, receipt)
  }
  return [...byCandidate.values()]
}

/** Project one candidate-write delivery receipt onto the per-candidate V2 summary it describes. */
export function candidateSummaryOf(receipt: ResearchDeliveryCandidateReceipt): ResearchCandidateReceiptSummary[] {
  const state = receipt.status === 'accepted' && receipt.issueCodes.length > 0
    ? 'pending_confirmation'
    : receipt.status
  return receipt.candidateIds.map((candidateId) => ({
    candidateId,
    kind: candidateKindOf(receipt.commandKind),
    state: state as ResearchCandidateReceiptSummary['state'],
    pendingConfirmation: receipt.status === 'pending_confirmation' || receipt.issueCodes.includes('SOURCE_TRUST_BLOCKED'),
    issueCodes: [...receipt.issueCodes],
  }))
}

function candidateKindOf(commandKind: ResearchDeliveryCandidateReceipt['commandKind']): ResearchCandidateReceiptSummary['kind'] {
  // `submit_candidates` writes the whole discriminated union; the per-candidate kind is not carried
  // by the call receipt, so a definition is the safe default and every id still counts distinctly.
  return commandKind === 'submit_candidates' ? 'definition' : 'source'
}
