import type {
  DocumentParseStore,
  LogicalJobRecord,
  PipelineStage,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { JobStageFailure } from '../jobs/errors'
import type {
  JobStageContext,
  JobStageHandler,
  JobStageHandlerRegistry,
  JobStageOutcome,
} from '../jobs/types'
import { decodeExtractionJobRef } from './job-ref'
import type { ExtractionPipeline } from './extraction-service'
import type { ExtractionInput } from './types'

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

async function buildInput(
  job: LogicalJobRecord,
  parseStore: DocumentParseStore,
  ctx: ToolContext,
  loadChunks: boolean,
): Promise<ExtractionInput> {
  const documentRef = job.documentRef
  if (documentRef === undefined) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'an extraction job requires a documentRef', false)
  }
  let ref
  try {
    ref = decodeExtractionJobRef(documentRef)
  } catch (error) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'the extraction job reference is malformed', false, {
      cause: error,
    })
  }
  const chunks = loadChunks ? await parseStore.listChunks(scopeOf(ctx), ref.parseId, ctx) : []
  if (loadChunks && chunks.length === 0) {
    throw new JobStageFailure('INSUFFICIENT_DATA', 'the parse has no chunks to extract', false)
  }
  return {
    jobId: job.jobId,
    parseId: ref.parseId,
    parserVersion: ref.parserVersion,
    pipelineVersion: job.pipelineVersion,
    definitionRef: ref.definitionRef,
    ...(ref.documentVersionRef === undefined ? {} : { documentVersionRef: ref.documentVersionRef }),
    chunks,
    truncatedChunkIds: ref.truncatedChunkIds ?? [],
  }
}

export interface ExtractionStageHandlerDependencies {
  readonly pipeline: ExtractionPipeline
  readonly parseStore: DocumentParseStore
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * `parsed → extracted`: consume the traceable chunks of the job's parse and produce
 * append-only entity/relation candidates. The handler owns no persistence: the worker writes
 * the stage checkpoint, the counts and the outbox message in one transaction.
 */
export class ExtractionStageHandler implements JobStageHandler {
  readonly stage = 'parsed' as const
  readonly #pipeline: ExtractionPipeline
  readonly #parseStore: DocumentParseStore
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: ExtractionStageHandlerDependencies) {
    this.#pipeline = dependencies.pipeline
    this.#parseStore = dependencies.parseStore
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const input = await buildInput(context.job, this.#parseStore, context.ctx, true)
    const result = await this.#pipeline.extract(input, {
      ledgerId: context.ledgerId,
      ctx: context.ctx,
      signal: context.signal,
    })
    const now = this.#now()
    return {
      nextStage: 'extracted',
      counts: result.counts,
      outbox: {
        outboxId: this.#newId(),
        topic: 'extraction.candidates.produced',
        payload: {
          jobId: context.job.jobId,
          candidateCount: result.candidateIds.length,
          modelCalls: result.modelCalls,
          deterministicCandidates: result.deterministicCandidates,
          ruleCandidates: result.ruleCandidates,
          unhandledRules: result.unhandledRules,
        },
        idempotencyKey: `extraction-candidates-produced:${context.job.jobId}`,
        availableAt: now,
        createdAt: now,
      },
    }
  }
}

/**
 * `extracted → validated`: run the deterministic schema/span validation and move every
 * candidate to `pending_review` or `failed`. It re-decodes the job reference but never
 * re-reads chunks or calls the model, so a retry from this stage does not redo extraction.
 */
export class CandidateValidationStageHandler implements JobStageHandler {
  readonly stage = 'extracted' as const
  readonly #pipeline: ExtractionPipeline
  readonly #parseStore: DocumentParseStore

  constructor(dependencies: ExtractionStageHandlerDependencies) {
    this.#pipeline = dependencies.pipeline
    this.#parseStore = dependencies.parseStore
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const input = await buildInput(context.job, this.#parseStore, context.ctx, false)
    const result = await this.#pipeline.validate(input, {
      ledgerId: context.ledgerId,
      ctx: context.ctx,
      signal: context.signal,
    })
    return { nextStage: 'validated', counts: result.counts }
  }
}

/** Build a stage registry from the extraction handlers so the worker can claim them. */
export function createExtractionHandlerRegistry(
  handlers: readonly JobStageHandler[],
): JobStageHandlerRegistry {
  const byStage = new Map<PipelineStage, JobStageHandler>()
  for (const handler of handlers) byStage.set(handler.stage, handler)
  return { get: (stage) => byStage.get(stage) }
}

/**
 * `validated → awaiting_review`: the validated candidates are handed to human review. The
 * stage only moves the job to the stop stage; it never publishes anything (D4.6), so a
 * candidate still needs an explicit review decision before it can affect published truth.
 */
export class ReviewHandoffStageHandler implements JobStageHandler {
  readonly stage = 'validated' as const

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    return { nextStage: 'awaiting_review', counts: context.job.counts }
  }
}
