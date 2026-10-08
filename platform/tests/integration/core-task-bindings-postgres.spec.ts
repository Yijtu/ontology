import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import { projectSnapshotMappingRef } from '@ontology/semantic-engine'
import type { DataQueryOutput } from '@ontology/contracts'
import { projectQueryPublicationFixture } from './project-query-publication-fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresRunExecutionBindingStore,
  PostgresPublishedTaskBindingStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  CORE_TYPED_RESULT_SCHEMA_REF,
  coreScenarioTaskBindings,
  createCoreApi,
  createCoreProjectQueryWorkflow,
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
 * W06 real-database acceptance for the mounted Core task bindings.
 *
 * The default `createCoreLocalComposition` host mounts runnable task bindings per scenario. This
 * drives the structured-query task through the *normal* HTTP surface: a task-mode `POST /runs`
 * selects the mounted `structured_query` binding, the Template runtime prepares its deterministic
 * semantic plan, the shared gateway compiles and runs it against the project's official published
 * fact snapshot, the typed writer emits an `answer-draft@3`, the publication gate publishes the same
 * verified version, and the answer is read back through `/answers/{id}/result`, the revision
 * history and the verified JSON export. Nothing about the plan, evidence or answer is pre-seeded.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `taskbind_${randomUUID().replaceAll('-', '')}`
const DIGEST = `sha256:${'a'.repeat(64)}`
const SCENARIO_ID = 'transport-facility-inspection'
const PROJECT_ID = randomUUID()
const DOCUMENT_SET_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'document' }
const APPROVED_INPUT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const CHANGE_REASON = 'W06 mounted task binding acceptance'
const OBJECT_ID = 'transport_facility'
const FIELDS = ['facility_id', 'inspection_due'] as const

function mappingRef(): MappingRef {
  return {
    id: 'taskbind-mapping',
    version: '1.0.0',
    digest: DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'taskbind', sourceId: 'records' }, objectPath: 'records' },
  }
}

function revisionBody(definitionRef: { id: string; version: string; digest: string }): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'taskbind-pack', version: '1.0.0', digest: DIGEST },
    definitionRef,
    mappingRefs: [mappingRef(), { ...definitionRef, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'taskbind', sourceId: 'identity' }, objectPath: 'identity_index' } }],
    profileRef: { id: 'taskbind-profile', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: DOCUMENT_SET_REF,
    approvedInputRef: APPROVED_INPUT_REF,
    semanticPublicationRefs: [definitionRef],
    sourceVisibilityEpoch: '1',
    changeReason: CHANGE_REASON,
  }
}

