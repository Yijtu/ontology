import {
  ResearchError,
  isToolContext,
} from '@ontology/contracts'
import type {
  IndustryWorkspaceStore,
  ResearchExecutionAny,
  ResearchExecutionStore,
  ResearchRequest,
  ResearchRunAdmissionRequest,
  ResearchRunAdmissionStore,
  ScopeRef,
  ToolContext,
  Uuid,
  WorkflowDispatchPort,
} from '@ontology/contracts'
import type { WorkspaceResearchRunService } from '../../research/workspace-research-run-service'
import type { ResearchRunEntry } from './research-entry'
import type { ResearchContinuationLinkage, ResearchRunView } from './research-workflow-service'
import { researchIdForRequest } from './research-workflow-service'
import { isTerminal } from './research-scope'

/**
 * The agentic research run entry (design §4/§8/§10, S10).
 *
 * It implements the same `ResearchRunEntry` shape as the legacy fixed-chain facade but routes
 * **newly-accepted** requests to the V2 workspace-research run (`WorkspaceResearchRunService`): the
 * request is admitted (brief/frozen draft/authorization receipt/model snapshot/one ledger/manifest),
 * an agentic `2.0.0` scheduler job is created and the run is handed to the durable dispatch queue
 * that drives the real `WorkflowController` + Pi runtime.
 *
 * The switch is deliberately replay-safe and only affects **new** requests:
 *
 *  - an idempotency key that already has a durable admission re-arms that run's dispatch and returns
 *    the stored projection — it never starts a second run and never changes the engine;
 *  - a request that was already accepted by the legacy engine (an `@1` execution exists for its
 *    deterministic run id) is replayed through the legacy facade, so a restart that flips the switch
 *    can never migrate an in-flight/old run onto a different engine;
 *  - only a genuinely new request is admitted to V2, and only after the model and public-search
 *    capabilities are confirmed available (a missing model/search is a clear block, never a silent
 *    half-run).
 */
export interface AgentResearchRunEntryDependencies {
  /** The legacy fixed-chain facade, used for `@1` replays and to preserve read shape. */
  readonly legacy: ResearchRunEntry
  /** The V2 admission/lifecycle service. */
  readonly agent: WorkspaceResearchRunService
  readonly workspaces: Pick<IndustryWorkspaceStore, 'getWorkspace'>
  readonly executions: ResearchExecutionStore
  readonly admissions: ResearchRunAdmissionStore
  readonly dispatch: WorkflowDispatchPort
  /** Cancels the controller run + its durable dispatch (the worker's `cancelRun` hook). */
  readonly cancelRun?: (runId: Uuid, ctx: ToolContext) => Promise<void>
  /**
   * Confirms the model **and** public-search capabilities for the target workspace, throwing a
   * stable `CAPABILITY_NOT_CONFIGURED` when either is missing/disabled/revoked. Keep this the first
   * gate before admitting a new agentic run so a half-configured host never starts one.
   */
  readonly assertCapabilities: (workspaceId: Uuid, ctx: ToolContext) => Promise<void>
  readonly now?: () => string
}

export class AgentResearchRunEntry implements ResearchRunEntry {
  readonly #deps: AgentResearchRunEntryDependencies
  readonly #now: () => string

  constructor(dependencies: AgentResearchRunEntryDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  get executionAvailable(): boolean {
    // The agent entry is mounted only when the deployment has a runnable controller; the per-run
    // capability block is decided at accept (`assertCapabilities`), so the entry itself is available.
    return true
  }

  async start(request: ResearchRequest, ctx: ToolContext, linkage?: ResearchContinuationLinkage): Promise<ResearchExecutionAny> {
    const scope = scopeOf(ctx)
    // (1) A replay of an already-admitted agentic run: re-arm the same dispatch, never a second run.
    const admitted = await this.#deps.admissions.findByIdempotencyKey(scope, request.idempotencyKey, ctx)
    if (admitted !== undefined) {
      await this.#deps.dispatch.enqueue({ runId: admitted.runId, logicalActionId: 'initial-drive' }, ctx)
      return this.#requireExecution(scope, admitted.researchId, ctx)
    }
    // (2) A replay of a request already accepted by the legacy engine keeps the legacy engine.
    const legacyId = researchIdForRequest(request)
    const legacy = await this.#deps.executions.getExecution(scope, legacyId, ctx)
    if (legacy !== undefined) return this.#deps.legacy.start(request, ctx, linkage)
    // (3) A genuinely new request: confirm the capabilities, then admit it to V2.
    await this.#deps.assertCapabilities(request.workspaceId, ctx)
    const result = await this.#deps.agent.accept(await this.#admissionRequestFor(request, ctx), ctx)
    return this.#requireExecution(scope, result.researchId, ctx)
  }

  async get(researchId: Uuid, ctx: ToolContext): Promise<ResearchRunView> {
    const scope = scopeOf(ctx)
    const execution = await this.#deps.executions.getExecution(scope, researchId, ctx)
    // A legacy `@1` record keeps the legacy read shape (its own usage/job projection); a `@2` run
    // projection is returned directly. An unknown id is delegated so the legacy NOT_FOUND stands.
    if (execution !== undefined && execution.schemaVersion === 'research-execution@2') return { execution }
    return this.#deps.legacy.get(researchId, ctx)
  }

  async cancel(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const scope = scopeOf(ctx)
    const execution = await this.#deps.executions.getExecution(scope, researchId, ctx)
    if (execution === undefined || execution.schemaVersion !== 'research-execution@2') {
      return this.#deps.legacy.cancel(researchId, ctx)
    }
    if (isTerminal(execution.status)) return execution
    // Persist the cancellation fence first (cancel the durable dispatch + abort in-flight work),
    // then record the terminal projection; a late runtime result can never revive the run.
    if (this.#deps.cancelRun !== undefined) await this.#deps.cancelRun(execution.runId, ctx)
    return this.#deps.executions.putExecution(scope, {
      ...execution,
      status: 'cancelled',
      stopReason: 'cancelled',
      recordedAt: this.#now(),
    }, ctx)
  }

