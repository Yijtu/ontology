import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresCandidateSubmissionStore, PostgresResearchExecutionStore, runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, emptyCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { createToolContext } from '@ontology/contracts'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `researchwire_${randomUUID().replaceAll('-', '')}`
const MODEL_SECRET = 'test-only-controlled-research-secret'
const SEARCH_DOMAIN = 'standards.example.org'
const PAGE_A = { url: `https://${SEARCH_DOMAIN}/maintenance-manual`, title: '设备维护手册', snippet: '设备维护与检修周期说明。', content: '设备维护手册：点检周期为 30 天，停机条件为温度超过 85 摄氏度。' }
const PAGE_B = { url: `https://${SEARCH_DOMAIN}/inspection-code`, title: '点检规范', snippet: '点检频次与适用版本。', content: '点检规范：标准编号 GB/T-9001，适用版本 2026，点检频次每 30 天一次。' }

interface ModelToolCall {
  readonly callId: string
  readonly toolId: string
  readonly arguments: Readonly<Record<string, unknown>>
}
interface ModelTurn {
  readonly toolCalls: readonly ModelToolCall[]
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let bareScopeRef: ScopeRef
let bareObjectDirectory = ''
let bareComposition: CoreLocalComposition | undefined
let bareApi: ReturnType<typeof createCoreApi> | undefined
let bareBaseUrl = ''
let modelServer: Server | undefined
let modelServerUrl = ''
let pageServer: Server | undefined
let pageBaseUrl = ''
let fixture: WebSearchFixture | undefined
const workerErrors: Error[] = []
let scriptedWorkspaceId = ''
let modelDelayMs = 0
let modelScript: (toolMessages: readonly string[]) => ModelTurn = defaultResearchScript

function toolCall(callId: string, toolId: string, args: Readonly<Record<string, unknown>>): ModelTurn {
  return { toolCalls: [{ callId, toolId, arguments: args }] }
}

function webSearchTurn(): ModelTurn {
  return toolCall('call_search', 'web_search', { query: '设备维护规程与点检规范', allowedDomains: [SEARCH_DOMAIN], limit: 5 })
}

/**
 * Turn 1 searches, turn 2 reads the run's staged material through `document_search` (exercising the
 * real versioned targeted read), and turn 3 submits one source + one **multi-source** definition
 * candidate whose evidence is echoed from the real `web_search` tool result. It never invents a
 * ref/digest: it deep-copies the exact `snapshotRef`/`snapshotManifestRef`/`contentDigest` the
 * platform returned, so the real evidence authorizer must accept them on their own merits.
 */
function defaultResearchScript(toolMessages: readonly string[]): ModelTurn {
  if (toolMessages.length === 0) return webSearchTurn()
  if (toolMessages.length === 1) return toolCall('call_read', 'document_search', { query: '维护' })
  if (toolMessages.length === 2) return submitTurn(toolMessages[0] ?? '')
  return { toolCalls: [] }
}

/** Submit both candidates in one command without a preceding read (for the budget case). */
function budgetScript(toolMessages: readonly string[]): ModelTurn {
  if (toolMessages.length === 0) return webSearchTurn()
  if (toolMessages.length === 1) return submitTurn(toolMessages[0] ?? '')
  return { toolCalls: [] }
}

function archivedPages(searchResultContent: string): readonly Record<string, unknown>[] {
  const jsonText = searchResultContent.slice(searchResultContent.indexOf('\n') + 1)
  const parsed = JSON.parse(jsonText) as { pages?: readonly Record<string, unknown>[] }
  return parsed.pages ?? []
}

function evidenceOf(page: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'web_page',
    url: page['url'],
    snapshotRef: page['snapshotRef'],
    snapshotManifestRef: page['snapshotManifestRef'],
    contentDigest: page['contentDigest'],
    fetchedAt: page['fetchedAt'],
    parserVersion: page['parserVersion'],
  }
}

