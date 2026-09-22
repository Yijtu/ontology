import { randomUUID } from 'node:crypto'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import {
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  InMemoryJobStore,
  JobService,
  JobStageFailure,
  JobWorker,
} from '@ontology/application'
import type { JobStageHandler, JobStageHandlerRegistry, JobStageOutcome } from '@ontology/application'
import { InMemoryDocumentParseStore, sha256DigestOfText } from '@ontology/adapter-extraction-document'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import {
  IdentityDecisionService,
  InMemoryIdentityDecisionStore,
  InMemorySemanticPublicationStore,
  SemanticPublicationService,
} from '@ontology/semantic-engine'
import {
  createToolContext,
} from '@ontology/contracts'
import type {
  ControlAppendEventResponse,
  ControlRepository,
  DocumentChunkRecord,
  DocumentParseRecord,
  EntityCandidate,
  JobStageCounts,
  ProjectionState,
  RunnableJobStage,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'
import { PUBLICATION_DEFINITION_REF, publicationSchema } from '../unit/publication-fixtures'

/**
 * Shared fixture for the ingestion-job and candidate-review surfaces. It builds the real
 * Fastify API over in-memory stores — the same routes the browser talks to — and seeds a
 * parse, its chunks and the candidates that reference them, so the UI can be driven against
 * real HTTP behaviour (including 409 conflicts and explicit source failures) rather than a
 * hand-written fake.
 */

export const REVIEW_SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

export const REVIEW_ROLES =
  'platform-admin,data-editor,semantic-reviewer,semantic-publisher,scoped-reader'

export const REVIEW_SENTINEL_SECRET = 'super-secret-token-DO-NOT-LEAK-review-7c1d'

export const REVIEW_PARSE_ID = '99999999-9999-4999-8999-999999999999'
export const REVIEW_JOB_ID = '88888888-8888-4888-8888-888888888888'
export const CHARGER_CHUNK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const CHARGER_TEXT = '设备名称：充电器一号；额定功率 7kW；安装位置：车库'

const CHARGER_DIGEST = sha256DigestOfText(CHARGER_TEXT)

export function chargerSpan(): EntityCandidate['sourceSpans'][number] {
  return {
    parseId: REVIEW_PARSE_ID,
    chunkId: CHARGER_CHUNK_ID,
    locator: { kind: 'page', page: 3, startOffset: 0, endOffset: CHARGER_TEXT.length },
    spanKind: 'normalized',
    precision: 'exact',
    quoteDigest: CHARGER_DIGEST,
    textDigest: CHARGER_DIGEST,
  }
}

function idempotencyKey(): string {
  return `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`
}

export function reviewCandidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  const candidateId = overrides.candidateId ?? randomUUID()
  return {
    kind: 'entity',
    jobId: REVIEW_JOB_ID,
    objectId: 'device',
    identityScopeId: 'device_identity',
    attributes: [
      { attributeId: 'device_native_id', value: `DEV-${candidateId.slice(0, 4)}` },
      { attributeId: 'device_name', value: '充电器一号' },
    ],
    sourceSpans: [chargerSpan()],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: PUBLICATION_DEFINITION_REF,
      parseId: REVIEW_PARSE_ID,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    idempotencyKey: idempotencyKey(),
    recordedAt: '2026-09-22T00:00:00Z',
    ...overrides,
    candidateId,
  }
}

export function reviewParseRecord(): DocumentParseRecord {
  return {
    parseId: REVIEW_PARSE_ID,
    scopeRef: REVIEW_SCOPE,
    mediaKind: 'text',
    originalMediaType: 'text/plain',
    originalRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
    normalizedMediaType: 'text/plain',
    normalizedByteSize: CHARGER_TEXT.length,
    normalizedRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' },
    spanMapMediaType: 'application/json',
    spanMapRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'artifact' },
    parserId: 'fixture-parser',
    parserVersion: '1.0.0',
    offsetUnit: 'character',
    coverage: {
      status: 'complete',
      completeness: 'complete',
      totalUnits: 1,
      parsedUnits: 1,
      skippedUnits: 0,
      skippedReasons: [],
      notes: [],
    },
    pages: [{ page: 3, startOffset: 0, endOffset: CHARGER_TEXT.length, approximate: false }],
    createdAt: '2026-09-22T00:00:00Z',
  }
}

