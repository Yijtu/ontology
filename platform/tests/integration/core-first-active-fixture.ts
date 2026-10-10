import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { createCoreApi, createCoreLocalComposition, createCompetencyQuestionBoundary, loadCoreExamples } from '@ontology/app-api'
import { canonicalJson, contentDigestOf } from '@ontology/application'
import { createToolContext, isRecord, isResourceRef, isVersionRef } from '@ontology/contracts'
import type { ColumnMappingEntry, CompetencyQuestionSetBody, ResolvedProfileRef, ResourceRef, VersionRef } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import { publicationMaterializationBarrier } from './publication-materialization-fixture'

export function actualObject(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error('actual object response missing'); return value }
export function actualText(value: unknown): string { if (typeof value !== 'string' || value === '') throw new Error('actual string response missing'); return value }
export function actualVersion(value: unknown): VersionRef { if (!isVersionRef(value)) throw new Error('actual version pin missing'); return { id: value.id, version: value.version, digest: value.digest } }
export function actualResource(value: unknown): ResourceRef { if (!isResourceRef(value)) throw new Error('actual resource pin missing'); return value }
export function actualArray(value: unknown): readonly unknown[] { if (!Array.isArray(value)) throw new Error('actual array response missing'); return value }
async function mapConcurrent<T, R>(values: readonly T[], width: number, operation: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(width, values.length) }, async () => {
    while (next < values.length) {
      const index = next++, value = values[index]
      if (value === undefined) throw new Error('the bounded fixture worker lost its input')
      result[index] = await operation(value, index)
    }
  })
  const settled = await Promise.allSettled(workers)
  const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
  if (failure !== undefined) throw new Error('a bounded real HTTP review worker failed', { cause: failure.reason })
  return result
}

export interface FirstActivePack { readonly workspaceId: string; readonly packRef: VersionRef; readonly definitionRef: VersionRef; readonly profileRef: ResolvedProfileRef; readonly unitCode: 'h' | 'min' }

export type FirstActiveWorkerPhase = 'fixture_setup' | 'pack_publication' | 'source_import' | 'human_confirmation' | 'facts_publication' | 'outbox_dispatch_wait' | 'evolution' | 'query' | 'teardown'
export interface FirstActiveWorkerError {
  readonly phase: FirstActiveWorkerPhase
  readonly awaitedPublicationOutboxId?: string
  readonly errorType: string
  readonly name: string
  readonly code?: string
  readonly message?: string
  readonly keys: readonly string[]
}

const safeWorkerErrorNames = new Set(['CoreCapabilityError', 'Error', 'IncompletePublishedReadError', 'JobStoreError', 'ProjectError', 'ProjectStoreError', 'SemanticPublicationStoreError', 'TypeError', 'WorkflowControllerError'])
const safeWorkerErrorCodes = new Set(['CAPABILITY_NOT_CONFIGURED', 'INCOMPLETE_PUBLISHED_READ', 'INVALID_ARGUMENT', 'JOB_NOT_FOUND', 'READINESS_CONFLICT', 'REVISION_CONFLICT', 'SOURCE_UNREADABLE', 'VERSION_CONFLICT'])

function firstActiveWorkerError(error: unknown, phase: FirstActiveWorkerPhase, outboxId?: string): FirstActiveWorkerError {
  const readString = (key: 'name' | 'code' | 'message'): string | undefined => {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined
    try {
      const value: unknown = Reflect.get(error, key)
      return typeof value === 'string' ? value.slice(0, key === 'message' ? 240 : 120) : undefined
    } catch { return undefined }
  }
  let keys: string[] = []
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try { keys = Object.keys(error).slice(0, 12).map((key) => key.slice(0, 80)) } catch { keys = ['<keys-unavailable>'] }
  }
  const rawName = readString('name'), rawCode = readString('code')
  const message = readString('message')?.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted]')
    .replace(/(password|api[_-]?key|token)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '[redacted-id]')
    .replace(/sha256:[0-9a-f]{64}/giu, '[redacted-digest]')
    .replace(/\b(?:OLD-A|OLD-B|M-1|staged-only|machine_id|phase_note|hours)\b/giu, '[redacted-value]')
  return {
    phase,
    ...(outboxId === undefined ? {} : { awaitedPublicationOutboxId: outboxId }),
    errorType: typeof error,
    name: rawName !== undefined && safeWorkerErrorNames.has(rawName) ? rawName : 'unknown',
    ...(rawCode !== undefined && safeWorkerErrorCodes.has(rawCode) ? { code: rawCode } : {}),
    ...(message === undefined ? {} : { message: message.slice(0, 160) }),
    keys,
  }
}

