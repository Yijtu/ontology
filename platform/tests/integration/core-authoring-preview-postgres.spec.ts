import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCoreApi, createCoreLocalComposition, createCompetencyQuestionBoundary, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { contentDigestOf } from '@ontology/application'
import { isRecord, isResourceRef, isVersionRef } from '@ontology/contracts'
import type { CompetencyQuestionSetBody, ResourceRef, ScopeRef, VersionRef } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

let harness: JobDbHarness, composition: CoreLocalComposition, api: ReturnType<typeof createCoreApi>, server: Server
let scope: ScopeRef, directory = '', baseUrl = '', proposal: unknown = {}
const modelCalls: string[] = []
const workerErrors: unknown[] = []
function object(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error('the actual response is not an object'); return value }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('the actual response string is missing'); return value }
function version(value: unknown): VersionRef { if (!isVersionRef(value)) throw new Error('the actual version pin is missing'); return { id: value.id, version: value.version, digest: value.digest } }
function resource(value: unknown): ResourceRef { if (!isResourceRef(value)) throw new Error('the actual resource pin is missing'); return value }
async function call(path: string, body?: unknown, revision?: string, key = randomUUID()): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(revision === undefined ? {} : { 'if-match': revision }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  const raw = await response.text()
  expect(response.ok, `${path}: ${response.status} ${raw}`).toBe(true)
  return object(object(JSON.parse(raw) as unknown)['data'])
}
async function publishedAnswer(runId: string) {
  const deadline = Date.now()+30_000
  while (Date.now()<deadline) {
    const response = await fetch(`${baseUrl}/api/v1/runs/${runId}/answer`)
    if (response.status===200) return object(object(await response.json() as unknown)['data'])
    if (response.status!==202) throw new Error(`normal task publication refused: ${await response.text()}; run=${JSON.stringify(await call(`/api/v1/runs/${runId}`))}; workers=${JSON.stringify(workerErrors.map((error) => error instanceof Error ? { message: error.message,cause: error.cause,stack: error.stack } : error))}`)
    await new Promise<void>((done)=>setTimeout(done,100))
  }
  throw new Error('the actual normal controller did not publish before its original30s bound')
}
function firstEvidenceRef(answer: Record<string, unknown>): ResourceRef {
  const body = object(answer['v3Body'])
  for (const group of [body['assertions'], body['claims']]) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      if (!isRecord(item) || !Array.isArray(item['references'])) continue
      for (const reference of item['references']) {
        if (isRecord(reference) && isResourceRef(reference['evidenceRef'])) return reference['evidenceRef']
      }
    }
  }
  throw new Error('the actual normal answer has no cited source evidence')
}
beforeAll(async () => {
  harness = await startJobDatabase(); scope = (await createJobScope(harness.adminClient, 'normal-authoring-preview')).scopeRef
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const input = object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    modelCalls.push(text(input['model']))
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const event of [
      { choices: [{ index: 0, delta: { content: JSON.stringify(proposal) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 80, completion_tokens: 100 } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('controlled source proposal server is unavailable')
  directory = await mkdtemp(join(tmpdir(), 'core-authoring-preview-'))
  composition = await createCoreLocalComposition({ databaseUrl: harness.appUrl, objectDirectory: directory, scopeRef: scope,
    examples: loadCoreExamples({ targetScopeRef: scope }), allowLocalOperator: true, modelsEnabled: true, jevEnabled: false, onWorkerError: (error) => { workerErrors.push(error) },
    modelEnvironment: { CORE_COMPANY_MODEL_BASE_URL: `http://127.0.0.1:${address.port}`, CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY', CORE_COMPANY_MODEL_API_KEY: 'local-controlled-proposal-only', CORE_COMPANY_MODEL_PLATFORM_ID: 'source-proposal', CORE_COMPANY_MODEL_VENDOR_MODEL: 'controlled-source-proposal', CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible' } })
  api = createCoreApi(composition.dependencies); baseUrl = await api.listen({ host: '127.0.0.1', port: 0 })
})
afterAll(async () => {
  await api?.close(); await composition?.close(); await new Promise<void>((done) => server?.close(() => done())); await harness?.stop()
  if (directory !== '') { const owned = resolve(directory); if (!owned.startsWith(resolve(tmpdir(), 'core-authoring-preview-'))) throw new Error('owned source-proof cleanup escaped its prefix'); await rm(owned, { recursive: true, force: true }) }
})

describe('normal Core authoring, reviewed pack execution support and actual CQ deployment', () => {
  it('keeps the same human-reviewed source through HTTP preview retry, new CQ approval and physical final publication', async () => {
    const created = await call('/api/v1/core/workspace-bootstrap', { namespace: `normal-${randomUUID()}`, displayName: '设备工时规则', boundary: { goals: ['核对设备工时条件'], included: ['设备工时'], excluded: ['真实设备控制'], applicability: {} } })
    const workspaceId = text(object(created['workspace'])['workspaceId'])
    const policy = '设备通过 machine_id 标识，身份限定在当前项目。hours 是以 h 为单位的工时数量。设备工时达到 8 h 时符合工时规则的条件；缺少工时不能判断。amount 是可选的非负精确小数，amount_unit 是可选的单位文本；每件数量使用 each，登记示例汇总最多四位小数的每件数量。'
    const source = await call(`/api/v1/core/workspaces/${workspaceId}/sources`, { name: '工时规则.txt', mediaType: 'text/plain', contentEncoding: 'base64', content: Buffer.from(policy).toString('base64') }, '1')
    const sourceRef = resource(object(source['source'])['sourceRef'])
    const context = await call(`/api/v1/core/workspaces/${workspaceId}/authoring-context`)
    const generationPolicyRef = version(context['generationPolicyRef'])
    const common = { businessMeaning: '来自上传工时原文', suggestedReason: '原文明确声明', sourceIndex: 0, fragmentIndex: 0 }
    proposal = { objects: [{ ...common, logicalId: 'machine', displayName: '设备', identityAttributeIds: ['machine_id'], identityScopeDimensions: ['project'] }], attributes: [
      { ...common, logicalId: 'machine_id', objectLogicalId: 'machine', displayName: '设备编号', valueType: 'string', minCardinality: 1, maxCardinality: 1 },
      { ...common, logicalId: 'hours', objectLogicalId: 'machine', displayName: '运行工时', valueType: 'quantity', unitCode: 'h', dimension: 'time', minCardinality: 1, maxCardinality: 1 },
      { ...common, logicalId: 'amount', objectLogicalId: 'machine', displayName: '数量', valueType: 'number', minCardinality: 0, maxCardinality: 1 },
      { ...common, logicalId: 'amount_unit', objectLogicalId: 'machine', displayName: '数量单位', valueType: 'string', minCardinality: 0, maxCardinality: 1 },
    ] }
    const generated = await call(`/api/v1/industry-workspaces/${workspaceId}/generations`, { kinds: ['object','attribute'], sourceRefs: [sourceRef], generationPolicyRef, candidateLimit: 5 }, '2')
    if (!Array.isArray(generated['candidates'])) throw new Error('normal generated candidates missing')
    const ids = generated['candidates'].map((candidate: unknown) => text(object(candidate)['candidateId']))
    const review = async (candidateId: string) => call(`/api/v1/candidates/${candidateId}/reviews`, { decision: 'approve', reason: '人工逐项核对原文及当前候选内容' }, '0')
    for (const id of ids) await review(id)
    proposal = { rules: [{ ruleId: 'maintenance', objectId: 'machine', displayName: '工时条件', businessMeaning: '工时符合已审核门槛', suggestedReason: '已审核原文8h门槛', applicabilityNote: '当前项目设备', condition: { op: 'compare', attributeId: 'hours', operator: 'gte', value: '8', unitCode: 'h' }, exceptions: [], sourceSelections: ['applicability','condition'].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })) }] }
    const rules = await call(`/api/v1/industry-workspaces/${workspaceId}/rule-action-generations`, { kinds: ['rule'], sourceRefs: [sourceRef], selectedDefinitionCandidateIds: ids, generationPolicyRef, candidateLimit: 1 }, '2')
    if (!Array.isArray(rules['candidates']) || rules['candidates'].length !== 1) throw new Error('normal generated rule missing')
    const ruleId = text(object(rules['candidates'][0])['candidateId'])
    await review(ruleId)
    await call(`/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${ruleId}/enable`, {}, '2')
    const sample = await call(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets`, { caseKinds: ['missing_parameter'], cases: [{ caseId: 'missing-hours', caseKind: 'missing_parameter', objectTypeRef: 'machine', fields: [{ fieldId: 'machine_id', value: 'M-1' }, { fieldId: 'hours', value: null }] }], expectations: [{ expectationId: 'missing-is-unknown', caseId: 'missing-hours', kind: 'rule', ruleId: 'maintenance', expected: 'unknown', origin: 'authored_oracle', reason: '原始输入没有工时，不能判断', confirmedBy: 'local-operator', confirmedAt: new Date().toISOString() }] }, '2')
    const exampleSetId = text(object(sample['exampleSet'])['exampleSetId']), previewKey = randomUUID()
    const preview = await call(`/api/v1/core/workspaces/${workspaceId}/execution-preview`, { exampleSetId }, '2', previewKey)
    expect(object(preview['workspace'])['headRevision']).toBe('3')
    expect(preview['deploymentExecutable']).toBe(false)
    const retry = await call(`/api/v1/core/workspaces/${workspaceId}/execution-preview`, { exampleSetId }, '2', previewKey)
    expect(retry['templateBindingRef']).toEqual(preview['templateBindingRef'])
    expect(object(retry['workspace'])['headRevision']).toBe('3')
    expect((await call(`/api/v1/core/workspaces/${workspaceId}/execution-preview`))['templateBindingRef']).toEqual(preview['templateBindingRef'])
    const native = 'machine_id,hours\nM-1,9.000000000000000001\n'
    const uploaded = await fetch(`${baseUrl}/api/v1/competency-question-sources`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-source-media-type': 'text/csv' }, body: native })
    expect(uploaded.ok, await uploaded.clone().text()).toBe(true)
    const original = version(object(object(await uploaded.json() as unknown)['data'])['sourceRef'])
    const definitionRef = version(preview['definitionRef'])
    if (!Array.isArray(preview['ruleRefs']) || preview['ruleRefs'].length !== 1) throw new Error('actual preview rule ref missing')
    const ruleRef = version(preview['ruleRefs'][0]), logicalProjectId = randomUUID()
    const policyLocation = { sourceRef: version(sourceRef), startOffset: 0, endOffset: Buffer.byteLength(policy), quoteDigest: sourceRef.digest, offsetUnit: 'utf8_byte' as const }
    const inputLocation = { sourceRef: original, startOffset: 0, endOffset: Buffer.byteLength(native), quoteDigest: original.digest, offsetUnit: 'utf8_byte' as const }
    const body: CompetencyQuestionSetBody = { schemaVersion: 'competency-questions@1', classification: 'synthetic_demo_not_an_industry_standard', execution: 'not_run', industryId: 'normal-machine-hours', definitionRefs: [definitionRef], ruleRefs: [ruleRef], sourceRefs: [version(sourceRef),original], allowedCapabilities: ['semantic_read'], externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] }, questions: [{ questionId: 'normal-machine-hours', question: '设备M-1的原始工时是否符合这条规则的条件？', taskKind: 'rule_judgement', definitionRef, ruleRefs: [ruleRef], input: { dataMode: 'synthetic', scopeRef: scope, projectId: logicalProjectId, validAt: '2026-10-09T00:00:00Z', asOfRecordedSeq: '1', observations: [{ factId: 'original-hours', entityId: 'M-1', objectId: 'machine', attributeId: 'hours', value: { amount: '9.000000000000000001', unit: 'h' }, recordedSeq: '1', status: 'active', source: inputLocation }], relations: [], structuredSources: [{ sourceRef: original, objectId: 'machine', attributeIds: ['machine_id','hours'] }] }, intent: { kind: 'rule', projectId: logicalProjectId, objectId: 'machine', subjectEntityId: 'M-1', ruleId: 'maintenance' }, requiredCapabilities: ['semantic_read'], requiredSources: [policyLocation,inputLocation], expected: { kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: 'unknown' }, goldOrigin: 'authored_oracle', derivation: '独立原文门槛为8h，原始输入9.000000000000000001h达到门槛；规则没有业务结论。', specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'] }] }
    const upload = { ref: { id: randomUUID(), version: '1.0.0', digest: contentDigestOf(body) }, body }
    const validate = createCompetencyQuestionBoundary().boundary.validate
    const valid = validate(upload)
    expect(valid, JSON.stringify('errors' in validate ? validate.errors : undefined)).toBe(true)
    const declaration = await call('/api/v1/competency-question-sets', upload)
    const cqRef = version(object(declaration['declaration'])['ref'])
    await review(cqRef.id)
    const strategy = { kind: 'new_version', reason: '人工选择通过真实业务能力验核的正式版本', supersedesRef: definitionRef }
    const result = await call(`/api/v1/industry-workspaces/${workspaceId}/validations`, { exampleSetId, competencyQuestionRef: cqRef, definitionRef, strategy }, '3')
    const validation = object(result['validation'])
    expect(object(validation['competency'])['passed']).toBe(true)
    expect(object(validation['deploymentExecutable'])['passed']).toBe(true)
    const published = await call(`/api/v1/industry-workspaces/${workspaceId}/publications`, { packId: 'execution-preview-2', version: '1.0.0', validationId: validation['validationId'], strategy, requireDeploymentExecutable: true }, '3')
    expect(object(published['capabilityStatus'])['deploymentExecutable']).toBe(true)
    expect(object(published['pack'])['revision']).toBe('4')
    const configured = await call('/api/v1/core/published-pack-profiles', { packRef: object(published['pack'])['packRef'] })
    const profile = object(configured['profileRef'])
    const business = await call('/api/v1/core/project-bootstrap', { title: '正式设备项目', profileRef: { id: profile['id'], version: profile['version'] } })
    expect(object(business['revision'])['executionPurpose']).toBeUndefined()
    expect(object(business['revision'])['industryPackRef']).toEqual(object(published['pack'])['packRef'])
    expect(object(business['revision'])['definitionRef']).toEqual(object(published['pack'])['definitionRef'])
    const projectId = text(object(business['project'])['projectId'])
    const imported = await call(`/api/v1/projects/${projectId}/structured-imports`, { format: 'csv', mediaType: 'text/csv', content: 'machine_id,hours,amount,amount_unit\nN-1,9.000000000000000001,2.5,each\nN-2,7.25,1.25,each\n', contentEncoding: 'utf-8' })
    const beforeMap = await call(`/api/v1/core/projects/${projectId}/source-catalogue`)
    if (!Array.isArray(beforeMap['sources'])) throw new Error('actual business source catalogue missing')
    const nativeSource = object(beforeMap['sources'][0])
    if (!Array.isArray(nativeSource['tables'])) throw new Error('actual business native table missing')
    const nativeTable = object(nativeSource['tables'][0])
    if (!Array.isArray(nativeTable['columns'])) throw new Error('actual business original column catalogue missing')
    const mappingBody = { format: 'csv', parseId: imported['parseId'], originalRef: imported['originalRef'], originalMediaType: imported['originalMediaType'], options: {}, objectId: 'machine',
      entries: nativeTable['columns'].map((value: unknown) => { const column = object(value); return { fieldRef: column['header'], columnIndex: column['columnIndex'], header: column['header'], headerDigest: column['headerDigest'], ...(column['header'] !== 'hours' ? {} : { sourceUnitCode: 'h', canonicalUnitCode: 'h' }) } }) }
    const mappingKey = randomUUID(), mapped = await call(`/api/v1/projects/${projectId}/mappings`,mappingBody,undefined,mappingKey)
    const mounted = await call(`/api/v1/core/projects/${projectId}/source-catalogue`)
    expect(object(mounted['revision'])['mappingRefs']).toContainEqual(object(mapped['mapping'])['ref'])
    expect(object(mounted['revision'])['documentSetRef']).toMatchObject({ digest: object(imported['documentSetRef'])['digest'] })
    await call(`/api/v1/projects/${projectId}/mappings`,mappingBody,undefined,mappingKey)
    expect(object((await call(`/api/v1/projects/${projectId}`))['project'])['headRevision']).toBe(object(object(mounted['revision'])['ref'])['revision'])
    const bound = await call(`/api/v1/projects/${projectId}/records`, { parseId: imported['parseId'],mappingId: object(mapped['mapping'])['mappingId'],mappingVersion: object(mapped['mapping'])['version'] })
    if (!Array.isArray(bound['records'])) throw new Error('actual mapped business records missing')
    const stagedFacts = await call(`/api/v1/core/projects/${projectId}/fact-candidates`, { documentId: imported['documentId'],recordRefs: bound['records'].map((row: unknown) => ({ recordId: object(row)['recordId'],revision: object(row)['revision'] })) })
    if (!Array.isArray(stagedFacts['candidates']) || stagedFacts['candidates'].length !== 2) throw new Error('actual normal business fact candidates missing')
    for (const value of stagedFacts['candidates']) {
      const candidate = object(value), candidateId = text(candidate['candidateId'])
      const createdRecord = await call(`/api/v1/projects/${projectId}/instance-records`, { candidateId,documentId: imported['documentId'] })
      let record = object(createdRecord['record'])
      if (!Array.isArray(record['fields'])) throw new Error('actual mapped human-review fields missing')
      record = object((await call(`/api/v1/projects/${projectId}/instance-records/${text(record['recordId'])}/field-confirmations`, { decisions: record['fields'].map((field: unknown) => ({ fieldId: object(field)['fieldId'],decision: 'confirm' })) },text(record['recordRevision'])))['record'])
      await call(`/api/v1/projects/${projectId}/instance-records/${text(record['recordId'])}/identity-decisions`, { kind: 'create',reason: '人工核对当前项目内真实原始编号与字段' },text(record['recordRevision']))
      await review(candidateId)
    }
    const ledger = await call('/api/v1/semantic-publications')
    if (!Array.isArray(ledger['publications'])) throw new Error('actual publication ledger missing')
    const currentRead = ledger['publications'].reduce((max: bigint,row: unknown) => BigInt(text(object(row)['revision'])) > max ? BigInt(text(object(row)['revision'])) : max,0n).toString()
    await call('/api/v1/semantic-publications', { approvedCandidateRefs: stagedFacts['candidates'].map((row: unknown) => ({ candidateId: object(row)['candidateId'],kind: 'entity' })),schemaRef: object(published['pack'])['definitionRef'] },currentRead)
    const materialized = await call(`/api/v1/projects/${projectId}/dataset-snapshots`, { objectId: 'machine' })
    expect(object(materialized['status'])['state']).toBe('ready')
    const tasks = await call(`/api/v1/core/projects/${projectId}/task-catalogue`)
    if (!Array.isArray(tasks['tasks'])) throw new Error('actual business task catalogue missing')
    const queryTask = tasks['tasks'].map(object).find((task) => task['taskKind'] === 'structured_query')
    expect(queryTask?.['available'],JSON.stringify(queryTask)).toBe(true)
    const queryRun = await call('/api/v1/runs', { profileRef: { id: profile['id'],version: profile['version'] },projectId,question: '查看已审核设备的原始工时',context: { timeZone: 'UTC' },preferences: { route: 'template',allowWeb: false },task: { bindingRef: queryTask?.['bindingRef'],arguments: { objectId: 'machine',fields: ['machine_id','hours'],limit: 2 } } })
    const answer = await publishedAnswer(text(queryRun['runId']))
    const resultView = await call(`/api/v1/answers/${text(answer['answerId'])}/result`)
    expect(resultView['tables']).toHaveLength(1)
    expect(JSON.stringify(resultView['tables'])).toContain('运行工时')
    expect(JSON.stringify(resultView['tables'])).toContain('设备编号')
    const actualTable = object((resultView['tables'] as unknown[])[0]), tableId = text(actualTable['tableId'])
    const actualPage = await call(`/api/v1/answers/${text(answer['answerId'])}/tables/${tableId}`)
    const actualRow = object((actualPage['rows'] as unknown[])[0]), actualColumn = (actualPage['columns'] as unknown[]).map(object).find((column) => column['semanticPredicate'] === 'machine_id')
    if (actualColumn === undefined) throw new Error('the actual normal query table has no mapped machine identifier column')
    const querySource = await call(`/api/v1/core/answers/${text(answer['answerId'])}/sources/${firstEvidenceRef(answer).id}?tableId=${encodeURIComponent(tableId)}&rowKey=${encodeURIComponent(text(actualRow['rowKey']))}&columnRef=${encodeURIComponent(text(actualColumn['columnRef']))}`)
    expect(querySource).toMatchObject({ answerId: answer['answerId'], evidenceId: firstEvidenceRef(answer).id, selectedCell: { tableId, rowKey: actualRow['rowKey'], columnRef: actualColumn['columnRef'] }, sourceCoverage: { mode: 'saved_cell', coverage: 'complete' }, readability: 'archived_snapshot_only' })
    expect(JSON.stringify(querySource['fragments'])).toContain('N-1')
    const computeTask = tasks['tasks'].map(object).find((task) => task['taskKind'] === 'compute')
    expect(computeTask?.['available'],JSON.stringify(computeTask)).toBe(true)
    expect(computeTask?.['parameterSchema']).toMatchObject({ properties: {} })
    const computeRun = await call('/api/v1/runs',{ profileRef: { id: profile['id'],version: profile['version'] },projectId,question: '汇总已审核原始行的每件数量',context: { timeZone: 'UTC' },preferences: { route: 'template',allowWeb: false },task: { bindingRef: computeTask?.['bindingRef'],arguments: {},inputSelection: { objectId: 'machine',idField: 'machine_id',amountField: 'amount',unitField: 'amount_unit' } } })
    const computeAnswer = await publishedAnswer(text(computeRun['runId']))
    expect(object(computeAnswer['v3Body'])['claims']).toContainEqual(expect.objectContaining({ predicate: 'total_quantity',kind: 'computation',value: { value: '3.75',unit: 'each' } }))
    const computeSource = await call(`/api/v1/core/answers/${text(computeAnswer['answerId'])}/sources/${firstEvidenceRef(computeAnswer).id}`)
    expect(computeSource).toMatchObject({ answerId: computeAnswer['answerId'], evidenceId: firstEvidenceRef(computeAnswer).id, sourceCoverage: { mode: 'compute_input_sample', coverage: 'complete' }, readability: 'archived_snapshot_only' })
    expect(JSON.stringify(computeSource['fragments'])).toContain('2.5')
    const computeState = await call(`/api/v1/runs/${text(computeRun['runId'])}`)
    expect(object(computeState['scope'])['explicitDegradations']).not.toContainEqual(expect.objectContaining({ capability: 'compute:example.compute.aggregate@1' }))
    let currentTasks = await call(`/api/v1/core/projects/${projectId}/task-catalogue`)
    if (!Array.isArray(currentTasks['tasks'])) throw new Error('the actual current task catalogue is missing')
    let ruleTask = currentTasks['tasks'].map(object).find((task) => task['taskKind'] === 'rule_judgement')
    const readinessDeadline = Date.now()+30_000
    while (ruleTask?.['available'] !== true && Date.now()<readinessDeadline) {
      await new Promise<void>((done)=>setTimeout(done,100))
      currentTasks = await call(`/api/v1/core/projects/${projectId}/task-catalogue`)
      if (!Array.isArray(currentTasks['tasks'])) throw new Error('the actual current task catalogue is missing')
      ruleTask = currentTasks['tasks'].map(object).find((task) => task['taskKind'] === 'rule_judgement')
    }
    if (ruleTask?.['available'] !== true) {
      const [projection,readiness] = await Promise.all([harness.adminClient.query('SELECT row_to_json(p) body FROM agent_platform.projection_state p WHERE tenant_id=$1::uuid AND space_id=$2::uuid',[scope.tenantId,scope.spaceId]),harness.adminClient.query('SELECT row_to_json(p) body FROM agent_platform.project_readiness p WHERE tenant_id=$1::uuid AND space_id=$2::uuid AND project_id=$3::uuid',[scope.tenantId,scope.spaceId,projectId])])
      throw new Error(`actual rule readiness did not advance: ${JSON.stringify({ ruleTask,projection: projection.rows,readiness: readiness.rows,workerErrors: workerErrors.map((error) => error instanceof Error ? { message: error.message,cause: error.cause } : error) })}`)
    }
    const ruleRun = await call('/api/v1/runs',{ profileRef: { id: profile['id'],version: profile['version'] },projectId,question: 'N-1是否符合已审核工时规则的条件',context: { timeZone: 'UTC' },preferences: { route: 'template',allowWeb: false },task: { bindingRef: ruleTask?.['bindingRef'],arguments: { rule: 'maintenance',entity: 'N-1' } } })
    const ruleAnswer = await publishedAnswer(text(ruleRun['runId']))
    expect(object(ruleAnswer['v3Body'])['assertions']).toContainEqual(expect.objectContaining({ kind: 'rule_judgement',value: 'true',judgementAxis: 'applicability' }))
    expect(ruleTask['rules']).toContainEqual(expect.objectContaining({ ruleId: 'maintenance',displayName: '工时条件' }))
    const privateJobs = await harness.adminClient.query<{ stage: string; last_error: unknown }>(`SELECT DISTINCT j.stage,j.last_error FROM agent_platform.jobs j
      JOIN agent_platform.published_statements s ON s.tenant_id=j.tenant_id AND s.space_id=j.space_id AND s.source_job_id=j.job_id
      JOIN agent_platform.project_revisions r ON r.tenant_id=s.tenant_id AND r.space_id=s.space_id AND r.project_id::text=s.value#>>'{provenance,sources,0,projectRevisionRef,projectId}'
      WHERE j.tenant_id=$1::uuid AND j.space_id=$2::uuid AND r.body->>'executionPurpose'='synthetic_validation'`, [scope.tenantId,scope.spaceId])
    expect(privateJobs.rows.length).toBeGreaterThan(0)
    expect(privateJobs.rows.every((job) => job.stage === 'awaiting_review' && job.last_error === null)).toBe(true)
    expect(modelCalls).toEqual(['controlled-source-proposal','controlled-source-proposal'])
    expect(workerErrors.map((error) => error instanceof Error ? { name: error.name, message: error.message, cause: error.cause instanceof Error ? error.cause.message : error.cause, stack: error.stack } : error)).toEqual([])
  })
})
