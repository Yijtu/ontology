import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiServer, createBearerTokenAuthenticator, registerSecurityHeaders, registerWebApp } from '@ontology/app-api'
import type { FastifyInstance } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'

const TOKEN = 'deployment-token-0123456789'
const SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

function request(authorization?: string): { method: 'GET'; url: string; headers: Record<string, string> } {
  return {
    method: 'GET',
    url: '/anything',
    headers: authorization === undefined ? {} : { authorization },
  }
}

describe('deployment bearer token authenticator', () => {
  const authenticate = createBearerTokenAuthenticator({
    token: TOKEN,
    scopeRef: SCOPE,
    roles: ['profile-editor'],
    subjectId: 'deployment-token',
  })

  it('accepts the configured token and attributes the request to the deployment scope', () => {
    const authenticated = authenticate(request(`Bearer ${TOKEN}`) as never)
    expect(authenticated?.spaceId).toBe(SCOPE.spaceId)
    expect(authenticated?.principal).toMatchObject({
      tenantId: SCOPE.tenantId,
      subjectId: 'deployment-token',
      roles: ['profile-editor'],
    })
  })

  it('rejects a wrong, missing or non-bearer credential', () => {
    expect(authenticate(request() as never)).toBeUndefined()
    expect(authenticate(request('') as never)).toBeUndefined()
    expect(authenticate(request('Bearer wrong-token') as never)).toBeUndefined()
    expect(authenticate(request(`Basic ${TOKEN}`) as never)).toBeUndefined()
    expect(authenticate(request('Bearer ') as never)).toBeUndefined()
    // A prefix of the real token must not pass.
    expect(authenticate(request(`Bearer ${TOKEN.slice(0, -1)}`) as never)).toBeUndefined()
  })
})

describe('web build hosting', () => {
  let app: FastifyInstance
  let root = ''
  const previousCwd = process.cwd()

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ontology-webdist-'))
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), '<!doctype html><title>core</title>', 'utf8')
    await writeFile(join(root, 'assets', 'app.js'), 'console.log("core")', 'utf8')
    await writeFile(join(previousCwd, 'do-not-serve.txt'), 'secret', 'utf8').catch(() => undefined)

    app = createApiServer({ authenticate: () => undefined })
    registerSecurityHeaders(app)
    registerWebApp(app, { root })
    app.get('/api/v1/known', async () => ({ ok: true }))
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await rm(join(previousCwd, 'do-not-serve.txt'), { force: true })
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  it('serves the built asset with an immutable cache policy', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('immutable')
    expect(response.headers['content-type']).toContain('javascript')
    expect(response.body).toContain('console.log')
  })

  it('falls back to the shell for a client-side route, without caching it', async () => {
    const response = await app.inject({ method: 'GET', url: '/workspaces/123/sources' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<title>core</title>')
    expect(response.headers['cache-control']).toBe('no-cache')
  })

  it('keeps unknown API paths a JSON 404 instead of the shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/missing' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    // A real route still wins over the SPA fallback.
    expect((await app.inject({ method: 'GET', url: '/api/v1/known' })).json()).toEqual({ ok: true })
  })

  it('never serves a file outside the build root', async () => {
    const response = await app.inject({ method: 'GET', url: '/../do-not-serve.txt' })
    expect(response.body).not.toContain('secret')
  })

  it('sends the security headers the Electron renderer relies on', async () => {
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-frame-options']).toBe('DENY')
    const csp = String(response.headers['content-security-policy'])
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-eval')
  })

  it('refuses to mount a directory that has no built app', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ontology-webdist-empty-'))
    try {
      expect(() => registerWebApp(createApiServer({ authenticate: () => undefined }), { root: empty })).toThrow(/index\.html/u)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
