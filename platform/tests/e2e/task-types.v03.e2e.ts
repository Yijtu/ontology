import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from 'pg'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import {
  createBlobArtifactWriter,
  createCoreApi,
  createCoreLocalComposition,
  loadCoreExamples,
} from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { canonicalJson, contentDigestOf } from '@ontology/application'
import { createToolContext, isRecord, isVersionRef } from '@ontology/contracts'
import type {
  ProjectRevisionRef,
  ResourceRef,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { startPostgresContainer } from '../integration/postgres-container'
import type { PostgresContainer } from '../integration/postgres-container'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

/** W08 task-type browser/host E2E with real originals, project mappings, human review and publication. */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `tasktypes_${randomUUID().replaceAll('-', '')}`
const MODEL_SECRET = 'task-types-controlled-model-secret'
const SCENARIO_ID = 'transport-facility-inspection'
let PROJECT_ID = ''
let UNREADY_PROJECT_ID = ''
const DIGEST = `sha256:${'a'.repeat(64)}`
const DOCUMENT_TEXT = 'SERVICE MANUAL. The inspection interval for the pump is ninety days. The warranty covers five years of pump operation.'
const MATCHING_QUERY = 'inspection interval pump'
const COMPUTE_INPUT = { rows: [{ id: 'R-1', amount: '10', unit: 'each' }, { id: 'R-2', amount: '2.5', unit: 'each' }, { id: 'R-3', amount: '1.25', currency: 'CNY' }] }
let RULE_SUBJECT_ID = ''
const RULE_OBJECT_ID = 'transport_facility'
const POLICY_TEXT = 'The transport_facility registry has exactly one required facility_id:string identity, exactly one required network_code:string, and exactly one required facility_district_code enum whose allowed values are north and south. The inspection_due:boolean, inspection_exempt:boolean, inspection_required:boolean, and inspection_policy_code:string fields are each optional single values. Synthetic demo policy R-T: For one transport facility, the rule requires an inspection when inspection_due is true. Exception: inspection_exempt is true. A missing inspection_exempt value is unknown and does not count as false. When the rule applies its typed business conclusion is inspection_required=true. This is a local synthetic assumption, not a transport standard, regulation, or customer policy.'
const RULE_VALIDITY = { validFrom: '2020-01-01T00:00:00Z', validTo: '2099-01-01T00:00:00Z' }
let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let web: WebHost
let browser: Browser
let modelServer: Server | undefined
let modelServerBaseUrl = ''
let approvedInputRef: ResourceRef
let projectRevisionRefValue: ProjectRevisionRef
let unreadyProjectRevisionRefValue: ProjectRevisionRef
let unreadyApprovedInputRef: ResourceRef
let cachedApprovedInput: ResourceRef | undefined
let factCandidateId = ''
let taskProfileRef: { id: string; version: string } | undefined
let closingComposition = false
const workerErrors: { readonly duringClose: boolean; readonly name: string; readonly code?: string; readonly message: string }[] = []

async function startControlledModelServer(): Promise<string> {
  modelServer = createServer(async (_request, response) => {
    let receivedBytes = 0
    for await (const chunk of _request) {
      receivedBytes += Buffer.byteLength(chunk)
      if (receivedBytes > 256 * 1024) {
        response.writeHead(413).end()
        return
      }
    }
    const content = JSON.stringify({
      objects: [{ logicalId: RULE_OBJECT_ID, displayName: 'Transport facility', businessMeaning: 'A facility identified in the source transport registry',
        suggestedReason: 'The uploaded source names this registry object', identityAttributeIds: ['facility_id'] }],
      attributes: [
        { logicalId: 'facility_id', displayName: 'Facility ID', businessMeaning: 'The source identity of a transport facility', suggestedReason: 'The uploaded source identifies each facility', objectLogicalId: RULE_OBJECT_ID, valueType: 'string', minCardinality: 1, maxCardinality: 1 },
        { logicalId: 'network_code', displayName: 'Network code', businessMeaning: 'The network code for a transport facility', suggestedReason: 'The uploaded source names the network code', objectLogicalId: RULE_OBJECT_ID, valueType: 'string', minCardinality: 1, maxCardinality: 1 },
        { logicalId: 'facility_district_code', displayName: 'District code', businessMeaning: 'The district code for a transport facility', suggestedReason: 'The uploaded source names the district code', objectLogicalId: RULE_OBJECT_ID, valueType: 'enum', enumValues: ['north', 'south'], minCardinality: 1, maxCardinality: 1 },
        { logicalId: 'inspection_due', displayName: 'Inspection due', businessMeaning: 'Whether the next inspection is due', suggestedReason: 'The source policy names this condition', objectLogicalId: RULE_OBJECT_ID, valueType: 'boolean', minCardinality: 0, maxCardinality: 1 },
        { logicalId: 'inspection_exempt', displayName: 'Inspection exempt', businessMeaning: 'Whether an explicit inspection exemption applies', suggestedReason: 'The source policy names this exception', objectLogicalId: RULE_OBJECT_ID, valueType: 'boolean', minCardinality: 0, maxCardinality: 1 },
        { logicalId: 'inspection_required', displayName: 'Inspection required', businessMeaning: 'Whether the source rule requires an inspection', suggestedReason: 'The source policy states this conclusion', objectLogicalId: RULE_OBJECT_ID, valueType: 'boolean', minCardinality: 0, maxCardinality: 1 },
        { logicalId: 'inspection_policy_code', displayName: 'Inspection policy code', businessMeaning: 'The source policy code used for the inspection requirement rule', suggestedReason: 'The policy source defines this field for its synthetic registry', objectLogicalId: RULE_OBJECT_ID, valueType: 'string', minCardinality: 0, maxCardinality: 1 },
      ],
    })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const frame of [
      { id: 'tasktypes-model', object: 'chat.completion.chunk', created: 1, model: 'tasktypes-controlled', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
      { id: 'tasktypes-model', object: 'chat.completion.chunk', created: 1, model: 'tasktypes-controlled', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'tasktypes-model', object: 'chat.completion.chunk', created: 1, model: 'tasktypes-controlled', choices: [], usage: { prompt_tokens: 10, completion_tokens: 12 } },
    ]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve, reject) => {
    modelServer?.once('error', reject)
    modelServer?.listen(0, '127.0.0.1', resolve)
  })
  const address = modelServer.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

function recordWorkerError(error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  workerErrors.push({ duringClose: closingComposition, name: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }), message: error instanceof Error ? error.message : String(error) })
}

function trustedContext(scope: ScopeRef): ToolContext {
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: 'tasktypes-author', roles: ['platform-admin', 'operator', 'data-editor', 'semantic-publisher', 'semantic-reviewer'], scopes: [], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: '2026-09-30T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    allowedResources: { tenantId: scope.tenantId, spaceId: scope.spaceId, resourceKinds: ['artifact', 'document', 'chunk', 'dataset', 'computation', 'evidence', 'plan', 'job'], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 1_000 },
    traceId: `tasktypes:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `tasktypes-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Task types'])
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const base = new URL(container.adminUrl)
  appUrl = `${base.protocol}//${encodeURIComponent('ontology_app')}:${encodeURIComponent(APP_PASSWORD)}@${base.hostname}:${base.port}/${base.pathname.replace(/^\//, '')}`
}

async function archiveComputeInput(): Promise<ResourceRef> {
  if (cachedApprovedInput !== undefined) return cachedApprovedInput
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const writer = createBlobArtifactWriter(new LocalImmutableBlobStore({ objectStore, registry }))
    const stored = await writer.putBytes({ scopeRef, content: new TextEncoder().encode(canonicalJson(COMPUTE_INPUT)), mediaType: 'application/json' }, trustedContext(scopeRef))
    cachedApprovedInput = stored.blobRef
    return stored.blobRef
  } finally {
    await registry.close().catch(() => undefined)
  }
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
}

