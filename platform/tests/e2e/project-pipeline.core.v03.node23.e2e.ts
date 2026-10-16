import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from 'pg'
import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, Page, Response } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_PROJECT_DATASET_BACKEND } from '@ontology/adapter-data-postgres'
import type { PostgresProjectDatasetConfig } from '@ontology/adapter-data-postgres'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { isRecord } from '@ontology/contracts'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `gap23_project_${randomUUID().replaceAll('-', '')}`
const DATA_ROW_COUNT = 1_001
const PAGE_SIZE = 25
interface IndustryCase {
  readonly scenarioId: string
  readonly profileId: string
  readonly profileVersion: string
  readonly objectId: string
  readonly keyField: string
  readonly headers: readonly string[]
  readonly row: (n: number, key: string) => readonly string[]
  readonly requiredFields: readonly string[]
}

const INDUSTRIAL: IndustryCase = {
  scenarioId: 'industrial-asset-maintenance',
  profileId: 'synthetic-industrial-maintenance-demo',
  profileVersion: '1.0.0',
  objectId: 'industrial_asset',
  keyField: 'asset_id',
  headers: ['asset_id', 'asset_network_code', 'asset_workshop_code'],
  row: (_n, key) => [key, 'network-gap23', 'WS-A'],
  requiredFields: ['asset_id', 'asset_network_code', 'asset_workshop_code'],
}

const TRANSPORT: IndustryCase = {
  scenarioId: 'transport-facility-inspection',
  profileId: 'synthetic-transport-facility-demo',
  profileVersion: '1.0.0',
  objectId: 'transport_facility',
  keyField: 'facility_id',
  headers: ['facility_id', 'network_code', 'facility_district_code'],
  row: (_n, key) => [key, 'network-gap23', 'north'],
  requiredFields: ['facility_id', 'network_code', 'facility_district_code'],
}
type BusinessBackend = 'duckdb' | 'postgres'
interface CaseHost {
  readonly name: string
  readonly objectDirectory: string
  readonly scopeRef: ScopeRef
  readonly businessSchema?: string
  readonly businessPostgres?: PostgresContainer
  readonly businessSql?: Client
  readonly composition: CoreLocalComposition
  readonly api: ReturnType<typeof createCoreApi>
  readonly web: WebHost
  readonly diagnostics: { readonly duringClose: boolean; readonly name: string; readonly code?: string; readonly message: string }[]
  closing: boolean
}

const execFileAsync = promisify(execFile)
let controlPostgres: PostgresContainer | undefined
let controlAdmin: Client | undefined
let browser: Browser | undefined
let appUrl = ''

function requestPath(response: Response): string {
  return new URL(response.url()).pathname
}

function applicationConnectionString(url: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//u, '') || 'postgres'
  return `${base.protocol}//ontology_app:${encodeURIComponent(APP_PASSWORD)}@${base.hostname}${port}/${database}`
}

function recordWorkerError(diagnostics: CaseHost['diagnostics'], closing: () => boolean, error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  diagnostics.push({
    duringClose: closing(),
    name: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }),
    message: error instanceof Error ? error.message : String(error),
  })
}

async function createScope(label: string): Promise<ScopeRef> {
  if (controlAdmin === undefined) throw new Error('the exclusive control PostgreSQL admin connection is unavailable')
  const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await controlAdmin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [
    scopeRef.tenantId,
    `gap23-${scopeRef.tenantId.slice(0, 8)}`,
  ])
  await controlAdmin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [
    scopeRef.tenantId,
    scopeRef.spaceId,
    `GAP-023 ${label}`,
  ])
  return scopeRef
}

async function startControlDatabase(): Promise<void> {
  controlPostgres = await startPostgresContainer()
  await runControlMigrations({ connectionString: controlPostgres.adminUrl, migrationsDir: MIGRATIONS_DIR })
  controlAdmin = new Client({ connectionString: controlPostgres.adminUrl })
  await controlAdmin.connect()
  const statement = await controlAdmin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterRole = statement.rows[0]?.statement
  if (alterRole === undefined) throw new Error('could not configure the non-owner control-store application role')
  await controlAdmin.query(alterRole)
  appUrl = applicationConnectionString(controlPostgres.adminUrl)
}

async function startCaseHost(input: { readonly name: string; readonly backend: BusinessBackend }): Promise<CaseHost> {
  const scopeRef = await createScope(input.name)
  const objectDirectory = await mkdtemp(join(tmpdir(), `ontology-gap23-${input.name}-`))
  let businessPostgres: PostgresContainer | undefined
  let businessSql: Client | undefined
  let schema: string | undefined
  let composition: CoreLocalComposition | undefined
  let api: ReturnType<typeof createCoreApi> | undefined
  let web: WebHost | undefined
  const diagnostics: { duringClose: boolean; name: string; code?: string; message: string }[] = []
  let closing = false
  try {
    let projectDataset: PostgresProjectDatasetConfig | undefined
    if (input.backend === 'postgres') {
      businessPostgres = await startPostgresContainer()
      schema = `gap23_${input.name.replace(/[^a-z0-9_]/giu, '_')}`
      projectDataset = {
        connectionString: businessPostgres.adminUrl,
        schema,
        applicationName: `gap23-${input.name}`,
      }
      businessSql = new Client({ connectionString: businessPostgres.adminUrl, application_name: `gap23-check-${input.name}` })
      await businessSql.connect()
    }
    composition = await createCoreLocalComposition({
      databaseUrl: appUrl,
      objectDirectory: join(objectDirectory, 'objects'),
      ...(projectDataset === undefined ? {} : { projectDataset }),
      scopeRef,
      examples: loadCoreExamples({ targetScopeRef: scopeRef }),
      allowLocalOperator: true,
      modelsEnabled: false,
      jevEnabled: false,
      onWorkerError: (error) => recordWorkerError(diagnostics, () => closing, error),
    })
    api = createCoreApi(composition.dependencies)
    const origin = await api.listen({ host: '127.0.0.1', port: 0 })
    web = await startWebHost(origin, { bindDefaultProfile: false })
    return {
      name: input.name,
      objectDirectory,
      scopeRef,
      ...(schema === undefined ? {} : { businessSchema: schema }),
      ...(businessPostgres === undefined ? {} : { businessPostgres }),
      ...(businessSql === undefined ? {} : { businessSql }),
      composition,
      api,
      web,
      diagnostics,
      get closing() { return closing },
      set closing(value: boolean) { closing = value },
    }
  } catch (error) {
    const failures: Error[] = [new Error(`could not start GAP-023 Core host ${input.name}`, { cause: error })]
    const attempt = async (label: string, action: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        await action()
      } catch (caught) {
        failures.push(new Error(`${label} failed during startup cleanup`, { cause: caught }))
      }
    }
    await attempt('web host', async () => web?.close())
    await attempt('Core API', async () => api?.close())
    await attempt('Core composition', async () => composition?.close())
    await attempt('business SQL client', async () => businessSql?.end())
    await attempt('business PostgreSQL', async () => businessPostgres?.stop())
    await attempt('owned object directory', async () => rm(objectDirectory, { recursive: true, force: true }))
    throw new AggregateError(failures, 'GAP-023 Core host initialization failed')
  }
}

