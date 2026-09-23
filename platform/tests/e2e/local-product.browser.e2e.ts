import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { startLocalProduct } from '@ontology/app-api'
import type { PublishedAnswer } from '@ontology/contracts'
import type { LocalPlanDetailView } from '../../apps/web/src/api/client'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { startWebHost } from './web-host'
import type { WebHost } from './web-host'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control/', import.meta.url))
let container: PostgresContainer
let app: Awaited<ReturnType<typeof startLocalProduct>>
let web: WebHost
let browser: Browser
let apiUrl: string
let workDir: string
let appDatabaseUrl: string
let tenantId: string
let spaceId: string
const operatorToken = `operator-${randomBytes(12).toString('hex')}`

function appUrlFor(adminUrl: string, password: string): string {
  const url = new URL(adminUrl)
  url.username = 'ontology_app'
  url.password = password
  return url.toString()
}

beforeAll(async () => {
  container = await startPostgresContainer()
  tenantId = randomUUID()
  spaceId = randomUUID()
  const password = `local_product_${randomBytes(10).toString('hex')}`
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  const admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  try {
    const roleStatement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [password])
    const statement = roleStatement.rows[0]?.statement
    if (statement === undefined) throw new Error('could not configure local application role')
    await admin.query(statement)
    await admin.query('INSERT INTO agent_platform.tenants (tenant_id,slug) VALUES ($1,$2)', [tenantId, `local-${tenantId}`])
    await admin.query('INSERT INTO agent_platform.spaces (tenant_id,space_id,name) VALUES ($1,$2,$3)', [tenantId, spaceId, 'browser-local-product'])
  } finally {
    await admin.end()
  }
  appDatabaseUrl = appUrlFor(container.adminUrl, password)
  workDir = await mkdtemp(join(tmpdir(), `ontology-local-product-${randomBytes(3).toString('hex')}-`))
  process.env['DATABASE_URL'] = appDatabaseUrl
  process.env['ONTOLOGY_TENANT_ID'] = tenantId
  process.env['ONTOLOGY_SPACE_ID'] = spaceId
  process.env['ONTOLOGY_BLOB_DIR'] = join(workDir, 'blobs')
  process.env['ONTOLOGY_LOCAL_OPERATOR_TOKEN'] = operatorToken
  process.env['PORT'] = '0'
  app = await startLocalProduct()
  apiUrl = app.origin
  web = await startWebHost(apiUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await app?.close().catch(() => undefined)
  await container?.stop()
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true })
}, 120_000)

