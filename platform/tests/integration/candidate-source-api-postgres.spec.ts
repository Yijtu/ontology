import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresCandidateSourceStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import { CandidateSourceIngestionService, JobService, WebResearchService } from '@ontology/application'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  CandidateSource,
  CreateIndustryWorkspaceInput,
  ImmutableArtifactWriter,
  ResourceRef,
  ToolContext,
  Uuid,
  WebSearchProvider,
  WebSearchProviderResult,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 120_000 })

const RECORDED_AT = '2026-10-13T00:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let store: PostgresCandidateSourceStore
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let app: ReturnType<typeof createApiServer>
let workspaceId: Uuid

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function digestOf(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: sha('a'), kind: 'artifact' }
}

function source(overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    schemaVersion: 'candidate-source@1',
    sourceId: randomUUID(),
    workspaceId,
    kind: 'web_fetch',
    trustTier: 'agent_researched',
    origin: { url: 'https://example.org/standard', fetchedAt: RECORDED_AT },
    contentRef: resourceRef(),
    contentDigest: sha('b'),
    freshness: { retrievedAt: RECORDED_AT },
    reviewState: 'proposed',
    proposedBy: 'researcher',
    recordedAt: RECORDED_AT,
    ...overrides,
  }
}

function authenticator(request: { headers: Record<string, string | string[] | undefined> }): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : ['profile-editor']
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return { principal: { tenantId: chosen.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 }, spaceId: chosen.spaceId }
}

interface CallOptions {
  readonly body?: object
  readonly roles?: string
  readonly subject?: string | null
  readonly ifMatch?: string
  readonly idempotencyKey?: string
}

function headersOf(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-roles': options.roles ?? 'profile-editor',
    'x-test-scope': 'primary',
  }
  if (options.subject !== null) headers['x-test-subject'] = options.subject ?? 'editor-1'
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  headers['idempotency-key'] = options.idempotencyKey ?? `idem-${randomUUID()}`
  return headers
}

async function post(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'POST', url, headers: headersOf(options), ...(options.body === undefined ? {} : { payload: options.body }) })
}
async function get(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'GET', url, headers: headersOf(options) })
}

const throwingWriter: ImmutableArtifactWriter = { putBytes: () => { throw new Error('archived snapshots must not re-archive bytes') } }

class FakeProvider implements WebSearchProvider {
  readonly providerRef = { id: 'web-search.fake', version: '1.0.0', digest: digestOf('fake') }
  constructor(readonly result: WebSearchProviderResult) {}
  async search(): Promise<WebSearchProviderResult> { return this.result }
}

