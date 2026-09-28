import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import { createCoreApi } from '@ontology/app-api'
import { loadCoreExamples } from '@ontology/app-api'
import { createCoreLocalComposition } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import type { ScopeRef } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_ROLE = 'ontology_app'
const APP_PASSWORD = `coretest_${randomUUID().replaceAll('-', '')}`

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
const workerErrors: Error[] = []
let persistedAnswerRunId: string | undefined
let persistedAnswerPayload: string | undefined
let persistedEvidenceId: string | undefined

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `core-host-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Core host integration'])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = APP_ROLE
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 20_000
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

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 30_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return await response.json() as Record<string, unknown>
    if (response.status !== 202) {
      const errorText = await response.text()
      const run = await request(`/api/v1/runs/${runId}`).then((result) => result.text())
      const events = await request(`/api/v1/runs/${runId}/events`).then((result) => result.text())
      const causes = workerErrors.map((error) => `${error.name}: ${error.message}`).join('\n')
      throw new Error(`answer route failed with ${String(response.status)}: ${errorText}; run=${run}; events=${events}; workerErrors=${causes}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the test deadline`)
}

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-host-'))
  const examples = loadCoreExamples({ targetScopeRef: scopeRef })
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples,
    allowLocalOperator: true,
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
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('the mounted local Core host through normal HTTP', () => {
  it('ingests real raw records, requires identity/review/publication, then publishes a verified facts answer', async () => {
    const health = await request('/healthz')
    expect(health.status).toBe(200)

    const componentList = await request('/api/v1/components')
    expect(componentList.status).toBe(200)
    expect(((await componentList.json() as { data: { components: unknown[] } }).data.components).length).toBeGreaterThan(0)
    const sourceList = await request('/api/v1/sources')
    expect(sourceList.status).toBe(200)
    expect((await sourceList.json() as { data: { sources: unknown[] } }).data.sources).toEqual([])

    const deploymentResponse = await request('/api/v1/core/deployment')
    expect(deploymentResponse.status).toBe(200)
    const deployment = await deploymentResponse.json() as {
      data: {
        scenarios: {
          scenarioId: string
          availableTasks: string[]
          profileRef: { id: string; version: string }
          namespace: string
          environment: string
          baseProfileSpec?: {
            industryRef: { id: string }
            mappingRefs: { id: string; sourceObjectRef: { objectPath: string } }[]
            backendBindings: Record<string, unknown>
          }
        }[]
      }
    }
    const scenario = deployment.data.scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    expect(scenario?.availableTasks).toContain('facts:inspection_due')
    expect(scenario?.environment).toBe('local_dev')
    expect(scenario?.baseProfileSpec?.industryRef.id).toBe('synthetic-transport-facility')
    expect(scenario?.baseProfileSpec?.mappingRefs[0]?.sourceObjectRef.objectPath).toBe('demo.registry_a_facilities')
    if (scenario?.baseProfileSpec === undefined) throw new Error('Core deployment did not expose the registered base profile spec')
    const activeProfileResponse = await request(`/api/v1/profiles/${encodeURIComponent(scenario.profileRef.id)}/active`)
    expect(activeProfileResponse.status).toBe(200)
    const initialActive = await activeProfileResponse.json() as { data: { active: { profileRef: { version: string }; revision: string } } }
    expect(initialActive.data.active.profileRef.version).toBe('1.0.0')

    const initialScope = await request(`/api/v1/runs/scope?profileId=${encodeURIComponent(scenario.profileRef.id)}&version=${encodeURIComponent(scenario.profileRef.version)}`)
    expect(initialScope.status).toBe(200)
    expect((await initialScope.json() as { data: { toolIds: string[] } }).data.toolIds).toContain('ontology_lookup')

    const nextProfileRef = { id: scenario.profileRef.id, version: '1.0.1' }
    const profilePublish = await request('/api/v1/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-profile-publish-transport-v101' },
      body: JSON.stringify({ profileRef: nextProfileRef, spec: scenario.baseProfileSpec, environment: scenario.environment }),
    })
    expect(profilePublish.status).toBe(201)
    const nextPreflight = await request(`/api/v1/profiles/${encodeURIComponent(nextProfileRef.id)}/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: nextProfileRef.version }),
    })
    expect(nextPreflight.status).toBe(200)
    const preflightResult = await nextPreflight.json() as { data: { status: string; resolvedProfile?: { snapshotHash: string } } }
    expect(preflightResult.data.status).toBe('resolved')
    const snapshotHash = preflightResult.data.resolvedProfile?.snapshotHash
    if (snapshotHash === undefined) throw new Error('new profile preflight did not resolve a snapshot')
    if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
    const activeRevisionRows = await admin.query<{ revision: string }>(
      'SELECT revision::text AS revision FROM agent_platform.active_profiles WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3',
      [scopeRef.tenantId, scopeRef.spaceId, nextProfileRef.id],
    )
    const activeRevision = activeRevisionRows.rows[0]?.revision
    if (activeRevision === undefined) throw new Error('Core bootstrap did not activate the base profile')
    const activated = await request(`/api/v1/profiles/${encodeURIComponent(nextProfileRef.id)}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': activeRevision },
      body: JSON.stringify({ version: nextProfileRef.version, snapshotHash }),
    })
    expect(activated.status).toBe(200)
    const activatedProfile = await activated.json() as { data: { profileRef: { version: string }; revision: string } }
    expect(activatedProfile.data.profileRef.version).toBe('1.0.1')
    const refreshedActive = await request(`/api/v1/profiles/${encodeURIComponent(nextProfileRef.id)}/active`)
    expect((await refreshedActive.json() as { data: { active: { profileRef: { version: string } } } }).data.active.profileRef.version).toBe('1.0.1')
    const refreshedDeployment = await request('/api/v1/core/deployment').then((response) => response.json()) as {
      data: { scenarios: { scenarioId: string; profileRef: { version: string }; availableTasks: string[] }[] }
    }
    const refreshedScenario = refreshedDeployment.data.scenarios.find((entry) => entry.scenarioId === scenario.scenarioId)
    expect(refreshedScenario?.profileRef.version).toBe('1.0.1')
    expect(refreshedScenario?.availableTasks).toContain('facts:inspection_due')
    const upgradedScope = await request(`/api/v1/runs/scope?profileId=${encodeURIComponent(nextProfileRef.id)}&version=${encodeURIComponent(nextProfileRef.version)}`)
    expect(upgradedScope.status).toBe(200)

    const transport = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    if (transport === undefined) throw new Error('transport synthetic scenario was not mounted')
    const registry = transport.rawSources.find((entry) => entry.sourceRef.sourceId === 'registry-a')
    if (registry === undefined) throw new Error('transport registry source was not mounted')
    const unsupportedTextImport = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-disabled-model-text' },
      body: JSON.stringify({
        scenarioId: transport.scenarioId,
        sourceId: registry.sourceRef.sourceId,
        content: '{"text":"T-X-01 needs an inspection"}',
      }),
    })
    expect(unsupportedTextImport.status).toBe(409)
    expect((await unsupportedTextImport.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
    const unsupportedPlainTextImport = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-disabled-model-plain-text' },
      body: JSON.stringify({
        scenarioId: transport.scenarioId,
        sourceId: registry.sourceRef.sourceId,
        content: 'T-PLAIN-01 is a facility that needs an inspection.',
      }),
    })
    expect(unsupportedPlainTextImport.status).toBe(409)
    expect((await unsupportedPlainTextImport.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
    const rawContent = await readFile(registry.path, 'utf8')
    const importResponse = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-transport-registry-a' },
      body: JSON.stringify({ scenarioId: transport.scenarioId, sourceId: registry.sourceRef.sourceId, content: rawContent }),
    })
    expect(importResponse.status).toBe(202)
    const importBody = await importResponse.json() as { data: { jobId: string } }
    const job = await waitForJob(importBody.data.jobId)
    expect(job['stage']).toBe('awaiting_review')
    expect((job['counts'] as { processed: number }).processed).toBeGreaterThan(0)

    const candidateListResponse = await request(`/api/v1/candidates?jobId=${encodeURIComponent(importBody.data.jobId)}&kind=entity`)
    expect(candidateListResponse.status).toBe(200)
    const candidatesBody = await candidateListResponse.json() as { data: { candidates: { candidateId: string }[] } }
    expect(candidatesBody.data.candidates.length).toBeGreaterThan(0)
    let target: { candidateId: string } | undefined
    for (const summary of candidatesBody.data.candidates) {
      const detailResponse = await request(`/api/v1/candidates/${summary.candidateId}`)
      const detail = await detailResponse.json() as { data: { candidate: { nativeId?: string; attributes?: { attributeId: string; value: unknown }[]; decisionRevision: string } } }
      if (detail.data.candidate.nativeId === 'T-04') target = { candidateId: summary.candidateId }
    }
    if (target === undefined) throw new Error('native T-04 candidate was not produced by the real parser/extraction pipeline')

    const decision = await request(`/api/v1/candidates/${target.candidateId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ kind: 'create_pending', justification: 'operator reviewed this synthetic native identifier' }),
    })
    expect(decision.status).toBe(200)
    const pendingIdentity = await decision.json() as { data: { targetEntityId?: string } }
    if (pendingIdentity.data.targetEntityId === undefined) throw new Error('identity create_pending did not return an entity reference')
    const match = await request(`/api/v1/candidates/${target.candidateId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({
        kind: 'match',
        targetEntityId: pendingIdentity.data.targetEntityId,
        strongIdentity: { kind: 'native_id', value: 'T-04' },
      }),
    })
    expect(match.status).toBe(200)
    const review = await request(`/api/v1/candidates/${target.candidateId}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ decision: 'approve', reason: 'source-backed synthetic record reviewed by operator' }),
    })
    expect(review.status).toBe(200)

    const publication = await request('/api/v1/semantic-publications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0', 'idempotency-key': 'core-transport-publish-t04' },
      body: JSON.stringify({
        approvedCandidateRefs: [{ candidateId: target.candidateId, kind: 'entity' }],
        schemaRef: transport.definitionRef,
      }),
    })
    if (publication.status !== 201) {
      throw new Error(`semantic publication failed with ${String(publication.status)}: ${await publication.text()}`)
    }

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-transport-facts-t04' },
      body: JSON.stringify({
        profileRef: nextProfileRef,
        question: 'facts:inspection_due',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(runResponse.status).toBe(202)
    const runBody = await runResponse.json() as { data: { runId: string } }
    const answerResponse = await waitForAnswer(runBody.data.runId)
    persistedAnswerRunId = runBody.data.runId
    persistedAnswerPayload = JSON.stringify(answerResponse['data'])
    const answer = answerResponse['data'] as { body?: { assertions: { predicate: string; value: unknown; subject?: string; references: { evidenceRef: { id: string } }[] }[] }; semanticReview?: { status: string; reason?: string } }
    expect(answer.body?.assertions).toContainEqual(expect.objectContaining({ predicate: 'inspection_due', value: false }))
    const assertion = answer.body?.assertions.find((entry) => entry.predicate === 'inspection_due')
    expect(assertion?.references[0]?.evidenceRef.id).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(answer.semanticReview).toEqual({ status: 'not_run', reason: 'disabled' })
    if (assertion === undefined || assertion.references[0] === undefined) throw new Error('verified inspection fact has no evidence reference')
    persistedEvidenceId = assertion.references[0].evidenceRef.id
    const evidenceResponse = await request(`/api/v1/evidence/${encodeURIComponent(assertion.references[0].evidenceRef.id)}`)
    expect(evidenceResponse.status).toBe(200)
    if (assertion.subject !== undefined) {
      const historyResponse = await request(`/api/v1/objects/${encodeURIComponent(assertion.subject)}/history`)
      expect(historyResponse.status).toBe(200)
    }
  }, 120_000)

  it('does not create or dispatch an unregistered natural-language task', async () => {
    const response = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-unknown-question' },
      body: JSON.stringify({
        profileRef: { id: 'synthetic-transport-facility-demo', version: '1.0.0' },
        question: 'Which facilities should be inspected?',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('CAPABILITY_NOT_CONFIGURED')
  })

  it('reuses the same HTTP ingestion and verified facts workflow for the industrial scenario', async () => {
    const industrial = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === 'industrial-asset-maintenance')
    if (industrial === undefined) throw new Error('industrial synthetic scenario was not mounted')
    const source = industrial.rawSources.find((entry) => entry.sourceRef.sourceId === 'asset-hours-canonical')
    if (source === undefined) throw new Error('industrial canonical source was not mounted')
    const importResponse = await request('/api/v1/core/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-industrial-canonical' },
      body: JSON.stringify({
        scenarioId: industrial.scenarioId,
        sourceId: source.sourceRef.sourceId,
        content: await readFile(source.path, 'utf8'),
      }),
    })
    expect(importResponse.status).toBe(202)
    const importBody = await importResponse.json() as { data: { jobId: string } }
    expect((await waitForJob(importBody.data.jobId))['stage']).toBe('awaiting_review')

    const list = await request(`/api/v1/candidates?jobId=${encodeURIComponent(importBody.data.jobId)}&kind=entity`)
    const listBody = await list.json() as { data: { candidates: { candidateId: string }[] } }
    let targetId: string | undefined
    for (const item of listBody.data.candidates) {
      const detail = await request(`/api/v1/candidates/${item.candidateId}`).then((response) => response.json()) as {
        data: { candidate: { nativeId?: string } }
      }
      if (detail.data.candidate.nativeId === 'I-04') targetId = item.candidateId
    }
    if (targetId === undefined) throw new Error('industrial I-04 candidate was not produced by the real native pipeline')

    const pendingResponse = await request(`/api/v1/candidates/${targetId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ kind: 'create_pending', justification: 'operator reviewed the industrial native identifier' }),
    })
    const pending = await pendingResponse.json() as { data: { targetEntityId?: string } }
    if (pending.data.targetEntityId === undefined) throw new Error('industrial identity create_pending returned no entity')
    const matched = await request(`/api/v1/candidates/${targetId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '1' },
      body: JSON.stringify({ kind: 'match', targetEntityId: pending.data.targetEntityId, strongIdentity: { kind: 'native_id', value: 'I-04' } }),
    })
    expect(matched.status).toBe(200)
    const review = await request(`/api/v1/candidates/${targetId}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ decision: 'approve', reason: 'canonical hours record reviewed by operator' }),
    })
    expect(review.status).toBe(200)
    const publication = await request('/api/v1/semantic-publications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '1', 'idempotency-key': 'core-industrial-publish-i04' },
      body: JSON.stringify({ approvedCandidateRefs: [{ candidateId: targetId, kind: 'entity' }], schemaRef: industrial.definitionRef }),
    })
    if (publication.status !== 201) throw new Error(`industrial semantic publication failed: ${await publication.text()}`)

    const createdRun = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-industrial-facts-i04' },
      body: JSON.stringify({
        profileRef: industrial.profileRef,
        question: 'facts:operating_hours',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(createdRun.status).toBe(202)
    const createdBody = await createdRun.json() as { data: { runId: string } }
    const response = await waitForAnswer(createdBody.data.runId)
    const answer = response['data'] as {
      body?: { claims: { predicate: string; subject: string; value: { value: string | number; unit: string }; references: { evidenceRef: { id: string } }[] }[] }
    }
    expect(answer.body?.claims).toContainEqual(expect.objectContaining({ predicate: 'operating_hours', value: { value: '100', unit: 'h' } }))
    expect(answer.body?.claims[0]?.references[0]?.evidenceRef.id).toMatch(/^[0-9a-f-]{36}$/iu)
  }, 120_000)

  it('keeps the active profile version and its published answer available after a host restart', async () => {
    await api?.close()
    api = undefined
    await composition?.close()
    composition = undefined

    composition = await createCoreLocalComposition({
      databaseUrl: appUrl,
      objectDirectory,
      scopeRef,
      examples: loadCoreExamples({ targetScopeRef: scopeRef }),
      allowLocalOperator: true,
    })
    api = createCoreApi(composition.dependencies)
    const address = await api.listen({ host: '127.0.0.1', port: 0 })
    baseUrl = address.replace(/\/$/u, '')

    const deployment = await request('/api/v1/core/deployment').then((response) => response.json()) as {
      data: { scenarios: { scenarioId: string; profileRef: { id: string; version: string } }[] }
    }
    const scenario = deployment.data.scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
    expect(scenario?.profileRef.version).toBe('1.0.1')
    if (persistedAnswerRunId === undefined || persistedAnswerPayload === undefined || persistedEvidenceId === undefined) {
      throw new Error('the first transport run was not retained for restart verification')
    }
    const previousAnswer = await request(`/api/v1/runs/${encodeURIComponent(persistedAnswerRunId)}/answer`)
    expect(previousAnswer.status).toBe(200)
    expect(JSON.stringify((await previousAnswer.json() as { data: unknown }).data)).toBe(persistedAnswerPayload)
    const previousEvidence = await request(`/api/v1/evidence/${encodeURIComponent(persistedEvidenceId)}`)
    expect(previousEvidence.status).toBe(200)
    const scopeResponse = await request(`/api/v1/runs/scope?profileId=${encodeURIComponent(scenario?.profileRef.id ?? '')}&version=1.0.1`)
    expect(scopeResponse.status).toBe(200)

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'core-transport-restart-facts-v101' },
      body: JSON.stringify({
        profileRef: scenario?.profileRef,
        question: 'facts:inspection_due',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
      }),
    })
    expect(runResponse.status).toBe(202)
    const run = await runResponse.json() as { data: { runId: string } }
    const answer = await waitForAnswer(run.data.runId)
    expect(((answer['data'] as { body?: { assertions: { predicate: string; value: unknown }[] } }).body?.assertions ?? []))
      .toContainEqual(expect.objectContaining({ predicate: 'inspection_due', value: false }))
  }, 180_000)
})
