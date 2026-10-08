import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAssetCandidateStore,
  PostgresAssetWorkspaceStore,
  PostgresCandidateStore,
  PostgresJobStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import {
  CompositeReviewableCandidateReader,
  DefinitionCandidateEditingService,
  InMemoryDefinitionEditingStore,
  IndustryWorkspaceService,
  StaticDefinitionTerminologySource,
} from '@ontology/application'
import { SemanticPublicationService } from '@ontology/semantic-engine'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type { AssetCandidateBatch, AssetCandidateVersion, DefinitionCandidatePayload, IdentityDecisionStore, ResourceRef } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { toolContext } from '../unit/component-registry-fixtures'

const DIGEST = `sha256:${'a'.repeat(64)}`

const unusedIdentity: IdentityDecisionStore = {
  async getEntity() {
    throw new Error('identity store is not used by candidate review')
  },
  async listEntities() {
    throw new Error('identity store is not used by candidate review')
  },
  async latestRevision() {
    throw new Error('identity store is not used by candidate review')
  },
  async latestReadRevision() {
    throw new Error('identity store is not used by candidate review')
  },
  async readPublishedBindings() {
    throw new Error('identity store is not used by candidate review')
  },
  async appendDecision() {
    throw new Error('identity store is not used by candidate review')
  },
  async getDecision() {
    throw new Error('identity store is not used by candidate review')
  },
  async listDecisions() {
    throw new Error('identity store is not used by candidate review')
  },
  async listAssertions() {
    throw new Error('identity store is not used by candidate review')
  },
  async listLinkConstraints() {
    throw new Error('identity store is not used by candidate review')
  },
  async hasReviewedIdentity() {
    throw new Error('identity store is not used by candidate review')
  },
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let app: ReturnType<typeof createApiServer>
let candidateStore: PostgresAssetCandidateStore

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
    principal: {
      tenantId: chosen.tenantId,
      subjectId: subject,
      roles: ['profile-editor', 'semantic-reviewer'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: chosen.spaceId,
  }
}

interface CallOptions {
  readonly body?: object
  readonly scope?: 'primary' | 'other'
  readonly ifMatch?: string
  readonly idempotencyKey?: string
}

function headersOf(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-scope': options.scope ?? 'primary',
    'x-test-subject': 'editor-1',
    'idempotency-key': options.idempotencyKey ?? `idem-${randomUUID()}`,
  }
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
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

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

async function createWorkspace(): Promise<string> {
  const response = await post('/api/v1/industry-workspaces', {
    body: {
      namespace: 'tbox-edit-integration',
      displayName: 'TBox edit integration workspace',
      boundary: { goals: ['model equipment'], included: ['catalog'], excluded: ['pricing'], applicability: {} },
      documentSetRef: resourceRef(),
    },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

function objectPayload(logicalId: string, identity: readonly string[] = []): DefinitionCandidatePayload {
  return {
    kind: 'object',
    logicalId,
    displayName: logicalId,
    businessMeaning: `${logicalId} meaning`,
    suggestedReason: 'seeded',
    conflicts: [],
    identityAttributeIds: identity,
  }
}

function attributePayload(logicalId: string, objectLogicalId: string, valueType: 'string' | 'quantity', unitCode?: string): DefinitionCandidatePayload {
  return {
    kind: 'attribute',
    logicalId,
    displayName: logicalId,
    businessMeaning: `${logicalId} meaning`,
    suggestedReason: 'seeded',
    conflicts: [],
    objectLogicalId,
    valueType,
    ...(unitCode === undefined ? {} : { unitCode }),
    minCardinality: 0,
    maxCardinality: 1,
  }
}

async function seedCandidate(workspaceId: string, payload: DefinitionCandidatePayload): Promise<AssetCandidateVersion> {
  const batchId = randomUUID()
  const candidateId = randomUUID()
  const candidate: AssetCandidateVersion = {
    candidateId,
    batchId,
    workspaceId,
    logicalId: payload.logicalId,
    domain: 'definition',
    kind: payload.kind,
    payload,
    inputDraftRef: { workspaceId, revision: '1', digest: DIGEST },
    sourceRefs: [resourceRef()],
    sourceSpans: [],
    state: 'produced',
    issues: [],
    pendingConfirmation: false,
    contentDigest: DIGEST,
    idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
    recordedAt: new Date().toISOString(),
  }
  const batch: AssetCandidateBatch = {
    batchId,
    workspaceId,
    domain: 'definition',
    inputDraftRef: candidate.inputDraftRef,
    modelRef: { modelId: 'seed', version: '1.0.0' },
    responseSchemaRef: { id: 'seed', version: '1.0.0', digest: DIGEST },
    documentSetRef: resourceRef(),
    generationPolicyRef: { id: 'seed.policy', version: '1.0.0', digest: DIGEST },
    state: 'completed',
    counts: { total: 1, produced: 1, pendingConfirmation: 0, pendingReview: 0, failed: 0 },
    idempotencyKey: `seed-${randomUUID()}`,
    requestDigest: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
    createdBy: 'seed',
    recordedAt: new Date().toISOString(),
  }
  const result = await candidateStore.insertBatch(scope.scopeRef, batch, [candidate], editorContext())
  const stored = result.candidates[0]
  if (stored === undefined) throw new Error('seed failed')
  return stored
}

function editorContext() {
  return toolContext(scope.tenantId, scope.spaceId, ['profile-editor'], 'editor-1')
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'definition-editing')
  otherScope = await createJobScope(harness.adminClient, 'definition-editing-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const jobStore = new PostgresJobStore(database)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: jobStore, newId: () => randomUUID() })
  candidateStore = new PostgresAssetCandidateStore(database)
  const editingService = new DefinitionCandidateEditingService({
    workspaces: workspaceStore,
    candidates: candidateStore,
    terminology: new StaticDefinitionTerminologySource(),
    editing: new InMemoryDefinitionEditingStore(),
    newId: () => randomUUID(),
  })
  const publicationService = new SemanticPublicationService({
    store: new PostgresSemanticPublicationStore(database),
    candidates: new PostgresCandidateStore(database),
    schemaSource: { async getSchema() { throw new Error('schema source is not used by candidate review') } },
    identity: unusedIdentity,
    reviewableCandidates: new CompositeReviewableCandidateReader({
      definition: candidateStore,
      instance: new PostgresCandidateStore(database),
    }),
  })
  app = createApiServer({
    authenticate: authenticator,
    industryWorkspaces: { service: workspaceService },
    definitionEditing: { service: editingService },
    publications: { service: publicationService },
  })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('definition editing (real PostgreSQL)', () => {
  it('applies migration 063 with RLS and the non-executable rule constraint', async () => {
    const tables = await harness.adminClient.query<{ table_name: string; relrowsecurity: boolean }>(
      `SELECT c.relname AS table_name, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relname IN ('asset_definition_adjudications', 'asset_definition_unsupported_rules')`,
    )
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'asset_definition_adjudications',
      'asset_definition_unsupported_rules',
    ])
    expect(tables.rows.every((row) => row.relrowsecurity)).toBe(true)

    const workspaceId = await createWorkspace()
    await harness.adminClient.query(
      `INSERT INTO agent_platform.asset_definition_unsupported_rules
         (tenant_id, space_id, rule_id, workspace_id, reason, raw_form, executable, idempotency_key, actor, recorded_at)
       VALUES ($1, $2, 'rule.ok', $3, 'unsupported form', '{"op":"loop"}'::jsonb, false, $4, 'editor-1', now())`,
      [scope.tenantId, scope.spaceId, workspaceId, `keep-${randomUUID()}`],
    )
    await expect(
      harness.adminClient.query(
        `INSERT INTO agent_platform.asset_definition_unsupported_rules
           (tenant_id, space_id, rule_id, workspace_id, reason, raw_form, executable, idempotency_key, actor, recorded_at)
         VALUES ($1, $2, 'rule.bad', $3, 'unsupported form', '{}'::jsonb, true, $4, 'editor-1', now())`,
        [scope.tenantId, scope.spaceId, workspaceId, `bad-${randomUUID()}`],
      ),
    ).rejects.toThrow()
  })

  it('edits a candidate into a new persisted revision and preserves the original', async () => {
    const workspaceId = await createWorkspace()
    const original = await seedCandidate(workspaceId, attributePayload('rated_power', 'device', 'quantity', 'kW'))
    await seedCandidate(workspaceId, objectPayload('device', ['rated_power']))

    const response = await post(`/api/v1/industry-workspaces/${workspaceId}/candidates/${original.candidateId}/edits`, {
      ifMatch: '1',
      body: { payload: attributePayload('rated_power', 'device', 'quantity', 'MW'), reason: 'correct the unit' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      data: { created: boolean; candidates: { candidateId: string; replacesCandidateId?: string; payload: { unitCode?: string } }[] }
    }
    expect(body.data.created).toBe(true)
    const revision = body.data.candidates[0]
    expect(revision?.candidateId).not.toBe(original.candidateId)
    expect(revision?.replacesCandidateId).toBe(original.candidateId)
    expect(revision?.payload.unitCode).toBe('MW')

    const persisted = await candidateStore.getCandidate(scope.scopeRef, original.candidateId, editorContext())
    expect(persisted?.payload.kind === 'attribute' ? persisted.payload.unitCode : undefined).toBe('kW')
    const storedRevision = await candidateStore.getCandidate(scope.scopeRef, revision?.candidateId ?? '', editorContext())
    expect(storedRevision?.payload.kind === 'attribute' ? storedRevision.payload.unitCode : undefined).toBe('MW')

    const adjudications = await get(`/api/v1/industry-workspaces/${workspaceId}/definition-adjudications`)
    expect(adjudications.statusCode).toBe(200)
    expect((adjudications.json() as { data: { adjudications: unknown[] } }).data.adjudications).toHaveLength(1)
  })

  it('blocks publication on a duplicate identifier and allows it after keep-separate', async () => {
    const workspaceId = await createWorkspace()
    const left = await seedCandidate(workspaceId, objectPayload('device'))
    const right = await seedCandidate(workspaceId, objectPayload('device'))

    const blocked = await post(`/api/v1/industry-workspaces/${workspaceId}/definition-validations`, {
      body: { revision: '1' },
    })
    expect(blocked.statusCode).toBe(200)
    const report = blocked.json() as { data: { report: { publishable: boolean; blockers: { code: string }[] } } }
    expect(report.data.report.publishable).toBe(false)
    expect(report.data.report.blockers.some((blocker) => blocker.code === 'DUPLICATE_IDENTIFIER')).toBe(true)

    const decision = await post(`/api/v1/industry-workspaces/${workspaceId}/candidate-decisions/keep-separate`, {
      ifMatch: '1',
      body: { candidateIds: [left.candidateId, right.candidateId], reason: 'same label pending disambiguation' },
    })
    expect(decision.statusCode).toBe(200)
  })

  it('saves an unsupported rule as non-executable through the API', async () => {
    const workspaceId = await createWorkspace()
    const created = await post(`/api/v1/industry-workspaces/${workspaceId}/unsupported-rules`, {
      body: { ruleId: 'rule.cyclic', reason: 'cycles are unsupported', rawForm: { op: 'loop', depth: 3 } },
    })
    expect(created.statusCode).toBe(201)
    const rule = (created.json() as { data: { rule: { executable: boolean; rawForm: unknown } } }).data.rule
    expect(rule.executable).toBe(false)
    expect(rule.rawForm).toEqual({ op: 'loop', depth: 3 })

    const listed = await get(`/api/v1/industry-workspaces/${workspaceId}/unsupported-rules`)
    expect((listed.json() as { data: { rules: unknown[] } }).data.rules).toHaveLength(1)
  })

  it('keeps an edit invisible to another scope', async () => {
    const workspaceId = await createWorkspace()
    const candidate = await seedCandidate(workspaceId, objectPayload('device'))
    const response = await post(
      `/api/v1/industry-workspaces/${workspaceId}/candidates/${candidate.candidateId}/edits`,
      {
        ifMatch: '1',
        scope: 'other',
        body: { payload: objectPayload('device'), reason: 'noop' },
      },
    )
    expect(response.statusCode).toBe(404)
  })

  it('reviews a TBox candidate through the existing review route and does not carry the approve to the new revision', async () => {
    const workspaceId = await createWorkspace()
    const original = await seedCandidate(workspaceId, objectPayload('meter', ['meter_serial']))

    const review = await post(`/api/v1/candidates/${original.candidateId}/reviews`, {
      ifMatch: '0',
      body: { decision: 'approve', reason: 'looks correct' },
    })
    expect(review.statusCode).toBe(200)
    expect((review.json() as { data: { contentDigest?: string } }).data.contentDigest).toBe(original.contentDigest)
    const reviews = await get(`/api/v1/candidates/${original.candidateId}/reviews`)
    expect((reviews.json() as { data: { reviews: unknown[] } }).data.reviews).toHaveLength(1)

    const edited = await post(`/api/v1/industry-workspaces/${workspaceId}/candidates/${original.candidateId}/edits`, {
      ifMatch: '1',
      body: { payload: objectPayload('meter', []), reason: 'clear the identity' },
    })
    expect(edited.statusCode).toBe(200)
    const newId = (edited.json() as { data: { candidates: { candidateId: string }[] } }).data.candidates[0]?.candidateId
    expect(newId).toBeDefined()
    if (newId === undefined) throw new Error('expected a new revision')

    const newReviews = await get(`/api/v1/candidates/${newId}/reviews`)
    expect((newReviews.json() as { data: { reviews: unknown[] } }).data.reviews).toHaveLength(0)
    const oldReviews = await get(`/api/v1/candidates/${original.candidateId}/reviews`)
    expect((oldReviews.json() as { data: { reviews: unknown[] } }).data.reviews).toHaveLength(1)
  })
})
