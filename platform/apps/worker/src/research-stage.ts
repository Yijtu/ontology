import type { JobStageContext, JobStageHandler, JobStageOutcome } from '@ontology/application'
import { JobStageFailure, decodeResearchJobRequest, isLegacyResearchJobRequest, nextPipelineStage } from '@ontology/application'
import type { LegacyResearchExecutor } from '@ontology/application'

/**
 * The bounded legacy research job handler (design §2.3, A-R02).
 *
 * The durable job carries the exact authorized `ResearchRequest` in its opaque `datasetRef`. The
 * handler decodes it and drives the wired `LegacyResearchExecutor` exactly once: the executor is
 * idempotent, so replaying a reclaimed attempt or walking the remaining runnable stages only
 * re-reads the frozen execution. The handler holds no provider and no credentials — it never makes
 * a network call itself, so a research run cannot reach beyond the `web_search` adapter the
 * executor was given.
 *
 * It serves only the legacy `@1` payload; an agentic `@2` job is run by the agent runtime and is
 * refused here instead of being coerced into the fixed chain.
 */
export interface ResearchStageDependencies {
  readonly executor: LegacyResearchExecutor
}

export class ResearchStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #executor: LegacyResearchExecutor

  constructor(dependencies: ResearchStageDependencies) {
    this.#executor = dependencies.executor
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const job = context.job
    if (job.kind !== 'research') {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the research handler only serves research jobs', false)
    }
    const ref = decodeResearchJobRequest(job.datasetRef)
    if (!isLegacyResearchJobRequest(ref)) {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the legacy research handler only serves legacy research jobs', false)
    }
    const execution = await this.#executor.execute(
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
