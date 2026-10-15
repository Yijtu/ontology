import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, PostgresAssetCandidateStore, PostgresAssetWorkspaceStore, PostgresCandidateStore, PostgresIdentityDecisionStore, PostgresJobStore, PostgresRuleActionCandidateStore, PostgresSemanticPublicationStore, PostgresDefinitionEditingStore, PostgresSemanticDefinitionStore, PostgresPublishedPackAssetStore, PostgresSyntheticExampleSetStore, PostgresIndustryValidationReportStore } from '@ontology/adapter-control-postgres'
import { CompositeReviewableCandidateReader, DefinitionCandidateEditingService, IndustryWorkspaceService, InMemoryIndustrySchemaSource, IndustryValidationService, SyntheticExampleService, contentDigestOf } from '@ontology/application'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, SemanticPublicationService } from '@ontology/semantic-engine'
import { createApiServer, createCompetencyQuestionWorkflow, createRequestToolContext, registerCompetencyQuestionRoutes } from '@ontology/app-api'
import type { AssetCandidateBatch, AssetCandidateVersion, CompetencyQuestionSet, ScopeRef, ToolContext } from '@ontology/contracts'
import { loadCompetencyQuestions } from '../fixtures/competency-questions/loader'
import { COMPETENCY_SCOPE, byteDigest, competencyDigest } from '../fixtures/competency-questions/assets'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

let harness: JobDbHarness | undefined
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let workflow: ReturnType<typeof createCompetencyQuestionWorkflow>
let publisher: SemanticPublicationService
let definitions: PostgresAssetCandidateStore
let workspaces: PostgresAssetWorkspaceStore
let jobs: PostgresJobStore
let rootDirectory = ''
let baseUrl = ''
let otherScope: ScopeRef
let app: ReturnType<typeof createApiServer>

function context(scope: ScopeRef = COMPETENCY_SCOPE, roles = ['platform-admin']): ToolContext {
  return createRequestToolContext({ principal: { tenantId: scope.tenantId, subjectId: 'synthetic-cq-reviewer', roles, scopes: [], authEpoch: 1 }, spaceId: scope.spaceId, traceId: randomUUID(), runId: randomUUID() })
}
function declaration(label: string): CompetencyQuestionSet {
  const set = structuredClone(loadCompetencyQuestions()[0]!)
  set.body.questions[0]!.question += `（${label}）`
  set.ref.digest = competencyDigest(set.body)
  return set
}
async function review(id: string, decision: 'approve' | 'reject', reason: string) {
  const revision = await new PostgresSemanticPublicationStore(database).latestReviewRevision(COMPETENCY_SCOPE, id, context())
  return publisher.reviewCandidate({ candidateId: id, expectedRevision: revision, decision, reason }, context())
}

beforeAll(async () => {
  harness = await startJobDatabase()
  await harness.adminClient.query('INSERT INTO agent_platform.tenants(tenant_id,slug) VALUES($1,$2)', [COMPETENCY_SCOPE.tenantId, `cq-${randomUUID()}`])
  await harness.adminClient.query('INSERT INTO agent_platform.spaces(tenant_id,space_id,name) VALUES($1,$2,$3)', [COMPETENCY_SCOPE.tenantId, COMPETENCY_SCOPE.spaceId, 'Synthetic CQ approval'])
  otherScope = (await createJobScope(harness.adminClient, 'cq-foreign')).scopeRef
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 3 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  rootDirectory = await mkdtemp(join(tmpdir(), 'cq-approval-'))
  const objects = new FileSystemObjectStore(rootDirectory); await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
  const publications = new PostgresSemanticPublicationStore(database)
  workflow = createCompetencyQuestionWorkflow({ blobs, registry, reviews: publications })
  definitions = new PostgresAssetCandidateStore(database); workspaces = new PostgresAssetWorkspaceStore(database); jobs = new PostgresJobStore(database)
  const instances = new PostgresCandidateStore(database)
  const reader = new CompositeReviewableCandidateReader({ definition: definitions, instance: instances, ruleActions: new PostgresRuleActionCandidateStore(database), competencyQuestions: workflow.service })
  publisher = new SemanticPublicationService({ store: publications, candidates: instances, schemaSource: new InMemoryIndustrySchemaSource(), identity: new PostgresIdentityDecisionStore(database), reviewableCandidates: reader })
  const authenticate = () => ({ principal: context().principal, spaceId: COMPETENCY_SCOPE.spaceId })
  app = createApiServer({ authenticate, publications: { service: publisher } })
  registerCompetencyQuestionRoutes(app, { service: workflow.service, uploadSource: workflow.uploadSource, authenticate })
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
}, 60_000)