function submitTurn(searchResultContent: string): ModelTurn {
  const pages = archivedPages(searchResultContent)
  const [first, second] = pages
  if (first === undefined) return { toolCalls: [] }
  const evidence = second === undefined ? [evidenceOf(first)] : [evidenceOf(first), evidenceOf(second)]
  const command = {
    schemaVersion: 'submit-candidates@1',
    commandKind: 'submit_candidates',
    workspaceId: scriptedWorkspaceId,
    note: '疑似官方标准，请人工审核',
    candidates: [
      {
        kind: 'source',
        reason: '设备维护手册页面提供了维护周期的正式依据',
        origin: { url: first['url'], publisher: '示例标准机构' },
        evidence: [evidenceOf(first)],
      },
      {
        kind: 'definition',
        definitionKind: 'object',
        reason: '依据两份归档页面提出设备对象候选',
        evidence,
        payload: {
          kind: 'object',
          logicalId: 'equipment',
          displayName: '设备',
          businessMeaning: '需要定期维护的物理设备',
          suggestedReason: '归档页面描述了设备及其维护要求',
          identityAttributeIds: [],
        },
      },
    ],
  }
  return toolCall('call_submit', 'submit_candidates', command)
}

function writeOpenAiTurn(response: ServerResponse, turn: ModelTurn): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const base = { id: 'chatcmpl-research', object: 'chat.completion.chunk', created: 1, model: 'synthetic-research-vendor' }
  for (const call of turn.toolCalls) {
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.callId, type: 'function', function: { name: call.toolId, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }], usage: null })}\n\n`)
  }
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls.length > 0 ? 'tool_calls' : 'stop' }], usage: null })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
}

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    let toolMessages: string[] = []
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: readonly { role?: string; content?: string }[] }
      toolMessages = (body.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.content ?? '')
    } catch {
      toolMessages = []
    }
    const turn = modelScript(toolMessages)
    if (modelDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, modelDelayMs))
    if (response.writableEnded || response.destroyed) return
    writeOpenAiTurn(response, turn)
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

/** A real local page HTTP server the mapped transport forwards the canonical page URLs to. */
async function startPageServer(): Promise<string> {
  const pages = new Map<string, { content: string; type: string }>([
    ['/maintenance-manual', { content: `<html><body><h1>设备维护手册</h1><p>点检周期为 30 天，停机条件为温度超过 85 摄氏度。</p></body></html>`, type: 'text/html' }],
    ['/inspection-code', { content: `<html><body><h1>点检规范</h1><p>标准编号 GB/T-9001，适用版本 2026，点检频次每 30 天一次。</p></body></html>`, type: 'text/html' }],
  ])
  pageServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const page = pages.get(url.pathname)
    if (page === undefined) { response.writeHead(404); response.end('not found'); return }
    response.writeHead(200, { 'content-type': page.type })
    response.end(page.content)
  })
  await new Promise<void>((resolve) => pageServer?.listen(0, '127.0.0.1', resolve))
  const address = pageServer.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

/**
 * The controlled page transport. It is used by the real archiver (which enforces https + the
 * approved-domain allowlist and refuses redirects before this is reached) and by the real search
 * provider. A canonical `https://standards.example.org/...` page URL is forwarded to the local page
 * server; every other URL (the local search fixture) is passed through to the platform `fetch`.
 */
const webPageFetchImpl: typeof fetch = (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href)
  if (url.protocol === 'https:' && url.hostname === SEARCH_DOMAIN) {
    return fetch(new URL(`${url.pathname}${url.search}`, pageBaseUrl), init)
  }
  return fetch(input, init)
}

async function insertScope(scope: ScopeRef, name: string): Promise<void> {
  await admin!.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scope.tenantId, `${name}-${scope.tenantId.slice(0, 8)}`])
  await admin!.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scope.tenantId, scope.spaceId, name])
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await insertScope(scopeRef, 'research-wiring')
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = 'ontology_app'
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
}

