import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresJobStore } from '@ontology/adapter-control-postgres'
import { JobWorker } from '@ontology/application'
import { createJobApi, createPostgresJobService } from '@ontology/app-api'
import type { AuthenticatedRequest, JobServiceComposition } from '@ontology/app-api'
import { toolContext } from '../unit/component-registry-fixtures'
import { createBudgetHarness, pipelineHandlers } from '../unit/job-fixtures'
import {
  JOB_SPACE_A,
  JOB_SPACE_B,
  JOB_TENANT_A,
  JOB_TENANT_B,
  createJobScope,
  startJobDatabase,
} from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

let harness: JobDbHarness
let composition: JobServiceComposition
let app: ReturnType<typeof createJobApi>
let store: PostgresJobStore

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  const rawScope = request.headers['x-test-scope']
  const scope = Array.isArray(rawScope) ? rawScope[0] : rawScope
  // An explicit tenant/space header lets a test use a fresh, isolated scope.
  const rawTenant = request.headers['x-test-tenant']
  const tenant = Array.isArray(rawTenant) ? rawTenant[0] : rawTenant
  const rawSpace = request.headers['x-test-space']
  const space = Array.isArray(rawSpace) ? rawSpace[0] : rawSpace
  if (typeof tenant === 'string' && tenant.length > 0 && typeof space === 'string' && space.length > 0) {
    return { principal: { tenantId: tenant, subjectId: subject, roles, scopes: [], authEpoch: 1 }, spaceId: space }
  }
  const isB = scope === 'b'
  return {
    principal: {
      tenantId: isB ? JOB_TENANT_B : JOB_TENANT_A,
      subjectId: subject,
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: isB ? JOB_SPACE_B : JOB_SPACE_A,
  }
}

function ingestionBody(pipelineVersion = '1.0.0') {
  return {
    sourceRef: 'source-api',
    documentRef: `doc-api-${randomUUID()}`,
    pipelineVersion,
  }
}

function ingest(options?: { readonly key?: string; readonly body?: Record<string, unknown>; readonly subject?: string; readonly roles?: string }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ingestions',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': options?.key ?? `api-${randomUUID()}`,
      'x-test-subject': options?.subject ?? 'api-editor',
      'x-test-roles': options?.roles ?? 'data-editor',
    },
    payload: options?.body ?? ingestionBody(),
  })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  composition = createPostgresJobService({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresJobStore(composition.database)
  app = createJobApi({ service: composition.service, authenticate: testAuthenticator })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await harness?.stop()
})

