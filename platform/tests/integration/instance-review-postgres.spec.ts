import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresInstanceReviewStore,
  PostgresCandidateStore,
  PostgresProjectStore,
  PostgresProjectDocumentStore,
  PostgresIdentityDecisionStore,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { InstanceReviewService, InMemoryIndustrySchemaSource, JobService } from '@ontology/application'
import type { InstanceFieldPolicy } from '@ontology/application'
import { createApiServer, createInstanceIdentityWorkflow } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  InstanceFieldSource,
  EntityCandidate,
  IndustrySchema,
  InstanceIdentityCandidate,
  ResourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { IdentityDecisionService, InMemoryIdentityIndexReader } from '@ontology/semantic-engine'
import type { IdentityIndexEntry } from '@ontology/semantic-engine'
import { seedIdentityProject, seedIdentityParse } from './instance-identity-fixtures'
import { toolContext } from '../unit/component-registry-fixtures'
import { MIGRATIONS_DIR, createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 120_000 })

const DIGEST = `sha256:${'a'.repeat(64)}`
const MIGRATION_062 = '062_instance_review.sql'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let store: PostgresInstanceReviewStore
let service: InstanceReviewService
let app: ReturnType<typeof createApiServer>
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let projectId: Uuid
let candidateStore: PostgresCandidateStore
let documents: PostgresProjectDocumentStore
let identityStore: PostgresIdentityDecisionStore
let schemaSource: InMemoryIndustrySchemaSource
const identityEntries: IdentityIndexEntry[] = []
const DEFINITION = { id: 'instance.fixture', version: '1.0.0', digest: DIGEST }
const schema: IndustrySchema = {
  namespace: 'fixture', definitionRef: DEFINITION,
  objects: [{ objectId: 'device', displayName: 'Device', identityScopeId: 'device_identity', attributes: [
    { attributeId: 'device_name', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
    { attributeId: 'capacity', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
  ] }], relations: [], identityScopes: [{ identityScopeId: 'device_identity', objectId: 'device', scopeDimensions: [], identityAttributeIds: [] }],
}

const fieldPolicy: InstanceFieldPolicy = {
  validate: ({ objectTypeRef, fieldId, normalizedValue }) => {
    if (objectTypeRef !== 'device') return undefined
    if (fieldId !== 'device_name' && fieldId !== 'capacity') return 'unknown field'
    if (normalizedValue === undefined) return 'no normalized value yet'
    return undefined
  },
}

function resourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function source(fieldId: string): InstanceFieldSource {
  return {
    documentRef: resourceRef(),
    parseId: randomUUID(),
    chunkId: randomUUID(),
    locator: { kind: 'json_pointer', pointer: `/${fieldId}`, startByte: 0, endByte: 4, normalizationMapRef: 'nm-1' },
    textDigest: DIGEST,
    quoteDigest: DIGEST,
  }
}

function candidate(entityId: string, objectId: string, displayName: string): InstanceIdentityCandidate {
  return { entityId, objectId, displayName, strategy: 'native_id' }
}

/** A test authenticator that turns request headers into a trusted principal. */
function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : ['semantic-reviewer']
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return {
    principal: { tenantId: chosen.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: chosen.spaceId,
  }
}

interface CallOptions {
  readonly body?: object
  readonly roles?: string
  readonly subject?: string | null
  readonly scope?: 'primary' | 'other'
  readonly ifMatch?: string
  readonly idempotencyKey?: string
}

function headersOf(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-roles': options.roles ?? 'semantic-reviewer',
    'x-test-scope': options.scope ?? 'primary',
  }
  if (options.subject !== null) headers['x-test-subject'] = options.subject ?? 'reviewer-1'
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  headers['idempotency-key'] = options.idempotencyKey ?? `idem-${randomUUID()}`
  return headers
}

async function post(url: string, options: CallOptions = {}) {
  let payload = options.body
  if (url === `/api/v1/projects/${projectId}/instance-records` && payload !== undefined) {
    // Server-side fixture setup preserves this suite's field/history assertions; the actual
    // request sends selectors only. Real business-index recall is covered by identity-recall-postgres.
    const body = payload as ReturnType<typeof createBody>
    const fields = body['fields'] as { fieldId: string; rawValue: string; normalizedValue?: { kind: string; value: string }; source: InstanceFieldSource }[]
    const first = fields[0]
    if (first === undefined) throw new Error('fixture has no fields')
    const parseId = first.source.parseId
    await seedIdentityParse(harness.adminClient, scope.scopeRef, parseId)
    const jobId = randomUUID()
    await new JobService({ store: new PostgresJobStore(database) }).createJob({ jobId, kind: 'ingestion', sourceRef: 'instance-fixture', documentRef: parseId, pipelineVersion: '1.0.0', idempotencyKey: `fixture-${jobId}` }, ctx)
    const candidateId = randomUUID()
    const extracted: EntityCandidate = {
      kind: 'entity', candidateId, jobId, objectId: 'device', identityScopeId: 'device_identity',
      attributes: fields.map((field) => ({ attributeId: field.fieldId, value: field.normalizedValue?.value ?? field.rawValue, raw: field.rawValue })),
      sourceSpans: [{ kind: 'structured', parseId, recordId: randomUUID(), sourceRowKey: candidateId, locator: first.source.locator, rowDigest: first.source.quoteDigest }],
      deterministic: false, state: 'pending_review', issues: [], inputVersion: { definitionRef: DEFINITION, parseId, parserVersion: '1.0.0', pipelineVersion: '1.0.0' },
      idempotencyKey: `sha256:${candidateId.replaceAll('-', '').padEnd(64, '0')}`, recordedAt: new Date().toISOString(),
    }
    await candidateStore.insertCandidates(scope.scopeRef, [extracted], ctx)
    const documentId = randomUUID()
    await documents.registerDocument(scope.scopeRef, projectId, { documentId, documentRef: first.source.documentRef, documentDigest: first.source.documentRef.digest, parseId, parseRef: resourceRef(), textDigest: first.source.textDigest, precision: 'exact', actor: 'fixture', recordedAt: new Date().toISOString() }, ctx)
    for (const entry of body['identityCandidates'] as InstanceIdentityCandidate[]) {
      if (await identityStore.getEntity(scope.scopeRef, entry.entityId, ctx) === undefined) {
        let ids = 0
        const decisions = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource, newId: () => ++ids === 2 ? entry.entityId : randomUUID() })
        await decisions.decide({ projectId, candidateId, kind: 'create_pending', expectedRevision: '0' }, ctx)
      }
      if (!identityEntries.some((known) => known.entityId === entry.entityId)) identityEntries.push({ tenantId: scope.tenantId, spaceId: scope.spaceId, entityId: entry.entityId, objectId: entry.objectId, identityScopeId: 'device_identity', displayName: entry.displayName, normalizedName: entry.displayName.toLowerCase(), entityType: entry.objectId, aliasConfirmed: false, dimensions: { project: projectId } })
    }
    payload = { candidateId, documentId, relations: body['relations'] }
  }
  return app.inject({ method: 'POST', url, headers: headersOf(options), ...(payload === undefined ? {} : { payload }) })
}