export function chargerChunk(): DocumentChunkRecord {
  return {
    chunkId: CHARGER_CHUNK_ID,
    ordinal: 0,
    chunkKind: 'clause',
    // A sentinel in an internal chunk field the review projection deliberately does not echo;
    // a test asserts it never reaches an API response or the rendered HTML.
    heading: REVIEW_SENTINEL_SECRET,
    text: CHARGER_TEXT,
    textDigest: CHARGER_DIGEST,
    locator: { kind: 'page', page: 3, startOffset: 0, endOffset: CHARGER_TEXT.length },
    spanKind: 'normalized',
    precision: 'exact',
    quoteDigest: CHARGER_DIGEST,
    conditions: [],
    exceptions: [],
  }
}

export interface ReviewHarnessOptions {
  readonly roles?: string
  /** Use the fixed loopback principal (browser E2E) instead of header-driven identity. */
  readonly fixedPrincipal?: boolean
  /** Start with no candidates, to exercise the explicit empty state. */
  readonly emptyCandidates?: boolean
  /** Omit the parse store, so the source route answers `CAPABILITY_NOT_CONFIGURED`. */
  readonly withoutDocuments?: boolean
}

export interface ReviewHarness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly baseUrl: string
  readonly candidates: InMemoryCandidateStore
  readonly documents: InMemoryDocumentParseStore
  readonly jobService: JobService
  readonly jobStore: InMemoryJobStore
  readonly failedJobId: string
  readonly publishedJobId: string
  readonly missingSourceCandidateId: string
  readonly sourceCandidateId: string
}

/** A minimal control repository: this fixture drives jobs through an in-memory store only. */
class NullControlRepository implements ControlRepository {
  async transaction(): Promise<void> {
    return undefined
  }

  async readProjection(): Promise<ProjectionState> {
    return Promise.reject(new Error('readProjection is not used by the review fixture'))
  }

  async appendEvent(): Promise<ControlAppendEventResponse> {
    return { recordedSeq: '1', appended: true }
  }
}

/** Insert one more candidate into a running harness (used by the browser E2E). */
export async function insertReviewCandidate(
  harness: ReviewHarness,
  overrides: Partial<EntityCandidate> = {},
): Promise<EntityCandidate> {
  const candidate = reviewCandidate(overrides)
  await harness.candidates.insertCandidates(REVIEW_SCOPE, [candidate], editorContext())
  return candidate
}

function editorContext(): ToolContext {
  return createToolContext({
    principal: {
      tenantId: REVIEW_SCOPE.tenantId,
      subjectId: 'review-editor',
      roles: ['platform-admin', 'data-editor', 'semantic-reviewer', 'semantic-publisher'],
      scopes: [],
      authEpoch: 1,
    },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '1.0.0',
    deadline: '2026-09-22T00:10:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-22T00:00:00Z',
      expiresAt: '2026-09-22T00:10:00Z',
    },
    allowedResources: {
      tenantId: REVIEW_SCOPE.tenantId,
      spaceId: REVIEW_SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-review-fixture',
  })
}

export const PUBLICATION_VERSION: VersionRef = {
  id: 'review-fixture-document-version',
  version: '1.0.0',
  digest: `sha256:${'f'.repeat(64)}`,
}

interface PipelineOptions {
  readonly failAt?: RunnableJobStage
  readonly publish?: boolean
}

const NEXT_STAGE: Readonly<Record<RunnableJobStage, 'parsed' | 'extracted' | 'validated' | 'awaiting_review'>> = {
  received: 'parsed',
  parsed: 'extracted',
  extracted: 'validated',
  validated: 'awaiting_review',
}

const RUNNABLE_STAGES: readonly RunnableJobStage[] = ['received', 'parsed', 'extracted', 'validated']

function advanceCounts(previous: JobStageCounts): JobStageCounts {
  return {
    total: previous.total + 1,
    processed: previous.processed + 1,
    failed: previous.failed,
    skipped: previous.skipped,
  }
}

/**
 * Controlled stage handlers: they stand in for the parser/extractor this slice does not own,
 * so the job UI is driven by the real stage/checkpoint contract without a document pipeline.
 */