  async resume(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const scope = scopeOf(ctx)
    const execution = await this.#deps.executions.getExecution(scope, researchId, ctx)
    if (execution === undefined || execution.schemaVersion !== 'research-execution@2') {
      return this.#deps.legacy.resume(researchId, ctx)
    }
    if (isTerminal(execution.status)) {
      throw new ResearchError('VERSION_CONFLICT', `research run ${researchId} is ${execution.status} and cannot be resumed; append a continuation instead`)
    }
    // A delivery-ready run is waiting on a human source/admission review: it is not re-driven by a
    // resume (design §8, S09) — the user appends a continuation instead.
    if (execution.status === 'awaiting_confirmation') {
      throw new ResearchError('VERSION_CONFLICT', `research run ${researchId} has delivered its candidates and awaits review; append a continuation instead`)
    }
    await this.#deps.dispatch.enqueue({ runId: execution.runId, logicalActionId: 'initial-drive' }, ctx)
    return execution
  }

  async continuations(previousResearchId: Uuid, request: ResearchRequest, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const scope = scopeOf(ctx)
    const previous = await this.#deps.executions.getExecution(scope, previousResearchId, ctx)
    // A continuation of a legacy run is a new legacy run; a continuation of an agentic run is a new
    // agentic run. Either way it gets its own id, authorization and budget (design §3/§10).
    if (previous === undefined || previous.schemaVersion !== 'research-execution@2') {
      return this.#deps.legacy.continuations(previousResearchId, request, ctx)
    }
    if (!isTerminal(previous.status) && previous.status !== 'awaiting_confirmation') {
      throw new ResearchError('VERSION_CONFLICT', `research run ${previousResearchId} is ${previous.status} and is still active; a continuation requires an ended run`)
    }
    if (previous.workspaceId !== request.workspaceId) {
      throw new ResearchError('SCOPE_MISMATCH', 'a continuation must target the same workspace as the run it continues')
    }
    return this.start({ ...request, idempotencyKey: `continuation:${previousResearchId}:${request.idempotencyKey}` }, ctx, { continuedFromResearchId: previousResearchId })
  }

  async #admissionRequestFor(request: ResearchRequest, ctx: ToolContext): Promise<ResearchRunAdmissionRequest> {
    const scope = scopeOf(ctx)
    const workspace = await this.#deps.workspaces.getWorkspace(scope, request.workspaceId, ctx)
    if (workspace === undefined) {
      throw new ResearchError('NOT_FOUND', `workspace ${request.workspaceId} is not visible in this scope`)
    }
    return {
      schemaVersion: 'research-run-admission-request@1',
      workspaceId: request.workspaceId,
      // The run models the workspace's current draft revision (the only revision a new run can fix);
      // the config/run admission freezes it, so later edits never retarget the run.
      draftRevision: workspace.headRevision,
      brief: request.brief,
      context: { timeZone: 'UTC' },
      preferences: { route: 'pi', allowWeb: true },
      allowedDomains: [...request.allowedDomains],
      limits: request.limits,
      idempotencyKey: request.idempotencyKey,
    }
  }

  async #requireExecution(scope: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const execution = await this.#deps.executions.getExecution(scope, researchId, ctx)
    if (execution === undefined) {
      throw new ResearchError('STORE_FAILED', `the admitted research run ${researchId} has no readable projection`)
    }
    return execution
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ResearchError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
