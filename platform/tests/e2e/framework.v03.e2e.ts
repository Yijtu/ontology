import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { WorkbenchClient } from '@ontology/app-web/client'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

// Framework acceptance uses the normal index.html and production Core composition, real PG and
// real Chromium. No responses or browser requests are mocked; models are explicitly disabled.
let postgres: PostgresContainer | undefined
let admin: Client | undefined
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let web: WebHost | undefined
let browser: Browser | undefined
let directory = ''
let client: WorkbenchClient
let workspaceId = ''
let appDatabaseUrl = ''
let closing = false
const workerDiagnostics: { readonly duringClose: boolean; readonly name: string; readonly code?: string; readonly message: string }[] = []
function recordWorkerError(error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  workerDiagnostics.push({ duringClose: closing, name: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }), message: error instanceof Error ? error.message : String(error) })
}

beforeAll(async () => {
  postgres = await startPostgresContainer()
  await runControlMigrations({ connectionString: postgres.adminUrl, migrationsDir: fileURLToPath(new URL('../../migrations/control', import.meta.url)) })
  admin = new Client({ connectionString: postgres.adminUrl })
  await admin.connect()
  const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `framework-${scopeRef.tenantId}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'framework'])
  const password = `framework_${randomUUID().replaceAll('-', '')}`
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [password])
  const sql = statement.rows[0]?.statement
  if (sql === undefined) throw new Error('application role password unavailable')
  await admin.query(sql)
  const database = new URL(postgres.adminUrl)
  database.username = 'ontology_app'
  database.password = password
  appDatabaseUrl = database.href
  directory = await mkdtemp(join(tmpdir(), 'ontology-framework-'))
  composition = await createCoreLocalComposition({ databaseUrl: database.href, objectDirectory: directory, scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: true, modelsEnabled: false, jevEnabled: false, onWorkerError: recordWorkerError })
  api = createCoreApi(composition.dependencies)
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  client = new WorkbenchClient({ baseUrl: origin })
  web = await startWebHost(origin, { bindDefaultProfile: false })
  browser = await chromium.launch({ headless: true })
}, 300_000)

afterAll(async () => {
  closing = true
  await browser?.close()
  await web?.close()
  await api?.close()
  await composition?.close()
  await admin?.end()
  if (directory !== '') await rm(directory, { recursive: true, force: true })
  await postgres?.stop()
  await record('gap-017-worker-diagnostic', workerDiagnostics.map((entry) => JSON.stringify(entry)))
  // The route-only run has no published facts. Its deliberate data-gap failure is distinct
  // from shutdown diagnostics; every other worker error remains an acceptance failure.
  expect(workerDiagnostics.filter((entry) => entry.duringClose || entry.name !== 'TypedDraftWriterError' || entry.code !== 'INSUFFICIENT_DATA')).toEqual([])
})

async function newPage(width = 1440): Promise<Page> {
  if (browser === undefined || web === undefined) throw new Error('framework environment unavailable')
  const page = await browser.newPage({ viewport: { width, height: 1050 } })
  await page.goto(web.origin)
  await page.waitForSelector('[data-testid="guide-home"]')
  await page.waitForSelector('[data-testid="context-workspace-loading"]', { state: 'hidden' })
  return page
}

async function openView(page: Page, view: string): Promise<void> {
  if (await page.getByRole('button', { name: '打开主导航' }).isVisible()) await page.getByRole('button', { name: '打开主导航' }).click()
  if (view === 'workbench') await page.getByText('高级设置', { exact: true }).click()
  await page.getByTestId(`tab-${view}`).click()
  await page.waitForFunction((value) => document.querySelector('.app')?.getAttribute('data-view') === value, view)
}

describe('professional product framework: real production host', () => {
  it('renders genuine empty state and responsive shell at four required widths', async () => {
    for (const width of [1440, 1024, 768, 390]) {
      const page = await newPage(width)
      try {
        expect(await page.getByText('从一个清晰的业务边界开始').isVisible()).toBe(true)
        expect(await page.getByText('还没有项目数据', { exact: true }).isVisible()).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await record(`gap-017-layout-${width}`, [await page.locator('.app__skip').evaluate((element) => JSON.stringify({ position: getComputedStyle(element).position, transform: getComputedStyle(element).transform, focus: element === document.activeElement, scrollY: window.scrollY }))])
        await capture(page, `gap-017-overview-${width}`)
        await openView(page, 'definitions')
        expect(await page.getByTestId('workspace-required').isVisible()).toBe(true)
        expect(new URL(page.url()).searchParams.get('view')).toBe('definitions')
        await page.reload()
        await page.waitForSelector('[data-testid="workspace-required"]')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      } finally { await page.close() }
    }
  })

  it('reads real workspaces, preserves deep context and guards unfinished input', async () => {
    const created = await client.createIndustryWorkspace({ namespace: 'framework-acceptance', displayName: '设备知识审核',
      boundary: { goals: ['审核设备定义'], included: [], excluded: [], applicability: {} },
      documentSetRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' } })
    workspaceId = created.workspace.workspaceId
    const page = await newPage()
    try {
      expect(await page.getByRole('table', { name: '当前本体工作区' }).textContent()).toContain('设备知识审核')
      await page.getByTestId('context-workspace-select').selectOption(workspaceId)
      await openView(page, 'definitions')
      await page.waitForSelector('[data-testid="definition-workbench"]')
      expect(new URL(page.url()).searchParams.get('workspace')).toBe(workspaceId)
      await capture(page, 'gap-017-context-definitions-1440')
      await openView(page, 'query')
      await page.waitForSelector('[data-testid="query-question"]')
      await page.getByTestId('query-question').fill('尚未提交的问题')
      await page.getByTestId('tab-start').click()
      expect(await page.getByRole('dialog', { name: '离开当前工作内容？' }).isVisible()).toBe(true)
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      expect(await page.getByTestId('query-question').inputValue()).toBe('尚未提交的问题')
      await page.getByTestId('core-scenario-select').selectOption({ index: 1 })
      await page.getByTestId('shell-discard-changes').click()
      expect(await page.getByTestId('query-question').inputValue()).toBe('')
      expect(new URL(page.url()).searchParams.has('workspace')).toBe(false)
      expect(await page.getByTestId('query-capability-note').textContent()).toContain('未启用')
      await page.reload()
      await page.waitForSelector('[data-testid="query-question"]')
      expect(await page.getByTestId('core-scenario-select').inputValue()).toBe(new URL(page.url()).searchParams.get('scenarioId'))
      await capture(page, 'gap-017-model-off-query-1440')
    } finally { await page.close() }
  })

  it('supports keyboard drawer trap, Escape, focus return and narrow navigation', async () => {
    const page = await newPage(390)
    try {
      const trigger = page.getByRole('button', { name: '查看上下文' })
      await trigger.focus()
      await page.keyboard.press('Enter')
      const close = page.getByRole('button', { name: '关闭当前工作上下文' })
      expect(await close.evaluate((element) => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Shift+Tab')
      expect(await page.getByText('高级：绑定标识', { exact: true }).evaluate((element) => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)
      await openView(page, 'query')
      await page.waitForSelector('[data-testid="query-question"]')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await capture(page, 'gap-017-model-off-query-390')
      await record('gap-017-framework', ['host=production createCoreLocalComposition', 'storage=real PostgreSQL', 'entry=index.html default URL', 'models=off', 'widths=1440,1024,768,390', 'drawer=keyboard trap/Escape/focus return', 'deep-links=view/workspace/scenario', 'dirty=retain or explicit discard'])
    } finally { await page.close() }
  })

  it('preserves browser entries when dirty Back/Forward is cancelled or accepted', async () => {
    const page = await newPage()
    const view = (expected: string) => page.waitForFunction((value) => document.querySelector('.app')?.getAttribute('data-view') === value, expected)
    const decision = () => page.getByRole('dialog', { name: '离开当前工作内容？' }).waitFor()
    try {
      const overviewUrl = page.url()
      await openView(page, 'query')
      const queryUrl = page.url()
      await page.getByTestId('query-question').fill('返回时保留的问题')
      await page.goBack()
      await decision()
      expect(page.url()).toBe(queryUrl)
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      expect(await page.getByTestId('query-question').inputValue()).toBe('返回时保留的问题')
      await page.goBack()
      await decision()
      await page.getByTestId('shell-discard-changes').click()
      await view('start')
      expect(page.url()).toBe(overviewUrl)
      await page.goForward()
      await view('query')
      expect(page.url()).toBe(queryUrl)
      await openView(page, 'definitions')
      const definitionsUrl = page.url()
      await page.goBack()
      await view('query')
      await page.getByTestId('query-question').fill('前进时保留的问题')
      await page.goForward()
      await decision()
      expect(page.url()).toBe(queryUrl)
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      expect(await page.getByTestId('query-question').inputValue()).toBe('前进时保留的问题')
      await page.goForward()
      await decision()
      await page.getByTestId('shell-discard-changes').click()
      await view('definitions')
      expect(page.url()).toBe(definitionsUrl)
      await page.goBack()
      await view('query')
      await page.goBack()
      await view('start')
      expect(page.url()).toBe(overviewUrl)
    } finally { await page.close() }
  })

  it('resolves bound-run and invalid-view URLs identically on Back/Forward/reload', async () => {
    if (browser === undefined || web === undefined) throw new Error('framework environment unavailable')
    const deployment = await client.getCoreDeployment()
    const scenario = deployment.scenarios[0]
    if (scenario === undefined) throw new Error('no real scenario available')
    const run = await client.createRun({ profileRef: scenario.profileRef, question: 'facts:facility_id', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false } })
    await expect.poll(async () => ['published', 'cancelled', 'failed', 'blocked'].includes((await client.getRun(run.runId)).state), { timeout: 30_000, interval: 100 }).toBe(true)
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
    const view = (expected: string) => page.waitForFunction((value) => document.querySelector('.app')?.getAttribute('data-view') === value, expected)
    try {
      // Cold reloads used to expose the shell before passive history listeners were installed.
      // Repeated native traversal exercises that timing window without sleeps or fake popstate.
      for (const extra of Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? '' : '&view=unknown-view')) {
        const target = `${web.origin}/?run=${run.runId}${extra}`
        await page.goto(target)
        await view('workbench')
        await page.getByTestId('bound-run-id').waitFor()
        expect(await page.getByTestId('bound-run-id').textContent()).toBe(run.runId)
        await openView(page, 'query')
        await page.goBack()
        await view('workbench')
        expect(page.url()).toBe(target)
        await page.reload()
        await view('workbench')
        await page.goForward()
        await view('query')
        await page.reload()
        await view('query')
        await page.goBack()
        await view('workbench')
        expect(page.url()).toBe(target)
      }
      await record('gap-017-history', ['Back/Forward=real browser traversal', 'dirty cancellation=entry and index preserved', 'dirty acceptance=original traversal replayed', 'bound run=real API-created persisted run', 'route resolution=shared startup/history, including invalid view and reload'])
    } finally { await page.close() }
  })

  it('keeps the real read-only deployment and startup failure path usable', async () => {
    if (postgres === undefined || admin === undefined || browser === undefined) throw new Error('framework environment unavailable')
    const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
    await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `readonly-${scopeRef.tenantId}`])
    await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'readonly'])
    // Reuse the migrated application connection, while keeping the two host scopes separate.
    const readOnlyComposition = await createCoreLocalComposition({ databaseUrl: appDatabaseUrl, objectDirectory: join(directory, 'readonly'), scopeRef,
      examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: false, modelsEnabled: false, jevEnabled: false })
    const readOnlyApi = createCoreApi(readOnlyComposition.dependencies)
    let readOnlyWeb: WebHost | undefined
    let failingWeb: WebHost | undefined
    const page = await browser.newPage({ viewport: { width: 390, height: 1050 } })
    try {
      const origin = await readOnlyApi.listen({ host: '127.0.0.1', port: 0 })
      readOnlyWeb = await startWebHost(origin, { bindDefaultProfile: false })
      await page.goto(readOnlyWeb.origin)
      await page.waitForSelector('[data-testid="guide-home"]')
      expect(await page.getByTestId('core-deployment-mode').textContent()).toContain('只读')
      expect(await page.getByText('当前为只读访问').isVisible()).toBe(true)
      await capture(page, 'gap-017-readonly-390')
      failingWeb = await startWebHost('http://127.0.0.1:1', { bindDefaultProfile: false })
      await page.goto(failingWeb.origin)
      await page.getByRole('button', { name: '重新连接' }).waitFor()
      expect(await page.getByText('工作空间暂不可用', { exact: true }).isVisible()).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await capture(page, 'gap-017-startup-failure-390')
      await page.getByRole('button', { name: '重新连接' }).click()
      await page.getByRole('button', { name: '重新连接' }).waitFor()
    } finally {
      await page.close()
      await failingWeb?.close()
      await readOnlyWeb?.close()
      await readOnlyApi.close()
      await readOnlyComposition.close()
    }
  })
})
