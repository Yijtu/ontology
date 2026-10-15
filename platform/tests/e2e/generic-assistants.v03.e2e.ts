import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { contentDigestOf } from '@ontology/application'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { isRecord, isVersionRef } from '@ontology/contracts'
import type { ProjectEvolutionRecord, ResolvedProfileRef, ResourceRef, ScopeRef, VersionRef } from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { confirmOrDefinitions, prepareEvolutionRemapping, prepareOrCompetency, prepareOrSource } from './generic-or-fixture'

/**
 * V03-045 (#217) generic dual-assistant full-stack browser E2E.
 *
 * One real environment drives the whole A.US-016 journey: a throwaway PostgreSQL container, the
 * real `createCoreLocalComposition` host (real control stores, real immutable blob store, real
 * DuckDB snapshot, the durable job worker and the durable workflow dispatch/controller), the real
 * built web app served by the loopback static host, and a real Chromium page. Nothing about the
 * Controller, Worker or persistence is mocked. The only substitute is the generative model:
 * a loopback OpenAI-compatible server returns controlled definition and rule proposals
 * (recorded explicitly in the run log); no candidates, derived conclusions or
 * answers are pre-seeded.
 *
 * Coverage is marked per test: browser-verified steps drive the real UI over real HTTP; host-HTTP
 * steps drive the same real host directly where the main app shell has no surface for them.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const TRANSPORT_REGISTRY = fileURLToPath(new URL('../../deploy/core/examples/transport-facility/records/registry-a.txt', import.meta.url))
const INDUSTRIAL_CANONICAL = fileURLToPath(new URL('../../deploy/core/examples/industrial-maintenance/records/canonical-layout.txt', import.meta.url))
const APP_PASSWORD = `generic_e2e_${randomUUID().replaceAll('-', '')}`
const MODEL_SECRET = 'test-only-controlled-definition-secret'
const DIGEST = `sha256:${'a'.repeat(64)}`
const POLICY_REF = { id: 'ontology.tbox.policy', version: '1.0.0', digest: DIGEST }
const TRANSPORT_SCENARIO = 'transport-facility-inspection'
const INDUSTRIAL_SCENARIO = 'industrial-asset-maintenance'
const UNKNOWN_PROPERTY_QUESTION = 'facts:not_registered'

/** The single controlled definition-candidate response served for the generation model. */
const GENERATED_DEFINITION = {
  objects: [
    {
      logicalId: 'asset',
      displayName: 'Asset',
      businessMeaning: 'A maintained physical asset',
      suggestedReason: 'named in the source',
      identityAttributeIds: ['asset_code'],
    },
  ],
  attributes: [
    {
      logicalId: 'asset_code',
      displayName: 'Asset code',
      businessMeaning: 'The stable code that identifies an asset',
      suggestedReason: 'named in the source',
      objectLogicalId: 'asset',
      valueType: 'string',
      minCardinality: 1,
      maxCardinality: 1,
    },
    {
      logicalId: 'inspection_due',
      displayName: 'Inspection due',
      businessMeaning: 'Whether the next scheduled inspection is due',
      suggestedReason: 'named in the source',
      objectLogicalId: 'asset',
      valueType: 'boolean',
      minCardinality: 0,
      maxCardinality: 1,
    },
    {
      logicalId: 'inspection_required',
      displayName: 'Inspection required',
      businessMeaning: 'Whether the reviewed inspection rule requires an inspection',
      suggestedReason: 'the rule conclusion is declared by the reviewed source',
      objectLogicalId: 'asset',
      valueType: 'boolean',
      minCardinality: 0,
      maxCardinality: 1,
    },
  ],
  relations: [],
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let otherScopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let otherComposition: CoreLocalComposition | undefined
let otherApi: ReturnType<typeof createCoreApi> | undefined
let otherBaseUrl = ''
let modelServer: Server | undefined
let modelServerBaseUrl = ''
let web: WebHost
let browser: Browser
let closingComposition = false
const workerDiagnostics: { readonly duringClose: boolean; readonly name: string; readonly code?: string; readonly message: string }[] = []

function recordWorkerError(error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  workerDiagnostics.push({ duringClose: closingComposition, name: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }), message: error instanceof Error ? error.message : String(error) })
}

const modelRequests: string[] = []

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    modelRequests.push(rawBody)
    const decoded: unknown = JSON.parse(rawBody)
    const messages = typeof decoded === 'object' && decoded !== null && 'messages' in decoded && Array.isArray(decoded.messages) ? decoded.messages : []
    const systemText = messages.flatMap((entry: unknown) => typeof entry === 'object' && entry !== null && 'role' in entry && entry.role === 'system' && 'content' in entry && typeof entry.content === 'string' ? [entry.content] : []).join('\n')
    const content = systemText.includes('Propose candidate rules/actions only')
      ? JSON.stringify({ rules: [{ kind: 'rule', ruleId: 'inspection_required', objectId: 'asset', displayName: 'Inspection required', businessMeaning: 'An asset requires an inspection when the source condition applies', suggestedReason: 'The original policy states this condition', applicabilityNote: 'Applies to the identified asset', condition: { op: 'compare', attributeId: 'inspection_due', operator: 'eq', value: true }, exceptions: [], conclusion: { predicate: 'inspection_required', value: true }, ruleDependencies: [], sourceSelections: ['applicability', 'condition', 'conclusion'].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })) }], actions: [] })
      : systemText.includes('Select one enabled task using the supplied semantic catalog')
        ? JSON.stringify({ kind: 'rule_judgement', rule: 'inspection_required', entity: 'GAP22-ASSET-001', object: 'asset' })
        : JSON.stringify(GENERATED_DEFINITION)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const frames = [
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-extractor', choices: [{ index: 0, delta: { content }, finish_reason: null }], usage: null },
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-extractor', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
      { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-extractor', choices: [], usage: { prompt_tokens: 10, completion_tokens: 12 } },
    ]
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

async function seedScope(target: ScopeRef, slug: string): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [target.tenantId, slug])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [target.tenantId, target.spaceId, slug])
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  otherScopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await seedScope(scopeRef, `generic-e2e-${scopeRef.tenantId.slice(0, 8)}`)
  await seedScope(otherScopeRef, `generic-e2e-other-${otherScopeRef.tenantId.slice(0, 8)}`)
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  appUrl = connectionStringFor(container.adminUrl, 'ontology_app', APP_PASSWORD)
}

async function buildHostFor(
  target: ScopeRef,
): Promise<{ composition: CoreLocalComposition; api: ReturnType<typeof createCoreApi>; baseUrl: string }> {
  const built = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef: target,
    examples: loadCoreExamples({ targetScopeRef: target }),
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: false,
    onWorkerError: recordWorkerError,
    modelEnvironment: {
      CORE_ENABLE_MODELS: 'true',
      CORE_COMPANY_MODEL_BASE_URL: modelServerBaseUrl,
      CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
      CORE_COMPANY_MODEL_API_KEY: MODEL_SECRET,
      CORE_COMPANY_MODEL_PLATFORM_ID: 'core-company-extractor',
      CORE_COMPANY_MODEL_VENDOR_MODEL: 'synthetic-vendor-extractor',
      CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
    },
  })
  const app = createCoreApi(built.dependencies)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  return { composition: built, api: app, baseUrl: address.replace(/\/$/u, '') }
}

function request(target: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${target}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
}

function jsonRequest(target: string, path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return request(target, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `generic-${randomUUID()}`, ...extra },
    body: JSON.stringify(body),
  })
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${String(response.status)}: ${text}`)
  }
  return await response.json() as T
}

async function ordinaryCall(path: string, body?: unknown, revision?: string): Promise<Record<string, unknown>> {
  const response = body === undefined ? await request(baseUrl, path)
    : await jsonRequest(baseUrl, path, body, revision === undefined ? {} : { 'if-match': revision })
  return (await readJson<{ data: Record<string, unknown> }>(response)).data
}

interface JobView {
  readonly stage: string
  readonly counts: { readonly processed: number }
}

async function waitForJob(jobId: string): Promise<JobView> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const body = await readJson<{ data: JobView }>(await request(baseUrl, `/api/v1/jobs/${jobId}`))
    if (body.data.stage === 'awaiting_review' || body.data.stage === 'failed') return body.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} never reached awaiting_review`)
}

interface CandidateSummary {
  readonly candidateId: string
  readonly kind: string
  readonly nativeId?: string
}

