import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { LocalDocumentExtractionService, PostgresDocumentParseStore } from '@ontology/adapter-extraction-document'
import {
  coreScenarioTaskBindings,
  createCoreApi,
  createCoreLocalComposition,
  loadCoreExamples,
} from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type {
  DocumentParseRecord,
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
 * W07 real-database acceptance for a document-QA task run.
 *
 * The default `createCoreLocalComposition` host mounts a `document_qa` task binding. This builds
 * a real project document corpus (a parsed text document, a membership, a BM25 index) exactly as
 * the production routes do, then drives a task-mode `POST /runs`: the Template runtime prepares
 * the deterministic `document_search` plan scoped to the project's own collection, the Core
 * document-search handler resolves the exact span text, the typed writer emits a document
 * citation, and the publication gate publishes the verified @3 answer that is read back through
 * `/answers/{id}/result`.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `coredocqa_${randomUUID().replaceAll('-', '')}`
const SCENARIO_ID = 'transport-facility-inspection'
const PROJECT_ID = randomUUID()
const DIGEST = `sha256:${'a'.repeat(64)}`
const CHANGE_REASON = 'W07 document-QA task acceptance'
const DOCUMENT_TEXT = 'SERVICE MANUAL. The inspection interval for the pump is ninety days. The warranty covers five years of pump operation.'
const MATCHING_QUERY = 'inspection interval pump'

function mappingRef(): MappingRef {
  return {
    id: 'docqa-mapping',
    version: '1.0.0',
    digest: DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'docqa', sourceId: 'records' }, objectPath: 'records' },
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
    industryPackRef: { id: 'docqa-pack', version: '1.0.0', digest: DIGEST },
    definitionRef,
    mappingRefs: [mappingRef()],
    profileRef: { id: 'docqa-profile', version: '1.0.0', snapshotHash: DIGEST },
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

const APPROVED_INPUT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let projectRevisionRefValue: ProjectRevisionRef
let parsedDocument: DocumentParseRecord
const workerErrors: Error[] = []

function trustedContext(scope: ScopeRef): ToolContext {
  return createToolContext({
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'docqa-author',
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
      resourceKinds: ['artifact', 'document', 'chunk', 'dataset'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `docqa:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `docqa-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Document QA'])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  appUrl = `postgres://${encodeURIComponent('ontology_app')}:${encodeURIComponent(APP_PASSWORD)}@${new URL(container.adminUrl).hostname}:${new URL(container.adminUrl).port}/${new URL(container.adminUrl).pathname.replace(/^\//, '')}`
}

/** Publish and parse the corpus document through the real LOCAL-023 parser on the shared stores. */
async function parseCorpusDocument(): Promise<DocumentParseRecord> {
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  const parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
    const bytes = new TextEncoder().encode(DOCUMENT_TEXT)
    const staged = await blobStore.stage(bytes, { scopeRef }, trustedContext(scopeRef))
    const published = await blobStore.publish(
      {
        scopeRef,
        contentDigest: staged.contentDigest,
        mediaType: 'text/plain',
        byteSize: staged.byteSize,
        purpose: 'document',
      },
      trustedContext(scopeRef),
    )
    const parser = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore })
    return await parser.parse({ scopeRef, originalRef: published.blobRef }, trustedContext(scopeRef))
  } finally {
    await parseStore.close().catch(() => undefined)
    await registry.close().catch(() => undefined)
  }
}

async function seedProject(body: ProjectRevisionBody): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'W07 document QA project', 1, 'active', $4, $5, 'tester', $6, $6)`,
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
      const eventsResponse = await request(`/api/v1/runs/${encodeURIComponent(runId)}/events`)
      const events = eventsResponse.ok ? await eventsResponse.text() : `<events ${String(eventsResponse.status)}>`
      let verify = ''
      if (admin !== undefined) {
        try {
          const row = await admin.query<{ record: unknown }>(
            'SELECT record FROM agent_platform.workflow_verifications WHERE run_id = $1 ORDER BY verification_id DESC LIMIT 1',
            [runId],
          )
          verify = JSON.stringify(row.rows[0]?.record ?? null)
        } catch (error) {
          verify = `<verify query failed: ${String(error)}>`
        }
      }
      throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}; causes=${causes}; verify=${verify}; events=${events}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the deadline`)
}