async function jsonBody(response: Response): Promise<{ data: Record<string, unknown> }> {
  return await response.json() as { data: Record<string, unknown> }
}

async function postJson(path: string, body: unknown, idempotencyKey: string, revision?: string): Promise<Response> {
  return request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey,
    ...(revision === undefined ? {} : { 'if-match': revision }) }, body: JSON.stringify(body) })
}

async function appendProjectPins(projectId: string, input: { readonly approvedInputRef?: ResourceRef; readonly documentSetRef?: ResourceRef; readonly semanticPublicationRefs?: readonly VersionRef[]; readonly reason: string }): Promise<void> {
  const projectRoute = `/api/v1/projects/${encodeURIComponent(projectId)}`
  const projectResponse = await request(projectRoute)
  if (!projectResponse.ok) throw new Error(`actual project read failed: ${await projectResponse.text()}`)
  const project = (await jsonBody(projectResponse)).data['project'] as { headRevision: string }
  const statusResponse = await request(`${projectRoute}/document-index`)
  if (!statusResponse.ok) throw new Error(`actual document index status read failed: ${await statusResponse.text()}`)
  const status = (await jsonBody(statusResponse)).data['status'] as { visibilityEpoch?: string }
  const projectService = composition?.dependencies.api?.projects?.service
  if (projectService === undefined) throw new Error('the real Core project revision service is not mounted')
  await projectService.appendRevision(projectId, {
    expectedRevision: project.headRevision,
    reason: input.reason,
    ...(input.approvedInputRef === undefined ? {} : { approvedInputRef: input.approvedInputRef }),
    ...(input.documentSetRef === undefined ? {} : { documentSetRef: input.documentSetRef }),
    ...(input.semanticPublicationRefs === undefined ? {} : { semanticPublicationRefs: input.semanticPublicationRefs }),
    ...(status.visibilityEpoch === undefined ? {} : { sourceVisibilityEpoch: status.visibilityEpoch }),
  }, `tasktypes-revision-${projectId}-${randomUUID()}`, 'tasktypes-author', trustedContext(scopeRef))
}