function modelEnvironment(): Record<string, string> {
  return {
    CORE_ENABLE_MODELS: 'true',
    CORE_COMPANY_MODEL_BASE_URL: modelServerUrl,
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
    CORE_COMPANY_MODEL_API_KEY: MODEL_SECRET,
    CORE_COMPANY_MODEL_PLATFORM_ID: 'core-research-wiring',
    CORE_COMPANY_MODEL_VENDOR_MODEL: 'synthetic-research-vendor',
    CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
    // A normal start must discover research from configuration, not from a test injection.
    CORE_WEB_SEARCH_BASE_URL: fixture!.baseUrl,
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
}

async function bareRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${bareBaseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
}

function hostContext(): ReturnType<typeof createToolContext> {
  return createToolContext({
    principal: { tenantId: scopeRef.tenantId, subjectId: 'research-wiring-reader', roles: ['platform-admin'], scopes: [], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: '1.0.0',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    allowedResources: { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 0 },
    traceId: `research-wiring:${scopeRef.spaceId}`,
  })
}

beforeAll(async () => {
  await startIsolatedDatabase()
  fixture = await startWebSearchFixture()
  fixture.setScenario({ results: [PAGE_A, PAGE_B] })
  pageBaseUrl = await startPageServer()
  modelServerUrl = await startControlledModelServer()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-research-wiring-'))
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: emptyCoreExamples(),
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: false,
    webPageFetchImpl,
    modelEnvironment: modelEnvironment(),
    onWorkerError(error) { if (error instanceof Error) workerErrors.push(error) },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')

  // A second, independent scope that deliberately configures *no* search provider. Its research
  // entry must still exist and answer with a stable capability reason, never a 404.
  bareScopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await insertScope(bareScopeRef, 'research-bare')
  bareObjectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-research-bare-'))
  bareComposition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory: bareObjectDirectory,
    scopeRef: bareScopeRef,
    examples: emptyCoreExamples(),
    allowLocalOperator: true,
    modelsEnabled: false,
    jevEnabled: false,
    modelEnvironment: { CORE_ENABLE_MODELS: 'false' },
  })
  bareApi = createCoreApi(bareComposition.dependencies)
  const bareAddress = await bareApi.listen({ host: '127.0.0.1', port: 0 })
  bareBaseUrl = bareAddress.replace(/\/$/u, '')
}, 300_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await bareApi?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await bareComposition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  await fixture?.stop().catch(() => undefined)
  await new Promise<void>((resolve) => { if (pageServer === undefined) resolve(); else pageServer.close(() => resolve()) })
  await new Promise<void>((resolve) => { if (modelServer === undefined) resolve(); else modelServer.close(() => resolve()) })
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  if (bareObjectDirectory !== '') await rm(bareObjectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

async function bootstrapWorkspace(target = 'primary'): Promise<string> {
  const send = target === 'primary' ? request : bareRequest
  const created = await send('/api/v1/core/workspace-bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `research-wiring-workspace-${randomUUID()}` },
    body: JSON.stringify({ namespace: `research-${randomUUID()}`, displayName: '研究装配工作区', boundary: { goals: ['整理设备维护规则'], included: ['合成资料'], excluded: [], applicability: {} } }),
  })
  if (created.status !== 201) throw new Error(`workspace bootstrap failed: ${String(created.status)} ${await created.text()}`)
  return (await created.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

function researchBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: '整理设备维护规则及其依据',
    allowedResearchDomains: [SEARCH_DOMAIN],
    targetKinds: ['object', 'attribute'],
    sourceLimit: 5,
    candidateLimit: 5,
    ...overrides,
  })
}

function startRun(workspaceId: string, body = researchBody()): Promise<Response> {
  return request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `research-wiring-${randomUUID()}` },
    body,
  })
}