/** Register the parsed document into the project corpus and build its BM25 index via the routes. */
async function mountCorpus(): Promise<void> {
  const membership = await request(`/api/v1/projects/${PROJECT_ID}/document-memberships`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `docqa-membership-${PROJECT_ID}` },
    body: JSON.stringify({
      documentRef: parsedDocument.originalRef,
      documentDigest: parsedDocument.originalRef.digest,
      parseId: parsedDocument.parseId,
      parseRef: parsedDocument.spanMapRef,
      textDigest: parsedDocument.spanMapRef.digest,
      precision: 'exact',
    }),
  })
  if (membership.status !== 201) throw new Error(`document membership failed: ${await membership.text()}`)
  const index = await request(`/api/v1/projects/${PROJECT_ID}/document-index`, {
    method: 'POST',
  })
  if (index.status !== 202) throw new Error(`document index build failed: ${await index.text()}`)
  const status = (await jsonBody(index)).data['status'] as { state?: string }
  expect(status.state).toBe('ready')
}

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-document-qa-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)
  parsedDocument = await parseCorpusDocument()
  const body = revisionBody(scenario.definitionRef, APPROVED_INPUT_REF)
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
  await mountCorpus()
}, 240_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

async function documentQaBindingRef(): Promise<{ id: string; version: string; digest: string }> {
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error('the transport scenario was not mounted')
  const binding = coreScenarioTaskBindings(scenario).find((entry) => entry.kind === 'document_qa')
  if (binding === undefined) throw new Error('the composition did not mount a document_qa task binding')
  return binding.taskBindingRef
}

describe('document-QA task run through the normal HTTP host (real PostgreSQL, real BM25 index)', () => {
  it('retrieves the project document, cites the exact span and publishes a read-back answer-draft@3', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `docqa-task-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'what does the manual say about the inspection interval',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: APPROVED_INPUT_REF,
          inputSnapshotDigest: APPROVED_INPUT_REF.digest,
          taskBindingRef: await documentQaBindingRef(),
          parameters: { query: MATCHING_QUERY, limit: 5 },
        },
      }),
    })
    if (runResponse.status !== 202) throw new Error(`task run admission failed: ${await runResponse.text()}`)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('task run admission returned no run id')

    const answer = await waitForAnswer(runId)
    const v3Body = answer['v3Body'] as { schemaVersion: string; assertions?: { kind: string; quote?: string }[] }
    expect(v3Body.schemaVersion).toBe('answer-draft@3')
    const citations = (v3Body.assertions ?? []).filter((entry) => entry.kind === 'document_quote')
    expect(citations.length).toBeGreaterThanOrEqual(1)
    expect(citations[0]?.quote).toContain('inspection interval')
    const answerId = answer['answerId']
    if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')

    const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
    if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
    const resultData = (await jsonBody(result)).data
    expect(resultData['answerId']).toBe(answerId)

    const exported = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`)
    if (exported.status !== 200) throw new Error(`verified export failed: ${await exported.text()}`)
    expect((await jsonBody(exported)).data['versions']).toBeDefined()
  }, 180_000)

  it('refuses to cite when the corpus has no matching evidence', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `docqa-task-miss-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'a term the corpus does not contain',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: APPROVED_INPUT_REF,
          inputSnapshotDigest: APPROVED_INPUT_REF.digest,
          taskBindingRef: await documentQaBindingRef(),
          parameters: { query: 'zzz-unfindable-token', limit: 5 },
        },
      }),
    })
    expect(runResponse.status).toBe(202)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('task run admission returned no run id')

    // The run either fails or publishes a limited result; in neither case may it fabricate a
    // document citation for a query that matched nothing.
    const endAt = Date.now() + 45_000
    let fabricated = false
    while (Date.now() < endAt) {
      const response = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer`)
      if (response.status === 200) {
        const answer = (await jsonBody(response)).data
        const v3Body = answer['v3Body'] as { assertions?: { kind: string }[] } | undefined
        fabricated = (v3Body?.assertions ?? []).some((entry) => entry.kind === 'document_quote')
        break
      }
      if (response.status !== 202) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(fabricated).toBe(false)
  }, 120_000)
})
