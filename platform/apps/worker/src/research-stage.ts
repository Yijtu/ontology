import type { JobStageContext, JobStageHandler, JobStageOutcome } from '@ontology/application'
import {
  JobStageFailure,
  decodeResearchJobRequest,
  isAgentResearchJobRequest,
  isCatalogueResearchJobRequest,
  nextPipelineStage,
} from '@ontology/application'
import type { LegacyResearchExecutor, ResearchProviderSource } from '@ontology/application'

/**
 * The bounded research job handler (design §2.3, A-R02; S03).
 *
 * The durable job carries the exact authorized `ResearchRequest` in its opaque `datasetRef`. The
 * handler decodes it and drives the wired `LegacyResearchExecutor` exactly once: the executor is
 * idempotent, so replaying a reclaimed attempt or walking the remaining runnable stages only
 * re-reads the frozen execution. The handler holds no provider and no credentials — it never makes
 * a network call itself.
 *
 * The job version selects the provider source: a catalogue `1.1.0` job resolves its public search
 * from the pinned tool-connection binding (S03), while a legacy `1.0.0` job keeps the deployment
 * environment path. An agentic `2.0.0` job is run by the agent runtime and is refused here instead
 * of being coerced into the fixed chain.
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
    if (isAgentResearchJobRequest(ref)) {
      throw new JobStageFailure('INVALID_ARGUMENT', 'the fixed research chain does not serve agentic research jobs', false)
    }
    const providerSource: ResearchProviderSource = isCatalogueResearchJobRequest(ref) ? 'catalogue' : 'env'
    const execution = await this.#executor.execute(
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
