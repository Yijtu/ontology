import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { LocalDocumentExtractionService, PostgresDocumentParseStore } from '@ontology/adapter-extraction-document'
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
  DocumentParseRecord,
  MappingRef,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

/**
 * W07 task-type browser/host E2E for the two types this node closed end-to-end.
 *
 * It runs the *real* full stack (throwaway PostgreSQL, the real `createCoreLocalComposition`
 * host with the real durable worker/controller, the real BM25 index, the real built web app
 * served by the loopback static host and a real Chromium page) and drives:
 *  - a registered-compute run whose `computation.metrics` project into typed claims, and
 *  - a document-QA run that cites an exact archived span.
 * Each produces a verified `answer-draft@3` read back through `/answers/{id}/result`, the
 * revision history and the verified JSON export. The rule-conclusion and project-snapshot
 * structured-query types remain open; a counterexample pins the rule admission refusal so a
 * regression cannot silently claim them.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `tasktypes_${randomUUID().replaceAll('-', '')}`
const SCENARIO_ID = 'transport-facility-inspection'
const PROJECT_ID = randomUUID()
const DIGEST = `sha256:${'a'.repeat(64)}`
const CHANGE_REASON = 'W07 task-type E2E'
const DOCUMENT_TEXT = 'SERVICE MANUAL. The inspection interval for the pump is ninety days. The warranty covers five years of pump operation.'
const MATCHING_QUERY = 'inspection interval pump'
const COMPUTE_INPUT = { rows: [{ id: 'R-1', amount: '10', unit: 'each' }, { id: 'R-2', amount: '2.5', unit: 'each' }, { id: 'R-3', amount: '1.25', currency: 'CNY' }] }

function mappingRef(): MappingRef {
  return {
    id: 'tasktypes-mapping',
    version: '1.0.0',
    digest: DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'tasktypes', sourceId: 'records' }, objectPath: 'records' },
  }
}

function revisionBody(definitionRef: { id: string; version: string; digest: string }, approvedInputRef: ResourceRef): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'tasktypes-pack', version: '1.0.0', digest: DIGEST },
    definitionRef,
    mappingRefs: [mappingRef()],
    profileRef: { id: 'tasktypes-profile', version: '1.0.0', snapshotHash: DIGEST },
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

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let web: WebHost
let browser: Browser
let approvedInputRef: ResourceRef
let projectRevisionRefValue: ProjectRevisionRef
let parsedDocument: DocumentParseRecord
let cachedApprovedInput: ResourceRef | undefined
const workerErrors: Error[] = []

function trustedContext(scope: ScopeRef): ToolContext {
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: 'tasktypes-author', roles: ['platform-admin', 'operator', 'data-editor'], scopes: [], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: '2026-09-30T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    allowedResources: { tenantId: scope.tenantId, spaceId: scope.spaceId, resourceKinds: ['artifact', 'document', 'chunk', 'dataset', 'computation'], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 1_000 },
    traceId: `tasktypes:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `tasktypes-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Task types'])
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const base = new URL(container.adminUrl)
  appUrl = `${base.protocol}//${encodeURIComponent('ontology_app')}:${encodeURIComponent(APP_PASSWORD)}@${base.hostname}:${base.port}/${base.pathname.replace(/^\//, '')}`
}

async function archiveComputeInput(): Promise<ResourceRef> {
  if (cachedApprovedInput !== undefined) return cachedApprovedInput
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const writer = createBlobArtifactWriter(new LocalImmutableBlobStore({ objectStore, registry }))
    const stored = await writer.putBytes({ scopeRef, content: new TextEncoder().encode(canonicalJson(COMPUTE_INPUT)), mediaType: 'application/json' }, trustedContext(scopeRef))
    cachedApprovedInput = stored.blobRef
    return stored.blobRef
  } finally {
    await registry.close().catch(() => undefined)
  }
}

async function parseCorpusDocument(): Promise<DocumentParseRecord> {
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  const parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
    const bytes = new TextEncoder().encode(DOCUMENT_TEXT)
    const staged = await blobStore.stage(bytes, { scopeRef }, trustedContext(scopeRef))
    const published = await blobStore.publish({ scopeRef, contentDigest: staged.contentDigest, mediaType: 'text/plain', byteSize: staged.byteSize, purpose: 'document' }, trustedContext(scopeRef))
    return await new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore }).parse({ scopeRef, originalRef: published.blobRef }, trustedContext(scopeRef))
  } finally {
    await parseStore.close().catch(() => undefined)
    await registry.close().catch(() => undefined)
  }
}

async function seedProject(body: ProjectRevisionBody): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query(
    `INSERT INTO agent_platform.projects (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'W07 task-type project', 1, 'active', $4, $5, 'tester', $6, $6)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, `project-create-${PROJECT_ID}`, DIGEST, '2026-09-30T00:00:00Z'],
  )
  await admin.query(
    `INSERT INTO agent_platform.project_revisions (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, $6, $7, $8, 'tester', $9)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, projectRevisionRef(body).digest, JSON.stringify(body), CHANGE_REASON, `revision-${PROJECT_ID}`, DIGEST, '2026-09-30T00:00:00Z'],
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

async function taskBindingRef(kind: string): Promise<{ id: string; version: string; digest: string }> {
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error('the transport scenario was not mounted')
  const binding = coreScenarioTaskBindings(scenario).find((entry) => entry.kind === kind)
  if (binding === undefined) throw new Error(`the composition did not mount a ${kind} task binding`)
  return binding.taskBindingRef
}

async function submitTask(input: { kind: string; parameters: Record<string, unknown>; idempotencyKey: string }): Promise<Response> {
  const deployment = await jsonBody(await request('/api/v1/core/deployment'))
  const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
  const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')
  return request('/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      profileRef: mountedScenario.profileRef,
      question: 'host task run',
      context: { timeZone: 'UTC' },
      preferences: { route: 'template', allowWeb: false },
      task: {
        mode: 'task',
        projectRevisionRef: projectRevisionRefValue,
        inputSnapshotRef: approvedInputRef,
        inputSnapshotDigest: approvedInputRef.digest,
        taskBindingRef: await taskBindingRef(input.kind),
        parameters: input.parameters,
      },
    }),
  })
}

async function readBack(runId: string, answer: Record<string, unknown>): Promise<void> {
  const answerId = answer['answerId']
  if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')
  const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
  if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
  expect((await jsonBody(result)).data['answerId']).toBe(answerId)

  const history = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/history`)
  if (history.status !== 200) throw new Error(`result history failed: ${await history.text()}`)
  expect((await jsonBody(history)).data['currentAnswerId']).toBe(answerId)

  const exported = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`)
  if (exported.status !== 200) throw new Error(`verified export failed: ${await exported.text()}`)
  const versions = (await jsonBody(exported)).data['versions'] as { answerId: string; contentHash: string }
  expect(versions.answerId).toBe(answerId)
  expect(versions.contentHash).toBe(answer['contentHash'])
}

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-task-types-e2e-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)
  approvedInputRef = await archiveComputeInput()
  parsedDocument = await parseCorpusDocument()
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
  web = await startWebHost(baseUrl, { bindDefaultProfile: false })
  browser = await chromium.launch({ headless: true })

  const membership = await request(`/api/v1/projects/${PROJECT_ID}/document-memberships`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `tasktypes-membership-${PROJECT_ID}` },
    body: JSON.stringify({ documentRef: parsedDocument.originalRef, documentDigest: parsedDocument.originalRef.digest, parseId: parsedDocument.parseId, parseRef: parsedDocument.spanMapRef, textDigest: parsedDocument.spanMapRef.digest, precision: 'exact' }),
  })
  if (membership.status !== 201) throw new Error(`document membership failed: ${await membership.text()}`)
  const index = await request(`/api/v1/projects/${PROJECT_ID}/document-index`, { method: 'POST' })
  if (index.status !== 202) throw new Error(`document index build failed: ${await index.text()}`)
}, 300_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('W07 task-type browser/host E2E (real chromium, real host)', () => {
  it('[browser] loads the real deployment picker from the same host the task runs drive', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    try {
      await page.goto(`${web.origin}/?view=jobs`)
      await page.waitForSelector('[data-testid="core-deployment-picker"]')
      expect(await page.textContent('[data-testid="core-deployment-mode"]')).toContain('本地操作员')
      await capture(page, 'v03-w07-deployment-picker')
      await record('v03-w07-deployment-picker', ['mode=operator', 'served_by=loopback-static-host'])
    } finally {
      await context.close()
    }
  }, 120_000)

  it('[host-http] runs a registered-compute task and reads a verified answer@3 back', async () => {
    const response = await submitTask({ kind: 'compute', parameters: {}, idempotencyKey: `tasktypes-compute-${PROJECT_ID}` })
    if (response.status !== 202) throw new Error(`compute task admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('compute admission returned no run id')
    const answer = await waitForAnswer(runId)
    const v3 = answer['v3Body'] as { schemaVersion: string; claims?: { predicate: string; value: { value: string | number; unit: string } }[] }
    expect(v3.schemaVersion).toBe('answer-draft@3')
    expect(v3.claims).toContainEqual(expect.objectContaining({ predicate: 'total_quantity', value: { value: '12.5', unit: 'each' } }))
    expect(v3.claims).toContainEqual(expect.objectContaining({ predicate: 'total_cost', value: { value: '1.25', unit: 'CNY' } }))
    await readBack(runId, answer)
    await record('v03-w07-compute-answer', ['type=compute', 'total_quantity=12.5 each', 'total_cost=1.25 CNY', 'answer=answer-draft@3'])
  }, 180_000)

  it('[host-http] runs a document-QA task and reads a verified answer@3 with a real quote', async () => {
    const response = await submitTask({ kind: 'document_qa', parameters: { query: MATCHING_QUERY, limit: 5 }, idempotencyKey: `tasktypes-docqa-${PROJECT_ID}` })
    if (response.status !== 202) throw new Error(`document QA admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('document QA admission returned no run id')
    const answer = await waitForAnswer(runId)
    const v3 = answer['v3Body'] as { schemaVersion: string; assertions?: { kind: string; quote?: string }[] }
    expect(v3.schemaVersion).toBe('answer-draft@3')
    const citations = (v3.assertions ?? []).filter((entry) => entry.kind === 'document_quote')
    expect(citations.length).toBeGreaterThanOrEqual(1)
    expect(citations[0]?.quote).toContain('inspection interval')
    await readBack(runId, answer)
    await record('v03-w07-document-qa-answer', ['type=document_qa', 'citation=exact-span', 'answer=answer-draft@3'])
  }, 180_000)

  it('[host-http] counterexample: a rule-conclusion run is refused, not silently answered', async () => {
    // The rule-derivation producer and the `rule_judgement` plan (V03-028/029) are not mounted
    // on this host, so the run is refused at admission (no published_semantics readiness) and can
    // never publish a verified @3. This pins the remaining open type.
    const response = await submitTask({ kind: 'rule_judgement', parameters: { question: 'is inspection due' }, idempotencyKey: `tasktypes-rule-${PROJECT_ID}` })
    const body = await response.json() as { error: { code: string; message?: string } }
    expect(response.status).toBe(409)
    expect(body.error.code).toBe('TASK_NOT_READY')
    await record('v03-w07-rule-counterexample', ['type=rule_judgement', 'admission=409 TASK_NOT_READY', 'reason=rule-derivation producer not mounted'])
  }, 120_000)
})