async function currentProjectRevision(projectId: string): Promise<ProjectRevisionRef> {
  const projectResponse = await request(`/api/v1/projects/${encodeURIComponent(projectId)}`)
  if (!projectResponse.ok) throw new Error(`actual project read failed: ${await projectResponse.text()}`)
  const project = (await jsonBody(projectResponse)).data['project'] as { headRevision: string }
  const revisionResponse = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(project.headRevision)}`)
  if (!revisionResponse.ok) throw new Error(`actual project revision read failed: ${await revisionResponse.text()}`)
  const revision = (await jsonBody(revisionResponse)).data['revision'] as { ref: ProjectRevisionRef }
  return revision.ref
}

async function waitForSemanticReadiness(projectId: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastBody = ''
  while (Date.now() < deadline) {
    const response = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/readiness?required=published_semantics`)
    lastBody = await response.text()
    if (!response.ok) throw new Error(`actual semantic readiness read failed: ${String(response.status)} ${lastBody}`)
    const envelope: unknown = JSON.parse(lastBody)
    if (!isRecord(envelope) || !isRecord(envelope['data'])) throw new Error('actual semantic readiness response was malformed')
    if (envelope['data']['ready'] === true) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Core worker did not mark the exact active project revision semantics ready: ${lastBody}`)
}

async function createTaskTypesCompetency(input: { readonly workspaceId: string; readonly exampleSetId: string; readonly policyRef: ResourceRef; readonly policyText: string; readonly definitionRef: VersionRef; readonly ruleRef: VersionRef }): Promise<VersionRef> {
  const nativeCsv = 'facility_id,network_code,facility_district_code,inspection_due,inspection_exempt,inspection_required\nFAC-001,demo-network,north,true,false,true\n'
  const uploaded = await request('/api/v1/competency-question-sources', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-source-media-type': 'text/csv' }, body: nativeCsv,
  })
  const uploadText = await uploaded.text()
  if (!uploaded.ok) throw new Error(`actual competency CSV upload failed: ${String(uploaded.status)} ${uploadText}`)
  const uploadEnvelope: unknown = JSON.parse(uploadText)
  if (!isRecord(uploadEnvelope) || !isRecord(uploadEnvelope['data']) || !isVersionRef(uploadEnvelope['data']['sourceRef'])) throw new Error('actual competency CSV upload did not return a source version')
  const csvRef = uploadEnvelope['data']['sourceRef']
  const policyVersionRef = { id: input.policyRef.id, version: input.policyRef.version, digest: input.policyRef.digest }
  const csvLocation = { sourceRef: csvRef, startOffset: 0, endOffset: Buffer.byteLength(nativeCsv, 'utf8'), quoteDigest: csvRef.digest, offsetUnit: 'utf8_byte' as const }
  const policyLocation = { sourceRef: policyVersionRef, startOffset: 0, endOffset: Buffer.byteLength(input.policyText, 'utf8'), quoteDigest: input.policyRef.digest, offsetUnit: 'utf8_byte' as const }
  const projectId = randomUUID()
  const caseId = randomUUID()
  const questionId = randomUUID()
  const body = {
    schemaVersion: 'competency-questions@1', classification: 'synthetic_demo_not_an_industry_standard', execution: 'not_run',
    industryId: 'synthetic-transport-facility', definitionRefs: [input.definitionRef], ruleRefs: [input.ruleRef],
    sourceRefs: [policyVersionRef, csvRef], allowedCapabilities: ['semantic_read'],
    externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] },
    questions: [{
      questionId, question: 'FAC-001 的 inspection_due=true 且 inspection_exempt=false 时，该原文规则是否适用并得出inspection_required=true？',
      taskKind: 'rule_judgement', definitionRef: input.definitionRef, ruleRefs: [input.ruleRef],
      input: { dataMode: 'synthetic', scopeRef, projectId, validAt: '2026-10-10T00:00:00Z', asOfRecordedSeq: '1',
        observations: [
          { factId: `${caseId}:facility-id`, entityId: 'FAC-001', objectId: RULE_OBJECT_ID, attributeId: 'facility_id', value: 'FAC-001', recordedSeq: '1', status: 'active', source: csvLocation },
          { factId: `${caseId}:inspection-due`, entityId: 'FAC-001', objectId: RULE_OBJECT_ID, attributeId: 'inspection_due', value: true, recordedSeq: '1', status: 'active', source: csvLocation },
          { factId: `${caseId}:inspection-exempt`, entityId: 'FAC-001', objectId: RULE_OBJECT_ID, attributeId: 'inspection_exempt', value: false, recordedSeq: '1', status: 'active', source: csvLocation },
          { factId: `${caseId}:inspection-required`, entityId: 'FAC-001', objectId: RULE_OBJECT_ID, attributeId: 'inspection_required', value: true, recordedSeq: '1', status: 'active', source: csvLocation },
        ], relations: [], structuredSources: [{ sourceRef: csvRef, objectId: RULE_OBJECT_ID, attributeIds: ['facility_id', 'network_code', 'facility_district_code', 'inspection_due', 'inspection_exempt', 'inspection_required'] }],
      },
      intent: { kind: 'rule', projectId, objectId: RULE_OBJECT_ID, subjectEntityId: 'FAC-001', ruleId: 'inspection-due-policy' },
      requiredCapabilities: ['semantic_read'], requiredSources: [policyLocation, csvLocation],
      expected: { kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: 'true' },
      goldOrigin: 'authored_oracle',
      derivation: '独立核验原始政策：inspection_due=true使适用条件成立，inspection_exempt=false不构成例外，政策明示结论inspection_required=true。',
      specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'],
    }],
  }
  const proposedRef = { id: randomUUID(), version: '1.0.0', digest: contentDigestOf(body) }
  const savedResponse = await postJson('/api/v1/competency-question-sets', { ref: proposedRef, body }, `tasktypes-cq-save-${input.workspaceId}`)
  if (!savedResponse.ok) throw new Error(`actual independent competency save failed: ${await savedResponse.text()}`)
  const saved = (await jsonBody(savedResponse)).data as { approvalRequired: boolean; candidateId: string; declaration: { ref: VersionRef; body: unknown } }
  if (!saved.approvalRequired || saved.candidateId !== saved.declaration.ref.id || saved.declaration.ref.digest !== proposedRef.digest || contentDigestOf(saved.declaration.body) !== proposedRef.digest) {
    throw new Error('competency service did not mint the exact independently authored body as a review candidate')
  }
  const review = await postJson(`/api/v1/candidates/${saved.candidateId}/reviews`, {
    decision: 'approve', reason: 'Human independently checked the exact OR/exception input against the actual source locations',
  }, `tasktypes-cq-review-${input.workspaceId}`, '0')
  if (!review.ok) throw new Error(`actual competency human review failed: ${await review.text()}`)
  const readback = await postJson('/api/v1/competency-question-sets/read', { ref: saved.declaration.ref }, `tasktypes-cq-read-${input.workspaceId}`)
  if (!readback.ok) throw new Error(`actual approved competency readback failed: ${await readback.text()}`)
  const readbackData = (await jsonBody(readback)).data as { approved: boolean; declaration: { body: unknown } }
  if (!readbackData.approved || contentDigestOf(readbackData.declaration.body) !== saved.declaration.ref.digest) throw new Error('approved competency readback did not preserve the authored body')
  return saved.declaration.ref
}

async function publishActualInspectionRule(): Promise<{ readonly packRef: VersionRef; readonly profileRef: { id: string; version: string }; readonly definitionRef: VersionRef }> {
  const workspaceKey = `tasktypes-rule-workspace-${randomUUID()}`
  const bootstrap = await postJson('/api/v1/core/workspace-bootstrap', {
    namespace: 'synthetic-transport-facility',
    displayName: 'Task types reviewed rule source',
    boundary: { goals: ['review transport facility inspection rules'], included: ['transport facility registry'], excluded: ['pricing'], applicability: {} },
  }, workspaceKey)
  if (bootstrap.status !== 201) throw new Error(`actual rule workspace bootstrap failed: ${await bootstrap.text()}`)
  const bootstrapData = (await jsonBody(bootstrap)).data as { workspace: { workspaceId: string; headRevision: string } }
  const workspaceId = bootstrapData.workspace.workspaceId
  const sourceHead = bootstrapData.workspace.headRevision
  const upload = await postJson(`/api/v1/core/workspaces/${workspaceId}/sources`, {
    name: 'transport-inspection-policy.txt', mediaType: 'text/plain', contentEncoding: 'base64',
    content: Buffer.from(POLICY_TEXT, 'utf8').toString('base64'),
  }, `tasktypes-rule-source-${workspaceId}`, sourceHead)
  if (!upload.ok) throw new Error(`actual rule source upload failed: ${await upload.text()}`)
  const sourceData = (await jsonBody(upload)).data['source'] as { sourceRef: ResourceRef }
  const sourceRef = sourceData.sourceRef
  const grounding = await postJson(`/api/v1/industry-workspaces/${workspaceId}/source-grounding`, { sourceRefs: [sourceRef] }, `tasktypes-rule-grounding-${workspaceId}`)
  if (!grounding.ok) throw new Error(`actual rule-source grounding failed: ${await grounding.text()}`)
  const groundingData = (await jsonBody(grounding)).data as { fragments: { sourceIndex: number; fragmentIndex: number; sourceRef: ResourceRef; content: { kind: string; text?: string } }[] }
  const firstFragment = groundingData.fragments[0]
  if (firstFragment?.sourceIndex !== 0 || firstFragment.fragmentIndex !== 0 || firstFragment.sourceRef.id !== sourceRef.id ||
    firstFragment.content.kind !== 'text' || !firstFragment.content.text?.includes('inspection_due is true') || !firstFragment.content.text.includes('inspection_exempt is true') || !firstFragment.content.text.includes('inspection_required=true')) {
    throw new Error('the actual rule-source fragment does not contain the reviewed conditions and conclusion')
  }
  const generationWorkspaceResponse = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!generationWorkspaceResponse.ok) throw new Error(`actual rule workspace read before definition generation failed: ${await generationWorkspaceResponse.text()}`)
  const generationHead = ((await jsonBody(generationWorkspaceResponse)).data['workspace'] as { headRevision: string }).headRevision
  const authoringContextResponse = await request(`/api/v1/core/workspaces/${workspaceId}/authoring-context`)
  if (!authoringContextResponse.ok) throw new Error(`actual registered authoring policy read failed: ${await authoringContextResponse.text()}`)
  const generationPolicyValue = ((await jsonBody(authoringContextResponse)).data['generationPolicyRef'])
  if (!isRecord(generationPolicyValue) || typeof generationPolicyValue['id'] !== 'string' || typeof generationPolicyValue['version'] !== 'string' || typeof generationPolicyValue['digest'] !== 'string') {
    throw new Error('the server did not return its exact registered definition-generation policy')
  }
  const generationPolicyRef: VersionRef = { id: generationPolicyValue['id'], version: generationPolicyValue['version'], digest: generationPolicyValue['digest'] }
  const generatedResponse = await postJson(`/api/v1/industry-workspaces/${workspaceId}/generations`, {
    kinds: ['object', 'attribute'], generationPolicyRef, sourceRefs: [sourceRef],
  }, `tasktypes-definition-generation-${workspaceId}`, generationHead)
  if (generatedResponse.status !== 201) throw new Error(`actual controlled-model definition generation failed: ${await generatedResponse.text()}`)
  const generatedCandidates = (await jsonBody(generatedResponse)).data['candidates'] as { candidateId: string; kind: string; payload: { logicalId?: string }; contentDigest: string }[]
  if (generatedCandidates.length !== 8 || !generatedCandidates.some((candidate) => candidate.kind === 'object' && candidate.payload.logicalId === RULE_OBJECT_ID) ||
    !generatedCandidates.some((candidate) => candidate.kind === 'attribute' && candidate.payload.logicalId === 'inspection_policy_code')) {
    throw new Error('the controlled model did not return the complete source-supported transport TBox')
  }
  for (const generated of generatedCandidates) {
    const currentWorkspaceResponse = await request(`/api/v1/industry-workspaces/${workspaceId}`)
    if (!currentWorkspaceResponse.ok) throw new Error(`actual rule workspace read before definition confirmation failed: ${await currentWorkspaceResponse.text()}`)
    const expectedRevision = ((await jsonBody(currentWorkspaceResponse)).data['workspace'] as { headRevision: string }).headRevision
    const sourceConfirmed = await postJson(`/api/v1/industry-workspaces/${workspaceId}/candidates/${generated.candidateId}/source-confirmations`, {
      contentDigest: generated.contentDigest, sourceRef, fragmentIndex: 0,
      reason: 'Human checked this generated definition against the actual uploaded and grounded policy text',
    }, `tasktypes-definition-source-confirm-${generated.candidateId}`, expectedRevision)
    if (!sourceConfirmed.ok) throw new Error(`actual generated definition source confirmation failed: ${await sourceConfirmed.text()}`)
    const confirmedCandidates = ((await jsonBody(sourceConfirmed)).data['candidates'] as { candidateId: string; contentDigest: string }[])
    const confirmed = confirmedCandidates.find((candidate) => candidate.candidateId !== generated.candidateId)
    if (confirmed === undefined) throw new Error(`source confirmation returned no immutable current candidate for ${generated.candidateId}`)
    const latestReviewsResponse = await request(`/api/v1/candidates/${confirmed.candidateId}/reviews`)
    if (!latestReviewsResponse.ok) throw new Error(`definition candidate review history failed: ${await latestReviewsResponse.text()}`)
    const priorReviews = ((await jsonBody(latestReviewsResponse)).data['reviews'] as { revision: string }[])
    const latestReviewRevision = priorReviews.reduce((latest, review) => BigInt(review.revision) > BigInt(latest) ? review.revision : latest, '0')
    const definitionApproval = await postJson(`/api/v1/candidates/${confirmed.candidateId}/reviews`, {
      decision: 'approve', reason: 'Human approved the exact source-confirmed current definition revision',
    }, `tasktypes-definition-review-${confirmed.candidateId}`, latestReviewRevision)
    if (!definitionApproval.ok) throw new Error(`actual definition human review failed: ${await definitionApproval.text()}`)
  }
  const sourceSelections = ['applicability', 'condition', 'exceptions[0]', 'exceptions[0].condition', 'conclusion']
    .map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 }))
  const currentWorkspace = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!currentWorkspace.ok) throw new Error(`actual rule workspace read failed: ${await currentWorkspace.text()}`)
  const headRevision = ((await jsonBody(currentWorkspace)).data['workspace'] as { headRevision: string }).headRevision
  const ingested = await postJson(`/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/ingest`, {
    sourceRefs: [sourceRef],
    rules: [{
      kind: 'rule', ruleId: 'inspection-due-policy', objectId: RULE_OBJECT_ID,
      displayName: 'Inspection due policy',
      businessMeaning: 'A due inspection requires an inspection unless an explicit exemption applies',
      suggestedReason: 'Human reviewed the actual local synthetic transport policy text',
      applicabilityNote: 'For one transport facility in the registered synthetic scenario',
      condition: { op: 'compare', attributeId: 'inspection_due', operator: 'eq', value: true },
      exceptions: [{ exceptionId: 'inspection_exempt', condition: { op: 'compare', attributeId: 'inspection_exempt', operator: 'eq', value: true } }],
      conclusion: { predicate: 'inspection_required', value: true },
      ruleDependencies: [], sourceSelections,
    }],
  }, `tasktypes-rule-ingest-${workspaceId}`, headRevision)
  if (ingested.status !== 201) throw new Error(`actual rule candidate ingest failed: ${await ingested.text()}`)
  const initial = ((await jsonBody(ingested)).data['rules'] as { candidateId: string; contentDigest: string }[])[0]
  if (initial === undefined) throw new Error('the real rule candidate ingestion returned no candidate')
  const latestWorkspace = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!latestWorkspace.ok) throw new Error(`current rule workspace read failed: ${await latestWorkspace.text()}`)
  const latestHead = ((await jsonBody(latestWorkspace)).data['workspace'] as { headRevision: string }).headRevision
  const confirmation = await postJson(`/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${initial.candidateId}/source-confirmations`, {
    contentDigest: initial.contentDigest, sourceRefs: [sourceRef], sourceSelections,
    reason: 'Human checked applicability, condition, exception and conclusion against the actual original policy text',
  }, `tasktypes-rule-source-confirm-${workspaceId}`, latestHead)
  if (!confirmation.ok) throw new Error(`actual rule source confirmation failed: ${await confirmation.text()}`)
  const current = ((await jsonBody(confirmation)).data['candidates'] as { candidateId: string; contentDigest: string }[])[0]
  if (current === undefined || current.candidateId === initial.candidateId) throw new Error('source confirmation did not return the immutable current rule candidate')
  const approval = await postJson(`/api/v1/candidates/${current.candidateId}/reviews`, {
    decision: 'approve', reason: 'Human approved the exact source-confirmed inspection rule revision',
  }, `tasktypes-rule-review-${workspaceId}`, '0')
  if (!approval.ok) throw new Error(`actual rule candidate review failed: ${await approval.text()}`)
  const afterReview = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!afterReview.ok) throw new Error(`current rule workspace read failed: ${await afterReview.text()}`)
  const enableHead = ((await jsonBody(afterReview)).data['workspace'] as { headRevision: string }).headRevision
  const enabled = await postJson(`/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${current.candidateId}/enable`, {}, `tasktypes-rule-enable-${workspaceId}`, enableHead)
  if (!enabled.ok) throw new Error(`actual reviewed rule enable failed: ${await enabled.text()}`)
  const currentHeadResponse = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!currentHeadResponse.ok) throw new Error(`rule workspace read before synthetic validation failed: ${await currentHeadResponse.text()}`)
  const currentHead = ((await jsonBody(currentHeadResponse)).data['workspace'] as { headRevision: string }).headRevision
  const caseId = `tasktypes-${randomUUID()}`
  const exampleSetResponse = await postJson(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets`, {
    caseKinds: ['contradiction'],
    cases: [{ caseId, caseKind: 'contradiction', objectTypeRef: RULE_OBJECT_ID, fields: [
      { fieldId: 'facility_id', value: 'FAC-001' }, { fieldId: 'inspection_due', value: true },
      { fieldId: 'inspection_exempt', value: false }, { fieldId: 'inspection_required', value: true },
    ] }],
    expectations: [{ expectationId: `${caseId}-expected`, caseId, kind: 'rule', ruleId: 'inspection-due-policy', expected: 'true',
      origin: 'authored_oracle', reason: 'The source rule applies to a due, non-exempt facility.', confirmedBy: 'tasktypes-reviewer', confirmedAt: '2026-10-11T00:00:00Z' }],
  }, `tasktypes-example-set-${workspaceId}`, currentHead)
  if (exampleSetResponse.status !== 201) throw new Error(`actual authored synthetic example set failed: ${await exampleSetResponse.text()}`)
  const exampleSetId = ((await jsonBody(exampleSetResponse)).data['exampleSet'] as { exampleSetId: string }).exampleSetId
  const beforePreview = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!beforePreview.ok) throw new Error(`actual rule workspace read before execution preview failed: ${await beforePreview.text()}`)
  const previewHead = ((await jsonBody(beforePreview)).data['workspace'] as { headRevision: string }).headRevision
  const preview = await postJson(`/api/v1/core/workspaces/${workspaceId}/execution-preview`, { exampleSetId }, `tasktypes-execution-preview-${workspaceId}`, previewHead)
  if (!preview.ok) throw new Error(`actual Core execution preview failed: ${await preview.text()}`)
  const previewData = (await jsonBody(preview)).data as { definitionRef: VersionRef; ruleRefs: VersionRef[] }
  if (!isVersionRef(previewData.definitionRef) || previewData.ruleRefs.length !== 1 || previewData.ruleRefs[0] === undefined) throw new Error('execution preview omitted the exact current rule and definition versions')
  const competencyQuestionRef = await createTaskTypesCompetency({ workspaceId, exampleSetId, policyRef: sourceRef, policyText: POLICY_TEXT,
    definitionRef: previewData.definitionRef, ruleRef: previewData.ruleRefs[0] })
  const beforeValidation = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!beforeValidation.ok) throw new Error(`rule workspace read before validation failed: ${await beforeValidation.text()}`)
  const validationHead = ((await jsonBody(beforeValidation)).data['workspace'] as { headRevision: string }).headRevision
  const validationStrategy = { kind: 'new_version' as const, reason: 'Publish the exact human-reviewed source rule as a new transport package version' }
  const validationResponse = await postJson(`/api/v1/industry-workspaces/${workspaceId}/validations`, {
    exampleSetId, competencyQuestionRef, definitionRef: previewData.definitionRef,
    strategy: validationStrategy,
  }, `tasktypes-validation-${workspaceId}`, validationHead)
  if (validationResponse.status !== 201) throw new Error(`actual industry validation failed: ${await validationResponse.text()}`)
  const report = ((await jsonBody(validationResponse)).data['validation']) as { validationId: string; publishable: boolean; semanticPublished: { passed: boolean }; competency?: { passed: boolean } }
  if (!report.publishable || !report.semanticPublished.passed || report.competency?.passed !== true) throw new Error(`actual independent validation did not pass every publication gate: ${JSON.stringify(report)}`)
  const beforePublication = await request(`/api/v1/industry-workspaces/${workspaceId}`)
  if (!beforePublication.ok) throw new Error(`rule workspace read before package publication failed: ${await beforePublication.text()}`)
  const publicationHead = ((await jsonBody(beforePublication)).data['workspace'] as { headRevision: string }).headRevision
  const packVersion = '1.0.0'
  const packPublication = await postJson(`/api/v1/industry-workspaces/${workspaceId}/publications`, {
    packId: 'task-types-transport', version: packVersion, validationId: report.validationId, strategy: validationStrategy,
  }, `tasktypes-pack-publication-${workspaceId}`, publicationHead)
  if (!packPublication.ok) throw new Error(`actual validated industry package publication failed: ${await packPublication.text()}`)
  const publishedData = (await jsonBody(packPublication)).data as { packRef: unknown; pack: { definitionRef: unknown } }
  const packRef = publishedData.packRef
  if (!isVersionRef(packRef)) throw new Error('actual package publication returned no immutable pack reference')
  const publishedDefinitionRef = publishedData.pack.definitionRef
  if (!isVersionRef(publishedDefinitionRef)) throw new Error('actual package publication returned no exact definition reference')
  const configured = await postJson('/api/v1/core/published-pack-profiles', { packRef }, `tasktypes-pack-profile-${workspaceId}`)
  if (!configured.ok) throw new Error(`Core profile configuration for the actual published pack failed: ${await configured.text()}`)
  const profile = (await jsonBody(configured)).data as { purpose: string; packRef: VersionRef; definitionRef: VersionRef; profileRef: { id: string; version: string } }
  if (profile.purpose !== 'business_project_configuration' || canonicalJson(profile.packRef) !== canonicalJson(packRef) ||
    canonicalJson(profile.definitionRef) !== canonicalJson(publishedDefinitionRef)) throw new Error('Core configured a different pack or definition than the exact validated publication')
  return { packRef, profileRef: { id: profile.profileRef.id, version: profile.profileRef.version }, definitionRef: profile.definitionRef }
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return (await jsonBody(response)).data
    if (response.status !== 202) {
      const causes = workerErrors.map((error) => JSON.stringify(error)).join('\n')
      const errorBody = await response.text()
      const runView = await request(`/api/v1/runs/${encodeURIComponent(runId)}`)
      const runText = await runView.text()
      const eventsResponse = await request(`/api/v1/runs/${encodeURIComponent(runId)}/events`)
      const eventsText = await eventsResponse.text()
      throw new Error(`answer route failed with ${String(response.status)}: ${errorBody}; run=${runText}; events=${eventsText}; workerDiagnostics=${causes}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the deadline`)
}