function researchApp(withProvider: boolean) {
  const ingestion = new CandidateSourceIngestionService({ artifacts: throwingWriter, sources: store, now: () => RECORDED_AT })
  const research = withProvider ? new WebResearchService({ webSearch: new FakeProvider({
    pages: [{ url: 'https://standards.example.org/gb50500', title: 'GB50500', snippet: 'load tables', fetchedAt: RECORDED_AT,
      contentDigest: digestOf('page-a'), snapshotRef: { id: randomUUID(), version: '1.0.0', digest: digestOf('page-a'), kind: 'artifact' } }],
    truncated: false, excludedCount: 0,
  }), ingestion }) : undefined
  return createApiServer({ authenticate: authenticator, candidateSources: { sources: store, ...(research === undefined ? {} : { research }) } })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'candidate-source-api')
  otherScope = await createJobScope(harness.adminClient, 'candidate-source-api-other')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresCandidateSourceStore(database)
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const jobStore = new PostgresJobStore(database)
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  const jobId = randomUUID()
  await jobService.createJob({ jobId, kind: 'ingestion', sourceRef: 'candidate-source-api', documentRef: randomUUID(), pipelineVersion: '1.0.0', idempotencyKey: `anchor-${jobId.slice(0, 12)}` }, ctx)
  workspaceId = randomUUID()
  const createInput: CreateIndustryWorkspaceInput = {
    workspace: { workspaceId, namespace: 'test.industry', displayName: 'Candidate source API workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, headRevision: '1', state: 'draft' },
    firstDraft: { workspaceId, revision: '1', digest: sha('d'), documentSetRef: resourceRef(), candidateRefs: [] },
    idempotencyKey: `ws-${randomUUID().slice(0, 12)}`, requestDigest: sha('1'), actor: 'tester', recordedAt: RECORDED_AT,
    outbox: { outboxId: randomUUID(), topic: 'asset.workspace.created', payload: { workspaceId }, idempotencyKey: `ob-${randomUUID().slice(0, 12)}`, availableAt: RECORDED_AT, createdAt: RECORDED_AT }, outboxJobId: jobId,
  }
  await workspaceStore.createWorkspace(createInput, scope.scopeRef, ctx)
  app = researchApp(true)
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('candidate source research and review API (real PostgreSQL)', () => {
  it('lists a proposed source with its tier and revision', async () => {
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    const response = await get(`/api/v1/industry-workspaces/${workspaceId}/sources?reviewState=proposed`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { data: { sources: { sourceId: string; trustTier: string; revision: string }[] } }
    const found = body.data.sources.find((row) => row.sourceId === proposed.sourceId)
    expect(found).toMatchObject({ trustTier: 'agent_researched', revision: '1' })
  })

  it('promotes a source with a compare-and-swap revision and reflects it on read', async () => {
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    const reviewed = await post(`/api/v1/industry-workspaces/${workspaceId}/sources/${proposed.sourceId}/reviews`, {
      ifMatch: '1', body: { reviewState: 'approved', trustTier: 'public_standard', reason: '原文为公开规范，人工确认版本与适用范围' },
    })
    expect(reviewed.statusCode).toBe(201)
    const body = reviewed.json() as { data: { source: { trustTier: string; reviewState: string } }; meta: { revision: string } }
    expect(body.data.source).toMatchObject({ trustTier: 'public_standard', reviewState: 'approved' })
    expect(body.meta.revision).toBe('2')
  })

  it('rejects a stale review revision and a non-reviewer role', async () => {
    const proposed = source()
    await store.putSource(scope.scopeRef, { source: proposed, idempotencyKey: `cs-${randomUUID().slice(0, 12)}` }, ctx)
    const stale = await post(`/api/v1/industry-workspaces/${workspaceId}/sources/${proposed.sourceId}/reviews`, { ifMatch: '9', body: { reviewState: 'rejected', reason: '与厂商文档重复，作为研究参考保留' } })
    expect(stale.statusCode).toBe(409)
    const forbidden = await post(`/api/v1/industry-workspaces/${workspaceId}/sources/${proposed.sourceId}/reviews`, { roles: 'business-user', ifMatch: '1', body: { reviewState: 'rejected', reason: '无审核权限' } })
    expect(forbidden.statusCode).toBe(403)
  })

  it('runs research into a proposed agent-researched source', async () => {
    const response = await post(`/api/v1/industry-workspaces/${workspaceId}/research`, {
      roles: 'researcher',
      body: { goal: '按 GB50500 建桥架计价本体', allowedResearchDomains: ['standards.example.org'], targetKinds: ['object', 'attribute'], candidateLimit: 5 },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { data: { sources: { kind: string; trustTier: string; reviewState: string }[]; skippedWithoutSnapshot: number } }
    expect(body.data.sources).toHaveLength(1)
    expect(body.data.sources[0]).toMatchObject({ kind: 'web_fetch', trustTier: 'agent_researched', reviewState: 'proposed' })
    expect(body.data.skippedWithoutSnapshot).toBe(0)

    const listed = await get(`/api/v1/industry-workspaces/${workspaceId}/sources?trustTier=agent_researched`)
    expect((listed.json() as { data: { sources: unknown[] } }).data.sources.length).toBeGreaterThan(0)
  })
})
