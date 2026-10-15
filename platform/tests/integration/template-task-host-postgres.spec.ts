import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import { CORE_TYPED_RESULT_SCHEMA_REF, createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type {
  MappingRef,
  ProjectRevisionBody,
  ProjectRevisionRef,
  PublishedTaskBinding,
  PublishedTaskBindingBody,
  ResourceRef,
  ScopeRef,
  VersionRef,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * V03-037 / #208 real-database acceptance for the Template task host.
 *
 * A run created through the *normal* HTTP surface with an optional `task` execution binding is
 * dispatched by the real `WorkflowController` (no manual controller start): the Template runtime
 * prepares the run-bound plan, executes the known step through the shared gateway/ledger, the
 * typed draft writer resolves the run's archived typed result manifest + finalization receipt and
 * emits an `answer-draft@3`, and the publication gate publishes the same verified version. The
 * clarification/fixed-fact chain is exercised by the sibling `core-template-plan-receipts` suite.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `taskhost_${randomUUID().replaceAll('-', '')}`
const DIGEST = `sha256:${'a'.repeat(64)}`
const PROJECT_ID = randomUUID()
const APPROVED_INPUT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const DOCUMENT_SET_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'document' }
const DEFINITION_REF: VersionRef = { id: 'taskhost-definition', version: '1.0.0', digest: DIGEST }
const PARAMETER_SCHEMA = { type: 'object' } as const
const PARAMETER_SCHEMA_DIGEST = sha256DigestOf(canonicalJson(PARAMETER_SCHEMA))
const PROJECT_TITLE = 'Template task host project'

function mappingRef(): MappingRef {
  return {
    id: 'taskhost-mapping',
    version: '1.0.0',
    digest: DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'taskhost', sourceId: 'records' }, objectPath: 'records' },
  }
}

function revisionBody(): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'taskhost-pack', version: '1.0.0', digest: DIGEST },
    definitionRef: DEFINITION_REF,
    mappingRefs: [mappingRef()],
    profileRef: { id: 'taskhost-profile', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: DOCUMENT_SET_REF,
    approvedInputRef: APPROVED_INPUT_REF,
    semanticPublicationRefs: [DEFINITION_REF],
    sourceVisibilityEpoch: '1',
    changeReason: 'template task host acceptance',
  }
}

function projectRevisionRef(): ProjectRevisionRef {
  return { projectId: PROJECT_ID, revision: '1', digest: sha256DigestOf(canonicalJson(revisionBody())) }
}

function taskBindingBody(): PublishedTaskBindingBody {
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingIdentity: { id: 'task.taskhost.inspection', version: '1.0.0' },
    actionDefinitionRef: DEFINITION_REF,
    kind: 'published_facts',
    parameterSchema: { ...PARAMETER_SCHEMA },
    parameterSchemaDigest: PARAMETER_SCHEMA_DIGEST,
    requiredCapabilities: [],
    requiredReadiness: [],
    resultSchemaRef: CORE_TYPED_RESULT_SCHEMA_REF,
  }
}

function taskBinding(): PublishedTaskBinding {
  const body = taskBindingBody()
  return {
    schemaVersion: body.schemaVersion,
    taskBindingRef: {
      id: body.taskBindingIdentity.id,
      version: body.taskBindingIdentity.version,
      digest: sha256DigestOf(canonicalJson(body)),
    },
    actionDefinitionRef: body.actionDefinitionRef,
    kind: body.kind,
    parameterSchema: body.parameterSchema,
    parameterSchemaDigest: body.parameterSchemaDigest,
    requiredCapabilities: [...body.requiredCapabilities],
    requiredReadiness: [...body.requiredReadiness],
    resultSchemaRef: body.resultSchemaRef,
  }
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
const workerErrors: Error[] = []

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `taskhost-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Template task host'])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = 'ontology_app'
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
}

async function seedProjectAndBinding(): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, 'active', $5, $6, 'tester', $7, $7)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, PROJECT_TITLE, `project-create-${PROJECT_ID}`, DIGEST, '2026-09-30T00:00:00Z'],
  )
  await admin.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, $6, $7, $8, 'tester', $9)`,
    [
      scopeRef.tenantId,
      scopeRef.spaceId,
      PROJECT_ID,
      projectRevisionRef().digest,
      JSON.stringify(revisionBody()),
      revisionBody().changeReason,
      `revision-${PROJECT_ID}`,
      DIGEST,
      '2026-09-30T00:00:00Z',
    ],
  )
  const binding = taskBinding()
  await admin.query(
    `INSERT INTO agent_platform.published_task_bindings
       (tenant_id, space_id, task_binding_id, version, digest, binding, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [scopeRef.tenantId, scopeRef.spaceId, binding.taskBindingRef.id, binding.taskBindingRef.version, binding.taskBindingRef.digest, JSON.stringify(binding), '2026-09-30T00:00:00Z'],
  )
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(20_000) })
}

async function jsonBody(response: Response): Promise<{ data: Record<string, unknown> }> {
  return await response.json() as { data: Record<string, unknown> }
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 30_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/jobs/${jobId}`)
    if (!response.ok) throw new Error(`GET job failed with ${String(response.status)}: ${await response.text()}`)
    const body = await jsonBody(response)
    if (body.data['stage'] === 'awaiting_review' || body.data['stage'] === 'failed') return body.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not reach review before the deadline`)
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return await response.json() as Record<string, unknown>
    if (response.status !== 202) {
      const run = await request(`/api/v1/runs/${runId}`).then((result) => result.text())
      const events = await request(`/api/v1/runs/${runId}/events`).then((result) => result.text())
      const causes = workerErrors.map((error) => error.stack ?? error.message).join('\n')
      throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}; run=${run}; events=${events}; causes=${causes}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the deadline`)
}

