import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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
const APP_PASSWORD = `modeltest_${randomUUID().replaceAll('-', '')}`
const MODEL_SECRET = 'test-only-controlled-company-secret'
const generatedCandidate = {
  entities: [{
    objectId: 'transport_facility',
    attributes: [
      { attributeId: 'facility_id', value: 'T-MODEL-01' },
      { attributeId: 'network_code', value: 'demo-network' },
      { attributeId: 'facility_district_code', value: 'north' },
      { attributeId: 'inspection_due', value: true },
    ],
  }],
  relations: [],
  rules: [],
  exceptions: [],
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let modelServer: Server | undefined
let modelServerUrl = ''
let clockOffsetMs = -6 * 60_000
let staleBootstrapDeadline = 0
const modelRequests: { readonly authorization: string | undefined; readonly model: string }[] = []
const hostClock = (): Date => new Date(Date.now() + clockOffsetMs)

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      body = {}
    }
    modelRequests.push({
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
      model: typeof body['model'] === 'string' ? body['model'] : '',
    })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const content = JSON.stringify(generatedCandidate)
    const chunksToWrite = [
      { id: 'chatcmpl-core-test', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-extractor', choices: [{ index: 0, delta: { content }, finish_reason: null }], usage: null },
      { id: 'chatcmpl-core-test', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-extractor', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
      { id: 'chatcmpl-core-test', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-extractor', choices: [], usage: { prompt_tokens: 21, completion_tokens: 18 } },
    ]
    for (const item of chunksToWrite) response.write(`data: ${JSON.stringify(item)}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `core-model-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Core model host integration'])
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
  const endAt = Date.now() + 30_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
    if (!response.ok) throw new Error(`GET job failed with ${String(response.status)}: ${await response.text()}`)
    const payload = await response.json() as { data: Record<string, unknown> }
    if (payload.data['stage'] === 'awaiting_review' || payload.data['stage'] === 'failed') return payload.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not reach review or failure before the deadline`)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  modelServerUrl = await startControlledModelServer()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-model-host-'))
  staleBootstrapDeadline = hostClock().getTime() + 5 * 60_000
  const modelEnvironment = {
    CORE_ENABLE_MODELS: 'true',
    CORE_COMPANY_MODEL_BASE_URL: modelServerUrl,
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
    CORE_COMPANY_MODEL_API_KEY: MODEL_SECRET,
    CORE_COMPANY_MODEL_PLATFORM_ID: 'core-company-extractor',
    CORE_COMPANY_MODEL_VENDOR_MODEL: 'synthetic-vendor-extractor',
    CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
  }
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: false,
    modelEnvironment,
    clock: hostClock,
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
}, 180_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  await new Promise<void>((resolve) => modelServer?.close(() => resolve()))
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('the configured Core generation adapter through the real ingestion host', () => {
  it('uses one adapter-owned attempt and a fresh per-job deadline after the host context is older than five minutes', async () => {
    const deployment = await request('/api/v1/core/deployment').then((response) => response.json()) as {
      data: { models: { generation: boolean; decision: boolean } }
    }
    expect(deployment.data.models).toEqual({ generation: true, decision: false })

    expect(staleBootstrapDeadline).toBeLessThan(Date.now())
    clockOffsetMs = 0
    expect(hostClock().getTime() + 5 * 60_000).toBeGreaterThan(Date.now())
    const importResponse = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-controlled-model-extraction' },
      body: JSON.stringify({
        scenarioId: 'transport-facility-inspection',
        sourceId: 'registry-a',
        content: 'Facility T-MODEL-01 is in network demo-network, district north, and inspection is due.',
      }),
    })
    expect(importResponse.status).toBe(202)
    const importBody = await importResponse.json() as { data: { jobId: string } }
    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const availableAt = await admin.query<{ next_attempt_at: string }>(
      `SELECT next_attempt_at::text AS next_attempt_at
         FROM agent_platform.jobs
        WHERE tenant_id = $1 AND space_id = $2 AND job_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, importBody.data.jobId],
    )
    expect(availableAt.rows).toHaveLength(1)
    expect(Date.parse(availableAt.rows[0]?.next_attempt_at ?? '')).toBeLessThanOrEqual(Date.now())
    const job = await waitForJob(importBody.data.jobId)
    expect(job['stage']).toBe('awaiting_review')
    expect((job['counts'] as { processed: number }).processed).toBeGreaterThan(0)
    expect(modelRequests).toHaveLength(1)
    expect(modelRequests[0]?.model).toBe('synthetic-vendor-extractor')
    expect(modelRequests[0]?.authorization).toBe(`Bearer ${MODEL_SECRET}`)

    const candidatesResponse = await request(`/api/v1/candidates?jobId=${encodeURIComponent(importBody.data.jobId)}&kind=entity`)
    expect(candidatesResponse.status).toBe(200)
    const candidateSummaries = await candidatesResponse.json() as { data: { candidates: { candidateId: string }[] } }
    expect(candidateSummaries.data.candidates).toHaveLength(1)
    const candidateDetailResponse = await request(`/api/v1/candidates/${encodeURIComponent(candidateSummaries.data.candidates[0]?.candidateId ?? '')}`)
    expect(candidateDetailResponse.status).toBe(200)
    const candidateDetail = await candidateDetailResponse.json() as {
      data: { candidate: { state: string; attributes: { attributeId: string; value: unknown }[] } }
    }
    expect(candidateDetail.data.candidate.state).toBe('pending_review')
    expect(candidateDetail.data.candidate.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 'network_code', value: 'demo-network' }),
      expect.objectContaining({ attributeId: 'facility_district_code', value: 'north' }),
    ]))
    const candidateSource = await request(`/api/v1/candidates/${encodeURIComponent(candidateSummaries.data.candidates[0]?.candidateId ?? '')}/source`)
    expect(candidateSource.status).toBe(200)
    expect(JSON.stringify(await candidateSource.json())).toContain('Facility T-MODEL-01 is in network demo-network, district north, and inspection is due.')

    const reservations = await admin.query<{ status: string; actual_model_tokens: string | null; usage_unknown: boolean }>(
      `SELECT status, actual_model_tokens::text AS actual_model_tokens, usage_unknown
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, importBody.data.jobId],
    )
    expect(reservations.rows).toHaveLength(1)
    expect(reservations.rows[0]?.status).toBe('settled')
    expect(Number(reservations.rows[0]?.actual_model_tokens)).toBe(39)
    expect(reservations.rows[0]?.usage_unknown).toBe(false)

    const modelEvidence = await admin.query<{ evidence_id: string; payload_ref: unknown }>(
      `SELECT evidence_id, payload_ref
         FROM agent_platform.evidence_records
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND kind = 'model_output'`,
      [scopeRef.tenantId, scopeRef.spaceId, importBody.data.jobId],
    )
    expect(modelEvidence.rows).toHaveLength(1)
    expect(modelEvidence.rows[0]?.payload_ref).toBeDefined()
  }, 120_000)
})