function firstActiveWorkerErrorSummary(errors: readonly FirstActiveWorkerError[]) {
  const groups = new Map<string, FirstActiveWorkerError & { count: number }>()
  for (const error of errors) {
    const key = canonicalJson(error), existing = groups.get(key)
    if (existing === undefined) groups.set(key, { ...error, count: 1 })
    else existing.count += 1
  }
  const all = [...groups.values()]
  return { totalCount: errors.length, groups: all.slice(0, 8), unrepresentedCount: all.slice(8).reduce((total, group) => total + group.count, 0), lastSamples: errors.slice(-8) }
}

/** Actual normal Company adapter, HTTP host/worker and real scoped PostgreSQL stores.
 * Only model proposals are controlled; sources, review ledgers, pack/profile refs and inputs
 * are produced by their real services. No expected answer is accepted by this factory. */
export async function startFirstActiveFixture() {
  const harness = await startJobDatabase(), scope = (await createJobScope(harness.adminClient, 'first-active-evolution')).scopeRef
  let proposal: unknown = {}
  const modelCalls: string[] = [], workerErrors: FirstActiveWorkerError[] = []
  let workerPhase: FirstActiveWorkerPhase = 'fixture_setup'
  let currentOutboxId: string | undefined
  const setWorkerContext = (phase: FirstActiveWorkerPhase, outboxId?: string): void => { workerPhase = phase; currentOutboxId = outboxId }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const input = actualObject(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    modelCalls.push(actualText(input['model']))
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of [{ choices: [{ index: 0, delta: { content: JSON.stringify(proposal) }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 80, completion_tokens: 100 } }]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('controlled proposal server unavailable')
  const directory = await mkdtemp(join(tmpdir(), 'core-first-active-'))
  const composition = await createCoreLocalComposition({ databaseUrl: harness.appUrl, objectDirectory: directory, scopeRef: scope, examples: loadCoreExamples({ targetScopeRef: scope }), allowLocalOperator: true, modelsEnabled: true, jevEnabled: false,
    onWorkerError: (error) => {
      const observation = firstActiveWorkerError(error, workerPhase, currentOutboxId)
      workerErrors.push(observation)
      process.stderr.write(`[core-worker-error-observed] ${JSON.stringify(observation)}\n`)
    }, modelEnvironment: { CORE_COMPANY_MODEL_BASE_URL: `http://127.0.0.1:${address.port}`, CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY', CORE_COMPANY_MODEL_API_KEY: 'local-controlled-proposal-only', CORE_COMPANY_MODEL_PLATFORM_ID: 'source-proposal', CORE_COMPANY_MODEL_VENDOR_MODEL: 'controlled-source-proposal', CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible' } })
  const api = createCoreApi(composition.dependencies), baseUrl = await api.listen({ host: '127.0.0.1', port: 0 })
  const objects = new FileSystemObjectStore(directory), registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
  const proofDatabase = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  let proofProfile: ResolvedProfileRef | undefined
  const rawCall = (path: string, body?: unknown, revision?: string, key: string = randomUUID()) => fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(revision === undefined ? {} : { 'if-match': revision }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  const call = async (path: string, body?: unknown, revision?: string, key?: string): Promise<Record<string, unknown>> => {
    const response = await rawCall(path, body, revision, key), raw = await response.text()
    if (!response.ok) throw new Error(`${path}: ${response.status} ${raw}`)
    return actualObject(actualObject(JSON.parse(raw) as unknown)['data'])
  }
  const review = (id: string, revision = '0') => call(`/api/v1/candidates/${id}/reviews`, { decision: 'approve', reason: '人工逐项核对实际原文与当前候选内容' }, revision)
  const proofContext = (profile: ResolvedProfileRef, maxRows = 1_000) => {
    const now = new Date().toISOString(), deadline = new Date(Date.now() + 120_000).toISOString(), runId = randomUUID()
    return createToolContext({ principal: { tenantId: scope.tenantId, subjectId: 'first-active-proof-reader', roles: ['platform-admin'], scopes: [], authEpoch: 1 }, runId, resolvedProfileHash: profile.snapshotHash, policyVersion: '1.0.0', deadline, budgetReservation: { reservationId: randomUUID(), runId, grantedAt: now, expiresAt: deadline }, allowedResources: { ...scope, resourceKinds: ['artifact', 'document', 'plan'], sourceRefs: [], collectionRefs: [], domains: [], maxRows }, traceId: randomUUID() })
  }
  const readArtifact = async (ref: ResourceRef, profile: ResolvedProfileRef) => {
    const bytes = await blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, proofContext(profile, 0))
    return actualObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
  }
  const waitForPublication = publicationMaterializationBarrier({ client: harness.adminClient, database: proofDatabase, blobs, scope,
    context: () => { if (proofProfile === undefined) throw new Error('the actual published proof profile is unavailable'); return proofContext(proofProfile) },
    assertWorkerHealthy: () => { if (workerErrors.length > 0) throw new Error(`actual publication materialization worker failed: ${JSON.stringify(firstActiveWorkerErrorSummary(workerErrors))}`) },
  })

  const publishPack = async (unitCode: 'h' | 'min', includeNote: boolean): Promise<FirstActivePack> => {
    setWorkerContext('pack_publication')
    const created = await call('/api/v1/core/workspace-bootstrap', { namespace: `first-${unitCode}-${randomUUID()}`, displayName: `设备工时${unitCode}`, boundary: { goals: ['核对实际工时输入与版本升级'], included: ['项目设备工时'], excluded: ['真实设备控制'], applicability: {} } })
    const workspaceId = actualText(actualObject(created['workspace'])['workspaceId']), threshold = unitCode === 'h' ? '8' : '480'
    const policy = `设备通过 machine_id 标识，身份限定在当前项目。hours 是以 ${unitCode} 为单位的工时数量，量纲为 time。设备工时达到 ${threshold} ${unitCode} 时符合工时规则的条件；缺少工时不能判断。${includeNote ? 'phase_note 是可选的阶段说明文本，不能从旧版本未确认的列自动获得业务批准。' : ''}`
    const source = await call(`/api/v1/core/workspaces/${workspaceId}/sources`, { name: `工时-${unitCode}.txt`, mediaType: 'text/plain', contentEncoding: 'base64', content: Buffer.from(policy).toString('base64') }, actualText(actualObject(created['draft'])['revision']))
    const sourceRef = actualResource(actualObject(source['source'])['sourceRef']), context = await call(`/api/v1/core/workspaces/${workspaceId}/authoring-context`), revision = actualText(actualObject(context['draft'])['revision']), generationPolicyRef = actualVersion(context['generationPolicyRef'])
    const common = { businessMeaning: '来自上传工时原文', suggestedReason: '原文明确声明', sourceIndex: 0, fragmentIndex: 0 }
    proposal = { objects: [{ ...common, logicalId: 'machine', displayName: '设备', identityAttributeIds: ['machine_id'], identityScopeDimensions: ['project'] }], attributes: [
      { ...common, logicalId: 'machine_id', objectLogicalId: 'machine', displayName: '设备编号', valueType: 'string', minCardinality: 1, maxCardinality: 1 },
      { ...common, logicalId: 'hours', objectLogicalId: 'machine', displayName: '运行工时', valueType: 'quantity', unitCode, dimension: 'time', minCardinality: 1, maxCardinality: 1 },
      ...(includeNote ? [{ ...common, logicalId: 'phase_note', objectLogicalId: 'machine', displayName: '阶段说明', valueType: 'string', minCardinality: 0, maxCardinality: 1 }] : []),
    ] }
    const generated = await call(`/api/v1/industry-workspaces/${workspaceId}/generations`, { kinds: ['object', 'attribute'], sourceRefs: [sourceRef], generationPolicyRef, candidateLimit: includeNote ? 4 : 3 }, revision)
    const ids = actualArray(generated['candidates']).map((row) => actualText(actualObject(row)['candidateId']))
    expect(ids).toHaveLength(includeNote ? 4 : 3)
    for (const id of ids) await review(id)
    proposal = { rules: [{ ruleId: 'maintenance', objectId: 'machine', displayName: '工时条件', businessMeaning: '工时符合已审核门槛', suggestedReason: `原文${threshold}${unitCode}门槛`, applicabilityNote: '当前项目设备', condition: { op: 'compare', attributeId: 'hours', operator: 'gte', value: threshold, unitCode }, exceptions: [], sourceSelections: ['applicability', 'condition'].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })) }] }
    const rules = await call(`/api/v1/industry-workspaces/${workspaceId}/rule-action-generations`, { kinds: ['rule'], sourceRefs: [sourceRef], selectedDefinitionCandidateIds: ids, generationPolicyRef, candidateLimit: 1 }, revision)
    expect(actualArray(rules['candidates'])).toHaveLength(1)
    const ruleId = actualText(actualObject(actualArray(rules['candidates'])[0])['candidateId'])
    await review(ruleId); await call(`/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${ruleId}/enable`, {}, revision)
    const sample = await call(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets`, { caseKinds: ['missing_parameter'], cases: [{ caseId: 'missing-hours', caseKind: 'missing_parameter', objectTypeRef: 'machine', fields: [{ fieldId: 'machine_id', value: 'M-1' }, { fieldId: 'hours', value: null }] }], expectations: [{ expectationId: 'missing-is-unknown', caseId: 'missing-hours', kind: 'rule', ruleId: 'maintenance', expected: 'unknown', origin: 'authored_oracle', reason: '原始输入没有工时，不能判断', confirmedBy: 'local-operator', confirmedAt: new Date().toISOString() }] }, revision)
    const exampleSetId = actualText(actualObject(sample['exampleSet'])['exampleSetId']), preview = await call(`/api/v1/core/workspaces/${workspaceId}/execution-preview`, { exampleSetId }, revision)
    const previewRevision = actualText(actualObject(preview['draft'])['revision'])
    expect(preview['deploymentExecutable']).toBe(false)
    // These synthetic original amounts are independent authored inputs, never generated
    // from the expected state or an execution result.
    const inputAmount = unitCode === 'h' ? '9.125' : '547.5', native = `machine_id,hours\nM-1,${inputAmount}\n`
    const uploaded = await fetch(`${baseUrl}/api/v1/competency-question-sources`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-source-media-type': 'text/csv' }, body: native, signal: AbortSignal.timeout(30_000) })
    if (!uploaded.ok) throw new Error(`actual CQ original upload failed: ${await uploaded.text()}`)
    const original = actualVersion(actualObject(actualObject(await uploaded.json() as unknown)['data'])['sourceRef']), definitionRef = actualVersion(preview['definitionRef']), ruleRef = actualVersion(actualArray(preview['ruleRefs'])[0]), logicalProjectId = randomUUID()
    const policyLocation = { sourceRef: actualVersion(sourceRef), startOffset: 0, endOffset: Buffer.byteLength(policy), quoteDigest: sourceRef.digest, offsetUnit: 'utf8_byte' as const }, inputLocation = { sourceRef: original, startOffset: 0, endOffset: Buffer.byteLength(native), quoteDigest: original.digest, offsetUnit: 'utf8_byte' as const }
    const body: CompetencyQuestionSetBody = { schemaVersion: 'competency-questions@1', classification: 'synthetic_demo_not_an_industry_standard', execution: 'not_run', industryId: `first-active-${unitCode}`, definitionRefs: [definitionRef], ruleRefs: [ruleRef], sourceRefs: [actualVersion(sourceRef), original], allowedCapabilities: ['semantic_read'], externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] }, questions: [{ questionId: `hours-${unitCode}`, question: '独立原始工时是否符合已审核门槛？', taskKind: 'rule_judgement', definitionRef, ruleRefs: [ruleRef], input: { dataMode: 'synthetic', scopeRef: scope, projectId: logicalProjectId, validAt: '2026-10-09T00:00:00Z', asOfRecordedSeq: '1', observations: [{ factId: 'original-hours', entityId: 'M-1', objectId: 'machine', attributeId: 'hours', value: { amount: inputAmount, unit: unitCode }, recordedSeq: '1', status: 'active', source: inputLocation }], relations: [], structuredSources: [{ sourceRef: original, objectId: 'machine', attributeIds: ['machine_id', 'hours'] }] }, intent: { kind: 'rule', projectId: logicalProjectId, objectId: 'machine', subjectEntityId: 'M-1', ruleId: 'maintenance' }, requiredCapabilities: ['semantic_read'], requiredSources: [policyLocation, inputLocation], expected: { kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: 'unknown' }, goldOrigin: 'authored_oracle', derivation: unitCode === 'h' ? '独立原文门槛8h，输入9.125h符合；没有业务结论。' : '独立原文门槛480min，输入547.5min符合；没有业务结论。', specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'] }] }
    const declaration = { ref: { id: randomUUID(), version: '1.0.0', digest: contentDigestOf(body) }, body }
    expect(createCompetencyQuestionBoundary().boundary.validate(declaration)).toBe(true)
    const saved = await call('/api/v1/competency-question-sets', declaration), cqRef = actualVersion(actualObject(saved['declaration'])['ref']); await review(cqRef.id)
    const strategy = { kind: 'new_version', reason: '人工发布本工作区已验证的正式版本', supersedesRef: definitionRef }, validation = actualObject((await call(`/api/v1/industry-workspaces/${workspaceId}/validations`, { exampleSetId, competencyQuestionRef: cqRef, definitionRef, strategy }, previewRevision))['validation'])
    expect(actualObject(validation['competency'])['passed']).toBe(true); expect(actualObject(validation['deploymentExecutable'])['passed']).toBe(true)
    const published = await call(`/api/v1/industry-workspaces/${workspaceId}/publications`, { packId: `first-active-${unitCode}-${randomUUID()}`, version: '1.0.0', validationId: validation['validationId'], strategy, requireDeploymentExecutable: true }, previewRevision)
    const pack = actualObject(published['pack']), packRef = actualVersion(pack['packRef']), actualDefinitionRef = actualVersion(pack['definitionRef']), configured = await call('/api/v1/core/published-pack-profiles', { packRef }), profile = actualObject(configured['profileRef'])
    expect(configured['definitionRef']).toEqual(actualDefinitionRef)
    const snapshotHash = actualText(profile['snapshotHash']); if (!/^sha256:[0-9a-f]{64}$/u.test(snapshotHash)) throw new Error('actual resolved profile digest missing')
    proofProfile = { id: actualText(profile['id']), version: actualText(profile['version']), snapshotHash }
    return { workspaceId, packRef, definitionRef: actualDefinitionRef, profileRef: proofProfile, unitCode }
  }

  return { harness, scope, modelCalls, workerErrors, call, rawCall, review, readArtifact, publishPack, setWorkerContext, waitForPublication,
    async close() { setWorkerContext('teardown'); await api.close(); await composition.close(); await registry.close(); await proofDatabase.close(); await new Promise<void>((done) => server.close(() => done())); await harness.stop(); const owned = resolve(directory); if (!owned.startsWith(resolve(tmpdir(), 'core-first-active-'))) throw new Error('owned staging cleanup escaped its prefix'); await rm(owned, { recursive: true, force: true }); if (workerErrors.length > 0) process.stderr.write(`[core-worker-error-summary] ${JSON.stringify(firstActiveWorkerErrorSummary(workerErrors))}\n`) } }
}

export type FirstActiveFixture = Awaited<ReturnType<typeof startFirstActiveFixture>>

export interface FirstActiveProject {
  readonly projectId: string
  readonly documentId: string
  readonly originalRef: ResourceRef
  readonly mapping: Record<string, unknown>
  readonly sourceColumns: readonly Record<string, unknown>[]
  readonly candidateIds: readonly string[]
  readonly snapshotRef: ResourceRef
  readonly revision: Record<string, unknown>
}

/** Import/confirm/publish real original rows without creating ANY ordinary run/input capture. */
export async function createFirstActiveProject(f: FirstActiveFixture, pack: FirstActivePack, title: string, sourceRows?: readonly { readonly machineId: string; readonly hours: string }[]): Promise<FirstActiveProject> {
  f.setWorkerContext('source_import')
  const business = await f.call('/api/v1/core/project-bootstrap', { title, profileRef: { id: pack.profileRef.id, version: pack.profileRef.version } }), projectId = actualText(actualObject(business['project'])['projectId'])
  expect(actualObject(business['revision'])['executionPurpose']).toBeUndefined()
  expect(actualObject(business['revision'])['industryPackRef']).toEqual(pack.packRef); expect(actualObject(business['revision'])['definitionRef']).toEqual(pack.definitionRef)
  // These inputs precede all query expectations; the third original column is deliberately
  // unmapped by P1 and must not enter old-active output while P2 is unapproved.
  const csv = sourceRows === undefined ? 'machine_id,hours,phase_note\nOLD-A,9.125,staged-only-A\nOLD-B,10.25,staged-only-B\n'
    : `machine_id,hours,phase_note\n${sourceRows.map((row) => `${row.machineId},${row.hours},staged-only`).join('\n')}\n`
  const imported = await f.call(`/api/v1/projects/${projectId}/structured-imports`, { format: 'csv', mediaType: 'text/csv', content: csv, contentEncoding: 'utf-8' })
  const catalogue = await f.call(`/api/v1/core/projects/${projectId}/source-catalogue`), source = actualObject(actualArray(catalogue['sources'])[0]), table = actualObject(actualArray(source['tables'])[0]), sourceColumns = actualArray(table['columns']).map(actualObject)
  const entries = firstActiveEntries(sourceColumns, false)
  const mapped = await f.call(`/api/v1/projects/${projectId}/mappings`, { format: 'csv', parseId: imported['parseId'], originalRef: imported['originalRef'], originalMediaType: imported['originalMediaType'], options: {}, objectId: 'machine', entries })
  const mapping = actualObject(mapped['mapping']), bound = await f.call(`/api/v1/projects/${projectId}/records`, { parseId: imported['parseId'], mappingId: mapping['mappingId'], mappingVersion: mapping['version'] })
  const recordRefs = actualArray(bound['records']).map((row) => ({ recordId: actualObject(row)['recordId'], revision: actualObject(row)['revision'] }))
  const candidateIds: string[] = []
  for (let offset = 0; offset < recordRefs.length; offset += 200) {
    const staged = await f.call(`/api/v1/core/projects/${projectId}/fact-candidates`, { documentId: imported['documentId'], recordRefs: recordRefs.slice(offset, offset + 200) })
    candidateIds.push(...actualArray(staged['candidates']).map((row) => actualText(actualObject(row)['candidateId'])))
  }
  expect(candidateIds).toHaveLength(sourceRows?.length ?? 2)
  f.setWorkerContext('human_confirmation')
  const records = await mapConcurrent(candidateIds, 8, async (id) => actualObject((await f.call(`/api/v1/projects/${projectId}/instance-records`, { candidateId: id, documentId: imported['documentId'] }))['record']))
  await mapConcurrent(candidateIds, 8, async (id, index) => {
    const record = records[index]
    if (record === undefined) throw new Error('the actual candidate has no created project record')
    await confirmFirstActiveCandidate(f, projectId, id, record)
  })
  await publishFirstActiveFacts(f, candidateIds, pack.definitionRef)
  const materialized = await f.call(`/api/v1/projects/${projectId}/dataset-snapshots`, { objectId: 'machine' })
  expect(actualObject(materialized['status'])['state']).toBe('ready')
  const mounted = await f.call(`/api/v1/core/projects/${projectId}/source-catalogue`)
  return { projectId, documentId: actualText(imported['documentId']), originalRef: actualResource(imported['originalRef']), mapping, sourceColumns, candidateIds, snapshotRef: actualResource(actualObject(materialized['status'])['snapshotRef']), revision: actualObject(mounted['revision']) }
}

export function firstActiveEntries(columns: readonly Record<string, unknown>[], target: boolean): readonly ColumnMappingEntry[] {
  return columns.flatMap((column) => {
    const header = actualText(column['header'])
    if (!['machine_id', 'hours', ...(target ? ['phase_note'] : [])].includes(header)) return []
    const columnIndex = column['columnIndex']; if (typeof columnIndex !== 'number' || !Number.isSafeInteger(columnIndex) || columnIndex < 0) throw new Error('actual native column index missing')
    return [{ fieldRef: header, columnIndex, header, headerDigest: actualText(column['headerDigest']), ...(header !== 'hours' ? {} : target ? { sourceUnitCode: 'h', canonicalUnitCode: 'min', unitConversion: { fromUnitCode: 'h', toUnitCode: 'min', numerator: '60', denominator: '1' } } : { sourceUnitCode: 'h', canonicalUnitCode: 'h' }) }]
  })
}

export async function confirmFirstActiveCandidate(f: FirstActiveFixture, projectId: string, candidateId: string, initial?: Record<string, unknown>) {
  f.setWorkerContext('human_confirmation')
  let record = initial ?? actualObject((await f.call(`/api/v1/projects/${projectId}/instance-records/${candidateId}`))['record'])
  record = actualObject((await f.call(`/api/v1/projects/${projectId}/instance-records/${candidateId}/field-confirmations`, { decisions: actualArray(record['fields']).map((field) => ({ fieldId: actualObject(field)['fieldId'], decision: 'confirm' })) }, actualText(record['recordRevision'])))['record'])
  await f.call(`/api/v1/projects/${projectId}/instance-records/${candidateId}/identity-decisions`, { kind: 'create', reason: '人工核对当前版本实际原始字段与项目内身份' }, actualText(record['recordRevision']))
  await f.review(candidateId)
}

export async function publishFirstActiveFacts(f: FirstActiveFixture, ids: readonly string[], definitionRef: VersionRef) {
  let result: Record<string, unknown> = {}
  for (let offset = 0; offset < ids.length; offset += 200) {
    f.setWorkerContext('facts_publication')
    const ledger = await f.call('/api/v1/semantic-publications'), current = actualArray(ledger['publications']).reduce<bigint>((value, row) => { const revision = BigInt(actualText(actualObject(row)['revision'])); return revision > value ? revision : value }, 0n)
    const publication = await f.call('/api/v1/semantic-publications', { approvedCandidateRefs: ids.slice(offset, offset + 200).map((candidateId) => ({ candidateId, kind: 'entity' })), schemaRef: definitionRef }, current.toString())
    const outboxId = actualText(publication['outboxId'])
    f.setWorkerContext('outbox_dispatch_wait', outboxId)
    await f.waitForPublication(outboxId)
    result = publication
  }
  return result
}

export async function waitFirstActiveEvolution(f: FirstActiveFixture, projectId: string, evolutionId: string) {
  f.setWorkerContext('evolution')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = actualObject((await f.call(`/api/v1/projects/${projectId}/evolutions/${evolutionId}`))['evolution'])
    if (f.workerErrors.length > 0) throw new Error(`actual worker cycle failure: ${JSON.stringify(firstActiveWorkerErrorSummary(f.workerErrors))}; evolution=${JSON.stringify(value)}`)
    if (value['state'] === 'awaiting_review' || value['state'] === 'needs_human' || value['state'] === 'ready') return value
    if (value['state'] === 'failed' || value['state'] === 'cancelled') throw new Error(`actual evolution worker refused: ${JSON.stringify(value)}`)
    await new Promise<void>((done) => setTimeout(done, 100))
  }
  throw new Error('actual evolution worker did not finish within its original30s polling bound')
}

export async function firstActiveQuery(f: FirstActiveFixture, projectId: string, profile: ResolvedProfileRef, fields: readonly string[], limit = 2) {
  f.setWorkerContext('query')
  const catalogue = await f.call(`/api/v1/core/projects/${projectId}/task-catalogue`), binding = actualArray(catalogue['tasks']).map(actualObject).find((row) => row['taskKind'] === 'structured_query')
  if (binding === undefined || binding['available'] !== true) throw new Error(`actual old-active task is unavailable: ${JSON.stringify(binding)}`)
  const created = await f.call('/api/v1/runs', { profileRef: { id: profile.id, version: profile.version }, projectId, question: '读取此实际生效版本已审核的原始工时', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { bindingRef: binding['bindingRef'], arguments: { objectId: 'machine', fields, limit } } })
  const runId = actualText(created['runId']), deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await f.rawCall(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return { runId, answer: actualObject(actualObject(await response.json() as unknown)['data']), catalogue }
    if (response.status !== 202) {
      const [ledger, reservations, runState, verifications, workflowManifest] = await Promise.all([
        f.harness.adminClient.query(`SELECT ledger_id,limits,tool_calls_consumed,repair_attempts_consumed,rows_consumed,bytes_consumed,model_tokens_consumed FROM agent_platform.budget_ledgers WHERE tenant_id=$1::uuid AND space_id=$2::uuid AND run_id=$3::uuid`, [f.scope.tenantId, f.scope.spaceId, runId]),
        f.harness.adminClient.query(`SELECT reservation_id,idempotency_key,status,tool_calls,reserved_rows,reserved_bytes,actual_rows,actual_bytes,actual_tool_calls FROM agent_platform.budget_reservations WHERE tenant_id=$1::uuid AND space_id=$2::uuid AND run_id=$3::uuid ORDER BY granted_at`, [f.scope.tenantId, f.scope.spaceId, runId]),
        f.harness.adminClient.query(`SELECT state,revision::text FROM agent_platform.workflow_run_states WHERE tenant_id=$1::uuid AND space_id=$2::uuid AND run_id=$3::uuid`, [f.scope.tenantId, f.scope.spaceId, runId]),
        f.harness.adminClient.query(`SELECT record FROM agent_platform.workflow_verifications WHERE tenant_id=$1::uuid AND space_id=$2::uuid AND run_id=$3::uuid`, [f.scope.tenantId, f.scope.spaceId, runId]),
        f.harness.adminClient.query(`SELECT manifest FROM agent_platform.workflow_run_manifests WHERE tenant_id=$1::uuid AND space_id=$2::uuid AND run_id=$3::uuid`, [f.scope.tenantId, f.scope.spaceId, runId]),
      ])
      throw new Error(`actual first active query refused: ${await response.text()}; ${JSON.stringify({ run: await f.call(`/api/v1/runs/${runId}`), ledger: ledger.rows, reservations: reservations.rows, runState: runState.rows, verifications: verifications.rows, workflowManifest: workflowManifest.rows })}`)
    }
    await new Promise<void>((done) => setTimeout(done, 100))
  }
  throw new Error('actual first active query did not publish within original30s bound')
}
