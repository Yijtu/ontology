import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAssetCandidateStore,
  PostgresAssetWorkspaceStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import {
  DefinitionCandidateGenerationService,
  IndustryWorkspaceService,
  StaticDefinitionTerminologySource,
} from '@ontology/application'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type { GenerationEvent, GenerationPort, GenerationRequest, ResourceRef, ToolContext } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { toolContext } from '../unit/component-registry-fixtures'

const DIGEST = `sha256:${'a'.repeat(64)}`
const POLICY_REF = { id: 'policy.tbox', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }

/** A controlled generation port: the structural acceptance does not depend on a live model. */
class ScriptedGenerationPort implements GenerationPort {
  calls = 0
  #responses: string[] = []
  #throws = false

  enqueue(response: string): void {
    this.#responses.push(response)
  }

  failWith(): void {
    this.#throws = true
  }

  recover(): void {
    this.#throws = false
  }

  async *generate(_request: GenerationRequest, _ctx: ToolContext): AsyncIterable<GenerationEvent> {
    void _request
    void _ctx
    this.calls += 1
    if (this.#throws) throw new Error('provider unavailable')
    const text = this.#responses.shift() ?? '{}'
    yield { type: 'text_delta', text }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 4 } }
    yield { type: 'completed', stopReason: 'stop', candidateOnly: true }
  }
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let app: ReturnType<typeof createApiServer>
let generation: ScriptedGenerationPort
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
    principal: { tenantId: chosen.tenantId, subjectId: subject, roles: ['profile-editor'], scopes: [], authEpoch: 1 },
    spaceId: chosen.spaceId,
  }
}