function pipelineHandlers(options: PipelineOptions = {}): JobStageHandlerRegistry {
  const handlers = new Map<RunnableJobStage, JobStageHandler>()
  for (const stage of RUNNABLE_STAGES) {
    handlers.set(stage, {
      stage,
      run: async (context): Promise<JobStageOutcome> => {
        if (options.failAt === stage) {
          throw new JobStageFailure('SOURCE_UNAVAILABLE', 'the controlled source was unavailable', true)
        }
        const counts = advanceCounts(context.job.counts)
        const nextStage = stage === 'validated' && options.publish === true ? 'published' : NEXT_STAGE[stage]
        if (nextStage === 'published') {
          return {
            nextStage,
            counts,
            publication: {
              publicationKey: `document-version:${context.job.jobId}`,
              versionRef: PUBLICATION_VERSION,
              outboxTopic: 'semantic.publication.committed',
              outboxPayload: { jobId: context.job.jobId },
            },
          }
        }
        return { nextStage, counts }
      },
    })
  }
  return {
    get: (stage) => (stage in NEXT_STAGE ? handlers.get(stage as RunnableJobStage) : undefined),
  }
}

/** Header-driven authenticator for the jsdom tests, which can set headers per request. */
export function headerAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  return {
    principal: { tenantId: REVIEW_SCOPE.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: REVIEW_SCOPE.spaceId,
  }
}

/** Fixed-principal authenticator for the browser E2E harness (loopback only). */
export function loopbackAuthenticator(): AuthenticatedRequest {
  return {
    principal: {
      tenantId: REVIEW_SCOPE.tenantId,
      subjectId: 'e2e-reviewer',
      roles: ['platform-admin', 'data-editor', 'semantic-reviewer', 'semantic-publisher', 'scoped-reader'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: REVIEW_SCOPE.spaceId,
  }
}

export async function startReviewHarness(options: ReviewHarnessOptions = {}): Promise<ReviewHarness> {
  const candidates = new InMemoryCandidateStore()
  const documents = new InMemoryDocumentParseStore()
  const identityStore = new InMemoryIdentityDecisionStore()
  const publicationStore = new InMemorySemanticPublicationStore()
  const jobStore = new InMemoryJobStore()
  const ctx = editorContext()

  await documents.recordParse(reviewParseRecord(), [chargerChunk()], ctx)

  const sourceCandidate = reviewCandidate()
  const missingSourceCandidate = reviewCandidate({ sourceSpans: [] })
  if (options.emptyCandidates !== true) {
    await candidates.insertCandidates(REVIEW_SCOPE, [sourceCandidate, missingSourceCandidate], ctx)
  }

  const schemaSource = new InMemoryIndustrySchemaSource([
    { ref: PUBLICATION_DEFINITION_REF, schema: publicationSchema(PUBLICATION_DEFINITION_REF) },
  ])
  const identityService = new IdentityDecisionService({
    store: identityStore,
    candidates,
    schemaSource,
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  const publicationService = new SemanticPublicationService({
    store: publicationStore,
    candidates,
    schemaSource,
    identity: identityStore,
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })

  const app = createApiServer({
    authenticate: options.fixedPrincipal === true ? loopbackAuthenticator : headerAuthenticator,
    jobs: { service: jobService },
    decisions: {
      service: identityService,
      candidates,
      ...(options.withoutDocuments === true ? {} : { documents }),
    },
    publications: { service: publicationService },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('the API did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const roles = options.roles ?? REVIEW_ROLES
  const client = new WorkbenchClient({
    baseUrl,
    fetchImpl: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers ?? {}), 'x-test-subject': 'ui-reviewer', 'x-test-roles': roles },
      }),
  })

  const budget = new BudgetService({
    store: new InMemoryBudgetLedgerStore(),
    control: new NullControlRepository(),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })

  const createJob = async (handlers: JobStageHandlerRegistry): Promise<string> => {
    const jobId = randomUUID()
    await jobService.createJob(
      {
        jobId,
        kind: 'ingestion',
        sourceRef: 'review-fixture-source',
        // A distinct document ref per job: the logical job identity is content-derived, so two
        // jobs with identical input would collapse into one.
        documentRef: `review-document-${jobId}`,
        pipelineVersion: '1.0.0',
        idempotencyKey: `review-fixture-${jobId}`,
      },
      ctx,
    )
    const worker = new JobWorker({
      store: jobStore,
      handlers,
      budget,
      workerId: 'ui-worker',
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    })
    await worker.runUntilIdle(REVIEW_SCOPE, ctx)
    return jobId
  }

  const failedJobId = await createJob(pipelineHandlers({ failAt: 'extracted' }))
  const publishedJobId = await createJob(pipelineHandlers({ publish: true }))

  return {
    app,
    client,
    baseUrl,
    candidates,
    documents,
    jobService,
    jobStore,
    failedJobId,
    publishedJobId,
    missingSourceCandidateId: missingSourceCandidate.candidateId,
    sourceCandidateId: sourceCandidate.candidateId,
  }
}
