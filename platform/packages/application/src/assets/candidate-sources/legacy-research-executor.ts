import { ResearchError } from '@ontology/contracts'
import type {
  BudgetLedgerPort,
  ResearchCoverage,
  ResearchExecution,
  ResearchExecutionAny,
  ResearchExecutionStore,
  ResearchRequest,
  ResearchSourceRef,
  ResearchStopReason,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { ExecutionModelBindingService } from '../../model-settings/execution-model-binding-service'
import { sha256DigestOf } from '../../extraction/canonical'
import { WebResearchError, WebResearchService } from './web-research-service'
import type { CandidateSourceIngestionService } from './ingestion-service'
import type { ResearchSearchResolver } from './research-search-resolver'
import { assertResearcher, isTerminal, scopeOf } from './research-scope'

/**
 * Where a run's public search comes from. A `catalogue` run resolves it from the pinned tool
 * connection at its workspace scope (S03); an `env` run is a historical job that keeps the legacy
 * deployment-environment provider. The distinction is explicit so a legacy job is never re-pointed.
 */
export type ResearchProviderSource = 'env' | 'catalogue'

/** The decoded job: the run to execute, the exact authorized request and its provider source. */
export interface ExecuteResearchInput {
  readonly researchId: Uuid
  readonly request: ResearchRequest
  /** Defaults to `env` so a caller that predates S03 keeps the legacy environment path. */
  readonly providerSource?: ResearchProviderSource
}

export interface LegacyResearchExecutorDependencies {
  readonly executions: ResearchExecutionStore
  /**
   * The legacy environment-search path. Present on a deployment that configured
   * `CORE_WEB_SEARCH_*`; used only for historical `@1` (env) jobs, never for a new catalogue run.
   */
  readonly research?: WebResearchService
  /**
   * The catalogue-search path (S03). When present the executor resolves the run's public search from
   * the pinned tool-connection binding at its workspace scope and runs the same fixed chain.
   */
  readonly catalogue?: {
    readonly search: ResearchSearchResolver
    readonly ingestion: CandidateSourceIngestionService
  }
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

/**
 * The fixed legacy research execution chain (design §2.3/§2.4, A-R02), split out of the workflow
 * facade so the facade only starts/reads/cancels/resumes/appends and the durable job handler owns
 * the one execution path.
 *
 * It runs — preflight/authorization → durable job + shared budget ledger → bounded `web_search`
 * (which archives snapshots internally) → `CandidateSource` registration → coverage + stop reason.
 * It never publishes: every source it registers is `agent_researched`/`proposed` and needs the
 * existing review/admission gate. It reuses the durable job's own background budget ledger, so a
 * retry or a crash-restart neither resets the budget nor admits a late page; a cancelled run is
 * frozen and cannot be resurrected by a later write.
 */
export class LegacyResearchExecutor {
  readonly #executions: ResearchExecutionStore
  readonly #research: WebResearchService | undefined
  readonly #catalogue: LegacyResearchExecutorDependencies['catalogue']
  readonly #budget: BudgetLedgerPort
  readonly #modelBinding: ExecutionModelBindingService | undefined
  readonly #now: () => string

  constructor(dependencies: LegacyResearchExecutorDependencies) {
    if (dependencies.research === undefined && dependencies.catalogue === undefined) {
      throw new ResearchError('STORE_FAILED', 'a research executor needs a catalogue or an environment search path')
    }
    this.#executions = dependencies.executions
    this.#research = dependencies.research
    this.#catalogue = dependencies.catalogue
    this.#budget = dependencies.budget
    this.#modelBinding = dependencies.modelBinding
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /**
   * Execute one queued run inside the durable worker. It is idempotent and restart-safe: a run
   * that already reached a terminal status is returned untouched, and the budget is drawn from the
   * job's shared background ledger so a reclaimed attempt never resets it.
   *
   * It serves only legacy `@1` executions; an agentic `@2` projection is run by the agent runtime,
   * not by this fixed chain, so a mismatch is refused instead of being coerced.
   */
  async execute(input: ExecuteResearchInput, ctx: ToolContext, ledgerId: Uuid, signal: AbortSignal): Promise<ResearchExecution> {
    assertResearcher(ctx)
    const scope = scopeOf(ctx)
    const execution = this.#requireLegacy(await this.#requireExecution(scope, input.researchId, ctx))
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
    // reclaimed attempt draws from the same reservation instead of resetting the budget. The search
    // is one `searches` unit charged on the one run ledger at the run's original deadline.
    const reserve = await this.#budget.reserve({
      ledgerId,
      idempotencyKey: `research:${input.researchId}:search`,
      toolCalls: 1,
      searches: 1,
      requestedDeadline: input.request.limits.deadline,
    }, ctx)
    if (!reserve.granted) {
      return this.#finalize(scope, execution, { status: 'failed', stage: 'searching', stopReason: 'budget_exhausted' }, ctx)
    }
    const reservation = reserve.reservation
    if (reservation === undefined) throw new ResearchError('STORE_FAILED', 'a granted research reservation carried no reservation record')
    const reservationId = reservation.reservationId

    // Resolve the run's public search before any search call: a catalogue run reads its pinned
    // binding, a historical env job keeps the deployment provider. A blocked binding fails the run;
    // it never falls back to another connection or to the environment.
    let research: WebResearchService
    try {
      research = await this.#researchFor(input, execution, ctx)
    } catch (error) {
      await this.#settle(ledgerId, reservationId, 'failed', 0, ctx)
      await this.#finalize(scope, execution, { status: 'failed', stage: 'searching', stopReason: 'provider_failed' }, ctx)
      throw error
    }

    const startedAt = Date.now()
    // One ledger for the whole run: each archived page reserves exactly one `sources` unit, keyed by
    // the page URL so a re-page is idempotent and the source ceiling cannot be bypassed.
    const sourceReservations = new Map<string, Uuid>()
    let result
    try {
      result = await research.research({
        brief: input.request.brief,
        retrievedAt: this.#now(),
        deadline: input.request.limits.deadline,
        signal,
        idempotencyKey: `research:${input.researchId}`,
        admit: () => this.#stillAdmitting(scope, input.researchId, ctx),
        reserveSource: async (url) => {
          const outcome = await this.#budget.reserve({
            ledgerId,
            idempotencyKey: `research:${input.researchId}:source:${sha256DigestOf(url)}`,
            toolCalls: 0,
            sources: 1,
            requestedDeadline: input.request.limits.deadline,
          }, ctx)
          if (!outcome.granted || outcome.reservation === undefined) return false
          sourceReservations.set(url, outcome.reservation.reservationId)
          return true
        },
        recordSource: async (url, contentRef) => {
          const reservationId = sourceReservations.get(url)
          if (reservationId === undefined) return
          await this.#budget.settle({
            ledgerId,
            reservationId,
            status: 'completed',
            usage: { durationMs: 0 },
            measured: { sources: 1 },
            evidenceRefs: [contentRef],
          }, ctx).catch(() => undefined)
        },
      }, ctx)
    } catch (error) {
      await this.#settle(ledgerId, reservationId, 'failed', Date.now() - startedAt, ctx)
      const latest = this.#requireLegacy(await this.#requireExecution(scope, input.researchId, ctx))
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
    await this.#settle(ledgerId, reservationId, 'completed', Date.now() - startedAt, ctx, { searches: 1 })

    // A cancel that landed while the provider was running fences the run: the terminal write is
    // refused by the store, so the late result is never admitted.
    const latest = this.#requireLegacy(await this.#requireExecution(scope, input.researchId, ctx))
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
   * Build the `WebResearchService` for one run from the correct provider source.
   *
   * A `catalogue` run resolves its pinned `web_search` binding; a blocked binding is a stable
   * `ResearchError('CAPABILITY_NOT_CONFIGURED')`, so the run fails closed instead of reaching the
   * legacy environment provider. An `env` run is a historical job and keeps the deployment provider.
   */
  async #researchFor(input: ExecuteResearchInput, execution: ResearchExecution, ctx: ToolContext): Promise<WebResearchService> {
    const source: ResearchProviderSource = input.providerSource ?? 'env'
    if (source === 'catalogue') {
      const catalogue = this.#catalogue
      if (catalogue === undefined) {
        throw new ResearchError('CAPABILITY_NOT_CONFIGURED', 'this deployment has no catalogue search path to run a catalogue research job')
      }
      const resolution = await catalogue.search.resolveForResearch(
        { researchId: input.researchId, workspaceId: execution.workspaceId },
        ctx,
      )
      if (resolution.state !== 'available') {
        throw new ResearchError('CAPABILITY_NOT_CONFIGURED', `the pinned public search is unavailable: ${resolution.message}`)
      }
      return new WebResearchService({ webSearch: resolution.provider, ingestion: catalogue.ingestion })
    }
    const legacy = this.#research
    if (legacy === undefined) {
      throw new ResearchError('CAPABILITY_NOT_CONFIGURED', 'this deployment has no environment search path for a legacy research job')
    }
    return legacy
  }

  /** Between-page admission gate: once cancelled, no further page is registered. */
  async #stillAdmitting(scope: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<boolean> {
    const latest = await this.#executions.getExecution(scope, researchId, ctx)
    return latest !== undefined && !isTerminal(latest.status)
  }

  async #settle(ledgerId: Uuid, reservationId: Uuid, status: 'completed' | 'failed', durationMs: number, ctx: ToolContext, measured?: { readonly searches?: number }): Promise<void> {
    await this.#budget.settle({
      ledgerId,
      reservationId,
      status,
      usage: { durationMs: Math.max(0, durationMs), calls: status === 'completed' ? 1 : 0 },
      ...(measured === undefined ? {} : { measured }),
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
    const written = await this.#executions.putExecution(scope, {
      ...execution,
      status: update.status,
      stage: update.stage,
      stopReason: update.stopReason,
      coverage,
      sourceCount: update.sources === undefined ? execution.sourceCount : update.sources.length,
      ...(update.sources === undefined ? {} : { sources: update.sources }),
    }, ctx)
    return this.#requireLegacy(written)
  }

  async #requireExecution(scope: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny> {
    const execution = await this.#executions.getExecution(scope, researchId, ctx)
    if (execution === undefined) throw new ResearchError('NOT_FOUND', `research run ${researchId} is not visible in this scope`)
    return execution
  }

  /** The fixed chain only serves legacy `@1` executions; an agent `@2` run is never coerced into it. */
  #requireLegacy(execution: ResearchExecutionAny): ResearchExecution {
    if (execution.schemaVersion !== 'research-execution@1') {
      throw new ResearchError('VERSION_CONFLICT', 'the legacy research executor only serves legacy @1 executions')
    }
    return execution
  }
}
