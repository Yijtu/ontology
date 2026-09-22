import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresCandidateStore,
  PostgresIdentityDecisionStore,
  PostgresJobStore,
  PostgresSemanticPublicationStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { PostgresDocumentParseStore, sha256DigestOfText } from '@ontology/adapter-extraction-document'
import { InMemoryIndustrySchemaSource, JobService } from '@ontology/application'
import {
  IdentityDecisionService,
  SemanticPublicationService,
} from '@ontology/semantic-engine'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  DocumentChunkRecord,
  DocumentParseRecord,
  EntityCandidate,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { PUBLICATION_DEFINITION_REF, entityFor, publicationSchema } from '../unit/publication-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

vi.setConfig({ testTimeout: 120_000 })

const CHARGER_TEXT = '设备名称：充电器一号；额定功率 7kW；安装位置：车库'
const CHARGER_DIGEST = sha256DigestOfText(CHARGER_TEXT)
const SENTINEL_SECRET = 'super-secret-token-DO-NOT-LEAK-integration-9f2a'

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let candidateStore: PostgresCandidateStore
let publicationStore: PostgresSemanticPublicationStore
let documents: PostgresDocumentParseStore
let app: ReturnType<typeof createApiServer>
let parseId: Uuid
let jobId: Uuid
let deviceCandidate: EntityCandidate
let missingSourceCandidate: EntityCandidate

function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles =
    typeof rolesValue === 'string' && rolesValue.length > 0
      ? rolesValue.split(',')
      : ['semantic-reviewer', 'semantic-publisher']
  return {
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'ui-reviewer',
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: scope.spaceId,
  }
}