async function assertPostgresResourcesReclaimed(container: PostgresContainer): Promise<void> {
  const volumeName = container.containerName.replace(/^ontology-pg-/u, 'ontology-pg-data-')
  const remainingContainers = await execFileAsync('docker', [
    'ps', '-aq', '--filter', `name=^/${container.containerName}$`,
  ]).then(({ stdout }) => stdout.trim())
  const remainingVolumes = await execFileAsync('docker', [
    'volume', 'ls', '-q', '--filter', `name=^${volumeName}$`,
  ]).then(({ stdout }) => stdout.trim())
  expect(remainingContainers, `owned container ${container.containerName} must be removed`).toBe('')
  expect(remainingVolumes, `owned volume ${volumeName} must be removed`).toBe('')
}

async function closeCaseHost(host: CaseHost): Promise<void> {
  host.closing = true
  const failures: Error[] = []
  const attempt = async (label: string, action: () => Promise<unknown> | undefined): Promise<void> => {
    try {
      await action()
    } catch (error) {
      failures.push(new Error(`${label} teardown failed`, { cause: error }))
    }
  }
  await attempt('web host', () => host.web.close())
  await attempt('Core API', () => host.api.close())
  await attempt('Core composition', () => host.composition.close())
  await attempt('business SQL connection', async () => host.businessSql?.end())
  await attempt('business PostgreSQL', async () => host.businessPostgres?.stop())
  if (host.businessPostgres !== undefined) {
    await attempt('business PostgreSQL resource verification', () => assertPostgresResourcesReclaimed(host.businessPostgres as PostgresContainer))
  }
  await attempt('owned object directory', async () => {
    const owned = resolve(host.objectDirectory)
    if (!owned.startsWith(resolve(tmpdir(), 'ontology-gap23-'))) throw new Error('temporary cleanup escaped the owned GAP-023 directory')
    await rm(owned, { recursive: true, force: true })
  })
  await attempt('worker diagnostics artifact', async () => record(`gap23-${host.name}-worker-diagnostics`, host.diagnostics.map((entry) => JSON.stringify(entry))))
  if (host.diagnostics.length > 0) failures.push(new Error(`unexpected worker errors including shutdown: ${JSON.stringify(host.diagnostics)}`))
  if (failures.length > 0) throw new AggregateError(failures, 'GAP-023 per-case teardown or worker diagnostics failed')
}

async function findTargetRow(page: Page, targetKey: string, keyField: string): Promise<{ readonly recordId: string } | undefined> {
  const rows = page.getByTestId('record-row')
  const count = await rows.count()
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    const rawKey = (await row.getByTestId(`record-field-${keyField}`).locator('code').first().textContent())?.trim()
    if (rawKey === targetKey) {
      const recordId = await row.getAttribute('data-record-id')
      if (recordId === null) throw new Error('the actual target record row had no returned record ID')
      return { recordId }
    }
  }
  return undefined
}