interface CallOptions {
  readonly body?: object
  readonly scope?: 'primary' | 'other'
  readonly ifMatch?: string
  readonly idempotencyKey?: string
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

function resourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

async function createWorkspace(): Promise<string> {
  const response = await post('/api/v1/industry-workspaces', {
    body: {
      namespace: 'tbox-integration',
      displayName: 'TBox integration workspace',
      boundary: { goals: ['model equipment'], included: ['catalog'], excluded: ['pricing'], applicability: {} },
      documentSetRef: resourceRef(),
    },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

async function generate(workspaceId: string, options: CallOptions = {}) {
  return post(`/api/v1/industry-workspaces/${workspaceId}/generations`, {
    ifMatch: options.ifMatch ?? '1',
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    body: {
      kinds: ['object', 'attribute'],
      generationPolicyRef: POLICY_REF,
      sourceRefs: [resourceRef('11111111-2222-4333-8444-555555555555')],
      ...options.body,
    },
  })
}

async function countRows(table: string, target: JobTestScope = scope): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE tenant_id = $1 AND space_id = $2`,
    [target.tenantId, target.spaceId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

const PAYLOAD = JSON.stringify({
  objects: [
    {
      logicalId: 'device',
      displayName: 'Device',
      businessMeaning: 'a monitored physical device',
      suggestedReason: 'the source lists devices',
      sourceIndex: 0,
      identityAttributeIds: ['device_serial'],
    },
  ],
  attributes: [
    {
      logicalId: 'device_serial',
      displayName: 'Serial',
      businessMeaning: 'manufacturer serial number',
      suggestedReason: 'appears on every row',
      objectLogicalId: 'device',
      valueType: 'string',
      minCardinality: 1,
      maxCardinality: 1,
      sourceIndex: 0,
    },
  ],
})

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'asset-candidates')
  otherScope = await createJobScope(harness.adminClient, 'asset-candidates-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const jobStore = new PostgresJobStore(database)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: jobStore, newId: () => randomUUID() })
  candidateStore = new PostgresAssetCandidateStore(database)
  generation = new ScriptedGenerationPort()
  const generationService = new DefinitionCandidateGenerationService({
    workspaces: workspaceStore,
    candidates: candidateStore,
    terminology: new StaticDefinitionTerminologySource(),
    generationForRun: () => generation,
    modelRef: { modelId: 'tbox-integration-model', version: '1.0.0' },
    outputLimit: { maxTokens: 1_024 },
    newId: () => randomUUID(),
  })
  app = createApiServer({
    authenticate: authenticator,
    industryWorkspaces: { service: workspaceService },
    assetCandidates: { generation: generationService },
  })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('definition (TBox) candidate generation (real PostgreSQL)', () => {
  it('persists definition candidates with provenance, separate from instance candidates', async () => {
    const workspaceId = await createWorkspace()
    generation.enqueue(PAYLOAD)
    const response = await generate(workspaceId)
    expect(response.statusCode).toBe(201)
    const data = response.json() as {
      data: {
        batch: { state: string; counts: { total: number }; modelRef: { modelId: string } }
        candidates: {
          domain: string
          kind: string
          logicalId: string
          state: string
          sourceRefs: unknown[]
          payload: { businessMeaning: string }
        }[]
        created: boolean
      }
    }
    expect(data.data.created).toBe(true)
    expect(data.data.batch.state).toBe('completed')
    expect(data.data.batch.modelRef.modelId).toBe('tbox-integration-model')
    expect(data.data.candidates).toHaveLength(2)
    const device = data.data.candidates.find((candidate) => candidate.logicalId === 'device')
    expect(device).toMatchObject({ domain: 'definition', kind: 'object', state: 'produced' })
    expect(device?.payload.businessMeaning).toBe('a monitored physical device')
    expect(device?.sourceRefs).toHaveLength(1)

    // Definition candidates live in their own table; the instance table is untouched.
    expect(await countRows('asset_candidate_versions')).toBe(2)
    expect(await countRows('asset_candidate_batches')).toBe(1)
    expect(await countRows('extraction_candidates')).toBe(0)

    const list = await get(`/api/v1/industry-workspaces/${workspaceId}/candidates`)
    expect(list.statusCode).toBe(200)
    expect((list.json() as { data: { candidates: unknown[] } }).data.candidates).toHaveLength(2)
  })

  it('does not touch the workspace draft or any published definition', async () => {
    const workspaceId = await createWorkspace()
    generation.enqueue(PAYLOAD)
    await generate(workspaceId)
    expect(await countRows('asset_draft_versions')).toBeGreaterThan(0)
    // No published definition version was written by generation.
    expect(await countRows('semantic_definition_versions')).toBe(0)
    const workspace = await get(`/api/v1/industry-workspaces/${workspaceId}`)
    expect((workspace.json() as { data: { workspace: { headRevision: string } } }).data.workspace.headRevision).toBe('1')
  })

  it('replays an idempotent generation without a second model call', async () => {
    const workspaceId = await createWorkspace()
    const key = `gen-idem-${randomUUID()}`
    generation.enqueue(PAYLOAD)
    const before = generation.calls
    const first = await generate(workspaceId, { idempotencyKey: key })
    expect(first.statusCode).toBe(201)
    const replay = await generate(workspaceId, { idempotencyKey: key })
    expect(replay.statusCode).toBe(201)
    const firstBody = first.json() as { data: { batch: { batchId: string }; created: boolean } }
    const replayBody = replay.json() as { data: { batch: { batchId: string }; created: boolean } }
    expect(replayBody.data.created).toBe(false)
    expect(replayBody.data.batch.batchId).toBe(firstBody.data.batch.batchId)
    expect(generation.calls).toBe(before + 1)
  })

  it('saves a failed, retryable batch and allows a later successful retry', async () => {
    const workspaceId = await createWorkspace()
    generation.failWith()
    const failed = await generate(workspaceId)
    expect(failed.statusCode).toBe(201)
    const failedBody = failed.json() as { data: { batch: { state: string; error?: { retryable: boolean } } } }
    expect(failedBody.data.batch.state).toBe('failed')
    expect(failedBody.data.batch.error?.retryable).toBe(true)

    generation.recover()
    generation.enqueue(PAYLOAD)
    const retried = await generate(workspaceId)
    const retriedBody = retried.json() as { data: { batch: { state: string } } }
    expect(retriedBody.data.batch.state).toBe('completed')
    const batches = await get(`/api/v1/industry-workspaces/${workspaceId}/generations`)
    expect((batches.json() as { data: { batches: unknown[] } }).data.batches).toHaveLength(2)
  })

  it('marks a suggestion without provenance as pending confirmation and lets a reviewer transition it', async () => {
    const workspaceId = await createWorkspace()
    generation.enqueue(
      JSON.stringify({
        objects: [
          { logicalId: 'guess', displayName: 'Guess', businessMeaning: 'g', suggestedReason: 'r' },
        ],
      }),
    )
    const response = await generate(workspaceId)
    const data = response.json() as {
      data: { batch: { state: string }; candidates: { candidateId: string; state: string; pendingConfirmation: boolean }[] }
    }
    expect(data.data.batch.state).toBe('pending_confirmation')
    const candidate = data.data.candidates[0]
    expect(candidate?.state).toBe('pending_confirmation')
    expect(candidate?.pendingConfirmation).toBe(true)
    if (candidate === undefined) throw new Error('expected a produced candidate')
    const ctx = toolContext(scope.tenantId, scope.spaceId, ['profile-editor'], 'editor-1')
    const transitioned = await candidateStore.transitionCandidate(
      scope.scopeRef,
      candidate.candidateId,
      { state: 'pending_review', issues: [], transitionedAt: '2026-09-29T00:00:00Z' },
      ctx,
    )
    expect(transitioned.state).toBe('pending_review')
  })

  it('keeps a workspace and its candidates invisible to another scope', async () => {
    const workspaceId = await createWorkspace()
    generation.enqueue(PAYLOAD)
    await generate(workspaceId)
    const other = await get(`/api/v1/industry-workspaces/${workspaceId}/candidates`, { scope: 'other' })
    expect(other.statusCode).toBe(200)
    expect((other.json() as { data: { candidates: unknown[] } }).data.candidates).toHaveLength(0)
  })
})
