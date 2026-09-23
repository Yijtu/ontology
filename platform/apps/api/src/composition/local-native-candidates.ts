import { randomUUID } from 'node:crypto'
import type { JobStore, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'
import type { CandidateStore, DocumentParseRecord, DocumentChunkRecord, GenerationPort } from '@ontology/contracts'
import { ExtractionPipeline, JobServiceError, JobStageFailure, JobWorker, decodeExtractionJobRef, encodeExtractionJobRef, mapNativeEntities, parseNativeRecord } from '@ontology/application'
import type { JobService, JobStageHandler, JobStageHandlerRegistry } from '@ontology/application'
import type { BudgetLedgerPort, IndustrySchema, IndustrySchemaSource, SemanticDefinitionVersion, VersionRef } from '@ontology/contracts'
import { projectIndustrySchema } from '@ontology/semantic-engine'
import type { PostgresDocumentParseStore } from '@ontology/adapter-extraction-document'

const SOURCE_REF = 'operator.document-native-candidates'
const PIPELINE_VERSION = '1.0.0'
const CHUNK_LIMIT = 256

class PinnedIndustrySchemaSource implements IndustrySchemaSource {
  readonly #ref: VersionRef
  readonly #schema: IndustrySchema
  constructor(definition: SemanticDefinitionVersion) { this.#ref = definition.ref; this.#schema = projectIndustrySchema(definition) }
  async getSchema(_scope: ScopeRef, ref: VersionRef): Promise<IndustrySchema | undefined> {
    return ref.id === this.#ref.id && ref.version === this.#ref.version && ref.digest === this.#ref.digest ? structuredClone(this.#schema) : undefined
  }
}

export class LocalNativeCandidateIngestion {
  readonly #jobs: JobService
  readonly #candidateStore: CandidateStore
  readonly #worker: JobWorker

  constructor(input: {
    readonly jobs: JobService
    readonly jobStore: JobStore
    readonly candidates: CandidateStore
    readonly parseStore: PostgresDocumentParseStore
    readonly definition: SemanticDefinitionVersion
    readonly budget: BudgetLedgerPort
  }) {
    this.#jobs = input.jobs
    this.#candidateStore = input.candidates
    const schemaSource = new PinnedIndustrySchemaSource(input.definition)
    const generation: GenerationPort = { async *generate() { throw new JobStageFailure('CAPABILITY_NOT_CONFIGURED', 'unstructured extraction is unavailable without a configured model; use an exact JSON record or enter a human candidate', false) } }
    const pipeline = new ExtractionPipeline({ schemaSource, generation, candidates: input.candidates, budget: input.budget, modelRef: { modelId: 'not-configured', version: '0' }, outputLimit: { maxTokens: 1 } })
    const handlers = new Map<string, JobStageHandler>()
    handlers.set('received', {
      stage: 'received',
      async run({ job, ctx }) {
        try {
          const parseId = job.documentRef
          if (parseId === undefined) throw new JobStageFailure('INVALID_ARGUMENT', 'candidate extraction requires an imported parse id', false)
          const parsed = await parseFor(input.parseStore, parseId, ctx)
          if (parsed.record.coverage.status !== 'complete' || parsed.record.coverage.completeness !== 'complete' || parsed.chunks.length === 0 || parsed.chunks.length > CHUNK_LIMIT) {
            throw new JobStageFailure('INSUFFICIENT_DATA', 'candidate extraction requires a complete parse with at most 256 spans', false)
          }
          const schema = projectIndustrySchema(input.definition)
          for (const chunk of parsed.chunks) {
            if (chunk.truncated || chunk.precision !== 'exact') throw new JobStageFailure('INSUFFICIENT_DATA', 'approximate or truncated spans cannot produce candidates', false)
            const record = parseNativeRecord(chunk.text)
            if (record === undefined || mapNativeEntities(schema, record).length === 0) {
              throw new JobStageFailure('UNSUPPORTED_QUERY', 'automatic extraction is disabled; each source span must contain one schema-valid native JSON record', false)
            }
          }
          const extractionRef = encodeExtractionJobRef({
            parseId,
            parserVersion: parsed.record.parserVersion,
            definitionRef: input.definition.ref,
            ...(parsed.record.documentVersionRef === undefined ? {} : { documentVersionRef: parsed.record.documentVersionRef }),
            truncatedChunkIds: [],
          })
          return { nextStage: 'parsed', documentRef: extractionRef, counts: { total: parsed.chunks.length, processed: 0, failed: 0, skipped: 0 } }
        } catch (error) {
          if (error instanceof JobStageFailure) throw error
          const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown-code'
          const detail = error instanceof Error && error.name === 'DocumentExtractionError' ? error.message.slice(0, 160) : error instanceof Error ? error.name : 'unknown error'
          throw new JobStageFailure('INTERNAL_ERROR', `candidate parse stage failed (${code}:${detail})`, false)
        }
      },
    })
    handlers.set('parsed', {
      stage: 'parsed',
      async run({ job, ledgerId, ctx, signal }) {
        if (job.documentRef === undefined) throw new JobStageFailure('INVALID_ARGUMENT', 'the extraction job is missing its pinned input ref', false)
        const ref = decodeExtractionJobRef(job.documentRef)
        const parsed = await parseFor(input.parseStore, ref.parseId, ctx)
        const result = await pipeline.extract({
          jobId: job.jobId, parseId: parsed.record.parseId, parserVersion: parsed.record.parserVersion,
          pipelineVersion: PIPELINE_VERSION, definitionRef: ref.definitionRef,
          ...(ref.documentVersionRef === undefined ? {} : { documentVersionRef: ref.documentVersionRef }),
          chunks: parsed.chunks, truncatedChunkIds: ref.truncatedChunkIds ?? [],
        }, { ledgerId, ctx, signal })
        return { nextStage: 'extracted', counts: { ...result.counts, processed: result.counts.total }, ...(job.documentRef === undefined ? {} : { documentRef: job.documentRef }) }
      },
    })
    handlers.set('extracted', {
      stage: 'extracted',
      async run({ job, ledgerId, ctx, signal }) {
        if (job.documentRef === undefined) throw new JobStageFailure('INVALID_ARGUMENT', 'the extraction job is missing its pinned input ref', false)
        const ref = decodeExtractionJobRef(job.documentRef)
        const parsed = await parseFor(input.parseStore, ref.parseId, ctx)
        const result = await pipeline.validate({
          jobId: job.jobId, parseId: parsed.record.parseId, parserVersion: parsed.record.parserVersion,
          pipelineVersion: PIPELINE_VERSION, definitionRef: ref.definitionRef,
          ...(ref.documentVersionRef === undefined ? {} : { documentVersionRef: ref.documentVersionRef }),
          chunks: parsed.chunks, truncatedChunkIds: ref.truncatedChunkIds ?? [],
        }, { ledgerId, ctx, signal })
        return { nextStage: 'validated', counts: { total: result.counts.total, processed: result.counts.processed, failed: result.counts.failed, skipped: result.counts.skipped }, ...(job.documentRef === undefined ? {} : { documentRef: job.documentRef }) }
      },
    })
    handlers.set('validated', { stage: 'validated', async run({ job }) { return { nextStage: 'awaiting_review', counts: job.counts, ...(job.documentRef === undefined ? {} : { documentRef: job.documentRef }) } } })
    const registry: JobStageHandlerRegistry = { get: (stage) => handlers.get(stage) }
    this.#worker = new JobWorker({ store: input.jobStore, handlers: registry, budget: input.budget })
  }

  async extract(parseId: Uuid, idempotencyKey: string, ctx: ToolContext): Promise<{ readonly jobId: Uuid; readonly stage: string; readonly candidateIds: readonly Uuid[]; readonly deterministic: true; readonly modelCalls: 0 }> {
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const jobId = randomUUID()
    const created = await this.#jobs.createJob({ jobId, kind: 'ingestion', sourceRef: SOURCE_REF, documentRef: parseId, pipelineVersion: PIPELINE_VERSION, idempotencyKey }, ctx)
    const result = await this.#worker.runJob(created.jobId, scope, ctx)
    const job = await this.#jobs.getJob(created.jobId, ctx)
    if (result.disposition === 'failed' || job.stage === 'failed') {
      const code = job.lastError?.code ?? 'INTERNAL_ERROR'
      const stage = job.lastError?.stage ?? job.failedStage ?? job.stage
      throw new JobServiceError(code, `candidate pipeline failed in ${stage} (${code}): ${job.lastError?.message ?? 'no safe stage detail'}`)
    }
    const candidates = await this.#candidateStore.listCandidates(scope, { jobId: created.jobId, limit: CHUNK_LIMIT }, ctx)
    return { jobId: created.jobId, stage: job.stage, candidateIds: candidates.map((candidate) => candidate.candidateId), deterministic: true, modelCalls: 0 }
  }
}

async function parseFor(store: PostgresDocumentParseStore, parseId: string, ctx: ToolContext): Promise<{ record: DocumentParseRecord; chunks: readonly DocumentChunkRecord[] }> {
  const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  const record = await store.getParseById(scope, parseId, ctx)
  if (record === undefined) throw new JobStageFailure('INVALID_ARGUMENT', 'the imported parse is not visible in this scope', false)
  const chunks = await store.listChunksBounded(scope, record.parseId, CHUNK_LIMIT + 1, ctx)
  if (chunks.length === 0 || chunks.length > CHUNK_LIMIT) throw new JobStageFailure('RESULT_TOO_LARGE', 'candidate extraction exceeded the 256-span limit', false)
  return { record, chunks }
}
