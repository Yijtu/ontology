import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

/**
 * V03-045 (#217) generic dual-assistant full-stack browser E2E.
 *
 * One real environment drives the whole A.US-016 journey: a throwaway PostgreSQL container, the
 * real `createCoreLocalComposition` host (real control stores, real immutable blob store, real
 * DuckDB snapshot, the durable job worker and the durable workflow dispatch/controller), the real
 * built web app served by the loopback static host, and a real Chromium page. Nothing about the
 * Controller, Worker or persistence is mocked. The only substitute is the generative model:
 * a loopback OpenAI-compatible server answers the single controlled definition-candidate response
 * this test needs (recorded explicitly in the run log); no candidates, derived conclusions or
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

const modelRequests: string[] = []

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    modelRequests.push(Buffer.concat(chunks).toString('utf8'))
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const content = JSON.stringify(GENERATED_DEFINITION)
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

async function newPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
  const page = await context.newPage()
  return { page, close: () => context.close() }
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
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await otherApi?.close().catch(() => undefined)
  await otherComposition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  await new Promise<void>((resolve) => modelServer?.close(() => resolve()))
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
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
      await page.selectOption('[data-testid="query-registered-task"]', 'facts:inspection_due')
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
      await page.waitForSelector('[data-testid="evidence-panel"]')
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
    const candidates = await generateCandidates(workspaceId)
    const attribute = candidates.find((candidate) => candidate.kind === 'attribute')
    if (attribute === undefined) throw new Error('generation produced no attribute candidate')
    expect(modelRequests.length).toBeGreaterThanOrEqual(1)

    await readJson(await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/candidates/${attribute.candidateId}/edits`, {
      payload: { ...attribute.payload, businessMeaning: 'Whether the next scheduled inspection is due' },
      reason: 'clarify the business meaning',
    }, { 'if-match': await workspaceHead(workspaceId) }))
    await readJson(await jsonRequest(baseUrl, `/api/v1/candidates/${attribute.candidateId}/reviews`, {
      decision: 'approve',
      reason: 'operator reviewed the generated attribute',
    }, { 'if-match': '0' }))

    // A genuine different-condition OR is executable (V03-026 / #188) and must enable.
    const orRule = await ingestRule(workspaceId, {
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
    const enabled = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${orRule.candidateId}/enable`, {}, { 'if-match': await workspaceHead(workspaceId) })
    expect(enabled.status).toBe(200)
    expect((await enabled.json() as { data: { candidate: { lifecycle: string } } }).data.candidate.lifecycle).toBe('enabled')

    const exampleSetId = await createExampleSet(workspaceId, orRule.ruleId)
    const report = await readJson<{ data: { validation: { validationId: string; publishable: boolean; semanticPublished: { passed: boolean } } } }>(
      await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/validations`, { exampleSetId }, { 'if-match': await workspaceHead(workspaceId) }),
    )
    expect(report.data.validation.publishable).toBe(true)
    expect(report.data.validation.semanticPublished.passed).toBe(true)

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
    const profileRef = { id: 'generic-e2e-profile', version: '1.0.0', snapshotHash: DIGEST }
    const documentSetRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }

    const created = await readJson<{ data: { project: { projectId: string; headRevision: string } } }>(
      await jsonRequest(baseUrl, '/api/v1/projects', {
        title: 'Generic E2E project',
        industryPackRef: packRef,
        profileRef,
        mappingRefs: [
          {
            id: 'mapping-1',
            version: '1.0.0',
            digest: DIGEST,
            role: 'catalog',
            sourceObjectRef: { sourceRef: { namespace: 'generic-e2e', sourceId: 'src-1' }, objectPath: 'asset' },
          },
        ],
        documentSetRef,
      }),
    )
    const projectId = created.data.project.projectId
    expect(created.data.project.headRevision).toBe('1')

    const readiness = await readJson<{ data: { ready: boolean; blockers: { code: string }[] } }>(
      await request(baseUrl, `/api/v1/projects/${projectId}/readiness?required=published_semantics`),
    )
    expect(readiness.data.ready).toBe(false)
    expect(readiness.data.blockers[0]?.code).toBe('READINESS_NOT_BUILT')

    // A newer pack version mounts as a new revision and invalidates the readiness projection.
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
    const mounted = await readJson<{ data: { revision: { ref: { revision: string } }; readinessInvalidated: string[] } }>(
      await jsonRequest(baseUrl, `/api/v1/projects/${projectId}/pack-mounts`, {
        industryPackRef: newerPack.packRef,
        reason: 'switch to 1.1.0',
      }, { 'if-match': '1' }),
    )
    expect(mounted.data.revision.ref.revision).toBe('2')
    expect(mounted.data.readinessInvalidated).toContain('published_semantics')

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
      'mount=revision-2',
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
})

async function workspaceHead(workspaceId: string): Promise<string> {
  const view = await readJson<{ data: { workspace: { headRevision: string } } }>(
    await request(baseUrl, `/api/v1/industry-workspaces/${workspaceId}`),
  )
  return view.data.workspace.headRevision
}

async function createWorkspace(namespace: string): Promise<string> {
  const response = await jsonRequest(baseUrl, '/api/v1/industry-workspaces', {
    namespace,
    displayName: 'Generic E2E workspace',
    boundary: { goals: ['model assets'], included: ['registry'], excluded: ['pricing'], applicability: {} },
    documentSetRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
  })
  if (response.status !== 201) throw new Error(`workspace create failed: ${await response.text()}`)
  return (await response.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

interface GeneratedCandidate {
  readonly candidateId: string
  readonly kind: string
  readonly payload: Record<string, unknown>
}

async function generateCandidates(workspaceId: string): Promise<GeneratedCandidate[]> {
  const response = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/generations`, {
    kinds: ['object', 'attribute'],
    generationPolicyRef: POLICY_REF,
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
): Promise<{ candidateId: string; ruleId: string }> {
  const response = await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/ingest`, {
    rules: [{ kind: 'rule', suggestedReason: 'derived from the registry', exceptions: [], ruleDependencies: [], ...rule }],
  }, { 'if-match': await workspaceHead(workspaceId) })
  if (response.status !== 201) throw new Error(`rule ingest failed: ${await response.text()}`)
  const rule1 = (await response.json() as { data: { rules: { candidateId: string }[] } }).data.rules[0]
  if (rule1 === undefined) throw new Error('rule ingest returned no candidate')
  return { candidateId: rule1.candidateId, ruleId: rule.ruleId }
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
  const report = await readJson<{ data: { validation: { validationId: string } } }>(
    await jsonRequest(baseUrl, `/api/v1/industry-workspaces/${workspaceId}/validations`, { exampleSetId }, { 'if-match': await workspaceHead(workspaceId) }),
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
