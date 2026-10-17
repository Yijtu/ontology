import type { JobStageContext, JobStageHandler, JobStageOutcome } from '@ontology/application'
import {
  JobStageFailure,
  decodeResearchJobRequest,
  isAgentResearchJobRequest,
} from '@ontology/application'
import type { WorkflowDispatchPort } from '@ontology/contracts'

/**
 * The bounded research job handler (design §2.3, A-R02; S09; S11).
 *
 * The job exists only to **schedule** research (design §8: Job 只负责调度). The one engine is the
 * V2 agentic run: `WorkspaceResearchRunService`(S05) already accepted the run with its one
 * manifest/ledger, so a `2.0.0` job only **idempotently enqueues** that run into the durable
 * dispatch queue and finishes at the `dispatched` terminal stage. It never calls `startRun()`,
 * never waits for the Pi runtime, never participates in model retries and never opens a background
 * ledger (the `JobWorker` skips the ledger for this version, so the run's manifest ledger is the
 * single ledger execution consumes). `WorkflowDispatchWorker` remains the only controller driver.
 *
 * S11 retires the legacy fixed chain. A historical request-carrying job (`1.0.0` environment or
 * `1.1.0` catalogue) is **not executed here** and is **never reassigned** to the agentic runtime:
 * such a job can only be completed under its original configuration or explicitly cancelled with
 * the original engine before the upgrade. The drain check refuses to start this build while any
 * such job is in flight; if one somehow reaches this handler it fails closed with a stable reason
 * instead of silently re-homing it or dropping it.
 */
export interface ResearchStageDependencies {
  /**
   * The durable dispatch queue. Required to hand an accepted agentic run to the controller; a host
   * without it refuses an agentic job with a stable capability reason instead of silently dropping
   * the handoff.
   */
  readonly dispatch?: WorkflowDispatchPort
}

export class ResearchStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #dispatch: WorkflowDispatchPort | undefined

  constructor(dependencies: ResearchStageDependencies) {
    this.#dispatch = dependencies.dispatch
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const job = context.job
    if (job.kind !== 'research') {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the research handler only serves research jobs', false)
    }
    const ref = decodeResearchJobRequest(job.datasetRef)
    if (!isAgentResearchJobRequest(ref)) {
      // A retired request-carrying job. Fail closed instead of running a fixed chain that no longer
      // exists or reassigning the historical run to the agentic runtime.
      throw new JobStageFailure(
        'CAPABILITY_NOT_CONFIGURED',
        'the fixed research chain is retired; finish or explicitly cancel this legacy research job with the original engine',
        false,
      )
    }
    // The scheduling handoff: enqueue the already-accepted run for the controller. `enqueue` is
    // idempotent on `(runId, logicalActionId)`, so a reclaimed attempt (a crash after the enqueue
    // but before the `dispatched` checkpoint) re-arms exactly the same durable dispatch and never a
    // second execution owner.
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
}
