import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ProfileSpec, ScopeRef, VersionRef } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `planner_${randomUUID().replaceAll('-', '')}`
const COMPANY_SECRET = 'controlled-company-planner-secret'
const JEV_SECRET = 'controlled-jev-route-secret'

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let modelServer: Server | undefined
let modelServerUrl = ''
let companyPlanArguments = ''
const modelRequests: { readonly path: string; readonly body: Record<string, unknown> }[] = []
const workerErrors: Error[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBody(bytes: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function sendJson(response: import('node:http').ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function startControlledModels(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = parseBody(Buffer.concat(chunks))
    const path = request.url ?? ''
    modelRequests.push({ path, body })
    if (path === '/v1/systemone') {
      const questions = isRecord(body['questions']) ? body['questions'] : {}
      const questionId = Object.keys(questions)[0]
      if (questionId === undefined) {
        response.writeHead(422)
        response.end('missing question')
        return
      }
      sendJson(response, {
        model: 'controlled-jev-v1',
        answers: {
          [questionId]: {
            type: 'choice',
            choice: 'clarify',
            probabilities: { small_plan: 0.05, clarify: 0.95 },
            confidence: 0.95,
          },
        },
        usage: { input_tokens: 24, output_tokens: 8 },
      })
      return
    }
    if (path !== '/v1/chat/completions') {
      response.writeHead(404)
      response.end('unknown controlled endpoint')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const chunksToWrite = [
      {
        id: 'chatcmpl-core-planner',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'controlled-company-v1',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call-semantic-plan', type: 'function', function: { name: 'data_query', arguments: companyPlanArguments } }] },
          finish_reason: null,
        }],
        usage: null,
      },
      {
        id: 'chatcmpl-core-planner',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'controlled-company-v1',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: null,
      },
      {
        id: 'chatcmpl-core-planner',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'controlled-company-v1',
        choices: [],
        usage: { prompt_tokens: 18, completion_tokens: 26 },
      },
    ]
    for (const item of chunksToWrite) response.write(`data: ${JSON.stringify(item)}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `core-plan-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Core template planner route'])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = 'ontology_app'
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 30_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
    if (!response.ok) throw new Error(`GET job failed with ${String(response.status)}: ${await response.text()}`)
    const body = await response.json() as { data: Record<string, unknown> }
    if (body.data['stage'] === 'awaiting_review' || body.data['stage'] === 'failed') return body.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not reach the review boundary`)
}

async function waitForRunState(runId: string, states: readonly string[]): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${encodeURIComponent(runId)}`)
    if (!response.ok) throw new Error(`GET run failed with ${String(response.status)}: ${await response.text()}`)
    const body = await response.json() as { data: Record<string, unknown> }
    if (typeof body.data['state'] === 'string' && states.includes(body.data['state'])) return body.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not reach one of: ${states.join(', ')}`)
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 30_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer`)
    if (response.status === 200) return await response.json() as Record<string, unknown>
    if (response.status !== 202) throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish its deterministic facts answer`)
}

async function submitAndPublishIndustrialCandidate(): Promise<void> {
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === 'industrial-asset-maintenance')
  const source = scenario?.rawSources.find((entry) => entry.sourceRef.sourceId === 'asset-hours-canonical')
  if (scenario === undefined || source === undefined) throw new Error('the industrial native source was not mounted')
  const imported = await request('/api/v1/core/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'core-template-plan-industrial-source' },
    body: JSON.stringify({ scenarioId: scenario.scenarioId, sourceId: source.sourceRef.sourceId, content: await readFile(source.path, 'utf8') }),
  })
  expect(imported.status).toBe(202)
  const job = await imported.json() as { data: { jobId: string } }
  expect((await waitForJob(job.data.jobId))['stage']).toBe('awaiting_review')
  const listed = await request(`/api/v1/candidates?jobId=${encodeURIComponent(job.data.jobId)}&kind=entity`)
  const summaries = await listed.json() as { data: { candidates: { candidateId: string }[] } }
  let candidateId: string | undefined
  for (const entry of summaries.data.candidates) {
    const detail = await request(`/api/v1/candidates/${encodeURIComponent(entry.candidateId)}`)
      .then((response) => response.json()) as { data: { candidate: { nativeId?: string } } }
    if (detail.data.candidate.nativeId === 'I-04') candidateId = entry.candidateId
  }
  if (candidateId === undefined) throw new Error('the real native parser did not produce industrial candidate I-04')
  const identity = await request(`/api/v1/candidates/${encodeURIComponent(candidateId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '0' },
    body: JSON.stringify({ kind: 'create_pending', justification: 'operator reviewed the synthetic industrial source identity' }),
  })
  const identityBody = await identity.json() as { data: { targetEntityId?: string } }
  if (identityBody.data.targetEntityId === undefined) throw new Error('industrial candidate identity did not create a pending entity')
  const matched = await request(`/api/v1/candidates/${encodeURIComponent(candidateId)}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '1' },
    body: JSON.stringify({ kind: 'match', targetEntityId: identityBody.data.targetEntityId, strongIdentity: { kind: 'native_id', value: 'I-04' } }),
  })
  expect(matched.status).toBe(200)
  const reviewed = await request(`/api/v1/candidates/${encodeURIComponent(candidateId)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '0' },
    body: JSON.stringify({ decision: 'approve', reason: 'operator verified the industrial record' }),
  })
  expect(reviewed.status).toBe(200)
  const publication = await request('/api/v1/semantic-publications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': '0', 'idempotency-key': 'core-template-plan-publish-i04' },
    body: JSON.stringify({ approvedCandidateRefs: [{ candidateId, kind: 'entity' }], schemaRef: scenario.definitionRef }),
  })
  expect(publication.status).toBe(201)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  const examples = loadCoreExamples({ targetScopeRef: scopeRef })
  const industrial = examples.scenarios.find((scenario) => scenario.scenarioId === 'industrial-asset-maintenance')
  const canonicalMapping = industrial?.physicalMappings.find((mapping) => mapping.ref.id === 'synthetic-industrial-hours-canonical')
  if (canonicalMapping === undefined) throw new Error('the industrial canonical mapping was not mounted')
  companyPlanArguments = JSON.stringify({
    kind: 'query',
    mode: 'semantic',
    queryPlan: {
      mode: 'semantic',
      concepts: ['industrial_asset'],
      fields: ['asset_id', 'operating_hours'],
      links: [],
      filters: [{ fieldRef: 'asset_id', op: 'eq', values: ['I-04'] }],
      orderBy: [],
      limit: 10,
      mappingVersion: canonicalMapping.ref,
    },
  })
  modelServerUrl = await startControlledModels()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-planner-'))
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples,
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: true,
    modelEnvironment: {
      CORE_ENABLE_MODELS: 'true',
      CORE_ENABLE_JEV: 'true',
      CORE_COMPANY_MODEL_BASE_URL: modelServerUrl,
      CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
      CORE_COMPANY_MODEL_API_KEY: COMPANY_SECRET,
      CORE_COMPANY_MODEL_PLATFORM_ID: 'core-company-sql-planner',
      CORE_COMPANY_MODEL_VENDOR_MODEL: 'controlled-company-v1',
      CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
      CORE_COMPANY_MODEL_ENDPOINT: '/v1/chat/completions',
      CORE_JEV_BASE_URL: modelServerUrl,
      CORE_JEV_SECRET_REF: 'env:CORE_JEV_API_KEY',
      CORE_JEV_API_KEY: JEV_SECRET,
      CORE_JEV_PLATFORM_MODEL_ID: 'core-jev-route-planner',
      CORE_JEV_VENDOR_MODEL: 'controlled-jev-v1',
      CORE_JEV_FALLBACK_POLICY: 'reject',
    },
    onWorkerError(error) { if (error instanceof Error) workerErrors.push(error) },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
}, 180_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  await new Promise<void>((resolve) => modelServer?.close(() => resolve()))
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('run-bound Template plan preparation and immutable receipt recovery', () => {
  it('keeps fixed facts at zero model calls, then archives genuine JEV clarification and resumes it into a bounded compiled query', async () => {
    await submitAndPublishIndustrialCandidate()

    const deployment = await request('/api/v1/core/deployment').then((response) => response.json()) as {
      data: { scenarios: { scenarioId: string; profileRef: { id: string; version: string }; models: { generation: boolean; decision: boolean }; baseProfileSpec?: ProfileSpec }[] }
    }
    const industrialScenario = deployment.data.scenarios.find((entry) => entry.scenarioId === 'industrial-asset-maintenance')
    if (industrialScenario?.baseProfileSpec === undefined) throw new Error('the base industrial ProfileSpec is missing')
    expect(industrialScenario.models).toEqual({ generation: false, decision: false })
    const unboundNaturalLanguage = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-template-plan-unbound-model' },
      body: JSON.stringify({
        profileRef: industrialScenario.profileRef,
        question: 'List industrial assets with operating hours.',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(unboundNaturalLanguage.status).toBe(409)
    expect((await unboundNaturalLanguage.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(modelRequests).toHaveLength(0)

    const fixedRun = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-template-plan-fixed-facts' },
      body: JSON.stringify({
        profileRef: industrialScenario.profileRef,
        question: 'facts:operating_hours',
        context: { timeZone: 'UTC' },
        preferences: { route: 'auto', allowWeb: false },
      }),
    })
    expect(fixedRun.status).toBe(202)
    const fixedRunData = await fixedRun.json() as { data: { runId: string } }
    const fixedAnswer = await waitForAnswer(fixedRunData.data.runId)
    expect(JSON.stringify(fixedAnswer['data'])).toContain('operating_hours')
    expect(modelRequests).toHaveLength(0)

    const componentResponse = await request('/api/v1/components')
    const componentBody = await componentResponse.json() as {
      data: { components: { manifest: { kind: string }; manifestRef: VersionRef }[] }
    }
    const generationComponent = componentBody.data.components.find((entry) => entry.manifest.kind === 'generation')
    const decisionComponent = componentBody.data.components.find((entry) => entry.manifest.kind === 'decision')
    if (generationComponent === undefined || decisionComponent === undefined) throw new Error('configured model components were not registered')

    const modelProfileRef = { id: industrialScenario.profileRef.id, version: '1.0.1' }
    const modelProfileSpec: ProfileSpec = {
      ...industrialScenario.baseProfileSpec,
      modelBindings: {
        generation: { role: 'generation', modelRef: generationComponent.manifestRef, fallbackPolicy: 'clarify', enabled: true },
        decision: { role: 'decision', modelRef: decisionComponent.manifestRef, fallbackPolicy: 'clarify', enabled: true },
      },
      toolBindings: industrialScenario.baseProfileSpec.toolBindings.map((binding) => binding.toolId === 'data_query'
        ? { ...binding, enabled: true, maxCallsPerRun: 1 }
        : binding),
    }
    const profilePublish = await request('/api/v1/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-template-plan-model-profile' },
      body: JSON.stringify({ profileRef: modelProfileRef, spec: modelProfileSpec, environment: 'local_dev' }),
    })
    expect(profilePublish.status).toBe(201)
    const preflight = await request(`/api/v1/profiles/${encodeURIComponent(modelProfileRef.id)}/preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: modelProfileRef.version }),
    })
    expect(preflight.status).toBe(200)
    const preflightBody = await preflight.json() as { data: { status: string; resolvedProfile?: { snapshotHash: string } } }
    expect(preflightBody.data.status).toBe('resolved')
    const snapshotHash = preflightBody.data.resolvedProfile?.snapshotHash
    if (snapshotHash === undefined) throw new Error('the model profile did not resolve')
    const currentProfile = await request(`/api/v1/profiles/${encodeURIComponent(modelProfileRef.id)}/active`)
      .then((response) => response.json()) as { data: { active?: { revision: string } } }
    if (currentProfile.data.active === undefined) throw new Error('the base profile activation is missing')
    const activated = await request(`/api/v1/profiles/${encodeURIComponent(modelProfileRef.id)}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': currentProfile.data.active.revision },
      body: JSON.stringify({ version: modelProfileRef.version, snapshotHash }),
    })
    expect(activated.status).toBe(200)
    const activatedDeployment = await request('/api/v1/core/deployment').then((response) => response.json()) as {
      data: { scenarios: { scenarioId: string; models: { generation: boolean; decision: boolean } }[] }
    }
    expect(activatedDeployment.data.scenarios.find((entry) => entry.scenarioId === 'industrial-asset-maintenance')?.models)
      .toEqual({ generation: true, decision: true })

    const question = 'Should we query operating hours or maintenance exemption for I-04?'
    const createdRun = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-template-plan-clarification' },
      body: JSON.stringify({
        profileRef: modelProfileRef,
        question,
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(createdRun.status).toBe(202)
    const created = await createdRun.json() as { data: { runId: string } }
    const waiting = await waitForRunState(created.data.runId, ['awaiting_input', 'failed'])
    expect(waiting['state']).toBe('awaiting_input')
    const clarificationId = waiting['pendingClarificationId']
    const revision = waiting['revision']
    if (typeof clarificationId !== 'string' || typeof revision !== 'string') throw new Error('the route clarification lacks its durable id/revision')
    expect(modelRequests.map((entry) => entry.path)).toEqual(['/v1/systemone'])
    const jevState = modelRequests[0]?.body['state']
    expect(isRecord(jevState)).toBe(true)
    if (!isRecord(jevState)) throw new Error('JEV did not receive the archived actual route state')
    expect(jevState['kind']).toBe('core_run_route_decision')
    expect(jevState['question']).toBe(question)
    expect(jevState['runId']).toBe(created.data.runId)
    expect(isRecord(jevState['confirmedSchema'])).toBe(true)

    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const decisionRefs = await admin.query<{ run_id: string; state_ref: { id: string; version: string; digest: string; kind: string } }>(
      `SELECT run_id, state_ref
         FROM agent_platform.decision_state_refs
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, created.data.runId],
    )
    expect(decisionRefs.rows).toHaveLength(2)
    expect(decisionRefs.rows[0]?.state_ref.kind).toBe('artifact')
    const clarificationReceipts = await admin.query<{ receipt_payload: { kind: string; route: { route: string } }; receipt_id: string }>(
      `SELECT receipt_id, receipt_payload
         FROM agent_platform.core_plan_receipts
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, created.data.runId],
    )
    expect(clarificationReceipts.rows).toHaveLength(1)
    expect(clarificationReceipts.rows[0]?.receipt_payload.kind).toBe('clarification')
    expect(clarificationReceipts.rows[0]?.receipt_payload.route.route).toBe('clarify')

    const response = await request(`/api/v1/runs/${encodeURIComponent(created.data.runId)}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': revision },
      body: JSON.stringify({ clarificationId, typedResponse: { answer: 'Use operating hours for I-04.' } }),
    })
    expect(response.status).toBe(200)
    const terminal = await waitForRunState(created.data.runId, ['failed', 'published', 'blocked'])
    expect(terminal['state']).toBe('published')
    if (modelRequests.length !== 2) {
      const events = await request(`/api/v1/runs/${encodeURIComponent(created.data.runId)}/events`).then((result) => result.text())
      const errors = workerErrors.map((error) => error.stack ?? error.message).join('\n')
      throw new Error(`expected one JEV and one Company planner call; run=${JSON.stringify(terminal)}; events=${events}; workerErrors=${errors}`)
    }
    expect(modelRequests.map((entry) => entry.path)).toEqual(['/v1/systemone', '/v1/chat/completions'])
    const companyMessages = modelRequests[1]?.body['messages']
    const companyMessageText = Array.isArray(companyMessages)
      ? companyMessages.filter(isRecord).map((message) => typeof message['content'] === 'string' ? message['content'] : '').join('\n')
      : ''
    expect(companyMessageText).toContain('<route_clarification_response untrusted="true">')
    expect(companyMessageText).toContain('Use operating hours for I-04.')

    const planReceipts = await admin.query<{ receipt_payload: { kind: string; route: { route: string; signals: { routeAmbiguous?: boolean } }; steps?: { toolId: string; args: { source?: { value?: unknown } }[] }[] } }>(
      `SELECT receipt_payload
         FROM agent_platform.core_plan_receipts
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3
        ORDER BY created_at`,
      [scopeRef.tenantId, scopeRef.spaceId, created.data.runId],
    )
    expect(planReceipts.rows).toHaveLength(2)
    const executableReceipt = planReceipts.rows.find((row) => row.receipt_payload.kind === 'plan')
    expect(executableReceipt?.receipt_payload.route.route).toBe('small_plan')
    expect(executableReceipt?.receipt_payload.route.signals).toEqual({})
    expect(executableReceipt?.receipt_payload.steps?.[0]?.toolId).toBe('data_query')

    const runEvents = await request(`/api/v1/runs/${encodeURIComponent(created.data.runId)}/events`).then((response) => response.text())
    expect(runEvents).toContain('data_query')
    // The previously-failing WIP chain (route clarification -> bounded compiled query) now ends
    // in a visible, verified answer drawn from the real data_query evidence — no manual controller
    // start and no silent downgrade to a definitions lookup.
    const answer = await request(`/api/v1/runs/${encodeURIComponent(created.data.runId)}/answer`)
    expect(answer.status).toBe(200)
    const answerData = (await answer.json() as {
      data: { body?: { claims?: { references: { evidenceRef: { id: string } }[] }[]; assertions?: { references: { evidenceRef: { id: string } }[] }[] } }
    }).data
    const statements = [
      ...(answerData.body?.claims ?? []),
      ...(answerData.body?.assertions ?? []),
    ]
    expect(statements.length).toBeGreaterThan(0)
    expect(statements.every((statement) => statement.references.length > 0)).toBe(true)
    const citedEvidenceId = statements[0]?.references[0]?.evidenceRef.id
    if (citedEvidenceId === undefined) throw new Error('the compiled-query answer has no evidence reference')
    expect((await request(`/api/v1/evidence/${encodeURIComponent(citedEvidenceId)}`)).status).toBe(200)

    const runManifest = await admin.query<{ ledger_id: string }>(
      `SELECT manifest->>'budgetLedgerId' AS ledger_id
         FROM agent_platform.workflow_run_manifests
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, created.data.runId],
    )
    const ledgerId = runManifest.rows[0]?.ledger_id
    if (ledgerId === undefined) throw new Error('the run did not open its one shared ledger')
    const modelReservations = await admin.query<{ count: string; actual_tokens: string }>(
      `SELECT count(*)::text AS count, COALESCE(sum(actual_model_tokens), 0)::text AS actual_tokens
         FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3 AND actual_model_tokens > 0`,
      [scopeRef.tenantId, scopeRef.spaceId, ledgerId],
    )
    expect(modelReservations.rows[0]?.count).toBe('2')
    expect(Number(modelReservations.rows[0]?.actual_tokens)).toBeGreaterThan(0)
    const modelEvidence = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.evidence_records
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND kind = 'model_output'`,
      [scopeRef.tenantId, scopeRef.spaceId, created.data.runId],
    )
    expect(modelEvidence.rows[0]?.count).toBe('2')
    const dataEvidence = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM agent_platform.evidence_records
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3
          AND kind = 'observation' AND data_mode = 'synthetic'`,
      [scopeRef.tenantId, scopeRef.spaceId, created.data.runId],
    )
    expect(Number(dataEvidence.rows[0]?.count)).toBeGreaterThan(0)

    const ordinaryRun = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-template-plan-ordinary-no-jev' },
      body: JSON.stringify({
        profileRef: modelProfileRef,
        question: 'List operating hours for asset I-04.',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(ordinaryRun.status).toBe(202)
    const ordinaryRunData = await ordinaryRun.json() as { data: { runId: string } }
    expect((await waitForRunState(ordinaryRunData.data.runId, ['failed', 'published', 'blocked']))['state']).toBe('published')
    expect(modelRequests.map((entry) => entry.path)).toEqual([
      '/v1/systemone',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ])
  }, 180_000)
})
