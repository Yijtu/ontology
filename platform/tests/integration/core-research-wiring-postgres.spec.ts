import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
const APP_PASSWORD = `researchwire_${randomUUID().replaceAll('-', '')}`

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
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `research-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Core research wiring'])
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
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

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-research-wiring-'))
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: false,
    modelEnvironment: {
      CORE_ENABLE_MODELS: 'true',
      CORE_COMPANY_MODEL_BASE_URL: 'http://127.0.0.1:9',
      CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
      CORE_COMPANY_MODEL_API_KEY: 'research-wiring-secret',
      CORE_COMPANY_MODEL_PLATFORM_ID: 'core-research-wiring',
      CORE_COMPANY_MODEL_VENDOR_MODEL: 'research-wiring-vendor',
      CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
      // A normal start must discover research from configuration, not from a test injection.
      CORE_WEB_SEARCH_BASE_URL: 'https://search.example.com',
    },
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

describe('a normal Core start discovers the research surface (N12)', () => {
  it('projects the research/archive capabilities as available from the configured search endpoint', async () => {
    const response = await request('/api/v1/workbench/overview')
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { capabilities: { ability: string; available: boolean; unavailableReason?: string }[] } }
    const byAbility = new Map(body.data.capabilities.map((entry) => [entry.ability, entry]))
    expect(byAbility.get('research')?.available).toBe(true)
    expect(byAbility.get('archive')?.available).toBe(true)
    expect(byAbility.get('research')?.unavailableReason).toBeUndefined()
  })

  it('mounts the durable research-run route and accepts a bounded run with 202', async () => {
    const created = await request('/api/v1/core/workspace-bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `research-wiring-workspace-${randomUUID()}` },
      body: JSON.stringify({ namespace: `research-${randomUUID()}`, displayName: '研究装配工作区', boundary: { goals: ['整理设备维护规则'], included: ['合成资料'], excluded: [], applicability: {} } }),
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const workspaceId = (await created.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
    const response = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `research-wiring-${randomUUID()}` },
      body: JSON.stringify({
        goal: '整理设备维护规则及其依据',
        allowedResearchDomains: ['standards.example.org'],
        targetKinds: ['object', 'attribute'],
        sourceLimit: 5,
        candidateLimit: 5,
      }),
    })
    expect(response.status, await response.clone().text()).toBe(202)
    const body = await response.json() as { data: { researchId: string; jobId: string; execution: { status: string; stage: string } } }
    expect(body.data.researchId).toBe(body.data.jobId)
    expect(body.data.execution.status).toBe('queued')
    expect(body.data.execution.stage).toBe('planning')

    const read = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(body.data.researchId)}`)
    expect(read.status).toBe(200)
    const view = await read.json() as { data: { execution: { researchId: string } } }
    expect(view.data.execution.researchId).toBe(body.data.researchId)
  })
})
