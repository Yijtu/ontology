import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/**
 * S03 acceptance: a new research run's public search comes from the tool-connection catalogue at its
 * workspace scope — never from the deployment environment — and we verify the **real request
 * destination** for four situations:
 *   1. only a UI/catalogue connection (Tavily-shaped compat);
 *   2. only the legacy environment, imported on first start;
 *   3. the catalogue edited, then the host restarted;
 *   4. the catalogue disabled while the environment is still present (the environment must not win).
 *
 * It runs a real PostgreSQL, a real host composition and a controlled HTTP search server; the
 * provider request URL is captured from the actual server that received it.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `s03dest_${randomUUID().replaceAll('-', '')}`

const MODEL_ENV = {
  CORE_ENABLE_MODELS: 'true',
  CORE_COMPANY_MODEL_BASE_URL: 'http://127.0.0.1:9',
  CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
  CORE_COMPANY_MODEL_API_KEY: 's03-destinations-secret',
  CORE_COMPANY_MODEL_PLATFORM_ID: 's03-destinations-model',
  CORE_COMPANY_MODEL_VENDOR_MODEL: 's03-destinations-vendor',
  CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
} as const

/** A controlled OpenAI-compatible model that issues exactly one `web_search` and then stops. */
let modelServer: Server | undefined

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    let toolMessages = 0
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: readonly { role?: string }[] }
      toolMessages = (body.messages ?? []).filter((message) => message.role === 'tool').length
    } catch {
      toolMessages = 0
    }
    const call = toolMessages === 0
      ? { id: 'call_search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '设备维护规程', allowedDomains: ['standards.example.org'], limit: 3 }) } }
      : undefined
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: 'chatcmpl-s03', object: 'chat.completion.chunk', created: 1, model: 's03-vendor' }
    if (call !== undefined) {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: call.function }] }, finish_reason: null }], usage: null })}\n\n`)
    }
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? 'stop' : 'tool_calls' }], usage: null })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  const { port } = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let modelBaseUrl = ''
const tempDirs: string[] = []

/** A controlled search server that records the paths it actually received and returns no results. */
interface SearchServer {
  readonly url: string
  readonly requests: string[]
  close(): Promise<void>
}

async function startSearchServer(): Promise<SearchServer> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [], truncated: false }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))),
  }
}

async function insertScope(scope: ScopeRef, name: string): Promise<void> {
  await admin!.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scope.tenantId, `${name}-${scope.tenantId.slice(0, 8)}`])
  await admin!.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scope.tenantId, scope.spaceId, name])
}

interface Host {
  readonly composition: CoreLocalComposition
  readonly api: ReturnType<typeof createCoreApi>
  readonly baseUrl: string
  close(): Promise<void>
}

async function startHost(scopeRef: ScopeRef, env: Readonly<Record<string, string | undefined>>, existingObjectDirectory?: string): Promise<Host> {
  const objectDirectory = existingObjectDirectory ?? await mkdtemp(join(tmpdir(), 'ontology-s03-dest-'))
  if (existingObjectDirectory === undefined) tempDirs.push(objectDirectory)
  const composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: false,
    modelEnvironment: { ...MODEL_ENV, CORE_COMPANY_MODEL_BASE_URL: modelBaseUrl, ...env },
  })
  const api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  return {
    composition,
    api,
    baseUrl: address.replace(/\/$/u, ''),
    async close() {
      await api.close().catch(() => undefined)
      await composition.close().catch(() => undefined)
    },
  }
}

function url(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`
}

