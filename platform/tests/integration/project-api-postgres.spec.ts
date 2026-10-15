import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresJobStore,
  PostgresProjectReadinessStore,
  PostgresProjectStore,
  PostgresPublishedPackAssetStore,
} from '@ontology/adapter-control-postgres'
import {
  ProjectService,
  StoreBackedIndustryPackCatalogue,
  assemblePack,
} from '@ontology/application'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type {
  IndustryValidationReport,
  IndustryWorkspace,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const RECORDED_AT = '2026-09-30T00:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let projectStore: PostgresProjectStore
let readinessStore: PostgresProjectReadinessStore
let publishedPackStore: PostgresPublishedPackAssetStore
let service: ProjectService
let app: ReturnType<typeof createApiServer>

const workspaceId = randomUUID()

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function resourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function workspaceFixture(): IndustryWorkspace {
  return {
    workspaceId,
    namespace: 'demo-industry',
    displayName: 'Demo industry',
    boundary: { goals: [], included: [], excluded: [], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function reportFixture(seed: string): IndustryValidationReport {
  const exampleSetId = randomUUID()
  return {
    validationId: randomUUID(),
    workspaceId,
    revision: '1',
    exampleSetId,
    exampleSetRef: { id: exampleSetId, version: '1.0.0', digest: DIGEST, kind: 'dataset' },
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    businessApproval: 'none',
    realFactsWritten: false,
    rules: [],
    actions: [],
    semanticPublished: { passed: true, blockers: [] },
    deploymentExecutable: { passed: true, blockers: [] },
    publishable: true,
    gate: 'open',
    issues: [],
    expectationResults: [],
    coverage: [],
    contentDigest: sha(seed),
    idempotencyKey: `validation-${randomUUID()}`,
    actor: 'editor-1',
    recordedAt: RECORDED_AT,
  }
}

function publishPack(packId: string, version: string, seed: string, expectedRevision: string, target: ScopeRef) {
  const { definition, asset } = assemblePack({
    workspace: workspaceFixture(),
    scopeRef: target,
    packId,
    version,
    definitionId: `demo-industry.${packId}`,
    projection: [],
    ruleActions: [],
    report: reportFixture(seed),
    publishedAt: RECORDED_AT,
    idempotencyKey: `publish-${randomUUID()}`,
    actor: 'editor-1',
  })
  return publishedPackStore.commitApprovedPack(
    target,
    {
      expectedRevision,
      definition,
      definitionAudit: {
        digest: definition.ref.digest,
        payloadDigest: DIGEST,
        idempotencyKey: `definition-publish:${definition.namespace}:${definition.ref.id}:${definition.ref.version}`,
        occurredAt: RECORDED_AT,
        actor: 'editor-1',
      },
      pack: asset,
      idempotencyKey: asset.idempotencyKey,
      requestDigest: DIGEST,
      actor: 'editor-1',
      recordedAt: RECORDED_AT,
      outbox: {
        outboxId: randomUUID(),
        topic: 'asset.pack.published',
        payload: { packRef: asset.packRef },
        idempotencyKey: `pack-publish:${asset.namespace}:${asset.packRef.id}:${asset.packRef.version}`,
        availableAt: RECORDED_AT,
        createdAt: RECORDED_AT,
      },
      outboxJobId: randomUUID(),
    },
    // The publication runs with an editor context in the target scope.
    editorContextFor(target),
  )
}

const RUN_ID = '99999999-9999-4999-8999-999999999999'

function editorContextFor(target: ScopeRef): ToolContext {
  return createToolContext({
    principal: {
      tenantId: target.tenantId,
      subjectId: 'editor-1',
      roles: ['profile-editor', 'platform-admin'],
      scopes: [],
      authEpoch: 1,
    },
    runId: RUN_ID,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId: RUN_ID,
      grantedAt: RECORDED_AT,
      expiresAt: '2026-12-31T00:00:00Z',
    },
    allowedResources: {
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `project-api:${randomUUID()}`,
  })
}

/**
 * A test authenticator that turns request headers into a trusted principal, standing in for the
 * server-side OIDC authenticator. Identity and scope are never read from the JSON body.
 */
function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return {
    principal: { tenantId: chosen.tenantId, subjectId: subject, roles: ['platform-admin'], scopes: [], authEpoch: 1 },
    spaceId: chosen.spaceId,
  }
}

interface CallOptions {
  readonly body?: object
  readonly ifMatch?: string
  readonly idempotencyKey?: string
  readonly scope?: 'primary' | 'other'
  readonly subject?: string | null
}

function headersOf(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-scope': options.scope ?? 'primary',
  }
  if (options.subject !== null) headers['x-test-subject'] = options.subject ?? 'editor-1'
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  headers['idempotency-key'] = options.idempotencyKey ?? `idem-${randomUUID()}`
  return headers
}

async function post(url: string, options: CallOptions = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: headersOf(options),
    ...(options.body === undefined ? {} : { payload: options.body }),
  })
}