async function findNativeCandidate(jobId: string, nativeId: string): Promise<string> {
  const body = await readJson<{ data: { candidates: CandidateSummary[] } }>(
    await request(baseUrl, `/api/v1/candidates?jobId=${encodeURIComponent(jobId)}&kind=entity`),
  )
  for (const summary of body.data.candidates) {
    const detail = await readJson<{ data: { candidate: { nativeId?: string } } }>(
      await request(baseUrl, `/api/v1/candidates/${summary.candidateId}`),
    )
    if (detail.data.candidate.nativeId === nativeId) return summary.candidateId
  }
  throw new Error(`no entity candidate with native id ${nativeId} was produced`)
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(baseUrl, `/api/v1/runs/${runId}/answer`)
    if (response.status === 200) {
      const body = await response.json() as { data: Record<string, unknown> }
      return body.data
    }
    if (response.status !== 202) {
      throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never published an answer`)
}

/** Drive the browser through the real UI: import raw records, identity review, publish, query. */
let importedJobId = ''
let targetCandidateId = ''
let publishedRunId = ''
let publishedWorkspaceId = ''
let publishedPackRef: { id: string; version: string; digest: string } | undefined
let publishedWorkspaceSource: Awaited<ReturnType<typeof prepareOrSource>> | undefined
let gap22FlowWorkspaceId = ''
let gap22FlowPackRef: { id: string; version: string; digest: string } | undefined
let gap22FlowTargetPackRef: { id: string; version: string; digest: string } | undefined
let gap22FlowProjectId = ''
let gap22FlowRunId = ''
let gap22FlowCsvRef: VersionRef | undefined
let gap22FlowFactCandidateIds = new Set<string>()
let gap22FlowEntityId = ''
let gap22FlowIdentityScopeId = ''

async function newPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
  try {
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    return { page, close: async () => {
      await context.close()
      expect(pageErrors, 'uncaught errors in the actual App page').toEqual([])
    } }
  } catch (error) {
    try { await context.close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'failed to create the real-browser page and close its owned context') }
    throw error
  }
}

async function discardIfNeeded(page: Page): Promise<void> {
  const prompt = page.getByRole('dialog', { name: '离开当前工作内容？' })
  if (await prompt.isVisible()) await page.getByTestId('shell-discard-changes').click()
}

beforeAll(async () => {
  await startIsolatedDatabase()
  modelServerBaseUrl = await startControlledModelServer()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-generic-e2e-'))
  const primary = await buildHostFor(scopeRef)
  composition = primary.composition
  api = primary.api
  baseUrl = primary.baseUrl
  // A real Core deployment must supply its scenarios, so do not bind the legacy fixture profile.
  web = await startWebHost(baseUrl, { bindDefaultProfile: false })
  browser = await chromium.launch({ headless: true })
}, 300_000)

afterAll(async () => {
  closingComposition = true
  const teardownErrors: string[] = []
  const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action() } catch (error) { teardownErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  await attempt('browser', async () => browser?.close())
  await attempt('web host', async () => web?.close())
  await attempt('primary Core API', async () => api?.close())
  await attempt('primary Core composition', async () => composition?.close())
  await attempt('other Core API', async () => otherApi?.close())
  await attempt('other Core composition', async () => otherComposition?.close())
  await attempt('PostgreSQL admin client', async () => admin?.end())
  if (modelServer !== undefined) await attempt('controlled model server', async () => new Promise<void>((resolve, reject) => {
    modelServer?.close((error) => error === undefined ? resolve() : reject(error))
  }))
  if (objectDirectory !== '') await attempt('object directory', async () => {
    const owned = resolve(objectDirectory)
    const root = resolve(tmpdir())
    if (owned === root || !relative(root, owned).split(sep).every((segment) => segment.length > 0 && segment !== '..')) throw new Error('refusing cleanup outside the owned OS temporary root')
    await rm(owned, { recursive: true, force: true })
  })
  await attempt('owned PostgreSQL container and volume', async () => container?.stop())
  await record('gap-022-generic-worker-diagnostic', workerDiagnostics.map((entry) => JSON.stringify(entry)))
  expect(teardownErrors).toEqual([])
  expect(workerDiagnostics).toEqual([])
})

describe('V03-045 generic dual-assistant full-stack E2E (real chromium, real host)', () => {
  it('[browser] loads the real deployment picker and mounted scenarios', async () => {
    const { page, close } = await newPage()
    try {
      await page.goto(`${web.origin}/?view=jobs`)
      await page.waitForSelector('[data-testid="core-deployment-picker"]')
      await page.waitForSelector('[data-testid="core-import-panel"]')
      const scenarios = await page.locator('[data-testid="core-scenario-select"] option').allTextContents()
      expect(scenarios.length).toBeGreaterThanOrEqual(2)
      expect(await page.textContent('[data-testid="core-deployment-classification"]')).toContain('合成')
      expect(await page.textContent('[data-testid="core-deployment-mode"]')).toContain('本地操作员')
      expect(await page.locator('[data-testid="tab-query"]').count()).toBe(1)
      await capture(page, 'v03-045-1-deployment-picker')
      await record('v03-045-1-deployment-picker', [
        `scenarios=${String(scenarios.length)}`,
        'classification=synthetic',
        'mode=operator',
      ])
    } finally {
      await close()
    }
  }, 120_000)

  it('[browser] imports raw records through the real Jobs UI and drives the real worker', async () => {
    const { page, close } = await newPage()
    try {
      await page.goto(`${web.origin}/?view=jobs`)
      await page.waitForSelector('[data-testid="core-import-panel"]')
      await page.selectOption('[data-testid="core-import-scenario"]', TRANSPORT_SCENARIO)
      await page.selectOption('[data-testid="core-import-source"]', 'registry-a')
      const content = await readFile(TRANSPORT_REGISTRY, 'utf8')
      await page.fill('[data-testid="core-import-content"]', content)
      await page.click('[data-testid="core-import-submit"]')
      await page.waitForSelector('[data-testid="core-import-notice"]')
      const notice = await page.textContent('[data-testid="core-import-notice"]')
      const jobId = /([0-9a-f-]{36})/iu.exec(notice ?? '')?.[1]
      if (jobId === undefined) throw new Error(`the import notice carried no job id: ${notice ?? ''}`)
      importedJobId = jobId
      // The real worker drains the job; the panel loads on demand, so re-read the terminal stage
      // through the real UI instead of trusting the first snapshot taken right after submit.
      expect((await waitForJob(importedJobId)).stage).toBe('awaiting_review')
      await page.click('[data-testid="job-load"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="job-stages"]')?.getAttribute('data-stage') === 'awaiting_review',
        undefined,
        { timeout: 30_000 },
      )
      expect(await page.getAttribute('[data-testid="job-stages"]', 'data-stage')).toBe('awaiting_review')
      await capture(page, 'v03-045-2-import-awaiting-review')
      await record('v03-045-2-import-awaiting-review', [`jobId=${jobId}`, 'stage=awaiting_review'])
    } finally {
      await close()
    }
  }, 120_000)

  it('[browser] resolves identity, approves and publishes the T-04 entity through the real Review UI', async () => {
    targetCandidateId = await findNativeCandidate(importedJobId, 'T-04')
    const { page, close } = await newPage()
    try {
      await page.goto(`${web.origin}/?view=review&candidate=${targetCandidateId}`)
      await page.waitForSelector(`[data-testid="candidate-id"]`)
      expect(await page.textContent('[data-testid="candidate-id"]')).toBe(targetCandidateId)

      await page.click('[data-testid="decision-create_pending"]')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="decision-record"]').length === 1)
      // create_pending mints the entity; the panel prefills it, so wait before the match decision.
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="target-entity"]') as HTMLInputElement | null)?.value.length !== 0,
      )
      // A match needs a reviewer justification or a strong identity; record the human justification.
      await page.fill('[data-testid="justification"]', 'operator confirmed the native identity T-04')
      await page.click('[data-testid="decision-match"]')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="decision-record"]').length === 2, undefined, { timeout: 30_000 })

      await page.click('[data-testid="review-approve"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="review-head"]')?.getAttribute('data-approved') === 'true',
      )
      await page.click('[data-testid="publish"]')
      await page.waitForSelector('[data-testid="statement-current"]')
      expect(await page.getAttribute('[data-testid="statement-current"]', 'data-status')).toBe('active')
      await capture(page, 'v03-045-3-review-published')
      await record('v03-045-3-review-published', [
        `candidateId=${targetCandidateId}`,
        'decisions=create_pending,match',
        'review=approve',
        'statement=active',
      ])
    } finally {
      await close()
    }
  }, 120_000)

  it('[browser] asks a property fact through the real Query UI, renders the verified answer and reads provenance', async () => {
    const { page, close } = await newPage()
    try {
      page.on('request', (request) => {
        const match = /\/api\/v1\/runs\/([0-9a-f-]{36})\b/iu.exec(request.url())
        if (match?.[1] !== undefined) publishedRunId = match[1]
      })
      await page.goto(`${web.origin}/?view=query`)
      await page.waitForSelector('[data-testid="query-ask"]')
      const tasks = await page.locator('[data-testid="query-registered-task"] option').allTextContents()
      expect(tasks).toContain('facts:inspection_due')
      await page.getByText('已注册快捷读取格式', { exact: true }).click()
      await page.selectOption('[data-testid="query-registered-task"]', 'facts:inspection_due')
      await page.getByText('执行选项', { exact: true }).click()
      await page.selectOption('[data-testid="query-route"]', 'template')
      await page.click('[data-testid="query-ask"]')
      await page.waitForSelector('[data-testid="query-answer"][data-answer-state="published"]', { timeout: 60_000 })
      expect(await page.locator('[data-testid="published-answer-body"]').count()).toBe(1)
      const hash = await page.textContent('[data-testid="answer-hash"]')
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/u)
      const answerId = await page.textContent('[data-testid="answer-id"]')
      expect(answerId).not.toBeNull()
      expect(publishedRunId).toMatch(/^[0-9a-f-]{36}$/u)

      // The verified answer exposes its archived evidence; opening it drives the real evidence view.
      await page.click('[data-testid="published-answer-evidence-reference"]')
      const resultEvidence = page.getByRole('dialog', { name: '答案来源' })
      await resultEvidence.waitFor()
      const evidenceNavigation = page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'evidence' ||
        [...document.querySelectorAll('dialog[open]')].some((dialog) => dialog.textContent?.includes('离开当前工作内容？') === true))
      await resultEvidence.getByRole('button', { name: '查看完整来源页面' }).click()
      await evidenceNavigation
      await discardIfNeeded(page)
      await page.waitForSelector('[data-testid="evidence-panel"]')
      await page.getByText('核验、时间与版本详情', { exact: true }).click()
      await page.waitForSelector('[data-testid="basis-outcome"]')
      expect(await page.textContent('[data-testid="basis-outcome"]')).toBe('verifiable')
      expect(await page.textContent('[data-testid="basis-integrity"]')).toBe('true')
      await capture(page, 'v03-045-4-query-answer-evidence')
      await record('v03-045-4-query-answer-evidence', [
        'question=facts:inspection_due',
        `answerHash=${hash ?? ''}`,
        'evidence=verifiable',
      ])
    } finally {
      await close()
    }
  }, 120_000)

  it('[host-http] generates, edits, reviews, validates and publishes an industry pack with a different-condition OR', async () => {
    const workspaceId = await createWorkspace('generic-e2e')
    publishedWorkspaceId = workspaceId
    const source = await prepareOrSource({ workspaceId, call: ordinaryCall })
    publishedWorkspaceSource = source
    const candidates = await generateCandidates(workspaceId, { sourceRefs: [source.sourceRef], generationPolicyRef: source.generationPolicyRef })
    const attribute = candidates.find((candidate) => candidate.kind === 'attribute')
    if (attribute === undefined) throw new Error('generation produced no attribute candidate')
    expect(modelRequests.length).toBeGreaterThanOrEqual(1)

    const edited = await readJson<{ data: { candidates: GeneratedCandidate[] } }>(await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/candidates/${attribute.candidateId}/edits`, {
      payload: { ...attribute.payload, businessMeaning: 'Whether the next scheduled inspection is due' },
      reason: 'clarify the business meaning',
    }, { 'if-match': await workspaceHead(workspaceId) }))
    const editedAttribute = edited.data.candidates.find((candidate) => candidate.kind === 'attribute')
    if (editedAttribute === undefined) throw new Error('definition edit returned no current attribute revision')
    expect(editedAttribute.candidateId).not.toBe(attribute.candidateId)
    await confirmOrDefinitions({ workspaceId, sourceRef: source.sourceRef,
      candidateIds: [editedAttribute.candidateId, ...candidates.filter((candidate) => candidate.candidateId !== attribute.candidateId).map((candidate) => candidate.candidateId)],
      call: ordinaryCall })

    // A genuine different-condition OR is executable (V03-026 / #188) and must enable.
    let orRule = await ingestRule(workspaceId, {
      ruleId: 'inspection_due_or_network',
      displayName: 'Inspection due or demo network',
      businessMeaning: 'Two genuinely different conditions combine with OR',
      objectId: 'asset',
      condition: {
        op: 'any',
        operands: [
          { op: 'compare', attributeId: 'inspection_due', operator: 'eq', value: true },
          { op: 'compare', attributeId: 'asset_code', operator: 'eq', value: 'asset-code-1' },
        ],
      },
    })
    const groundedRule = await readJson<{ data: { candidates: readonly { candidateId: string; contentDigest: string }[] } }>(
      await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${orRule.candidateId}/source-confirmations`, {
        contentDigest: orRule.contentDigest,
        sourceRefs: [source.sourceRef],
        sourceSelections: ['applicability', 'condition', 'condition.operands[0]', 'condition.operands[1]'].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })),
        reason: 'independently checked the original policy for applicability and both distinct OR operands',
      }, { 'if-match': await workspaceHead(workspaceId) }),
    )
    const groundedRuleHead = groundedRule.data.candidates[0]
    if (groundedRuleHead === undefined) throw new Error('the genuine OR rule source confirmation returned no current candidate')
    orRule = { ...orRule, candidateId: groundedRuleHead.candidateId, contentDigest: groundedRuleHead.contentDigest }
    await readJson(await jsonRequest(baseUrl, `/api/v1/candidates/${orRule.candidateId}/reviews`, {
      decision: 'approve', reason: 'human reviewed both distinct source-confirmed OR conditions without dropping either operand',
    }, { 'if-match': '0' }))
    const enabled = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${orRule.candidateId}/enable`, {}, { 'if-match': await workspaceHead(workspaceId) })
    expect(enabled.status).toBe(200)
    expect((await enabled.json() as { data: { candidate: { lifecycle: string } } }).data.candidate.lifecycle).toBe('enabled')

    const exampleSetId = await createExampleSet(workspaceId, orRule.ruleId)
    const competency = await prepareOrCompetency({ baseUrl, workspaceId, exampleSetId, scopeRef, sourceRef: source.sourceRef, policyText: source.policyText, call: ordinaryCall })
    const report = await readJson<{ data: { validation: { validationId: string; publishable: boolean; semanticPublished: { passed: boolean } } } }>(
      await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/validations`, { exampleSetId, ...competency }, { 'if-match': await workspaceHead(workspaceId) }),
    )
    const candidateInventory = await readJson<unknown>(await request(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/candidates`))
    const reviewInventory = await Promise.all(candidates.map(async (candidate) => ({ candidateId: candidate.candidateId, body: await (await request(baseUrl, `/api/v1/candidates/${candidate.candidateId}/reviews`)).text() })))
    expect(report.data.validation.publishable, JSON.stringify({ validation: report.data.validation, candidateInventory, reviewInventory })).toBe(true)
    expect(report.data.validation.semanticPublished.passed, JSON.stringify(report.data.validation.semanticPublished)).toBe(true)

    const stale = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/publications`, {
      packId: 'generic-e2e-pack',
      version: '1.0.0',
      validationId: report.data.validation.validationId,
    }, { 'if-match': '999' })
    expect(stale.status).toBe(409)

    const published = await readJson<{ data: { packRef: { id: string; version: string; digest: string } } }>(
      await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/publications`, {
        packId: 'generic-e2e-pack',
        version: '1.0.0',
        validationId: report.data.validation.validationId,
      }, { 'if-match': await workspaceHead(workspaceId) }),
    )
    publishedPackRef = published.data.packRef
    expect(published.data.packRef.id).toBe('generic-e2e.generic-e2e-pack')
    const catalogue = await readJson<{ data: { packs: { packRef: { id: string; version: string } }[] } }>(
      await request(baseUrl, '/api/v1/industry-packs'),
    )
    expect(catalogue.data.packs.some((entry) => entry.packRef.id === published.data.packRef.id)).toBe(true)
    await record('v03-045-5-asset-chain', [
      `workspaceId=${workspaceId}`,
      `packRef=${published.data.packRef.id}@${published.data.packRef.version}`,
      'orRule=enabled',
      'validation=publishable',
      'stalePublication=409',
    ])
  }, 180_000)

  it('[host-http] refuses to enable a rule whose relation premise is outside the executable subset', async () => {
    const workspaceId = await createWorkspace('generic-e2e-relation')
    const relationRule = await ingestRule(workspaceId, {
      ruleId: 'asset_relation_premise',
      displayName: 'Relation premise rule',
      businessMeaning: 'Uses a relation premise beyond the first finite subset',
      objectId: 'asset',
      condition: { op: 'relation', relationId: 'asset_part_of' },
    })
    const blocked = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${relationRule.candidateId}/enable`, {}, { 'if-match': await workspaceHead(workspaceId) })
    expect(blocked.status).toBe(422)
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe('SUPPORT_VALIDATION_BLOCKED')
    await record('v03-045-5b-relation-premise', ['relationRule=SUPPORT_VALIDATION_BLOCKED'])
  }, 120_000)

  it('[host-http] creates a project against the published pack, mounts a newer version and enforces cross-scope isolation', async () => {
    const packRef = publishedPackRef
    if (packRef === undefined) throw new Error('the asset-chain test did not publish a pack')
    const configured = await readJson<{ data: { profileRef: { id: string; version: string } } }>(
      await jsonRequest(baseUrl, '/api/v1/core/published-pack-profiles', { packRef }),
    )

    const created = await readJson<{ data: { project: { projectId: string; headRevision: string } } }>(
      await jsonRequest(baseUrl, '/api/v1/core/project-bootstrap', {
        title: 'Generic E2E project',
        profileRef: { id: configured.data.profileRef.id, version: configured.data.profileRef.version },
      }),
    )
    const projectId = created.data.project.projectId
    expect(created.data.project.headRevision).toBe('1')

    const readiness = await readJson<{ data: { ready: boolean; blockers: { code: string }[] } }>(
      await request(baseUrl, `/api/v1/projects/${projectId}/readiness?required=published_semantics`),
    )
    expect(readiness.data.ready).toBe(false)
    expect(readiness.data.blockers[0]?.code).toBe('READINESS_NOT_BUILT')
    const originalSource = await prepareEvolutionRemapping({ projectId, call: ordinaryCall })

    // Definition changes require explicit evolution; staging never grants active semantics.
    const secondValidation = await createExampleSetAndValidate(publishedWorkspaceId, 'inspection_due_or_network')
    await readJson(await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${publishedWorkspaceId}/publications`, {
      packId: 'generic-e2e-pack',
      version: '1.1.0',
      validationId: secondValidation,
    }, { 'if-match': await workspaceHead(publishedWorkspaceId) }))
    const newer = await readJson<{ data: { packs: { packRef: { id: string; version: string; digest: string } }[] } }>(
      await request(baseUrl, '/api/v1/industry-packs'),
    )
    const newerPack = newer.data.packs.find((entry) => entry.packRef.id === packRef.id && entry.packRef.version === '1.1.0')
    if (newerPack === undefined) throw new Error('the second pack version was not published')
    const shallowMount = await jsonRequest(baseUrl, `/api/v1/projects/${projectId}/pack-mounts`, {
        industryPackRef: newerPack.packRef,
        reason: 'switch to 1.1.0',
      }, { 'if-match': originalSource.headRevision })
    expect(shallowMount.status).toBe(400)
    expect((await shallowMount.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
    const targetConfiguration = await readJson<{ data: { profileRef: ResolvedProfileRef } }>(
      await jsonRequest(baseUrl, '/api/v1/core/published-pack-profiles', { packRef: newerPack.packRef }),
    )
    const staged = await readJson<{ data: { evolution: ProjectEvolutionRecord } }>(
      await jsonRequest(baseUrl, `/api/v1/projects/${projectId}/evolutions`, {
        industryPackRef: newerPack.packRef,
        profileRef: targetConfiguration.data.profileRef,
        strategy: { kind: 'new_version', reason: 'stage the exact reviewed 1.1.0 definition through controlled evolution' },
        remappings: originalSource.remappings,
      }, { 'if-match': originalSource.headRevision }),
    )
    const targetRevisionNumber = (BigInt(originalSource.headRevision) + 1n).toString()
    expect(staged.data.evolution.plan.previousRevisionRef.revision).toBe(originalSource.headRevision)
    expect(staged.data.evolution.plan.targetRevisionRef.revision).toBe(targetRevisionNumber)
    const targetRevision = await readJson<{ data: { revision: { industryPackRef: VersionRef; semanticPublicationRefs: readonly VersionRef[] } } }>(
      await request(baseUrl, `/api/v1/projects/${projectId}/revisions/${targetRevisionNumber}`),
    )
    expect(targetRevision.data.revision.industryPackRef).toEqual(newerPack.packRef)
    expect(targetRevision.data.revision.semanticPublicationRefs).toEqual([])
    const projectHead = await readJson<{ data: { project: { headRevision: string; activeRevision: string } } }>(
      await request(baseUrl, `/api/v1/projects/${projectId}`),
    )
    expect(projectHead.data.project.headRevision).toBe(targetRevisionNumber)
    expect(projectHead.data.project.activeRevision).toBe(originalSource.headRevision)

    // A project id outside the trusted scope is never disclosed.
    const other = await buildHostFor(otherScopeRef)
    otherComposition = other.composition
    otherApi = other.api
    otherBaseUrl = other.baseUrl
    const crossScope = await request(otherBaseUrl, `/api/v1/projects/${projectId}`)
    expect(crossScope.status).toBe(404)
    expect((await crossScope.json() as { error: { code: string } }).error.code).toBe('PROJECT_NOT_FOUND')
    await record('v03-045-6-project-chain', [
      `projectId=${projectId}`,
      'readiness=READINESS_NOT_BUILT',
      `evolution=staged-revision-${targetRevisionNumber}; active-source-revision-${originalSource.headRevision}-preserved; target-semantic-publications-empty`,
      'crossScope=404',
    ])
  }, 180_000)

  it('[host-http] answers a property fact for a second industry through the real host', async () => {
    const source = await readFile(INDUSTRIAL_CANONICAL, 'utf8')
    const importResponse = await jsonRequest(baseUrl, '/api/v1/core/imports', {
      scenarioId: INDUSTRIAL_SCENARIO,
      sourceId: 'asset-hours-canonical',
      content: source,
    })
    expect(importResponse.status).toBe(202)
    const jobId = (await importResponse.json() as { data: { jobId: string } }).data.jobId
    expect((await waitForJob(jobId)).stage).toBe('awaiting_review')

    const candidateId = await findNativeCandidate(jobId, 'I-04')
    const pending = await readJson<{ data: { targetEntityId?: string } }>(
      await jsonRequest(baseUrl, `/api/v1/candidates/${candidateId}/decision`, { kind: 'create_pending', justification: 'operator reviewed the industrial identity' }, { 'if-match': '0' }),
    )
    if (pending.data.targetEntityId === undefined) throw new Error('industrial create_pending returned no entity')
    await readJson(await jsonRequest(baseUrl, `/api/v1/candidates/${candidateId}/decision`, {
      kind: 'match',
      targetEntityId: pending.data.targetEntityId,
      strongIdentity: { kind: 'native_id', value: 'I-04' },
    }, { 'if-match': '1' }))
    await readJson(await jsonRequest(baseUrl, `/api/v1/candidates/${candidateId}/reviews`, { decision: 'approve', reason: 'canonical hours record reviewed' }, { 'if-match': '0' }))
    const publication = await jsonRequest(baseUrl, '/api/v1/semantic-publications', {
      approvedCandidateRefs: [{ candidateId, kind: 'entity' }],
      schemaRef: (await scenarioDefinitionRef(INDUSTRIAL_SCENARIO)),
    }, { 'if-match': await latestPublicationRevision() })
    expect(publication.status).toBe(201)

    const runResponse = await jsonRequest(baseUrl, '/api/v1/runs', {
      profileRef: { id: 'synthetic-industrial-maintenance-demo', version: '1.0.0' },
      question: 'facts:operating_hours',
      context: { timeZone: 'UTC' },
      preferences: { route: 'template', allowWeb: false },
    })
    expect(runResponse.status).toBe(202)
    const runId = (await runResponse.json() as { data: { runId: string } }).data.runId
    const answer = await waitForAnswer(runId)
    const body = answer['body'] as { claims: { predicate: string; value: { value: string | number; unit: string } }[] }
    expect(body.claims).toContainEqual(expect.objectContaining({ predicate: 'operating_hours', value: { value: '100', unit: 'h' } }))
    await record('v03-045-7-second-industry', ['industry=industrial-asset-maintenance', 'operating_hours=100 h'])
  }, 180_000)

  it('[host-http] rejects an unsupported fact request without creating a run', async () => {
    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const before = await admin.query<{ runs: string }>(
      'SELECT count(*)::text AS runs FROM agent_platform.runs WHERE tenant_id = $1 AND space_id = $2',
      [scopeRef.tenantId, scopeRef.spaceId],
    )
    const response = await jsonRequest(baseUrl, '/api/v1/runs', {
      profileRef: { id: 'synthetic-transport-facility-demo', version: '1.0.0' },
      question: UNKNOWN_PROPERTY_QUESTION,
      context: { timeZone: 'UTC' },
      preferences: { route: 'template', allowWeb: false },
    })
    expect(response.status).toBe(422)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_PROPERTY')
    const after = await admin.query<{ runs: string }>(
      'SELECT count(*)::text AS runs FROM agent_platform.runs WHERE tenant_id = $1 AND space_id = $2',
      [scopeRef.tenantId, scopeRef.spaceId],
    )
    expect(after.rows[0]?.runs).toBe(before.rows[0]?.runs)
    await record('v03-045-8-unsupported-request', ['facts:not_registered=422 UNKNOWN_PROPERTY', 'runs=unchanged'])
  }, 120_000)

  it('[host-http] retracts the published statement, preserves history and blocks cross-scope reads', async () => {
    const statement = await readJson<{ data: { status: string; objectId: string; propositionKey: string } }>(
      await request(baseUrl, `/api/v1/statements/${targetCandidateId}`),
    )
    expect(statement.data.status).toBe('active')
    const objectId = statement.data.objectId

    const retracted = await readJson<{ data: { version: string } }>(
      await jsonRequest(baseUrl, `/api/v1/statements/${targetCandidateId}/revisions`, {
        kind: 'retraction',
        reason: 'the supporting source was withdrawn',
      }, { 'if-match': '1' }),
    )
    expect(retracted.data.version).toBe('2')

    const history = await readJson<{ data: { assertions: { version: string; status: string }[] } }>(
      await request(baseUrl, `/api/v1/objects/${objectId}/history`),
    )
    const versions = new Map(history.data.assertions.map((entry) => [entry.version, entry.status]))
    expect(versions.get('2')).toBe('retracted')

    const foreign = await request(otherBaseUrl, `/api/v1/statements/${targetCandidateId}`)
    expect(foreign.status).toBeGreaterThanOrEqual(400)
    await record('v03-045-9-retraction', [`statement=${targetCandidateId}`, 'retraction=version-2', 'history=retracted', 'crossScope=blocked'])
  }, 120_000)

  it('[host-http] keeps the published profile, pack and answer readable after a host restart', async () => {
    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const answerBefore = publishedRunId === '' ? undefined : await waitForAnswer(publishedRunId)

    await api?.close()
    api = undefined
    await composition?.close()
    composition = undefined

    const restarted = await buildHostFor(scopeRef)
    composition = restarted.composition
    api = restarted.api
    baseUrl = restarted.baseUrl

    const catalogue = await readJson<{ data: { packs: { packRef: { id: string; version: string } }[] } }>(
      await request(baseUrl, '/api/v1/industry-packs'),
    )
    expect(catalogue.data.packs.length).toBeGreaterThanOrEqual(1)
    if (publishedRunId !== '' && answerBefore !== undefined) {
      const answerAfter = await waitForAnswer(publishedRunId)
      expect(answerAfter['contentHash']).toBe(answerBefore['contentHash'])
    }
    await record('v03-045-10-restart', ['profile=persisted', 'catalogue=persisted', 'answer=stable-content-hash'])
  }, 180_000)

  it('[browser] creates, grounds, reviews, validates and publishes an authored rule pack through the ordinary App', async () => {
    let temporaryDirectory: string | undefined
    let closePage: (() => Promise<void>) | undefined
    const apiTrace: string[] = []
    const apiResponses: string[] = []
    const apiFailures: string[] = []
    const apiFailureBodyReads: Promise<void>[] = []
    let executionPreviewPrepared = false
    let flow1Page: Page | undefined
    let testFailed = false
    let testFailure: unknown
    try {
      await web.close()
      web = await startWebHost(baseUrl, { bindDefaultProfile: false })
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'ontology-gap22-flow1-'))
      const temporaryRoot = resolve(tmpdir())
      const ownedTemporary = resolve(temporaryDirectory)
      if (ownedTemporary === temporaryRoot || !relative(temporaryRoot, ownedTemporary).split(sep).every((segment) => segment.length > 0 && segment !== '..')) {
        throw new Error('the Flow1 temporary upload directory is outside the owned OS temporary root')
      }
      const policyPath = join(temporaryDirectory, 'inspection-policy.txt')
      const policyText = 'For each asset, inspection_due is a condition. When inspection_due is true, the asset requires inspection. The policy applies to identified assets.'
      await writeFile(policyPath, policyText, 'utf8')
      const { page, close } = await newPage()
      flow1Page = page
      closePage = close
    page.on('request', (entry) => {
      if (new URL(entry.url()).pathname.startsWith('/api/v1/')) apiTrace.push(`${entry.method()} ${new URL(entry.url()).pathname}`)
    })
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (!path.startsWith('/api/v1/')) return
      apiResponses.push(`${response.status()} ${response.request().method()} ${path}`)
      const expectedUnpreparedPreview = response.status() === 404 && response.request().method() === 'GET' &&
        !executionPreviewPrepared && gap22FlowWorkspaceId !== '' && path === `/api/v1/core/workspaces/${gap22FlowWorkspaceId}/execution-preview`
      if (response.status() >= 400 && !expectedUnpreparedPreview) {
        const entry = `${response.status()} ${response.request().method()} ${path}`
        apiFailureBodyReads.push(response.text().then((body) => { apiFailures.push(`${entry}: ${body}`) }).catch((error: unknown) => {
          apiFailures.push(`${entry}: response body unavailable (${error instanceof Error ? error.message : String(error)})`)
        }))
      }
    })
      const discardDirty = async (): Promise<void> => {
        const discard = page.getByTestId('shell-discard-changes')
        if (await discard.count() > 0) await discard.click()
      }
      const openView = async (view: string): Promise<void> => {
        await page.getByTestId(`tab-${view}`).click()
        await discardDirty()
        await page.waitForFunction((value) => document.querySelector('.app')?.getAttribute('data-view') === value, view)
      }
      const appWorkspaceListResponse = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/industry-workspaces')
      await page.goto(web.origin)
      await page.waitForSelector('[data-testid="guide-home"]')
      expect((await appWorkspaceListResponse).ok()).toBe(true)
      const ontologyWorkspaceListResponse = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/industry-workspaces')
      await openView('ontology')
      expect((await ontologyWorkspaceListResponse).ok()).toBe(true)
      await page.waitForFunction(() => {
        const panel = document.querySelector('[data-testid="ontology-workspace"]')
        const contextLoading = document.querySelector('[data-testid="context-workspace-loading"]')
        const contextSelect = document.querySelector<HTMLSelectElement>('[data-testid="context-workspace-select"]')
        const disclosure = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-create-disclosure"]')
        if (panel === null || contextLoading !== null || contextSelect === null || disclosure === null) return false
        const phase = panel.getAttribute('data-phase')
        if (phase === 'empty') return contextSelect.value === '' && disclosure.open
        if (phase !== 'ready') return false
        if (disclosure.open) return false
        const detail = panel.querySelector<HTMLElement>('[data-testid="workspace-detail"]')
        const workspaceId = detail?.getAttribute('data-workspace-id')
        return workspaceId !== undefined && workspaceId !== null && contextSelect.value === workspaceId &&
          new URLSearchParams(location.search).get('workspace') === workspaceId
      })
      const workspaceCreateDisclosure = page.getByTestId('workspace-create-disclosure')
      if (await workspaceCreateDisclosure.getAttribute('open') === null) await workspaceCreateDisclosure.locator('summary').click()
      await page.getByTestId('workspace-create-display-name').waitFor({ state: 'visible' })
      const namespace = `gap22-flow1-${randomUUID().slice(0, 8)}`
      await page.getByTestId('workspace-create-display-name').fill('检修要求规则工作区')
      await page.getByTestId('workspace-create-namespace').fill(namespace)
      await page.getByTestId('workspace-create-goals').fill('核对检修要求并保留原始依据')
      const workspaceResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/core/workspace-bootstrap')
      await page.getByTestId('workspace-create-submit').click()
      const createdWorkspace = await workspaceResponse
      expect(createdWorkspace.status()).toBe(201)
      const workspaceBody = await createdWorkspace.json() as { data: { workspace: { workspaceId: string; headRevision: string } } }
      gap22FlowWorkspaceId = workspaceBody.data.workspace.workspaceId
      expect(workspaceBody.data.workspace.headRevision).toBe('1')
      await page.waitForSelector(`[data-testid="workspace-detail"][data-workspace-id="${gap22FlowWorkspaceId}"]`)
      expect(new URL(page.url()).searchParams.get('workspace')).toBe(gap22FlowWorkspaceId)
      expect(await page.getByTestId('context-workspace-select').inputValue()).toBe(gap22FlowWorkspaceId)
      expect(await workspaceCreateDisclosure.getAttribute('open')).toBeNull()
      await capture(page, 'gap22-flow1-workspace-created-1440')

      await page.getByLabel('资料名称').fill('真实检修政策原文')
      await page.getByLabel('选择原始文件').setInputFiles(policyPath)
      const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/core/workspaces/${gap22FlowWorkspaceId}/sources`)
      await page.getByRole('button', { name: '上传并读取真实资料' }).click()
      const actualPolicyUpload = await uploadResponse
      expect(actualPolicyUpload.status()).toBe(201)
      const actualPolicyUploadBody = await actualPolicyUpload.json() as { data: { source: { sourceRef: ResourceRef } } }
      const actualPolicySourceRef = actualPolicyUploadBody.data.source.sourceRef
      expect(actualPolicySourceRef.id).toBeTruthy()
      expect(actualPolicySourceRef.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
      // The source library (design §1.5/N06) renders a second "查看真实原文与片段" control; the
      // workspace-source article is the one this draft flow uploads into.
      const originalSourceButton = page.locator('article').getByRole('button', { name: '查看真实原文与片段', exact: true })
      await originalSourceButton.waitFor()
      await originalSourceButton.click()
      const originalDialog = page.getByRole('dialog', { name: '原始资料预览' })
      await originalDialog.waitFor()
      expect(await originalDialog.textContent()).toContain('inspection_due is a condition')
      await capture(page, 'gap22-flow1-original-source-1440')
      await page.keyboard.press('Escape')
      await originalDialog.waitFor({ state: 'hidden' })
      expect(await originalSourceButton.evaluate((element) => element === document.activeElement)).toBe(true)

      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await capture(page, `gap22-flow1-workspace-responsive-${width}`)
      }
      await page.setViewportSize({ width: 320, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.setViewportSize({ width: 1440, height: 900 })

      const sourceCheckbox = page.locator('.ontology-source-card input[type="checkbox"]').first()
      await sourceCheckbox.check()
      await page.getByLabel('生成范围').selectOption('definitions')
      const definitionGeneration = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/generations`)
      await page.getByRole('button', { name: '从所选真实资料生成候选' }).click()
      const generatedDefinitionResponse = await definitionGeneration
      if (generatedDefinitionResponse.status() !== 201) throw new Error(`real App definition generation failed: ${String(generatedDefinitionResponse.status())} ${await generatedDefinitionResponse.text()} request=${generatedDefinitionResponse.request().postData() ?? ''}`)
      const generatedDefinitions = await generatedDefinitionResponse.json() as { data: { candidates: { candidateId: string }[] } }
      const sourceDefinitionIds = generatedDefinitions.data.candidates.map((candidate) => candidate.candidateId)
      expect(sourceDefinitionIds.length).toBe(4)
      expect(modelRequests.some((body) => body.includes('synthetic-vendor-extractor'))).toBe(true)
      expect(modelRequests.some((body) => body.includes(policyText))).toBe(true)
      await page.getByRole('button', { name: '继续编辑与审核候选 →' }).click()
      await page.waitForSelector('[data-testid="definition-workbench"]')

      const confirmAndApproveDefinition = async (candidateId: string): Promise<string> => {
        const candidateRow = page.locator(`[data-testid="definition-candidate"][data-candidate-id="${candidateId}"]`)
        await candidateRow.locator('button').click()
        await page.getByRole('button', { name: '查看原始资料与定位片段' }).click()
        const dialog = page.getByRole('dialog', { name: '原始依据与来源确认' })
        await dialog.waitFor()
        const sourceCheckbox = dialog.locator('input[type="checkbox"]').first()
        if (!(await sourceCheckbox.isChecked())) await sourceCheckbox.check()
        await dialog.getByRole('button', { name: '读取所选原文与真实片段' }).click()
        await dialog.locator('input[type="radio"]').first().check()
        await dialog.getByLabel('来源确认说明').fill('逐项核对了该定义对应的实际检修原文。')
        const sourceResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/candidates/${candidateId}/source-confirmations`))
        await dialog.getByRole('button', { name: '确认依据并生成新候选' }).click()
        const confirmed = await sourceResponse
        expect(confirmed.status()).toBe(201)
        const confirmedBody = await confirmed.json() as { data: { candidates: { candidateId: string }[] } }
        const actualCandidateId = confirmedBody.data.candidates[0]?.candidateId
        if (actualCandidateId === undefined) throw new Error('the server returned no source-confirmed definition candidate')
        await page.keyboard.press('Escape')
        const confirmedRow = page.locator(`[data-testid="definition-candidate"][data-candidate-id="${actualCandidateId}"]`)
        await confirmedRow.locator('button').click()
        expect(await confirmedRow.textContent()).not.toContain('待确认来源')
        await page.getByLabel('审核意见').fill('逐项比对原始检修规则，定义与来源一致。')
        const approval = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/candidates/${actualCandidateId}/reviews`)
        await page.getByRole('button', { name: '批准当前内容' }).click()
        expect((await approval).status()).toBe(200)
        return actualCandidateId
      }
      const approvedDefinitionIds: string[] = []
      for (const candidateId of sourceDefinitionIds) approvedDefinitionIds.push(await confirmAndApproveDefinition(candidateId))

      await page.getByRole('button', { name: '1–2 资料与生成' }).click()
      await page.getByLabel('生成范围').selectOption('rules')
      await page.waitForSelector('[data-testid="rule-generation-terms"][data-phase="ready"]')
      const terms = page.getByTestId('rule-generation-terms').locator('input[type="checkbox"]')
      const termCount = await terms.count()
      if (termCount !== 4) {
        const candidateList = await request(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/candidates`)
        const candidatePayload = await candidateList.json() as { data: { candidates: { candidateId: string; kind: string; state: string; pendingConfirmation: boolean; replacesCandidateId?: string; contentDigest: string; sourceRefs: readonly unknown[] }[] } }
        const currentCandidates = candidatePayload.data.candidates.filter((candidate) => candidate.sourceRefs.length > 0 && !candidate.pendingConfirmation)
        const reviews = await Promise.all(currentCandidates.map(async (candidate) => ({ candidateId: candidate.candidateId, digest: candidate.contentDigest,
          response: await (await request(baseUrl, `/api/v1/candidates/${candidate.candidateId}/reviews`)).text() })))
        throw new Error(`expected four actual approved rule terms, found ${String(termCount)}; picker=${await page.getByTestId('rule-generation-terms').textContent()}; candidates=${JSON.stringify(currentCandidates)}; reviews=${JSON.stringify(reviews)}`)
      }
      for (const term of await terms.all()) await term.check()
      const ruleGeneration = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/rule-action-generations`)
      await page.getByRole('button', { name: '从所选真实资料生成候选' }).click()
      const generatedRuleResponse = await ruleGeneration
      expect(generatedRuleResponse.status()).toBe(201)
      const generatedRuleBody = await generatedRuleResponse.json() as { data: { candidates: { candidateId: string }[] } }
      const initialRuleId = generatedRuleBody.data.candidates[0]?.candidateId
      if (initialRuleId === undefined) throw new Error('the controlled model returned no rule candidate')
      const sentRuleRequest = modelRequests.map((body) => JSON.parse(body) as { messages?: readonly { readonly role?: string; readonly content?: string }[] }).find((body) => body.messages?.some((message) => message.role === 'system' && message.content?.includes('Propose candidate rules/actions only')))
      expect(sentRuleRequest).toBeDefined()
      await page.getByRole('button', { name: '继续编辑与审核候选 →' }).click()
      await page.waitForSelector('[data-testid="definition-workbench"]')
      const ruleRow = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${initialRuleId}"]`)
      try { await ruleRow.waitFor({ timeout: 10_000 }) } catch {
        const ruleList = await request(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/rule-action-candidates`)
        throw new Error(`newly generated rule candidate is not visible in review UI; status=${String(ruleList.status)} body=${await ruleList.text()}`)
      }
      await ruleRow.locator('button').click()
      await page.getByRole('button', { name: '查看原始资料与定位片段' }).click()
      const ruleDialog = page.getByRole('dialog', { name: '原始依据与来源确认' })
      await ruleDialog.waitFor()
      const ruleSourceCheckbox = ruleDialog.locator('input[type="checkbox"]').first()
      if (!(await ruleSourceCheckbox.isChecked())) await ruleSourceCheckbox.check()
      await ruleDialog.getByRole('button', { name: '读取所选原文与真实片段' }).click()
      await ruleDialog.getByRole('heading', { name: '为每个条件选择真实依据' }).waitFor()
      const pathSelectors = ruleDialog.locator('select')
      expect(await pathSelectors.count()).toBe(3)
      for (const select of await pathSelectors.all()) await select.selectOption({ index: 1 })
      await ruleDialog.getByLabel('来源确认说明').fill('已将规则适用范围、条件及业务结论逐项绑定到原始资料。')
      const ruleSourceResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/rule-action-candidates/${initialRuleId}/source-confirmations`))
      await ruleDialog.getByRole('button', { name: '确认依据并生成新候选' }).click()
      const groundedRuleResponse = await ruleSourceResponse
      expect(groundedRuleResponse.status()).toBe(201)
      const groundedRuleBody = await groundedRuleResponse.json() as { data: { candidates: { candidateId: string }[] } }
      const groundedRuleId = groundedRuleBody.data.candidates[0]?.candidateId
      if (groundedRuleId === undefined) throw new Error('the source-confirmed rule candidate is missing')
      await page.keyboard.press('Escape')
      const groundedRuleRow = page.locator(`[data-testid="rule-action-candidate"][data-candidate-id="${groundedRuleId}"]`)
      await groundedRuleRow.locator('button').click()
      await page.getByLabel('审核意见').fill('我审核了实际原文中的布尔条件与结论。')
      const ruleApproval = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/candidates/${groundedRuleId}/reviews`)
      await page.getByRole('button', { name: '批准当前内容' }).click()
      expect((await ruleApproval).status()).toBe(200)
      const enable = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/rule-action-candidates/${groundedRuleId}/enable`)
      await page.getByRole('button', { name: '启用通过验核的声明' }).click()
      expect((await enable).status()).toBe(200)
      await capture(page, 'gap22-flow1-enabled-rule-1440')

      await page.getByRole('button', { name: '4–5 验核与发布' }).click()
      await page.getByTestId('synthetic-rule-select').selectOption('inspection_required')
      expect(await page.getByTestId('synthetic-field-select').inputValue()).toBe('inspection_due')
      await page.getByTestId('synthetic-field-value').selectOption('')
      await page.getByTestId('synthetic-expectation').selectOption('unknown')
      await page.getByTestId('synthetic-expectation-reason').fill('原始规则条件缺失时，我独立判定结果为未知。')
      await page.getByTestId('synthetic-expectation-reviewer').fill('GAP-022 独立期望编写者')
      const sampleSave = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/synthetic-example-sets`)
      await page.getByTestId('synthetic-example-save').click()
      expect((await sampleSave).status()).toBe(201)
      await page.getByTestId('validation-example-set').waitFor()
      expect(await page.getByTestId('validation-example-set').textContent()).toContain('1 个场景')
      const previewResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/core/workspaces/${gap22FlowWorkspaceId}/execution-preview`)
      await page.getByRole('button', { name: '准备执行验证' }).click()
      expect((await previewResponse).ok()).toBe(true)
      executionPreviewPrepared = true
      await page.getByRole('heading', { name: '从当前真实规则编写新问题' }).waitFor()
      await page.getByLabel('要验证的业务规则').selectOption('inspection_required')
      const inputs = page.locator('.ontology-cq-author')
      expect(await inputs.count()).toBeGreaterThan(0)
      const cqWorkbench = page.locator('.ontology-cq')
      const authoring = page.locator('.ontology-cq-author').last()
      // Fill user-facing source values by their labels; no candidate, source or version IDs are entered.
      await authoring.getByLabel(/Asset code/).fill('GAP22-ASSET-001')
      await authoring.getByLabel(/Inspection due/).selectOption('true')
      await authoring.getByLabel('业务问题').fill('Does GAP22-ASSET-001 require inspection under the reviewed policy?')
      const validAt = authoring.getByLabel('验证时间（UTC）')
      if (await validAt.inputValue() === '') await validAt.fill('2026-10-10T00:00:00')
      await authoring.getByLabel('期望条件').selectOption('true')
      await authoring.getByLabel('期望适用性').selectOption('applicable')
      await authoring.getByLabel('期望业务结论').selectOption('true')
      await authoring.getByLabel('独立期望的依据').fill('我单独核对了原文条件与输入值；布尔条件成立且规则适用。')
      await authoring.getByRole('button', { name: '上传原始行并加入新题集' }).click()
      await page.getByText(/个问题在当前待保存题集中/).waitFor()
      const cqSaveResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/competency-question-sets')
      const cqReadbackResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/competency-question-sets/read', { timeout: 5_000 }).catch(() => undefined)
      await page.getByRole('button', { name: '保存为全新题集' }).click()
      const cqSaveResponse = await cqSaveResponsePromise
      if (!cqSaveResponse.ok()) throw new Error(`actual CQ save failed: ${String(cqSaveResponse.status())} ${await cqSaveResponse.text()}; panel=${await cqWorkbench.textContent()}`)
      const savedInitialCq = await cqSaveResponse.json() as { data?: { declaration?: { body?: unknown } } }
      const originalFlow1CqBody = savedInitialCq.data?.declaration?.body
      if (!isRecord(originalFlow1CqBody) || !Array.isArray(originalFlow1CqBody['questions'])) {
        throw new Error('the actual Flow1 CQ save returned no reusable independently authored question body')
      }
      const cqReadbackResponse = await cqReadbackResponsePromise
      if (cqReadbackResponse === undefined) throw new Error(`actual CQ save did not start readback; panel=${await cqWorkbench.textContent()}; requests=${JSON.stringify(apiTrace)}`)
      if (!cqReadbackResponse.ok()) throw new Error(`actual CQ readback failed: ${String(cqReadbackResponse.status())} ${await cqReadbackResponse.text()}; panel=${await cqWorkbench.textContent()}`)
      await page.getByText(/新题集已存入实际审核库并重新读回/).waitFor()
      await cqWorkbench.getByLabel('新题集人工审核意见').fill('我已核对独立输入、期望和其对应的版本。')
      const cqApprove = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/v1\/candidates\/[0-9a-f-]{36}\/reviews$/u.test(new URL(response.url()).pathname))
      const cqApprovalReadback = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/competency-question-sets/read', { timeout: 5_000 }).catch(() => undefined)
      await cqWorkbench.getByRole('button', { name: '人工批准当前新题集' }).click()
      const cqApproveResponse = await cqApprove
      expect(cqApproveResponse.status()).toBe(200)
      const cqApprovalReadbackResponse = await cqApprovalReadback
      if (cqApprovalReadbackResponse === undefined) throw new Error(`actual CQ approval did not read back; panel=${await cqWorkbench.textContent()}; requests=${JSON.stringify(apiTrace)}`)
      if (!cqApprovalReadbackResponse.ok()) throw new Error(`actual CQ approval readback failed: ${String(cqApprovalReadbackResponse.status())} ${await cqApprovalReadbackResponse.text()}; panel=${await cqWorkbench.textContent()}`)
      const cqApprovalState = await cqApprovalReadbackResponse.json() as { data?: { approved?: boolean } }
      expect(cqApprovalState.data?.approved).toBe(true)
      await cqWorkbench.locator('.ui-status--success').filter({ hasText: '当前题集已人工批准' }).waitFor({ timeout: 5_000 })
      const validationResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/validations`)
      await page.getByTestId('validation-run').click()
      const validation = await validationResponse
      expect(validation.status()).toBe(201)
      const validationBody = await validation.text()
      await page.waitForSelector('[data-testid="validation-report"]', { timeout: 5_000 }).catch(async () => { throw new Error(`actual validation result not rendered; response=${validationBody}; packagePanel=${await page.getByTestId('package-publication').textContent()}; requests=${JSON.stringify(apiTrace)}`) })
      await page.waitForSelector('[data-testid="validation-report"][data-gate="open"]', { timeout: 5_000 }).catch(async () => { throw new Error(`actual validation report did not reach open gate; response=${validationBody}; report=${await page.getByTestId('validation-report').textContent()}; packagePanel=${await page.getByTestId('package-publication').textContent()}`) })
      expect(await page.getByTestId('validation-publishable').getAttribute('data-publishable')).toBe('true')
      await capture(page, 'gap22-flow1-human-cq-validation-1440')
      const publishResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/publications`)
      await page.getByRole('button', { name: '发布', exact: true }).click()
      expect((await publishResponse).status()).toBe(201)
      const published = await page.getByTestId('publication-result').getAttribute('data-pack-ref')
      expect(published).toBe(`${namespace}.pack@1.0.0`)
      await page.reload()
      await page.waitForSelector(`[data-testid="workspace-detail"][data-workspace-id="${gap22FlowWorkspaceId}"]`)
      await page.waitForSelector('[data-testid="context-workspace-loading"]', { state: 'hidden' })
      expect(new URL(page.url()).searchParams.get('view')).toBe('ontology')
      expect(new URL(page.url()).searchParams.get('workspace')).toBe(gap22FlowWorkspaceId)
      expect(await page.getByTestId('context-workspace-select').inputValue()).toBe(gap22FlowWorkspaceId)
      const packList = await readJson<{ data: { packs: { packRef: { id: string; version: string; digest: string } }[] } }>(await request(baseUrl, '/api/v1/industry-packs'))
      gap22FlowPackRef = packList.data.packs.find((pack) => pack.packRef.id === `${namespace}.pack` && pack.packRef.version === '1.0.0')?.packRef
      expect(gap22FlowPackRef?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
      // Create a real compatible definition successor from the same grounded candidate.
      // Logical IDs and fields stay stable. The edit inherits the exact original source pin,
      // while its new candidate ID and digest still need an explicit human approval.
      const currentDefinitions = await ordinaryCall(`/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/candidates`)
      if (!Array.isArray(currentDefinitions['candidates'])) throw new Error('the actual workspace definition inventory is absent')
      const assetHead = currentDefinitions['candidates'].map((value) => value as GeneratedCandidate & { sourceRefs?: readonly ResourceRef[] })
        .find((candidate) => approvedDefinitionIds.includes(candidate.candidateId) && candidate.kind === 'object' && candidate.payload['logicalId'] === 'asset')
      if (assetHead === undefined) throw new Error('the actually approved asset definition candidate is not the current workspace head')
      expect(assetHead.sourceRefs?.some((ref) => ref.id === actualPolicySourceRef.id && ref.digest === actualPolicySourceRef.digest)).toBe(true)
      const editedAssetResponse = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/candidates/${assetHead.candidateId}/edits`, {
        payload: { ...assetHead.payload, displayName: 'Managed asset' },
        reason: 'make a compatible display-name clarification for the next published definition version',
      }, { 'if-match': await workspaceHead(gap22FlowWorkspaceId) })
      const editedAssets = await readJson<{ data: { candidates: GeneratedCandidate[] } }>(editedAssetResponse)
      const editedAsset = editedAssets.data.candidates.find((candidate) => candidate.kind === 'object' && candidate.payload['logicalId'] === 'asset')
      if (editedAsset === undefined) throw new Error('the asset definition edit returned no current replacement candidate')
      expect(editedAsset.candidateId).not.toBe(assetHead.candidateId)
      expect(editedAsset.payload['displayName']).toBe('Managed asset')
      const editedInventory = await ordinaryCall(`/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/candidates`)
      if (!Array.isArray(editedInventory['candidates'])) throw new Error('the edited definition inventory is absent')
      const editedAssetHead = editedInventory['candidates'].map((value) => value as GeneratedCandidate & { contentDigest?: string; sourceRefs?: readonly ResourceRef[] })
        .find((candidate) => candidate.candidateId === editedAsset.candidateId)
      if (editedAssetHead === undefined) throw new Error('the edited asset candidate is not its current workspace head')
      expect(editedAssetHead.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(editedAssetHead.sourceRefs?.some((ref) => ref.id === actualPolicySourceRef.id && ref.digest === actualPolicySourceRef.digest)).toBe(true)
      const editReviewHistory = await ordinaryCall(`/api/v1/candidates/${editedAsset.candidateId}/reviews`)
      if (!Array.isArray(editReviewHistory['reviews'])) throw new Error('the edited definition candidate has no actual review history')
      const latestEditReviewRevision = editReviewHistory['reviews'].reduce((latest: bigint, value: unknown) => {
        if (typeof value !== 'object' || value === null || !('revision' in value) || typeof value.revision !== 'string') throw new Error('the edited candidate review history has a malformed revision')
        const revision = BigInt(value.revision)
        return revision > latest ? revision : latest
      }, 0n).toString()
      const approvedEdit = await readJson<{ data: { candidateId: string; contentDigest: string; decision: string } }>(
        await jsonRequest(baseUrl, `/api/v1/candidates/${editedAsset.candidateId}/reviews`, {
          decision: 'approve', reason: '人工重新核对保留的原始来源绑定与兼容展示名修改，并批准当前定义摘要',
        }, { 'if-match': latestEditReviewRevision }),
      )
      expect(approvedEdit.data).toMatchObject({ candidateId: editedAsset.candidateId, contentDigest: editedAssetHead.contentDigest, decision: 'approve' })

      // Every member of the published definition projection must pin this same successor
      // draft. Reissue the unchanged source-grounded heads as immutable edits and approve
      // those exact new digests, so stale candidate revisions cannot leak into validation.
      for (const prior of editedInventory['candidates'].map((value) => value as GeneratedCandidate & { sourceRefs?: readonly ResourceRef[] })) {
        if (!approvedDefinitionIds.includes(prior.candidateId) || prior.candidateId === assetHead.candidateId) continue
        if (!prior.sourceRefs?.some((ref) => ref.id === actualPolicySourceRef.id && ref.digest === actualPolicySourceRef.digest)) {
          throw new Error(`unchanged definition ${prior.candidateId} (${prior.kind}:${String(prior.payload['logicalId'])}) does not carry the exact uploaded policy pin; sources=${JSON.stringify(prior.sourceRefs ?? [])}; expected=${JSON.stringify(actualPolicySourceRef)}`)
        }
        const response = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/candidates/${prior.candidateId}/edits`, {
          payload: prior.payload,
          reason: '保留当前已批准的原始定义内容，并将不可变候选版本绑定到同一新工作区草稿',
        }, { 'if-match': await workspaceHead(gap22FlowWorkspaceId) })
        const result = await readJson<{ data: { candidates: GeneratedCandidate[] } }>(response)
        const replacement = result.data.candidates.find((candidate) => candidate.kind === prior.kind && candidate.payload['logicalId'] === prior.payload['logicalId'])
        if (replacement === undefined || replacement.candidateId === prior.candidateId) throw new Error(`definition ${prior.candidateId} was not reissued as a new immutable candidate`)
        const inventory = await ordinaryCall(`/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/candidates`)
        if (!Array.isArray(inventory['candidates'])) throw new Error('the reissued definition inventory is absent')
        const head = inventory['candidates'].map((value) => value as GeneratedCandidate & { contentDigest?: string; sourceRefs?: readonly ResourceRef[] })
          .find((candidate) => candidate.candidateId === replacement.candidateId)
        if (head === undefined || !head.sourceRefs?.some((ref) => ref.id === actualPolicySourceRef.id && ref.digest === actualPolicySourceRef.digest)) {
          throw new Error(`reissued definition ${replacement.candidateId} lost its exact original source pin`)
        }
        const history = await ordinaryCall(`/api/v1/candidates/${replacement.candidateId}/reviews`)
        if (!Array.isArray(history['reviews'])) throw new Error(`review history is absent for reissued definition ${replacement.candidateId}`)
        const revision = history['reviews'].reduce((latest: bigint, value: unknown) => {
          if (typeof value !== 'object' || value === null || !('revision' in value) || typeof value.revision !== 'string') throw new Error('reissued definition review history is malformed')
          const number = BigInt(value.revision)
          return number > latest ? number : latest
        }, 0n).toString()
        const approval = await readJson<{ data: { candidateId: string; contentDigest: string; decision: string } }>(
          await jsonRequest(baseUrl, `/api/v1/candidates/${replacement.candidateId}/reviews`, {
            decision: 'approve', reason: '人工重新核对保留的真实来源、当前内容和新候选摘要后批准',
          }, { 'if-match': revision }),
        )
        expect(approval.data).toMatchObject({ candidateId: replacement.candidateId, contentDigest: head.contentDigest, decision: 'approve' })
      }

      // The enabled generated rule pins the pre-edit draft. Reconfirm that same saved rule
      // against the current, complete source and revised definition draft before validating
      // the successor pack; then approve and enable the fresh immutable candidate revision.
      const currentRules = await ordinaryCall(`/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/rule-action-candidates`)
      if (!Array.isArray(currentRules['candidates'])) throw new Error('the current workspace rule inventory is absent')
      const inspectionRule = currentRules['candidates'].map((value) => value as { candidateId: string; logicalId: string; contentDigest: string })
        .find((candidate) => candidate.candidateId === groundedRuleId && candidate.logicalId === 'inspection_required')
      if (inspectionRule === undefined) throw new Error('the originally published source-grounded inspection rule is not the current rule head')
      const revalidatedRuleResponse = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/rule-action-candidates/${inspectionRule.candidateId}/source-confirmations`, {
        contentDigest: inspectionRule.contentDigest,
        sourceRefs: [actualPolicySourceRef],
        sourceSelections: ['applicability', 'condition', 'conclusion'].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })),
        reason: '重新核对原检修政策中适用范围、条件与结论，并绑定当前定义草稿',
      }, { 'if-match': await workspaceHead(gap22FlowWorkspaceId) })
      const revalidatedRule = await readJson<{ data: { candidates: { candidateId: string }[] } }>(revalidatedRuleResponse)
      const revalidatedRuleId = revalidatedRule.data.candidates[0]?.candidateId
      if (revalidatedRuleId === undefined) throw new Error('the freshly grounded rule candidate is absent')
      const revalidatedReviews = await ordinaryCall(`/api/v1/candidates/${revalidatedRuleId}/reviews`)
      if (!Array.isArray(revalidatedReviews['reviews'])) throw new Error('the fresh rule candidate review ledger is absent')
      const latestRuleReviewRevision = revalidatedReviews['reviews'].reduce((latest: bigint, value: unknown) => {
        if (typeof value !== 'object' || value === null || !('revision' in value) || typeof value.revision !== 'string') throw new Error('the fresh rule review history has a malformed revision')
        const revision = BigInt(value.revision)
        return revision > latest ? revision : latest
      }, 0n).toString()
      await readJson(await jsonRequest(baseUrl, `/api/v1/candidates/${revalidatedRuleId}/reviews`, {
        decision: 'approve', reason: '人工核对更新定义草稿后重新确认的真实来源规则内容',
      }, { 'if-match': latestRuleReviewRevision }))
      const reenabledRule = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/rule-action-candidates/${revalidatedRuleId}/enable`, {}, { 'if-match': await workspaceHead(gap22FlowWorkspaceId) })
      if (!reenabledRule.ok) throw new Error(`revalidated rule could not be enabled: ${String(reenabledRule.status)} ${await reenabledRule.text()}`)

      // Publish a second immutable version from this same workspace through a fresh
      // independently authored, human-approved CQ set and normal validation gate.
      const evolutionExampleSetId = await createExampleSet(gap22FlowWorkspaceId, 'inspection_required')
      const evolutionPreview = await ordinaryCall(`/api/v1/core/workspaces/${gap22FlowWorkspaceId}/execution-preview`,
        { exampleSetId: evolutionExampleSetId }, await workspaceHead(gap22FlowWorkspaceId))
      if (!isVersionRef(evolutionPreview['definitionRef']) || !Array.isArray(evolutionPreview['ruleRefs']) ||
        evolutionPreview['ruleRefs'].length !== 1 || !isVersionRef(evolutionPreview['ruleRefs'][0])) {
        throw new Error('the actual successor preview did not return its exact immutable definition and rule references')
      }
      const successorDefinitionRef: VersionRef = { ...evolutionPreview['definitionRef'] }
      const successorRuleRef: VersionRef = { ...evolutionPreview['ruleRefs'][0] }
      const successorCqBodyValue: unknown = structuredClone(originalFlow1CqBody)
      if (!isRecord(successorCqBodyValue)) {
        throw new Error('the cloned Flow1 CQ body lost its authored question')
      }
      const successorQuestions = successorCqBodyValue['questions']
      if (!Array.isArray(successorQuestions)) throw new Error('the cloned Flow1 CQ body lost its authored question')
      const successorCqBody: Record<string, unknown> = successorCqBodyValue
      const successorQuestion = successorQuestions[0]
      if (!isRecord(successorQuestion)) throw new Error('the independently authored Flow1 CQ contains no question to rebind')
      expect(successorQuestion['intent']).toMatchObject({ kind: 'rule', objectId: 'asset', ruleId: 'inspection_required' })
      expect(successorQuestion['expected']).toMatchObject({ kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: 'true' })
      successorCqBody['definitionRefs'] = [successorDefinitionRef]
      successorCqBody['ruleRefs'] = [successorRuleRef]
      successorQuestion['definitionRef'] = successorDefinitionRef
      successorQuestion['ruleRefs'] = [successorRuleRef]
      const successorCqRef: VersionRef = { id: randomUUID(), version: '1.0.0', digest: contentDigestOf(successorCqBody) }
      const successorCq = await ordinaryCall('/api/v1/competency-question-sets', { ref: successorCqRef, body: successorCqBody })
      await record('gap23-flow1-successor-cq-save', [JSON.stringify({ proposedRef: successorCqRef, result: successorCq })])
      if (successorCq['approvalRequired'] !== true || typeof successorCq['candidateId'] !== 'string') {
        throw new Error(`the successor CQ was not saved as a new human-review candidate: ${JSON.stringify(successorCq)}`)
      }
      const successorDeclaration = successorCq['declaration']
      if (!isRecord(successorDeclaration) || !isVersionRef(successorDeclaration['ref']) || !isRecord(successorDeclaration['body'])) {
        throw new Error('the server returned no actual successor CQ declaration')
      }
      const actualSuccessorCqRef: VersionRef = { ...successorDeclaration['ref'] }
      expect(successorCq['candidateId']).toBe(actualSuccessorCqRef.id)
      expect(actualSuccessorCqRef.digest).toBe(successorCqRef.digest)
      expect(contentDigestOf(successorDeclaration['body'])).toBe(successorCqRef.digest)
      const successorCqReviews = await ordinaryCall(`/api/v1/candidates/${actualSuccessorCqRef.id}/reviews`)
      if (!Array.isArray(successorCqReviews['reviews'])) throw new Error('the successor CQ has no actual review history')
      const latestSuccessorCqReview = successorCqReviews['reviews'].reduce((latest: bigint, value: unknown) => {
        if (!isRecord(value) || typeof value['revision'] !== 'string') throw new Error('the successor CQ review history has a malformed revision')
        const revision = BigInt(value['revision'])
        return revision > latest ? revision : latest
      }, 0n).toString()
      const successorCqApproval = await ordinaryCall(`/api/v1/candidates/${actualSuccessorCqRef.id}/reviews`, {
        decision: 'approve', reason: '人工重新核对 Flow1 原题的独立输入、期待与原始来源，并核实其精确绑定新定义和规则版本',
      }, latestSuccessorCqReview)
      expect(successorCqApproval).toMatchObject({ candidateId: actualSuccessorCqRef.id, contentDigest: actualSuccessorCqRef.digest, decision: 'approve' })
      const successorCqReadback = await ordinaryCall('/api/v1/competency-question-sets/read', { ref: actualSuccessorCqRef })
      const readbackDeclaration = successorCqReadback['declaration']
      expect(successorCqReadback['approved']).toBe(true)
      if (!isRecord(readbackDeclaration) || !isRecord(readbackDeclaration['body'])) throw new Error('the approved successor CQ readback is malformed')
      expect(contentDigestOf(readbackDeclaration['body'])).toBe(actualSuccessorCqRef.digest)
      const evolutionCompetency = { competencyQuestionRef: actualSuccessorCqRef, definitionRef: successorDefinitionRef }
      const evolutionValidation = await readJson<{ data: { validation: { validationId: string; publishable: boolean } } }>(
        await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/validations`,
          { exampleSetId: evolutionExampleSetId, ...evolutionCompetency },
          { 'if-match': await workspaceHead(gap22FlowWorkspaceId) }),
      )
      await record('gap23-flow1-successor-validation', [JSON.stringify(evolutionValidation.data.validation)])
      expect(evolutionValidation.data.validation.publishable, JSON.stringify(evolutionValidation.data.validation)).toBe(true)
      const evolutionPublication = await readJson<{ data: { packRef: { id: string; version: string; digest: string } } }>(
        await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${gap22FlowWorkspaceId}/publications`, {
          packId: 'pack', version: '1.1.0', validationId: evolutionValidation.data.validation.validationId,
        }, { 'if-match': await workspaceHead(gap22FlowWorkspaceId) }),
      )
      gap22FlowTargetPackRef = evolutionPublication.data.packRef
      expect(gap22FlowTargetPackRef).toMatchObject({ id: gap22FlowPackRef?.id, version: '1.1.0', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) })
      await capture(page, 'gap22-flow1-published-pack-1440')
      await record('gap22-flow1-actual-app-publication', [
        `workspace=${gap22FlowWorkspaceId}`,
        `pack=${published ?? ''}`,
        `controlledModelRequests=${String(modelRequests.length)}`,
        'source=actual-browser-uploaded-policy-bytes-and-confirmed-text-spans',
        'terms=selected-from-real-human-approved-candidates',
        'rule=controlled-model-proposal+actual-source-confirmation+human-approval+enablement',
        'sample=human-authored-independent-unknown-expectation+server-readback',
        'cq=independently-authored-and-human-approved',
        'validation=server-report-publishable',
        ...apiResponses,
        ...apiTrace,
      ])
      await Promise.all(apiFailureBodyReads)
      expect(apiFailures).toEqual([])
    } catch (error) {
      testFailed = true
      testFailure = error
      await Promise.all(apiFailureBodyReads)
      if (flow1Page !== undefined) {
        try {
          const workspaceReadiness = await flow1Page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>('[data-testid="ontology-workspace"]')
            const contextSelect = document.querySelector<HTMLSelectElement>('[data-testid="context-workspace-select"]')
            const detail = document.querySelector<HTMLElement>('[data-testid="workspace-detail"]')
            const disclosure = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-create-disclosure"]')
            return {
              url: location.href,
              appView: document.querySelector('.app')?.getAttribute('data-view'),
              panelPhase: panel?.getAttribute('data-phase'),
              contextSelectValue: contextSelect?.value,
              contextLoading: document.querySelector('[data-testid="context-workspace-loading"]')?.textContent?.trim(),
              contextFailure: document.querySelector('[data-testid="context-workspace-failure"]')?.textContent?.trim(),
              detailWorkspaceId: detail?.getAttribute('data-workspace-id'),
              disclosureOpen: disclosure?.open,
              dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')].map((dialog) => dialog.innerText.trim()),
              body: document.body.innerText.slice(0, 12_000),
            }
          })
          await record('gap22-flow1-workspace-readiness-diagnostic', [JSON.stringify(workspaceReadiness)])
          await capture(flow1Page, 'gap22-flow1-workspace-readiness-failure-1440')
        } catch (diagnosticError) {
          await record('gap22-flow1-workspace-readiness-diagnostic-error', [diagnosticError instanceof Error ? diagnosticError.stack ?? diagnosticError.message : String(diagnosticError)])
        }
      }
      await record('gap22-flow1-failure', [
        error instanceof Error ? error.stack ?? error.message : String(error),
        ...apiFailures,
        ...apiResponses,
        ...apiTrace,
      ])
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      if (closePage !== undefined) {
        try { await closePage() } catch (error) { cleanupErrors.push(error) }
      }
      if (temporaryDirectory !== undefined) {
        try {
          const ownedTemporary = resolve(temporaryDirectory)
          const temporaryRoot = resolve(tmpdir())
          if (ownedTemporary === temporaryRoot || !relative(temporaryRoot, ownedTemporary).split(sep).every((segment) => segment.length > 0 && segment !== '..')) {
            throw new Error('refusing Flow1 cleanup outside the owned OS temporary root')
          }
          await rm(ownedTemporary, { recursive: true, force: true })
        } catch (error) { cleanupErrors.push(error) }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(testFailed ? [testFailure, ...cleanupErrors] : cleanupErrors, 'Flow1 cleanup failed')
    }
  })

  it('[browser] applies the exact Flow1 published pack to a real project and runs its verified business rule task', async () => {
    if (gap22FlowPackRef === undefined) throw new Error('Flow1 did not produce an actual published pack ref')
    let temporaryDirectory: string | undefined
    let closePage: (() => Promise<void>) | undefined
    const apiTrace: string[] = []
    const apiResponses: string[] = []
    const apiFailures: string[] = []
    const apiFailureBodyReads: Promise<void>[] = []
    let stagedFactCandidateIds = new Set<string>()
    let semanticPublicationStarted = false
    let testFailed = false
    let testFailure: unknown
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'ontology-gap22-flow3-'))
      const temporaryRoot = resolve(tmpdir())
      const ownedTemporary = resolve(temporaryDirectory)
      if (ownedTemporary === temporaryRoot || !relative(temporaryRoot, ownedTemporary).split(sep).every((segment) => segment.length > 0 && segment !== '..')) {
        throw new Error('the Flow3 temporary upload directory is outside the owned OS temporary root')
      }
      const csvPath = join(temporaryDirectory, 'gap22-asset-facts.csv')
      await writeFile(csvPath, 'asset_code,inspection_due\nGAP22-ASSET-001,true\n', 'utf8')
      const { page, close } = await newPage()
      closePage = close
    page.on('request', (entry) => {
      if (new URL(entry.url()).pathname.startsWith('/api/v1/')) apiTrace.push(`${entry.method()} ${new URL(entry.url()).pathname}`)
    })
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (!path.startsWith('/api/v1/')) return
      apiResponses.push(`${response.status()} ${response.request().method()} ${path}`)
      const expectedNoPriorStatement = response.status() === 404 && response.request().method() === 'GET' &&
        !semanticPublicationStarted && stagedFactCandidateIds.has(path.split('/').at(-1) ?? '') &&
        /^\/api\/v1\/statements\/[0-9a-f-]{36}$/u.test(path)
      if (response.status() >= 400 && !expectedNoPriorStatement) {
        const entry = `${response.status()} ${response.request().method()} ${path}`
        apiFailureBodyReads.push(response.text().then((body) => { apiFailures.push(`${entry}: ${body}`) }).catch((error: unknown) => {
          apiFailures.push(`${entry}: response body unavailable (${error instanceof Error ? error.message : String(error)})`)
        }))
      }
    })
      await page.goto(web.origin)
      await page.waitForSelector('[data-testid="guide-home"]')
      await page.getByTestId('tab-projects').click()
      await page.waitForSelector('[data-testid="project-workspace"]:is([data-phase="ready"], [data-phase="empty"])')
      const projectCreate = page.locator('.project-create-disclosure')
      if (await projectCreate.getAttribute('open') === null) await projectCreate.locator('summary').click()
      const packSelector = page.getByTestId('project-create-pack')
      await page.waitForFunction((expected: { id: string; version: string; digest: string }) => {
        const select = document.querySelector<HTMLSelectElement>('[data-testid="project-create-pack"]')
        return select !== null && [...select.options].some((option) => option.value === JSON.stringify(expected))
      }, gap22FlowPackRef)
      const exactPackValue = JSON.stringify(gap22FlowPackRef)
      await packSelector.waitFor({ state: 'visible' })
      const [configuredProfileResponse] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/core/published-pack-profiles'),
        packSelector.selectOption({ value: exactPackValue }),
      ])
      expect(configuredProfileResponse.status()).toBe(200)
      const configuredPayload = await configuredProfileResponse.json() as { data: { purpose: string; packRef: { id: string; version: string; digest: string }; definitionRef: { id: string; version: string; digest: string }; profileRef: { id: string; version: string } } }
      expect(configuredPayload.data.purpose).toBe('business_project_configuration')
      expect(configuredPayload.data.packRef).toEqual(gap22FlowPackRef)
      expect(configuredPayload.data.definitionRef).toMatchObject({ id: gap22FlowPackRef.id, version: gap22FlowPackRef.version })
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-testid="project-create-submit"]')?.disabled === false)
      await page.getByTestId('project-create-title').fill('GAP-022 已发布规则项目')
      const bootstrapResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/core/project-bootstrap')
      await page.getByTestId('project-create-submit').click()
      const projectResponse = await bootstrapResponse
      expect(projectResponse.status()).toBe(201)
      const projectPayload = await projectResponse.json() as { data: { project: { projectId: string; title: string }; revision: { profileRef: { id: string; version: string } } } }
      expect(projectPayload.data.project.title).toBe('GAP-022 已发布规则项目')
      expect(projectPayload.data.revision.profileRef).toEqual(configuredPayload.data.profileRef)
      const projectId = projectPayload.data.project.projectId
      gap22FlowProjectId = projectId
      await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${projectId}"]`)
      expect(await page.getByTestId('context-project-select').inputValue()).toBe(projectId)
      expect(await page.getByTestId('context-project-select').locator('option:checked').textContent()).toContain('GAP-022 已发布规则项目')

      await page.getByRole('button', { name: '导入资料', exact: true }).click()
      await page.getByTestId('project-file').setInputFiles(csvPath)
      const importResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/structured-imports`)
      await page.getByTestId('project-file-submit').click()
      const imported = await importResponse
      const importedBodyText = await imported.text()
      expect(imported.ok(), `actual CSV import returned ${String(imported.status())}: ${importedBodyText}`).toBe(true)
      const importedPayload = JSON.parse(importedBodyText) as { data: { originalRef: { id: string; version: string; digest: string } } }
      const originalCsvRef = importedPayload.data.originalRef
      gap22FlowCsvRef = originalCsvRef
      expect(originalCsvRef.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
      await page.waitForSelector('[data-testid="project-file-result"][data-status="complete"]')
      expect(await page.getByTestId('project-file-result').textContent()).toContain('共 1 行')
      await page.locator('[data-testid="source-candidate"]').waitFor()
      await page.locator('[data-testid="source-candidate"]').getByRole('button', { name: '确认这份资料的映射' }).click()
      await page.waitForSelector('[data-testid="project-mapping"]:not([hidden])')
      await page.getByTestId('mapping-source').selectOption({ index: 1 })
      await page.getByTestId('mapping-object').selectOption('asset')
      const mappedFieldIds = await page.locator('[data-testid="mapping-fields"] tbody tr').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')?.replace('mapping-field-', '') ?? ''))
      expect(mappedFieldIds).toContain('asset_code')
      expect(mappedFieldIds).toContain('inspection_due')
      await page.getByTestId('mapping-column-asset_code').selectOption({ label: 'asset_code' })
      await page.getByTestId('mapping-column-inspection_due').selectOption({ label: 'inspection_due' })
      const mappingPreview = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/mappings/preview`)
      await page.getByTestId('mapping-preview-button').click()
      expect((await mappingPreview).ok()).toBe(true)
      await page.waitForSelector('[data-testid="mapping-preview"][data-confirmable="true"]')
      const mappedIdentity = page.getByTestId('mapping-preview-asset_code')
      expect(await mappedIdentity.locator('td:nth-child(2)').textContent()).toBe('GAP22-ASSET-001')
      expect(await mappedIdentity.locator('td:nth-child(3)').textContent()).toBe('GAP22-ASSET-001')
      // Preview columns are 规范字段 | 原始值 | 规范值 | 单位 | 实际定位 (design §1.5/N07).
      expect(await mappedIdentity.locator('td:nth-child(4)').textContent()).toBe('—')
      expect(await mappedIdentity.locator('td:nth-child(5)').textContent()).toContain('A2')
      const confirmMapping = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/mappings`)
      await page.getByTestId('mapping-confirm-button').click()
      const confirmedMappingResponse = await confirmMapping
      expect(confirmedMappingResponse.ok()).toBe(true)
      const confirmedMappingPayload = await confirmedMappingResponse.json() as { data: { mapping: { ref: { id: string; version: string; digest: string } } } }
      expect(confirmedMappingPayload.data.mapping.ref).toMatchObject({ id: expect.any(String), version: expect.any(String), digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) })
      await page.getByTestId('mapping-confirmed').waitFor()
      await page.getByTestId('record-bind').click()
      await page.waitForFunction(() => document.querySelector('[data-testid="bind-notice"]')?.textContent?.includes('已绑定 1 条记录') === true)
      const recordsStepCatalogue = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/core/projects/${projectId}/source-catalogue`)
      await page.getByRole('button', { name: '项目记录', exact: true }).click()
      const catalogueResponse = await recordsStepCatalogue
      expect(catalogueResponse.ok()).toBe(true)
      const cataloguePayload = await catalogueResponse.json() as { data: { revision: { mappingRefs: readonly { id: string; version: string; digest: string }[] } } }
      expect(cataloguePayload.data.revision.mappingRefs).toContainEqual(confirmedMappingPayload.data.mapping.ref)
      await page.waitForSelector('[data-testid="record-row"][data-status="confirmed"]')
      const stagedFacts = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/core/projects/${projectId}/fact-candidates`)
      await page.getByTestId('project-stage-facts').click()
      const stagedResponse = await stagedFacts
      expect(stagedResponse.status()).toBe(201)
      const stagedPayload = await stagedResponse.json() as { data: { candidates: readonly { candidateId: string }[] } }
      expect(stagedPayload.data.candidates.length).toBeGreaterThan(0)
      stagedFactCandidateIds = new Set(stagedPayload.data.candidates.map((candidate) => candidate.candidateId))
      gap22FlowFactCandidateIds = stagedFactCandidateIds
      const factCandidateId = stagedPayload.data.candidates[0]?.candidateId
      if (factCandidateId === undefined) throw new Error('the actual project flow did not create its source-backed fact candidate')
      await page.getByTestId('project-create-reviews').click()
      await page.waitForSelector('[data-testid="instance-review"]')
      await page.locator('[data-testid="instance-record-item"]').first().click()
      await page.waitForSelector('[data-testid="instance-detail"]')
      const confirmedFieldIds = await page.locator('[data-testid="instance-field-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-field-id') ?? ''))
      expect(confirmedFieldIds).toContain('asset_code')
      expect(confirmedFieldIds).toContain('inspection_due')
      for (const fieldId of confirmedFieldIds) {
        const row = page.locator(`[data-testid="instance-field-row"][data-field-id="${fieldId}"]`)
        await row.getByTestId('instance-field-confirm').click()
        await row.locator('[data-testid="instance-field-status"][data-status="confirmed"]').waitFor()
      }
      await page.getByTestId('instance-identity-reason').fill('根据原始资产编码确认这条项目记录的对象身份')
      const identityResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/identity-decisions'))
      await page.getByTestId('instance-identity-create').click()
      const createdIdentity = await identityResponse
      expect(createdIdentity.ok()).toBe(true)
      const createdIdentityBody = await createdIdentity.json() as { data: { record: { identity: { matchedEntityId?: string; binding?: { identityScopeId: string } } } } }
      const actualEntityId = createdIdentityBody.data.record.identity.matchedEntityId
      if (actualEntityId === undefined) throw new Error('the real Flow3 identity-create action returned no matched entity ID')
      gap22FlowEntityId = actualEntityId
      const identityScopeId = createdIdentityBody.data.record.identity.binding?.identityScopeId
      if (identityScopeId === undefined) throw new Error('the actual Flow3 identity binding omitted its stable semantic scope')
      gap22FlowIdentityScopeId = identityScopeId
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('已新建') === true)
      const instanceApproval = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/approve'))
      await page.getByTestId('instance-approve').click()
      expect((await instanceApproval).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent?.includes('已批准') === true)
      const instancePublication = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/publish'))
      await page.getByTestId('instance-publish').click()
      expect((await instancePublication).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent === '已发布')
      const cellSourceButton = page.locator('[data-testid="instance-field-row"][data-field-id="asset_code"] [data-testid="instance-field-source"] button')
      await cellSourceButton.focus()
      await page.keyboard.press('Enter')
      const sourceDialog = page.getByRole('dialog', { name: '字段来源' })
      await sourceDialog.waitFor()
      await sourceDialog.locator('[data-testid="answer-source-fragment"] button').first().click()
      await sourceDialog.getByTestId('original-cell-location').waitFor()
      const originalCell = await sourceDialog.getByTestId('original-cell-location').textContent()
      expect(originalCell).toContain('GAP22-ASSET-001')
      expect(originalCell).toContain('A2')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.activeElement?.closest('[data-testid="instance-field-source"]') !== null)

      // Record confirmation and official semantic publication are separate human authority steps.
      const candidateListResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/candidates')
      const reviewUrl = new URL(page.url())
      reviewUrl.searchParams.set('view', 'review')
      reviewUrl.searchParams.set('candidate', factCandidateId)
      await page.goto(reviewUrl.href)
      const candidateListResponse = await candidateListResponsePromise
      expect(candidateListResponse.ok()).toBe(true)
      const candidateListPayload = await candidateListResponse.json() as { data: { candidates: readonly { candidateId: string }[] } }
      const factCandidateIndex = candidateListPayload.data.candidates.findIndex((candidate) => candidate.candidateId === factCandidateId)
      expect(factCandidateIndex, `staged fact candidate ${factCandidateId} is absent from the browser-loaded review list`).toBeGreaterThanOrEqual(0)
      await page.waitForSelector('[data-testid="candidate-panel"]')
      await page.waitForFunction(() => { const phase = document.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase'); return phase !== undefined && phase !== 'loading' })
      const candidatePhase = await page.getAttribute('[data-testid="candidate-panel"]', 'data-phase')
      if (candidatePhase !== 'ready') throw new Error(`project fact review did not load: phase=${String(candidatePhase)} panel=${await page.getByTestId('candidate-panel').textContent()}`)
      const candidateItems = page.getByTestId('candidate-item')
      expect(await candidateItems.count()).toBe(candidateListPayload.data.candidates.length)
      expect(await candidateItems.nth(factCandidateIndex).getAttribute('data-selected')).toBe('true')
      await page.waitForFunction((expected) => document.querySelector('[data-testid="candidate-id"]')?.textContent === expected, factCandidateId)
      const candidateApproval = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/candidates/${factCandidateId}/reviews`)
      await page.getByTestId('review-reason').fill('核对了来源单元格及映射字段后批准正式事实')
      await page.getByTestId('review-approve').click()
      expect((await candidateApproval).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="review-head"]')?.getAttribute('data-approved') === 'true')
      const semanticPublication = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/semantic-publications')
      semanticPublicationStarted = true
      await page.getByTestId('publish').click()
      expect((await semanticPublication).status()).toBe(201)
      await page.waitForSelector('[data-testid="statement-current"][data-status="active"]')

      await page.getByTestId('tab-projects').click()
      await discardIfNeeded(page)
      await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${projectId}"]`)
      await page.getByRole('button', { name: '项目记录', exact: true }).click()
      await page.getByTestId('dataset-object').selectOption('asset')
      const materialize = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/dataset-snapshots`)
      await page.getByTestId('dataset-materialize').click()
      const materialized = await materialize
      const materializedText = await materialized.text()
      expect(materialized.ok(), `actual dataset materialization returned ${String(materialized.status())}: ${materializedText}`).toBe(true)
      await page.waitForSelector('[data-testid="dataset-status"][data-state="ready"]', { timeout: 60_000 })
      await page.waitForFunction(() => document.querySelector('[data-testid="readiness-state-dataset"]')?.textContent === '已就绪')

      // Dataset materialization and semantic readiness advance independently. Wait for the
      // actual worker-earned readiness before opening a task which requires that projection.
      await page.waitForFunction(async (expectedProjectId) => {
        const response = await fetch(`/api/v1/projects/${expectedProjectId}/readiness?required=published_semantics`)
        if (!response.ok) throw new Error(`semantic readiness read failed: ${response.status}`)
        const envelope = await response.json() as { data: { ready: boolean } }
        return envelope.data.ready
      }, projectId, { polling: 500, timeout: 30_000 })

      await page.waitForFunction(async (expectedProjectId) => {
        const response = await fetch(`/api/v1/core/projects/${expectedProjectId}/task-catalogue`)
        if (!response.ok) throw new Error(`actual task catalogue read failed: ${response.status}`)
        const envelope = await response.json() as { data: { project: { projectId: string }; tasks: readonly { bindingRef: { id: string }; available: boolean }[] } }
        return envelope.data.project.projectId === expectedProjectId &&
          envelope.data.tasks.some((task) => task.bindingRef.id === 'core.task.rule_judgement' && task.available)
      }, projectId, { polling: 500, timeout: 30_000 })

      await page.getByTestId('tab-business').click()
      await discardIfNeeded(page)
      expect(await page.getByTestId('business-project').inputValue()).toBe(projectId)
      expect(await page.getByTestId('context-project-select').inputValue()).toBe(projectId)
      const refreshedCatalogue = page.waitForResponse((response) => response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/v1/core/projects/${projectId}/task-catalogue`)
      await page.getByTestId('business-task-refresh').click()
      expect((await refreshedCatalogue).ok()).toBe(true)
      const ruleTask = page.locator('[data-testid="task-entry"][data-task-id="core.task.rule_judgement"]')
      await ruleTask.waitFor()
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[data-testid="task-entry"][data-task-id="core.task.rule_judgement"]')?.disabled === false)
      if (await ruleTask.isDisabled()) throw new Error(`real rule task unavailable for the generated pack/project: ${await ruleTask.textContent()}; catalogue=${await page.getByTestId('business-task-list').textContent()}`)
      expect(await page.getByTestId('business-model-note').textContent()).toContain('智能判断未启用')
      await ruleTask.click()
      const ruleField = page.getByTestId('task-parameter-rule')
      const ruleOption = (await ruleField.locator('option').allTextContents()).find((label) => label.toLowerCase().includes('inspection required'))
      if (ruleOption === undefined) throw new Error(`actual published rule was not offered by the task schema: ${await ruleField.locator('option').allTextContents()}`)
      await ruleField.selectOption({ label: ruleOption })
      const entityField = page.getByTestId('task-parameter-entity')
      const entityOption = (await entityField.locator('option').allTextContents()).find((label) => label.includes('GAP22-ASSET-001'))
      if (entityOption === undefined) throw new Error(`actual confirmed entity was not offered by the task schema: ${await entityField.locator('option').allTextContents()}`)
      await entityField.selectOption({ label: entityOption })
      const selectedRule = await ruleField.inputValue()
      const selectedEntity = await entityField.inputValue()
      expect(await page.getByTestId('task-run').isDisabled()).toBe(true)
      await page.getByTestId('task-parameter-preview').click()
      await page.getByTestId('task-parameter-diff').waitFor()
      expect(await page.getByTestId('task-parameter-diff').textContent()).toContain(ruleOption)
      expect(await page.getByTestId('task-parameter-diff').textContent()).toContain(entityOption)
      await page.getByTestId('task-parameter-confirm').click()
      expect(await page.getByTestId('task-run').isEnabled()).toBe(true)
      const modelRequestCount = modelRequests.length
      const taskRun = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/runs')
      await page.getByTestId('task-run').click()
      const runResponse = await taskRun
      expect(runResponse.status()).toBe(202)
      const submitted: unknown = runResponse.request().postDataJSON()
      expect(submitted).toMatchObject({ projectId, task: { arguments: { rule: selectedRule, entity: selectedEntity } } })
      const runPayload = await runResponse.json() as { data: { runId: string } }
      gap22FlowRunId = runPayload.data.runId
      await page.waitForSelector('[data-testid="business-run-panel"][data-state="published"]', { timeout: 60_000 })
      expect(modelRequests.length).toBe(modelRequestCount)
      await page.getByTestId('published-answer-body').waitFor()
      const judgementView = page.getByTestId('published-answer-rule-judgement')
      await judgementView.waitFor()
      expect(await judgementView.textContent()).toContain('条件成立')
      expect(await judgementView.textContent()).toContain('仅描述规则条件或适用性')
      const actualAnswer = await waitForAnswer(runPayload.data.runId)
      type EvidenceRefShape = { readonly id: string; readonly version: string; readonly digest: string; readonly kind: string }
      const answerBody = (actualAnswer['v3Body'] ?? actualAnswer['body']) as { assertions: readonly { kind: string; judgementAxis?: string; value?: string; ruleRef?: { id: string; version: string; digest: string }; premiseRefs?: readonly EvidenceRefShape[]; references?: readonly { evidenceRef: EvidenceRefShape }[] }[] }
      expect(Array.isArray(answerBody.assertions)).toBe(true)
      const judgement = answerBody.assertions.find((assertion) => assertion.kind === 'rule_judgement')
      expect(judgement).toMatchObject({ judgementAxis: 'applicability', value: 'true' })
      if (judgement?.ruleRef === undefined || judgement.premiseRefs === undefined || judgement.premiseRefs.length === 0) throw new Error(`actual rule judgement omitted its exact published rule/premise references: ${JSON.stringify(judgement)}`)
      const judgementRuleRef = judgement.ruleRef
      const citedPremiseRef = judgement.premiseRefs.find((ref) => ref.kind === 'evidence')
      if (citedPremiseRef === undefined) throw new Error(`the verified rule judgement has no clickable evidence premise: ${JSON.stringify(judgement.premiseRefs)}`)
      const renderableRefs = [...(judgement.references ?? []).map((binding) => binding.evidenceRef), ...judgement.premiseRefs]
      const uniqueRenderedRefs = [...new Map(renderableRefs.map((ref) => [`${ref.id}\u0000${ref.version}\u0000${ref.digest}\u0000${ref.kind}`, ref])).values()]
      const citedPremiseIndex = uniqueRenderedRefs.findIndex((ref) => ref.id === citedPremiseRef.id && ref.version === citedPremiseRef.version && ref.digest === citedPremiseRef.digest && ref.kind === citedPremiseRef.kind)
      if (citedPremiseIndex < 0) throw new Error('the exact evidence premise was not present among the rendered rule citation controls')
      await capture(page, 'gap22-flow3-verified-rule-task-1440')
      const ruleAssertion = page.locator('[data-testid="published-answer-statement"][data-kind="rule_judgement"]')
      const evidenceButton = ruleAssertion.getByTestId('published-answer-evidence-reference').nth(citedPremiseIndex)
      await evidenceButton.click()
      const resultEvidenceDialog = page.getByRole('dialog', { name: '结果依据' })
      await resultEvidenceDialog.waitFor()
      const answerSourceFragment = resultEvidenceDialog.getByTestId('answer-source-fragment')
      await answerSourceFragment.waitFor()
      const sourceCells = answerSourceFragment.locator('tbody tr')
      let conditionCell: import('@playwright/test').Locator | undefined
      for (let index = 0; index < await sourceCells.count(); index += 1) {
        const row = sourceCells.nth(index)
        const text = await row.textContent()
        if (text?.includes('true') && text.includes('B2')) { conditionCell = row; break }
      }
      if (conditionCell === undefined) throw new Error(`the rule premise citation did not expose the actual inspection_due CSV cell B2: ${await answerSourceFragment.textContent()}`)
      await conditionCell.locator('td').nth(2).getByRole('button').click()
      const citedOriginalCell = answerSourceFragment.getByTestId('original-cell-location')
      await citedOriginalCell.waitFor()
      expect(await citedOriginalCell.textContent()).toContain('B2')
      expect(await citedOriginalCell.textContent()).toContain('true')
      const sourceDetails = answerSourceFragment.getByText('原始文件与解析版本', { exact: true })
      await sourceDetails.click()
      const answerSourceText = await answerSourceFragment.textContent()
      expect(answerSourceText).toContain(originalCsvRef.id)
      expect(answerSourceText).toContain(originalCsvRef.digest)
      expect(await resultEvidenceDialog.getByRole('button', { name: '查看完整依赖与历史' }).count()).toBe(1)
      await capture(page, 'gap22-flow3-answer-csv-cell-1440')
      await resultEvidenceDialog.getByRole('button', { name: '查看完整依赖与历史' }).waitFor()
      const fullEvidenceNavigation = page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'evidence' ||
        [...document.querySelectorAll('dialog[open]')].some((dialog) => dialog.textContent?.includes('离开当前工作内容？') === true))
      await resultEvidenceDialog.getByRole('button', { name: '查看完整依赖与历史' }).click()
      await fullEvidenceNavigation
      await discardIfNeeded(page)
      await page.waitForFunction(() => new URL(window.location.href).searchParams.get('view') === 'evidence')
      await page.getByTestId('evidence-basis').waitFor()
      expect(await page.getByTestId('basis-evidence-id').textContent()).toBe(citedPremiseRef.id)
      expect(await page.getByTestId('source-snapshots').textContent()).not.toBe('')
      await capture(page, 'gap22-flow3-evidence-1440')
      await record('gap22-flow3-actual-business-task', [
        `publishedPack=${gap22FlowPackRef.id}@${gap22FlowPackRef.version}`,
        `project=${projectId}`,
        `run=${runPayload.data.runId}`,
        `ruleRef=${judgementRuleRef.id}@${judgementRuleRef.version}`,
        `premiseEvidenceRef=${citedPremiseRef.id}@${citedPremiseRef.version}`,
        'input=visible task schema selecting actual published rule and confirmed entity',
        'axis=applicability; value=true; no business-proposition claim',
        'source=actual project CSV original cell row-2 column-1 value GAP22-ASSET-001',
        `rulePremiseSource=actual original CSV B2=true; originalRef=${originalCsvRef.id}; digest=${originalCsvRef.digest}`,
        'fact=record approval+separate Candidate Review approval+semantic publication+materialized project dataset',
        'modelRequests=unchanged while registered deterministic task ran',
        ...apiResponses,
        ...apiTrace,
      ])
      await Promise.all(apiFailureBodyReads)
      expect(apiFailures).toEqual([])
    } catch (error) {
      testFailed = true
      testFailure = error
      await Promise.all(apiFailureBodyReads)
      await record('gap22-flow3-failure', [
        error instanceof Error ? error.stack ?? error.message : String(error),
        ...apiFailures,
        ...apiResponses,
        ...apiTrace,
      ])
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      if (closePage !== undefined) {
        try { await closePage() } catch (error) { cleanupErrors.push(error) }
      }
      if (temporaryDirectory !== undefined) {
        try {
          const ownedTemporary = resolve(temporaryDirectory)
          const temporaryRoot = resolve(tmpdir())
          if (ownedTemporary === temporaryRoot || !relative(temporaryRoot, ownedTemporary).split(sep).every((segment) => segment.length > 0 && segment !== '..')) {
            throw new Error('refusing Flow3 cleanup outside the owned OS temporary root')
          }
          await rm(ownedTemporary, { recursive: true, force: true })
        } catch (error) { cleanupErrors.push(error) }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(testFailed ? [testFailure, ...cleanupErrors] : cleanupErrors, 'Flow3 cleanup failed')
    }
  })

  it('[browser] cancels and re-runs a staged version evolution against the real Flow3 project', async () => {
    if (gap22FlowTargetPackRef === undefined || gap22FlowPackRef === undefined || gap22FlowProjectId === '' || gap22FlowRunId === '' || gap22FlowCsvRef === undefined || gap22FlowEntityId === '' || gap22FlowIdentityScopeId === '') {
      throw new Error('the actual Flow1 target pack and Flow3 project answer/identity are required before project evolution')
    }
    const originalCsvRef = gap22FlowCsvRef
    const originalPackRef = gap22FlowPackRef
    const existingEntityId = gap22FlowEntityId
    const existingIdentityScopeId = gap22FlowIdentityScopeId
    const { page, close } = await newPage()
    const evolutionRequests: string[] = []
    const flow4ApiTrace: string[] = []
    page.on('request', (entry) => {
      const path = new URL(entry.url()).pathname
      if (path.startsWith('/api/v1/')) flow4ApiTrace.push(`${entry.method()} ${path}`)
    })
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (path.startsWith('/api/v1/')) flow4ApiTrace.push(`${response.status()} ${response.request().method()} ${path}`)
    })
    page.on('request', (entry) => {
      const path = new URL(entry.url()).pathname
      if (path.startsWith(`/api/v1/projects/${gap22FlowProjectId}/evolutions/`)) evolutionRequests.push(`${entry.method()} ${path}`)
    })
    try {
      await page.goto(`${web.origin}/?view=projects`)
      await page.waitForSelector('[data-testid="project-workspace"]')
      await page.getByTestId('context-project-select').selectOption(gap22FlowProjectId)
      await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${gap22FlowProjectId}"]`)
      await page.getByRole('button', { name: '版本演进', exact: true }).click()
      const evolutionPanel = page.getByTestId('project-evolution')
      await evolutionPanel.waitFor()

      const targetValue = `${gap22FlowTargetPackRef.id}:${gap22FlowTargetPackRef.version}:${gap22FlowTargetPackRef.digest}`
      const targetChoice = evolutionPanel.getByTestId('evolution-pack')
      await targetChoice.selectOption({ value: targetValue })
      await evolutionPanel.getByLabel('演进原因').fill('使用同一工作区经新 CQ 验证并发布的 1.1.0 版本重新处理原始项目资料')
      await evolutionPanel.getByLabel('新版本中的记录类型').selectOption('asset')
      const remapFields = evolutionPanel.locator('.project-remap select').nth(1)
      await remapFields.selectOption({ label: 'asset_code' })
      await evolutionPanel.locator('.project-remap select').nth(2).selectOption({ label: 'inspection_due' })
      await evolutionPanel.getByLabel('我已核对原始列对应和重新审核要求，以待审核方式创建演进。').check()
      const projectBefore = await readJson<{ data: { project: { activeRevision: string; headRevision: string } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}`),
      )
      const oldAnswerBefore = await readJson<{ data: { answerId: string; contentHash: string; v3Body?: unknown; body?: unknown } }>(
        await request(baseUrl, `/api/v1/runs/${gap22FlowRunId}/answer`),
      )
      if (admin === undefined) throw new Error('the real PostgreSQL audit client is unavailable')
      const oldBindingBefore = await admin.query<{ binding: unknown }>(
        'SELECT binding FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3',
        [scopeRef.tenantId, scopeRef.spaceId, gap22FlowRunId],
      )
      expect(oldBindingBefore.rows).toHaveLength(1)
      const savedOldBinding = oldBindingBefore.rows[0]?.binding
      const firstProfileResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/core/published-pack-profiles')
      const firstPlanResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${gap22FlowProjectId}/evolutions`)
      await evolutionPanel.getByTestId('evolution-start').click()
      const configuredTargetProfile = await firstProfileResponse
      expect(configuredTargetProfile.status()).toBe(200)
      const configuredTargetProfileBody = await configuredTargetProfile.json() as { data: { packRef: VersionRef; definitionRef: VersionRef; profileRef: { id: string; version: string; snapshotHash: string } } }
      expect(configuredTargetProfileBody.data.packRef).toEqual(gap22FlowTargetPackRef)
      expect(configuredTargetProfileBody.data.profileRef.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
      const firstPlan = await firstPlanResponse
      const firstPlanBodyText = await firstPlan.text()
      if (firstPlan.status() !== 202) throw new Error(`actual browser evolution start returned ${String(firstPlan.status())}: ${firstPlanBodyText}; panel=${await evolutionPanel.textContent()}`)
      const firstEvolutionRequest = firstPlan.request().postDataJSON() as { industryPackRef: VersionRef; profileRef?: { id: string; version: string; snapshotHash: string } }
      expect(firstEvolutionRequest.industryPackRef).toEqual(gap22FlowTargetPackRef)
      expect(firstEvolutionRequest.profileRef).toEqual(configuredTargetProfileBody.data.profileRef)
      const firstEvolutionRequestDigest = contentDigestOf(firstEvolutionRequest)
      const firstPlanBody = JSON.parse(firstPlanBodyText) as { data: { evolution: ProjectEvolutionRecord } }
      const cancelledPlanId = firstPlanBody.data.evolution.plan.evolutionId
      expect(firstPlanBody.data.evolution.plan.previousRevisionRef.revision).toBe(projectBefore.data.project.activeRevision)
      expect(firstPlanBody.data.evolution.plan.targetRevisionRef.revision).not.toBe(projectBefore.data.project.activeRevision)
      const targetRevisionResponse = await readJson<{ data: { revision: { industryPackRef: { id: string; version: string; digest: string }; semanticPublicationRefs: readonly VersionRef[] } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/revisions/${firstPlanBody.data.evolution.plan.targetRevisionRef.revision}`),
      )
      expect(targetRevisionResponse.data.revision.industryPackRef).toEqual(gap22FlowTargetPackRef)
      expect(targetRevisionResponse.data.revision.semanticPublicationRefs).toEqual([])

      const cancelResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${gap22FlowProjectId}/evolutions/${cancelledPlanId}/cancel`)
      await evolutionPanel.getByRole('button', { name: '取消本次演进' }).click()
      const cancelled = await cancelResponse
      expect(cancelled.ok()).toBe(true)
      const cancelledBody = await cancelled.json() as { data: { evolution: ProjectEvolutionRecord } }
      expect(cancelledBody.data.evolution.state).toBe('cancelled')
      await evolutionPanel.getByRole('heading', { name: '已取消' }).waitFor()
      expect(await evolutionPanel.textContent()).not.toContain('MALFORMED_RESPONSE')
      const afterCancel = await readJson<{ data: { project: { activeRevision: string; headRevision: string } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}`),
      )
      expect(afterCancel.data.project.activeRevision).toBe(projectBefore.data.project.activeRevision)
      expect(afterCancel.data.project.headRevision).toBe(firstPlanBody.data.evolution.plan.targetRevisionRef.revision)
      const oldAnswerAfterCancel = await readJson<{ data: { answerId: string; contentHash: string; v3Body?: unknown; body?: unknown } }>(
        await request(baseUrl, `/api/v1/runs/${gap22FlowRunId}/answer`),
      )
      expect(oldAnswerAfterCancel.data).toEqual(oldAnswerBefore.data)

      const afterCancelCatalogue = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/core/projects/${gap22FlowProjectId}/source-catalogue`)
      await page.getByRole('button', { name: '项目记录', exact: true }).click()
      expect((await afterCancelCatalogue).ok()).toBe(true)
      await page.getByRole('button', { name: '版本演进', exact: true }).click()
      const refreshedEvolutionPanel = page.getByTestId('project-evolution')
      await refreshedEvolutionPanel.getByTestId('evolution-pack').selectOption({ value: targetValue })
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLSelectElement>('.project-remap select')].some((select) =>
        [...select.options].some((option) => option.value === 'asset')))
      await refreshedEvolutionPanel.getByLabel('演进原因').fill('取消后的重试计划：重新映射并人工复核同一原始 CSV 的新版本记录')
      await refreshedEvolutionPanel.getByLabel('新版本中的记录类型').selectOption('asset')
      await refreshedEvolutionPanel.locator('.project-remap select').nth(1).selectOption({ label: 'asset_code' })
      await refreshedEvolutionPanel.locator('.project-remap select').nth(2).selectOption({ label: 'inspection_due' })
      await refreshedEvolutionPanel.getByLabel('我已核对原始列对应和重新审核要求，以待审核方式创建演进。').check()
      const secondPlanResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${gap22FlowProjectId}/evolutions`)
      await refreshedEvolutionPanel.getByTestId('evolution-start').click()
      const secondPlan = await secondPlanResponse
      const secondPlanBodyText = await secondPlan.text()
      if (secondPlan.status() !== 202) throw new Error(`actual browser evolution restart returned ${String(secondPlan.status())}: ${secondPlanBodyText}; panel=${await refreshedEvolutionPanel.textContent()}`)
      const secondPlanBody = JSON.parse(secondPlanBodyText) as { data: { evolution: ProjectEvolutionRecord } }
      const activePlanId = secondPlanBody.data.evolution.plan.evolutionId
      await record('gap23-flow4-after-start-ui', [JSON.stringify({
        url: page.url(), panel: await refreshedEvolutionPanel.textContent(),
        body: (await page.locator('body').innerText()).slice(0, 12_000), requests: evolutionRequests,
      })])
      expect(secondPlanBody.data.evolution.plan.previousRevisionRef.revision).toBe(projectBefore.data.project.activeRevision)
      expect(secondPlanBody.data.evolution.plan.sources).toHaveLength(1)
      expect(secondPlanBody.data.evolution.plan.sources[0]?.expectedRecords).toBe(1)
      expect(secondPlanBody.data.evolution.plan.sources[0]?.objectId).toBe('asset')
      expect(secondPlanBody.data.evolution.plan.sources[0]?.originalRef.id).toBe(originalCsvRef.id)
      expect(secondPlanBody.data.evolution.plan.sources[0]?.originalRef.digest).toBe(originalCsvRef.digest)

      await expect.poll(async () => {
        const actual = await readJson<{ data: { evolution: { state: string } } }>(
          await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/evolutions/${activePlanId}`),
        )
        return actual.data.evolution.state
      }, { timeout: 30_000, interval: 250 }).toBe('awaiting_review')
      const staged = await readJson<{ data: { evolution: ProjectEvolutionRecord } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/evolutions/${activePlanId}`),
      )
      const stagedJob = await readJson<{ data: { stage: string; counts: Record<string, number>; state?: string; lastError?: unknown } }>(
        await request(baseUrl, `/api/v1/jobs/${secondPlanBody.data.evolution.plan.jobId}`),
      )
      const evolvedRecordId = secondPlanBody.data.evolution.plan.sources[0]?.recordIds[0]
      const physicalHistory = evolvedRecordId === undefined || admin === undefined ? [] : (await admin.query<{
        revision: string; mapping_id: string; mapping_version: string; content_digest: string
      }>(
        'SELECT revision::text AS revision,mapping_id::text AS mapping_id,mapping_version,content_digest FROM agent_platform.project_record_versions WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND record_id=$4 ORDER BY revision',
        [scopeRef.tenantId, scopeRef.spaceId, gap22FlowProjectId, evolvedRecordId],
      )).rows
      await record('gap23-flow4-staged-evolution-diagnostic', [JSON.stringify({ evolution: staged.data.evolution, job: stagedJob.data, physicalHistory })])
      expect(staged.data.evolution.state).toBe('awaiting_review')
      expect(staged.data.evolution.candidateIds).toHaveLength(1)
      const beforePlanRefresh = await page.evaluate(() => ({
        url: location.href,
        dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')]
          .map((dialog) => dialog.innerText.trim()),
        body: document.body.innerText.slice(0, 12_000),
      }))
      await record('gap23-flow4-before-plan-refresh-ui', [JSON.stringify({ ...beforePlanRefresh, panel: await refreshedEvolutionPanel.textContent(), requests: evolutionRequests })])
      if (await page.getByRole('dialog', { name: '离开当前工作内容？' }).isVisible()) {
        await discardIfNeeded(page)
      }
      const planReadback = page.waitForResponse((response) => response.request().method() === 'GET' &&
        new URL(response.url()).pathname.startsWith(`/api/v1/projects/${gap22FlowProjectId}/evolutions/`))
      await refreshedEvolutionPanel.getByRole('button', { name: '刷新计划' }).click()
      const refreshedPlan = await planReadback
      expect(refreshedPlan.ok()).toBe(true)
      expect(new URL(refreshedPlan.url()).pathname.split('/').at(-1)).toBe(activePlanId)
      const refreshedPlanBody = await refreshedPlan.json() as { data: { evolution: ProjectEvolutionRecord } }
      expect(refreshedPlanBody.data.evolution.state).toBe('awaiting_review')
      await refreshedEvolutionPanel.getByRole('heading', { name: '等待人工审核' }).waitFor()
      const reextractedCandidateId = staged.data.evolution.candidateIds[0]
      if (reextractedCandidateId === undefined) throw new Error('the real worker produced no candidate from the original project source')
      expect(gap22FlowFactCandidateIds.has(reextractedCandidateId)).toBe(false)
      await evolutionPanel.getByRole('button', { name: '核对本批 1 条重抽取记录' }).click()
      await page.waitForSelector('[data-testid="instance-review"]')
      const selectedRecordItem = page.locator('[data-testid="instance-record-item"][data-selected="true"]')
      await selectedRecordItem.waitFor()
      await page.waitForSelector('[data-testid="instance-detail"]')
      const reextractedRecordId = await selectedRecordItem.getAttribute('data-record-id')
      if (reextractedRecordId === null) throw new Error('the actual evolution review row has no record ID')
      const reextractedRecord = await readJson<{ data: { record: { identity: { binding?: { candidateId: string; projectRevisionRef: { projectId: string; revision: string; digest: string } }; candidates: readonly { entityId: string; objectId: string; strategy: string; identityScopeId?: string }[] }; fields: readonly { fieldId: string; rawValue: string | boolean | null; normalizedValue?: { kind: string; value?: unknown }; source: { documentRef: VersionRef } }[] } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/instance-records/${reextractedRecordId}`),
      )
      expect(reextractedRecord.data.record.identity.binding).toMatchObject({
        candidateId: reextractedCandidateId,
        projectRevisionRef: secondPlanBody.data.evolution.plan.targetRevisionRef,
      })
      const normalizedIdentity = reextractedRecord.data.record.fields.find((field) => field.fieldId === 'asset_code')
      expect(normalizedIdentity).toMatchObject({
        rawValue: 'GAP22-ASSET-001',
        normalizedValue: { kind: 'scalar', value: 'GAP22-ASSET-001' },
        source: { documentRef: { id: originalCsvRef.id, digest: originalCsvRef.digest } },
      })
      const existingIdentityCandidate = reextractedRecord.data.record.identity.candidates.find((candidate) => candidate.entityId === existingEntityId)
      expect(existingIdentityCandidate).toMatchObject({ entityId: existingEntityId, objectId: 'asset', strategy: 'native_id', identityScopeId: existingIdentityScopeId })
      const matchEntity = page.locator(`[data-testid="instance-identity-candidate"][data-entity-id="${existingEntityId}"]`)
      await matchEntity.waitFor()
      const reextractedFields = await page.locator('[data-testid="instance-field-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-field-id') ?? ''))
      expect(reextractedFields).toContain('asset_code')
      expect(reextractedFields).toContain('inspection_due')
      for (const fieldId of reextractedFields) {
        const row = page.locator(`[data-testid="instance-field-row"][data-field-id="${fieldId}"]`)
        await row.getByTestId('instance-field-confirm').click()
        await row.locator('[data-testid="instance-field-status"][data-status="confirmed"]').waitFor()
      }
      await page.getByTestId('instance-identity-reason').fill('从项目演进重抽取的原始 CSV 资产编码确认新版本身份')
      const identity = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/identity-decisions'))
      await matchEntity.getByTestId('instance-identity-match').click()
      const matchedIdentity = await identity
      expect(matchedIdentity.ok()).toBe(true)
      const matchedIdentityBody = await matchedIdentity.json() as { data: { record: { identity: { state: string; matchedEntityId?: string } } } }
      expect(matchedIdentityBody.data.record.identity).toMatchObject({ state: 'matched', matchedEntityId: existingEntityId })
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-identity-state"]')?.textContent?.includes('已匹配') === true)
      const approvedRecord = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/approve'))
      await page.getByTestId('instance-approve').click()
      expect((await approvedRecord).ok()).toBe(true)
      const publishedRecord = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/publish'))
      await page.getByTestId('instance-publish').click()
      expect((await publishedRecord).ok()).toBe(true)
      await page.waitForFunction(() => document.querySelector('[data-testid="instance-detail-publication"]')?.textContent === '已发布')

      const candidateReviewUrl = new URL(page.url())
      candidateReviewUrl.searchParams.set('view', 'review')
      candidateReviewUrl.searchParams.set('candidate', reextractedCandidateId)
      const candidateList = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/candidates')
      await page.goto(candidateReviewUrl.href)
      expect((await candidateList).ok()).toBe(true)
      await page.waitForSelector('[data-testid="candidate-panel"][data-phase="ready"]')
      const candidateApproval = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/candidates/${reextractedCandidateId}/reviews`)
      await page.getByTestId('review-reason').fill('重新核对 1.1.0 版本重抽取记录及其原始 CSV 支持后批准')
      await page.getByTestId('review-approve').click()
      expect((await candidateApproval).ok()).toBe(true)
      const semanticPublication = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/semantic-publications')
      await page.getByTestId('publish').click()
      const semanticPublicationResponse = await semanticPublication
      expect(semanticPublicationResponse.status()).toBe(201)
      const semanticPublicationBody = await semanticPublicationResponse.json() as { data: { publicationId: string; versionRef: VersionRef; schemaRef: VersionRef; approvedCandidateRefs: readonly { candidateId: string; kind: string }[]; statements: readonly { statementId: string; sourceCandidateId: string; status: string; sourceRefs: readonly ResourceRef[] }[] } }
      expect(semanticPublicationBody.data.approvedCandidateRefs).toContainEqual({ candidateId: reextractedCandidateId, kind: 'entity' })
      expect(semanticPublicationBody.data.statements).toContainEqual(expect.objectContaining({ statementId: reextractedCandidateId, sourceCandidateId: reextractedCandidateId, status: 'active' }))
      const semanticPublicationReadback = await readJson<{ data: typeof semanticPublicationBody.data }>(
        await request(baseUrl, `/api/v1/semantic-publications/${semanticPublicationBody.data.publicationId}`),
      )
      expect(semanticPublicationReadback.data).toEqual(semanticPublicationBody.data)
      await page.waitForSelector('[data-testid="statement-current"][data-status="active"]')

      await page.getByTestId('tab-projects').click()
      await discardIfNeeded(page)
      await page.waitForSelector(`[data-testid="project-detail"][data-project-id="${gap22FlowProjectId}"]`)
      await page.getByRole('button', { name: '版本演进', exact: true }).click()
      await page.getByTestId('project-evolution').getByRole('button', { name: '激活已完成审核的版本' }).waitFor()
      const activation = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/projects/${gap22FlowProjectId}/evolutions/${activePlanId}/activate`)
      await page.getByTestId('project-evolution').getByRole('button', { name: '激活已完成审核的版本' }).click()
      const activatedResponse = await activation
      expect(activatedResponse.ok()).toBe(true)
      const activatedBody = await activatedResponse.json() as { data: { evolution: ProjectEvolutionRecord } }
      expect(activatedBody.data.evolution.state).toBe('ready')
      await page.getByTestId('project-evolution').getByRole('heading', { name: '新版本已激活' }).waitFor()
      expect(await page.getByTestId('project-evolution').textContent()).not.toContain('MALFORMED_RESPONSE')
      const currentProject = await readJson<{ data: { project: { activeRevision: string } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}`),
      )
      expect(BigInt(currentProject.data.project.activeRevision)).toBeGreaterThan(BigInt(projectBefore.data.project.activeRevision))
      const currentRevisionNumber = currentProject.data.project.activeRevision
      const currentRevision = await readJson<{ data: { revision: { industryPackRef: VersionRef; semanticPublicationRefs: readonly VersionRef[] } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/revisions/${currentRevisionNumber}`),
      )
      expect(currentRevision.data.revision.industryPackRef).toEqual(gap22FlowTargetPackRef)
      expect(currentRevision.data.revision.semanticPublicationRefs).toEqual([])
      const oldAnswerAfterActivation = await readJson<{ data: { answerId: string; contentHash: string; v3Body?: unknown; body?: unknown } }>(
        await request(baseUrl, `/api/v1/runs/${gap22FlowRunId}/answer`),
      )
      expect(oldAnswerAfterActivation.data).toEqual(oldAnswerBefore.data)
      const oldBindingAfter = await admin.query<{ binding: unknown }>(
        'SELECT binding FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3',
        [scopeRef.tenantId, scopeRef.spaceId, gap22FlowRunId],
      )
      expect(oldBindingAfter.rows).toEqual([{ binding: savedOldBinding }])
      const oldRevision = await readJson<{ data: { revision: { industryPackRef: VersionRef } } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/revisions/${projectBefore.data.project.activeRevision}`),
      )
      expect(oldRevision.data.revision.industryPackRef).toEqual(originalPackRef)
      const actualSources = await readJson<{ data: { sources: readonly { originalRef: VersionRef }[] } }>(
        await request(baseUrl, `/api/v1/core/projects/${gap22FlowProjectId}/source-catalogue`),
      )
      expect(actualSources.data.sources.some((source) => source.originalRef.id === originalCsvRef.id && source.originalRef.digest === originalCsvRef.digest)).toBe(true)
      const currentDataset = await readJson<{ data: { snapshotRef: ResourceRef; rows: readonly unknown[] } }>(
        await request(baseUrl, `/api/v1/projects/${gap22FlowProjectId}/dataset?objectId=asset`),
      )
      expect(currentDataset.data.snapshotRef.kind).toBe('dataset')
      expect(currentDataset.data.rows).toHaveLength(1)
      const statementUrl = new URL(page.url())
      statementUrl.searchParams.set('view', 'review')
      statementUrl.searchParams.set('candidate', reextractedCandidateId)
      await page.goto(statementUrl.href)
      await page.waitForSelector('[data-testid="statement-current"][data-status="active"]')
      const currentStatementVersion = await page.getAttribute('[data-testid="statement-current"]', 'data-version')
      if (currentStatementVersion === null) throw new Error('the re-extracted fact statement has no current revision')
      await page.getByTestId('revision-reason').fill('撤回本次重抽取候选的语义依据，同时保留已发布版本与旧答案历史')
      const statementRetraction = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/statements/${reextractedCandidateId}/revisions`)
      await page.getByTestId('revise-retraction').click()
      const retractionResponse = await statementRetraction
      expect(retractionResponse.status()).toBe(200)
      const retraction = await retractionResponse.json() as { data: { statementId: string; version: string; kind: string; reason: string; supersedesVersion?: string } }
      const retractedVersion = (BigInt(currentStatementVersion) + 1n).toString()
      expect(retraction.data).toMatchObject({ statementId: reextractedCandidateId, version: retractedVersion, kind: 'retraction', supersedesVersion: currentStatementVersion })
      await page.waitForSelector(`[data-testid="statement-current"][data-status="retracted"][data-version="${retractedVersion}"]`)
      const retractionRow = page.locator(`[data-testid="revision-record"][data-kind="retraction"]`)
      await retractionRow.waitFor()
      expect(await retractionRow.textContent()).toContain('撤回本次重抽取候选的语义依据')
      const currentStatement = await readJson<{ data: { status: string; version: string } }>(
        await request(baseUrl, `/api/v1/statements/${reextractedCandidateId}`),
      )
      expect(currentStatement.data).toMatchObject({ status: 'retracted', version: retractedVersion })
      const statementHistory = await readJson<{ data: { revisions: readonly { version: string; kind: string; reason: string; supersedesVersion?: string }[] } }>(
        await request(baseUrl, `/api/v1/statements/${reextractedCandidateId}/revisions`),
      )
      expect(statementHistory.data.revisions).toContainEqual(expect.objectContaining({
        version: retractedVersion, kind: 'retraction', reason: '撤回本次重抽取候选的语义依据，同时保留已发布版本与旧答案历史', supersedesVersion: currentStatementVersion,
      }))
      const oldAnswerAfterRetraction = await readJson<{ data: { answerId: string; contentHash: string; v3Body?: unknown; body?: unknown } }>(
        await request(baseUrl, `/api/v1/runs/${gap22FlowRunId}/answer`),
      )
      expect(oldAnswerAfterRetraction.data).toEqual(oldAnswerBefore.data)
      const oldBindingAfterRetraction = await admin.query<{ binding: unknown }>(
        'SELECT binding FROM agent_platform.run_execution_bindings WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3',
        [scopeRef.tenantId, scopeRef.spaceId, gap22FlowRunId],
      )
      expect(oldBindingAfterRetraction.rows).toEqual([{ binding: savedOldBinding }])
      await capture(page, 'gap23-flow4-retracted-evolution-support-1440')
      await record('gap23-flow4-actual-project-evolution', [
        `cancelledEvolution=${cancelledPlanId}`,
        `activeEvolution=${activePlanId}`,
        `targetPack=${gap22FlowTargetPackRef.id}@${gap22FlowTargetPackRef.version}`,
        `activeRevision=${currentProject.data.project.activeRevision}`,
        `newCandidate=${reextractedCandidateId}`,
        `semanticPublication=${semanticPublicationBody.data.publicationId}@${semanticPublicationBody.data.versionRef.version}; candidate=${reextractedCandidateId}; readback=verified`,
        `resolvedTargetProfile=${configuredTargetProfileBody.data.profileRef.id}@${configuredTargetProfileBody.data.profileRef.version}; snapshotHash=${configuredTargetProfileBody.data.profileRef.snapshotHash}`,
        `evolutionRequestDigest=${firstEvolutionRequestDigest}`,
        `oldAnswer=${oldAnswerBefore.data.answerId}; unchanged=${oldAnswerAfterActivation.data.contentHash === oldAnswerBefore.data.contentHash}`,
        `fixedSource=${originalCsvRef.id}; digest=${originalCsvRef.digest}`,
        `currentDataset=${currentDataset.data.snapshotRef.id}; digest=${currentDataset.data.snapshotRef.digest}`,
        `retraction=${retraction.data.version}; status=${currentStatement.data.status}; oldAnswerStable=${oldAnswerAfterRetraction.data.contentHash === oldAnswerBefore.data.contentHash}`,
      ])
    } catch (error) {
      try {
        const flow4FailureUi = await page.evaluate(() => ({
          url: location.href,
          appView: document.querySelector('.app')?.getAttribute('data-view'),
          projectWorkspacePhase: document.querySelector<HTMLElement>('[data-testid="project-workspace"]')?.getAttribute('data-phase'),
          contextProjectValue: document.querySelector<HTMLSelectElement>('[data-testid="context-project-select"]')?.value,
          contextProjectSelectedLabel: document.querySelector<HTMLSelectElement>('[data-testid="context-project-select"]')?.selectedOptions[0]?.textContent?.trim(),
          projectOptions: [...document.querySelectorAll<HTMLOptionElement>('[data-testid="context-project-select"] option')].map((option) => ({ value: option.value, label: option.textContent?.trim() })),
          contextWorkspaceValue: document.querySelector<HTMLSelectElement>('[data-testid="context-workspace-select"]')?.value,
          contextProjectLoading: document.querySelector('[data-testid="context-project-loading"]')?.textContent?.trim(),
          projectDetails: [...document.querySelectorAll<HTMLElement>('[data-testid="project-detail"]')].map((detail) => ({ projectId: detail.getAttribute('data-project-id'), text: detail.innerText.trim() })),
          dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')].map((dialog) => dialog.innerText.trim()),
          body: document.body.innerText.slice(0, 12_000),
        }))
        await record('gap23-flow4-failure-ui-diagnostic', [JSON.stringify({ error: error instanceof Error ? error.stack ?? error.message : String(error), ui: flow4FailureUi, requests: flow4ApiTrace })])
        await capture(page, 'gap23-flow4-failure-ui-1440')
      } catch (diagnosticError) {
        await record('gap23-flow4-failure-ui-diagnostic-error', [diagnosticError instanceof Error ? diagnosticError.stack ?? diagnosticError.message : String(diagnosticError)])
      }
      throw error
    } finally {
      await close()
    }
  })
})

