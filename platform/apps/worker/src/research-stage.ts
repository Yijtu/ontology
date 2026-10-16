import type { JobStageContext, JobStageHandler, JobStageOutcome } from '@ontology/application'
import {
  JobStageFailure,
  decodeResearchJobRequest,
  isAgentResearchJobRequest,
  isCatalogueResearchJobRequest,
  nextPipelineStage,
} from '@ontology/application'
import type { LegacyResearchExecutor, ResearchProviderSource } from '@ontology/application'
import type { WorkflowDispatchPort } from '@ontology/contracts'

/**
 * The bounded research job handler (design §2.3, A-R02; S03; S09).
 *
 * The durable job carries the exact authorized `ResearchRequest` in its opaque `datasetRef`. The
 * handler decodes it and drives the wired `LegacyResearchExecutor` exactly once: the executor is
 * idempotent, so replaying a reclaimed attempt or walking the remaining runnable stages only
 * re-reads the frozen execution. The handler holds no provider and no credentials — it never makes
 * a network call itself.
 *
 * The job version selects the provider source: a catalogue `1.1.0` job resolves its public search
 * from the pinned tool-connection binding (S03), while a legacy `1.0.0` job keeps the deployment
 * environment path.
 *
 * An agentic `2.0.0` job is **not** run by this handler against a fixed chain. It is a pure
 * scheduling handoff (design §8: Job 只负责调度): the run was already accepted by
 * `WorkspaceResearchRunService`(S05) with its one manifest/ledger, so the handler only
 * **idempotently enqueues** that run into the durable dispatch queue and finishes at the
 * `dispatched` terminal stage. It never calls `startRun()`, never waits for the Pi runtime, never
 * participates in model retries and never opens a background ledger (the `JobWorker` skips it for
 * this version, so the run's manifest ledger is the single ledger execution consumes).
 * `WorkflowDispatchWorker` remains the only controller driver.
 */
export interface ResearchStageDependencies {
  /**
   * The fixed legacy/catalogue execution chain. Required only to serve a `1.x` request-carrying job;
   * a host that schedules only agentic `2.0.0` handoffs may omit it.
   */
  readonly executor?: LegacyResearchExecutor
  /**
   * The durable dispatch queue. Required to hand an accepted agentic run to the controller; a host
   * without it refuses an agentic job with a stable capability reason instead of silently dropping
   * the handoff.
   */
  readonly dispatch?: WorkflowDispatchPort
}

export class ResearchStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #executor: LegacyResearchExecutor | undefined
  readonly #dispatch: WorkflowDispatchPort | undefined

  constructor(dependencies: ResearchStageDependencies) {
    this.#executor = dependencies.executor
    this.#dispatch = dependencies.dispatch
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const job = context.job
    if (job.kind !== 'research') {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the research handler only serves research jobs', false)
    }
    const ref = decodeResearchJobRequest(job.datasetRef)
    if (isAgentResearchJobRequest(ref)) {
      // The scheduling handoff: enqueue the already-accepted run for the controller. `enqueue` is
      // idempotent on `(runId, logicalActionId)`, so a reclaimed attempt (a crash after the enqueue
      // but before the `dispatched` checkpoint) re-arms exactly the same durable dispatch and never
      // a second execution owner.
      const dispatch = this.#dispatch
      if (dispatch === undefined) {
        throw new JobStageFailure(
          'CAPABILITY_NOT_CONFIGURED',
          'no durable dispatch queue is mounted to hand off an agentic research run',
          false,
        )
      }
      try {
        await dispatch.enqueue({ runId: ref.runId, logicalActionId: 'initial-drive' }, context.ctx)
      } catch (error) {
        throw new JobStageFailure(
          'INTERNAL_ERROR',
          'the agentic research run could not be handed off to the durable dispatch queue',
          true,
          { cause: error },
        )
      }
      return { nextStage: 'dispatched', counts: { total: 1, processed: 1, failed: 0, skipped: 0 } }
    }
    const providerSource: ResearchProviderSource = isCatalogueResearchJobRequest(ref) ? 'catalogue' : 'env'
    const executor = this.#executor
    if (executor === undefined) {
      throw new JobStageFailure(
        'CAPABILITY_NOT_CONFIGURED',
        'no fixed research chain is mounted for a request-carrying research job',
        false,
      )
    }
    const execution = await executor.execute(
      { researchId: ref.researchId, request: ref.request, providerSource },
      context.ctx,
      context.ledgerId,
      context.signal,
    )
    const next = nextPipelineStage(job.stage)
    return {
      nextStage: next ?? job.stage,
      counts: {
        total: execution.coverage.pagesDiscovered,
        processed: execution.coverage.archivedSnapshots,
        failed: execution.coverage.failedCount,
        skipped: execution.coverage.skippedWithoutSnapshot,
      },
    }
  }
}