async function run1001RowCase(input: {
  readonly industry: IndustryCase
  readonly backend: BusinessBackend
  readonly caseName: string
  readonly outputPrefix: string
}): Promise<void> {
  if (browser === undefined) throw new Error('the real Chromium browser was not initialized')
  const host = await startCaseHost({ name: input.caseName, backend: input.backend })
  const filePath = join(host.objectDirectory, '1001-source-records.csv')
  const targetKey = `GAP23-${input.caseName.toUpperCase().replace(/[^A-Z0-9]+/gu, '-')}-ROW-1001`
  const csvRows = [input.industry.headers.join(',')]
  for (let index = 1; index <= DATA_ROW_COUNT; index += 1) {
    const sourceKey = index === DATA_ROW_COUNT ? targetKey : `GAP23-${input.caseName.toUpperCase().replace(/[^A-Z0-9]+/gu, '-')}-ROW-${String(index).padStart(4, '0')}`
    csvRows.push(input.industry.row(index, sourceKey).join(','))
  }
  const pageErrors: string[] = []
  const apiFailures: string[] = []
  const apiResponses: string[] = []
  const apiTrace: string[] = []
  const stagedCandidateIds = new Set<string>()
  let semanticPublicationStarted = false
  let context: BrowserContext | undefined
  let mainFailure: unknown
  try {
    await writeFile(filePath, `${csvRows.join('\n')}\n`, 'utf8')
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith('/api/v1/')) apiTrace.push(`${request.method()} ${path}`)
    })
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (!path.startsWith('/api/v1/')) return
      apiResponses.push(`${response.status()} ${response.request().method()} ${path}`)
      const expectedMissingStatement = response.status() === 404 && response.request().method() === 'GET' &&
        !semanticPublicationStarted && path.startsWith('/api/v1/statements/') && stagedCandidateIds.has(path.slice('/api/v1/statements/'.length))
      if (response.status() >= 400 && !expectedMissingStatement) apiFailures.push(`${response.status()} ${path}`)
    })
    await page.goto(host.web.origin)
    await page.waitForSelector('[data-testid="guide-home"]')
    await page.waitForSelector('[data-testid="context-workspace-loading"]', { state: 'hidden' })
    const scenario = page.getByTestId('core-scenario-select')
    await scenario.selectOption(input.industry.scenarioId)
    expect(await scenario.locator('option:checked').getAttribute('value')).toBe(input.industry.scenarioId)
    await page.getByTestId('assistant-tab-business').click()
    await page.waitForSelector('[data-testid="project-workspace"]')
    await page.getByTestId('project-create-title').fill(`GAP-023 ${input.caseName} 1001 rows`)
    const bootstrapResponse = page.waitForResponse((response) => response.request().method() === 'POST' && requestPath(response) === '/api/v1/core/project-bootstrap')
    await page.getByTestId('project-create-submit').click()
    const bootstrapped = await bootstrapResponse
    expect(bootstrapped.status()).toBe(201)
    const bootstrapBody: unknown = await bootstrapped.json()
    if (!isRecord(bootstrapBody) || !isRecord(bootstrapBody['data']) || !isRecord(bootstrapBody['data']['project']) || typeof bootstrapBody['data']['project']['projectId'] !== 'string') {
      throw new Error('the real Core bootstrap response omitted its actual project')
    }
    const projectId = bootstrapBody['data']['project']['projectId']
    if (!isRecord(bootstrapBody['data']['revision']) || !isRecord(bootstrapBody['data']['revision']['profileRef']) ||
      bootstrapBody['data']['revision']['profileRef']['id'] !== input.industry.profileId ||
      bootstrapBody['data']['revision']['profileRef']['version'] !== input.industry.profileVersion) {
      throw new Error(`the actual project bootstrap did not pin the selected ${input.industry.scenarioId} Core profile`)
    }
    await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${projectId}"]`)
    await page.getByRole('button', { name: '导入资料', exact: true }).click()
    await page.getByTestId('project-file').setInputFiles(filePath)
    const importResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/structured-imports`)
    await page.getByTestId('project-file-submit').click()
    const imported = await importResponse
    expect(imported.status()).toBe(201)
    const importedBody: unknown = await imported.json()
    if (!isRecord(importedBody) || !isRecord(importedBody['data']) || !isRecord(importedBody['data']['counts']) || !isRecord(importedBody['data']['coverage'])) {
      throw new Error('the actual 1001-row import did not return parse counts and native source coverage')
    }
    const parseStatus = importedBody['data']['status']
    const parseCounts = importedBody['data']['counts']
    const parseCoverage = importedBody['data']['coverage']
    const parseId = importedBody['data']['parseId']
    if (typeof parseId !== 'string') throw new Error('the actual native CSV import did not return its exact parser identity')
    const originalRef = importedBody['data']['originalRef']
    if (!isRecord(originalRef) || typeof originalRef['id'] !== 'string' || typeof originalRef['version'] !== 'string' ||
      typeof originalRef['digest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(originalRef['digest'])) {
      throw new Error('the actual imported CSV did not return its exact immutable original reference')
    }
    const originalDigest = originalRef['digest']
    const documentIndexState = importedBody['data']['documentIndexState']
    if (parseCounts['total'] !== DATA_ROW_COUNT || parseCoverage['completeness'] !== 'complete' || parseStatus !== 'complete') {
      throw new Error(`the actual native parse did not report 1001 complete source rows: ${JSON.stringify({ parseStatus, parseCounts, parseCoverage })}`)
    }
    if (controlAdmin === undefined) throw new Error('the read-only projection coverage verifier lost its control database connection')
    const projectionRead = await controlAdmin.query<{
      parse_status: string
      completeness: string
      coverage: unknown
      original_content_digest: string
    }>(
      `SELECT parse_status, completeness, coverage, original_content_digest
         FROM agent_platform.document_parse_runs
        WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3::uuid
          AND parser_id = 'ontology.structured-document-projection'`,
      [host.scopeRef.tenantId, host.scopeRef.spaceId, parseId],
    )
    const projection = projectionRead.rows[0]
    if (projectionRead.rowCount !== 1 || projection === undefined || projection.original_content_digest !== originalDigest ||
      projection.parse_status !== 'partial' || projection.completeness !== 'truncated' || !isRecord(projection.coverage) ||
      projection.coverage['parsedUnits'] !== 1_000 || projection.coverage['skippedUnits'] !== 1 ||
      !Array.isArray(projection.coverage['skippedReasons']) || !projection.coverage['skippedReasons'].includes('structured text projection row/byte limits')) {
      throw new Error(`the actual derived text projection did not report its bounded partial 1000-of-1001 state: ${JSON.stringify(projectionRead.rows)}`)
    }
    const derivedTextProjection = {
      parseStatus: projection.parse_status,
      completeness: projection.completeness,
      parsedUnits: projection.coverage['parsedUnits'],
      skippedUnits: projection.coverage['skippedUnits'],
      skippedReasons: projection.coverage['skippedReasons'],
    }
    await page.waitForSelector('[data-testid="project-file-result"][data-status="complete"]')
    await page.locator('[data-testid="source-candidate"]').waitFor()
    await page.locator('[data-testid="source-candidate"]').getByRole('button', { name: '确认这份资料的映射' }).click()
    await page.waitForSelector('[data-testid="project-mapping"]:not([hidden])')
    await page.getByTestId('mapping-source').selectOption({ index: 1 })
    await page.getByTestId('mapping-object').selectOption(input.industry.objectId)
    const requiredFields = await page.locator('[data-testid="mapping-fields"] tbody tr[data-required="true"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')?.replace('mapping-field-', '') ?? ''))
    expect(requiredFields.sort()).toEqual([...input.industry.requiredFields].sort())
    for (const field of requiredFields) await page.getByTestId(`mapping-column-${field}`).selectOption({ label: field })
    const mappingPreviewResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/mappings/preview`)
    await page.getByTestId('mapping-preview-button').click()
    const mappingPreview = await mappingPreviewResponse
    expect(mappingPreview.status()).toBe(200)
    const previewBody: unknown = await mappingPreview.json()
    if (!isRecord(previewBody) || !isRecord(previewBody['data']) || !isRecord(previewBody['data']['preview']) ||
      previewBody['data']['preview']['rowCount'] !== DATA_ROW_COUNT || previewBody['data']['preview']['confirmable'] !== true) {
      throw new Error(`the actual full-row mapping preview was not confirmable for exactly 1001 rows: ${JSON.stringify(previewBody)}`)
    }
    expect(await page.textContent('[data-testid="mapping-preview-rows"]')).toContain(String(DATA_ROW_COUNT))
    const confirmMapping = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/mappings`)
    await page.getByTestId('mapping-confirm-button').click()
    expect((await confirmMapping).ok()).toBe(true)
    await page.getByTestId('mapping-confirmed').waitFor()
    const bindResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/records`)
    await page.getByTestId('record-bind').click()
    const bound = await bindResponse
    expect(bound.ok()).toBe(true)
    await page.waitForFunction((count: number) => {
      const notice = document.querySelector('[data-testid="bind-notice"]')?.textContent ?? ''
      return notice.includes('已绑定') && Number(notice.replace(/\D/gu, '')) === count
    }, DATA_ROW_COUNT)
    await page.getByRole('button', { name: '项目记录', exact: true }).click()
    await page.waitForSelector('[data-testid="record-row"][data-status="confirmed"]')
    expect(await page.textContent('[data-testid="record-total"]')).toContain(String(DATA_ROW_COUNT))
    const firstPageRows = await page.getByTestId('record-row').count()
    expect(firstPageRows).toBeLessThanOrEqual(PAGE_SIZE)
    let pageCount = 1
    while (await findTargetRow(page, targetKey, input.industry.keyField) === undefined && pageCount < Math.ceil(DATA_ROW_COUNT / PAGE_SIZE)) {
      const next = page.getByTestId('record-next')
      await next.waitFor({ state: 'visible' })
      const priorTopRecordId = await page.getByTestId('record-row').first().getAttribute('data-record-id')
      if (priorTopRecordId === null) throw new Error('the visible source page had no actual opaque record key')
      const recordsResponse = page.waitForResponse((response) => response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/v1/projects/${projectId}/records`)
      await next.click()
      expect((await recordsResponse).ok()).toBe(true)
      await page.waitForFunction((previousRecordId: string) => {
        const currentTopRecordId = document.querySelector('[data-testid="record-row"]')?.getAttribute('data-record-id')
        return currentTopRecordId !== null && currentTopRecordId !== undefined && currentTopRecordId !== previousRecordId
      }, priorTopRecordId)
      pageCount += 1
    }
    const targetRecord = await findTargetRow(page, targetKey, input.industry.keyField)
    if (targetRecord === undefined) throw new Error(`the normal opaque keyset UI did not reach the actual final source row after ${String(pageCount)} pages`)
    await capture(page, `${input.outputPrefix}-target-page`)
    const targetPageRows = await page.getByTestId('record-row').count()
    if (targetPageRows < 1 || targetPageRows > PAGE_SIZE) throw new Error(`record page size was outside the actual UI limit: ${String(targetPageRows)}`)
    const currentStagingText = await page.getByTestId('project-fact-staging').textContent()
    const currentPageMatch = /当前页 (\d+) 条记录/u.exec(currentStagingText ?? '')
    if (Number(currentPageMatch?.[1]) !== targetPageRows) throw new Error('the fact staging UI count did not match its real current records page')
    const stageCandidatesResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/core/projects/${projectId}/fact-candidates`)
    await page.getByTestId('project-stage-facts').click()
    const stagedResponse = await stageCandidatesResponse
    expect(stagedResponse.status()).toBe(201)
    const stagedBody: unknown = await stagedResponse.json()
    if (!isRecord(stagedBody) || !isRecord(stagedBody['data']) || !Array.isArray(stagedBody['data']['candidates']) || stagedBody['data']['candidates'].length !== targetPageRows) {
      throw new Error(`the actual current page did not produce one candidate per visible row: ${JSON.stringify(stagedBody)}`)
    }
    let targetCandidateId: string | undefined
    for (const candidate of stagedBody['data']['candidates']) {
      if (!isRecord(candidate) || typeof candidate['candidateId'] !== 'string' || !isRecord(candidate['inputVersion']) ||
        !isRecord(candidate['inputVersion']['projectFact']) || !Array.isArray(candidate['inputVersion']['projectFact']['sources'])) {
        throw new Error('the actual staged candidate omitted its source-bound record reference')
      }
      stagedCandidateIds.add(candidate['candidateId'])
      const source = candidate['inputVersion']['projectFact']['sources'][0]
      if (isRecord(source) && source['recordId'] === targetRecord.recordId) targetCandidateId = candidate['candidateId']
    }
    if (targetCandidateId === undefined) throw new Error('the current page candidate list did not contain the actual final source record')
    await page.getByTestId('project-create-reviews').click()
    await page.getByTestId('instance-record-list').waitFor()
    await page.locator('[data-testid="instance-record-item"]').first().waitFor()
    const reviewItems = page.getByTestId('instance-record-item')
    if (await reviewItems.count() !== targetPageRows) throw new Error('the normal review queue did not contain one review per staged source record')
    const targetReviewItem = page.locator(`[data-testid="instance-record-item"][data-record-id="${targetCandidateId}"]`)
    await targetReviewItem.waitFor({ state: 'visible' })
    await targetReviewItem.click()
    const reviewRecordId = targetCandidateId
    await page.waitForSelector(`[data-testid="instance-detail"][data-record-id="${reviewRecordId}"]`)
    expect(await page.getAttribute('[data-testid="instance-detail"]', 'data-record-id')).toBe(targetCandidateId)
    const targetReviewKey = page.locator(`[data-testid="instance-field-row"][data-field-id="${input.industry.keyField}"] [data-testid="instance-field-raw"]`)
    expect((await targetReviewKey.textContent())?.trim()).toBe(targetKey)
    for (const field of requiredFields) {
      const row = page.locator(`[data-testid="instance-field-row"][data-field-id="${field}"]`)
      await row.getByTestId('instance-field-confirm').click()
      await row.locator('[data-testid="instance-field-status"][data-status="confirmed"]').waitFor()
    }
    await page.getByTestId('instance-identity-reason').fill(`核对原始CSV唯一末行 ${targetKey}`)
    const identityResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname.includes(`/instance-records/${reviewRecordId}/identity-decisions`))
    await page.getByTestId('instance-identity-create').click()
    expect((await identityResponse).ok()).toBe(true)
    const approvalResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/instance-records/${reviewRecordId}/approve`))
    await page.getByTestId('instance-approve').click()
    expect((await approvalResponse).ok()).toBe(true)
    const recordPublication = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/instance-records/${reviewRecordId}/publish`))
    await page.getByTestId('instance-publish').click()
    expect((await recordPublication).ok()).toBe(true)
    await page.waitForFunction(() => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent === '已发布')
    const pendingOthers = []
    for (let index = 0; index < await reviewItems.count(); index += 1) {
      const item = reviewItems.nth(index)
      if (await item.getAttribute('data-record-id') === targetCandidateId) continue
      const queueStatus = await item.locator('small').nth(1).textContent()
      if (!queueStatus?.includes('待审核') || !queueStatus.includes('待确认')) throw new Error(`a non-target source row advanced beyond pending review: ${queueStatus ?? ''}`)
      pendingOthers.push(item)
    }
    expect(pendingOthers.length).toBe(targetPageRows - 1)

    const sourceTrigger = page.locator(`[data-testid="instance-field-row"][data-field-id="${input.industry.keyField}"] [data-testid="instance-field-source"] button`)
    await sourceTrigger.click()
    const sourceDrawer = page.getByRole('dialog', { name: '字段来源' })
    await sourceDrawer.waitFor()
    await sourceDrawer.locator('[data-testid="answer-source-fragment"] button').first().click()
    const sourceLocation = sourceDrawer.getByTestId('original-cell-location')
    await sourceLocation.waitFor()
    const locationText = await sourceLocation.textContent()
    expect(locationText).toContain(targetKey)
    expect(locationText).toContain('A1002')
    await page.keyboard.press('Escape')
    await sourceDrawer.waitFor({ state: 'hidden' })
    expect(await sourceTrigger.evaluate((element) => document.activeElement === element)).toBe(true)

    const candidateInventoryResponse = page.waitForResponse((response) => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/candidates')
    await page.getByTestId('tab-review').click()
    const reviewLeavePrompt = page.getByRole('dialog', { name: '离开当前工作内容？' })
    if (await reviewLeavePrompt.isVisible()) await page.getByTestId('shell-discard-changes').click()
    const candidateInventory = await candidateInventoryResponse
    expect(candidateInventory.status()).toBe(200)
    const candidateInventoryBody: unknown = await candidateInventory.json()
    if (!isRecord(candidateInventoryBody) || !isRecord(candidateInventoryBody['data']) || !Array.isArray(candidateInventoryBody['data']['candidates'])) {
      throw new Error('the actual candidate review route returned no scoped candidate inventory')
    }
    const candidates = candidateInventoryBody['data']['candidates']
    const targetCandidateIndex = candidates.findIndex((candidate) => isRecord(candidate) && candidate['candidateId'] === targetCandidateId)
    if (targetCandidateIndex < 0) throw new Error('the actual staged target candidate was absent from the current review inventory')
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'review')
    await page.waitForSelector('[data-testid="candidate-panel"]')
    await page.waitForFunction(() => {
      const phase = document.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase')
      return phase !== undefined && phase !== 'loading'
    })
    expect(await page.getAttribute('[data-testid="candidate-panel"]', 'data-phase')).toBe('ready')
    await page.getByTestId('candidate-list').waitFor()
    const candidateItems = page.getByTestId('candidate-item')
    expect(await candidateItems.count()).toBe(candidates.length)
    await candidateItems.nth(targetCandidateIndex).click()
    await page.waitForFunction((candidateId: string) => document.querySelector('[data-testid="candidate-id"]')?.textContent === candidateId, targetCandidateId)
    await page.getByTestId('candidate-detail').waitFor()
    const candidateApproval = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/candidates/${targetCandidateId}/reviews`)
    await page.getByTestId('review-reason').fill(`人工复核唯一目标行 ${targetKey} 的完整原始来源`)
    await page.getByTestId('review-approve').click()
    expect((await candidateApproval).ok()).toBe(true)
    await page.waitForFunction(() => document.querySelector('[data-testid="review-head"]')?.getAttribute('data-approved') === 'true')
    const semanticPublication = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/semantic-publications')
    semanticPublicationStarted = true
    await page.getByTestId('publish').click()
    expect((await semanticPublication).ok()).toBe(true)
    await page.waitForSelector('[data-testid="statement-current"][data-status="active"]')

    await page.getByTestId('assistant-tab-business').click()
    const projectLeavePrompt = page.getByRole('dialog', { name: '离开当前工作内容？' })
    if (await projectLeavePrompt.isVisible()) await page.getByTestId('shell-discard-changes').click()
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'projects')
    await page.getByRole('button', { name: '项目记录', exact: true }).click()
    await page.getByTestId('dataset-object').selectOption(input.industry.objectId)
    const materialization = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/dataset-snapshots`)
    await page.getByTestId('dataset-materialize').click()
    const materialized = await materialization
    expect(materialized.status()).toBe(201)
    await page.waitForSelector('[data-testid="dataset-status"][data-state="ready"]')

    const datasetRead = await page.evaluate(async (path) => {
      const response = await fetch(path)
      return { status: response.status, body: await response.json() as unknown }
    }, `/api/v1/projects/${projectId}/dataset?objectId=${encodeURIComponent(input.industry.objectId)}&limit=25`)
    expect(datasetRead.status).toBe(200)
    if (!isRecord(datasetRead.body) || !isRecord(datasetRead.body['data']) || !Array.isArray(datasetRead.body['data']['rows']) ||
      !isRecord(datasetRead.body['data']['coverage']) || !isRecord(datasetRead.body['data']['snapshotRef'])) {
      throw new Error('the actual project dataset readback omitted snapshot, rows or coverage')
    }
    const datasetRows = datasetRead.body['data']['rows']
    const datasetRow = datasetRows[0]
    if (datasetRows.length !== 1 || !isRecord(datasetRow) || !isRecord(datasetRow['values']) || !Array.isArray(datasetRow['sources'])) {
      throw new Error(`the official target subset was not a single fixed dataset row: ${JSON.stringify(datasetRows)}`)
    }
    const keyValue = datasetRow['values'][input.industry.keyField]
    if (!isRecord(keyValue) || keyValue['kind'] !== 'scalar' || keyValue['value'] !== targetKey) throw new Error('the fixed official dataset does not contain the exact reviewed target key')
    const targetFieldSource = datasetRow['sources'].find((source) => isRecord(source) && source['fieldId'] === input.industry.keyField)
    if (!isRecord(targetFieldSource) || !isRecord(targetFieldSource['locator']) || targetFieldSource['locator']['kind'] !== 'table_cell' ||
      targetFieldSource['locator']['row'] !== DATA_ROW_COUNT + 1 || targetFieldSource['locator']['address'] !== 'A1002' ||
      !isRecord(targetFieldSource['documentRef']) || targetFieldSource['documentRef']['digest'] !== originalDigest) {
      throw new Error(`the official dataset source did not retain the exact physical final-row cell: ${JSON.stringify(targetFieldSource)}`)
    }
    if (datasetRead.body['data']['coverage']['completeness'] !== 'complete') throw new Error(`the published one-row dataset was not complete: ${JSON.stringify(datasetRead.body['data']['coverage'])}`)

    let businessDbProof: string[] = []
    if (input.backend === 'postgres') {
      if (host.businessSql === undefined || host.businessSchema === undefined) throw new Error('the explicit business PostgreSQL adapter had no owned verifier connection or schema')
      const snapshotId = datasetRead.body['data']['snapshotRef']['id']
      if (typeof snapshotId !== 'string') throw new Error('the actual dataset snapshot had no immutable ID')
      const stored = await host.businessSql.query<{ project_id: string; object_id: string; backend: string; row_count: string }>(
        `SELECT project_id::text, object_id, backend, row_count::text FROM "${host.businessSchema}".project_dataset_snapshots WHERE snapshot_id = $1::uuid`,
        [snapshotId],
      )
      if (stored.rowCount !== 1 || stored.rows[0]?.project_id !== projectId || stored.rows[0]?.object_id !== input.industry.objectId ||
        stored.rows[0]?.backend !== POSTGRES_PROJECT_DATASET_BACKEND || stored.rows[0]?.row_count !== '1') {
        throw new Error(`the independent business PostgreSQL schema did not store the exact one-row result: ${JSON.stringify(stored.rows)}`)
      }
      businessDbProof = [`businessPgSchema=${host.businessSchema}`, `businessPgSnapshot=${snapshotId}`, 'businessPgRows=1']
    }

    const viewportEvidence: string[] = []
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 })
      const scroll = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }))
      if (scroll.document > scroll.viewport) throw new Error(`actual project view overflows at ${String(width)}px: ${JSON.stringify(scroll)}`)
      const artifactName = `gap23-${input.caseName}-materialized-${String(width)}`
      await capture(page, artifactName)
      viewportEvidence.push(`${width}px:no-page-overflow`)
    }
    await record(`gap23-${input.caseName}-1001-row-flow`, [
      `industry=${input.industry.scenarioId}`,
      `queryBackend=${input.backend}`,
      `project=${projectId}`,
      `nativeParseStatus=${String(parseStatus)}`,
      `nativeParseCounts=${JSON.stringify(parseCounts)}`,
      `nativeParseCoverage=${JSON.stringify(parseCoverage)}`,
      `derivedTextProjectionCoverage=${JSON.stringify(derivedTextProjection)}`,
      `documentIndexState=${JSON.stringify(documentIndexState)}`,
      `boundRows=${String(DATA_ROW_COUNT)}`,
      `targetKey=${targetKey}`,
      `targetPhysicalCell=A1002`,
      `actualPagesVisited=${String(pageCount)}`,
      `actualCandidatesStagedOnTargetPage=${String(targetPageRows)}`,
      `otherCandidatesRemainPending=${String(pendingOthers.length)}`,
      `officialDatasetRows=${String(datasetRows.length)}`,
      `datasetCoverage=${JSON.stringify(datasetRead.body['data']['coverage'])}`,
      ...businessDbProof,
      `viewports=${viewportEvidence.join(',')}`,
      ...apiTrace,
      ...apiResponses,
      ...(apiFailures.length === 0 ? [] : [`apiFailures=${apiFailures.join(',')}`]),
      ...(pageErrors.length === 0 ? [] : [`pageErrors=${pageErrors.join(' | ')}`]),
    ])
    expect(apiFailures).toEqual([])
    expect(pageErrors).toEqual([])
  } catch (error) {
    mainFailure = error
    throw error
  } finally {
    const finalizationErrors: unknown[] = []
    try {
      await record(`gap23-${input.caseName}-browser-diagnostics`, [
        `outcome=${mainFailure === undefined ? 'completed' : 'failed'}`,
        ...(mainFailure === undefined ? [] : [`failure=${mainFailure instanceof Error ? `${mainFailure.name}: ${mainFailure.message}` : String(mainFailure)}`]),
        ...apiTrace,
        ...apiResponses,
        ...(apiFailures.length === 0 ? [] : [`apiFailures=${apiFailures.join(',')}`]),
        ...(pageErrors.length === 0 ? [] : [`pageErrors=${pageErrors.join(' | ')}`]),
      ])
    } catch (error) { finalizationErrors.push(new Error('browser/API diagnostics could not be recorded', { cause: error })) }
    if (context !== undefined) {
      try { await context.close() } catch (error) { finalizationErrors.push(new Error('browser context teardown failed', { cause: error })) }
    }
    try { await closeCaseHost(host) } catch (error) { finalizationErrors.push(error) }
    if (finalizationErrors.length > 0) {
      throw new AggregateError([...(mainFailure === undefined ? [] : [mainFailure]), ...finalizationErrors], 'GAP-023 actual App case teardown or diagnostics failed')
    }
  }
}