async function readRun(workspaceId: string, researchId: string): Promise<Record<string, unknown>> {
  const response = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}`)
  if (response.status !== 200) throw new Error(`reading run ${researchId} returned ${String(response.status)}: ${await response.text()}`)
  return (await response.json() as { data: { execution: Record<string, unknown> } }).data.execution
}

async function waitForStatus(workspaceId: string, researchId: string, predicate: (status: string, execution: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  for (;;) {
    const execution = await readRun(workspaceId, researchId)
    if (predicate(String(execution['status']), execution)) return execution
    if (Date.now() > endAt) throw new Error(`run ${researchId} did not reach the expected state; last=${JSON.stringify(execution)} workerErrors=${workerErrors.map((error) => error.message).join('; ')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForRunState(runId: string, states: readonly string[]): Promise<void> {
  const endAt = Date.now() + 30_000
  for (;;) {
    const result = await admin!.query<{ state: string }>('SELECT state FROM agent_platform.runs WHERE run_id = $1::uuid', [runId])
    const state = result.rows[0]?.state
    if (state !== undefined && states.includes(state)) return
    if (Date.now() > endAt) throw new Error(`run ${runId} did not reach ${states.join('/')} (last ${String(state)})`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('a normal Core start discovers the research surface (N12)', () => {
  it('projects research as available from the catalogue, but archive only after a passed probe', async () => {
    const response = await request('/api/v1/workbench/overview')
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { capabilities: { ability: string; available: boolean; unavailableReason?: string }[] } }
    const byAbility = new Map(body.data.capabilities.map((entry) => [entry.ability, entry]))
    expect(byAbility.get('research')?.available).toBe(true)
    expect(byAbility.get('research')?.unavailableReason).toBeUndefined()
    expect(byAbility.get('archive')?.available).toBe(false)
    expect(byAbility.get('archive')?.unavailableReason).toContain('归档')
  })
})

describe('the default research entry runs the real agentic chain (S10)', () => {
  it('admits, drives the real Pi + tools, and delivers a bounded research run end to end', async () => {
    modelScript = defaultResearchScript
    modelDelayMs = 0
    const workspaceId = await bootstrapWorkspace()
    scriptedWorkspaceId = workspaceId

    const response = await startRun(workspaceId)
    expect(response.status, await response.clone().text()).toBe(202)
    const body = await response.json() as { data: { researchId: string; jobId: string; execution: { status: string; stage: string } } }
    expect(body.data.researchId).toBe(body.data.jobId)
    expect(body.data.execution.status).toBe('queued')
    expect(body.data.execution.stage).toBe('planning')

    const delivered = await waitForStatus(workspaceId, body.data.researchId, (status) => status === 'awaiting_confirmation')
    const runId = String(delivered['runId'])
    expect(delivered['goal']).toMatchObject({ kind: 'industry_workspace_research', workspaceId })
    expect(delivered['humanTodos']).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'source_review' })]))
    // Sources are proposed (never auto-approved); the candidate asset is pending confirmation.
    expect(delivered['sourceCount']).toBeGreaterThanOrEqual(2)
    const receipts = delivered['candidateReceipts'] as readonly { kind: string; pendingConfirmation: boolean; state: string }[]
    expect(receipts.some((receipt) => receipt.kind === 'source')).toBe(true)
    expect(receipts.some((receipt) => receipt.kind === 'definition' && receipt.pendingConfirmation)).toBe(true)

    // No project/scenario: the run is a bare workspace-research run.
    const manifest = await admin!.query<{ goal: unknown }>("SELECT manifest->'goal' AS goal FROM agent_platform.workflow_run_manifests WHERE run_id = $1::uuid", [runId])
    expect((manifest.rows[0]?.goal as { kind?: string } | undefined)?.kind).toBe('industry_workspace_research')
    // No project/scenario is created for this run: a bare workspace-research run needs neither.
    const projects = await admin!.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_platform.projects WHERE tenant_id = $1::uuid AND space_id = $2::uuid', [scopeRef.tenantId, scopeRef.spaceId])
    expect(projects.rows[0]?.count).toBe('0')

    // One run ledger; the scheduler job never opens a background ledger.
    const ledgers = await admin!.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_platform.budget_ledgers WHERE run_id = $1::uuid', [runId])
    expect(ledgers.rows[0]?.count).toBe('1')
    const background = await admin!.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_platform.budget_ledgers WHERE run_id = $1::uuid AND kind = 'background'", [body.data.researchId])
    expect(background.rows[0]?.count).toBe('0')

    // The real run spent the research dimensions on that one ledger (design §8, S06): the search
    // call, the model round and the archived source are metered, not just reported in the projection.
    const dimensions = await admin!.query<{
      searches_consumed: number
      model_rounds_consumed: number
      sources_consumed: number
      candidates_consumed: number
    }>(
      `SELECT searches_consumed, model_rounds_consumed, sources_consumed, candidates_consumed
         FROM agent_platform.budget_ledgers WHERE run_id = $1::uuid`,
      [runId],
    )
    const metered = dimensions.rows[0]
    expect(metered?.searches_consumed).toBeGreaterThanOrEqual(1)
    expect(metered?.model_rounds_consumed).toBeGreaterThanOrEqual(1)
    expect(metered?.sources_consumed).toBeGreaterThanOrEqual(1)
    expect(metered?.candidates_consumed).toBeGreaterThanOrEqual(1)
    // The projection's usage reports the ledger's measured dimensions, not a separately invented
    // number (archived snapshots stay the evidence count, which the source ceiling also bounds).
    expect(delivered['usage']).toMatchObject({
      searchCalls: metered?.searches_consumed,
      modelTurns: metered?.model_rounds_consumed,
      candidatesSubmitted: metered?.candidates_consumed,
    })

    // The run used the workspace research model binding and the workspace web_search tool binding.
    const modelBindings = await admin!.query<{ capability: string }>('SELECT capability FROM agent_platform.execution_model_bindings WHERE execution_id = $1::uuid', [runId])
    expect(modelBindings.rows.map((row) => row.capability)).toContain('research')
    const toolBindings = await admin!.query<{ tool_id: string }>('SELECT tool_id FROM agent_platform.execution_tool_bindings WHERE execution_id = $1::uuid', [runId])
    expect(toolBindings.rows.map((row) => row.tool_id)).toContain('web_search')

    // Persisted sources/candidates carry the server-fixed trust/review state.
    const sources = await admin!.query<{ trust_tier: string; review_state: string }>('SELECT trust_tier, review_state FROM agent_platform.candidate_sources WHERE workspace_id = $1::uuid', [workspaceId])
    expect(sources.rows.length).toBeGreaterThanOrEqual(1)
    expect(sources.rows.every((row) => row.trust_tier === 'agent_researched' && row.review_state === 'proposed')).toBe(true)
    const assets = await admin!.query<{ state: string }>('SELECT state FROM agent_platform.asset_candidate_versions WHERE workspace_id = $1::uuid', [workspaceId])
    expect(assets.rows.some((row) => row.state === 'pending_confirmation')).toBe(true)

    // A research run publishes no answer.
    const answer = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer`)
    expect(answer.status).toBe(202)
    const published = await admin!.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_platform.answers WHERE run_id = $1::uuid', [runId]).catch(() => ({ rows: [{ count: '0' }] }))
    expect(published.rows[0]?.count).toBe('0')

    // Restart durability: a fresh store/context over the same PostgreSQL re-reads the projection and
    // the candidate receipt unchanged.
    const database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 2 })
    try {
      const reread = await new PostgresResearchExecutionStore(database).getExecution(scopeRef, body.data.researchId, hostContext())
      if (reread?.schemaVersion !== 'research-execution@2') throw new Error('expected the persisted @2 projection')
      expect(reread.runId).toBe(runId)
      expect(reread.candidateReceipts).toEqual(delivered['candidateReceipts'])
      const receiptRows = await admin!.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_platform.candidate_submission_receipts WHERE run_id = $1::uuid', [runId])
      expect(Number(receiptRows.rows[0]?.count)).toBeGreaterThanOrEqual(1)
      const store = new PostgresCandidateSubmissionStore(database)
      const records = await store.listByRun?.(scopeRef, runId, hostContext())
      expect((records ?? []).length).toBeGreaterThanOrEqual(1)
    } finally {
      await database.close()
    }
  }, 120_000)

  it('cancels an in-flight research run without committing late candidates', async () => {
    modelScript = defaultResearchScript
    modelDelayMs = 3_000
    try {
      const workspaceId = await bootstrapWorkspace()
      scriptedWorkspaceId = workspaceId
      const started = await startRun(workspaceId)
      expect(started.status).toBe(202)
      const { researchId } = (await started.json() as { data: { researchId: string } }).data
      const execution = await waitForStatus(workspaceId, researchId, (status) => status === 'queued' || status === 'running')
      const runId = String(execution['runId'])
      await waitForRunState(runId, ['collecting'])

      const cancelled = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `cancel-${randomUUID()}` }, body: '{}' })
      expect(cancelled.status, await cancelled.clone().text()).toBe(200)
      const view = await waitForStatus(workspaceId, researchId, (status) => status === 'cancelled')
      expect(view['stopReason']).toBe('cancelled')

      // Wait past the model hold so a late tool result would have landed if it could; no candidate
      // may be committed by a cancelled run.
      await new Promise((resolve) => setTimeout(resolve, 3_500))
      const assets = await admin!.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_platform.asset_candidate_versions WHERE workspace_id = $1::uuid', [workspaceId])
      expect(assets.rows[0]?.count).toBe('0')
    } finally {
      modelDelayMs = 0
    }
  }, 120_000)

  it('enforces the candidate ceiling on the shared run ledger and refuses the excess write', async () => {
    modelScript = budgetScript
    modelDelayMs = 0
    const workspaceId = await bootstrapWorkspace()
    scriptedWorkspaceId = workspaceId
    const response = await startRun(workspaceId, researchBody({ sourceLimit: 1, candidateLimit: 1 }))
    expect(response.status).toBe(202)
    const { researchId } = (await response.json() as { data: { researchId: string } }).data
    const executed = await waitForStatus(workspaceId, researchId, (status) => status === 'awaiting_confirmation' || status === 'completed')

    // The two-candidate command could not fit the one-unit candidate ceiling, so nothing was written.
    expect(executed['candidateCount']).toBe(0)
    const assets = await admin!.query<{ count: string }>('SELECT count(*)::text AS count FROM agent_platform.asset_candidate_versions WHERE workspace_id = $1::uuid', [workspaceId])
    expect(assets.rows[0]?.count).toBe('0')
  }, 120_000)

  it('refuses to resume a delivered run', async () => {
    modelScript = defaultResearchScript
    modelDelayMs = 0
    const workspaceId = await bootstrapWorkspace()
    scriptedWorkspaceId = workspaceId
    const response = await startRun(workspaceId)
    const { researchId } = (await response.json() as { data: { researchId: string } }).data
    await waitForStatus(workspaceId, researchId, (status) => status === 'awaiting_confirmation')

    const resume = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${encodeURIComponent(researchId)}/resume`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `resume-${randomUUID()}` }, body: '{}' })
    expect(resume.status, await resume.clone().text()).toBe(409)
    expect((await resume.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT')
  }, 120_000)
})