function parseRecord(): DocumentParseRecord {
  return {
    parseId,
    scopeRef: scope.scopeRef,
    mediaKind: 'text',
    originalMediaType: 'text/plain',
    originalRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
    normalizedMediaType: 'text/plain',
    normalizedByteSize: CHARGER_TEXT.length,
    normalizedRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' },
    spanMapMediaType: 'application/json',
    spanMapRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'artifact' },
    parserId: 'integration-parser',
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

function chunkRecord(): DocumentChunkRecord {
  return {
    chunkId: randomUUID(),
    ordinal: 0,
    chunkKind: 'clause',
    // Internal chunk metadata the source projection must not echo.
    heading: SENTINEL_SECRET,
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

function candidateFor(chunkId: string, overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  const candidateId = randomUUID()
  return entityFor({
    candidateId,
    idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
    jobId,
    inputVersion: {
      definitionRef: PUBLICATION_DEFINITION_REF,
      parseId,
      parserVersion: '1.0.0',
      pipelineVersion: '1.0.0',
    },
    sourceSpans: [
      {
        parseId,
        chunkId,
        locator: { kind: 'page', page: 3, startOffset: 0, endOffset: CHARGER_TEXT.length },
        spanKind: 'normalized',
        precision: 'exact',
        quoteDigest: CHARGER_DIGEST,
        textDigest: CHARGER_DIGEST,
      },
    ],
    ...overrides,
  })
}

function schemaSource(): InMemoryIndustrySchemaSource {
  return new InMemoryIndustrySchemaSource([
    { ref: PUBLICATION_DEFINITION_REF, schema: publicationSchema(PUBLICATION_DEFINITION_REF) },
  ])
}

function review(candidateId: string, decision: 'approve' | 'reject', reason: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/candidates/${candidateId}/reviews`,
    headers: { 'content-type': 'application/json', 'x-test-roles': 'semantic-reviewer', 'if-match': '0' },
    payload: { decision, reason },
  })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  await runControlMigrations({ connectionString: harness.adminUrl, migrationsDir: MIGRATIONS_DIR })
  scope = await createJobScope(harness.adminClient, 'ui-review')
  ctx = toolContext(scope.tenantId, scope.spaceId, [
    'semantic-reviewer',
    'semantic-publisher',
    'data-editor',
    'platform-admin',
  ])

  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  candidateStore = new PostgresCandidateStore(database)
  const identityStore = new PostgresIdentityDecisionStore(database)
  publicationStore = new PostgresSemanticPublicationStore(database)
  const jobStore = new PostgresJobStore(database)
  documents = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 4 })

  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  parseId = randomUUID()
  const chunk = chunkRecord()
  await documents.recordParse(parseRecord(), [chunk], ctx)

  jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'ui-review-source',
      documentRef: `ui-review-document-${jobId}`,
      pipelineVersion: '1.0.0',
      idempotencyKey: `ui-review-${jobId}`,
    },
    ctx,
  )

  deviceCandidate = candidateFor(chunk.chunkId)
  missingSourceCandidate = candidateFor(chunk.chunkId, { sourceSpans: [] })
  await candidateStore.insertCandidates(scope.scopeRef, [deviceCandidate, missingSourceCandidate], ctx)

  const identityService = new IdentityDecisionService({
    store: identityStore,
    candidates: candidateStore,
    schemaSource: schemaSource(),
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  const publicationService = new SemanticPublicationService({
    store: publicationStore,
    candidates: candidateStore,
    schemaSource: schemaSource(),
    identity: identityStore,
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  app = createApiServer({
    authenticate: authenticator,
    jobs: { service: jobService },
    decisions: { service: identityService, candidates: candidateStore, documents },
    publications: { service: publicationService },
  })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await documents?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('candidate review UI routes against real PostgreSQL', () => {
  it('lists candidates, reads the detail and resolves the source span to the stored chunk', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/candidates',
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(listed.statusCode).toBe(200)
    const ids = (listed.json() as { data: { candidates: { candidateId: string }[] } }).data.candidates.map(
      (entry) => entry.candidateId,
    )
    expect(ids).toEqual(expect.arrayContaining([deviceCandidate.candidateId, missingSourceCandidate.candidateId]))

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}`,
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(detail.statusCode).toBe(200)
    const detailBody = detail.json() as {
      data: { candidate: { kind: string; decisionRevision: string; sourceSpans: unknown[] } }
    }
    expect(detailBody.data.candidate.kind).toBe('entity')
    expect(detailBody.data.candidate.decisionRevision).toBe('0')
    expect(detailBody.data.candidate.sourceSpans).toHaveLength(1)

    const source = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}/source`,
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(source.statusCode).toBe(200)
    const sourceBody = source.json() as {
      data: { missingSource: boolean; spans: { status: string; text?: string }[] }
    }
    expect(sourceBody.data.missingSource).toBe(false)
    expect(sourceBody.data.spans[0]?.status).toBe('resolved')
    expect(sourceBody.data.spans[0]?.text).toBe(CHARGER_TEXT)
    // The projection never echoes the internal chunk heading (where the sentinel lives).
    expect(source.body).not.toContain(SENTINEL_SECRET)

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${missingSourceCandidate.candidateId}/source`,
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(missing.statusCode).toBe(200)
    expect((missing.json() as { data: { missingSource: boolean } }).data.missingSource).toBe(true)
  })

  it('records an identity decision, refuses a stale revision, and lists the history', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}/decision`,
      headers: { 'content-type': 'application/json', 'x-test-roles': 'semantic-reviewer', 'if-match': '0' },
      payload: { kind: 'create_pending' },
    })
    expect(created.statusCode).toBe(200)
    const entityId = (created.json() as { data: { targetEntityId: string } }).data.targetEntityId

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}/decision`,
      headers: { 'content-type': 'application/json', 'x-test-roles': 'semantic-reviewer', 'if-match': '0' },
      payload: { kind: 'clarify' },
    })
    expect(stale.statusCode).toBe(409)
    expect((stale.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')

    const matched = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}/decision`,
      headers: { 'content-type': 'application/json', 'x-test-roles': 'semantic-reviewer', 'if-match': '1' },
      payload: { kind: 'match', targetEntityId: entityId, justification: '已核对原文' },
    })
    expect(matched.statusCode).toBe(200)
    expect((matched.json() as { data: { revision: string } }).data.revision).toBe('2')

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}/decisions`,
      headers: { 'x-test-roles': 'semantic-reviewer' },
    })
    expect(history.statusCode).toBe(200)
    const kinds = (history.json() as { data: { decisions: { kind: string }[] } }).data.decisions.map(
      (entry) => entry.kind,
    )
    expect(kinds).toEqual(['create_pending', 'match'])
  })

  it('publishes an approved candidate, revises it and keeps the prior basis readable', async () => {
    const approved = await review(deviceCandidate.candidateId, 'approve', 'source verified')
    expect(approved.statusCode).toBe(200)

    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/semantic-publications',
      headers: {
        'content-type': 'application/json',
        'x-test-roles': 'semantic-publisher',
        'if-match': '0',
        'idempotency-key': `ui-review-publish-${randomUUID()}`,
      },
      payload: {
        approvedCandidateRefs: [{ candidateId: deviceCandidate.candidateId, kind: 'entity' }],
        schemaRef: PUBLICATION_DEFINITION_REF,
      },
    })
    expect(published.statusCode).toBe(201)
    expect((published.json() as { data: { statements: unknown[] } }).data.statements).toHaveLength(1)

    const revised = await app.inject({
      method: 'POST',
      url: `/api/v1/statements/${deviceCandidate.candidateId}/revisions`,
      headers: {
        'content-type': 'application/json',
        'x-test-roles': 'semantic-publisher',
        'if-match': '1',
        'idempotency-key': `ui-review-revise-${randomUUID()}`,
      },
      payload: { kind: 'correction', reason: '依据更新为现场核验' },
    })
    expect(revised.statusCode).toBe(200)
    expect((revised.json() as { data: { version: string } }).data.version).toBe('2')

    const revisions = await app.inject({
      method: 'GET',
      url: `/api/v1/statements/${deviceCandidate.candidateId}/revisions`,
      headers: { 'x-test-roles': 'semantic-publisher' },
    })
    expect(revisions.statusCode).toBe(200)
    const records = (revisions.json() as { data: { revisions: { kind: string; reason: string; supersedesVersion?: string }[] } })
      .data.revisions
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'correction', reason: '依据更新为现场核验', supersedesVersion: '1' })
    expect(revisions.body).not.toContain(SENTINEL_SECRET)
  })

  it('reads the real job the candidates belong to', async () => {
    const view = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { 'x-test-roles': 'scoped-reader' },
    })
    expect(view.statusCode).toBe(200)
    const body = view.json() as { data: { jobId: string; stage: string; counts: { processed: number } } }
    expect(body.data.jobId).toBe(jobId)
    expect(body.data.stage).toBe('received')
    expect(body.data.counts.processed).toBe(0)
  })

  it('refuses the source route without the semantic-reviewer role', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${deviceCandidate.candidateId}/source`,
      headers: { 'x-test-roles': 'business-user' },
    })
    expect(denied.statusCode).toBe(403)
    expect((denied.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })
})