describe('POST /ingestions', () => {
  it('accepts an ingestion and reuses the job for the same Idempotency-Key and payload', async () => {
    const key = `api-key-${randomUUID()}`
    const body = ingestionBody()
    const first = await ingest({ key, body })
    expect(first.statusCode).toBe(202)
    const firstData = first.json() as { data: { jobId: string; stage: string; jobUrl: string } }
    expect(firstData.data.stage).toBe('received')
    expect(firstData.data.jobUrl).toBe(`/api/v1/jobs/${firstData.data.jobId}`)

    const second = await ingest({ key, body })
    expect(second.statusCode).toBe(202)
    const secondData = second.json() as { data: { jobId: string } }
    expect(secondData.data.jobId).toBe(firstData.data.jobId)

    const rows = await harness.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.jobs WHERE idempotency_key = $1`,
      [key],
    )
    expect(rows.rows[0]?.count).toBe('1')
  })

  it('rejects the same key with a different pipeline version with 409', async () => {
    const key = `api-key-${randomUUID()}`
    await ingest({ key, body: ingestionBody('1.0.0') })
    const conflict = await ingest({ key, body: ingestionBody('2.0.0') })
    expect(conflict.statusCode).toBe(409)
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('requires the Idempotency-Key header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ingestions',
      headers: { 'content-type': 'application/json', 'x-test-subject': 'api-editor', 'x-test-roles': 'data-editor' },
      payload: ingestionBody(),
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
  })

  it('returns 401 without an authenticated principal', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ingestions',
      headers: { 'content-type': 'application/json', 'idempotency-key': `api-${randomUUID()}` },
      payload: ingestionBody(),
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses an ingestion from a principal without the data-editor role', async () => {
    const response = await ingest({ roles: 'business-user', subject: 'api-viewer' })
    expect(response.statusCode).toBe(403)
    expect((response.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })
})

describe('GET /jobs/{id}', () => {
  it('returns stage, counts and errors and hides the job from another tenant', async () => {
    const created = await ingest({})
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { 'x-test-subject': 'api-viewer', 'x-test-roles': 'scoped-reader' },
    })
    expect(view.statusCode).toBe(200)
    const data = view.json() as { data: { stage: string; counts: { total: number }; attempts: unknown[] } }
    expect(data.data.stage).toBe('received')
    expect(data.data.counts.total).toBe(0)
    expect(data.data.attempts).toEqual([])

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { 'x-test-subject': 'api-editor-b', 'x-test-roles': 'data-editor', 'x-test-scope': 'b' },
    })
    expect(crossTenant.statusCode).toBe(404)
  })
})

describe('POST /jobs/{id}/retry', () => {
  async function failedJob(): Promise<{ jobId: string; revision: string; tenantId: string; spaceId: string }> {
    const scope = await createJobScope(harness.adminClient, 'api-retry')
    const editor = toolContext(scope.tenantId, scope.spaceId, ['data-editor'], 'api-editor')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/ingestions',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `api-${randomUUID()}`,
        'x-test-subject': 'api-editor',
        'x-test-roles': 'data-editor',
        'x-test-tenant': scope.tenantId,
        'x-test-space': scope.spaceId,
      },
      payload: ingestionBody(),
    })
    const jobId = (created.json() as { data: { jobId: string } }).data.jobId
    const worker = new JobWorker({
      store,
      handlers: pipelineHandlers({ failAt: 'extracted' }),
      budget: createBudgetHarness().budget,
      workerId: 'api-worker',
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    })
    await worker.runOnce(scope.scopeRef, editor)
    const job = await store.getJob(scope.scopeRef, jobId, editor)
    if (job === undefined) throw new Error('failed job missing')
    return { jobId, revision: job.revision, tenantId: scope.tenantId, spaceId: scope.spaceId }
  }

  it('creates a new attempt of the same logical job with If-Match and Idempotency-Key', async () => {
    const { jobId, revision, tenantId, spaceId } = await failedJob()
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: {
        'content-type': 'application/json',
        'x-test-subject': 'api-editor',
        'x-test-roles': 'data-editor',
        'x-test-tenant': tenantId,
        'x-test-space': spaceId,
        'idempotency-key': `retry-${randomUUID()}`,
        'if-match': revision,
      },
      payload: { failedStage: 'extracted' },
    })
    expect(response.statusCode).toBe(200)
    const data = response.json() as { data: { jobId: string; stage: string; attemptCount: number } }
    expect(data.data.jobId).toBe(jobId)
    expect(data.data.stage).toBe('extracted')
    expect(data.data.attemptCount).toBe(2)
  })

  it('returns 428 without If-Match and 409 for a stale revision', async () => {
    const { jobId, revision, tenantId, spaceId } = await failedJob()
    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: {
        'content-type': 'application/json',
        'x-test-subject': 'api-editor',
        'x-test-roles': 'data-editor',
        'x-test-tenant': tenantId,
        'x-test-space': spaceId,
        'idempotency-key': `retry-${randomUUID()}`,
      },
      payload: { failedStage: 'extracted' },
    })
    expect(missing.statusCode).toBe(428)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED')

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/retry`,
      headers: {
        'content-type': 'application/json',
        'x-test-subject': 'api-editor',
        'x-test-roles': 'data-editor',
        'x-test-tenant': tenantId,
        'x-test-space': spaceId,
        'idempotency-key': `retry-${randomUUID()}`,
        'if-match': '99',
      },
      payload: { failedStage: 'extracted' },
    })
    expect(stale.statusCode).toBe(409)
    expect((stale.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')
    expect(revision).not.toBe('99')
  })
})