describe('a normal Core start answers the research preflight', () => {
  it('answers a research preflight with the actual recipient and the effective domain scope', async () => {
    const workspaceId = await bootstrapWorkspace()
    const response = await request(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-preflights`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedResearchDomains: [SEARCH_DOMAIN, 'not-a-domain-at-all'], sourceLimit: 4, candidateLimit: 4 }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.json() as {
      data: { preflight: { recipient: { state: string; connectionName?: string; adapterType?: string }; effectiveDomains: readonly string[]; blocked: readonly { code: string }[]; authorization: { roles: readonly string[] } } }
    }
    expect(body.data.preflight.recipient.state).toBe('available')
    expect(body.data.preflight.recipient.connectionName).toBe('兼容网关')
    expect(body.data.preflight.recipient.adapterType).toBe('http_compat')
    expect(body.data.preflight.effectiveDomains).toEqual([SEARCH_DOMAIN, 'not-a-domain-at-all'])
    expect(body.data.preflight.blocked).toEqual([])
    expect(body.data.preflight.authorization.roles.length).toBeGreaterThan(0)
  })
})

describe('a deployment without a configured search still serves the research entry', () => {
  it('answers research-runs and reads with a stable capability reason, never a 404', async () => {
    const workspaceId = await bootstrapWorkspace('bare')

    const started = await bareRequest(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `bare-run-${randomUUID()}` },
      body: JSON.stringify({ goal: '整理规则', allowedResearchDomains: [SEARCH_DOMAIN], targetKinds: ['object'] }),
    })
    expect(started.status, await started.clone().text()).toBe(409)
    expect((await started.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')

    const read = await bareRequest(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${randomUUID()}`)
    expect(read.status).toBe(404)
    expect((await read.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')

    const resume = await bareRequest(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${randomUUID()}/resume`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `bare-resume-${randomUUID()}` }, body: '{}' })
    expect(resume.status, await resume.clone().text()).toBe(404)
    expect((await resume.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')

    const continuation = await bareRequest(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-runs/${randomUUID()}/continuations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `bare-continuation-${randomUUID()}` },
      body: JSON.stringify({ goal: '继续整理规则', allowedResearchDomains: [SEARCH_DOMAIN], targetKinds: ['object'] }),
    })
    expect(continuation.status, await continuation.clone().text()).toBe(409)
    expect((await continuation.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')

    const preflight = await bareRequest(`/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/research-preflights`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedResearchDomains: [SEARCH_DOMAIN] }),
    })
    expect(preflight.status, await preflight.clone().text()).toBe(200)
    const body = await preflight.json() as { data: { preflight: { recipient: { state: string }; blocked: readonly { code: string }[] } } }
    expect(body.data.preflight.recipient.state).toBe('unconfigured')
    expect(body.data.preflight.blocked.map((entry) => entry.code)).toContain('TOOL_NOT_CONFIGURED')
  })
})

// Kept last: it removes the imported search connection from the catalogue, so any earlier test that
// reads the catalogue must have run first.
describe('directory revocation blocks new agent runs', () => {
  it('refuses to admit a new research run once the pinned search connection is removed', async () => {
    modelScript = defaultResearchScript
    modelDelayMs = 0
    const connections = await request('/api/v1/core/ai/tool-connections')
    expect(connections.status).toBe(200)
    const list = (await connections.json() as { data: readonly { connectionId: string; adapterType: string; name: string; capabilities: readonly string[]; endpoint?: string; revision: string }[] }).data
    const compat = list.find((connection) => connection.adapterType === 'http_compat')
    if (compat === undefined) throw new Error('the imported compat search connection is missing')
    const disabled = await request(`/api/v1/core/ai/tool-connections/${encodeURIComponent(compat.connectionId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': `revoke-${randomUUID()}` },
      body: JSON.stringify({
        descriptor: { name: compat.name, adapterType: compat.adapterType, capabilities: compat.capabilities, enabled: false, ...(compat.endpoint === undefined ? {} : { endpoint: compat.endpoint }) },
        expectedRevision: compat.revision,
      }),
    })
    expect([200, 201], await disabled.clone().text()).toContain(disabled.status)

    const blocked = await startRun(await bootstrapWorkspace())
    expect(blocked.status, await blocked.clone().text()).toBe(409)
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
  }, 60_000)
})
