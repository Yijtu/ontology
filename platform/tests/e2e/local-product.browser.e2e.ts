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
import type { PublishedAnswer, ResourceRef } from '@ontology/contracts'
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
let operatorSqlUrl: string
let businessDatabaseName: string
let tenantId: string
let spaceId: string
const operatorToken = `operator-${randomBytes(12).toString('hex')}`

function appUrlFor(adminUrl: string, password: string): string {
  const url = new URL(adminUrl)
  url.username = 'ontology_app'
  url.password = password
  return url.toString()
}

function databaseUrlFor(baseUrl: string, database: string, username: string, password: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  url.username = username
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
    const facilityEntityId = 'facility-entity-001'
    await admin.query(`INSERT INTO agent_platform.identity_entities (tenant_id,space_id,entity_id,object_id,identity_scope_id,display_name,state,revision,recorded_at,updated_at)
      VALUES ($1,$2,$3,'road_facility','facility-key-within-district','Bridge N 01','confirmed',1,now(),now())`, [tenantId, spaceId, facilityEntityId])
    businessDatabaseName = `customer_${tenantId.replaceAll('-', '').slice(0, 12)}`
    const businessRolePassword = `readonly_${randomBytes(10).toString('hex')}`
    await admin.query(`CREATE DATABASE ${businessDatabaseName}`)
    const readerRoleStatement = await admin.query<{ statement: string }>("SELECT format('CREATE ROLE ontology_customer_reader LOGIN PASSWORD %L', $1::text) AS statement", [businessRolePassword])
    const createRoleSql = readerRoleStatement.rows[0]?.statement
    if (createRoleSql === undefined) throw new Error('could not create the read-only business role')
    await admin.query(createRoleSql)
    const businessAdminConfig = new URL(container.adminUrl)
    businessAdminConfig.pathname = `/${businessDatabaseName}`
    const businessAdminUrl = businessAdminConfig.toString()
    const businessAdmin = new Client({ connectionString: businessAdminUrl })
    await businessAdmin.connect()
    try {
      await businessAdmin.query(`CREATE TABLE public.ontology_facilities (
        facility_key text NOT NULL, district_code text NOT NULL, condition_code text NOT NULL,
        entity_id text NOT NULL, object_id text NOT NULL, identity_scope_id text NOT NULL, native_id text NOT NULL,
        display_name text NOT NULL, normalized_name text NOT NULL, alias text, alias_normalized text,
        alias_confirmed boolean NOT NULL, alias_valid_from timestamptz, alias_valid_to timestamptz,
        site text, entity_type text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
        tenant_id uuid NOT NULL, space_id uuid NOT NULL
      )`)
      await businessAdmin.query(`INSERT INTO public.ontology_facilities VALUES
        ('bridge-n-01','north','needs_inspection','facility-entity-001','road_facility','facility-key-within-district','bridge-n-01',
         'Bridge N 01','bridge n 01',NULL,NULL,false,NULL,NULL,'north-yard','road_facility','2020-01-01T00:00:00Z',NULL,$1,$2)`, [tenantId, spaceId])
      await businessAdmin.query(`GRANT CONNECT ON DATABASE ${businessDatabaseName} TO ontology_customer_reader`)
      await businessAdmin.query('GRANT USAGE ON SCHEMA public TO ontology_customer_reader')
      await businessAdmin.query('GRANT SELECT ON public.ontology_facilities TO ontology_customer_reader')
    } finally {
      await businessAdmin.end()
    }
    operatorSqlUrl = databaseUrlFor(container.adminUrl, businessDatabaseName, 'ontology_customer_reader', businessRolePassword)
  } finally {
    await admin.end()
  }
  appDatabaseUrl = appUrlFor(container.adminUrl, password)
  workDir = await mkdtemp(join(tmpdir(), `ontology-local-product-${randomBytes(3).toString('hex')}-`))
  process.env['DATABASE_URL'] = appDatabaseUrl
  process.env['ONTOLOGY_OPERATOR_SQL_URL'] = operatorSqlUrl
  process.env['ONTOLOGY_OPERATOR_SQL_SCHEMA'] = 'public'
  process.env['ONTOLOGY_OPERATOR_SQL_RELATION'] = 'ontology_facilities'
  process.env['ONTOLOGY_OPERATOR_SQL_URL'] = operatorSqlUrl
  process.env['ONTOLOGY_OPERATOR_SQL_SCHEMA'] = 'public'
  process.env['ONTOLOGY_OPERATOR_SQL_RELATION'] = 'ontology_facilities'
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
  it('publishes the 35% Anker baseline plan from real SOC evidence', async () => {
    const mismatchedScenarioResponse = await fetch(`${apiUrl}/api/v1/simulations/inputs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ reserveSocPercent: 20, weatherScenario: 'sunny' }),
    })
    expect(mismatchedScenarioResponse.status).toBe(201)
    const mismatchedScenario = (await mismatchedScenarioResponse.json() as { data: { inputRef: ResourceRef } }).data
    const mismatchedResponse = await fetch(`${apiUrl}/api/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ profileRef: { id: 'home-energy-demo-long', version: '1.0.0' }, question: '为家庭储能能源系统生成满足备电目标的确定性充放电计划。', context: { timeZone: 'Asia/Shanghai', taskId: 'energy.plan-candidate', taskInput: { siteRef: 'synthetic-home-1', scenarioRef: JSON.stringify(mismatchedScenario.inputRef), backupRequirementKwh: 2, weatherScenario: 'sunny' } }, preferences: { route: 'auto', allowWeb: false } }),
    })
    expect(mismatchedResponse.status).toBe(202)
    const mismatchedRunId = ((await mismatchedResponse.json()) as { data: { runId: string } }).data.runId
    let mismatchFailed = false
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if ((await fetch(`${apiUrl}/api/v1/runs/${mismatchedRunId}/answer`)).status === 404) { mismatchFailed = true; break }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(mismatchFailed).toBe(true)
    expect(await (await fetch(`${apiUrl}/api/v1/runs/${mismatchedRunId}/events`)).text()).toContain('VERIFICATION_FAILED')

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${web.origin}/?profileId=home-energy-demo-long&profileVersion=1.0.0&view=energy`)
    await page.waitForSelector('[data-testid="build-scenario"]')
    expect(await page.locator('[data-testid="backup-requirement"]').getAttribute('max')).toBe('100')
    await page.click('[data-testid="build-scenario"]')
    await page.waitForSelector('[data-testid="scenario-summary"]')
    let publishedRunId = ''
    page.on('response', async (response) => {
      if (response.request().method() !== 'POST' || !response.url().endsWith('/api/v1/runs')) return
      try { publishedRunId = ((await response.json()) as { data: { runId: string } }).data.runId } catch { /* preserve the assertion below */ }
    })
    await page.click('[data-testid="request-plan"]')
    try { await page.waitForSelector('[data-testid="plan-verified"][data-verified="true"]', { timeout: 20_000 }) }
    catch {
      const events = publishedRunId === '' ? 'no run response was captured' : await (await fetch(`${apiUrl}/api/v1/runs/${publishedRunId}/events`)).text()
      throw new Error(`Anker plan did not publish: ${await page.locator('body').innerText()}\nrunEvents=${events}`)
    }
    expect(await page.textContent('[data-testid="plan-selected-strategy"]')).not.toContain('无可行候选')
    await page.close()
  }, 300_000)

  it('replans from the observed Virtual SOLIX state for afternoon cloud and ReserveSOC 60%', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${web.origin}/?profileId=home-energy-demo-long&profileVersion=1.0.0&view=energy`)
    await page.waitForSelector('[data-testid="build-scenario"]')
    await page.waitForSelector('[data-testid="persisted-plan-versions"]')
    const initialState = await page.locator('[data-testid="virtual-solix-final-state"]').count()
    expect(initialState).toBe(0)

    await page.selectOption('[data-testid="weather-scenario"]', 'afternoon_overcast')
    await page.click('[data-testid="build-scenario"]')
    await page.waitForSelector('[data-testid="scenario-summary"]')
    const b1Revision = await page.locator('[data-testid="scenario-start-state"]').textContent()
    await page.click('[data-testid="request-plan"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="plan-verified"][data-verified="true"]').length > 0)
    await page.waitForSelector('[data-testid="persisted-plan-diff"]')
    expect(await page.textContent('[data-testid="diff-weather"]')).toContain('anker_base → afternoon_overcast')
    const pvDelta = await page.locator('[data-testid="diff-pv"]').textContent()
    expect(Number(pvDelta?.match(/Δ\s*(-?\d+(?:\.\d+)?)/u)?.[1])).toBeLessThan(0)
    expect(await page.locator('[data-testid="persisted-plan-version"][data-status="Superseded"]').count()).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-testid="persisted-plan-version"][data-status="Selected"]').count()).toBe(1)
    expect(await page.locator('[data-testid="diff-cause-trace"] li').count()).toBeGreaterThanOrEqual(2)
    const versionResponse = await fetch(`${apiUrl}/api/v1/energy/plan-versions`)
    const versionData = (await versionResponse.json()) as { data: { versions: readonly { status: string; detail: { intervals: readonly { pvAvailableKw: number }[] } }[] } }
    const baseVersion = versionData.data.versions.find((version) => version.status === 'Superseded')
    const cloudyVersion = versionData.data.versions.find((version) => version.status === 'Selected')
    expect(baseVersion?.detail.intervals).toHaveLength(96)
    expect(cloudyVersion?.detail.intervals).toHaveLength(96)
    for (let slot = 0; slot < 48; slot += 1) expect(cloudyVersion?.detail.intervals[slot]?.pvAvailableKw).toBe(baseVersion?.detail.intervals[slot]?.pvAvailableKw)
    const afternoonPvBefore = baseVersion?.detail.intervals.slice(48).reduce((sum, item) => sum + item.pvAvailableKw, 0) ?? 0
    const afternoonPvAfter = cloudyVersion?.detail.intervals.slice(48).reduce((sum, item) => sum + item.pvAvailableKw, 0) ?? 0
    expect(afternoonPvAfter).toBeLessThan(afternoonPvBefore)

    await page.fill('[data-testid="backup-requirement"]', '60')
    await page.selectOption('[data-testid="reserve-window"]', '68')
    await page.click('[data-testid="build-scenario"]')
    await page.waitForSelector('[data-testid="scenario-summary"]')
    const c1Start = await page.locator('[data-testid="scenario-start-state"]').textContent()
    expect(b1Revision).toContain('35.0% SOC')
    expect(b1Revision).toContain('revision 0')
    expect(c1Start).toContain('35.0% SOC')
    expect(c1Start).toContain('revision 0')
    await page.click('[data-testid="request-plan"]')
    try { await page.waitForFunction(() => document.querySelectorAll('[data-testid="plan-version"]').length >= 2, undefined, { timeout: 25_000 }) }
    catch { throw new Error(`C1 plan did not become visible (phase=${await page.locator('.energy').getAttribute('data-phase')}, count=${await page.locator('[data-testid="plan-version"]').count()}): ${await page.locator('body').innerText()}`) }
    await page.waitForSelector('[data-testid="diff-reserve"]')
    const infeasible = await page.locator('[data-testid="plan-version-status"]').last().textContent()
    expect(Number(c1Start?.match(/([0-9]+(?:\.[0-9]+)?)% SOC/u)?.[1] ?? 100)).toBe(35)
    expect(infeasible).toContain('feasible')
    expect(await page.textContent('[data-testid="diff-reserve"]')).toContain('20% → 60%')
    expect(await page.textContent('[data-testid="diff-reserve-window"]')).toContain('slot 0 → slot 68')
    expect(await page.locator('[data-testid="diff-cost"]').count()).toBe(1)
    expect(await page.locator('[data-testid="persisted-plan-version"][data-status="Selected"]').count()).toBe(1)
    const versionsResponse = await fetch(`${apiUrl}/api/v1/energy/plan-versions`)
    const versionsData = (await versionsResponse.json() as { data: { versions: readonly { status: string; detail: { reserveSocPercent: number; intervals: readonly { dischargeKw: number }[] } }[] } }).data
    const c1Version = versionsData.versions.find((version) => version.status === 'Selected')
    const priorVersion = versionsData.versions.find((version) => version.detail.reserveSocPercent === 20 && version.status === 'Superseded')
    expect(c1Version?.detail.reserveSocPercent).toBe(60)
    const priorEveningDischarge = priorVersion?.detail.intervals.slice(68).reduce((sum, item) => sum + item.dischargeKw, 0) ?? 0
    const c1EveningDischarge = c1Version?.detail.intervals.slice(68).reduce((sum, item) => sum + item.dischargeKw, 0) ?? 0
    expect(c1EveningDischarge).toBeLessThanOrEqual(priorEveningDischarge)
    await page.close()
  }, 300_000)

  it('executes only the selected same-state plan and starts the next horizon at simulated midnight', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${web.origin}/?profileId=home-energy-demo-long&profileVersion=1.0.0&view=energy`)
    await page.waitForSelector('[data-testid="build-scenario"]')
    await page.click('[data-testid="build-scenario"]')
    await page.waitForSelector('[data-testid="scenario-summary"]')
    const start = await page.locator('[data-testid="scenario-start-state"]').textContent()
    expect(start).toContain('35.0% SOC')
    expect(start).toContain('revision 0')
    await page.click('[data-testid="request-plan"]')
    await page.waitForSelector('[data-testid="plan-verified"][data-verified="true"]')
    await page.click('[data-testid="request-simulation-execution"]')
    await page.waitForSelector('[data-testid="execution-step-count"]')
    expect(await page.locator('[data-testid="execution-step"]').count()).toBe(96)
    expect(await page.locator('[data-testid="execution-step"]').first().textContent()).toContain('Requested → Accepted → Observed')
    const executionId = await page.locator('[data-testid="execution-record"]').getAttribute('data-execution-id')
    if (executionId === null) throw new Error('execution id is not available')
    const executionResponse = await fetch(`${apiUrl}/api/v1/executions/${executionId}`)
    expect(executionResponse.status).toBe(200)
    const execution = (await executionResponse.json() as { data: { finalState: { revision: number; energyKwh: number } } }).data
    expect(execution.finalState.revision).toBe(96)
    const stateResponse = await fetch(`${apiUrl}/api/v1/virtual-solix/state`)
    expect(stateResponse.status).toBe(200)
    const state = (await stateResponse.json() as { data: { energyKwh: number; revision: number; simulatedAt: string; stateRef?: ResourceRef } }).data
    expect(state.revision).toBe(96)
    expect(state.energyKwh).toBe(execution.finalState.energyKwh)
    expect(state.stateRef?.kind).toBe('artifact')
    const selectedBeforeReplan = (await (await fetch(`${apiUrl}/api/v1/energy/plan-versions`)).json() as { data: { selected?: { scenarioRef: ResourceRef } } }).data.selected
    if (selectedBeforeReplan === undefined) throw new Error('the executed plan has no persisted selected version')
    const staleRun = await fetch(`${apiUrl}/api/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        profileRef: { id: 'home-energy-demo-long', version: '1.0.0' },
        question: '为家庭储能能源系统生成满足备电目标的确定性充放电计划。',
        context: { timeZone: 'Asia/Shanghai', taskId: 'energy.plan-candidate', taskInput: {
          siteRef: 'virtual-solix-1', scenarioRef: JSON.stringify(selectedBeforeReplan.scenarioRef),
          backupRequirementKwh: 2, reserveWindowStartSlot: 0, weatherScenario: 'anker_base',
        } }, preferences: { route: 'auto', allowWeb: false },
      }),
    })
    expect(staleRun.status).toBe(400)
    expect((await staleRun.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
    const nextScenarioResponse = await fetch(`${apiUrl}/api/v1/simulations/inputs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ reserveSocPercent: 20, weatherScenario: 'anker_base' }),
    })
    expect(nextScenarioResponse.status).toBe(201)
    const nextScenario = (await nextScenarioResponse.json() as { data: { horizon: { start: string }; initialEnergyKwh: number; stateRevision: number; parentPlanRef?: ResourceRef } }).data
    expect(nextScenario.horizon.start).toBe(state.simulatedAt)
    expect(nextScenario.initialEnergyKwh).toBe(state.energyKwh)
    expect(nextScenario.stateRevision).toBe(state.revision)
    expect(nextScenario.parentPlanRef).toBeDefined()
    await page.selectOption('[data-testid="weather-scenario"]', 'afternoon_overcast')
    await page.click('[data-testid="build-scenario"]')
    await page.waitForSelector('[data-testid="scenario-summary"]')
    await page.click('[data-testid="request-plan"]')
    let crossDayRunId = ''
    let planSelectionResponse = ''
    page.on('response', async (response) => {
      if (response.request().method() !== 'POST') return
      if (response.url().endsWith('/api/v1/runs')) { try { crossDayRunId = ((await response.json()) as { data: { runId: string } }).data.runId } catch { /* retain failure context */ } }
      if (response.url().endsWith('/api/v1/energy/plan-versions/select')) { planSelectionResponse = `${response.status()} ${await response.text()}` }
    })
    try { await page.waitForFunction(() => document.querySelectorAll('[data-testid="plan-version"]').length >= 2, undefined, { timeout: 25_000 }) }
    catch {
      const events = crossDayRunId === '' ? 'no new plan run was posted' : await (await fetch(`${apiUrl}/api/v1/runs/${crossDayRunId}/events`)).text()
      const history = (await (await fetch(`${apiUrl}/api/v1/energy/plan-versions`)).json() as { data: { versions: readonly { status: string; runId: string; planRef: ResourceRef; parentPlanRef?: ResourceRef }[] } }).data.versions
      const selected = history.find((entry) => entry.status === 'Selected')
      const runInfo = crossDayRunId === '' ? undefined : (await (await fetch(`${apiUrl}/api/v1/runs/${crossDayRunId}`)).json() as { data?: { context?: { taskInput?: Record<string, unknown> } } }).data
      const planResponse = crossDayRunId === '' ? undefined : await fetch(`${apiUrl}/api/v1/runs/${crossDayRunId}/plan`)
      const runPlan = planResponse === undefined ? undefined : (await planResponse.json() as { data?: { selectedPlanRef?: ResourceRef; parentPlanRef?: ResourceRef; inputManifestHash?: string; stateRevision?: number; initialEnergyKwh?: number; weatherScenario?: string; reserveSocPercent?: number } }).data
      const comparison = selected?.parentPlanRef === undefined ? 'no persisted parent ref' : await (async () => {
        const query = new URLSearchParams({ parentId: selected.parentPlanRef!.id, parentVersion: selected.parentPlanRef!.version, parentDigest: selected.parentPlanRef!.digest, id: selected.planRef.id, version: selected.planRef.version, digest: selected.planRef.digest })
        const response = await fetch(`${apiUrl}/api/v1/energy/plan-versions/${encodeURIComponent(selected.planRef.id)}/diff?${query.toString()}`)
        return `diffStatus=${response.status} diffBody=${await response.text()}`
      })()
      const visibleError = await page.locator('[data-testid="energy-error"]').textContent().catch(() => '')
      throw new Error(`cross-day plan failed (phase=${await page.locator('.energy').getAttribute('data-phase')}, cards=${await page.locator('[data-testid="plan-version"]').count()}, displayedParent=${await page.locator('[data-testid="scenario-parent-plan"]').textContent()}, error=${visibleError}): select=${planSelectionResponse} selected=${JSON.stringify(selected && { planRef: selected.planRef, parentPlanRef: selected.parentPlanRef, runId: selected.runId })} runParent=${JSON.stringify(runInfo?.context?.taskInput?.['parentPlanRef'])} runPlan=${JSON.stringify(runPlan)} ${comparison}\nrunEvents=${events}`)
    }
    expect(await page.locator('[data-testid="persisted-plan-version"][data-status="Selected"]').count()).toBe(1)
    expect(await page.locator('[data-testid="persisted-plan-diff"]').count()).toBe(0)
    expect(await page.textContent('[data-testid="energy-notice"]')).toContain('PLAN_DIFF_NOT_COMPARABLE')
    await page.close()
  }, 300_000)

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
    const policyContent = '在此虚构的演示文本中，北区道路设施每年进行两次例行巡检。此内容仅用于测试引文定位。'
    const imported = await fetch(`${apiUrl}/api/v1/operator/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ title: '临时合成道路巡检说明', content: policyContent, mediaType: 'text/plain' }),
    })
    const importedText = await imported.text()
    expect(imported.status, importedText).toBe(201)
    const firstPolicy = (JSON.parse(importedText) as { data: { parseId: string; indexGeneration: string } }).data
    const repeatedPolicy = await fetch(`${apiUrl}/api/v1/operator/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ title: '同一份合成说明重试', content: policyContent, mediaType: 'text/plain' }),
    })
    expect(repeatedPolicy.status).toBe(201)
    const repeatedPolicyData = (await repeatedPolicy.json() as { data: { parseId: string; indexGeneration: string } }).data
    expect(repeatedPolicyData.parseId).toBe(firstPolicy.parseId)
    expect(repeatedPolicyData.indexGeneration).toBe(firstPolicy.indexGeneration)
    const secondDocument = await fetch(`${apiUrl}/api/v1/operator/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ title: '第二份合成文件', content: '另一个文件，应该被 collection 限制拒绝。', mediaType: 'text/markdown' }),
    })
    expect(secondDocument.status).toBe(409)

    const sourceInfo = await fetch(`${apiUrl}/api/v1/operator/sql-source`, { headers: { authorization: `Bearer ${operatorToken}` } })
    expect(sourceInfo.status).toBe(200)
    const source = (await sourceInfo.json() as { data: { readOnly: boolean; definitionRef: { id: string; version: string; digest: string } } }).data
    expect(source.readOnly).toBe(true)
    const hiddenSourceInfo = await fetch(`${apiUrl}/api/v1/operator/sql-source`)
    expect(hiddenSourceInfo.status).toBe(403)
    expect(JSON.stringify(source)).not.toContain(operatorSqlUrl)
    const readonlyClient = new Client({ connectionString: operatorSqlUrl })
    await readonlyClient.connect()
    try { await expect(readonlyClient.query('DELETE FROM public.ontology_facilities')).rejects.toBeDefined() }
    finally { await readonlyClient.end() }
    const candidateContent = '{"facility_key":"bridge-n-01","facility_name":"Bridge N 01","district":"north","inspection_state":"needs_inspection"}'
    const candidateUploads = await Promise.all([
      fetch(`${apiUrl}/api/v1/operator/candidate-documents`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ title: '受控原生实体记录 A', content: candidateContent, mediaType: 'text/plain' }),
      }),
      fetch(`${apiUrl}/api/v1/operator/candidate-documents`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
        body: JSON.stringify({ title: '受控原生实体记录 B', content: `${candidateContent} `, mediaType: 'text/plain' }),
      }),
    ])
    expect(candidateUploads.map((response) => response.status).sort()).toEqual([201, 409])
    const acceptedCandidateUpload = candidateUploads.find((response) => response.status === 201)
    if (acceptedCandidateUpload === undefined) throw new Error('the per-collection lock did not accept exactly one concurrent document')
    const candidateParseId = (await acceptedCandidateUpload.json() as { data: { parseId: string } }).data.parseId
    const acceptedCandidateContent = candidateUploads[0]?.status === 201 ? candidateContent : `${candidateContent} `
    const crossCollection = await fetch(`${apiUrl}/api/v1/operator/documents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ title: '另一个集合已有的候选文件', content: acceptedCandidateContent, mediaType: 'text/plain' }),
    })
    // A parse from the candidate collection must not authorise replacement of the policy index.
    expect(crossCollection.status).toBe(409)
    const extractResponse = await fetch(`${apiUrl}/api/v1/operator/documents/${candidateParseId}/extract-candidates`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}`, 'idempotency-key': `extract-${candidateParseId}` }, body: '{}',
    })
    const extractionText = await extractResponse.text()
    expect(extractResponse.status, extractionText).toBe(202)
    const extracted = (JSON.parse(extractionText) as { data: { jobId: string; stage: string; candidateIds: string[]; deterministic: boolean; modelCalls: number } }).data
    expect(extracted.stage).toBe('awaiting_review')
    expect(extracted.candidateIds).toHaveLength(1)
    expect(extracted.deterministic).toBe(true)
    expect(extracted.modelCalls).toBe(0)
    const job = await fetch(`${apiUrl}/api/v1/jobs/${extracted.jobId}`, { headers: { authorization: `Bearer ${operatorToken}` } })
    expect((await job.json() as { data: { stage: string } }).data.stage).toBe('awaiting_review')

    const candidateId = extracted.candidateIds[0]
    if (candidateId === undefined) throw new Error('deterministic extraction produced no entity candidate')
    const candidateSource = await fetch(`${apiUrl}/api/v1/candidates/${candidateId}/source`, { headers: { authorization: `Bearer ${operatorToken}` } })
    expect(candidateSource.status).toBe(200)
    const sourceSpans = (await candidateSource.json() as { data: { spans: readonly { status: string; text?: string }[] } }).data.spans
    expect(sourceSpans[0]?.status).toBe('resolved')
    expect(sourceSpans[0]?.text).toContain('bridge-n-01')
    const recall = await fetch(`${apiUrl}/api/v1/candidates/${candidateId}/identity-recall`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` }, body: '{}',
    })
    expect(recall.status).toBe(200)
    const recallView = (await recall.json() as { data: { auditId: string; result: { outcome: string; candidates: readonly { entityId: string; strategy: string; stableId: boolean }[]; similarity: { available: boolean } } } }).data
    expect(recallView.result.outcome).toBe('candidates')
    expect(recallView.result.candidates[0]).toMatchObject({ entityId: 'facility-entity-001', strategy: 'strong_identifier', stableId: true })
    expect(recallView.result.similarity.available).toBe(false)
    expect((await fetch(`${apiUrl}/api/v1/candidate-identity-recalls/${recallView.auditId}`, { headers: { authorization: `Bearer ${operatorToken}` } })).status).toBe(200)
    expect((await fetch(`${apiUrl}/api/v1/candidates/${candidateId}/identity-recall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)

    const clarifyResponse = await fetch(`${apiUrl}/api/v1/candidates/${candidateId}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}`, 'if-match': '0' }, body: JSON.stringify({ kind: 'clarify' }),
    })
    expect(clarifyResponse.status).toBe(200)
    const clarifiedRevision = (await clarifyResponse.json() as { meta: { revision: string } }).meta.revision
    const matchResponse = await fetch(`${apiUrl}/api/v1/candidates/${candidateId}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}`, 'if-match': clarifiedRevision }, body: JSON.stringify({ kind: 'match', targetEntityId: 'facility-entity-001', justification: '审核员已核对原文 span 与只读 SQL 强键召回记录。' }),
    })
    expect(matchResponse.status).toBe(200)
    const decisionRevision = (await matchResponse.json() as { meta: { revision: string } }).meta.revision
    expect(decisionRevision).toBe('2')
    const candidateDetail = await fetch(`${apiUrl}/api/v1/candidates/${candidateId}`, { headers: { authorization: `Bearer ${operatorToken}` } })
    expect((await candidateDetail.json() as { data: { candidate: { sourceSpans: readonly unknown[] } } }).data.candidate.sourceSpans).toHaveLength(1)

    const approval = await fetch(`${apiUrl}/api/v1/candidates/${candidateId}/reviews`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}`, 'if-match': '0' }, body: JSON.stringify({ decision: 'approve', reason: '核对来源 span 与已召回的强 native key。' }),
    })
    expect(approval.status).toBe(200)
    const beforePublicationRun = await createRun('已发布的道路设施本体事实有哪些？', 'synthetic-home-1', 'operator-sql-facilities', 'ontology.published-facts', {})
    expect((await fetch(`${apiUrl}/api/v1/runs/${beforePublicationRun}/answer`)).status).toBe(404)
    const publication = await fetch(`${apiUrl}/api/v1/semantic-publications`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}`, 'if-match': '0', 'idempotency-key': `publish-${candidateId}` },
      body: JSON.stringify({ schemaRef: source.definitionRef, approvedCandidateRefs: [{ candidateId, kind: 'entity' }] }),
    })
    const publicationText = await publication.text()
    expect(publication.status, publicationText).toBe(201)
    const published = (JSON.parse(publicationText) as { data: { publicationId: string; approvedCandidateRefs: readonly unknown[]; statements: readonly unknown[] } }).data
    expect(published.approvedCandidateRefs).toHaveLength(1)
    const ontologyRun = await createRun('已发布的道路设施本体事实有哪些？', 'synthetic-home-1', 'operator-sql-facilities', 'ontology.published-facts', {})
    const ontologyAnswerResponse = await fetch(`${apiUrl}/api/v1/runs/${ontologyRun}/answer`)
    expect(ontologyAnswerResponse.status).toBe(200)
    const ontologyAnswer = (await ontologyAnswerResponse.json() as { data: PublishedAnswer }).data
    expect(ontologyAnswer.assertions?.map((assertion) => assertion.predicate)).toEqual(expect.arrayContaining(['facility_key', 'district', 'inspection_state']))
    expect(ontologyAnswer.assertions?.every((assertion) => assertion.subject === 'facility-entity-001')).toBe(true)
    expect(published.statements).toHaveLength(1)

    await app.close()
    app = await startLocalProduct()
    apiUrl = app.origin
    const recalledAfterRestart = await fetch(`${apiUrl}/api/v1/candidate-identity-recalls/${recallView.auditId}`, { headers: { authorization: `Bearer ${operatorToken}` } })
    expect(recalledAfterRestart.status).toBe(200)
    expect((await recalledAfterRestart.json() as { data: { resultDigest: string } }).data.resultDigest).toBeTruthy()
    const publishedAfterRestart = await fetch(`${apiUrl}/api/v1/semantic-publications/${published.publicationId}`, { headers: { authorization: `Bearer ${operatorToken}` } })
    expect(publishedAfterRestart.status).toBe(200)
    expect((await publishedAfterRestart.json() as { data: { publicationId: string } }).data.publicationId).toBe(published.publicationId)
    const sqlRun = await createRun('north 区有哪些设施待巡检？', 'synthetic-home-1', 'operator-sql-facilities', 'transport.inspection-list', { district: 'north' })
    const sqlAnswerResponse = await fetch(`${apiUrl}/api/v1/runs/${sqlRun}/answer`)
    expect(sqlAnswerResponse.status).toBe(200)
    const sqlAnswer = (await sqlAnswerResponse.json() as { data: PublishedAnswer }).data
    expect(sqlAnswer.assertions?.map((assertion) => assertion.predicate)).toEqual(expect.arrayContaining(['facility_id', 'inspection_state', 'district']))
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
    const restoredOntologyAnswer = await fetch(`${apiUrl}/api/v1/runs/${ontologyRun}/answer`)
    expect(restoredOntologyAnswer.status).toBe(200)
    expect((await restoredOntologyAnswer.json() as { data: PublishedAnswer }).data.contentHash).toBe(ontologyAnswer.contentHash)

    const crossProfileTask = await fetch(`${apiUrl}/api/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `local-e2e-${randomUUID()}` },
      body: JSON.stringify({ profileRef: { id: 'home-energy-demo-wide', version: '1.0.0' }, question: 'north 区有哪些设施待巡检？', context: { timeZone: 'Asia/Shanghai', taskId: 'transport.inspection-list', taskInput: { district: 'north' }, sourceRefs: ['local-policy-library'] }, preferences: { route: 'auto', allowWeb: false } }),
    })
    expect(crossProfileTask.status).not.toBe(202)
    await page.close()
  })
})