async function taskBindingRef(kind: string, projectId: string): Promise<{ id: string; version: string; digest: string }> {
  const response = await request(`/api/v1/core/projects/${encodeURIComponent(projectId)}/task-catalogue`)
  if (!response.ok) throw new Error(`actual project task catalogue read failed: ${await response.text()}`)
  const tasks = (await jsonBody(response)).data['tasks'] as { taskKind: string; bindingRef: { id: string; version: string; digest: string } }[]
  const binding = tasks.find((entry) => entry.taskKind === kind)
  if (binding === undefined) throw new Error(`the actual project has no ${kind} task binding for its pinned definition`)
  return binding.bindingRef
}

async function submitTask(input: { kind: string; parameters: Record<string, unknown>; idempotencyKey: string; projectRevisionRef?: ProjectRevisionRef; projectId?: string; approvedInputRef?: ResourceRef }): Promise<Response> {
  const deployment = await jsonBody(await request('/api/v1/core/deployment'))
  const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
  const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (mountedScenario === undefined || taskProfileRef === undefined) throw new Error('the actual task profile or transport task binding was not exposed')
  const revisionRef = input.projectRevisionRef ?? projectRevisionRefValue
  const projectId = input.projectId ?? PROJECT_ID
  const inputRef = input.approvedInputRef ?? approvedInputRef
  return request('/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      profileRef: taskProfileRef,
      question: 'host task run',
      context: { timeZone: 'UTC' },
      preferences: { route: 'template', allowWeb: false },
      task: {
        mode: 'task',
        projectRevisionRef: revisionRef,
        inputSnapshotRef: inputRef,
        inputSnapshotDigest: inputRef.digest,
        taskBindingRef: await taskBindingRef(input.kind, projectId),
        parameters: input.parameters,
      },
    }),
  })
}

