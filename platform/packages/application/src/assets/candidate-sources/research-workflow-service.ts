import {
  ResearchError,
  assertModelingBriefShape,
  assertResearchRequestShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  BudgetLedgerSnapshot,
  PipelineStage,
  ResourceRef,
  ResearchCoverage,
  VersionRef,
  ResearchExecution,
  ResearchExecutionStore,
  ResearchRequest,
  ResearchSourceRef,
  ResearchStopReason,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { BudgetLedgerPort } from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import type { JobService } from '../../jobs/service'
import type { ExecutionModelBindingService } from '../../model-settings/execution-model-binding-service'
import { WebResearchError } from './web-research-service'
import type { WebResearchService } from './web-research-service'
import { RESEARCH_JOB_REQUEST_KIND, decodeResearchJobRequest, encodeResearchJobRequest } from './research-job-ref'

const RESEARCH_ROLES: readonly string[] = ['researcher', 'platform-admin']
const RESEARCH_PIPELINE_VERSION = '1.0.0'

/**
 * The fixed research policy and budget the reference host pins for a run (design §1.4: 固定
 * brief/策略/额度). They are deployment constants, not request fields, so a caller can neither
 * widen the allowed domains nor raise the budget by editing the body.
 */
export const DEFAULT_RESEARCH_POLICY_REF: VersionRef = {
  id: 'research-policy.core', version: '1.0.0', digest: sha256DigestOf('research-policy.core@1.0.0'),
}
export const DEFAULT_RESEARCH_BUDGET_REF: VersionRef = {
  id: 'research-budget.default', version: '1.0.0', digest: sha256DigestOf('research-budget.default@1.0.0'),
}
const TERMINAL_STATUSES: readonly ResearchExecution['status'][] = ['completed', 'cancelled', 'failed']

export interface ResearchWorkflowDependencies {
  readonly jobs: JobService
  readonly executions: ResearchExecutionStore
  readonly research: WebResearchService
  /** The shared budget ledger; the durable job's own background ledger is reused, never reset. */
  readonly budget: BudgetLedgerPort
  /**
   * The per-execution model binding (design §5.3). When present the run pins the research model at
   * authorization and refuses to run on a revoked/broken binding instead of silently switching
   * vendor. When absent the host mounts no model catalogue and the fence is a no-op.
   */
  readonly modelBinding?: ExecutionModelBindingService
  readonly now?: () => string
}

export interface ResearchRunView {
  readonly execution: ResearchExecution
  /** The run's background ledger projection; absent until the worker opens it. */
  readonly usage?: BudgetLedgerSnapshot
  readonly jobStage?: PipelineStage
}

export interface ExecuteResearchInput {
  readonly researchId: Uuid
  readonly request: ResearchRequest
}

/**
 * Optional linkage for a run that continues an earlier one (design §3/§10). It is informational:
 * the continuation still gets its own id, authorization, budget and ledger.
 */
export interface ResearchContinuationLinkage {
  readonly continuedFromResearchId: Uuid
}

function isTerminal(status: ResearchExecution['status']): boolean {
  return TERMINAL_STATUSES.includes(status)
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) throw new ResearchError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) throw new ResearchError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  return { tenantId, spaceId }
}

function assertResearcher(ctx: ToolContext): void {
  if (!ctx.principal.roles.some((role) => RESEARCH_ROLES.includes(role))) {
    throw new ResearchError('SCOPE_MISMATCH', 'web research requires a researcher or platform-admin role')
  }
}

/** Only an editor may pin a model assignment/binding; a researcher defers the pin to the worker. */
function canPinModel(ctx: ToolContext): boolean {
  return ctx.principal.roles.some((role) => role === 'platform-admin' || role === 'profile-editor')
}

function briefRefFor(researchId: Uuid, request: ResearchRequest): ResourceRef {
  return {
    id: `modeling-brief:${researchId}`,
    version: request.limits.deadline,
    digest: sha256DigestOf(canonicalJson(request.brief)),
    kind: 'artifact',
  }
}

/**
 * Bounded research orchestration (design §2.3/§2.4, A-R02).
 *
 * The workflow runs the fixed execution chain — preflight/authorization → durable job + shared
 * budget ledger → bounded query plan → `web_search` (which archives snapshots internally) →
 * `CandidateSource` registration → coverage + stop reason → wait for a human source review.
 *
 * It never publishes: every source it registers is `agent_researched`/`proposed` and needs the
 * existing review/admission gate. It reuses the durable job store for progress/cancellation and
 * the job's own background budget ledger, so a retry or a crash-restart neither resets the budget
 * nor admits a late page; a cancelled run is frozen and cannot be resurrected by a later write.
 */