async function workspaceHead(workspaceId: string): Promise<string> {
  const view = await readJson<{ data: { workspace: { headRevision: string } } }>(
    await request(baseUrl, `/api/v1/industry-workspaces/${workspaceId}`),
  )
  return view.data.workspace.headRevision
}

async function createWorkspace(namespace: string): Promise<string> {
  const response = await jsonRequest(baseUrl, '/api/v1/core/workspace-bootstrap', {
    namespace,
    displayName: 'Generic E2E workspace',
    boundary: { goals: ['model assets'], included: ['registry'], excluded: ['pricing'], applicability: {} },
  })
  if (response.status !== 201) throw new Error(`workspace create failed: ${await response.text()}`)
  return (await response.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

interface GeneratedCandidate {
  readonly candidateId: string
  readonly kind: string
  readonly payload: Record<string, unknown>
}

async function generateCandidates(workspaceId: string, grounding?: { readonly sourceRefs: readonly ResourceRef[]; readonly generationPolicyRef: VersionRef }): Promise<GeneratedCandidate[]> {
  const response = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/generations`, {
    kinds: ['object', 'attribute'],
    generationPolicyRef: POLICY_REF,
    ...grounding,
  }, { 'if-match': await workspaceHead(workspaceId) })
  if (response.status !== 201) throw new Error(`generation failed: ${await response.text()}`)
  return (await response.json() as { data: { candidates: GeneratedCandidate[] } }).data.candidates
}

async function ingestRule(
  workspaceId: string,
  rule: {
    readonly ruleId: string
    readonly displayName: string
    readonly businessMeaning: string
    readonly objectId: string
    readonly condition: unknown
  },
): Promise<{ candidateId: string; ruleId: string; contentDigest: string }> {
  const response = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/ingest`, {
    rules: [{ kind: 'rule', suggestedReason: 'derived from the registry', exceptions: [], ruleDependencies: [], ...rule }],
  }, { 'if-match': await workspaceHead(workspaceId) })
  if (response.status !== 201) throw new Error(`rule ingest failed: ${await response.text()}`)
  const rule1 = (await response.json() as { data: { rules: { candidateId: string; contentDigest: string }[] } }).data.rules[0]
  if (rule1 === undefined) throw new Error('rule ingest returned no candidate')
  return { candidateId: rule1.candidateId, ruleId: rule.ruleId, contentDigest: rule1.contentDigest }
}

async function createExampleSet(workspaceId: string, ruleId: string): Promise<string> {
  const response = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets`, {
    caseKinds: ['contradiction'],
    cases: [{
      caseId: 'case-due',
      caseKind: 'contradiction',
      objectTypeRef: 'asset',
      fields: [
        { fieldId: 'inspection_due', value: true },
        { fieldId: 'asset_code', value: 'asset-code-1' },
      ],
    }],
    expectations: [{
      expectationId: 'exp-due',
      caseId: 'case-due',
      kind: 'rule',
      ruleId,
      expected: 'true',
      origin: 'authored_oracle',
      reason: 'the oracle asserts the disjunction fires',
      confirmedBy: 'reviewer-1',
      confirmedAt: '2026-09-30T00:00:00Z',
    }],
  }, { 'if-match': await workspaceHead(workspaceId) })
  if (response.status !== 201) throw new Error(`example set failed: ${await response.text()}`)
  return (await response.json() as { data: { exampleSet: { exampleSetId: string } } }).data.exampleSet.exampleSetId
}

async function createExampleSetAndValidate(workspaceId: string, ruleId: string): Promise<string> {
  const exampleSetId = await createExampleSet(workspaceId, ruleId)
  if (publishedWorkspaceSource === undefined) throw new Error('the published OR workspace has no actual policy source')
  const competency = await prepareOrCompetency({ baseUrl, workspaceId, exampleSetId, scopeRef,
    sourceRef: publishedWorkspaceSource.sourceRef, policyText: publishedWorkspaceSource.policyText, call: ordinaryCall })
  const report = await readJson<{ data: { validation: { validationId: string } } }>(
    await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/validations`, { exampleSetId, ...competency }, { 'if-match': await workspaceHead(workspaceId) }),
  )
  return report.data.validation.validationId
}

async function latestPublicationRevision(): Promise<string> {
  const view = await readJson<{ data: { publications: { revision: string }[] } }>(
    await request(baseUrl, '/api/v1/semantic-publications'),
  )
  return view.data.publications.at(-1)?.revision ?? '0'
}

async function scenarioDefinitionRef(scenarioId: string): Promise<{ id: string; version: string; digest: string }> {
  const deployment = await readJson<{ data: { scenarios: { scenarioId: string; definitionRef: { id: string; version: string; digest: string } }[] } }>(
    await request(baseUrl, '/api/v1/core/deployment'),
  )
  const scenario = deployment.data.scenarios.find((entry) => entry.scenarioId === scenarioId)
  if (scenario === undefined) throw new Error(`scenario ${scenarioId} is not mounted`)
  return scenario.definitionRef
}
