import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `pitest_${randomUUID().replaceAll('-', '')}`
const MODEL_SECRET = 'test-only-controlled-pi-secret'
const GENERATION_MODEL_ID = 'core-company-planner'

/**
 * V03-038 / #209 — the real Pi runtime assembled at the normal Core entry.
 *
 * This suite is the acceptance path for A.US-013.AC-01/AC-03: a run submitted to the normal
 * HTTP surface `POST /api/v1/runs` is dispatched by the real durable worker into the real
 * `WorkflowController`, which selects the registered `runtime-pi` adapter from the run's
 * resolved profile. Pi drives a bounded "query insufficient → supplement → complete"
 * collection loop through the same single gateway, resolved profile and budget ledger every
 * other runtime uses, then the controller drafts, verifies and publishes only the verified
 * version. The only substitute is the model transport: a controlled HTTP model server emits
 * scripted tool-call proposals (controlled model responses), so no paid provider is called.
 * Generation and JEV are separate ports; JEV is disabled and Pi never needs it.
 */

interface ModelTurn {
  readonly toolCalls: readonly {
    readonly callId: string
    readonly toolId: string
    readonly arguments: Readonly<Record<string, unknown>>
  }[]
}

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
let modelRequestCount = 0
const workerErrors: Error[] = []

function scopeArgument(): { tenantId: string; spaceId: string } {
  return { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }
}

/**
 * A deterministic, stateful OpenAI-compatible stream. Turn 1 asks for a definitions lookup
 * (useful context but not a fact-backed answer → "query insufficient"); turn 2 asks for the
 * supplementary published-fact lookup that supplies the exact `inspection_due` values; any
 * later turn stops with no tool call, so the loop completes. Tool arguments are the untrusted
 * model proposal; the real gateway still authorizes and executes every one.
 */
function modelTurns(): readonly ModelTurn[] {
  const scope = scopeArgument()
  return [
    {
      toolCalls: [
        {
          callId: 'call_definitions',
          toolId: 'ontology_lookup',
          arguments: { scopeRef: scope, intent: 'definitions' },
        },
      ],
    },
    {
      toolCalls: [
        {
          callId: 'call_facts',
          toolId: 'ontology_lookup',
          arguments: {
            scopeRef: scope,
            intent: 'facts',
            concepts: [{ namespace: 'synthetic-transport-facility', conceptId: 'inspection_due' }],
          },
        },
      ],
    },
    { toolCalls: [] },
  ]
}

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // The request body is not needed: the turn is chosen by call order, not by content.
      void _chunk
    }
    const turns = modelTurns()
    const turn = turns[Math.min(modelRequestCount, turns.length - 1)] ?? { toolCalls: [] }
    modelRequestCount += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: 'chatcmpl-core-pi', object: 'chat.completion.chunk', created: 1, model: 'synthetic-vendor-planner' }
    for (const call of turn.toolCalls) {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.callId, type: 'function', function: { name: call.toolId, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }], usage: null })}\n\n`)
    }
    const finishReason = turn.toolCalls.length > 0 ? 'tool_calls' : 'stop'
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: null })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`)
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
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `core-pi-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Core Pi host integration'])
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
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 30_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/jobs/${jobId}`)
    if (!response.ok) throw new Error(`GET job failed with ${String(response.status)}: ${await response.text()}`)
    const body = await response.json() as { data: Record<string, unknown> }
    const stage = body.data['stage']
    if (stage === 'awaiting_review' || stage === 'failed') return body.data
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`job ${jobId} did not reach awaiting_review before the test deadline`)
}

