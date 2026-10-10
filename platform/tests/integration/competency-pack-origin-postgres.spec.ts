import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, PostgresCandidateStore, PostgresIdentityDecisionStore, PostgresInstanceReviewStore, PostgresJobStore, PostgresMaterializationStore, PostgresProfileStore, PostgresProjectReadinessStore, PostgresProjectStore, PostgresSemanticPublicationStore } from '@ontology/adapter-control-postgres'
import { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { CompetencyRunner, IndustryValidationService, ProjectService, StoreBackedIndustryPackCatalogue, InMemoryIndustrySchemaSource, competencyExecutionRequest, contentDigestOf, readWorkspacePublicationSourceDrafts } from '@ontology/application'
import { createBlobArtifactWriter, createCompetencyProjectPreparer, createCoreCompetencyExecution, createRequestToolContext } from '@ontology/app-api'
import { createToolContext, isRecord } from '@ontology/contracts'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, IdentityDecisionService, projectIndustrySchema, publishedRuleApplicabilityKey, publishedRuleRef } from '@ontology/semantic-engine'
import type { CompetencyQuestionSetBody, ProjectRevision, ResourceRef, ScopeRef, ToolContext } from '@ontology/contracts'
import { createPackOriginFixture } from './competency-pack-origin-fixture'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
let harness: JobDbHarness, db: ControlPostgresDatabase, registry: PostgresArtifactRegistry, parses: PostgresDocumentParseStore, structured: PostgresStructuredIngestionStore, blobs: LocalImmutableBlobStore, query: DuckDbProjectDatasetAdapter
let scope: ScopeRef, directory = ''
function context(): ToolContext { const base = createRequestToolContext({ principal: { tenantId: scope.tenantId, subjectId: 'actual-pack-reviewer', roles: ['platform-admin','profile-editor','semantic-reviewer','semantic-publisher','data-editor'], scopes: [], authEpoch: 1 }, spaceId: scope.spaceId, traceId: randomUUID(), runId: randomUUID() }); return createToolContext({ ...base, deadline: new Date(Date.now() + 300_000).toISOString() }) }
beforeAll(async () => {
  harness = await startJobDatabase(); const actual = await createJobScope(harness.adminClient, 'actual-pack-cq'); scope = actual.scopeRef
  db = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 }); registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  parses = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 2 }); structured = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  directory = await mkdtemp(join(tmpdir(), 'competency-pack-origin-')); const objects = new FileSystemObjectStore(directory); await objects.init(); blobs = new LocalImmutableBlobStore({ objectStore: objects, registry }); query = new DuckDbProjectDatasetAdapter({ instancePath: join(directory, 'business.duckdb') })
})
afterAll(async () => { await query?.close(); await structured?.close(); await parses?.close(); await registry?.close(); await db?.close(); await harness?.stop(); if (directory !== '') { const owned = resolve(directory); if (!owned.startsWith(resolve(tmpdir(), 'competency-pack-origin-'))) throw new Error('owned fixture cleanup escaped its exact temp prefix'); await rm(owned, { recursive: true, force: true }) } })
const fixture = (ctx: ToolContext, declarationKind?: 'business_conclusion') => createPackOriginFixture({ database: db, blobs, registry, parses, structured, scope, ctx, ...(declarationKind === undefined ? {} : { declarationKind }) })
async function bodyFor(f: Awaited<ReturnType<typeof fixture>>, ctx: ToolContext, oracle: 'applicability_only' | 'business_consequence') {
  const projectId = randomUUID(), policyLocation = { sourceRef: f.policy, startOffset: 0, endOffset: f.policyBytes.byteLength, quoteDigest: f.policy.digest, offsetUnit: 'utf8_byte' as const }, inputLocation = { sourceRef: f.original, startOffset: 0, endOffset: f.nativeBytes.byteLength, quoteDigest: f.original.digest, offsetUnit: 'utf8_byte' as const }
  const rule = f.rules[0]; if (rule === undefined) throw new Error('actual published pack rule missing')
  // Independent literal expected derives from the authored 8h policy and original9...h input,
  // never from materializer output. The production preparer receives no expected or derivation.
  const body: CompetencyQuestionSetBody = { schemaVersion: 'competency-questions@1', classification: 'synthetic_demo_not_an_industry_standard', execution: 'not_run', industryId: 'actual-pack-origin', definitionRefs: [f.definition.ref], ruleRefs: [rule.ruleRef], sourceRefs: [f.policy, f.original], allowedCapabilities: ['semantic_read'], externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] }, questions: [{ questionId: 'actual-pack-threshold', question: 'Does the actual published maintenance policy apply to original machine M-1?', taskKind: 'rule_judgement', definitionRef: f.definition.ref, ruleRefs: [rule.ruleRef], input: { dataMode: 'synthetic', scopeRef: scope, projectId, validAt: '2026-10-09T00:00:00Z', asOfRecordedSeq: '1', observations: [{ factId: 'original-hours', entityId: 'M-1', objectId: 'machine', attributeId: 'hours', value: { amount: '9.000000000000000001', unit: 'h' }, recordedSeq: '1', status: 'active', source: inputLocation }], relations: [], structuredSources: [{ sourceRef: f.original, objectId: 'machine', attributeIds: ['machine_id','hours','batch_note'] }] }, intent: { kind: 'rule', projectId, objectId: 'machine', subjectEntityId: 'M-1', ruleId: rule.ruleId }, requiredCapabilities: ['semantic_read'], requiredSources: [policyLocation, inputLocation], expected: { kind: 'rule', conditionState: 'true', applicability: 'applicable', propositionState: oracle === 'applicability_only' ? 'unknown' : 'true' }, goldOrigin: 'authored_oracle', derivation: 'The separately authored policy threshold8h is below the original exact input9.000000000000000001h.', specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'] }] }
  const declaration = await f.questionWorkflow.service.upload({ ref: { id: randomUUID(), version: '1.0.0', digest: contentDigestOf(body) }, body }, ctx)
  await f.review(declaration.ref.id)
  return declaration
}
function executionFor(f: Awaited<ReturnType<typeof fixture>>, prepare: Parameters<typeof createCoreCompetencyExecution>[0]['prepare']) {
  return createCoreCompetencyExecution({ prepare, sources: f.questionWorkflow.sources, artifacts: createBlobArtifactWriter(blobs), reader: { read: async (request, ctx) => { const ref = request.approvedInputRefs[0]; if (request.approvedInputRefs.length !== 1 || ref === undefined) throw new Error('one actual immutable execution artifact required'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx) } } })
}
function executor(f: Awaited<ReturnType<typeof fixture>>, options: { readonly bindingRef?: ResourceRef; readonly afterPrepare?: () => Promise<unknown> } = {}) {
  const actualPrepare = createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query, producerComponentRef: f.producerComponentRef, binding: async () => options.bindingRef ?? f.bindingRef, target: f.targetReader, publishedRules: f.publishedRules, packs: f.packs })
  const prepare = async (...args: Parameters<typeof actualPrepare>) => { const result = await actualPrepare(...args); if (result.status === 'prepared') await options.afterPrepare?.(); return result }
  const execution = executionFor(f, prepare)
  return { prepare, execution }
}
async function readArtifact(ref: ResourceRef, ctx: ToolContext) { const bytes = await blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx); const value: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!isRecord(value)) throw new Error('actual archive is not an object'); return value }

