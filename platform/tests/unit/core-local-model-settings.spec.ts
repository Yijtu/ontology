import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreLocalModelSettings, createCoreApi, loadCoreExamples } from '@ontology/app-api'
import { probeCompanyModel } from '@ontology/adapter-model-company'

const owned: string[] = []
const scope = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const key = randomUUID()
const body = { revision: '0', enabled: true, baseUrl: 'https://gateway.example.test', endpoint: '/v1/chat/completions', protocol: 'openai-compatible' as const, platformModelId: 'test-generation', vendorModel: 'test-model', apiKey: key }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ontology-model-settings-'))
  owned.push(directory)
  const settings = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: scope, environment: { CORE_ENABLE_MODELS: 'false' } })
  await settings.loadEnvironment()
  return { directory, settings }
}
afterEach(async () => {
  for (const directory of owned.splice(0)) {
    const target = resolve(directory)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}ontology-model-settings-`)) throw new Error('Refusing unowned cleanup')
    await rm(target, { recursive: true, force: true })
  }
})
describe('local model settings', () => {
  it('keeps secrets server-side, preserves blank credentials, and applies configuration only after restart', async () => {
    const { settings, directory } = await fixture()
    const initial = await settings.read()
    expect(initial).toMatchObject({ revision: '0', enabled: false, activeEnabled: false, hasApiKey: false, restartRequired: false })
    const saved = await settings.save(body)
    expect(saved).toMatchObject({ revision: '1', enabled: true, activeEnabled: false, hasApiKey: true, restartRequired: true })
    expect(JSON.stringify(saved)).not.toContain(key)
    const unchanged = await settings.save({ ...body, revision: '1', apiKey: '' })
    expect(unchanged.hasApiKey).toBe(true)
    const restarted = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: scope, environment: {} })
    const env = await restarted.loadEnvironment()
    expect(env['CORE_ENABLE_MODELS']).toBe('true')
    expect(env['CORE_COMPANY_MODEL_API_KEY']).toBe(key)
    expect(env['CORE_COMPANY_MODEL_SECRET_REF']).toBe('env:CORE_COMPANY_MODEL_API_KEY')
    expect(env['CORE_COMPANY_MODEL_PLATFORM_ID']).toMatch(/^test-generation\.local\.[a-f0-9]{16}$/u)
    expect(await restarted.read()).toMatchObject({ activeEnabled: true, restartRequired: false })
    await restarted.save({ ...body, revision: '2', vendorModel: 'different-model', apiKey: '' })
    const next = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: scope, environment: {} })
    expect((await next.loadEnvironment())['CORE_COMPANY_MODEL_PLATFORM_ID']).not.toBe(env['CORE_COMPANY_MODEL_PLATFORM_ID'])
    const otherScope = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: { ...scope, spaceId: randomUUID() }, environment: {} })
    expect((await otherScope.read()).hasApiKey).toBe(false)
  })
  it('rejects stale simultaneous writes and unsafe fields, and only clears credentials explicitly', async () => {
    const { settings, directory } = await fixture()
    const writes = await Promise.allSettled([settings.save(body), settings.save(body)])
    expect(writes.map((entry) => entry.status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(settings.save({ ...body, revision: '1', baseUrl: 'https://user:pass@example.test' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(settings.save({ ...body, revision: '1', endpoint: '//different.example.test' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(settings.save({ ...body, revision: '1', tenantId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(settings.test({ ...body, baseUrl: 'https://different.example.test', apiKey: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(settings.save({ ...body, revision: '1', apiKey: '', clearApiKey: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const cleared = await settings.save({ ...body, revision: '1', enabled: false, apiKey: '', clearApiKey: true })
    expect(cleared.hasApiKey).toBe(false)
    const stored: unknown = JSON.parse(await readFile(join(directory, '.core-settings', scope.tenantId, scope.spaceId, 'generation.json'), 'utf8'))
    expect(stored).toMatchObject({ apiKey: '', enabled: false })
  })
  it('mints a different model component when only the credential changes', async () => {
    const { settings, directory } = await fixture()
    await settings.save(body)
    const first = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: scope, environment: {} })
    const oldEnvironment = await first.loadEnvironment()
    const nextKey = randomUUID()
    expect(await first.save({ ...body, revision: '1', apiKey: nextKey })).toMatchObject({ restartRequired: true })
    const next = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: scope, environment: {} })
    const newEnvironment = await next.loadEnvironment()
    expect(newEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID']).not.toBe(oldEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'])
    expect(newEnvironment['CORE_COMPANY_MODEL_API_KEY']).toBe(nextKey)
    expect(oldEnvironment['CORE_COMPANY_MODEL_API_KEY']).toBe(key)
    expect(JSON.stringify(await next.read())).not.toContain(nextKey)
  })
  it('protects read and write routes from readonly, cross-scope and foreign-origin callers', async () => {
    const { settings } = await fixture()
    const examples = loadCoreExamples({ targetScopeRef: scope })
    const operator = createCoreApi({ scopeRef: scope, examples, database: { queryUnscoped: async () => undefined }, allowLocalOperator: true, modelSettings: settings, webPort: 5175 })
    const readonly = createCoreApi({ scopeRef: scope, examples, database: { queryUnscoped: async () => undefined }, modelSettings: settings })
    const crossScope = createCoreApi({ scopeRef: { ...scope, spaceId: randomUUID() }, examples, database: { queryUnscoped: async () => undefined }, allowLocalOperator: true, modelSettings: settings })
    try {
      const headers = { host: '127.0.0.1:3002', origin: 'http://127.0.0.1:5175' }
      expect((await readonly.inject({ url: '/api/v1/core/model-settings', headers })).statusCode).toBe(403)
      expect((await crossScope.inject({ url: '/api/v1/core/model-settings', headers })).statusCode).toBe(403)
      expect((await operator.inject({ method: 'PUT', url: '/api/v1/core/model-settings', headers: { ...headers, origin: 'https://foreign.example' }, payload: body })).statusCode).toBe(403)
      expect((await operator.inject({ url: '/api/v1/core/model-settings', headers: { host: 'foreign.example' } })).statusCode).toBe(403)
      const saved = await operator.inject({ method: 'PUT', url: '/api/v1/core/model-settings', headers, payload: body })
      expect(saved.statusCode).toBe(200)
      expect(saved.body).not.toContain(key)
      expect((await operator.inject({ url: '/api/v1/core/model-settings', headers })).body).not.toContain(key)
      const stale = await operator.inject({ method: 'PUT', url: '/api/v1/core/model-settings', headers, payload: body })
      expect(stale.statusCode).toBe(409)
      expect(stale.body).not.toContain(key)
    } finally { await Promise.all([operator.close(), readonly.close(), crossScope.close()]) }
  })
  it('does not silently ignore a damaged saved configuration or expose its content', async () => {
    const { settings, directory } = await fixture()
    await settings.save(body)
    await writeFile(join(directory, '.core-settings', scope.tenantId, scope.spaceId, 'generation.json'), JSON.stringify({ ...body, apiKey: key, enabled: 'invalid' }))
    try { await settings.loadEnvironment(); throw new Error('Corrupt settings were accepted') }
    catch (error) {
      expect(error).toMatchObject({ code: 'CONFIG_STORAGE_INVALID' })
      expect(String(error)).not.toContain(key)
    }
  })
})
describe('bounded model connectivity probe', () => {
  it('uses the actual streaming codec and bounded request without following redirects', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      let text = ''
      request.on('data', (chunk: Buffer) => { text += chunk.toString() })
      request.on('end', () => {
        requests.push(text)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"choices":[{"delta":{"content":"OK"},"index":0}]}\n\ndata: [DONE]\n\n')
      })
    })
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing local probe port')
    try {
      const result = await probeCompanyModel({ ...body, baseUrl: `http://127.0.0.1:${address.port}` })
      expect(result.reachable).toBe(true)
      expect(JSON.parse(requests[0] ?? '{}')).toMatchObject({ model: 'test-model', stream: true, max_tokens: 16 })
      expect(requests.join('')).not.toContain(key)
      let redirectPolicy: RequestRedirect | undefined
      const denied = await probeCompanyModel({ ...body, protocol: 'openai-compatible' }, { fetchImpl: async (_url, init) => {
        redirectPolicy = init?.redirect
        return new Response('credential must never be echoed', { status: 401 })
      } })
      expect(redirectPolicy).toBe('error')
      expect(denied).toMatchObject({ reachable: false })
      expect(denied.message).not.toContain('credential')
      const malformed = await probeCompanyModel({ ...body, protocol: 'openai-compatible' }, { fetchImpl: async () => new Response('data: {"unexpected":"body"}\n\n') })
      expect(malformed.reachable).toBe(false)
      const privateProtocol = await probeCompanyModel({ ...body, protocol: 'private' }, { fetchImpl: async () => new Response('data: {"type":"text_delta","text":"OK"}\n\n') })
      expect(privateProtocol.reachable).toBe(true)
      const huge = await probeCompanyModel({ ...body, protocol: 'openai-compatible' }, { fetchImpl: async () => new Response('x'.repeat(65_537)) })
      expect(huge.reachable).toBe(false)
      let calls = 0
      const controller = new AbortController(); controller.abort()
      expect((await probeCompanyModel({ ...body, protocol: 'openai-compatible' }, { signal: controller.signal, fetchImpl: async () => { calls++; return new Response() } })).reachable).toBe(false)
      expect(calls).toBe(0)
    } finally { await new Promise<void>((yes, no) => server.close((error) => error === undefined ? yes() : no(error))) }
  })
})