async function readBack(runId: string, answer: Record<string, unknown>): Promise<void> {
  const answerId = answer['answerId']
  if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')
  const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
  if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
  expect((await jsonBody(result)).data['answerId']).toBe(answerId)

  const history = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/history`)
  if (history.status !== 200) throw new Error(`result history failed: ${await history.text()}`)
  expect((await jsonBody(history)).data['currentAnswerId']).toBe(answerId)

  const exported = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`)
  if (exported.status !== 200) throw new Error(`verified export failed: ${await exported.text()}`)
  const versions = (await jsonBody(exported)).data['versions'] as { answerId: string; contentHash: string }
  expect(versions.answerId).toBe(answerId)
  expect(versions.contentHash).toBe(answer['contentHash'])
}


beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-task-types-e2e-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)
  approvedInputRef = await archiveComputeInput()
  modelServerBaseUrl = await startControlledModelServer()
  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    modelsEnabled: true,
    onWorkerError: recordWorkerError,
    modelEnvironment: {
      CORE_ENABLE_MODELS: 'true',
      CORE_COMPANY_MODEL_BASE_URL: modelServerBaseUrl,
      CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
      CORE_COMPANY_MODEL_API_KEY: MODEL_SECRET,
      CORE_COMPANY_MODEL_PLATFORM_ID: 'core-company-extractor',
      CORE_COMPANY_MODEL_VENDOR_MODEL: 'tasktypes-controlled',
      CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
    },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
  web = await startWebHost(baseUrl, { bindDefaultProfile: false })
  browser = await chromium.launch({ headless: true })

  const deploymentResponse = await request('/api/v1/core/deployment')
  if (!deploymentResponse.ok) throw new Error(`the real deployment catalogue failed: ${await deploymentResponse.text()}`)
  const deployment = (await jsonBody(deploymentResponse)).data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
  const activeScenario = deployment.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (activeScenario === undefined) throw new Error('the actual transport scenario has no registered deployment profile')
  const taskPack = await publishActualInspectionRule()
  taskProfileRef = taskPack.profileRef
  const bootstrap = async (title: string, key: string): Promise<{ projectId: string; revision: ProjectRevisionRef }> => {
    const response = await postJson('/api/v1/core/project-bootstrap', { title, profileRef: taskPack.profileRef }, key)
    if (response.status !== 201) throw new Error(`actual Core project bootstrap failed: ${await response.text()}`)
    const payload = (await jsonBody(response)).data as { project: { projectId: string }; revision: { ref: ProjectRevisionRef } }
    return { projectId: payload.project.projectId, revision: payload.revision.ref }
  }
  const mainProject = await bootstrap('Task type source-backed project', `tasktypes-project-${randomUUID()}`)
  PROJECT_ID = mainProject.projectId
  const unreadyProject = await bootstrap('Task type readiness counterexample', `tasktypes-unready-${randomUUID()}`)
  UNREADY_PROJECT_ID = unreadyProject.projectId
  unreadyApprovedInputRef = approvedInputRef
  await appendProjectPins(PROJECT_ID, { approvedInputRef, reason: 'pin the actual controlled compute input for the registered-compute task fixture' })
  await appendProjectPins(UNREADY_PROJECT_ID, { approvedInputRef, reason: 'pin the same actual input for the deliberate readiness counterexample' })

  const policyImport = await postJson(`/api/v1/projects/${PROJECT_ID}/structured-imports`, {
    format: 'text', mediaType: 'text/plain', contentEncoding: 'utf-8', content: DOCUMENT_TEXT,
  }, `tasktypes-policy-import-${PROJECT_ID}`)
  if (policyImport.status !== 201) throw new Error(`actual policy-document import failed: ${await policyImport.text()}`)
  const policyImported = (await jsonBody(policyImport)).data as { documentSetRef?: ResourceRef; documentId?: string }
  if (policyImported.documentSetRef === undefined || typeof policyImported.documentId !== 'string') throw new Error('the real policy source was not registered in a project document set')
  await appendProjectPins(PROJECT_ID, { documentSetRef: policyImported.documentSetRef, reason: 'fix the actual uploaded policy document in this project revision' })

  const csv = 'facility_id,network_code,facility_district_code,inspection_due,inspection_exempt,inspection_required\nFAC-001,demo-network,north,true,false,true\n'
  const sourceImport = await postJson(`/api/v1/projects/${PROJECT_ID}/structured-imports`, {
    format: 'csv', mediaType: 'text/csv', contentEncoding: 'utf-8', content: csv, options: { headerRow: 1 },
  }, `tasktypes-facts-import-${PROJECT_ID}`)
  if (sourceImport.status !== 201) throw new Error(`actual project CSV import failed: ${await sourceImport.text()}`)
  const imported = (await jsonBody(sourceImport)).data as { parseId: string; originalRef: ResourceRef; originalMediaType: string; documentId?: string }
  if (typeof imported.documentId !== 'string') throw new Error('the actual CSV import returned no project document ID')
  const catalogueResponse = await request(`/api/v1/core/projects/${PROJECT_ID}/source-catalogue`)
  if (!catalogueResponse.ok) throw new Error(`actual source catalogue read failed: ${await catalogueResponse.text()}`)
  const catalogue = (await jsonBody(catalogueResponse)).data as {
    revision: { definitionRef: VersionRef }
    sources: { parseId: string; documentId: string; format?: string; originalRef: ResourceRef; originalMediaType: string; options?: Record<string, unknown>; tables: { columns: { columnIndex: number; header: string; headerDigest: string }[] }[] }[]
  }
  const actualSource = catalogue.sources.find((entry) => entry.parseId === imported.parseId && entry.documentId === imported.documentId)
  const actualTable = actualSource?.tables[0]
  if (actualSource === undefined || actualTable === undefined || actualSource.options === undefined) throw new Error('the current CSV source catalogue lacks its actual saved parse selection and headers')
  const mappingBody = {
    definitionRef: catalogue.revision.definitionRef,
    format: 'csv', parseId: imported.parseId, originalRef: imported.originalRef, originalMediaType: imported.originalMediaType,
    options: actualSource.options, objectId: RULE_OBJECT_ID,
    entries: actualTable.columns.map((column) => ({ fieldRef: column.header, columnIndex: column.columnIndex, header: column.header, headerDigest: column.headerDigest })),
  }
  const previewResponse = await postJson(`/api/v1/projects/${PROJECT_ID}/mappings/preview`, mappingBody, `tasktypes-map-preview-${PROJECT_ID}`)
  if (!previewResponse.ok) throw new Error(`actual mapping preview failed: ${await previewResponse.text()}`)
  const preview = (await jsonBody(previewResponse)).data['preview'] as { confirmable: boolean }
  if (!preview.confirmable) throw new Error('the independently validated actual CSV mapping is not confirmable')
  const mappingResponse = await postJson(`/api/v1/projects/${PROJECT_ID}/mappings`, mappingBody, `tasktypes-map-confirm-${PROJECT_ID}`)
  if (!mappingResponse.ok) throw new Error(`actual mapping confirmation failed: ${await mappingResponse.text()}`)
  const mapping = (await jsonBody(mappingResponse)).data['mapping'] as { mappingId: string; version: string }
  const boundResponse = await postJson(`/api/v1/projects/${PROJECT_ID}/records`, { parseId: imported.parseId, mappingId: mapping.mappingId, mappingVersion: mapping.version }, `tasktypes-record-bind-${PROJECT_ID}`)
  if (!boundResponse.ok) throw new Error(`actual project record binding failed: ${await boundResponse.text()}`)
  const bound = (await jsonBody(boundResponse)).data['records'] as { recordId: string; revision: string }[]
  if (bound.length !== 1 || bound[0] === undefined) throw new Error('the current actual source did not bind exactly one facility row')
  const stagedResponse = await postJson(`/api/v1/core/projects/${PROJECT_ID}/fact-candidates`, {
    documentId: imported.documentId, recordRefs: [{ recordId: bound[0].recordId, revision: bound[0].revision }],
    validFrom: RULE_VALIDITY.validFrom, validTo: RULE_VALIDITY.validTo,
  }, `tasktypes-facts-stage-${PROJECT_ID}`)
  if (stagedResponse.status !== 201) throw new Error(`actual source-backed fact staging failed: ${await stagedResponse.text()}`)
  const staged = (await jsonBody(stagedResponse)).data['candidates'] as { candidateId: string }[]
  factCandidateId = staged[0]?.candidateId ?? ''
  if (factCandidateId.length === 0) throw new Error('the actual record yielded no official fact candidate')
  const recordResponse = await postJson(`/api/v1/projects/${PROJECT_ID}/instance-records`, { candidateId: factCandidateId, documentId: imported.documentId }, `tasktypes-record-review-${PROJECT_ID}`)
  if (recordResponse.status !== 201) throw new Error(`actual record review creation failed: ${await recordResponse.text()}`)
  let reviewRecord = (await jsonBody(recordResponse)).data['record'] as { recordId: string; recordRevision: string; fields: { fieldId: string }[] }
  const reviewPath = `/api/v1/projects/${PROJECT_ID}/instance-records/${reviewRecord.recordId}`
  const fieldReview = await postJson(`${reviewPath}/field-confirmations`, { decisions: reviewRecord.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })) }, `tasktypes-field-review-${PROJECT_ID}`, reviewRecord.recordRevision)
  if (!fieldReview.ok) throw new Error(`actual field review failed: ${await fieldReview.text()}`)
  reviewRecord = (await jsonBody(fieldReview)).data['record'] as typeof reviewRecord
  const identityDecision = await postJson(`${reviewPath}/identity-decisions`, { kind: 'create', reason: 'human confirmed FAC-001 from the exact original facility identity column' }, `tasktypes-identity-${PROJECT_ID}`, reviewRecord.recordRevision)
  if (!identityDecision.ok) throw new Error(`actual identity decision failed: ${await identityDecision.text()}`)
  reviewRecord = (await jsonBody(identityDecision)).data['record'] as typeof reviewRecord
  const matchedEntityId = (reviewRecord as typeof reviewRecord & { identity?: { matchedEntityId?: string } }).identity?.matchedEntityId
  if (typeof matchedEntityId !== 'string' || matchedEntityId.length === 0) throw new Error('the actual identity decision returned no created entity ID')
  RULE_SUBJECT_ID = matchedEntityId
  for (const action of ['approve', 'publish'] as const) {
    const current = await request(reviewPath)
    if (!current.ok) throw new Error(`actual record review readback failed: ${await current.text()}`)
    reviewRecord = (await jsonBody(current)).data['record'] as typeof reviewRecord
    const decision = await postJson(`${reviewPath}/${action}`, {}, `tasktypes-${action}-${PROJECT_ID}`, reviewRecord.recordRevision)
    if (!decision.ok) throw new Error(`actual record ${action} failed: ${await decision.text()}`)
    reviewRecord = (await jsonBody(decision)).data['record'] as typeof reviewRecord
  }
  const candidateApproval = await postJson(`/api/v1/candidates/${factCandidateId}/reviews`, {
    decision: 'approve', reason: 'human independently reviewed the exact mapped facility facts and original source record',
  }, `tasktypes-candidate-review-${PROJECT_ID}`, '0')
  if (!candidateApproval.ok) throw new Error(`actual source-backed candidate review failed: ${await candidateApproval.text()}`)
  const publicationsResponse = await request('/api/v1/semantic-publications')
  if (!publicationsResponse.ok) throw new Error(`semantic publication ledger read failed: ${await publicationsResponse.text()}`)
  const publicationRows = (await jsonBody(publicationsResponse)).data['publications'] as { revision: string }[]
  const publicationRevision = publicationRows.at(-1)?.revision ?? '0'
  const semanticPublication = await postJson('/api/v1/semantic-publications', {
    approvedCandidateRefs: [{ candidateId: factCandidateId, kind: 'entity' }], schemaRef: catalogue.revision.definitionRef,
  }, `tasktypes-semantic-publication-${PROJECT_ID}`, publicationRevision)
  if (semanticPublication.status !== 201) throw new Error(`actual fact semantic publication failed: ${await semanticPublication.text()}`)
  const factPublicationRef = ((await jsonBody(semanticPublication)).data['versionRef'])
  if (!isVersionRef(factPublicationRef)) throw new Error('the official fact publication returned no version reference')
  await appendProjectPins(PROJECT_ID, {
    semanticPublicationRefs: [factPublicationRef],
    reason: 'pin the exact independently reviewed official fact publication to the current project revision; the rule is pinned by the actual immutable pack',
  })
  const indexBuild = await request(`/api/v1/projects/${PROJECT_ID}/document-index`, { method: 'POST' })
  if (indexBuild.status !== 202) throw new Error(`actual project document indexing failed: ${await indexBuild.text()}`)
  const indexDeadline = Date.now() + 30_000
  while (Date.now() < indexDeadline) {
    const statusResponse = await request(`/api/v1/projects/${PROJECT_ID}/document-index`)
    if (!statusResponse.ok) throw new Error(`actual project document index status failed: ${await statusResponse.text()}`)
    const status = (await jsonBody(statusResponse)).data['status'] as { state: string }
    if (status.state === 'ready') break
    if (status.state === 'failed') throw new Error('the actual project document index failed')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const finalIndex = (await jsonBody(await request(`/api/v1/projects/${PROJECT_ID}/document-index`))).data['status'] as { state: string }
  if (finalIndex.state !== 'ready') throw new Error('the actual project document index did not become ready')
  projectRevisionRefValue = await currentProjectRevision(PROJECT_ID)
  unreadyProjectRevisionRefValue = await currentProjectRevision(UNREADY_PROJECT_ID)
  await waitForSemanticReadiness(PROJECT_ID)
}, 300_000)