async function waitForPublishedEvent(runId: string): Promise<string[]> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  const endAt = Date.now() + 10_000
  let types: string[] = []
  while (Date.now() < endAt) {
    const rows = await admin.query<{ sse_type: string }>(
      `SELECT sse_type FROM agent_platform.run_events
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 ORDER BY sequence`,
      [scopeRef.tenantId, scopeRef.spaceId, runId],
    )
    types = rows.rows.map((row) => row.sse_type)
    if (types.includes('answer.published')) return types
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return types
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return await response.json() as Record<string, unknown>
    if (response.status !== 202) {
      const errorText = await response.text()
      const run = await request(`/api/v1/runs/${runId}`).then((result) => result.text())
      const causes = workerErrors.map((error) => error.stack ?? `${error.name}: ${error.message}`).join('\n')
      throw new Error(`answer route failed with ${String(response.status)}: ${errorText}; run=${run}; workerErrors=${causes}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the test deadline`)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  modelServerUrl = await startControlledModelServer()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-pi-host-'))
  const modelEnvironment = {
    CORE_ENABLE_MODELS: 'true',
    CORE_COMPANY_MODEL_BASE_URL: modelServerUrl,
    CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
    CORE_COMPANY_MODEL_API_KEY: MODEL_SECRET,
    CORE_COMPANY_MODEL_PLATFORM_ID: GENERATION_MODEL_ID,
    CORE_COMPANY_MODEL_VENDOR_MODEL: 'synthetic-vendor-planner',
    CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
  }
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: true,
    jevEnabled: false,
    modelEnvironment,
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

describe('the Pi runtime assembled at the normal Core entry', () => {
  it('registers both real runtimes and dispatches a Pi profile through the normal HTTP run surface', async () => {
    const componentList = await request('/api/v1/components').then((response) => response.json()) as {
      data: { components: { manifest: { kind: string; id: string; version: string; digest: string } }[] }
    }
    const runtimeIds = componentList.data.components
      .filter((record) => record.manifest.kind === 'runtime')
      .map((record) => record.manifest.id)
    expect(runtimeIds).toContain('runtime-template')
    expect(runtimeIds).toContain('runtime-pi')
    const generation = componentList.data.components.find((record) => record.manifest.kind === 'generation')
    if (generation === undefined) throw new Error('the Core generation component is not registered')
    const piRuntime = componentList.data.components.find((record) => record.manifest.kind === 'runtime' && record.manifest.id === 'runtime-pi')
    if (piRuntime === undefined) throw new Error('the Core Pi runtime component is not registered')

    const deployment = await request('/api/v1/core/deployment').then((response) => response.json()) as {
      data: { scenarios: { scenarioId: string; baseProfileSpec?: Record<string, unknown>; profileRef: { id: string; version: string } }[] }
    }
    const transport = deployment.data.scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    if (transport === undefined || transport.baseProfileSpec === undefined) throw new Error('the transport base profile spec is not exposed')

    const transportScenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    if (transportScenario === undefined) throw new Error('the transport synthetic scenario is not mounted')
    const registry = transportScenario.rawSources.find((entry) => entry.sourceRef.sourceId === 'registry-a')
    if (registry === undefined) throw new Error('the transport registry source is not mounted')

    // Publish a real entity so the Pi lookup has source-backed published facts to supplement.
    const importResponse = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-pi-import-registry-a' },
      body: JSON.stringify({ scenarioId: transportScenario.scenarioId, sourceId: registry.sourceRef.sourceId, content: await readFile(registry.path, 'utf8') }),
    })
    expect(importResponse.status).toBe(202)
    const importBody = await importResponse.json() as { data: { jobId: string } }
    expect((await waitForJob(importBody.data.jobId))['stage']).toBe('awaiting_review')

    const candidateList = await request(`/api/v1/candidates?jobId=${encodeURIComponent(importBody.data.jobId)}&kind=entity`).then((response) => response.json()) as {
      data: { candidates: { candidateId: string }[] }
    }
    let targetId: string | undefined
    for (const candidate of candidateList.data.candidates) {
      const detail = await request(`/api/v1/candidates/${candidate.candidateId}`).then((response) => response.json()) as {
        data: { candidate: { nativeId?: string } }
      }
      if (detail.data.candidate.nativeId === 'T-04') targetId = candidate.candidateId
    }
    if (targetId === undefined) throw new Error('T-04 candidate was not produced by the real pipeline')
    const pending = await request(`/api/v1/candidates/${targetId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ kind: 'create_pending', justification: 'operator reviewed the synthetic native identifier' }),
    }).then((response) => response.json()) as { data: { targetEntityId?: string } }
    if (pending.data.targetEntityId === undefined) throw new Error('identity create_pending returned no entity')
    const matched = await request(`/api/v1/candidates/${targetId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({ kind: 'match', targetEntityId: pending.data.targetEntityId, strongIdentity: { kind: 'native_id', value: 'T-04' } }),
    })
    expect(matched.status).toBe(200)
    const reviewed = await request(`/api/v1/candidates/${targetId}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ decision: 'approve', reason: 'source-backed synthetic record reviewed by operator' }),
    })
    expect(reviewed.status).toBe(200)
    const publishedOk = await request('/api/v1/semantic-publications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0', 'idempotency-key': 'core-pi-publish-t04' },
      body: JSON.stringify({ approvedCandidateRefs: [{ candidateId: targetId, kind: 'entity' }], schemaRef: transportScenario.definitionRef }),
    })
    if (publishedOk.status !== 201) throw new Error(`semantic publication failed: ${await publishedOk.text()}`)

    // Publish a profile whose runtime is the real Pi adapter and whose generation model is the
    // registered Core generation component. JEV is deliberately not bound anywhere.
    const piProfileRef = { id: transportScenario.profileRef.id, version: '1.1.0' }
    const piSpec = {
      ...transport.baseProfileSpec,
      runtimeRef: { id: piRuntime.manifest.id, version: piRuntime.manifest.version, digest: piRuntime.manifest.digest },
      modelBindings: {
        generation: {
          role: 'generation',
          modelRef: { id: generation.manifest.id, version: generation.manifest.version, digest: generation.manifest.digest },
          fallbackPolicy: 'reject',
          enabled: true,
          contextLimitTokens: 32000,
          outputLimitTokens: 4000,
        },
      },
      toolBindings: [
        { toolId: 'ontology_lookup', enabled: true, maxCallsPerRun: 4 },
        { toolId: 'data_query', enabled: true, maxCallsPerRun: 4 },
        { toolId: 'document_search', enabled: true, maxCallsPerRun: 4 },
        { toolId: 'web_search', enabled: false },
      ],
    }
    const profilePublish = await request('/api/v1/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-pi-profile-v110' },
      body: JSON.stringify({ profileRef: piProfileRef, spec: piSpec, environment: 'local_dev' }),
    })
    if (profilePublish.status !== 201) throw new Error(`Pi profile publish failed: ${await profilePublish.text()}`)
    const preflight = await request(`/api/v1/profiles/${encodeURIComponent(piProfileRef.id)}/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: piProfileRef.version }),
    }).then((response) => response.json()) as { data: { status: string; resolvedProfile?: { snapshotHash: string } } }
    expect(preflight.data.status).toBe('resolved')
    const snapshotHash = preflight.data.resolvedProfile?.snapshotHash
    if (snapshotHash === undefined) throw new Error('the Pi profile did not resolve')
    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const activeRows = await admin.query<{ revision: string }>(
      'SELECT revision::text AS revision FROM agent_platform.active_profiles WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3',
      [scopeRef.tenantId, scopeRef.spaceId, piProfileRef.id],
    )
    const activeRevision = activeRows.rows[0]?.revision
    if (activeRevision === undefined) throw new Error('the base profile was not activated during bootstrap')
    const activated = await request(`/api/v1/profiles/${encodeURIComponent(piProfileRef.id)}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': activeRevision },
      body: JSON.stringify({ version: piProfileRef.version, snapshotHash }),
    })
    expect(activated.status).toBe(200)

    // The normal HTTP run surface, with normal durable dispatch. No test starts the controller.
    const created = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-pi-bounded-supplement' },
      body: JSON.stringify({
        profileRef: piProfileRef,
        question: 'Which synthetic facilities are due for inspection?',
        context: { timeZone: 'UTC' },
        preferences: { route: 'pi', allowWeb: false },
      }),
    })
    if (created.status !== 202) throw new Error(`run submission failed with ${String(created.status)}: ${await created.text()}`)
    const createdBody = await created.json() as { data: { runId: string } }
    const runId = createdBody.data.runId
    const answerResponse = await waitForAnswer(runId)
    const answer = answerResponse['data'] as {
      body?: { assertions: { predicate: string; value: unknown; references: { evidenceRef: { id: string } }[] }[] }
    }
    expect(answer.body?.assertions).toContainEqual(expect.objectContaining({ predicate: 'inspection_due', value: false }))

    // The answer row is committed by the publisher slightly before the controller appends the
    // public `answer.published` event, so poll briefly for the terminal event to settle.
    const eventTypes = await waitForPublishedEvent(runId)
    expect(eventTypes, JSON.stringify(eventTypes)).toContain('answer.published')
    const runView = await request(`/api/v1/runs/${runId}`).then((response) => response.json()) as { data: { state: string } }
    expect(runView.data.state).toBe('published')
    // Two model-proposed tool calls share one ledger: the definitions probe and the supplementary
    // fact lookup. Neither clarification nor the draft step started a second ledger.
    expect(modelRequestCount).toBeGreaterThanOrEqual(3)

    // Two model-proposed tool observations were collected; the model's own output is archived
    // as `model_output` evidence too, but it is never mistakable for a tool observation.
    const evidenceCount = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.evidence_records
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND kind = 'observation'`,
      [scopeRef.tenantId, scopeRef.spaceId, runId],
    )
    expect(Number(evidenceCount.rows[0]?.count)).toBe(2)

    const ledger = await admin.query<{ ledgers: string; consumed: string }>(
      `SELECT count(*)::text AS ledgers, coalesce(max(tool_calls_consumed), 0)::text AS consumed
         FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [scopeRef.tenantId, scopeRef.spaceId, runId],
    )
    // Exactly one ledger for the run: the supplement round, the model attempts and the bounded
    // draft step all draw from the same monotonic counters (no phase opens or resets a ledger).
    expect(ledger.rows[0]?.ledgers).toBe('1')
    expect(Number(ledger.rows[0]?.consumed)).toBeGreaterThanOrEqual(2)
  }, 180_000)
})