function projectRevisionRef(body: ProjectRevisionBody): ProjectRevisionRef {
  return { projectId: PROJECT_ID, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let businessUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
const workerErrors: Error[] = []

function trustedContext(scope: ScopeRef): ToolContext {
  return createToolContext({
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'taskbind-author',
      roles: ['platform-admin', 'operator', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'],
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
      resourceKinds: ['artifact', 'document', 'dataset'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `taskbind:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `taskbind-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Task binding'])
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
  await admin.query('CREATE DATABASE project_query_business')
  const businessDatabase = new URL(container.adminUrl)
  businessDatabase.pathname = '/project_query_business'
  businessUrl = businessDatabase.toString()

}

async function seedProject(body: ProjectRevisionBody): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'W06 task binding project', 1, 'active', $4, $5, 'tester', $6, $6)`,
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

let structuredBinding: { taskBindingRef: { id: string; version: string; digest: string } }
let projectRevisionRefValue: ProjectRevisionRef
let publishedFixture: ReturnType<typeof projectQueryPublicationFixture>
let queryDatabase: ControlPostgresDatabase
let queryRegistry: PostgresArtifactRegistry
let structuredStore: PostgresStructuredIngestionStore
let originalAnswer: Record<string, unknown>
let originalRunId = ''
let initialSource: Awaited<ReturnType<ReturnType<typeof projectQueryPublicationFixture>['importCsv']>>

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-task-bindings-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)

  // Every required task kind is mounted for the scenario, and the compute one pins the neutral
  // registered example operation.
  const mounted = coreScenarioTaskBindings(scenario)
  const kinds = mounted.map((binding) => binding.kind)
  for (const kind of ['published_facts', 'structured_query', 'document_qa', 'rule_judgement', 'compute']) {
    expect(kinds).toContain(kind)
  }
  const structured = mounted.find((binding) => binding.kind === 'structured_query')
  if (structured === undefined) throw new Error('the composition did not mount a structured_query task binding')
  expect(structured.resultSchemaRef).toEqual(CORE_TYPED_RESULT_SCHEMA_REF)
  structuredBinding = { taskBindingRef: structured.taskBindingRef }
  const compute = mounted.find((binding) => binding.kind === 'compute')
  expect(compute?.operationRef?.id).toBe('example.compute.aggregate')

  const body = revisionBody(scenario.definitionRef)
  projectRevisionRefValue = projectRevisionRef(body)
  await seedProject(body)

  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    projectDataset: { connectionString: businessUrl, schema: 'business_dataset' },
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    onWorkerError(error) { if (error instanceof Error) workerErrors.push(error) },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
  queryDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  queryRegistry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 2 })
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: appUrl, maxPoolSize: 2 })
  const objects = new FileSystemObjectStore(objectDirectory)
  await objects.init()
  const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry: queryRegistry })
  publishedFixture = projectQueryPublicationFixture({ db: queryDatabase, blobs, structured: structuredStore, scope: scopeRef, ctx: trustedContext(scopeRef), projectId: PROJECT_ID,
    definition: { ...scenario.definitionDraft, ref: scenario.definitionRef, publishedAt: new Date().toISOString() } })
  const source = await publishedFixture.importCsv(OBJECT_ID, 'code,network,district,due\nP-101,private-network,north,true\nP-102,private-network,south,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
  const district = await publishedFixture.importCsv('transport_district', 'code,network,name\nnorth,private-network,North\n', ['district_code', 'district_network_code', 'district_name'])
  initialSource = await publishedFixture.restage(source)
  await publishedFixture.approveAndPublish(initialSource)
  await publishedFixture.approveAndPublish(district)
  const projected = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
  if (projected.status !== 201) throw new Error(`official dataset creation failed: ${await projected.text()}`)
  projectRevisionRefValue = ((await jsonBody(projected)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef

}, 240_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await structuredStore?.close()
  await queryRegistry?.close()
  await queryDatabase?.close()
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('mounted Core structured-query task binding through the normal HTTP host (real PostgreSQL)', () => {
  it('runs the deterministic semantic plan and publishes a read-back answer-draft@3', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `taskbind-structured-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'structured query over the materialised snapshot',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: APPROVED_INPUT_REF,
          inputSnapshotDigest: APPROVED_INPUT_REF.digest,
          taskBindingRef: structuredBinding.taskBindingRef,
          parameters: { objectId: OBJECT_ID, fields: [...FIELDS], limit: 10 },
        },
      }),
    })
    if (runResponse.status !== 202) throw new Error(`task run admission failed: ${await runResponse.text()}`)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('task run admission returned no run id')

    const answer = await waitForAnswer(runId)
    originalAnswer = answer
    originalRunId = runId
    const assertions = (answer['v3Body'] as { assertions: { subject: string; predicate: string; value: unknown }[] }).assertions
    expect(assertions.filter((assertion) => assertion.predicate === 'inspection_due').map((assertion) => [assertion.subject, assertion.value]).sort()).toEqual([['P-101', true], ['P-102', false]])
    const v3Body = answer['v3Body'] as {
      schemaVersion: string
      resultManifestRef: ResourceRef
      resultManifestDigest: string
      finalizationReceiptRef: ResourceRef
      finalizationReceiptDigest: string
      executionBindingRef: ResourceRef
      blocks: unknown[]
    }
    expect(v3Body.schemaVersion).toBe('answer-draft@3')
    const controlTables = await admin?.query<{ count: string }>("SELECT count(*)::text FROM information_schema.tables WHERE table_name IN ('project_dataset_snapshots','project_dataset_rows')")
    expect(controlTables?.rows[0]?.count).toBe('0')
    expect(v3Body.resultManifestRef.digest).toBe(v3Body.resultManifestDigest)
    expect(v3Body.finalizationReceiptRef.digest).toBe(v3Body.finalizationReceiptDigest)
    expect(v3Body.executionBindingRef.kind).toBe('plan')
    expect(v3Body.blocks.length).toBeGreaterThan(0)
    const answerId = answer['answerId']
    if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')

    const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
    if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
    expect((await jsonBody(result)).data['answerId']).toBe(answerId)

    const history = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/history`)
    if (history.status !== 200) throw new Error(`result history failed: ${await history.text()}`)
    const historyBody = await jsonBody(history)
    expect(historyBody.data['currentAnswerId']).toBe(answerId)
    expect((historyBody.data['entries'] as unknown[]).length).toBeGreaterThanOrEqual(1)

    const exported = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`)
    if (exported.status !== 200) throw new Error(`verified export failed: ${await exported.text()}`)
    const exportedBody = await jsonBody(exported)
    const versions = exportedBody.data['versions'] as { answerId: string; contentHash: string }
    expect(versions.answerId).toBe(answerId)
    expect(versions.contentHash).toBe(answer['contentHash'])
  }, 180_000)

  it('imports a structured source for a project and previews column mapping on the real parse', async () => {
    const content = JSON.stringify([
      { facility_id: 'T-01', inspection_due: true },
      { facility_id: 'T-02', inspection_due: false },
    ])
    const imported = await request(`/api/v1/projects/${PROJECT_ID}/structured-imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `taskbind-import-${PROJECT_ID}` },
      body: JSON.stringify({ format: 'json', mediaType: 'application/json', content }),
    })
    if (imported.status !== 201) throw new Error(`structured import failed: ${await imported.text()}`)
    const importBody = await jsonBody(imported)
    const parseId = importBody.data['parseId']
    const originalRef = importBody.data['originalRef']
    if (typeof parseId !== 'string' || typeof originalRef !== 'object' || originalRef === null) {
      throw new Error('the structured import returned no parseId/originalRef')
    }
    expect(importBody.data['format']).toBe('json')
    const counts = importBody.data['counts'] as { total: number; succeeded: number }
    expect(counts.total).toBeGreaterThanOrEqual(2)

    const headerDigest = (header: string): string => sha256DigestOf(header)
    const preview = await request(`/api/v1/projects/${PROJECT_ID}/mappings/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'json',
        parseId,
        originalRef,
        originalMediaType: 'application/json',
        options: {},
        objectId: OBJECT_ID,
        entries: [
          { fieldRef: 'facility_id', header: 'facility_id', headerDigest: headerDigest('facility_id'), columnIndex: 0 },
          { fieldRef: 'inspection_due', header: 'inspection_due', headerDigest: headerDigest('inspection_due'), columnIndex: 1 },
        ],
      }),
    })
    if (preview.status !== 200) throw new Error(`mapping preview failed: ${await preview.text()}`)
    expect((await jsonBody(preview)).data['preview']).toBeDefined()
  }, 120_000)
  it('keeps authorized P1 history across another object and retraction rebuilds in the SAME project revision and restart', async () => {
    const ctx = trustedContext(scopeRef)
    const executions = new PostgresRunExecutionBindingStore(queryDatabase)
    const archived = await executions.getBindingByRun(scopeRef, originalRunId, ctx)
    const originalRef = archived?.binding.projectDatasetSnapshotRef
    if (archived === undefined || originalRef === undefined) throw new Error('the original execution is missing')
    const district = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: 'transport_district' }) })
    if (district.status !== 201) throw new Error(`same-revision district projection failed: ${await district.text()}`)
    expect(((await jsonBody(district)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef).toEqual(projectRevisionRefValue)
    await api?.close(); await composition?.close()
    composition = await createCoreLocalComposition({ databaseUrl: appUrl, projectDataset: { connectionString: businessUrl, schema: 'business_dataset' }, objectDirectory, scopeRef, examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: true })
    api = createCoreApi(composition.dependencies)
    baseUrl = (await api.listen({ host: '127.0.0.1', port: 0 })).replace(/\/$/u, '')
    const backend = new PostgresProjectDatasetAdapter({ connectionString: businessUrl, schema: 'business_dataset' })
    const oldCtx = createToolContext({ ...ctx, runId: originalRunId, allowedResources: { ...ctx.allowedResources, sourceRefs: [{ namespace: 'project-dataset', sourceId: originalRef.id }] } })
    const workflow = createCoreProjectQueryWorkflow({ query: backend, publishedSource: publishedFixture.publishedSource, projects: publishedFixture.projects, readiness: publishedFixture.readiness,
      executionBindings: executions, taskBindings: new PostgresPublishedTaskBindingStore(queryDatabase), definition: async () => publishedFixture.definition })
    const replay = async () => {
      const descriptor = await workflow.resolveExecution(archived.binding, OBJECT_ID, oldCtx)
      const outcome = await workflow.handler({ toolId: 'data_query', execute: async () => { throw new Error('historical startup fallback') } }).execute({ callId: randomUUID(), toolId: 'data_query', ctx: oldCtx,
        deadline: oldCtx.deadline, traceId: oldCtx.traceId, signal: new AbortController().signal, resultLimits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 30_000 },
        arguments: { kind: 'query', mode: 'semantic', queryPlan: { mode: 'semantic', concepts: [OBJECT_ID], fields: [...FIELDS, 'record_id', 'sources_json'], links: [], filters: [], orderBy: [{ fieldRef: 'record_id', direction: 'asc' }], limit: 10, mappingVersion: projectSnapshotMappingRef({ descriptor }) } } })
      expect((outcome.payload as DataQueryOutput).table?.rows.map((row) => [row[0], row[1]]).sort()).toEqual([['P-101', true], ['P-102', false]])
    }
    try {
      await replay()
      const revision = await publishedFixture.projects.getRevision(scopeRef, PROJECT_ID, projectRevisionRefValue.revision, ctx)
      if (revision === undefined) throw new Error('the original revision disappeared')
      await expect(workflow.resolveForCreation(scopeRef, revision, { objectId: OBJECT_ID }, ctx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
      const withdrawn = initialSource.entities.find((candidate) => candidate.attributes.some((attribute) => attribute.attributeId === 'facility_id' && attribute.value === 'P-101'))
      if (withdrawn === undefined) throw new Error('missing original P-101 source')
      await publishedFixture.workflow.publication.reviseStatement({ statementId: withdrawn.candidateId, kind: 'retraction', expectedRevision: '1', idempotencyKey: `same-revision-withdraw-${PROJECT_ID}`, reason: 'human withdrew one official support' }, ctx)
      const rebuilt = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
      if (rebuilt.status !== 201) throw new Error(`same-revision retraction rebuild failed: ${await rebuilt.text()}`)
      const next = (await jsonBody(rebuilt)).data['status'] as { projectRevisionRef: ProjectRevisionRef; snapshotRef: ResourceRef }
      expect(next.projectRevisionRef).toEqual(projectRevisionRefValue)
      expect(next.snapshotRef).not.toEqual(originalRef)
      expect(await workflow.resolveForCreation(scopeRef, revision, { objectId: OBJECT_ID }, ctx)).toEqual(next.snapshotRef)
      const deployment = await jsonBody(await request('/api/v1/core/deployment'))
      const profileRef = (deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]).find((scenario) => scenario.scenarioId === SCENARIO_ID)?.profileRef
      const admitted = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `same-revision-current-${PROJECT_ID}` }, body: JSON.stringify({
        profileRef, question: 'query the current same-revision published snapshot', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false },
        task: { mode: 'task', projectRevisionRef: projectRevisionRefValue, inputSnapshotRef: APPROVED_INPUT_REF, inputSnapshotDigest: APPROVED_INPUT_REF.digest, taskBindingRef: structuredBinding.taskBindingRef, parameters: { objectId: OBJECT_ID, fields: [...FIELDS], limit: 10 } },
      }) })
      if (admitted.status !== 202) throw new Error(`same-revision current admission failed: ${await admitted.text()}`)
      const newRunId = (await jsonBody(admitted)).data['runId']
      if (typeof newRunId !== 'string') throw new Error('the new same-revision run is missing')
      expect((await executions.getBindingByRun(scopeRef, newRunId, ctx))?.binding.projectDatasetSnapshotRef).toEqual(next.snapshotRef)
      const currentAnswer = await waitForAnswer(newRunId)
      const assertions = (currentAnswer['v3Body'] as { assertions: { subject: string; predicate: string; value: unknown }[] }).assertions
      expect(assertions.filter((assertion) => assertion.predicate === 'inspection_due').map((assertion) => [assertion.subject, assertion.value])).toEqual([['P-102', false]])

      await replay()
      const historical = await jsonBody(await request(`/api/v1/runs/${originalRunId}/answer`))
      expect(historical.data['v3Body']).toEqual(originalAnswer['v3Body'])
    } finally { await backend.close() }
  }, 180_000)

  it('changes the normal task result for new published input while the old run keeps its fixed history after restart', async () => {
    const source = await publishedFixture.importCsv(OBJECT_ID, 'code,network,district,due\nP-103,private-network,north,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
    await publishedFixture.approveAndPublish(source)
    const projected = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
    if (projected.status !== 201) throw new Error(`new official dataset creation failed: ${await projected.text()}`)
    const currentRevision = ((await jsonBody(projected)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const profile = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)?.profileRef
    const response = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `taskbind-new-${PROJECT_ID}` }, body: JSON.stringify({
      profileRef: profile, question: 'query the new published input', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false },
      task: { mode: 'task', projectRevisionRef: currentRevision, inputSnapshotRef: APPROVED_INPUT_REF, inputSnapshotDigest: APPROVED_INPUT_REF.digest,
        taskBindingRef: structuredBinding.taskBindingRef, parameters: { objectId: OBJECT_ID, fields: [...FIELDS], limit: 10 } },
    }) })
    if (response.status !== 202) throw new Error(`new query run admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing new run')
    const answer = await waitForAnswer(runId)
    const assertions = (answer['v3Body'] as { assertions: { subject: string; predicate: string; value: unknown }[] }).assertions
    expect(assertions.filter((assertion) => assertion.predicate === 'inspection_due').map((assertion) => [assertion.subject, assertion.value])).toEqual([['P-103', false]])
    await api?.close()
    await composition?.close()
    composition = await createCoreLocalComposition({ databaseUrl: appUrl, projectDataset: { connectionString: businessUrl, schema: 'business_dataset' }, objectDirectory, scopeRef, examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: true })
    api = createCoreApi(composition.dependencies)
    baseUrl = (await api.listen({ host: '127.0.0.1', port: 0 })).replace(/\/$/u, '')
    const historical = await jsonBody(await request(`/api/v1/runs/${originalRunId}/answer`))
    expect(historical.data['contentHash']).toBe(originalAnswer['contentHash'])
    expect(historical.data['v3Body']).toEqual(originalAnswer['v3Body'])
    // Resume the old tool from its actual archived binding. Its ready historical descriptor
    // must survive the new head and backend restart without resolving the current snapshot.
    const executions = new PostgresRunExecutionBindingStore(queryDatabase)
    const oldBinding = await executions.getBindingByRun(scopeRef, originalRunId, trustedContext(scopeRef))
    const oldRef = oldBinding?.binding.projectDatasetSnapshotRef
    if (oldBinding === undefined || oldRef === undefined) throw new Error('the original query snapshot was not archived')
    const oldCtx = createToolContext({ ...trustedContext(scopeRef), runId: originalRunId, allowedResources: { ...trustedContext(scopeRef).allowedResources, sourceRefs: [{ namespace: 'project-dataset', sourceId: oldRef.id }] } })
    const backend = new PostgresProjectDatasetAdapter({ connectionString: businessUrl, schema: 'business_dataset' })
    try {
      const workflow = createCoreProjectQueryWorkflow({ query: backend, publishedSource: publishedFixture.publishedSource,
        projects: publishedFixture.projects, readiness: publishedFixture.readiness, executionBindings: executions,
        taskBindings: new PostgresPublishedTaskBindingStore(queryDatabase), definition: async () => publishedFixture.definition })
      const descriptor = await workflow.resolveExecution(oldBinding.binding, OBJECT_ID, oldCtx)
      expect(descriptor.snapshotRef).toEqual(oldRef)
      const outcome = await workflow.handler({ toolId: 'data_query', execute: async () => { throw new Error('the old project query attempted startup fallback') } }).execute({
        callId: randomUUID(), toolId: 'data_query', ctx: oldCtx, deadline: oldCtx.deadline, traceId: oldCtx.traceId,
        signal: new AbortController().signal, resultLimits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 30_000 },
        arguments: { kind: 'query', mode: 'semantic', queryPlan: { mode: 'semantic', concepts: [OBJECT_ID], fields: [...FIELDS, 'record_id', 'sources_json'],
          links: [], filters: [], orderBy: [{ fieldRef: 'record_id', direction: 'asc' }], limit: 10, mappingVersion: projectSnapshotMappingRef({ descriptor }) } },
      })
      expect((outcome.payload as DataQueryOutput).table?.rows.map((row) => [row[0], row[1]]).sort()).toEqual([['P-101', true], ['P-102', false]])
      expect((outcome.payload as DataQueryOutput).table?.rows.every((row) => String(row[3]).includes(projectRevisionRefValue.digest))).toBe(true)
      await expect(workflow.resolveForCreation(scopeRef, (await publishedFixture.projects.getRevision(scopeRef, PROJECT_ID, projectRevisionRefValue.revision, oldCtx))!, { objectId: OBJECT_ID }, oldCtx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
    } finally { await backend.close() }

  }, 180_000)

})
