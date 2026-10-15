import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import {
  LocalStructuredIngestionService,
  PostgresStructuredIngestionStore,
  StructuredIngestionError,
} from '@ontology/adapter-extraction-document'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  JobService,
  JobWorker,
  OutboxDispatcher,
  encodeStructuredIngestionRef,
} from '@ontology/application'
import type { JobStageHandler, JobStageOutcome, OutboxConsumer } from '@ontology/application'
import { createIngestionHandlerRegistry } from '@ontology/app-worker'
import { createJobApi } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { BudgetService } from '@ontology/core'
import type {
  DocumentParserPort,
  ResourceRef,
  ScopeRef,
  StructuredIngestionPort,
  StructuredIngestionRequest,
  StructuredIngestionResult,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { ManualClock } from '../unit/job-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 60_000 })

const CSV_MEDIA = 'text/csv'
const DEFINITION_REF: VersionRef = { id: 'structured-definition', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` }

let harness: JobDbHarness
let database: ControlPostgresDatabase
let jobStore: PostgresJobStore
let budgetStore: PostgresBudgetLedgerStore
let budget: BudgetService
let jobService: JobService
let app: ReturnType<typeof createJobApi>
let structuredStore: PostgresStructuredIngestionStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
const clock = new ManualClock()
let objectDir = ''

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  const rawTenant = request.headers['x-test-tenant']
  const tenant = Array.isArray(rawTenant) ? rawTenant[0] : rawTenant
  const rawSpace = request.headers['x-test-space']
  const space = Array.isArray(rawSpace) ? rawSpace[0] : rawSpace
  if (typeof tenant !== 'string' || tenant.length === 0 || typeof space !== 'string' || space.length === 0) {
    return undefined
  }
  return {
    principal: { tenantId: tenant, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: space,
  }
}

interface StructuredContext {
  readonly scope: JobTestScope
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
}

async function newContext(prefix: string): Promise<StructuredContext> {
  const scope = await createJobScope(harness.adminClient, prefix)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'data-editor'], `${prefix}-ctx`)
  return { scope, scopeRef: scope.scopeRef, ctx }
}

async function publishOriginalBytes(
  context: StructuredContext,
  bytes: Uint8Array,
  mediaType: string,
): Promise<ResourceRef> {
  const staged = await blobStore.stage(bytes, { scopeRef: context.scopeRef }, context.ctx)
  const published = await blobStore.publish(
    {
      scopeRef: context.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    context.ctx,
  )
  return published.blobRef
}

function structuredDocumentRef(
  originalRef: ResourceRef,
  options: Record<string, unknown> = {},
): string {
  return encodeStructuredIngestionRef({
    kind: 'structured_ingestion',
    originalRef,
    parserVersion: '1.0.0',
    definitionRef: DEFINITION_REF,
    format: 'csv',
    options,
  })
}

async function ingest(
  context: StructuredContext,
  documentRef: string,
  key = `structured-ingest-${randomUUID()}`,
): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ingestions',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-test-subject': 'structured-editor',
      'x-test-roles': 'data-editor,platform-admin',
      'x-test-tenant': context.scope.tenantId,
      'x-test-space': context.scope.spaceId,
    },
    payload: { sourceRef: 'structured-source', documentRef, pipelineVersion: '1.0.0' },
  })
}

/** A downstream parsed → extracted stub that emits one outbox message, so the existing outbox runs. */
function downstreamHandlers(): readonly JobStageHandler[] {
  const stub = (
    stage: 'parsed' | 'extracted',
    nextStage: 'extracted' | 'validated',
  ): JobStageHandler => ({
    stage,
    run: (context): Promise<JobStageOutcome> =>
      Promise.resolve({ nextStage, counts: context.job.counts }),
  })
  return [
    {
      stage: 'parsed',
      run: (context): Promise<JobStageOutcome> => {
        const now = clock.now()
        return Promise.resolve({
          nextStage: 'extracted',
          counts: context.job.counts,
          outbox: {
            outboxId: randomUUID(),
            topic: 'structured.rows.reconciled',
            payload: { jobId: context.job.jobId, rows: context.job.counts.total },
            idempotencyKey: `structured-rows-reconciled:${context.job.jobId}`,
            availableAt: now,
            createdAt: now,
          },
        })
      },
    },
    stub('extracted', 'validated'),
    {
      stage: 'validated',
      run: (context): Promise<JobStageOutcome> =>
        Promise.resolve({ nextStage: 'awaiting_review', counts: context.job.counts }),
    },
  ]
}

const textParserStub: DocumentParserPort = {
  parse: async () => {
    throw new Error('the text parser must not run for a structured ingestion reference')
  },
}

function buildWorker(
  ingestion: StructuredIngestionPort,
  store: PostgresJobStore,
  workerId: string,
): JobWorker {
  return new JobWorker({
    store,
    handlers: createIngestionHandlerRegistry({
      parser: textParserStub,
      structured: ingestion,
      downstream: downstreamHandlers(),
    }),
    budget,
    workerId,
    now: clock.now,
    newId: () => randomUUID(),
  })
}

async function scalar(sql: string, values: readonly unknown[]): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(sql, [...values])
  return Number(result.rows[0]?.count ?? '0')
}

function countRows(scopeRef: ScopeRef): Promise<number> {
  return scalar(
    `SELECT count(*)::text AS count FROM agent_platform.document_structured_records
      WHERE tenant_id = $1 AND space_id = $2`,
    [scopeRef.tenantId, scopeRef.spaceId],
  )
}

function countParses(scopeRef: ScopeRef, digest: string): Promise<number> {
  return scalar(
    `SELECT count(*)::text AS count FROM agent_platform.document_structured_parses
      WHERE tenant_id = $1 AND space_id = $2 AND original_content_digest = $3`,
    [scopeRef.tenantId, scopeRef.spaceId, digest],
  )
}

/** Fails the first advanceStage before commit, i.e. after the parse rows were persisted. */
class FaultInjectingJobStore extends PostgresJobStore {
  failNextAdvanceBeforeCommit = false

  override async advanceStage(
    ...args: Parameters<PostgresJobStore['advanceStage']>
  ): ReturnType<PostgresJobStore['advanceStage']> {
    if (this.failNextAdvanceBeforeCommit) {
      this.failNextAdvanceBeforeCommit = false
      throw new Error('simulated crash after persistence before the stage checkpoint')
    }
    return super.advanceStage(...args)
  }
}

/** Fails the first parse call with a transient, retryable error; the retry delegates. */
class FlakyStructuredIngestion implements StructuredIngestionPort {
  #calls = 0

  constructor(private readonly inner: StructuredIngestionPort) {}

  parse(request: StructuredIngestionRequest, ctx: ToolContext): Promise<StructuredIngestionResult> {
    this.#calls += 1
    if (this.#calls === 1) {
      return Promise.reject(
        new StructuredIngestionError('ORIGINAL_UNREADABLE', 'transient original read failure'),
      )
    }
    return this.inner.parse(request, ctx)
  }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  jobStore = new PostgresJobStore(database)
  budgetStore = new PostgresBudgetLedgerStore(database)
  budget = new BudgetService({
    store: budgetStore,
    control: new ControlPostgresRepository(database),
    now: clock.now,
    newId: () => randomUUID(),
  })
  jobService = new JobService({ store: jobStore, now: clock.now, newId: () => randomUUID() })
  app = createJobApi({ service: jobService, authenticate: testAuthenticator })

  objectDir = await mkdtemp(join(tmpdir(), 'structured-ingestion-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await structuredStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

describe('structured ingestion through the existing jobs/outbox pipeline', () => {
  it('authenticates a native parse winner across both unique keys and refuses different selections or rows', async () => {
    const context = await newContext('native-conflict')
    const bytes = new TextEncoder().encode('device,hours\nM-1,9.000000000000000001\n')
    const originalRef = await publishOriginalBytes(context, bytes, CSV_MEDIA)
    const ingestion = new LocalStructuredIngestionService({ blobs: blobStore, store: structuredStore, now: clock.now })
    const saved = await ingestion.parse({ scopeRef: context.scopeRef, originalRef, options: { headerRow: 1 } }, context.ctx)
    const page = await structuredStore.listRecords(context.scopeRef, saved.parse.parseId, { limit: 10 }, context.ctx)
    const alias = await publishOriginalBytes(context, bytes, CSV_MEDIA)
    expect(await structuredStore.recordParse({ ...saved.parse, originalRef: alias, createdAt: new Date().toISOString() }, page.records, context.ctx)).toEqual({ created: false })
    await expect(structuredStore.recordParse({ ...saved.parse, parseOptions: { headerRow: 2 } }, page.records, context.ctx)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const first = page.records[0]
    if (first === undefined) throw new Error('actual original row is missing')
    await expect(structuredStore.recordParse(saved.parse, [{ ...first, rowDigest: `sha256:${'0'.repeat(64)}` }], context.ctx)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const different = await publishOriginalBytes(context, new TextEncoder().encode('device,hours\nM-2,10\n'), CSV_MEDIA)
    await expect(structuredStore.recordParse({ ...saved.parse, originalRef: different }, page.records, context.ctx)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await structuredStore.getParse(context.scopeRef, saved.parse.parseId, context.ctx)).toEqual(saved.parse)
    expect(await structuredStore.listRecords(context.scopeRef, saved.parse.parseId, { limit: 10 }, context.ctx)).toEqual(page)
  })
  it('persists located rows, reports the stage counts and drains the outbox', async () => {
    const context = await newContext('structured-e2e')
    const csv = 'sku,qty\nA-1,10\nA-2,20\nA-3,30\n'
    const originalRef = await publishOriginalBytes(context, new TextEncoder().encode(csv), CSV_MEDIA)
    const created = await ingest(context, structuredDocumentRef(originalRef))
    expect(created.statusCode).toBe(202)
    const createdData = created.json() as { data: { jobId: string; stage: string } }
    expect(createdData.data.stage).toBe('received')
    const jobId = createdData.data.jobId

    const ingestion = new LocalStructuredIngestionService({
      blobs: blobStore,
      store: structuredStore,
      now: clock.now,
    })
    const worker = buildWorker(ingestion, jobStore, 'structured-e2e-worker')
    await worker.runUntilIdle(context.scopeRef, context.ctx)

    const view = await jobService.getJob(jobId, context.ctx)
    expect(view.stage).toBe('awaiting_review')
    expect(view.counts).toEqual({ total: 3, processed: 3, failed: 0, skipped: 0 })
    expect(view.documentRef).toBeDefined()

    const parse = await structuredStore.findParseByDigest(
      context.scopeRef,
      originalRef.digest,
      '1.0.0',
      context.ctx,
    )
    expect(parse).toBeDefined()
    if (parse === undefined) return
    expect(parse.format).toBe('csv')
    expect(parse.counts).toEqual({ total: 3, succeeded: 3, pending: 0, failed: 0, skipped: 0 })
    const page = await structuredStore.listRecords(context.scopeRef, parse.parseId, { limit: 10 }, context.ctx)
    expect(page.total).toBe(3)
    expect(page.records.every((entry) => entry.locator.kind === 'table_row')).toBe(true)

    // The completion wrote an outbox message in the same transaction as the checkpoint.
    const pending = await scalar(
      `SELECT count(*)::text AS count FROM agent_platform.job_outbox
        WHERE tenant_id = $1 AND space_id = $2 AND topic = 'structured.rows.reconciled' AND state = 'pending'`,
      [context.scopeRef.tenantId, context.scopeRef.spaceId],
    )
    expect(pending).toBe(1)

    const consumed: string[] = []
    const consumer: OutboxConsumer = {
      consume: (message) => {
        consumed.push(message.idempotencyKey)
        return Promise.resolve()
      },
    }
    const dispatcher = new OutboxDispatcher({ store: jobStore, consumer, now: clock.now })
    expect(await dispatcher.dispatchOnce(context.scopeRef, context.ctx)).toBe(1)
    expect(consumed).toEqual([`structured-rows-reconciled:${jobId}`])
    expect(await dispatcher.dispatchOnce(context.scopeRef, context.ctx)).toBe(0)
  })

  it('reclaims a crash after persistence before the checkpoint without duplicating rows', async () => {
    const context = await newContext('structured-crash')
    const csv = 'sku,qty\nA-1,1\nA-2,2\n'
    const originalRef = await publishOriginalBytes(context, new TextEncoder().encode(csv), CSV_MEDIA)
    const created = await ingest(context, structuredDocumentRef(originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const ingestion = new LocalStructuredIngestionService({ blobs: blobStore, store: structuredStore, now: clock.now })
    const faultStore = new FaultInjectingJobStore(database)
    faultStore.failNextAdvanceBeforeCommit = true
    const crashing = buildWorker(ingestion, faultStore, 'structured-crash-worker')
    await expect(crashing.runOnce(context.scopeRef, context.ctx)).rejects.toThrow(
      /simulated crash after persistence/,
    )

    const afterCrash = await jobStore.getJob(context.scopeRef, jobId, context.ctx)
    expect(afterCrash?.stage).toBe('received')
    const parse = await structuredStore.findParseByDigest(
      context.scopeRef,
      originalRef.digest,
      '1.0.0',
      context.ctx,
    )
    expect(parse).toBeDefined()
    const rowsAfterCrash = await countRows(context.scopeRef)
    expect(rowsAfterCrash).toBe(2)

    clock.advance(5 * 60_000)
    const recovering = buildWorker(ingestion, jobStore, 'structured-recover-worker')
    const result = await recovering.runOnce(context.scopeRef, context.ctx)
    expect(result.reclaimedAttemptId).toBeDefined()
    expect(result.disposition).toBe('stopped')

    const done = await jobService.getJob(jobId, context.ctx)
    expect(done.stage).toBe('awaiting_review')
    expect(await countRows(context.scopeRef)).toBe(rowsAfterCrash)
    expect(await countParses(context.scopeRef, originalRef.digest)).toBe(1)

    const attempts = await jobStore.listAttempts(context.scopeRef, jobId, context.ctx)
    expect(attempts.map((attempt) => attempt.state)).toEqual(['abandoned', 'succeeded'])
  })

  it('fails a transient parse and recovers through a bounded retry', async () => {
    const context = await newContext('structured-retry')
    const originalRef = await publishOriginalBytes(
      context,
      new TextEncoder().encode('sku,qty\nA-1,1\n'),
      CSV_MEDIA,
    )
    const created = await ingest(context, structuredDocumentRef(originalRef))
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId

    const ingestion = new LocalStructuredIngestionService({ blobs: blobStore, store: structuredStore, now: clock.now })
    const flaky = new FlakyStructuredIngestion(ingestion)
    const failing = buildWorker(flaky, jobStore, 'structured-retry-fail')
    await failing.runUntilIdle(context.scopeRef, context.ctx)

    const failed = await jobService.getJob(jobId, context.ctx)
    expect(failed.stage).toBe('failed')
    expect(failed.failedStage).toBe('received')
    expect(failed.lastError?.code).toBe('SOURCE_UNAVAILABLE')
    expect(failed.lastError?.retryable).toBe(true)

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `structured-retry-${randomUUID()}`,
        'x-test-subject': 'structured-editor',
        'x-test-roles': 'data-editor,platform-admin',
        'x-test-tenant': context.scope.tenantId,
        'x-test-space': context.scope.spaceId,
        'if-match': failed.revision,
      },
      payload: { failedStage: 'received' },
    })
    expect(retry.statusCode).toBe(200)

    const recovering = buildWorker(ingestion, jobStore, 'structured-retry-recover')
    await recovering.runUntilIdle(context.scopeRef, context.ctx)
    const done = await jobService.getJob(jobId, context.ctx)
    expect(done.stage).toBe('awaiting_review')
    expect(await countParses(context.scopeRef, originalRef.digest)).toBe(1)

    const attempts = await jobStore.listAttempts(context.scopeRef, jobId, context.ctx)
    expect(attempts.map((attempt) => attempt.state)).toEqual(['failed', 'succeeded'])
  })
})