export class ResearchWorkflowService {
  readonly #jobs: JobService
  readonly #executions: ResearchExecutionStore
  readonly #research: WebResearchService
  readonly #budget: BudgetLedgerPort
  readonly #modelBinding: ExecutionModelBindingService | undefined
  readonly #now: () => string

  constructor(dependencies: ResearchWorkflowDependencies) {
    this.#jobs = dependencies.jobs
    this.#executions = dependencies.executions
    this.#research = dependencies.research
    this.#budget = dependencies.budget
    this.#modelBinding = dependencies.modelBinding
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /**
   * Preflight and authorize one run: pin the research model (when the host mounts one), create the
   * durable job and the budget-backed execution record, and return the queued run. Idempotent on
   * the request key: a replay reuses the same logical job and returns the same execution.
   */
  async start(request: ResearchRequest, ctx: ToolContext, linkage?: ResearchContinuationLinkage): Promise<ResearchExecution> {
    assertResearcher(ctx)
    assertResearchRequestShape(request)
    assertModelingBriefShape(request.brief)
    const scope = scopeOf(ctx)
    const researchId = candidateIdFor(sha256DigestOf(canonicalJson({
      kind: 'research-run@1',
      workspaceId: request.workspaceId,
      brief: request.brief,
      limits: request.limits,
      allowedDomains: request.allowedDomains,
      policyRef: request.policyRef,
      budgetRef: request.budgetRef,
      idempotencyKey: request.idempotencyKey,
    })))

    // Fix the model for this execution before it is queued (design §5.3): a named-but-broken model
    // is refused rather than silently switching vendor, and the same binding is read back on retry.
    // Pinning requires an editor role; when the requester is only a researcher the binding is
    // created once inside the worker (whose context may pin) and read back unchanged thereafter.
    if (this.#modelBinding !== undefined && canPinModel(ctx)) {
      await this.#modelBinding.ensureBinding(
        { executionId: researchId, scope: { kind: 'industry_workspace', workspaceId: request.workspaceId }, capability: 'research' },
        ctx,
      )
    }

    const job = await this.#jobs.createJob({
      jobId: researchId,
      kind: 'research',
      sourceRef: 'workbench.research',
      datasetRef: encodeResearchJobRequest({ kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_PIPELINE_VERSION, researchId, request }),
      pipelineVersion: RESEARCH_PIPELINE_VERSION,
      idempotencyKey: `research-run:${request.idempotencyKey}`,
    }, ctx)

    const existing = await this.#executions.getExecution(scope, researchId, ctx)
    if (existing !== undefined) return existing

    const execution: ResearchExecution = {
      schemaVersion: 'research-execution@1',
      researchId,
      workspaceId: request.workspaceId,
      jobId: job.jobId,
      status: 'queued',
      stage: 'planning',
      briefRef: briefRefFor(researchId, request),
      policyRef: request.policyRef,
      budgetRef: request.budgetRef,
      limits: request.limits,
      coverage: {
        queriesPlanned: 1, searchCalls: 0, pagesDiscovered: 0, archivedSnapshots: 0,
        skippedWithoutSnapshot: 0, excludedCount: 0, failedCount: 0, truncated: false,
      },
      sourceCount: 0,
      candidateCount: 0,
      ...(linkage === undefined ? {} : { continuedFromResearchId: linkage.continuedFromResearchId }),
      recordedAt: this.#now(),
    }
    return this.#executions.putExecution(scope, execution, ctx)
  }

  /**
   * Execute one queued run inside the durable worker. It is idempotent and restart-safe: a run
   * that already reached a terminal status is returned untouched, and the budget is drawn from the
   * job's shared background ledger so a reclaimed attempt never resets it.
   */
  async execute(input: ExecuteResearchInput, ctx: ToolContext, ledgerId: Uuid, signal: AbortSignal): Promise<ResearchExecution> {
    assertResearcher(ctx)
    const scope = scopeOf(ctx)
    const execution = await this.#requireExecution(scope, input.researchId, ctx)
    if (isTerminal(execution.status)) return execution
    if (execution.workspaceId !== input.request.workspaceId) {
      throw new ResearchError('SCOPE_MISMATCH', 'the research job names a different workspace than its execution record')
    }

    // The model fence: pin once (idempotent), then refuse a revoked/broken model instead of
    // silently switching vendor. A named-but-unusable model fails the run rather than rerouting.
    if (this.#modelBinding !== undefined) {
      try {
        await this.#modelBinding.ensureBinding(
          { executionId: input.researchId, scope: { kind: 'industry_workspace', workspaceId: execution.workspaceId }, capability: 'research' },
          ctx,
        )
        await this.#modelBinding.assertUsable(input.researchId, 'research', ctx)
      } catch (error) {
        await this.#finalize(scope, execution, { status: 'failed', stage: 'searching', stopReason: 'provider_failed' }, ctx)
        throw error
      }
    }

    await this.#executions.putExecution(scope, { ...execution, status: 'running', stage: 'searching' }, ctx)

    // The ledger is reopened per attempt but `reserve` is idempotent on the run's key, so a
    // reclaimed attempt draws from the same reservation instead of resetting the budget.
    const reserve = await this.#budget.reserve({
      ledgerId,
      idempotencyKey: `research:${input.researchId}:search`,
      toolCalls: 1,
      requestedDeadline: input.request.limits.deadline,
    }, ctx)
    if (!reserve.granted) {
      return this.#finalize(scope, execution, { status: 'failed', stage: 'searching', stopReason: 'budget_exhausted' }, ctx)
    }
    const reservation = reserve.reservation
    if (reservation === undefined) throw new ResearchError('STORE_FAILED', 'a granted research reservation carried no reservation record')
    const reservationId = reservation.reservationId

    const startedAt = Date.now()
    let result
    try {
      result = await this.#research.research({
        brief: input.request.brief,
        retrievedAt: this.#now(),
        deadline: input.request.limits.deadline,
        signal,
        idempotencyKey: `research:${input.researchId}`,
        admit: () => this.#stillAdmitting(scope, input.researchId, ctx),
      }, ctx)
    } catch (error) {
      await this.#settle(ledgerId, reservationId, 'failed', Date.now() - startedAt, ctx)
      const latest = await this.#requireExecution(scope, input.researchId, ctx)
      if (isTerminal(latest.status)) return latest
      const stopReason: ResearchStopReason = signal.aborted ? 'cancelled' : 'provider_failed'
      if (error instanceof WebResearchError && error.code === 'RESEARCH_FAILED') {
        return this.#finalize(scope, latest, { status: 'failed', stage: 'searching', stopReason }, ctx)
      }
      // A cancellation/failure of the provider is recorded, but a programming error is not
      // swallowed into a fake outcome: the execution is stopped and the error still propagates.
      await this.#finalize(scope, latest, { status: stopReason === 'cancelled' ? 'cancelled' : 'failed', stage: 'searching', stopReason }, ctx)
      throw error
    }
    await this.#settle(ledgerId, reservationId, 'completed', Date.now() - startedAt, ctx)

    // A cancel that landed while the provider was running fences the run: the terminal write is
    // refused by the store, so the late result is never admitted.
    const latest = await this.#requireExecution(scope, input.researchId, ctx)
    if (isTerminal(latest.status)) return latest

    const coverage: ResearchCoverage = {
      queriesPlanned: 1,
      searchCalls: result.coverage.searchCalls,
      pagesDiscovered: result.coverage.pagesDiscovered,
      archivedSnapshots: result.coverage.archivedSnapshots,
      skippedWithoutSnapshot: result.coverage.skippedWithoutSnapshot,
      excludedCount: result.coverage.excludedCount,
      failedCount: result.coverage.failedCount,
      truncated: result.coverage.truncated,
    }
    const sources: ResearchSourceRef[] = []
    for (const source of result.sources) {
      const url = source.origin.url
      if (url !== undefined) sources.push({ sourceId: source.sourceId, url })
    }
    const bounded = coverage.truncated || coverage.skippedWithoutSnapshot > 0
      || coverage.failedCount > 0 || coverage.excludedCount > 0
    if (coverage.pagesDiscovered === 0) {
      return this.#finalize(scope, latest, {
        status: 'completed', stage: 'completed', stopReason: 'no_results', coverage, sources,
      }, ctx)
    }
    return this.#finalize(scope, latest, {
      status: 'awaiting_confirmation',
      stage: 'awaiting_source_review',
      stopReason: bounded ? 'partial_results' : 'completed',
      coverage,
      sources,
    }, ctx)
  }

  /**
   * Read a run back with its usage projection and the job's current stage. The usage is the shared
   * background ledger of the job; it is absent (not a fabricated zero) until the worker opens it.
   */
  async get(researchId: Uuid, ctx: ToolContext): Promise<ResearchRunView> {
    const scope = scopeOf(ctx)
    const execution = await this.#requireExecution(scope, researchId, ctx)
    const usage = await this.#budget.remaining(execution.jobId, ctx).catch(() => undefined)
    let jobStage: PipelineStage | undefined
    try {
      const job = await this.#jobs.getJob(execution.jobId, ctx)
      jobStage = job.stage
    } catch {
      jobStage = undefined
    }
    return {
      execution,
      ...(usage === undefined ? {} : { usage }),
      ...(jobStage === undefined ? {} : { jobStage }),
    }
  }

  /**
   * Cancel a queued/running run. The terminal write fences the run, so a provider call that lands
   * afterwards cannot overwrite the cancellation or admit a late page.
   */
  async cancel(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecution> {
    const scope = scopeOf(ctx)
    const execution = await this.#requireExecution(scope, researchId, ctx)
    if (isTerminal(execution.status)) return execution
    return this.#executions.putExecution(scope, { ...execution, status: 'cancelled', stopReason: 'cancelled' }, ctx)
  }

  /**
   * Resume a non-terminal run (design §3/§10). It reuses the run's exact pinned binding and its one
   * shared budget ledger: the durable job is re-armed by its deterministic key (a no-op when the job
   * is already queued/running), never replaced by a second job or a fresh budget. A terminal run —
   * cancelled, completed or failed — can never be revived here; the user must append a
   * `continuations` run instead. The engine/runtime and the model/tool bindings are unchanged, so a
   * resume never switches engine mid-run.
   */
  async resume(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecution> {
    assertResearcher(ctx)
    const scope = scopeOf(ctx)
    const execution = await this.#requireExecution(scope, researchId, ctx)
    if (isTerminal(execution.status)) {
      throw new ResearchError('VERSION_CONFLICT', `research run ${researchId} is ${execution.status} and cannot be resumed; append a continuation instead`)
    }
    // Re-arm the same logical job from the frozen `datasetRef`, so the worker resumes the exact
    // authorized request on the same job id / ledger. `createJob` is idempotent on the key.
    const job = await this.#jobs.getJob(execution.jobId, ctx)
    const ref = decodeResearchJobRequest(job.datasetRef)
    await this.#jobs.createJob({
      jobId: execution.jobId,
      kind: 'research',
      sourceRef: 'workbench.research',
      datasetRef: encodeResearchJobRequest(ref),
      pipelineVersion: RESEARCH_PIPELINE_VERSION,
      idempotencyKey: `research-run:${ref.request.idempotencyKey}`,
    }, ctx)
    return execution
  }

  /**
   * Append research grounded in an already-ended run (design §3/§10). It creates a **new** execution
   * with a new authorization, budget and id, linked to the previous run through
   * `continuedFromResearchId`; the previous run stays frozen and is never revived or retried. An
   * active run cannot be continued (its own result is not yet a product to build on).
   */
  async continuations(previousResearchId: Uuid, request: ResearchRequest, ctx: ToolContext): Promise<ResearchExecution> {
    assertResearcher(ctx)
    assertResearchRequestShape(request)
    assertModelingBriefShape(request.brief)
    const scope = scopeOf(ctx)
    const previous = await this.#requireExecution(scope, previousResearchId, ctx)
    if (!isTerminal(previous.status)) {
      throw new ResearchError('VERSION_CONFLICT', `research run ${previousResearchId} is ${previous.status} and is still active; a continuation requires an ended run`)
    }
    if (previous.workspaceId !== request.workspaceId) {
      throw new ResearchError('SCOPE_MISMATCH', 'a continuation must target the same workspace as the run it continues')
    }
    const continuedRequest: ResearchRequest = {
      ...request,
      idempotencyKey: `continuation:${previousResearchId}:${request.idempotencyKey}`,
    }
    return this.start(continuedRequest, ctx, { continuedFromResearchId: previousResearchId })
  }

  /** Between-page admission gate: once cancelled, no further page is registered. */
  async #stillAdmitting(scope: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<boolean> {
    const latest = await this.#executions.getExecution(scope, researchId, ctx)
    return latest !== undefined && !isTerminal(latest.status)
  }

  async #settle(ledgerId: Uuid, reservationId: Uuid, status: 'completed' | 'failed', durationMs: number, ctx: ToolContext): Promise<void> {
    await this.#budget.settle({
      ledgerId,
      reservationId,
      status,
      usage: { durationMs: Math.max(0, durationMs), calls: status === 'completed' ? 1 : 0 },
      evidenceRefs: [],
    }, ctx).catch(() => undefined)
  }

  async #finalize(
    scope: ScopeRef,
    execution: ResearchExecution,
    update: {
      readonly status: ResearchExecution['status']
      readonly stage: ResearchExecution['stage']
      readonly stopReason: ResearchStopReason
      readonly coverage?: ResearchCoverage
      readonly sources?: readonly ResearchSourceRef[]
    },
    ctx: ToolContext,
  ): Promise<ResearchExecution> {
    const coverage = update.coverage ?? execution.coverage
    return this.#executions.putExecution(scope, {
      ...execution,
      status: update.status,
      stage: update.stage,
      stopReason: update.stopReason,
      coverage,
      sourceCount: update.sources === undefined ? execution.sourceCount : update.sources.length,
      ...(update.sources === undefined ? {} : { sources: update.sources }),
    }, ctx)
  }

  async #requireExecution(scope: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecution> {
    const execution = await this.#executions.getExecution(scope, researchId, ctx)
    if (execution === undefined) throw new ResearchError('NOT_FOUND', `research run ${researchId} is not visible in this scope`)
    return execution
  }
}