afterAll(async () => {
  closingComposition = true
  const failures: string[] = []
  const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try { await action() } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  await attempt('browser', async () => browser?.close())
  await attempt('web host', async () => web?.close())
  await attempt('Core API', async () => api?.close())
  await attempt('Core composition', async () => composition?.close())
  await attempt('controlled model HTTP server', async () => new Promise<void>((resolve, reject) => {
    if (modelServer === undefined) { resolve(); return }
    modelServer.close((error) => error === undefined ? resolve() : reject(error))
  }))
  await attempt('PostgreSQL admin client', async () => admin?.end())
  if (objectDirectory !== '') await attempt('owned object directory', async () => {
    const owned = resolve(objectDirectory), root = resolve(tmpdir())
    if (owned === root || !relative(root, owned).split(sep).every((segment) => segment.length > 0 && segment !== '..')) throw new Error('refusing cleanup outside the owned temporary root')
    await rm(owned, { recursive: true, force: true })
  })
  await attempt('owned PostgreSQL container and volume', async () => container?.stop())
  await record('v03-w08-worker-diagnostics', workerErrors.map((error) => JSON.stringify(error)))
  expect(failures, 'task-types owned resource teardown failures').toEqual([])
  expect(workerErrors, 'task-types worker failures including shutdown').toEqual([])
})