interface ScopedCandidateFixture {
  readonly projectId: string
  readonly candidateId: string
  readonly secretKey: string
}

async function createScopedCandidateThroughApp(): Promise<ScopedCandidateFixture> {
  if (browser === undefined) throw new Error('the real Chromium browser was not initialized')
  const host = await startCaseHost({ name: 'isolation-owner', backend: 'duckdb' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const pageErrors: string[] = []
  const secretKey = 'GAP23-CROSS-SCOPE-SECRET-001'
  const filePath = join(host.objectDirectory, 'isolation-source.csv')
  const csv = `asset_id,asset_network_code,asset_workshop_code\n${secretKey},network-gap23,WS-A\n`
  let failure: unknown
  try {
    await writeFile(filePath, csv, 'utf8')
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto(host.web.origin)
    await page.waitForSelector('[data-testid="guide-home"]')
    const scenario = page.getByTestId('core-scenario-select')
    await scenario.selectOption(INDUSTRIAL.scenarioId)
    await page.getByTestId('assistant-tab-business').click()
    await page.getByTestId('project-create-title').fill('GAP-023 isolation owner project')
    const bootstrap = page.waitForResponse((response) => response.request().method() === 'POST' && requestPath(response) === '/api/v1/core/project-bootstrap')
    await page.getByTestId('project-create-submit').click()
    const bootstrapResponse = await bootstrap
    if (bootstrapResponse.status() !== 201) throw new Error(`owner project bootstrap failed: ${await bootstrapResponse.text()}`)
    const bootstrapBody: unknown = await bootstrapResponse.json()
    if (!isRecord(bootstrapBody) || !isRecord(bootstrapBody['data']) || !isRecord(bootstrapBody['data']['project']) || typeof bootstrapBody['data']['project']['projectId'] !== 'string') {
      throw new Error('the owner project bootstrap returned no actual project identity')
    }
    const projectId = bootstrapBody['data']['project']['projectId']
    await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${projectId}"]`)
    await page.getByRole('button', { name: '导入资料', exact: true }).click()
    await page.getByTestId('project-file').setInputFiles(filePath)
    const importResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/structured-imports`)
    await page.getByTestId('project-file-submit').click()
    if (!(await importResponse).ok()) throw new Error('the owner project did not import its real one-row CSV')
    await page.locator('[data-testid="source-candidate"]').waitFor()
    await page.locator('[data-testid="source-candidate"]').getByRole('button', { name: '确认这份资料的映射' }).click()
    await page.waitForSelector('[data-testid="project-mapping"]:not([hidden])')
    await page.getByTestId('mapping-source').selectOption({ index: 1 })
    await page.getByTestId('mapping-object').selectOption(INDUSTRIAL.objectId)
    for (const field of INDUSTRIAL.requiredFields) await page.getByTestId(`mapping-column-${field}`).selectOption({ label: field })
    const preview = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/mappings/preview`)
    await page.getByTestId('mapping-preview-button').click()
    if (!(await preview).ok()) throw new Error('the owner project did not produce a confirmable source mapping')
    const mapping = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/mappings`)
    await page.getByTestId('mapping-confirm-button').click()
    if (!(await mapping).ok()) throw new Error('the owner project did not confirm its source mapping')
    await page.getByTestId('mapping-confirmed').waitFor()
    const binding = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/records`)
    await page.getByTestId('record-bind').click()
    if (!(await binding).ok()) throw new Error('the owner project did not bind its actual CSV record')
    await page.getByRole('button', { name: '项目记录', exact: true }).click()
    await page.getByTestId('record-row').waitFor()
    const staged = page.waitForResponse((response) => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/core/projects/${projectId}/fact-candidates`)
    await page.getByTestId('project-stage-facts').click()
    const stagedResponse = await staged
    if (stagedResponse.status() !== 201) throw new Error(`the owner project did not stage an actual source-backed candidate: ${await stagedResponse.text()}`)
    const stagedBody: unknown = await stagedResponse.json()
    if (!isRecord(stagedBody) || !isRecord(stagedBody['data']) || !Array.isArray(stagedBody['data']['candidates']) || stagedBody['data']['candidates'].length !== 1) {
      throw new Error('the owner project did not produce exactly one source-backed candidate')
    }
    const candidate = stagedBody['data']['candidates'][0]
    if (!isRecord(candidate) || typeof candidate['candidateId'] !== 'string' || !isRecord(candidate['inputVersion']) ||
      !isRecord(candidate['inputVersion']['projectFact']) || !Array.isArray(candidate['inputVersion']['projectFact']['sources'])) {
      throw new Error('the actual owner candidate omitted its project source binding')
    }
    const source = candidate['inputVersion']['projectFact']['sources'][0]
    if (!isRecord(source) || typeof source['recordId'] !== 'string') throw new Error('the owner candidate did not pin its actual source record')
    const visibleRowKey = await page.locator(`[data-testid="record-row"][data-record-id="${source['recordId']}"] td:first-child strong`).textContent()
    expect(visibleRowKey?.trim()).toBe(secretKey)
    expect(pageErrors).toEqual([])
    await record('gap23-isolation-owner-candidate', [
      `project=${projectId}`,
      `candidate=${candidate['candidateId']}`,
      `record=${source['recordId']}`,
      'created=normal-App-upload-mapping-bind-stage',
      'publication=not-started',
    ])
    return { projectId, candidateId: candidate['candidateId'], secretKey }
  } catch (error) {
    failure = error
    throw error
  } finally {
    const failures: unknown[] = []
    try {
      await record('gap23-isolation-owner-browser-diagnostics', [
        `outcome=${failure === undefined ? 'completed' : 'failed'}`,
        ...(failure === undefined ? [] : [`failure=${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}`]),
        ...(pageErrors.length === 0 ? [] : [`pageErrors=${pageErrors.join(' | ')}`]),
      ])
    } catch (error) { failures.push(error) }
    try { await context.close() } catch (error) { failures.push(error) }
    try { await closeCaseHost(host) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...failures], 'isolation owner project teardown failed')
  }
}

beforeAll(async () => {
  await startControlDatabase()
  browser = await chromium.launch({ headless: true })
}, 300_000)

afterAll(async () => {
  const failures: Error[] = []
  const attempt = async (label: string, action: () => Promise<unknown> | undefined): Promise<void> => {
    try { await action() } catch (error) { failures.push(new Error(`${label} cleanup failed`, { cause: error })) }
  }
  await attempt('Chromium browser', async () => browser?.close())
  await attempt('control SQL admin connection', async () => controlAdmin?.end())
  await attempt('control PostgreSQL container', async () => controlPostgres?.stop())
  if (controlPostgres !== undefined) await attempt('control PostgreSQL resource verification', () => assertPostgresResourcesReclaimed(controlPostgres as PostgresContainer))
  if (failures.length > 0) throw new AggregateError(failures, 'GAP-023 final resource cleanup failed')
})

describe('GAP-023 1001-row normal App source, review and fixed-dataset acceptance', () => {
  it('imports 1001 industrial rows, publishes only the actual final target through DuckDB, and traces A1002', async () => {
    await run1001RowCase({ industry: INDUSTRIAL, backend: 'duckdb', caseName: 'industrial-duckdb', outputPrefix: 'gap23-industrial-duckdb' })
  })

  it('imports 1001 industrial rows, publishes only the actual final target through business PostgreSQL, and traces A1002', async () => {
    await run1001RowCase({ industry: INDUSTRIAL, backend: 'postgres', caseName: 'industrial-postgres', outputPrefix: 'gap23-industrial-postgres' })
  })

  it('imports 1001 transport rows, publishes only the actual final target through DuckDB, and traces A1002', async () => {
    await run1001RowCase({ industry: TRANSPORT, backend: 'duckdb', caseName: 'transport-duckdb', outputPrefix: 'gap23-transport-duckdb' })
  })

  it('imports 1001 transport rows, publishes only the actual final target through business PostgreSQL, and traces A1002', async () => {
    await run1001RowCase({ industry: TRANSPORT, backend: 'postgres', caseName: 'transport-postgres', outputPrefix: 'gap23-transport-postgres' })
  })

  it('keeps actual project and candidate links isolated across Core tenant/space scopes in the normal App', async () => {
    if (browser === undefined) throw new Error('the real Chromium browser was not initialized')
    const owner = await createScopedCandidateThroughApp()
    const probeHost = await startCaseHost({ name: 'isolation-probe', backend: 'duckdb' })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const pageErrors: string[] = []
    const evidence: string[] = []
    try {
      const page = await context.newPage()
      page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
      await page.goto(probeHost.web.origin)
      await page.waitForSelector('[data-testid="guide-home"]')
      const scenario = page.getByTestId('core-scenario-select')
      await scenario.selectOption(INDUSTRIAL.scenarioId)
      const projectList = await page.evaluate(async () => {
        const response = await fetch('/api/v1/projects')
        return { status: response.status, body: await response.json() as unknown }
      })
      expect(projectList.status).toBe(200)
      if (!isRecord(projectList.body) || !isRecord(projectList.body['data']) || !Array.isArray(projectList.body['data']['projects'])) {
        throw new Error('the second Core scope did not return its actual project list')
      }
      expect(projectList.body['data']['projects']).toHaveLength(0)
      await page.getByTestId('assistant-tab-business').click()
      await page.getByTestId('project-empty').waitFor()
      expect(await page.getByTestId('project-list-item').count()).toBe(0)
      expect(await page.locator('body').textContent()).not.toContain(owner.secretKey)

      const foreignProjectRead = await page.evaluate(async (projectId) => {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}`)
        return { status: response.status, bodyText: await response.text() }
      }, owner.projectId)
      expect(foreignProjectRead.status).toBe(404)
      expect(foreignProjectRead.bodyText).not.toContain(owner.secretKey)
      evidence.push(`foreignProjectGET=${String(foreignProjectRead.status)}`)

      const scopedCandidateList = await page.evaluate(async () => {
        const response = await fetch('/api/v1/candidates')
        return { status: response.status, body: await response.json() as unknown }
      })
      expect(scopedCandidateList.status).toBe(200)
      if (!isRecord(scopedCandidateList.body) || !isRecord(scopedCandidateList.body['data']) || !Array.isArray(scopedCandidateList.body['data']['candidates'])) {
        throw new Error('the second Core scope did not return its actual candidate inventory')
      }
      expect(scopedCandidateList.body['data']['candidates']).toHaveLength(0)
      const foreignCandidateRead = await page.evaluate(async (candidateId) => {
        const response = await fetch(`/api/v1/candidates/${encodeURIComponent(candidateId)}`)
        return { status: response.status, bodyText: await response.text() }
      }, owner.candidateId)
      expect(foreignCandidateRead.status).toBe(404)
      expect(foreignCandidateRead.bodyText).not.toContain(owner.secretKey)
      evidence.push(`scopedCandidateList=200-empty`, `foreignCandidateGET=${String(foreignCandidateRead.status)}`)

      const forgedLink = new URL(probeHost.web.origin)
      forgedLink.searchParams.set('scenarioId', INDUSTRIAL.scenarioId)
      forgedLink.searchParams.set('view', 'review')
      forgedLink.searchParams.set('project', owner.projectId)
      forgedLink.searchParams.set('candidate', owner.candidateId)
      await page.goto(forgedLink.toString())
      await page.waitForSelector('[data-testid="candidate-panel"]')
      await page.waitForFunction(() => {
        const phase = document.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase')
        return phase !== undefined && phase !== 'loading'
      })
      expect(await page.getAttribute('[data-testid="candidate-panel"]', 'data-phase')).toBe('failure')
      expect(await page.getByTestId('candidate-item').count()).toBe(0)
      expect(await page.getByTestId('candidate-detail').count()).toBe(0)
      expect(await page.locator('body').textContent()).not.toContain(owner.secretKey)
      expect(await page.url()).toContain(`candidate=${owner.candidateId}`)
      evidence.push('forgedExactProjectAndCandidateDeepLink=no-foreign-key-or-detail')
      expect(pageErrors).toEqual([])
      await record('gap23-cross-scope-isolation', [
        `ownerProject=${owner.projectId}`,
        `ownerCandidate=${owner.candidateId}`,
        `probeScope=${probeHost.scopeRef.tenantId}/${probeHost.scopeRef.spaceId}`,
        'probeProjects=200-empty',
        ...evidence,
        `pageErrors=${pageErrors.length}`,
      ])
    } finally {
      const failures: unknown[] = []
      try { await context.close() } catch (error) { failures.push(error) }
      try { await closeCaseHost(probeHost) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'GAP-023 cross-scope probe teardown failed')
    }
  })
})
