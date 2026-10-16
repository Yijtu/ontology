import { ResearchError, assertModelingBriefShape, assertResearchRequestShape } from '@ontology/contracts'
import type {
  BudgetLedgerPort,
  BudgetLedgerSnapshot,
  PipelineStage,
  ResearchExecutionAny,
  ResearchExecutionStore,
  ResearchRequest,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import type { JobService } from '../../jobs/service'
import type { ExecutionModelBindingService } from '../../model-settings/execution-model-binding-service'
import {
  RESEARCH_JOB_REQUEST_KIND,
  RESEARCH_JOB_VERSION_LEGACY,
  decodeResearchJobRequest,
  encodeResearchJobRequest,
} from './research-job-ref'
import { assertResearcher, canPinModel, isTerminal, scopeOf } from './research-scope'

const RESEARCH_PIPELINE_VERSION = RESEARCH_JOB_VERSION_LEGACY

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

export interface ResearchWorkflowDependencies {
  readonly jobs: JobService
  readonly executions: ResearchExecutionStore
  /** The shared budget ledger; the durable job's own background ledger is reused, never reset. */
  readonly budget: BudgetLedgerPort
  /**
   * The per-execution model binding (design §5.3). When present the run pins the research model at
   * authorization and refuses to run on a revoked/broken binding instead of silently switching
   * vendor. When absent the host mounts no model catalogue and the fence is a no-op.
   */
  readonly modelBinding?: ExecutionModelBindingService
  /**
   * Whether a research execution engine is wired for this deployment (design §9/§10). The facade
   * is always mounted so reads/cancel/resume always work; only starting a new run (and appending a
   * continuation) needs an engine, and its absence is reported as a stable capability reason. It
   * defaults to `true` so a host that wires the executor keeps the historical behavior.
   */
  readonly executionAvailable?: boolean
  readonly now?: () => string
}

export interface ResearchRunView {
  readonly execution: ResearchExecutionAny
  /** The run's background ledger projection; absent until the worker opens it. */
  readonly usage?: BudgetLedgerSnapshot
  readonly jobStage?: PipelineStage
}

/**
 * Optional linkage for a run that continues an earlier one (design §3/§10). It is informational:
 * the continuation still gets its own id, authorization, budget and ledger.
 */
export interface ResearchContinuationLinkage {
  readonly continuedFromResearchId: Uuid
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
 * The bounded research orchestration facade (design §2.3/§2.4, §8, A-R02).
 *
 * It owns the durable lifecycle only — start, read, cancel, resume and append — over the research
 * execution store and the shared budget ledger. The fixed execution chain lives in
 * `LegacyResearchExecutor`, which the durable `research` job handler drives; the facade never
 * imports a provider, so a deployment without a search provider still reads and lists its history.
 *
 * It never publishes: a run only proposes `agent_researched`/`proposed` sources that need the
 * existing review/admission gate. A retry or a crash-restart neither resets the budget nor admits a
 * late page; a cancelled run is frozen and cannot be resurrected by a later write.
 */
export class ResearchWorkflowService {
  readonly #jobs: JobService
  readonly #executions: ResearchExecutionStore
  readonly #budget: BudgetLedgerPort
  readonly #modelBinding: ExecutionModelBindingService | undefined
  readonly #executionAvailable: boolean
  readonly #now: () => string

  constructor(dependencies: ResearchWorkflowDependencies) {
    this.#jobs = dependencies.jobs
    this.#executions = dependencies.executions
    this.#budget = dependencies.budget
    this.#modelBinding = dependencies.modelBinding
    this.#executionAvailable = dependencies.executionAvailable ?? true
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** `false` when no research engine is wired: reads still work, but a new run cannot start. */
  get executionAvailable(): boolean {
    return this.#executionAvailable
  }

  /**
   * Preflight and authorize one run: pin the research model (when the host mounts one), create the
   * durable job and the budget-backed execution record, and return the queued run. Idempotent on
   * the request key: a replay reuses the same logical job and returns the same execution.
   */
  async start(request: ResearchRequest, ctx: ToolContext, linkage?: ResearchContinuationLinkage): Promise<ResearchExecutionAny> {
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
      datasetRef: encodeResearchJobRequest({ kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_JOB_VERSION_LEGACY, researchId, request }),
      pipelineVersion: RESEARCH_PIPELINE_VERSION,
      idempotencyKey: `research-run:${request.idempotencyKey}`,
    }, ctx)

    const existing = await this.#executions.getExecution(scope, researchId, ctx)
    if (existing !== undefined) return existing

    const execution: ResearchExecutionAny = {
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
   * Read a run back with its usage projection and the job's current stage. The usage is the shared
   * background ledger of the job; it is absent (not a fabricated zero) until the worker opens it.
   * The read serves both projection versions and never requires a configured search provider.
   */
  async get(researchId: Uuid, ctx: ToolContext): Promise<ResearchRunView> {
    const scope = scopeOf(ctx)
    const execution = await this.#requireExecution(scope, researchId, ctx)
    const jobId = execution.jobId
    const usage = jobId === undefined
      ? undefined
      : await this.#budget.remaining(jobId, ctx).catch(() => undefined)
    let jobStage: PipelineStage | undefined
    if (jobId !== undefined) {
      try {
        const job = await this.#jobs.getJob(jobId, ctx)
        jobStage = job.stage
      } catch {
        jobStage = undefined
      }
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
  async cancel(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
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
  async resume(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
    assertResearcher(ctx)
    const scope = scopeOf(ctx)
    const execution = await this.#requireExecution(scope, researchId, ctx)
    if (isTerminal(execution.status)) {
      throw new ResearchError('VERSION_CONFLICT', `research run ${researchId} is ${execution.status} and cannot be resumed; append a continuation instead`)
    }
    // Re-arm the same logical job from the frozen `datasetRef`, so the worker resumes the exact
    // authorized payload on the same job id / ledger. `createJob` is idempotent on the key.
    const jobId = execution.jobId
    if (jobId === undefined) throw new ResearchError('STORE_FAILED', `research run ${researchId} has no durable job to resume`)
    const job = await this.#jobs.getJob(jobId, ctx)
    const ref = decodeResearchJobRequest(job.datasetRef)
    const idempotencyKey = ref.version === RESEARCH_JOB_VERSION_LEGACY
      ? `research-run:${ref.request.idempotencyKey}`
      : `research-run:${ref.runId}`
    await this.#jobs.createJob({
      jobId,
      kind: 'research',
      sourceRef: 'workbench.research',
      datasetRef: encodeResearchJobRequest(ref),
      pipelineVersion: RESEARCH_PIPELINE_VERSION,
      idempotencyKey,
    }, ctx)
    return execution
  }

  /**
   * Append research grounded in an already-ended run (design §3/§10). It creates a **new** execution
   * with a new authorization, budget and id, linked to the previous run through
   * `continuedFromResearchId`; the previous run stays frozen and is never revived or retried. An
   * active run cannot be continued (its own result is not yet a product to build on).
   */
  async continuations(previousResearchId: Uuid, request: ResearchRequest, ctx: ToolContext): Promise<ResearchExecutionAny> {
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

  async #requireExecution(scope: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const execution = await this.#executions.getExecution(scope, researchId, ctx)
    if (execution === undefined) throw new ResearchError('NOT_FOUND', `research run ${researchId} is not visible in this scope`)
    return execution
  }
}