describe('W08 task-type browser/host E2E (real chromium, real host)', () => {
  it('[browser] loads the real deployment picker from the same host the task runs drive', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    try {
      await page.goto(`${web.origin}/?view=jobs`)
      await page.waitForSelector('[data-testid="core-deployment-picker"]')
      expect(await page.textContent('[data-testid="core-deployment-mode"]')).toContain('本地操作员')
      await capture(page, 'v03-w08-deployment-picker')
      await record('v03-w08-deployment-picker', ['mode=operator', 'served_by=loopback-static-host'])
    } finally {
      await context.close()
    }
  }, 120_000)

  it('[host-http] runs a registered-compute task and reads a verified answer@3 back', async () => {
    const response = await submitTask({ kind: 'compute', parameters: {}, idempotencyKey: `tasktypes-compute-${PROJECT_ID}` })
    if (response.status !== 202) throw new Error(`compute task admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('compute admission returned no run id')
    const answer = await waitForAnswer(runId)
    const v3 = answer['v3Body'] as { schemaVersion: string; claims?: { predicate: string; value: { value: string | number; unit: string } }[] }
    expect(v3.schemaVersion).toBe('answer-draft@3')
    expect(v3.claims).toContainEqual(expect.objectContaining({ predicate: 'total_quantity', value: { value: '12.5', unit: 'each' } }))
    expect(v3.claims).toContainEqual(expect.objectContaining({ predicate: 'total_cost', value: { value: '1.25', unit: 'CNY' } }))
    await readBack(runId, answer)
    await record('v03-w08-compute-answer', ['type=compute', 'total_quantity=12.5 each', 'total_cost=1.25 CNY', 'answer=answer-draft@3'])
  }, 180_000)

  it('[host-http] runs a document-QA task and reads a verified answer@3 with a real quote', async () => {
    const response = await submitTask({ kind: 'document_qa', parameters: { query: MATCHING_QUERY, limit: 5 }, idempotencyKey: `tasktypes-docqa-${PROJECT_ID}` })
    if (response.status !== 202) throw new Error(`document QA admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('document QA admission returned no run id')
    const answer = await waitForAnswer(runId)
    const v3 = answer['v3Body'] as { schemaVersion: string; assertions?: { kind: string; quote?: string }[] }
    expect(v3.schemaVersion).toBe('answer-draft@3')
    const citations = (v3.assertions ?? []).filter((entry) => entry.kind === 'document_quote')
    expect(citations.length).toBeGreaterThanOrEqual(1)
    expect(citations[0]?.quote).toContain('inspection interval')
    await readBack(runId, answer)
    await record('v03-w08-document-qa-answer', ['type=document_qa', 'citation=exact-span', 'answer=answer-draft@3'])
  }, 180_000)

  it('[host-http] runs a rule-judgement task and reads a verified answer@3 with provenance', async () => {
    const response = await submitTask({
      kind: 'rule_judgement',
      parameters: { rule: 'inspection-due-policy', entity: RULE_SUBJECT_ID, object: RULE_OBJECT_ID },
      idempotencyKey: `tasktypes-rule-${PROJECT_ID}`,
    })
    if (response.status !== 202) throw new Error(`rule task admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('rule admission returned no run id')
    const answer = await waitForAnswer(runId)
    const v3 = answer['v3Body'] as {
      schemaVersion: string
      assertions?: { kind: string; value?: string; subject?: string; judgementAxis?: string; ruleRef?: VersionRef; references?: { evidenceRef?: { id: string } }[] }[]
    }
    expect(v3.schemaVersion).toBe('answer-draft@3')
    const rules = (v3.assertions ?? []).filter((entry) => entry.kind === 'rule_judgement')
    expect(rules.length).toBeGreaterThanOrEqual(1)
    expect(rules[0]?.value).toBe('true')
    expect(rules[0]?.judgementAxis).toBe('applicability')
    expect(rules[0]?.subject).toBe(RULE_SUBJECT_ID)
    const evidenceRef = rules[0]?.references?.[0]?.evidenceRef
    if (evidenceRef === undefined) throw new Error('the rule assertion bound no evidence reference')
    const provenance = await request(`/api/v1/evidence/${encodeURIComponent(evidenceRef.id)}`)
    if (provenance.status !== 200) throw new Error(`provenance read failed: ${await provenance.text()}`)
    const provenanceData = (await jsonBody(provenance)).data as { kind: string; supportResolution?: { state?: string }; specification?: { spans?: unknown[] } }
    expect(provenanceData.kind).toBe('rule_derivation')
    expect(provenanceData.supportResolution?.state).toBe('resolved')
    expect((provenanceData.specification?.spans ?? []).length).toBeGreaterThanOrEqual(1)
    await readBack(runId, answer)
    await record('v03-w08-rule-judgement-answer', ['type=rule_judgement', 'judgementAxis=applicability', 'applicability=true', 'specification_span=resolved', 'answer=answer-draft@3'])
  }, 180_000)

  it('[host-http] counterexample: a rule run on a revision without published_semantics readiness is refused', async () => {
    // The readiness gate is not weakened: a rule-judgement task whose pinned revision has not
    // been marked `published_semantics` ready is refused at admission and can never publish.
    const response = await submitTask({
      kind: 'rule_judgement',
      parameters: { rule: 'inspection-due-policy', entity: RULE_SUBJECT_ID, object: RULE_OBJECT_ID },
      idempotencyKey: `tasktypes-rule-unready-${UNREADY_PROJECT_ID}`,
      projectRevisionRef: unreadyProjectRevisionRefValue,
      projectId: UNREADY_PROJECT_ID,
      approvedInputRef: unreadyApprovedInputRef,
    })
    expect(response.status).toBe(409)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('TASK_NOT_READY')
    await record('v03-w08-rule-readiness-counterexample', ['type=rule_judgement', 'admission=409 TASK_NOT_READY', 'reason=published_semantics readiness missing'])
  }, 120_000)
})