afterAll(async () => {
  await app.close()
  await registry?.close(); await database?.close(); await harness?.stop()
  if (rootDirectory !== '') {
    const owned = resolve(rootDirectory)
    if (!owned.startsWith(resolve(tmpdir(), 'cq-approval-'))) throw new Error('refusing cleanup outside the explicitly created CQ fixture directory')
    await rm(owned, { recursive: true, force: true })
  }
})

describe('actual immutable CQ bodies and the existing human approval ledger', () => {
  it('uploads a real body artifact through listening HTTP and approves through the ordinary review route', async () => {
    const source = declaration('ordinary-http')
    const response = await fetch(`${baseUrl}/api/v1/competency-question-sets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(source) })
    expect(response.status).toBe(201)
    const result = await response.json() as { data: { declaration: CompetencyQuestionSet; candidateId: string; approvalRequired: boolean } }
    const saved = result.data.declaration
    expect(result.data.approvalRequired).toBe(true)
    expect(saved.ref.id).not.toBe(source.ref.id)
    expect(saved.ref.digest).toBe(source.ref.digest)
    const raw = await blobs.readAuthorized({ scopeRef: COMPETENCY_SCOPE, blobRef: { ...saved.ref, kind: 'artifact' } }, context())
    expect(byteDigest(raw)).toBe(saved.ref.digest)
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual(source.body)
    expect(await workflow.service.readApproved(COMPETENCY_SCOPE, saved.ref, context())).toBeUndefined()
    const approved = await fetch(`${baseUrl}/api/v1/candidates/${saved.ref.id}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '0' }, body: JSON.stringify({ decision: 'approve', reason: 'human inspected independent inputs and authored gold' }) })
    expect(approved.status).toBe(200)
    expect(await workflow.service.readApproved(COMPETENCY_SCOPE, saved.ref, context())).toEqual(saved)
    expect(context().allowedResources.maxRows).toBe(0)
    expect(context().allowedResources.sourceRefs).toEqual([])
  })

  it('separates a full envelope hash from the body hash and never inherits approval after editing content', async () => {
    const invalid = declaration('envelope-hash')
    invalid.ref.digest = byteDigest(new TextEncoder().encode(JSON.stringify(invalid)))
    await expect(workflow.service.upload(invalid, context())).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    const first = await workflow.service.upload(declaration('original-content'), context())
    await review(first.ref.id, 'approve', 'human approved the original body')
    const edited = structuredClone(first); edited.body.questions[0]!.question += ' changed'; edited.ref.digest = competencyDigest(edited.body)
    const next = await workflow.service.upload(edited, context())
    expect(next.ref.id).not.toBe(first.ref.id)
    expect(await workflow.service.readApproved(COMPETENCY_SCOPE, next.ref, context())).toBeUndefined()
    expect(await workflow.service.readApproved(COMPETENCY_SCOPE, first.ref, context())).toEqual(first)
  })

  it('keeps same-content reapproval valid and a real rejection strict while retaining old review history', async () => {
    const saved = await workflow.service.upload(declaration('reaffirm'), context())
    const original = await review(saved.ref.id, 'approve', 'first actual human review')
    await review(saved.ref.id, 'approve', 'reaffirm identical semantic content')
    expect(await workflow.service.readApproved(COMPETENCY_SCOPE, saved.ref, context())).toEqual(saved)
    await review(saved.ref.id, 'reject', 'withdraw approval')
    expect(await workflow.service.readApproved(COMPETENCY_SCOPE, saved.ref, context())).toBeUndefined()
    expect(await new PostgresSemanticPublicationStore(database).getReview(COMPETENCY_SCOPE, saved.ref.id, original.revision, context())).toEqual(original)
  })

  it('refuses cross-scope metadata, unapproved version pins and non-editor uploads', async () => {
    const saved = await workflow.service.upload(declaration('scoped'), context())
    await review(saved.ref.id, 'approve', 'actual scoped body review')
    expect(await workflow.service.readApproved(otherScope, saved.ref, context(otherScope))).toBeUndefined()
    expect(await workflow.service.readBody(COMPETENCY_SCOPE, { ...saved.ref, digest: `sha256:${'f'.repeat(64)}` }, context())).toBeUndefined()
    await expect(workflow.service.upload(declaration('readonly'), context(COMPETENCY_SCOPE, ['business-user']))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(workflow.service.upload(declaration('foreign-inputs'), context(otherScope))).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('does not prioritize a CQ artifact over another real stored candidate with the same UUID', async () => {
    const saved = await workflow.service.upload(declaration('collision'), context())
    const created = await new IndustryWorkspaceService({ store: workspaces, jobs }).createWorkspace({ namespace: `cq-collision-${randomUUID()}`, displayName: 'Synthetic ambiguous review', boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: { ...saved.ref, kind: 'artifact' } }, `cq-create-${randomUUID()}`, 'synthetic-cq-reviewer', context())
    const workspaceId = created.workspace.workspaceId
    const draft = (await workspaces.listDrafts(COMPETENCY_SCOPE, workspaceId, context()))[0]!
    const batchId = randomUUID(), now = new Date().toISOString()
    const payload = { kind: 'object' as const, logicalId: 'real-collision', displayName: 'Real collision', businessMeaning: 'a separate actual definition family', suggestedReason: 'explicit test input', conflicts: [], identityAttributeIds: [] }
    const candidate: AssetCandidateVersion = { candidateId: saved.ref.id, batchId, workspaceId, domain: 'definition', logicalId: payload.logicalId, kind: 'object', payload, inputDraftRef: { workspaceId, revision: '1', digest: draft.digest }, sourceRefs: [], sourceSpans: [], state: 'produced', issues: [], pendingConfirmation: false, contentDigest: contentDigestOf(payload), idempotencyKey: contentDigestOf({ batchId, payload }), recordedAt: now }
    const pin = { id: 'authored-collision', version: '1.0.0', digest: contentDigestOf(payload) }
    const batch: AssetCandidateBatch = { batchId, workspaceId, domain: 'definition', inputDraftRef: candidate.inputDraftRef, modelRef: { modelId: 'synthetic-input-author', version: '1.0.0' }, responseSchemaRef: pin, documentSetRef: { ...saved.ref, kind: 'artifact' }, generationPolicyRef: pin, state: 'completed', counts: { total: 1, produced: 1, failed: 0, pendingConfirmation: 0, pendingReview: 0 }, idempotencyKey: `cq-batch-${batchId}`, requestDigest: contentDigestOf(batchId), createdBy: 'synthetic-cq-reviewer', recordedAt: now }
    await definitions.insertBatch(COMPETENCY_SCOPE, batch, [candidate], context())
    await expect(review(saved.ref.id, 'approve', 'must refuse ambiguous real families')).rejects.toMatchObject({ code: 'CANDIDATE_DOMAIN_UNPUBLISHABLE' })
    expect(await new PostgresSemanticPublicationStore(database).latestReviewRevision(COMPETENCY_SCOPE, saved.ref.id, context())).toBe('0')
  })

  it('archives actual source bytes over ordinary HTTP and keeps reader permission and byte pins independent', async () => {
    const bytes = new TextEncoder().encode('id,value\nCQ-01,12.5\n')
    const response = await fetch(`${baseUrl}/api/v1/competency-question-sources`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-source-media-type': 'text/csv' }, body: bytes })
    expect(response.status).toBe(201)
    const result = await response.json() as { data: { sourceRef: { id: string; version: string; digest: string } } }
    expect(result.data.sourceRef.digest).toBe(byteDigest(bytes))
    const read = await workflow.sources.readSource(COMPETENCY_SCOPE, result.data.sourceRef, context(), new AbortController().signal)
    expect(read).toBeDefined()
    expect([...read!]).toEqual([...bytes])
    expect(await workflow.sources.readSource(otherScope, result.data.sourceRef, context(otherScope), new AbortController().signal)).toBeUndefined()
  })

  it('keeps a genuine persisted report immutable but returns no late success after cancellation during its actual write', async () => {
    const ctx = context()
    const source = await workflow.service.upload(declaration('actual-report-cancel'), ctx)
    const created = await new IndustryWorkspaceService({ store: workspaces, jobs }).createWorkspace({ namespace: `cq-cancel-${randomUUID()}`, displayName: 'Actual cancellation boundary',
      boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: { ...source.ref, kind: 'artifact' } }, `cq-cancel-create-${randomUUID()}`, ctx.principal.subjectId, ctx)
    const workspaceId = created.workspace.workspaceId
    const sets = new PostgresSyntheticExampleSetStore(database)
    const set = await new SyntheticExampleService({ workspaces, sets }).generate(workspaceId, { expectedRevision: '1', idempotencyKey: `cq-cancel-examples-${randomUUID()}`, caseKinds: ['missing_parameter'],
      cases: [{ caseId: 'missing', caseKind: 'missing_parameter', objectTypeRef: 'unset', fields: [{ fieldId: 'missing', value: null }] }],
      expectations: [{ expectationId: 'missing', caseId: 'missing', kind: 'rule', ruleId: 'not-published', expected: 'unknown', origin: 'authored_oracle', reason: 'no published rule exists in this deliberately empty sandbox', confirmedBy: ctx.principal.subjectId, confirmedAt: new Date().toISOString() }] }, ctx.principal.subjectId, ctx)
    const realReports = new PostgresIndustryValidationReportStore(database)
    const candidates = new PostgresCandidateStore(database), reviews = new PostgresSemanticPublicationStore(database), ruleActions = new PostgresRuleActionCandidateStore(database)
    const editing = new DefinitionCandidateEditingService({ workspaces, candidates: definitions, editing: new PostgresDefinitionEditingStore(database), publishedDefinitions: new PostgresSemanticDefinitionStore(database),
      publishedPacks: new PostgresPublishedPackAssetStore(database), reviews, reviewableCandidates: new CompositeReviewableCandidateReader({ definition: definitions, instance: candidates, ruleActions, competencyQuestions: workflow.service }), terminology: { getTerminology: async () => undefined } })
    let entered: () => void = () => undefined, release: () => void = () => undefined
    const paused = new Promise<void>((resolve) => { entered = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const validator = new IndustryValidationService({ workspaces, exampleSets: sets, definitions: editing, ruleActions, support: new FiniteGrammarRuleSupportValidator(), evaluator: new FiniteGrammarSyntheticEvaluator(),
      reports: { get: realReports.get.bind(realReports), list: realReports.list.bind(realReports), findByIdempotencyKey: realReports.findByIdempotencyKey.bind(realReports), insert: async (...args) => {
        const saved = await realReports.insert(...args); entered(); await barrier; return saved
      } } })
    const key = `cq-real-report-write-${randomUUID()}`, controller = new AbortController()
    const pending = validator.validate(workspaceId, { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: key, signal: controller.signal }, ctx.principal.subjectId, ctx)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await paused
    const persisted = await realReports.findByIdempotencyKey(COMPETENCY_SCOPE, key, ctx)
    expect(persisted).toBeDefined()
    expect(persisted?.dataMode).toBe('synthetic')
    controller.abort(); release(); await rejected
    expect(await realReports.findByIdempotencyKey(COMPETENCY_SCOPE, key, ctx)).toEqual(persisted)
  })
})
