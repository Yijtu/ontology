import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

vi.setConfig({ testTimeout: 180_000 })

const TOKEN = 'deployment-token-integration-0123456789'

let postgres: PostgresContainer
let admin: Client
let composition: Awaited<ReturnType<typeof createCoreLocalComposition>>
let api: ReturnType<typeof createCoreApi>
let origin = ''
let webRoot = ''
let objectDir = ''
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ['CORE_API_TOKEN', 'CORE_API_TOKEN_SUBJECT', 'CORE_WEB_DIST'] as const

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  postgres = await startPostgresContainer()
  await runControlMigrations({
    connectionString: postgres.adminUrl,
    migrationsDir: fileURLToPath(new URL('../../migrations/control', import.meta.url)),
  })
  admin = new Client({ connectionString: postgres.adminUrl })
  await admin.connect()
  const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id,slug) VALUES ($1,$2)', [scopeRef.tenantId, `deploy-${scopeRef.tenantId}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id,space_id,name) VALUES ($1,$2,$3)', [scopeRef.tenantId, scopeRef.spaceId, 'Deployment access'])
  const password = randomUUID().replaceAll('-', '')
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [password])
  if (statement.rows[0] === undefined) throw new Error('the application role could not be configured')
  await admin.query(statement.rows[0].statement)
  const appUrl = new URL(postgres.adminUrl)
  appUrl.username = 'ontology_app'
  appUrl.password = password

  // A minimal real build: the API must serve its own index.html and hashed assets.
  webRoot = await mkdtemp(join(tmpdir(), 'ontology-deploy-web-'))
  await mkdir(join(webRoot, 'assets'), { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root">core</div>', 'utf8')
  await writeFile(join(webRoot, 'assets', 'main.js'), 'globalThis.__coreBooted = true', 'utf8')
  objectDir = await mkdtemp(join(tmpdir(), 'ontology-deploy-objects-'))

  process.env['CORE_API_TOKEN'] = TOKEN
  process.env['CORE_API_TOKEN_SUBJECT'] = 'deployment-token'
  process.env['CORE_WEB_DIST'] = webRoot

  composition = await createCoreLocalComposition({
    databaseUrl: appUrl.toString(),
    objectDirectory: objectDir,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: false,
    jevEnabled: false,
  })
  api = createCoreApi(composition.dependencies)
  // A thrown exception rather than a port probe proves the authenticated path is actually mounted.
  origin = await api.listen({ host: '127.0.0.1', port: 0 })
}, 300_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await admin?.end().catch(() => undefined)
  await postgres?.stop().catch(() => undefined)
  if (webRoot !== '') await rm(webRoot, { recursive: true, force: true })
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
})

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, init)
}

describe('deployment access (real PostgreSQL, real API)', () => {
  it('keeps health unauthenticated so a client can probe reachability first', async () => {
    const response = await get('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ready' })
  })

  it('refuses the deployment API without the token', async () => {
    const response = await get('/api/v1/core/deployment')
    expect(response.status).toBe(401)
    expect((await response.json() as { error?: { code?: string } }).error?.code).toBe('UNAUTHENTICATED')
  })

  it('accepts the deployment token for a remote client', async () => {
    const response = await get('/api/v1/core/deployment', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
  })

  it('serves the built UI same-origin so no CORS relaxation is needed', async () => {
    const shell = await get('/')
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-type')).toContain('text/html')
    expect(await shell.text()).toContain('id="root"')
    expect(shell.headers.get('cache-control')).toBe('no-cache')

    const asset = await get('/assets/main.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    // A client-side route still gets the shell; a typo under /api does not.
    const route = await get('/workspaces/example/sources')
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('id="root"')
    const missingApi = await get('/api/v1/not-a-route', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(missingApi.status).toBe(404)
  })

  it('sends the renderer security headers on both API and UI responses', async () => {
    for (const path of ['/', '/healthz']) {
      const response = await get(path)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-frame-options')).toBe('DENY')
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    }
  })
})
