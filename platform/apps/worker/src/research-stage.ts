import type { JobStageContext, JobStageHandler, JobStageOutcome } from '@ontology/application'
import { JobStageFailure, decodeResearchJobRequest, nextPipelineStage } from '@ontology/application'
import type { ResearchWorkflowService } from '@ontology/application'

/**
 * The bounded research job handler (design §2.3, A-R02).
 *
 * The durable job carries the exact authorized `ResearchRequest` in its opaque `datasetRef`. The
 * handler decodes it and runs the wired `ResearchWorkflowService` exactly once: the workflow is
 * idempotent, so replaying a reclaimed attempt or walking the remaining runnable stages only
 * re-reads the frozen execution. The handler holds no provider and no credentials — it never
 * makes a network call itself, so a research run cannot reach beyond the `web_search` adapter the
 * workflow was given.
 */
export interface ResearchStageDependencies {
  readonly workflow: ResearchWorkflowService
}

export class ResearchStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #workflow: ResearchWorkflowService

  constructor(dependencies: ResearchStageDependencies) {
    this.#workflow = dependencies.workflow
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const job = context.job
    if (job.kind !== 'research') {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the research handler only serves research jobs', false)
    }
    const ref = decodeResearchJobRequest(job.datasetRef)
    const execution = await this.#workflow.execute(
      { researchId: ref.researchId, request: ref.request },
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
