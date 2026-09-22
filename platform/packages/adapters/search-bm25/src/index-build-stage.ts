import type { DocumentParseRecord, JobStageCounts, RunnableJobStage } from '@ontology/contracts'
import type { Bm25IndexBuilder } from './builder'
import type { IndexBuildStageHandler, IndexBuildStageOutcome } from './types'

export const KEYWORD_INDEX_ACTIVATED_TOPIC = 'keyword.index.activated'

export interface Bm25IndexBuildStageDependencies {
  readonly builder: Bm25IndexBuilder
  readonly collectionRef: string
  /**
   * The parsed corpus this job indexes. The upstream parse stage produces these;
   * the index stage consumes their chunks instead of re-parsing.
   */
  readonly parses: readonly DocumentParseRecord[]
  /** Pipeline stage the index build runs at. Defaults to `extracted`. */
  readonly stage?: RunnableJobStage
  readonly outboxTopic?: string
}

/**
 * Runs the keyword index build as a durable job stage (SPEC D6, LOCAL-022).
 *
 * The worker owns persistence, so the handler only reports the outcome: the build
 * and activation are idempotent, and the publication intent makes the index
 * version an exactly-once job publication. A crash before the atomic generation
 * write commits leaves no generation and therefore nothing to publish; a crash
 * after it re-runs the same build and publishes the same version once.
 *
 * The return shape mirrors the application layer's `JobStageHandler` structurally,
 * because an adapter may not import `@ontology/application` (SPEC §2).
 */
export function createBm25IndexBuildHandler(
  dependencies: Bm25IndexBuildStageDependencies,
): IndexBuildStageHandler {
  const stage: RunnableJobStage = dependencies.stage ?? 'extracted'
  const topic = dependencies.outboxTopic ?? KEYWORD_INDEX_ACTIVATED_TOPIC
  return {
    stage,
    async run(context): Promise<IndexBuildStageOutcome> {
      const result = await dependencies.builder.build(
        { collectionRef: dependencies.collectionRef, parses: dependencies.parses },
        context.ctx,
      )
      await dependencies.builder.activate(
        dependencies.collectionRef,
        result.generation.generation,
        context.ctx,
      )
      const counts: JobStageCounts = {
        total: context.job.counts.total + result.documentCount,
        processed: context.job.counts.processed + result.documentCount,
        failed: context.job.counts.failed,
        skipped: context.job.counts.skipped,
      }
      return {
        nextStage: 'published',
        counts,
        publication: {
          publicationKey: `keyword-index:${dependencies.collectionRef}:${result.generation.generation}`,
          versionRef: result.generation.indexRef,
          outboxTopic: topic,
          outboxPayload: {
            collectionRef: dependencies.collectionRef,
            generation: result.generation.generation,
            indexDigest: result.generation.indexDigest,
            documentCount: result.documentCount,
          },
        },
      }
    },
  }
}