describe('local product browser journey', () => {
  it('runs through POST /runs, computes and verifies an answer, then reads the same answer after API restart', async () => {
    const scopeResponse = await fetch(`${apiUrl}/api/v1/runs/scope?profileId=home-energy-demo-long&version=1.0.0`)
    const scopeView = await scopeResponse.json() as { data?: { tasks?: readonly { taskId: string }[] } }
    expect(scopeView.data?.tasks?.map((task) => task.taskId)).toContain('energy.plan-candidate')
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await page.goto(`${web.origin}/`)
    await page.waitForSelector('[data-testid="query-ask"]')
    expect(await page.locator('[data-testid="tab-query"]').count()).toBe(1)
    await page.selectOption('select', 'home-energy-demo-long')
    await page.waitForFunction(() => Array.from(document.querySelectorAll('select')).some((element) => Array.from(element.options).some((option) => option.value === 'energy.plan-candidate')))
    await page.locator('select').filter({ has: page.locator('option[value="energy.plan-candidate"]') }).selectOption('energy.plan-candidate')
    await page.fill('[data-testid="query-question"]', '明天如何安排充放电，在满足备电约束下尽量降低电费？')
    await page.fill('input[type="number"]', '2')
    await page.locator('select').filter({ has: page.locator('option[value="overcast"]') }).selectOption('overcast')
    const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/runs') && response.request().method() === 'POST')
    await page.click('[data-testid="query-ask"]')
    const created = await createResponse
    if (created.status() !== 202) throw new Error(`POST /runs returned ${created.status()}: ${await created.text()}`)
    const createdBody = await created.json() as { data: { runId: string } }
    const runId = createdBody.data.runId
    await expect.poll(async () => {
      const response = await fetch(`${apiUrl}/api/v1/runs/${runId}`)
      return (await response.json() as { data: { state: string } }).data.state
    }, { timeout: 60_000 }).toMatch(/^(published|failed|blocked)$/u)
    const runStateResponse = await fetch(`${apiUrl}/api/v1/runs/${runId}`)
    const runState = (await runStateResponse.json() as { data: { state: string } }).data.state
    if (runState !== 'published') {
      const eventResponse = await fetch(`${apiUrl}/api/v1/runs/${runId}/events`)
      throw new Error(`run ended ${runState}; events: ${await eventResponse.text()}`)
    }
    await page.waitForSelector('[data-testid="answer-claim"]', { timeout: 20_000 })
    const before = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/runs/${id}/answer`)
      if (!response.ok) throw new Error(`answer request returned ${response.status}`)
      return (await response.json() as { data: PublishedAnswer }).data
    }, runId)
    expect(before.blocks.every((block) => typeof block === 'object' && block !== null && 'kind' in block && block.kind === 'claim')).toBe(true)
    expect(before.claims.map((claim) => claim.predicate)).toEqual(expect.arrayContaining(['soc_percent', 'candidate_total_cost', 'baseline_total_cost', 'terminal_energy_kwh', 'reserve_satisfied']))
    expect(before.limitations.join(' ')).toContain('合成数据')
    expect(before.limitations.join(' ')).toContain('不会连接或控制真实设备')
    expect(await page.locator('[data-testid="answer-claim"]').count()).toBe(5)
    const planResponse = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/runs/${id}/plan`)
      return { status: response.status, body: await response.json() as { data?: LocalPlanDetailView; error?: { message: string } } }
    }, runId)
    expect(planResponse.status, planResponse.body.error?.message).toBe(200)
    await page.waitForSelector('[data-testid="plan-strategy"]', { timeout: 20_000 })
    const plan = planResponse.body.data
    if (plan === undefined) throw new Error('published plan has no detail payload')
    expect(plan.answerId).toBe(before.answerId)
    expect(plan.dataMode).toBe('simulation')
    expect(plan.optimality).toBe('best_of_tested_candidates')
    expect(plan.intervals).toHaveLength(96)
    expect(plan.intervals[0]?.startUtc).toBeDefined()
    expect(plan.intervals[0]?.energyEndKwh).toEqual(expect.any(Number))
    expect(plan.sourceEvidenceRef.id).toBeDefined()
    await page.locator('[data-testid="plan-trajectory"]').locator('summary').click()
    expect(await page.locator('[data-testid="plan-interval"]').count()).toBe(96)

    await app.close()
    app = await startLocalProduct()
    apiUrl = app.origin
    const after = await fetch(`${app.origin}/api/v1/runs/${runId}/answer`)
    expect(after.status).toBe(200)
    const persisted = (await after.json() as { data: PublishedAnswer }).data
    expect(persisted.answerId).toBe(before.answerId)
    expect(persisted.contentHash).toBe(before.contentHash)
    const persistedPlan = await fetch(`${app.origin}/api/v1/runs/${runId}/plan`)
    expect(persistedPlan.status).toBe(200)
    expect((await persistedPlan.json() as { data: LocalPlanDetailView }).data.resultRef.digest).toBe(plan.resultRef.digest)

    const createRun = async (question: string, siteRef = 'synthetic-home-1', profileId = 'home-energy-demo-wide', taskId = 'energy.soc-mean', taskInput: Record<string, unknown> = { siteRef }) => {
      const response = await fetch(`${app.origin}/api/v1/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `local-e2e-${randomUUID()}` },
        body: JSON.stringify({ profileRef: { id: profileId, version: '1.0.0' }, question, context: { timeZone: 'Asia/Shanghai', taskId, taskInput }, preferences: { route: 'auto', allowWeb: false } }),
      })
      expect(response.status).toBe(202)
      return (await response.json() as { data: { runId: string } }).data.runId
    }
    const socOnlyRun = await createRun('synthetic-home-1 的 SOC 均值是多少？')
    const socOnlyAnswerResponse = await fetch(`${apiUrl}/api/v1/runs/${socOnlyRun}/answer`)
    expect(socOnlyAnswerResponse.status).toBe(200)
    const socOnly = (await socOnlyAnswerResponse.json() as { data: PublishedAnswer }).data
    expect(socOnly.claims).toHaveLength(1)
    expect(socOnly.claims[0]?.predicate).toBe('soc_percent')
    expect(socOnly.claims[0]?.value).toEqual({ value: 45, unit: '%' })
    expect((await fetch(`${apiUrl}/api/v1/runs/${socOnlyRun}/plan`)).status).toBe(404)

    const unsupportedRun = await createRun('电池容量是多少？')
    expect((await fetch(`${apiUrl}/api/v1/runs/${unsupportedRun}/answer`)).status).toBe(404)
    const unsupportedState = await fetch(`${apiUrl}/api/v1/runs/${unsupportedRun}`)
    expect((await unsupportedState.json() as { data: { state: string } }).data.state).toBe('failed')

    const emptySiteRun = await createRun('unknown-site 的 SOC 均值是多少？', 'unknown-site')
    expect((await fetch(`${apiUrl}/api/v1/runs/${emptySiteRun}/answer`)).status).toBe(404)
    const emptySiteState = await fetch(`${apiUrl}/api/v1/runs/${emptySiteRun}`)
    expect((await emptySiteState.json() as { data: { state: string } }).data.state).toBe('failed')

    const noDocumentRun = await createRun('道路巡检需要多久一次？', 'synthetic-home-1', 'local-policy-documents', 'documents.policy-quote', {})
    expect((await fetch(`${apiUrl}/api/v1/runs/${noDocumentRun}/answer`)).status).toBe(404)
    const deniedImport = await fetch(`${apiUrl}/api/v1/operator/documents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '无权限导入', content: '道路设施每年巡检一次。', mediaType: 'text/plain' }) })
    expect(deniedImport.status).toBe(403)
    const imported = await fetch(`${apiUrl}/api/v1/operator/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ title: '临时合成道路巡检说明', content: '在此虚构的演示文本中，北区道路设施每年进行两次例行巡检。此内容仅用于测试引文定位。', mediaType: 'text/plain' }),
    })
    expect(imported.status, await imported.text()).toBe(201)
    const secondDocument = await fetch(`${apiUrl}/api/v1/operator/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ title: '第二份合成文件', content: '另一个文件，应该被 collection 限制拒绝。', mediaType: 'text/markdown' }),
    })
    expect(secondDocument.status).toBe(409)
    const transportRun = await createRun('north 区有哪些设施待巡检？', 'synthetic-home-1', 'transport-government-local', 'transport.inspection-list', { district: 'north' })
    const transportAnswerResponse = await fetch(`${apiUrl}/api/v1/runs/${transportRun}/answer`)
    expect(transportAnswerResponse.status).toBe(200)
    const transportAnswer = (await transportAnswerResponse.json() as { data: PublishedAnswer }).data
    expect(transportAnswer.assertions?.map((assertion) => assertion.predicate)).toEqual(expect.arrayContaining(['facility_id', 'inspection_state', 'district']))
    const wrongTransportIntent = await createRun('north 区的巡检周期是多少？', 'synthetic-home-1', 'transport-government-local', 'transport.inspection-list', { district: 'north' })
    expect((await fetch(`${apiUrl}/api/v1/runs/${wrongTransportIntent}/answer`)).status).toBe(404)
    const documentRun = await createRun('虚构演示文本中北区道路设施的例行巡检频率是什么？', 'synthetic-home-1', 'local-policy-documents', 'documents.policy-quote', {})
    const documentAnswerResponse = await fetch(`${apiUrl}/api/v1/runs/${documentRun}/answer`)
    expect(documentAnswerResponse.status).toBe(200)
    const documentAnswer = (await documentAnswerResponse.json() as { data: PublishedAnswer }).data
    expect(documentAnswer.assertions?.some((assertion) => assertion.kind === 'document_quote' && assertion.precision === 'exact' && assertion.quote.includes('每年进行两次'))).toBe(true)

    await app.close()
    app = await startLocalProduct()
    apiUrl = app.origin
    const restoredDocumentAnswer = await fetch(`${apiUrl}/api/v1/runs/${documentRun}/answer`)
    expect(restoredDocumentAnswer.status).toBe(200)
    expect((await restoredDocumentAnswer.json() as { data: PublishedAnswer }).data.contentHash).toBe(documentAnswer.contentHash)

    const crossProfileTask = await fetch(`${apiUrl}/api/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `local-e2e-${randomUUID()}` },
      body: JSON.stringify({ profileRef: { id: 'home-energy-demo-wide', version: '1.0.0' }, question: 'north 区有哪些设施待巡检？', context: { timeZone: 'Asia/Shanghai', taskId: 'transport.inspection-list', taskInput: { district: 'north' }, sourceRefs: ['local-policy-library'] }, preferences: { route: 'auto', allowWeb: false } }),
    })
    expect(crossProfileTask.status).not.toBe(202)
    await page.close()
  })
})