async function bootstrapWorkspace(baseUrl: string): Promise<string> {
  const response = await fetch(url(baseUrl, '/api/v1/core/workspace-bootstrap'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `s03-ws-${randomUUID()}` },
    body: JSON.stringify({ namespace: `s03-${randomUUID()}`, displayName: 'S03 目的地工作区', boundary: { goals: ['整理规则'], included: [], excluded: [], applicability: {} } }),
    signal: AbortSignal.timeout(20_000),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const body = await response.json() as { data: { workspace: { workspaceId: string } } }
  return body.data.workspace.workspaceId
}

async function startResearchRun(baseUrl: string, workspaceId: string): Promise<Response> {
  return fetch(url(baseUrl, `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `s03-run-${randomUUID()}` },
    body: JSON.stringify({ goal: '整理设备维护规则', allowedResearchDomains: ['standards.example.org'], targetKinds: ['object'], sourceLimit: 3, candidateLimit: 3 }),
    signal: AbortSignal.timeout(20_000),
  })
}

/** Wait until the background worker drives the run to a terminal state; returns the final status. */
async function waitForRunTerminal(baseUrl: string, workspaceId: string, researchId: string): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const read = await fetch(url(baseUrl, `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}`), { signal: AbortSignal.timeout(20_000) })
    if (read.status !== 200) throw new Error(`reading run ${researchId} returned ${String(read.status)}`)
    const body = await read.json() as { data: { execution: { status: string } } }
    const status = body.data.execution.status
    if (['completed', 'awaiting_confirmation', 'failed', 'cancelled'].includes(status)) return status
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('the research run did not reach a terminal state')
}

function newScope(): ScopeRef {
  return { tenantId: randomUUID(), spaceId: randomUUID() }
}

beforeAll(async () => {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  modelBaseUrl = await startControlledModelServer()
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = 'ontology_app'
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
}, 240_000)

afterAll(async () => {
  await admin?.end().catch(() => undefined)
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  await new Promise<void>((resolve) => { if (modelServer === undefined) resolve(); else modelServer.close(() => resolve()) })
  await container?.stop()
})

describe('S03 research request destinations', () => {
  it('1. sends a new run to the connection configured through the catalogue (UI), not any env', async () => {
    const scopeRef = newScope()
    await insertScope(scopeRef, 's03-ui')
    const server = await startSearchServer()
    const host = await startHost(scopeRef, {}) // no CORE_WEB_SEARCH_* at all
    try {
      // Configure the connection through the same HTTP surface the UI uses.
      const created = await fetch(url(host.baseUrl, '/api/v1/core/ai/tool-connections'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-conn-${randomUUID()}` },
        body: JSON.stringify({ descriptor: { name: 'Tavily 兼容', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, endpoint: server.url } }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const connection = (await created.json() as { data: { connectionId: string } }).data

      const assigned = await fetch(url(host.baseUrl, '/api/v1/core/ai/tool-assignments'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-assign-${randomUUID()}` },
        body: JSON.stringify({ scope: { kind: 'space' }, defaultSelection: { kind: 'connection', connectionId: connection.connectionId }, toolSelections: [] }),
      })
      expect(assigned.status, await assigned.clone().text()).toBe(200)

      const workspaceId = await bootstrapWorkspace(host.baseUrl)
      const started = await startResearchRun(host.baseUrl, workspaceId)
      expect(started.status, await started.clone().text()).toBe(202)
      const researchId = (await started.json() as { data: { researchId: string } }).data.researchId
      expect(['completed', 'awaiting_confirmation']).toContain(await waitForRunTerminal(host.baseUrl, workspaceId, researchId))
      expect(server.requests.some((path) => path.startsWith('/v1/search'))).toBe(true)

      // The synchronous compatibility path keeps its 201 and also goes through the catalogue.
      const before = server.requests.length
      const sync = await fetch(url(host.baseUrl, `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-sync-${randomUUID()}` },
        body: JSON.stringify({ goal: '整理设备维护规则', allowedResearchDomains: ['standards.example.org'], targetKinds: ['object'], candidateLimit: 3 }),
        signal: AbortSignal.timeout(20_000),
      })
      expect(sync.status, await sync.clone().text()).toBe(201)
      expect(server.requests.length).toBeGreaterThan(before)
    } finally {
      await host.close()
      await server.close()
    }
  }, 120_000)

  it('2. imports the legacy environment on first start and sends the run to it', async () => {
    const scopeRef = newScope()
    await insertScope(scopeRef, 's03-env')
    const server = await startSearchServer()
    const host = await startHost(scopeRef, { CORE_WEB_SEARCH_BASE_URL: server.url })
    try {
      const workspaceId = await bootstrapWorkspace(host.baseUrl)
      const started = await startResearchRun(host.baseUrl, workspaceId)
      expect(started.status, await started.clone().text()).toBe(202)
      const researchId = (await started.json() as { data: { researchId: string } }).data.researchId
      expect(['completed', 'awaiting_confirmation']).toContain(await waitForRunTerminal(host.baseUrl, workspaceId, researchId))
      expect(server.requests.some((path) => path.startsWith('/v1/search'))).toBe(true)
    } finally {
      await host.close()
      await server.close()
    }
  }, 120_000)

  it('3. honours a catalogue edit across a restart (the environment is not consulted)', async () => {
    const scopeRef = newScope()
    await insertScope(scopeRef, 's03-restart')
    const serverA = await startSearchServer()
    const serverB = await startSearchServer()
    // A restart reuses the same object directory, as a real in-place restart does.
    const objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-s03-dest-'))
    tempDirs.push(objectDirectory)
    const first = await startHost(scopeRef, {}, objectDirectory)
    let connectionId = ''
    let revision = ''
    try {
      const created = await fetch(url(first.baseUrl, '/api/v1/core/ai/tool-connections'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-conn-a-${randomUUID()}` },
        body: JSON.stringify({ descriptor: { name: '网关A', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, endpoint: serverA.url } }),
      })
      const connection = (await created.json() as { data: { connectionId: string; revision: string } }).data
      connectionId = connection.connectionId
      revision = connection.revision
      await fetch(url(first.baseUrl, '/api/v1/core/ai/tool-assignments'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-assign-a-${randomUUID()}` },
        body: JSON.stringify({ scope: { kind: 'space' }, defaultSelection: { kind: 'connection', connectionId }, toolSelections: [] }),
      })
    } finally {
      await first.close()
    }

    // A restart is a fresh host reading the same catalogue. The environment was never set.
    const second = await startHost(scopeRef, {}, objectDirectory)
    try {
      const updated = await fetch(url(second.baseUrl, `/api/v1/core/ai/tool-connections/${encodeURIComponent(connectionId)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-conn-edit-${randomUUID()}` },
        body: JSON.stringify({ descriptor: { name: '网关B', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, endpoint: serverB.url }, expectedRevision: revision }),
      })
      expect(updated.status, await updated.clone().text()).toBe(200)

      const workspaceId = await bootstrapWorkspace(second.baseUrl)
      const started = await startResearchRun(second.baseUrl, workspaceId)
      expect(started.status, await started.clone().text()).toBe(202)
      const researchId = (await started.json() as { data: { researchId: string } }).data.researchId
      expect(['completed', 'awaiting_confirmation']).toContain(await waitForRunTerminal(second.baseUrl, workspaceId, researchId))
      expect(serverB.requests.some((path) => path.startsWith('/v1/search'))).toBe(true)
      expect(serverA.requests).toHaveLength(0)
    } finally {
      await second.close()
      await serverA.close()
      await serverB.close()
    }
  }, 120_000)

  it('4. refuses a run when the catalogue is disabled even though the environment is present', async () => {
    const scopeRef = newScope()
    await insertScope(scopeRef, 's03-disabled')
    const envServer = await startSearchServer()
    const objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-s03-dest-'))
    tempDirs.push(objectDirectory)
    // The environment is present and gets imported at first start…
    const host = await startHost(scopeRef, { CORE_WEB_SEARCH_BASE_URL: envServer.url }, objectDirectory)
    let connectionId = ''
    let revision = ''
    try {
      const list = await fetch(url(host.baseUrl, '/api/v1/core/ai/tool-connections?capability=web_search'), { signal: AbortSignal.timeout(20_000) })
      const connections = (await list.json() as { data: { connectionId: string; revision: string }[] }).data
      const imported = connections[0]
      if (imported === undefined) throw new Error('expected the environment to have been imported')
      connectionId = imported.connectionId
      revision = imported.revision
    } finally {
      await host.close()
    }

    // Disable the catalogue connection; the environment is still set but must not become a fallback.
    const second = await startHost(scopeRef, { CORE_WEB_SEARCH_BASE_URL: envServer.url }, objectDirectory)
    try {
      const disabled = await fetch(url(second.baseUrl, `/api/v1/core/ai/tool-connections/${encodeURIComponent(connectionId)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': `s03-conn-disable-${randomUUID()}` },
        body: JSON.stringify({ descriptor: { name: '兼容网关', adapterType: 'http_compat', capabilities: ['web_search'], enabled: false, endpoint: envServer.url }, expectedRevision: revision }),
      })
      expect(disabled.status, await disabled.clone().text()).toBe(200)

      const workspaceId = await bootstrapWorkspace(second.baseUrl)
      const started = await startResearchRun(second.baseUrl, workspaceId)
      expect(started.status, await started.clone().text()).toBe(409)
      const error = (await started.json() as { error: { code: string } }).error
      expect(error.code).toBe('CAPABILITY_NOT_CONFIGURED')
      // The environment endpoint was never contacted: the catalogue is the single truth.
      expect(envServer.requests).toHaveLength(0)
    } finally {
      await second.close()
      await envServer.close()
    }
  }, 120_000)
})