/** Publish one real source-backed facility fact so the fixed `facts:` task can answer. */
async function publishTransportFact(): Promise<void> {
  const transport = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
  if (transport === undefined) throw new Error('transport scenario was not mounted')
  const registry = transport.rawSources.find((entry) => entry.sourceRef.sourceId === 'registry-a')
  if (registry === undefined) throw new Error('transport registry source was not mounted')
  const imported = await request('/api/v1/core/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'taskhost-import-registry-a' },
    body: JSON.stringify({ scenarioId: transport.scenarioId, sourceId: registry.sourceRef.sourceId, content: await readFile(registry.path, 'utf8') }),
  })
  expect(imported.status).toBe(202)
  const importBody = await jsonBody(imported)
  const jobId = importBody.data['jobId']
  if (typeof jobId !== 'string') throw new Error('import did not return a job id')
  expect((await waitForJob(jobId))['stage']).toBe('awaiting_review')

  const list = await request(`/api/v1/candidates?jobId=${encodeURIComponent(jobId)}&kind=entity`)
  const candidates = (await jsonBody(list)).data['candidates'] as { candidateId: string }[]
  let targetId: string | undefined
  for (const summary of candidates) {
    const detail = (await jsonBody(await request(`/api/v1/candidates/${summary.candidateId}`))).data['candidate'] as { nativeId?: string }
    if (detail.nativeId === 'T-04') targetId = summary.candidateId
  }
  if (targetId === undefined) throw new Error('native T-04 candidate was not produced')

  const pending = (await jsonBody(await request(`/api/v1/candidates/${targetId}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '0' },
    body: JSON.stringify({ kind: 'create_pending', justification: 'operator reviewed the synthetic native identifier' }),
  }))).data['targetEntityId']
  if (typeof pending !== 'string') throw new Error('identity create_pending returned no entity')
  expect((await request(`/api/v1/candidates/${targetId}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '1' },
    body: JSON.stringify({ kind: 'match', targetEntityId: pending, strongIdentity: { kind: 'native_id', value: 'T-04' } }),
  })).status).toBe(200)
  expect((await request(`/api/v1/candidates/${targetId}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '0' },
    body: JSON.stringify({ decision: 'approve', reason: 'source-backed synthetic record reviewed by operator' }),
  })).status).toBe(200)
  const publication = await request('/api/v1/semantic-publications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '0', 'idempotency-key': 'taskhost-publish-t04' },
    body: JSON.stringify({ approvedCandidateRefs: [{ candidateId: targetId, kind: 'entity' }], schemaRef: transport.definitionRef }),
  })
  if (publication.status !== 201) throw new Error(`semantic publication failed: ${await publication.text()}`)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  await seedProjectAndBinding()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-template-task-host-'))
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

describe('a task-bound Template run through the normal HTTP host (real PostgreSQL)', () => {
  it('publishes an answer-draft@3 pinned to the archived typed result manifest and finalization receipt', async () => {
    await publishTransportFact()

    const deployment = (await jsonBody(await request('/api/v1/core/deployment'))).data['scenarios'] as {
      scenarioId: string
      profileRef: { id: string; version: string }
    }[]
    const scenario = deployment.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    if (scenario === undefined) throw new Error('the transport scenario was not exposed')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'taskhost-task-facts-inspection' },
      body: JSON.stringify({
        profileRef: scenario.profileRef,
        question: 'facts:inspection_due',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRef(),
          inputSnapshotRef: APPROVED_INPUT_REF,
          inputSnapshotDigest: APPROVED_INPUT_REF.digest,
          taskBindingRef: taskBinding().taskBindingRef,
          parameters: {},
        },
      }),
    })
    if (runResponse.status !== 202) throw new Error(`task run admission failed: ${await runResponse.text()}`)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('task run admission returned no run id')

    const answer = (await waitForAnswer(runId)).data as {
      contentHash?: string
      v3Body?: {
        schemaVersion: string
        resultManifestRef: ResourceRef
        resultManifestDigest: string
        finalizationReceiptRef: ResourceRef
        finalizationReceiptDigest: string
        executionBindingRef: ResourceRef
        blocks: unknown[]
      }
      body?: unknown
    }
    expect(answer.v3Body?.schemaVersion).toBe('answer-draft@3')
    expect(answer.body).toBeUndefined()
    expect(answer.v3Body?.resultManifestRef.digest).toBe(answer.v3Body?.resultManifestDigest)
    expect(answer.v3Body?.finalizationReceiptRef.digest).toBe(answer.v3Body?.finalizationReceiptDigest)
    expect(answer.v3Body?.executionBindingRef.kind).toBe('plan')
    expect((answer.v3Body?.blocks ?? []).length).toBeGreaterThan(0)

    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const receipts = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.task_finalization_receipts
        WHERE tenant_id = $1 AND space_id = $2 AND receipt_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, answer.v3Body?.finalizationReceiptRef.id ?? ''],
    )
    expect(receipts.rows[0]?.count).toBe('1')

    // Same verified version only: the read-back answer is byte-identical and the evidence resolves.
    const reread = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer`)
    expect(reread.status).toBe(200)
    expect(JSON.stringify((await jsonBody(reread)).data)).toBe(JSON.stringify(answer))
  }, 180_000)
})