function get(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'GET', url, headers: headersOf(options) })
}

async function seedProject(): Promise<Uuid> {
  const id = randomUUID()
  await seedIdentityProject(harness.adminClient, scope.scopeRef, id, DEFINITION)
  return id
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectTypeRef: 'device',
    displayName: 'Bridge A',
    identityCandidates: [candidate(randomUUID(), 'device', 'Bridge A')],
    fields: [
      { fieldId: 'device_name', rawValue: 'Bridge A', normalizedValue: { kind: 'scalar', value: 'Bridge A' }, source: source('device_name') },
    ],
    relations: [],
    sourceRef: resourceRef(),
    ...overrides,
  }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'instance-review')
  otherScope = await createJobScope(harness.adminClient, 'instance-review-other')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-reviewer', 'data-editor'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresInstanceReviewStore(database)
  service = new InstanceReviewService({ store, fieldPolicy, now: () => '2026-09-29T00:00:00Z' })
  candidateStore = new PostgresCandidateStore(database)
  documents = new PostgresProjectDocumentStore(database)
  identityStore = new PostgresIdentityDecisionStore(database)
  schemaSource = new InMemoryIndustrySchemaSource([{ ref: DEFINITION, schema }])
  const identity = createInstanceIdentityWorkflow({ identityMappingRef: DEFINITION, service, projects: new PostgresProjectStore(database), projectDocuments: documents, candidates: candidateStore, identityStore, schemaSource,
    index: { query: (query, context) => new InMemoryIdentityIndexReader(identityEntries).query(query, context) },
  })
  app = createApiServer({ authenticate: authenticator, instanceReviews: { service, identity } })
  await app.ready()
  projectId = await seedProject()
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('public instance review against real PostgreSQL', () => {
  it('applies migration 062 idempotently', async () => {
    const report = await runControlMigrations({ connectionString: harness.adminUrl, migrationsDir: MIGRATIONS_DIR })
    expect(report.applied).toHaveLength(0)
    expect(report.skipped).toContain(MIGRATION_062)
  })

  it('creates a record over HTTP, reads it back and persists the append-only revision', async () => {
    const created = await post(`/api/v1/projects/${projectId}/instance-records`, { body: createBody() })
    expect(created.statusCode).toBe(201)
    const record = (created.json() as { data: { record: { recordId: string; recordRevision: string; fields: { status: string }[] } } }).data.record
    expect(record.recordRevision).toBe('1')
    expect(record.fields[0]?.status).toBe('pending')

    const read = await get(`/api/v1/projects/${projectId}/instance-records/${record.recordId}`)
    expect(read.statusCode).toBe(200)
    const readRecord = (read.json() as { data: { record: { fields: { rawValue: string; source: { locator: { kind: string } } }[] } } }).data.record
    expect(readRecord.fields[0]?.rawValue).toBe('Bridge A')
    expect(readRecord.fields[0]?.source.locator.kind).toBe('json_pointer')

    const rows = await harness.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.instance_review_records
        WHERE tenant_id = $1 AND space_id = $2 AND record_id = $3`,
      [scope.tenantId, scope.spaceId, record.recordId],
    )
    expect(rows.rows[0]?.count).toBe('1')
  })

  it('requires If-Match (428), rejects a stale revision (409) and blocks publication until confirmed', async () => {
    const created = await post(`/api/v1/projects/${projectId}/instance-records`, { body: createBody() })
    const record = (created.json() as { data: { record: { recordId: string } } }).data.record

    const missing = await post(`/api/v1/projects/${projectId}/instance-records/${record.recordId}/field-confirmations`, {
      body: { decisions: [{ fieldId: 'device_name', decision: 'confirm' }] },
    })
    expect(missing.statusCode).toBe(428)

    const stale = await post(`/api/v1/projects/${projectId}/instance-records/${record.recordId}/field-edits`, {
      ifMatch: '9',
      body: { fieldId: 'device_name', normalizedValue: { kind: 'scalar', value: 'x' }, reason: 'stale' },
    })
    expect(stale.statusCode).toBe(409)
    expect((stale.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')

    const blocked = await post(`/api/v1/projects/${projectId}/instance-records/${record.recordId}/approve`, { ifMatch: '1', body: {} })
    expect(blocked.statusCode).toBe(409)
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('PUBLICATION_BLOCKED')
  })

  it('confirms fields, edits a value, records history, approves and publishes over HTTP with read-back', async () => {
    const created = await post(`/api/v1/projects/${projectId}/instance-records`, { body: createBody() })
    const recordId = (created.json() as { data: { record: { recordId: string } } }).data.record.recordId

    const confirmed = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/field-confirmations`, {
      ifMatch: '1',
      body: { decisions: [{ fieldId: 'device_name', decision: 'confirm' }, { fieldId: 'ghost', decision: 'confirm' }] },
    })
    expect(confirmed.statusCode).toBe(200)
    const outcome = confirmed.json() as { data: { record: { recordRevision: string; fields: { status: string }[] }; accepted: unknown[]; skipped: unknown[] } }
    expect(outcome.data.record.fields[0]?.status).toBe('confirmed')
    expect(outcome.data.skipped).toHaveLength(1)

    const edited = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/field-edits`, {
      ifMatch: outcome.data.record.recordRevision,
      body: { fieldId: 'device_name', normalizedValue: { kind: 'scalar', value: 'Bridge B' }, reason: 'source shows a new value' },
    })
    expect(edited.statusCode).toBe(200)
    const editedRecord = edited.json() as { data: { record: { recordRevision: string; fields: { status: string; normalizedValue: { value: string } }[] } } }
    expect(editedRecord.data.record.fields[0]?.status).toBe('pending')
    expect(editedRecord.data.record.fields[0]?.normalizedValue.value).toBe('Bridge B')

    const reConfirmed = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/field-confirmations`, {
      ifMatch: editedRecord.data.record.recordRevision,
      body: { decisions: [{ fieldId: 'device_name', decision: 'confirm' }] },
    })
    const reConfirmedRecord = reConfirmed.json() as { data: { record: { recordRevision: string } } }

    const adjudicated = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/identity-decisions`, {
      ifMatch: reConfirmedRecord.data.record.recordRevision,
      body: { kind: 'create', reason: 'new entity' },
    })
    expect(adjudicated.statusCode).toBe(200)
    const adjudicatedRecord = adjudicated.json() as { data: { record: { recordRevision: string; identity: { state: string } } } }
    expect(adjudicatedRecord.data.record.identity.state).toBe('created')

    const approved = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/approve`, {
      ifMatch: adjudicatedRecord.data.record.recordRevision,
      body: {},
    })
    expect(approved.statusCode).toBe(200)
    const approvedRecord = approved.json() as { data: { record: { recordRevision: string; publicationState: string } } }
    expect(approvedRecord.data.record.publicationState).toBe('approved')

    const published = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/publish`, {
      ifMatch: approvedRecord.data.record.recordRevision,
      body: {},
    })
    expect(published.statusCode).toBe(200)
    const publishedRecord = published.json() as { data: { record: { publishedRevision: string; publicationState: string } } }
    expect(publishedRecord.data.record.publicationState).toBe('published')
    expect(publishedRecord.data.record.publishedRevision).toBeDefined()

    const readBack = await get(`/api/v1/projects/${projectId}/instance-records/${recordId}`)
    expect((readBack.json() as { data: { record: { publishedRevision: string } } }).data.record.publishedRevision).toBe(
      publishedRecord.data.record.publishedRevision,
    )

    const history = await get(`/api/v1/projects/${projectId}/instance-records/${recordId}/confirmations`)
    const confirmations = (history.json() as { data: { confirmations: { fieldId: string; status: string }[] } }).data.confirmations
    expect(confirmations.some((event) => event.fieldId === 'device_name' && event.status === 'confirmed')).toBe(true)
  })

  it('never deletes an independent record when two records merge onto one entity', async () => {
    const entity = randomUUID()
    const first = await post(`/api/v1/projects/${projectId}/instance-records`, {
      body: createBody({ identityCandidates: [candidate(entity, 'device', 'Bridge A')] }),
    })
    const second = await post(`/api/v1/projects/${projectId}/instance-records`, {
      body: createBody({ identityCandidates: [candidate(entity, 'device', 'Bridge A')] }),
    })
    const secondId = (second.json() as { data: { record: { recordId: string } } }).data.record.recordId
    await post(`/api/v1/projects/${projectId}/instance-records/${secondId}/identity-decisions`, {
      ifMatch: '1',
      body: { kind: 'match', targetEntityId: entity, reason: 'same device' },
    })
    const firstId = (first.json() as { data: { record: { recordId: string } } }).data.record.recordId
    const firstRead = await get(`/api/v1/projects/${projectId}/instance-records/${firstId}`)
    expect(firstRead.statusCode).toBe(200)
    const secondRead = await get(`/api/v1/projects/${projectId}/instance-records/${secondId}`)
    expect(secondRead.statusCode).toBe(200)
    // Both stable rows survive; a merge never deletes a business record.
    const rows = await harness.adminClient.query<{ count: string }>(
      `SELECT count(DISTINCT record_id)::text AS count FROM agent_platform.instance_review_records
        WHERE tenant_id = $1 AND space_id = $2 AND record_id IN ($3::uuid, $4::uuid)`,
      [scope.tenantId, scope.spaceId, firstId, secondId],
    )
    expect(rows.rows[0]?.count).toBe('2')
  })

  it('keeps a record invisible to another scope and enforces reviewer role', async () => {
    const created = await post(`/api/v1/projects/${projectId}/instance-records`, { body: createBody() })
    const recordId = (created.json() as { data: { record: { recordId: string } } }).data.record.recordId

    const crossScope = await get(`/api/v1/projects/${projectId}/instance-records/${recordId}`, { scope: 'other' })
    expect(crossScope.statusCode).toBe(404)

    const forbidden = await post(`/api/v1/projects/${projectId}/instance-records/${recordId}/approve`, {
      roles: 'business-user',
      ifMatch: '1',
      body: {},
    })
    expect(forbidden.statusCode).toBe(403)

    const unauthenticated = await get(`/api/v1/projects/${projectId}/instance-records`, { subject: null })
    expect(unauthenticated.statusCode).toBe(401)
  })

  it('rejects a cross-scope store read', async () => {
    const created = await post(`/api/v1/projects/${projectId}/instance-records`, { body: createBody() })
    const recordId = (created.json() as { data: { record: { recordId: string } } }).data.record.recordId
    const foreignScope = { tenantId: randomUUID(), spaceId: randomUUID() }
    await expect(store.getRecord(foreignScope, projectId, recordId, ctx)).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
    })
  })
})