describe('actual current-domain published pack rule origin in competency execution', () => {
  it('keeps the real8 candidate/review/body through semantic-only publication and actual current-target validation', async () => {
    const ctx = context(), f = await fixture(ctx)
    expect(f.asset.capabilities).toMatchObject({ semanticPublished: true, deploymentExecutable: false })
    expect(f.rules).toHaveLength(1); expect(f.rules[0]?.sourceCandidateId).toBe(f.sourceRule.candidateId); expect(f.rules[0]).not.toHaveProperty('publicationId')
    expect(f.asset.ruleDeclarations?.[0]).toMatchObject({ candidateId: f.sourceRule.candidateId, contentDigest: f.sourceRule.contentDigest, reviewRevision: '1' })
    const checkpoint = await f.workspaces.getDraft(scope, f.workspace.workspaceId, f.workspace.headRevision, ctx)
    expect(checkpoint).toHaveProperty('publicationCheckpoint')
    if (checkpoint === undefined) throw new Error('actual current publication checkpoint draft is missing')
    expect(await f.targetReader(f.target, f.template, f.definition, f.rules, ctx, new AbortController().signal)).toBe(true)
    const edited = await f.workspaceService.draftOperation(f.workspace.workspaceId, { expectedRevision: f.workspace.headRevision, operation: 'edit', reason: 'human explicitly edits after the semantic publication checkpoint', documentSetRef: checkpoint.documentSetRef }, `real-edit-${randomUUID()}`, ctx.principal.subjectId, ctx)
    expect(edited.draft).not.toHaveProperty('publicationCheckpoint')
    expect(await f.targetReader({ ...f.target, revision: edited.workspace.headRevision }, f.template, f.definition, f.rules, ctx, new AbortController().signal)).toBe(false)
  })
  it('standalone: reads actual pack origin through genuine facts/materializer/producer/14 replay without claiming a current deployment gate', async () => {
    const ctx = context(), f = await fixture(ctx), declaration = await bodyFor(f, ctx, 'applicability_only')
    const global = new PostgresMaterializationStore(db)
    await global.openFence(scope, { fenceId: randomUUID(), reason: 'ordinary global projection fence must survive unrelated synthetic execution', propositionKeys: [], openedAt: new Date().toISOString() }, ctx)
    const before = { state: await global.getProjectionState(scope, ctx), fences: await global.listOpenFences(scope, ctx), slices: await global.readSlices(scope, { limit: 100 }, ctx) }
    const { execution, prepare } = executor(f)
    const question = declaration.body.questions[0]
    if (question === undefined) throw new Error('actual independent question absent')
    const request = competencyExecutionRequest(declaration.ref, question)
    const prepared = await prepare(request, ctx, new AbortController().signal)
    if (prepared.status !== 'prepared' || prepared.input.rules === undefined) throw new Error('actual preparation unavailable')
    expect(prepared.input.project.executionPurpose).toBe('synthetic_validation')
    expect(prepared.input.projection?.ref.id).toBe(`projection.competency.${prepared.input.project.ref.projectId}`)
    if (prepared.input.projection === undefined) throw new Error('actual isolated projection configuration missing')
    const config = await readArtifact(prepared.input.projection.configRef, ctx)
    expect(config).toMatchObject({ schemaVersion: 'competency-projection-configuration@1', scopeRef: scope, projectId: prepared.input.project.ref.projectId, definitionRef: f.definition.ref, packRef: f.asset.packRef })
    expect(prepared.input.projection.ref.digest).toBe(prepared.input.projection.configRef.digest)
    const rules = prepared.input.rules, version = rules.versions[0]?.published, entity = prepared.input.entities.get('machine\u0000M-1')
    if (version === undefined || entity === undefined) throw new Error('actual published rule/entity absent')
    const key = publishedRuleApplicabilityKey({ tenantId: scope.tenantId, spaceId: scope.spaceId, definitionRef: prepared.input.definition.ref, ruleRef: publishedRuleRef(version), objectId: 'machine', subjectEntityId: entity, projectId: prepared.input.project.ref.projectId })
    const read = await rules.materializer.read({ scopeRef: scope, projectionRef: rules.projectionRef, validAt: request.input.validAt, asOfRecordedSeq: rules.recordedPoint, propositionKeys: [key] }, ctx)
    const artifact = read.ruleArtifacts?.find((row) => row.subjectEntityId === entity)
    if (artifact === undefined) throw new Error('actual exact artifact missing')
    expect(artifact.premiseInput?.request.projectionRef).toEqual(prepared.input.projection.ref)
    const evidence = await rules.producer.record({ scopeRef: scope, ruleRef: publishedRuleRef(version), definitionRef: prepared.input.definition.ref, objectId: 'machine', subjectEntityId: entity, validAt: request.input.validAt, asOfRecordedSeq: rules.recordedPoint, observedAt: new Date().toISOString(), sourceSnapshots: [], dataMode: 'synthetic' }, ctx)
    if (evidence.envelope.payloadRef === undefined) throw new Error('actual immutable payload absent')
    const payload = await readArtifact(evidence.envelope.payloadRef, ctx)
    expect(payload['policySourceEvidenceMappings']).toHaveLength(1)
    expect(await rules.replay.verify({ artifact, payload }, ctx)).toBe(true)
    const runner = new CompetencyRunner({ questions: f.questionWorkflow.service, boundary: f.questionWorkflow.boundary, sources: f.questionWorkflow.sources, validateActual: f.questionWorkflow.validateActual, execution })
    const result = await runner.run(declaration.ref, ctx, new AbortController().signal)
    expect(result.passed).toBe(true)
    expect(result.results[0]?.status).toBe('passed')
    expect(result.results[0]?.actual).toEqual(declaration.body.questions[0]?.expected)
    expect(result.results[0]?.sourceCoverage).toEqual({ required: 2, verified: 2, complete: true })
    expect(await f.reviews.latestReviewRevision(scope, f.sourceRule.candidateId, ctx)).toBe('1')
    expect(await f.reviews.listRuleVersions(scope, { sourceCandidateId: f.sourceRule.candidateId, limit: 2 }, ctx)).toEqual([])
    expect(f.asset.capabilities.deploymentExecutable).toBe(false)
    expect({ state: await global.getProjectionState(scope, ctx), fences: await global.listOpenFences(scope, ctx), slices: await global.readSlices(scope, { limit: 100 }, ctx) }).toEqual(before)
  })
  it('executes actual stored pack declarations with14 replay and no extraction clone or second approval', async () => {
    const ctx = context(), f = await fixture(ctx, 'business_conclusion'), declaration = await bodyFor(f, ctx, 'business_consequence'), question = declaration.body.questions[0]
    if (question === undefined) throw new Error('independently authored question missing')
    const { prepare, execution } = executor(f), request = { ...competencyExecutionRequest(declaration.ref, question), validationTarget: f.target }
    expect(request).not.toHaveProperty('expected'); expect(request).not.toHaveProperty('derivation')
    const prepared = await prepare(request, ctx, new AbortController().signal)
    expect(prepared.status).toBe('prepared'); if (prepared.status !== 'prepared') throw new Error('reason' in prepared ? prepared.reason : 'actual pack preparation was refused')
    expect(prepared.input.rules?.versions[0]?.published).toMatchObject({ sourceCandidateId: f.sourceRule.candidateId, publishedPackRef: f.asset.packRef, ruleRef: f.rules[0]?.ruleRef })
    expect(prepared.input.rules?.versions[0]?.published).not.toHaveProperty('publicationId')
    const saved = await readArtifact(prepared.input.executionInputRef, ctx)
    expect(saved['templateBindingRef']).toEqual(f.bindingRef)
    expect(await f.reviews.latestReviewRevision(scope, f.sourceRule.candidateId, ctx)).toBe('1')
    expect(await f.reviews.listRuleVersions(scope, { sourceCandidateId: f.sourceRule.candidateId, limit: 2 }, ctx)).toEqual([])
    // Run a fresh actual input through the full producer/replay executor; no prepared result is mocked.
    const actual = await execution.execute(request, ctx, new AbortController().signal)
    expect(actual.status).toBe('executed'); if (actual.status !== 'executed') throw new Error(actual.reason)
    expect(actual.actual).toEqual(question.expected)
    expect(actual.sources).toHaveLength(question.requiredSources.length)
    expect(await f.reviews.latestReviewRevision(scope, f.sourceRule.candidateId, ctx)).toBe('1')
    const runner = new CompetencyRunner({ questions: f.questionWorkflow.service, boundary: f.questionWorkflow.boundary, sources: f.questionWorkflow.sources, validateActual: f.questionWorkflow.validateActual, execution })
    const validation = new IndustryValidationService({ workspaces: f.workspaces, exampleSets: f.sets, definitions: f.editing, ruleActions: f.actions,
      support: new FiniteGrammarRuleSupportValidator(), evaluator: new FiniteGrammarSyntheticEvaluator(), reports: f.reports, requireCompetencyQuestions: true, competencyRunner: runner })
    const strategy = { kind: 'new_version' as const, reason: 'human explicitly publishes the separately verified execution gate', supersedesRef: f.asset.definitionRef }
    const report = await validation.validate(f.workspace.workspaceId, { exampleSetId: f.sample.exampleSetId, competencyQuestionRef: declaration.ref, definitionRef: f.definition.ref,
      expectedRevision: f.workspace.headRevision, strategy, idempotencyKey: `actual-pack-deployment-validation-${randomUUID()}`, signal: new AbortController().signal }, ctx.principal.subjectId, ctx)
    expect(report.semanticPublished.blockers).toEqual([])
    expect(report.deploymentExecutable.blockers).toEqual([])
    expect(report.competency?.passed).toBe(true)
    expect(report.competency?.results[0]?.actual).toEqual(question.expected)
    const deployed = await f.publication.publish(f.workspace.workspaceId, { packId: 'actual-origin', version: '1.0.1', validationId: report.validationId,
      expectedRevision: f.workspace.headRevision, strategy, idempotencyKey: `actual-pack-deployment-publish-${randomUUID()}`, requireDeploymentExecutable: true }, ctx.principal.subjectId, ctx)
    expect(deployed.validationRef.id).toBe(report.validationId)
    expect(deployed.capabilities).toMatchObject({ semanticPublished: true, deploymentExecutable: true })
    expect(deployed.ruleDeclarations?.[0]).toMatchObject({ candidateId: f.sourceRule.candidateId, contentDigest: f.sourceRule.contentDigest, reviewRevision: '1' })
    expect(f.sourceRule.generationContext?.inputDraftRef.revision).toBe('2')
    expect(f.asset.revision).toBe('3')
    expect(deployed.revision).toBe('4')
    expect(deployed.sourceDraftRef?.revision).toBe('3')
    const finalDraft = await f.workspaces.getDraft(scope, f.workspace.workspaceId, '4', ctx)
    if (finalDraft === undefined) throw new Error('physical final publication must create its actual current draft')
    const frames = await readWorkspacePublicationSourceDrafts({ workspaces: f.workspaces, packs: f.packs, definitions: f.terms, ruleActions: f.actions }, scope, f.workspace.workspaceId, finalDraft, ctx)
    expect(frames.map((frame) => frame.revision)).toEqual(['4','3','2'])
    expect(frames.at(-1)?.digest).toBe(f.sourceRule.generationContext?.inputDraftRef.digest)
    expect(await f.reviews.latestReviewRevision(scope, f.sourceRule.candidateId, ctx)).toBe('1')
  })
  it('keeps same-content reapproval and blocks a real late human rejection before execution', async () => {
    const ctx = context(), f = await fixture(ctx), declaration = await bodyFor(f, ctx, 'applicability_only'), question = declaration.body.questions[0]
    if (question === undefined) throw new Error('independent question missing')
    const request = competencyExecutionRequest(declaration.ref, question)
    await f.review(f.sourceRule.candidateId)
    expect(await f.reviews.latestReviewRevision(scope, f.sourceRule.candidateId, ctx)).toBe('2')
    expect(f.asset.ruleDeclarations?.[0]?.reviewRevision).toBe('1')
    const actual = await executor(f).execution.execute(request, ctx, new AbortController().signal)
    expect(actual.status).toBe('executed'); if (actual.status !== 'executed') throw new Error(actual.reason)
    expect(actual.actual).toEqual(question.expected)
    const delayed = executor(f, { afterPrepare: () => f.review(f.sourceRule.candidateId, 'reject') })
    await expect(delayed.execution.execute(request, ctx, new AbortController().signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect(await f.reviews.latestReviewRevision(scope, f.sourceRule.candidateId, ctx)).toBe('3')
    expect(await f.reviews.listRuleVersions(scope, { sourceCandidateId: f.sourceRule.candidateId, limit: 2 }, ctx)).toEqual([])
  })
  it('rejects immutable binding aliases that cross source families or name another real candidate/body', async () => {
    const ctx = context(), f = await fixture(ctx), declaration = await bodyFor(f, ctx, 'applicability_only'), question = declaration.body.questions[0]
    if (question === undefined) throw new Error('independent question missing')
    const request = competencyExecutionRequest(declaration.ref, question), signal = new AbortController().signal
    expect((await executor(f).prepare(request, ctx, signal)).status).toBe('prepared')
    const alias = f.template.rules[0], term = f.projection[0]
    if (alias === undefined || term === undefined) throw new Error('actual published alias and independently generated definition candidate required')
    for (const invalid of [
      { ...alias, publicationId: randomUUID() },
      { ...alias, sourceCandidateId: term.candidateId },
      { ...alias, declarationRef: f.definition.ref, publishedRef: f.definition.ref },
      { ...alias, publishedPackRef: f.definition.ref },
    ]) {
      const bindingRef = await f.put({ ...f.template, rules: [invalid] })
      expect(bindingRef.digest).not.toBe(f.bindingRef.digest)
      expect(await executor(f, { bindingRef }).prepare(request, ctx, signal)).toMatchObject({ status: 'not_yet_executable' })
    }
  })
  it('isolates real split fences and keeps immutable purpose through project revisions and SQL pagination', async () => {
    const ctx = context(), f = await fixture(ctx), declaration = await bodyFor(f, ctx, 'applicability_only'), question = declaration.body.questions[0]
    if (question === undefined) throw new Error('independent question missing')
    const { prepare } = executor(f), request = competencyExecutionRequest(declaration.ref, question), signal = new AbortController().signal
    const a = await prepare(request, ctx, signal), b = await prepare(request, ctx, signal)
    if (a.status !== 'prepared' || b.status !== 'prepared' || a.input.projection === undefined || b.input.projection === undefined) throw new Error('two genuine independently admitted cases required')
    expect(a.input.projection.ref.id).not.toBe(b.input.projection.ref.id)
    const storeA = new PostgresMaterializationStore(db, a.input.projection.ref.id), storeB = new PostgresMaterializationStore(db, b.input.projection.ref.id), global = new PostgresMaterializationStore(db)
    const priorAFences = await storeA.listOpenFences(scope, ctx)
    const before = { global: await global.getProjectionState(scope, ctx), globalFences: await global.listOpenFences(scope, ctx), b: await storeB.getProjectionState(scope, ctx), bFences: await storeB.listOpenFences(scope, ctx) }
    const publications = new PostgresSemanticPublicationStore(db), candidates = new PostgresCandidateStore(db), projects = new PostgresProjectStore(db)
    const archived = await readArtifact(a.input.executionInputRef, ctx), withdrawals = archived['withdrawals']
    const selected = Array.isArray(withdrawals) ? withdrawals.find((row: unknown) => isRecord(row) && row['logicalFactId'] === 'original-hours') : undefined
    if (!isRecord(selected) || typeof selected['actualStatementId'] !== 'string') throw new Error('actual archived original-row event selector required')
    const source = await publications.getStatement(scope, selected['actualStatementId'], ctx)
    if (source?.kind !== 'entity' || source.status !== 'active' || source.subjectEntityId === undefined || source.subjectEntityId !== a.input.entities.get('machine\u0000M-1')) throw new Error('exact actual confirmed original row required')
    const record = await new PostgresInstanceReviewStore(db).getRecord(scope, a.input.project.ref.projectId, source.sourceCandidateId, ctx), binding = record?.identity.binding
    const candidate = await candidates.getCandidate(scope, source.sourceCandidateId, ctx)
    if (binding === undefined || candidate?.kind !== 'entity') throw new Error('real confirmed source/identity binding required')
    const identity = new PostgresIdentityDecisionStore(db, { materializationProjectionRef: a.input.projection.ref.id })
    const split = await new IdentityDecisionService({ store: identity, candidates, schemaSource: new InMemoryIndustrySchemaSource([{ ref: f.definition.ref, schema: projectIndustrySchema(f.definition) }]) }).decide({
      candidateId: candidate.candidateId, kind: 'split', targetEntityId: source.subjectEntityId, projectId: a.input.project.ref.projectId,
      expectedRevision: await identity.latestRevision(scope, candidate.candidateId, ctx), justification: 'human separates the actual original row in this synthetic case',
      projectFence: { projectRevisionRef: binding.projectRevisionRef, definitionRef: binding.definitionRef, documentId: binding.documentId, parseId: candidate.inputVersion.parseId, membershipRevision: binding.membershipRevision, visibilityEpoch: binding.visibilityEpoch },
    }, ctx)
    const decision = await identity.getDecisionById(scope, split.decisionId, ctx)
    expect(decision).toMatchObject({ decisionId: split.decisionId, candidateId: candidate.candidateId, kind: 'split', targetEntityId: source.subjectEntityId, separatedCandidateIds: [candidate.candidateId] })
    expect(decision?.invalidationOutboxId).toBeDefined()
    expect(await identity.getDecisionById(scope, randomUUID(), ctx)).toBeUndefined()
    const foreign = await createJobScope(harness.adminClient, 'foreign-case-decision')
    const foreignCtx = createToolContext({ ...ctx, principal: { ...ctx.principal, tenantId: foreign.scopeRef.tenantId }, allowedResources: { ...ctx.allowedResources, tenantId: foreign.scopeRef.tenantId, spaceId: foreign.scopeRef.spaceId } })
    expect(await identity.getDecisionById(foreign.scopeRef, split.decisionId, foreignCtx)).toBeUndefined()
    await expect(identity.getDecisionById(foreign.scopeRef, split.decisionId, ctx)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    const afterAFences = await storeA.listOpenFences(scope, ctx), added = afterAFences.filter((fence) => !priorAFences.some((old) => old.fenceId === fence.fenceId))
    expect(afterAFences).toHaveLength(priorAFences.length + 1)
    expect(added).toHaveLength(1)
    expect(added[0]?.reason).toBe(`identity split ${split.decisionId}: human separates the actual original row in this synthetic case`)
    expect({ global: await global.getProjectionState(scope, ctx), globalFences: await global.listOpenFences(scope, ctx), b: await storeB.getProjectionState(scope, ctx), bFences: await storeB.listOpenFences(scope, ctx) }).toEqual(before)
    await expect(a.input.validateCurrent(ctx, signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    const jobs = new PostgresJobStore(db), readiness = new PostgresProjectReadinessStore(db), catalogue = new StoreBackedIndustryPackCatalogue({ store: f.packs })
    const service = new ProjectService({ projects, jobs, readiness, catalogue })
    const updated = await service.appendRevision(a.input.project.ref.projectId, { expectedRevision: a.input.project.ref.revision, reason: 'human updates the same synthetic project without changing its purpose' }, `purpose-update-${randomUUID()}`, ctx.principal.subjectId, ctx)
    expect(updated.revision.executionPurpose).toBe('synthetic_validation')
    const businessId = randomUUID(), emptySet = await f.put({ schemaVersion: 'project-document-set@1', projectId: businessId, members: [] })
    const profile = await new PostgresProfileStore(db).findResolvedProfile(f.resolved.resolvedProfileRef, f.resolved.resolvedProfileHash, scope, ctx)
    if (profile === undefined) throw new Error('actual resolved profile missing')
    let first = true
    const business = await new ProjectService({ projects, jobs, readiness, catalogue, newId: () => { if (first) { first = false; return businessId }; return randomUUID() } }).createProject({ title: 'Actual ordinary business project', industryPackRef: f.asset.packRef, profileRef: f.resolved.resolvedProfileRef, mappingRefs: profile.resolved.mappingRefs, documentSetRef: emptySet }, `business-${businessId}`, ctx.principal.subjectId, ctx)
    expect(business.revision.executionPurpose).toBeUndefined()
    const filtered = new PostgresProjectStore(db, { excludeSyntheticValidationProjects: true })
    expect((await filtered.listProjects(scope, { limit: 1 }, ctx)).map((row) => row.projectId)).toEqual([businessId])
    const unfiltered = await projects.listProjects(scope, { limit: 1 }, ctx), firstProject = unfiltered[0]
    if (firstProject === undefined) throw new Error('actual first default project missing')
    expect((await projects.getRevision(scope, firstProject.projectId, firstProject.headRevision, ctx))?.executionPurpose).toBe('synthetic_validation')
    expect(await filtered.getRevision(scope, a.input.project.ref.projectId, a.input.project.ref.revision, ctx)).toEqual(a.input.project)
    for (const prior of [updated.revision, business.revision]) {
      const { ref, ...pins } = prior, next = String(BigInt(ref.revision) + 1n)
      if (prior.executionPurpose === undefined) pins.executionPurpose = 'synthetic_validation'; else delete pins.executionPurpose
      const body = { schemaVersion: 'project-revision@1', projectId: ref.projectId, revision: next, ...pins }, revision: ProjectRevision = { ...pins, ref: { ...ref, revision: next, digest: contentDigestOf(body) } }, now = new Date().toISOString()
      await expect(projects.appendRevision(scope, ref.projectId, { expectedRevision: ref.revision, revision, idempotencyKey: `purpose-forge-${randomUUID()}`, requestDigest: contentDigestOf(body), actor: ctx.principal.subjectId, recordedAt: now, outboxJobId: candidate.jobId, outbox: { outboxId: randomUUID(), topic: 'project.revision.created', payload: { projectId: ref.projectId }, idempotencyKey: randomUUID(), availableAt: now, createdAt: now } }, ctx)).rejects.toMatchObject({ code: 'INVALID_REVISION' })
      expect((await projects.getProject(scope, ref.projectId, ctx))?.headRevision).toBe(ref.revision)
    }
  })
  it('rejects a correctly archived replacement projection configuration that differs from the actual saved computation', async () => {
    const ctx = context(), f = await fixture(ctx), declaration = await bodyFor(f, ctx, 'applicability_only'), question = declaration.body.questions[0]
    if (question === undefined) throw new Error('independent question missing')
    const { prepare } = executor(f)
    const execution = executionFor(f, async (request, context, signal) => {
      const prepared = await prepare(request, context, signal)
      if (prepared.status !== 'prepared' || prepared.input.projection === undefined || prepared.input.rules === undefined) throw new Error('genuine prepared case/config/rules required')
      const config = await readArtifact(prepared.input.projection.configRef, context)
      const configRef = await f.put({ ...config, producerComponentRef: f.asset.packRef }), ref = { ...prepared.input.projection.ref, digest: configRef.digest }
      expect(configRef.digest).not.toBe(prepared.input.projection.configRef.digest)
      const captured = await readArtifact(prepared.input.executionInputRef, context), executionInputRef = await f.put({ ...captured, projectionRef: ref, projectionConfigRef: configRef })
      return { ...prepared, input: { ...prepared.input, executionInputRef, projection: { ref, configRef }, rules: { ...prepared.input.rules, projectionRef: ref } } }
    })
    await expect(execution.execute(competencyExecutionRequest(declaration.ref, question), ctx, new AbortController().signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
  })
})