async function get(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'GET', url, headers: headersOf(options) })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'project-api')
  otherScope = await createJobScope(harness.adminClient, 'project-api-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })
  projectStore = new PostgresProjectStore(database)
  readinessStore = new PostgresProjectReadinessStore(database)
  publishedPackStore = new PostgresPublishedPackAssetStore(database)

  // The published pack is created against a real workspace in the same scope.
  await harness.adminClient.query(
    `INSERT INTO agent_platform.industry_workspaces
       (tenant_id, space_id, workspace_id, namespace, display_name, boundary, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'demo-industry', 'Demo industry', '{}'::jsonb, 1, 'draft', $4, $5, 'editor-1', now(), now())`,
    [scope.tenantId, scope.spaceId, workspaceId, `seed-${workspaceId}`, DIGEST],
  )

  const catalogue = new StoreBackedIndustryPackCatalogue({ store: publishedPackStore })
  service = new ProjectService({
    projects: projectStore,
    readiness: readinessStore,
    jobs: new PostgresJobStore(database),
    catalogue,
    newId: () => randomUUID(),
    now: () => RECORDED_AT,
  })
  app = createApiServer({ authenticate: authenticator, projects: { service } })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('customer project and version mounting API (real PostgreSQL)', () => {
  let projectId = ''
  let packV1: { id: string; version: string; digest: string }

  it('creates a project that pins the exact published pack and reports not-ready readiness', async () => {
    const published = await publishPack('demo-pack', '1.0.0', 'b', '1', scope.scopeRef)
    packV1 = published.asset.packRef

    const response = await post('/api/v1/projects', {
      idempotencyKey: `create-${randomUUID()}`,
      body: {
        title: 'Bridge costing project',
        industryPackRef: packV1,
        profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: sha('f') },
        mappingRefs: [
          {
            id: 'mapping-1',
            version: '1.0.0',
            digest: sha('c'),
            role: 'catalog',
            sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'src-1' }, objectPath: 'records' },
          },
        ],
        documentSetRef: resourceRef(),
      },
    })
    expect(response.statusCode).toBe(201)
    const created = response.json().data as {
      project: { projectId: string; headRevision: string }
      revision: { ref: { revision: string; digest: string }; industryPackRef: { version: string; digest: string }; definitionRef: { digest: string } }
    }
    projectId = created.project.projectId
    expect(created.project.headRevision).toBe('1')
    expect(created.revision.ref.revision).toBe('1')
    expect(created.revision.industryPackRef.digest).toBe(packV1.digest)

    const read = await get(`/api/v1/projects/${projectId}`)
    expect(read.statusCode).toBe(200)
    expect((read.json().data as { project: { headRevision: string } }).project.headRevision).toBe('1')

    const revision = await get(`/api/v1/projects/${projectId}/revisions/1`)
    expect(revision.statusCode).toBe(200)
    const revisionData = revision.json().data as { readiness: unknown[]; historical: boolean }
    expect(revisionData.readiness).toEqual([])
    expect(revisionData.historical).toBe(false)

    const readiness = await get(`/api/v1/projects/${projectId}/readiness?required=published_semantics`)
    expect(readiness.statusCode).toBe(200)
    const readinessData = readiness.json().data as {
      ready: boolean
      blockers: { code: string; readinessKind: string }[]
    }
    expect(readinessData.ready).toBe(false)
    expect(readinessData.blockers).toMatchObject([
      { code: 'READINESS_NOT_BUILT', readinessKind: 'published_semantics' },
    ])
  })

  it('does not auto-switch an existing project to a newer industry version', async () => {
    await publishPack('demo-pack', '1.1.0', 'd', '2', scope.scopeRef)
    const read = await get(`/api/v1/projects/${projectId}`)
    expect((read.json().data as { project: { headRevision: string } }).project.headRevision).toBe('1')
    const revision = await get(`/api/v1/projects/${projectId}/revisions/1`)
    expect((revision.json().data as { revision: { industryPackRef: { version: string } } }).revision.industryPackRef.version).toBe('1.0.0')
  })

  it('mounts the new published pack version as a new revision and keeps the old one readable', async () => {
    const packV2 = await publishedPackStore.findPack(scope.scopeRef, packV1.id, '1.1.0', editorContextFor(scope.scopeRef))
    if (packV2 === undefined) throw new Error('the second pack version was not published')

    const mounted = await post(`/api/v1/projects/${projectId}/pack-mounts`, {
      ifMatch: '1',
      idempotencyKey: `mount-${randomUUID()}`,
      body: { industryPackRef: packV2.packRef, reason: 'switch to 1.1.0' },
    })
    expect(mounted.statusCode).toBe(200)
    const mountedData = mounted.json().data as {
      revision: { ref: { revision: string }; industryPackRef: { version: string } }
      changes: string[]
      readinessInvalidated: string[]
    }
    expect(mountedData.revision.ref.revision).toBe('2')
    expect(mountedData.revision.industryPackRef.version).toBe('1.1.0')
    expect(mountedData.changes).toContain('industryPackRef')
    expect(mountedData.readinessInvalidated).toContain('published_semantics')

    const oldRevision = await get(`/api/v1/projects/${projectId}/revisions/1`)
    const oldData = oldRevision.json().data as { revision: { industryPackRef: { version: string } }; historical: boolean }
    expect(oldData.revision.industryPackRef.version).toBe('1.0.0')
    expect(oldData.historical).toBe(true)

    const revisions = await get(`/api/v1/projects/${projectId}/revisions`)
    expect((revisions.json().data as { revisions: unknown[] }).revisions).toHaveLength(2)

    await expect(
      post(`/api/v1/projects/${projectId}/pack-mounts`, {
        ifMatch: '1',
        idempotencyKey: `mount-${randomUUID()}`,
        body: { industryPackRef: packV2.packRef, reason: 'stale mount' },
      }),
    ).resolves.toMatchObject({ statusCode: 409 })
  })

  it('reports the revision ready once the required projection is materialised', async () => {
    await service.recordReadiness(
      projectId,
      {
        revision: '2',
        kind: 'published_semantics',
        targetRef: { id: 'demo-industry.definition', version: '1.1.0', digest: sha('e') },
        state: 'ready',
        completeness: 'complete',
        expectedCount: 1,
        processedCount: 1,
        failedCount: 0,
        targetDigest: sha('e'),
        fenceRevision: '2',
      },
      `readiness-${randomUUID()}`,
      'operator-1',
      editorContextFor(scope.scopeRef),
    )
    const readiness = await get(`/api/v1/projects/${projectId}/readiness?revision=2&required=published_semantics`)
    expect(readiness.statusCode).toBe(200)
    const data = readiness.json().data as { ready: boolean; blockers: unknown[]; projections: unknown[] }
    expect(data.ready).toBe(true)
    expect(data.blockers).toHaveLength(0)
    expect(data.projections).toHaveLength(1)
  })

  it('keeps a project invisible to another scope and requires authentication', async () => {
    const crossScope = await get(`/api/v1/projects/${projectId}`, { scope: 'other' })
    expect(crossScope.statusCode).toBe(404)
    expect((crossScope.json() as { error: { code: string } }).error.code).toBe('PROJECT_NOT_FOUND')

    const unauthenticated = await get(`/api/v1/projects/${projectId}`, { subject: null })
    expect(unauthenticated.statusCode).toBe(401)
  })
})
