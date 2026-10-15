import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import {
  coreScenarioTaskBindings,
  createBlobArtifactWriter,
  createCoreApi,
  createCoreLocalComposition,
  loadCoreExamples,
} from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type {
  MappingRef,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * W07 real-database acceptance for a registered-compute task run.
 *
 * The default `createCoreLocalComposition` host mounts a `compute` task binding that pins the
 * neutral registered example operation. This drives the compute task through the normal HTTP
 * surface: a task-mode `POST /runs` selects the mounted binding, the Template runtime prepares
 * the deterministic `data_query.kind=compute` plan, the shared gateway runs the registered
 * operation over the approved input snapshot, the typed writer projects `computation.metrics`
 * into row-bound quantity/money claims, the publication gate publishes the same verified @3
 * version, and the answer is read back through `/answers/{id}/result` and the JSON export.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `corecompute_${randomUUID().replaceAll('-', '')}`
const SCENARIO_ID = 'transport-facility-inspection'
const PROJECT_ID = randomUUID()
const DIGEST = `sha256:${'a'.repeat(64)}`
const CHANGE_REASON = 'W07 registered-compute task acceptance'

function mappingRef(): MappingRef {
  return {
    id: 'compute-mapping',
    version: '1.0.0',
    digest: DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'compute', sourceId: 'records' }, objectPath: 'records' },
  }
}

function revisionBody(
  definitionRef: { id: string; version: string; digest: string },
  approvedInputRef: ResourceRef,
): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'compute-pack', version: '1.0.0', digest: DIGEST },
    definitionRef,
    mappingRefs: [mappingRef()],
    profileRef: { id: 'compute-profile', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'document' },
    approvedInputRef,
    semanticPublicationRefs: [definitionRef],
    sourceVisibilityEpoch: '1',
    changeReason: CHANGE_REASON,
  }
}

function projectRevisionRef(body: ProjectRevisionBody): ProjectRevisionRef {
  return { projectId: PROJECT_ID, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }
}

const COMPUTE_INPUT_ROWS = {
  rows: [
    { id: 'R-1', amount: '10', unit: 'each' },
    { id: 'R-2', amount: '2.5', unit: 'each' },
    { id: 'R-3', amount: '1.25', currency: 'CNY' },
  ],
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let approvedInputRef: ResourceRef
let projectRevisionRefValue: ProjectRevisionRef
const workerErrors: Error[] = []

function trustedContext(scope: ScopeRef): ToolContext {
  return createToolContext({
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'compute-author',
      roles: ['platform-admin', 'operator', 'data-editor'],
      scopes: [],
      authEpoch: 1,
    },
    runId: randomUUID(),
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId: randomUUID(),
      grantedAt: '2026-09-30T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      resourceKinds: ['artifact', 'document', 'dataset', 'computation'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `compute:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `compute-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Compute'])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  appUrl = `postgres://${encodeURIComponent('ontology_app')}:${encodeURIComponent(APP_PASSWORD)}@${new URL(container.adminUrl).hostname}:${new URL(container.adminUrl).port}/${new URL(container.adminUrl).pathname.replace(/^\//, '')}`
}

/** Archive the exact compute input the operation will aggregate, in the host's own blob scope. */
async function archiveComputeInput(): Promise<ResourceRef> {
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
    const writer = createBlobArtifactWriter(blobStore)
    const stored = await writer.putBytes(
      {
        scopeRef,
        content: new TextEncoder().encode(canonicalJson(COMPUTE_INPUT_ROWS)),
        mediaType: 'application/json',
      },
      trustedContext(scopeRef),
    )
    return stored.blobRef
  } finally {
    await registry.close().catch(() => undefined)
  }
}

async function seedProject(body: ProjectRevisionBody): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'W07 compute project', 1, 'active', $4, $5, 'tester', $6, $6)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, `project-create-${PROJECT_ID}`, DIGEST, '2026-09-30T00:00:00Z'],
  )
  await admin.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, $6, $7, $8, 'tester', $9)`,
    [
      scopeRef.tenantId,
      scopeRef.spaceId,
      PROJECT_ID,
      projectRevisionRef(body).digest,
      JSON.stringify(body),
      CHANGE_REASON,
      `revision-${PROJECT_ID}`,
      DIGEST,
      '2026-09-30T00:00:00Z',
    ],
  )
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
}

async function jsonBody(response: Response): Promise<{ data: Record<string, unknown> }> {
  return await response.json() as { data: Record<string, unknown> }
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return (await jsonBody(response)).data
    if (response.status !== 202) {
      const causes = workerErrors.map((error) => error.stack ?? error.message).join('\n')
      throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}; causes=${causes}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the deadline`)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-compute-task-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)
  approvedInputRef = await archiveComputeInput()
  const body = revisionBody(scenario.definitionRef, approvedInputRef)
  projectRevisionRefValue = projectRevisionRef(body)
  await seedProject(body)

  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    onWorkerError(error) { if (error instanceof Error) workerErrors.push(error) },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
}, 240_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('registered-compute task run through the normal HTTP host (real PostgreSQL)', () => {
  it('runs the registered operation, projects its metrics and publishes a read-back answer-draft@3', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')

    const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (scenario === undefined) throw new Error('the transport scenario was not mounted')
    const computeBinding = coreScenarioTaskBindings(scenario).find((binding) => binding.kind === 'compute')
    if (computeBinding === undefined) throw new Error('the composition did not mount a compute task binding')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `compute-task-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'run the registered compute operation over the approved input',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: approvedInputRef,
          inputSnapshotDigest: approvedInputRef.digest,
          taskBindingRef: computeBinding.taskBindingRef,
          parameters: {},
        },
      }),
    })
    if (runResponse.status !== 202) throw new Error(`task run admission failed: ${await runResponse.text()}`)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('task run admission returned no run id')

    const answer = await waitForAnswer(runId)
    const v3Body = answer['v3Body'] as {
      schemaVersion: string
      resultManifestRef: ResourceRef
      executionBindingRef: ResourceRef
      blocks: unknown[]
    }
    expect(v3Body.schemaVersion).toBe('answer-draft@3')
    expect(v3Body.resultManifestRef.digest).toBe(
      (answer['v3Body'] as { resultManifestDigest: string }).resultManifestDigest,
    )
    expect(v3Body.blocks.length).toBeGreaterThan(0)
    const answerId = answer['answerId']
    if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')

    const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
    if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
    const resultBody = await jsonBody(result)
    expect(resultBody.data['answerId']).toBe(answerId)

    const exported = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`)
    if (exported.status !== 200) throw new Error(`verified export failed: ${await exported.text()}`)
    const exportedBody = await jsonBody(exported)
    const versions = exportedBody.data['versions'] as { answerId: string; contentHash: string }
    expect(versions.answerId).toBe(answerId)
    expect(versions.contentHash).toBe(answer['contentHash'])
  }, 180_000)

  it('refuses a compute task whose input snapshot is not the project approved input', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')
    const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (scenario === undefined) throw new Error('the transport scenario was not mounted')
    const computeBinding = coreScenarioTaskBindings(scenario).find((binding) => binding.kind === 'compute')
    if (computeBinding === undefined) throw new Error('the composition did not mount a compute task binding')

    const foreign: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
    const response = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `compute-task-bad-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'run the registered compute operation over an unapproved input',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: foreign,
          inputSnapshotDigest: foreign.digest,
          taskBindingRef: computeBinding.taskBindingRef,
          parameters: {},
        },
      }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('INPUT_SNAPSHOT_INVALID')
  }, 120_000)
})

