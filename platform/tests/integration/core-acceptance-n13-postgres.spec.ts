import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `n13unconfigured_${randomUUID().replaceAll('-', '')}`

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `n13-unconfigured-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'N13 unconfigured model acceptance'])
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

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 20_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
    if (!response.ok) throw new Error(`GET job failed with ${String(response.status)}: ${await response.text()}`)
    const body = await response.json() as { data: Record<string, unknown> }
    if (body.data['stage'] === 'awaiting_review' || body.data['stage'] === 'failed') return body.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not reach a terminal stage before the test deadline`)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-n13-unconfigured-'))
  // A normal start with no generation model, no decision model and no web_search provider.
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: false,
    jevEnabled: false,
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
}, 180_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

/**
 * N13 high-risk regression (design §5.5): a completely unconfigured model must not disable the
 * non-model source paths, and history stays readable. Capabilities degrade with an explicit reason
 * instead of silently pretending a model is available.
 */
describe('fully unconfigured model acceptance (N13)', () => {
  it('reports the missing model/search abilities with an explicit reason', async () => {
    const response = await request('/api/v1/workbench/overview')
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { capabilities: { ability: string; available: boolean; unavailableReason?: string }[] } }
    const byAbility = new Map(body.data.capabilities.map((entry) => [entry.ability, entry]))
    expect(byAbility.get('generation')?.available).toBe(false)
    expect(byAbility.get('generation')?.unavailableReason).toBeDefined()
    expect(byAbility.get('decision_jev')?.available).toBe(false)
    expect(byAbility.get('research')?.available).toBe(false)
    expect(byAbility.get('research')?.unavailableReason).toBeDefined()
    expect(byAbility.get('archive')?.available).toBe(false)
    // The deterministic structured ingestion path does not depend on a model.
    expect(byAbility.get('structured_ingestion')?.available).toBe(true)

    const deployment = await request('/api/v1/core/deployment')
    expect((await deployment.json() as { data: { models: { generation: boolean; decision: boolean } } }).data.models).toEqual({ generation: false, decision: false })
  })

  it('keeps the non-model upload path and history re-read available without any model', async () => {
    const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    if (scenario === undefined) throw new Error('the transport synthetic scenario is not mounted')
    const registry = scenario.rawSources.find((entry) => entry.sourceRef.sourceId === 'registry-a')
    if (registry === undefined) throw new Error('the transport registry raw source is not mounted')
    const content = await readFile(registry.path, 'utf8')

    const imported = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `n13-unconfigured-import-${randomUUID()}` },
      body: JSON.stringify({ scenarioId: scenario.scenarioId, sourceId: registry.sourceRef.sourceId, content }),
    })
    expect(imported.status, await imported.clone().text()).toBe(202)
    const jobId = (await imported.json() as { data: { jobId: string } }).data.jobId
    const job = await waitForJob(jobId)
    // Native records are ingested deterministically; no model was configured for the deployment.
    expect(job['stage']).toBe('awaiting_review')
    expect((job['counts'] as { processed: number }).processed).toBeGreaterThan(0)

    // A workspace draft is created and re-readable (history) with no model involved.
    const created = await request('/api/v1/core/workspace-bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `n13-unconfigured-workspace-${randomUUID()}` },
      body: JSON.stringify({ namespace: `n13-${randomUUID()}`, displayName: '无模型工作区', boundary: { goals: ['验证无模型退化'], included: ['合成资料'], excluded: [], applicability: {} } }),
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const workspaceId = (await created.json() as { data: { workspace: { workspaceId: string; headRevision: string } } }).data.workspace.workspaceId
    const firstRead = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}`)
    expect(firstRead.status).toBe(200)
    const firstHead = (await firstRead.json() as { data: { workspace: { headRevision: string } } }).data.workspace.headRevision
    const secondRead = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}`)
    expect(secondRead.status).toBe(200)
    expect((await secondRead.json() as { data: { workspace: { headRevision: string } } }).data.workspace.headRevision).toBe(firstHead)
  })
})
