import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { Client } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { CoreLocalModelSettings, createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

let postgres: PostgresContainer | undefined
let admin: Client | undefined
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let settings: CoreLocalModelSettings
let browser: Browser | undefined
let web: WebHost | undefined
let directory = ''
let appUrl = ''
let apiPort = 0
let probeUrl = ''
let probes = 0
const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
const workerErrors: string[] = []
const key = randomUUID()
const provider = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    probes++
    if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
  })
})
async function boot(port: number) {
  settings = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef, environment: { CORE_ENABLE_MODELS: 'false' } })
  const environment = await settings.loadEnvironment()
  const examples = loadCoreExamples({ targetScopeRef: scopeRef })
  composition = await createCoreLocalComposition({ databaseUrl: appUrl, objectDirectory: directory, scopeRef, examples,
    allowLocalOperator: true, modelsEnabled: environment['CORE_ENABLE_MODELS'] === 'true', jevEnabled: false, modelEnvironment: environment,
    onWorkerError: (error) => workerErrors.push(error instanceof Error ? error.name : typeof error) })
  api = createCoreApi({ ...composition.dependencies, modelSettings: settings })
  const address = await api.listen({ host: '127.0.0.1', port })
  apiPort = Number(new URL(address).port)
  return address
}
beforeAll(async () => {
  postgres = await startPostgresContainer()
  await runControlMigrations({ connectionString: postgres.adminUrl, migrationsDir: fileURLToPath(new URL('../../migrations/control', import.meta.url)) })
  admin = new Client({ connectionString: postgres.adminUrl }); await admin.connect()
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id,slug) VALUES ($1,$2)', [scopeRef.tenantId, `model-ui-${scopeRef.tenantId}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id,space_id,name) VALUES ($1,$2,$3)', [scopeRef.tenantId, scopeRef.spaceId, 'model UI acceptance'])
  const password = randomUUID().replaceAll('-', '')
  const statement = (await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L',$1::text) AS statement", [password])).rows[0]?.statement
  if (statement === undefined) throw new Error('No app role statement')
  await admin.query(statement)
  const url = new URL(postgres.adminUrl); url.username = 'ontology_app'; url.password = password; appUrl = url.href
  directory = await mkdtemp(join(tmpdir(), 'ontology-model-ui-'))
  await new Promise<void>((yes) => provider.listen(0, '127.0.0.1', yes))
  const providerAddress = provider.address()
  if (providerAddress === null || typeof providerAddress === 'string') throw new Error('Missing provider port')
  probeUrl = `http://127.0.0.1:${providerAddress.port}`
  web = await startWebHost(await boot(0), { bindDefaultProfile: false })
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  const errors: unknown[] = []
  for (const close of [() => browser?.close(), () => web?.close(), () => api?.close(), () => composition?.close(), () => admin?.end(),
    () => new Promise<void>((yes, no) => provider.close((error) => error === undefined ? yes() : no(error))), () => postgres?.stop()]) {
    try { await close() } catch (error) { errors.push(error) }
  }
  if (directory) {
    const target = resolve(directory)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}ontology-model-ui-`)) throw new Error('Refusing unowned cleanup')
    await rm(target, { recursive: true, force: true })
  }
  await record('model-ui-worker-diagnostics', workerErrors)
  expect(workerErrors).toEqual([])
  if (errors.length) throw new AggregateError(errors, 'Model UI cleanup failed')
})

it('configures, probes and assigns a model connection through the normal App and activates it after a real host restart', async () => {
  if (!browser || !web) throw new Error('Missing browser host')
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const pageErrors: string[] = []; page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await page.goto(web.origin)
    await page.getByTestId('open-model-settings').click()
    await page.getByTestId('ai-settings').waitFor()
    // The single-instance legacy surface is migrated to the catalogue once the host starts
    // (design §5.3): the compatibility tab refuses the old write surface instead of editing it.
    await page.getByTestId('ai-tab-legacy').click()
    await page.getByText('暂时无法读取配置', { exact: true }).waitFor()
    expect(await page.getByTestId('model-settings-form').count()).toBe(0)
    // The connection directory is the current configuration path.
    await page.getByTestId('ai-tab-connections').click()
    await page.getByTestId('connection-create').click()
    await page.getByTestId('connection-editor-form').waitFor()
    await page.getByLabel('连接名称 *', { exact: true }).fill('验收生成连接')
    await page.getByLabel('模型服务地址', { exact: true }).fill(probeUrl)
    await page.getByLabel('API 端点', { exact: true }).fill('/v1/chat/completions')
    await page.getByLabel('Core 平台模型 ID *', { exact: true }).fill('core-acceptance-generation')
    await page.getByLabel('服务商模型名称 *', { exact: true }).fill('controlled-probe-model')
    await page.getByLabel('API Key', { exact: true }).fill(key)
    await page.getByLabel('启用', { exact: true }).check()
    await page.getByTestId('connection-editor-test').click()
    await page.locator('[data-testid="connection-editor-test-result"][data-status="passed"]').waitFor()
    expect(probes).toBe(1)
    await page.getByTestId('connection-editor-save').click()
    await page.locator('[data-testid="connection-row"]', { hasText: '验收生成连接' }).waitFor()
    expect(await page.locator('body').innerText()).not.toContain(key)
    // Assign the saved connection as the space default, then confirm the effective projection.
    await page.getByTestId('ai-tab-assignments').click()
    await page.getByLabel('默认生成模型', { exact: true }).selectOption({ label: '验收生成连接' })
    await page.getByTestId('assignments-save').click()
    await page.getByText('分配已保存；新任务将使用新选择，进行中的任务保持原绑定。', { exact: true }).waitFor()
    await capture(page, 'model-ui-connection-assigned-1440')
    // Restart the real host; the catalogue and the assignment are durable, so generation is active.
    await api?.close(); await composition?.close()
    await boot(apiPort)
    await page.reload()
    await page.getByTestId('ai-settings').waitFor()
    await page.getByTestId('ai-tab-effective').click()
    await page.locator('[data-testid="effective-model"]').first().waitFor()
    const deployment = await (await fetch(`${web.origin}/api/v1/core/deployment`)).json() as unknown
    expect(deployment).toMatchObject({ data: { models: { generation: true, decision: false } } })
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1050 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await capture(page, `model-ui-active-${width}`)
    }
    expect(pageErrors).toEqual([])
  } catch (error) {
    await record('model-ui-config-failure', [JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), error: error instanceof Error ? error.message : String(error) })])
    await capture(page, 'model-ui-config-failure')
    throw error
  } finally { await page.close() }
})

it('opens the dedicated question page and explains each core feature without bypassing its prerequisites', async () => {
  if (!browser || !web) throw new Error('Missing browser host')
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  try {
    await page.goto(web.origin)
    await page.getByTestId('open-question-page').click()
    await page.getByTestId('query-panel').waitFor()
    expect(new URL(page.url()).searchParams.get('view')).toBe('query')
    expect(await page.getByTestId('function-guide').innerText()).toContain('项目正式数据')
    await capture(page, 'model-ui-question-window-1440')
    for (const view of ['start', 'ontology', 'projects', 'definitions', 'instances', 'packages', 'business', 'workbench', 'query', 'jobs', 'review', 'evidence', 'models']) {
      await page.goto(`${web.origin}/?view=${view}`)
      const guide = page.locator(`[data-testid="function-guide"][data-view="${view}"]`)
      await guide.waitFor()
      expect(await guide.innerText()).toContain('用途')
      expect(await guide.innerText()).toContain('开始前')
      expect(await guide.innerText()).toContain('完成后')
    }
    await page.setViewportSize({ width: 320, height: 1050 })
    await page.goto(`${web.origin}/?view=query`)
    await page.getByTestId('query-panel').waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await capture(page, 'model-ui-question-window-320')
  } finally { await page.close() }
})

it('keeps the configuration explanation visible for readonly access without disclosing credentials or allowing writes', async () => {
  if (!browser || !composition) throw new Error('Missing browser host')
  const readonly = createCoreApi({ ...composition.dependencies, allowLocalOperator: false, modelSettings: settings })
  const readonlyWeb = await startWebHost(await readonly.listen({ host: '127.0.0.1', port: 0 }), { bindDefaultProfile: false })
  const page = await browser.newPage()
  try {
    await page.goto(`${readonlyWeb.origin}/?view=models&aiTab=legacy`)
    await page.getByText('暂时无法读取配置', { exact: true }).waitFor()
    expect(await page.getByTestId('function-guide').isVisible()).toBe(true)
    expect(await page.getByTestId('model-settings-save').count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain(key)
    const response = await fetch(`${readonlyWeb.origin}/api/v1/core/model-settings`)
    expect(response.status).toBe(403)
  } finally { await page.close(); await readonlyWeb.close(); await readonly.close() }
})
