import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { chromium } from '@playwright/test'
import type { Browser, Page, Response } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { collectRealAppAccessibilityEvidence, collectRealAppDrawerEvidence } from './real-app-accessibility'

/**
 * GAP-022 project pipeline on the normal, production-composed App URL.
 *
 * PostgreSQL, Core stores/services, object bytes, parser, API, worker, static app host and
 * Chromium are real. The only SQL writes establish an isolated tenant/space and the app role;
 * the project, imported CSV, mapping, candidate, identity, field confirmations, publication and
 * dataset are all created by visible browser actions. No workspace/project harness or business
 * outcome is seeded. The selected scenario is the exact deployment profile
 * `synthetic-industrial-maintenance-demo@1.0.0` from the loaded Core examples.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `gap22_project_${randomUUID().replaceAll('-', '')}`
const SCENARIO_ID = 'industrial-asset-maintenance'
const PROFILE_ID = 'synthetic-industrial-maintenance-demo'
const PROFILE_VERSION = '1.0.0'
const SOURCE_ROW = 'GAP22-ASSET-001,network-gap22,WS-A'

let postgres: PostgresContainer | undefined
let admin: Client | undefined
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let web: WebHost | undefined
let browser: Browser | undefined
let fileDirectory = ''
let projectCsvPath = ''
const apiTrace: string[] = []
let closing = false
const workerDiagnostics: { readonly duringClose: boolean; readonly name: string; readonly code?: string; readonly message: string }[] = []

function recordWorkerError(error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  workerDiagnostics.push({
    duringClose: closing,
    name: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }),
    message: error instanceof Error ? error.message : String(error),
  })
}

function applicationConnectionString(url: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//u, '') || 'postgres'
  return `${base.protocol}//ontology_app:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

async function openPostgresScope(): Promise<{ readonly scopeRef: ScopeRef; readonly appUrl: string }> {
  postgres = await startPostgresContainer()
  await runControlMigrations({
    connectionString: postgres.adminUrl,
    migrationsDir: MIGRATIONS_DIR,
  })
  admin = new Client({ connectionString: postgres.adminUrl })
  await admin.connect()
  const scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [
    scopeRef.tenantId,
    `gap22-${scopeRef.tenantId.slice(0, 8)}`,
  ])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [
    scopeRef.tenantId,
    scopeRef.spaceId,
    'GAP-022 browser acceptance',
  ])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterRole = statement.rows[0]?.statement
  if (alterRole === undefined) throw new Error('could not configure the non-owner application role')
  await admin.query(alterRole)
  return { scopeRef, appUrl: applicationConnectionString(postgres.adminUrl, APP_PASSWORD) }
}

beforeAll(async () => {
  const { scopeRef, appUrl } = await openPostgresScope()
  fileDirectory = await mkdtemp(join(tmpdir(), 'ontology-gap22-project-'))
  projectCsvPath = join(fileDirectory, 'gap22-industrial-assets.csv')
  await writeFile(
    projectCsvPath,
    `asset_id,asset_network_code,asset_workshop_code\n${SOURCE_ROW}\n`,
    'utf8',
  )
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory: join(fileDirectory, 'objects'),
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: false,
    jevEnabled: false,
    onWorkerError: recordWorkerError,
  })
  api = createCoreApi(composition.dependencies)
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  web = await startWebHost(origin, { bindDefaultProfile: false })
  browser = await chromium.launch({ headless: true })
}, 300_000)

afterAll(async () => {
  closing = true
  const teardownErrors: Error[] = []
  const close = async (label: string, action: (() => Promise<unknown>) | undefined): Promise<void> => {
    if (action === undefined) return
    try {
      await action()
    } catch (error) {
      teardownErrors.push(new Error(`${label} teardown failed`, { cause: error }))
    }
  }
  await close('browser', browser === undefined ? undefined : () => browser?.close() ?? Promise.resolve())
  await close('web host', web === undefined ? undefined : () => web?.close() ?? Promise.resolve())
  await close('Core API', api === undefined ? undefined : () => api?.close() ?? Promise.resolve())
  await close('Core composition', composition === undefined ? undefined : () => composition?.close() ?? Promise.resolve())
  await close('PostgreSQL admin client', admin === undefined ? undefined : () => admin?.end() ?? Promise.resolve())
  await close('PostgreSQL container', postgres === undefined ? undefined : () => postgres?.stop() ?? Promise.resolve())
  if (fileDirectory !== '') await close('temporary files', async () => {
    const owned = resolve(fileDirectory)
    if (!owned.startsWith(resolve(tmpdir(), 'ontology-gap22-project-'))) throw new Error('temporary cleanup escaped the owned test directory')
    await rm(owned, { recursive: true, force: true })
  })
  try {
    await record('gap22-project-worker-diagnostics', workerDiagnostics.map((entry) => JSON.stringify(entry)))
  } catch (error) {
    teardownErrors.push(new Error('worker diagnostics could not be saved', { cause: error }))
  }
  if (workerDiagnostics.length > 0) {
    teardownErrors.push(new Error(`unexpected Core worker errors: ${workerDiagnostics.map((entry) => JSON.stringify(entry)).join('; ')}`))
  }
  if (teardownErrors.length > 0) throw new AggregateError(teardownErrors, 'GAP-022 E2E teardown or worker diagnostics failed')
})

async function waitForHidden(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { state: 'hidden' })
}

function requestPath(response: Response): string {
  return new URL(response.url()).pathname
}

describe('GAP-022 normal App project source-to-publication pipeline', () => {
  it('imports a real CSV, confirms mapping and identity, publishes the record and materializes its dataset', async () => {
    if (browser === undefined || web === undefined) throw new Error('the real Core browser host is unavailable')
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const apiFailures: string[] = []
    const apiResponses: string[] = []
    const accessibilityEvidence: string[] = []
    let stagedFactCandidateId: string | undefined
    let factSemanticPublicationStarted = false
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/')) {
        apiTrace.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/api/v1/')) {
        apiResponses.push(`${response.status()} ${response.request().method()} ${requestPath(response)}`)
        const expectedNoPriorStatement = response.status() === 404 &&
          response.request().method() === 'GET' && stagedFactCandidateId !== undefined &&
          !factSemanticPublicationStarted && requestPath(response) === `/api/v1/statements/${stagedFactCandidateId}`
        if (response.status() >= 400 && !expectedNoPriorStatement) {
          apiFailures.push(`${response.status()} ${requestPath(response)}`)
        }
      }
    })
    try {
      // Start at the ordinary App URL, select the registered scenario, then navigate through
      // the visible product navigation rather than opening a harness page or internal API.
      await page.goto(web.origin)
      await page.waitForSelector('[data-testid="guide-home"]')
      await waitForHidden(page, '[data-testid="context-workspace-loading"]')
      const scenario = page.getByTestId('core-scenario-select')
      await scenario.waitFor()
      await scenario.selectOption(SCENARIO_ID)
      expect(await scenario.locator('option:checked').getAttribute('value')).toBe(SCENARIO_ID)
      const selectedScenario = await scenario.locator('option:checked').textContent()
      expect(selectedScenario).toContain('工业资产维护')

      await page.getByTestId('tab-projects').click()
      await page.waitForSelector('[data-testid="project-workspace"]')
      await page.waitForSelector('[data-testid="project-create-title"]')
      const initialAccessibility = await collectRealAppAccessibilityEvidence(page, {
        state: 'project-create-empty',
        visibleControls: [
          { name: 'project title', locator: page.getByTestId('project-create-title') },
          { name: 'published package version', locator: page.getByTestId('project-create-pack') },
          { name: 'deployment scenario', locator: page.getByTestId('core-scenario-select') },
        ],
        contrastProbes: [
          { name: 'project creation heading', locator: page.locator('[data-testid="project-create"] h3') },
          { name: 'project title label', locator: page.locator('[data-testid="project-create-title"]').locator('xpath=..') },
          { name: 'project creation submit text', locator: page.getByTestId('project-create-submit') },
        ],
        motionProbes: [{ name: 'project title control', locator: page.getByTestId('project-create-title') }],
        nativeControlProbes: [{ name: 'project title control', locator: page.getByTestId('project-create-title') }],
      })
      accessibilityEvidence.push(JSON.stringify(initialAccessibility))

      const createResponse = page.waitForResponse((response) =>
        requestPath(response) === '/api/v1/core/project-bootstrap' && response.request().method() === 'POST',
      )
      await page.getByTestId('project-create-title').fill('GAP-022 原始资料项目')
      await page.getByTestId('project-create-submit').click()
      const createdResponse = await createResponse
      expect(createdResponse.status()).toBe(201)
      const created = await createdResponse.json() as {
        data: { project: { projectId: string; title: string }; revision: { profileRef: { id: string; version: string } } }
      }
      expect(created.data.project.title).toBe('GAP-022 原始资料项目')
      expect(created.data.revision.profileRef).toMatchObject({ id: PROFILE_ID, version: PROFILE_VERSION })
      const projectId = created.data.project.projectId
      await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${projectId}"]`)
      expect(new URL(page.url()).searchParams.get('project')).toBe(projectId)
      const selectedProject = page.getByTestId('context-project-select').locator('option:checked')
      expect(await selectedProject.getAttribute('value')).toBe(projectId)
      expect(await selectedProject.textContent()).toContain('GAP-022 原始资料项目')
      expect(await page.textContent('[data-testid="project-detail-head-revision"]')).toBe('1')
      await capture(page, 'gap22-project-created-1440')

      // Upload the actual bytes by using the visible file input and import action.
      await page.getByRole('button', { name: '导入资料', exact: true }).click()
      const csvInput = page.getByTestId('project-file')
      await csvInput.setInputFiles(projectCsvPath)
      const importResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/structured-imports$/u.test(requestPath(response)),
      )
      await page.getByTestId('project-file-submit').click()
      const importedResponse = await importResponse
      expect(importedResponse.ok()).toBe(true)
      await page.waitForSelector('[data-testid="project-file-result"][data-status="complete"]')
      expect(await page.textContent('[data-testid="project-file-result"]')).toContain('共 1 行')
      const importedPayload = await importedResponse.json() as { data: { originalRef: { digest: string } } }
      expect(importedPayload.data.originalRef.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
      await page.locator('[data-testid="source-candidate"]').waitFor()
      await capture(page, 'gap22-project-source-imported-1440')

      await page.locator('[data-testid="source-candidate"]')
        .getByRole('button', { name: '确认这份资料的映射' })
        .click()
      await page.waitForSelector('[data-testid="project-mapping"]:not([hidden])')
      await page.getByTestId('mapping-source').selectOption({ index: 1 })
      await page.getByTestId('mapping-object').selectOption('industrial_asset')
      const requiredFields = await page.locator('[data-testid="mapping-fields"] tbody tr[data-required="true"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')?.replace('mapping-field-', '') ?? ''))
      expect(requiredFields.sort()).toEqual(['asset_id', 'asset_network_code', 'asset_workshop_code'])
      for (const field of requiredFields) {
        await page.getByTestId(`mapping-column-${field}`).selectOption({ label: field })
      }
      const previewResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/mappings\/preview$/u.test(requestPath(response)),
      )
      await page.getByTestId('mapping-preview-button').click()
      expect((await previewResponse).ok()).toBe(true)
      await page.waitForSelector('[data-testid="mapping-preview"][data-confirmable="true"]')
      expect(await page.textContent('[data-testid="mapping-preview-rows"]')).toContain('1')
      const identityPreview = page.getByTestId('mapping-preview-asset_id')
      expect(await identityPreview.locator('td:nth-child(2)').textContent()).toBe('GAP22-ASSET-001')
      expect(await identityPreview.locator('td:nth-child(3)').textContent()).toBe('GAP22-ASSET-001')
      // The mapping preview now shows 规范字段 | 原始值 | 规范值 | 单位 | 实际定位 (design §1.5/N07):
      // a string field has no unit, and the original cell address moved to the locator column.
      expect(await identityPreview.locator('td:nth-child(4)').textContent()).toBe('—')
      expect(await identityPreview.locator('td:nth-child(5)').textContent()).toContain('A2')
      await capture(page, 'gap22-project-mapping-preview-1440')

      const confirmMappingResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/mappings$/u.test(requestPath(response)),
      )
      await page.getByTestId('mapping-confirm-button').click()
      expect((await confirmMappingResponse).ok()).toBe(true)
      await page.getByTestId('mapping-confirmed').waitFor()
      await page.getByTestId('record-bind').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="bind-notice"]')?.textContent?.includes('已绑定 1 条记录') === true)
      const recordsStepCatalogue = page.waitForResponse((response) =>
        response.request().method() === 'GET' && requestPath(response) === `/api/v1/core/projects/${projectId}/source-catalogue`,
      )
      await page.getByRole('button', { name: '项目记录', exact: true }).click()
      await page.waitForSelector('[data-testid="record-row"][data-status="confirmed"]')
      expect((await recordsStepCatalogue).ok()).toBe(true)
      expect(await page.textContent('[data-testid="record-total"]')).toContain('1')
      await page.getByTestId('project-stage-facts').waitFor()
      expect(await page.getByTestId('project-fact-staging').textContent()).toContain('当前页 1 条记录')
      expect(await page.getByTestId('project-stage-facts').isEnabled()).toBe(true)
      const candidateResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/core\/projects\/[^/]+\/fact-candidates$/u.test(requestPath(response)),
      )
      await page.getByTestId('project-stage-facts').click()
      const stagedResponse = await candidateResponse
      expect(stagedResponse.status()).toBe(201)
      const stagedPayload = await stagedResponse.json() as { data: { candidates: readonly { candidateId: string }[] } }
      expect(stagedPayload.data.candidates).toHaveLength(1)
      const factCandidateId = stagedPayload.data.candidates[0]?.candidateId
      if (factCandidateId === undefined) throw new Error('the UI did not stage a source-backed project fact candidate')
      stagedFactCandidateId = factCandidateId
      await page.getByTestId('project-create-reviews').waitFor()
      await page.getByTestId('project-create-reviews').click()
      await page.waitForSelector('[data-testid="instance-review"]')
      await page.locator('[data-testid="instance-record-item"]').first().click()
      await page.waitForSelector('[data-testid="instance-detail"]')

      // Confirm every mapped source field in the actual record UI before resolving identity.
      for (const field of requiredFields) {
        const row = page.locator(`[data-testid="instance-field-row"][data-field-id="${field}"]`)
        await row.getByTestId('instance-field-confirm').click()
        await row.locator('[data-testid="instance-field-status"][data-status="confirmed"]').waitFor()
      }
      await page.getByTestId('instance-identity-reason').fill('核对实际上传文件中的设备原始编码')
      const identityResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/instance-records\/[^/]+\/identity-decisions$/u.test(requestPath(response)),
      )
      await page.getByTestId('instance-identity-create').click()
      expect((await identityResponse).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('已新建') === true)

      const approveResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/instance-records\/[^/]+\/approve$/u.test(requestPath(response)),
      )
      await page.getByTestId('instance-approve').click()
      expect((await approveResponse).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent?.includes('已批准') === true)
      const publishResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/instance-records\/[^/]+\/publish$/u.test(requestPath(response)),
      )
      await page.getByTestId('instance-publish').click()
      expect((await publishResponse).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent === '已发布')
      await capture(page, 'gap22-project-instance-published-1440')

      // Read the exact persisted CSV source and cell through the review surface. This is an
      // actual accessible source action; keyboard Escape must return focus to that same trigger.
      const sourceButton = page.locator('[data-testid="instance-field-row"][data-field-id="asset_id"] [data-testid="instance-field-source"] button')
      await sourceButton.focus()
      await page.keyboard.press('Enter')
      const sourceDialog = page.getByRole('dialog', { name: '字段来源' })
      await sourceDialog.waitFor()
      await sourceDialog.locator('[data-testid="answer-source-fragment"] button').first().click()
      await sourceDialog.getByTestId('original-cell-location').waitFor()
      expect(await sourceDialog.getByTestId('original-cell-location').textContent()).toContain('GAP22-ASSET-001')
      expect(await sourceDialog.getByTestId('original-cell-location').textContent()).toContain('A2')
      await capture(page, 'gap22-project-original-cell-drawer-1440')
      const drawerAccessibility = await collectRealAppDrawerEvidence(page, { dialog: sourceDialog, trigger: sourceButton })
      expect(drawerAccessibility.focusReturned).toBe(true)
      accessibilityEvidence.push(JSON.stringify({ state: 'project-original-cell-source-drawer', ...drawerAccessibility }))

      // Instance publication completes the human field/identity review record. The fact itself
      // becomes an official semantic fact only after candidate review and semantic publication,
      // which is a separate visible action in the ordinary Candidate Review panel.
      await page.getByTestId('tab-review').click()
      const leavePrompt = page.getByRole('dialog', { name: '离开当前工作内容？' })
      if (await leavePrompt.isVisible()) await page.getByTestId('shell-discard-changes').click()
      await page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'review')
      await page.waitForSelector('[data-testid="candidate-panel"]')
      await page.waitForFunction(() => {
        const phase = document.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase')
        return phase !== undefined && phase !== 'loading'
      })
      const candidatePhase = await page.getAttribute('[data-testid="candidate-panel"]', 'data-phase')
      if (candidatePhase !== 'ready') {
        throw new Error(`candidate review did not load for the project fact candidate (phase=${candidatePhase}): ${await page.textContent('[data-testid="candidate-panel"]') ?? ''}`)
      }
      await page.waitForSelector('[data-testid="candidate-list"]')
      const candidateItems = page.getByTestId('candidate-item')
      let selectedFactCandidate = false
      for (let index = 0; index < await candidateItems.count(); index += 1) {
        await candidateItems.nth(index).click()
        await page.waitForSelector('[data-testid="candidate-detail"]')
        if (await page.textContent('[data-testid="candidate-id"]') === factCandidateId) {
          selectedFactCandidate = true
          break
        }
      }
      expect(selectedFactCandidate).toBe(true)
      expect(await page.getByTestId('candidate-detail').getAttribute('data-kind')).toBe('entity')
      const semanticReviewResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/candidates\/[^/]+\/reviews$/u.test(requestPath(response)),
      )
      await page.getByTestId('review-reason').fill('依据已审核的项目字段与来源单元格批准事实发布')
      await page.getByTestId('review-approve').click()
      expect((await semanticReviewResponse).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="review-head"]')?.getAttribute('data-approved') === 'true')
      const semanticPublicationResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && requestPath(response) === '/api/v1/semantic-publications',
      )
      factSemanticPublicationStarted = true
      await page.getByTestId('publish').click()
      expect((await semanticPublicationResponse).ok()).toBe(true)
      await page.waitForSelector('[data-testid="statement-current"][data-status="active"]')
      await capture(page, 'gap22-project-fact-semantics-published-1440')

      // Materialize the just-published record using the user-facing project action.
      await page.getByTestId('tab-projects').click()
      const returnPrompt = page.getByRole('dialog', { name: '离开当前工作内容？' })
      if (await returnPrompt.isVisible()) await page.getByTestId('shell-discard-changes').click()
      await page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'projects')
      await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${projectId}"]`)
      await page.getByRole('button', { name: '项目记录', exact: true }).click()
      await page.getByTestId('dataset-object').selectOption('industrial_asset')
      const materializationResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && /\/api\/v1\/projects\/[^/]+\/dataset-snapshots$/u.test(requestPath(response)),
      )
      await page.getByTestId('dataset-materialize').click()
      const materialized = await materializationResponse
      const materializationBody = await materialized.text()
      expect(materialized.ok(), `dataset materialization returned ${materialized.status()}: ${materializationBody}`).toBe(true)
      await page.waitForSelector('[data-testid="dataset-status"][data-state="ready"]', { timeout: 60_000 })
      await page.waitForFunction(() => document.querySelector('[data-testid="readiness-state-dataset"]')?.textContent === '已就绪')

      // Capture the responsive project state at the four required widths.
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await capture(page, `gap22-project-materialized-${width}`)
      }
      await record('gap22-project-pipeline', [
        `scenario=${SCENARIO_ID}`,
        `profile=${PROFILE_ID}@${PROFILE_VERSION}`,
        `project=${projectId}`,
        'file=actual-browser-uploaded-csv',
        'mapping=server-previewed-and-confirmed',
        'record=field-confirmed+identity-created+approved+published',
        `expectedPrepublishProbe=404 GET /api/v1/statements/${stagedFactCandidateId}`,
        'source=original-csv-cell-row-2-column-1-value-GAP22-ASSET-001',
        'dataset=ready-after-visible-materialize-action',
        'viewports=1440,1024,768,390,320; page-level-horizontal-overflow=none',
        ...accessibilityEvidence.map((report) => `accessibility=${report}`),
        ...apiTrace,
        ...apiResponses,
        ...(apiFailures.length === 0 ? [] : [`apiFailures=${apiFailures.join(',')}`]),
      ])
      expect(apiFailures).toEqual([])
    } finally {
      await context.close()
    }
  })
})
