import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { LocalDocumentExtractionService, PostgresDocumentParseStore } from '@ontology/adapter-extraction-document'
import { PostgresAssetCandidateStore, PostgresAssetWorkspaceStore, PostgresBudgetLedgerStore, PostgresCandidateStore, PostgresComponentRegistryStore, PostgresDefinitionEditingStore, PostgresIdentityDecisionStore, PostgresIndustryValidationReportStore, PostgresJobStore, PostgresPublishedPackAssetStore, PostgresRuleActionCandidateStore, PostgresSemanticDefinitionStore, PostgresSemanticPublicationStore, PostgresSyntheticExampleSetStore, ControlPostgresRepository } from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { CompositeReviewableCandidateReader, DefinitionCandidateEditingService, ExtractionPipeline, IndustryAssetPublicationService, IndustryValidationService, IndustryWorkspaceService, InMemoryIndustrySchemaSource, JobService, PublishedPackRuleDeclarationReader, RuleActionCandidateService, SyntheticExampleService, contentDigestOf } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, IdentityDecisionService, PublishedSemanticSource, SemanticPublicationService, projectIndustrySchema } from '@ontology/semantic-engine'
import type { AssetCandidateBatch, AssetCandidateVersion, CandidateSourceSpan, CommitApprovedPackInput, DefinitionCandidatePayload, EntityCandidate, RuleCandidateVersion, RuleProvenanceSpan, RuleExpressionNode, SemanticDefinitionVersionDraft, ToolContext, SemanticPublicationStore, RuleDependencyReference } from '@ontology/contracts'
import { INDUSTRIAL_DEFINITION, INDUSTRIAL_RULES, INDUSTRIAL_TEXT } from '../fixtures/competency-questions/assets'
import { loadCompetencyQuestions } from '../fixtures/competency-questions/loader'
import { CountingGenerationPort, MODEL_REF, generationResponse } from '../unit/extraction-fixtures'
import type { JobTestScope } from './job-postgres-harness'

/** Authored declarations are independent inputs; every approval, enablement and publication is real. */
export async function publishedRuleChainHarness(database: ControlPostgresDatabase, connectionString: string, scope: JobTestScope, ctx: ToolContext,
  beforeCommit?: (input: CommitApprovedPackInput, reviews: SemanticPublicationStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'published-rule-chain-'))
  const registry = new PostgresArtifactRegistry({ connectionString, maxPoolSize: 2 })
  const parses = new PostgresDocumentParseStore({ connectionString, maxPoolSize: 2 })
  const close = async () => { await parses.close(); await registry.close(); await rm(root, { recursive: true, force: true }) }
  try {
  const objects = new FileSystemObjectStore(root); await objects.init()
  const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
  const parser = new LocalDocumentExtractionService({ blobs, store: parses })
  const parseText = async (text: string) => {
    const staged = await blobs.stage(new TextEncoder().encode(text), { scopeRef: scope.scopeRef }, ctx)
    const original = await blobs.publish({ scopeRef: scope.scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'text/plain', purpose: 'document' }, ctx)
    return parser.parse({ scopeRef: scope.scopeRef, originalRef: original.blobRef, documentVersionRef: original.blobRef }, ctx)
  }
  const parsed = await parseText(INDUSTRIAL_TEXT)
  const first = parsed.chunks[0]; if (first === undefined) throw new Error('missing actual rule source chunk')
  const span: CandidateSourceSpan = { kind: 'text', parseId: parsed.parseId, chunkId: first.chunkId, locator: first.locator, spanKind: first.spanKind, precision: first.precision, quoteDigest: first.quoteDigest, textDigest: first.textDigest }
  const provenance: RuleProvenanceSpan = { parseId: parsed.parseId, chunkId: first.chunkId, locator: first.locator, spanKind: first.spanKind, precision: first.precision, quoteDigest: first.quoteDigest }
  const withSpans = (node: RuleExpressionNode): RuleExpressionNode => node.op === 'all' || node.op === 'any' ? { ...node, spans: [provenance], operands: node.operands.map(withSpans) } : node.op === 'not' ? { ...node, spans: [provenance], operand: withSpans(node.operand) } : { ...node, spans: [provenance] }
  const workspaces = new PostgresAssetWorkspaceStore(database), jobs = new PostgresJobStore(database)
  const created = await new IndustryWorkspaceService({ store: workspaces, jobs }).createWorkspace({ namespace: `chain-${scope.spaceId}`, displayName: 'Synthetic maintenance', boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: parsed.originalRef }, `create-${randomUUID()}`, ctx.principal.subjectId, ctx)
  const workspace = created.workspace
  const drafts = await workspaces.listDrafts(scope.scopeRef, workspace.workspaceId, ctx), draft = drafts[0]
  if (draft === undefined) throw new Error('missing actual workspace draft')
  const definitions = new PostgresAssetCandidateStore(database), ruleActions = new PostgresRuleActionCandidateStore(database), instances = new PostgresCandidateStore(database)
  const publication = new PostgresSemanticPublicationStore(database), definitionStore = new PostgresSemanticDefinitionStore(database), packs = new PostgresPublishedPackAssetStore(database)
  const identities = new PostgresIdentityDecisionStore(database)
  const reader = new CompositeReviewableCandidateReader({ definition: definitions, instance: instances, ruleActions })
  const reviewService = new SemanticPublicationService({ store: publication, candidates: instances, schemaSource: new InMemoryIndustrySchemaSource(), identity: identities, reviewableCandidates: reader })
  const approve = async (candidateId: string, expectedRevision = '0') => reviewService.reviewCandidate({ candidateId, decision: 'approve', reason: 'human reviewed the original authored source and complete declaration', expectedRevision }, ctx)
  const authored: SemanticDefinitionVersionDraft = INDUSTRIAL_DEFINITION.draft
  const common = (logicalId: string) => ({ logicalId, displayName: logicalId, businessMeaning: logicalId, suggestedReason: 'authored synthetic declaration', conflicts: [] })
  const payloads: DefinitionCandidatePayload[] = [
    ...authored.objects.map((object): DefinitionCandidatePayload => ({ ...common(object.id), kind: 'object', identityAttributeIds: authored.attributes.filter((field) => field.objectId === object.id && field.identityKey).map((field) => field.id) })),
    ...authored.attributes.map((field): DefinitionCandidatePayload => ({ ...common(field.id), kind: 'attribute', objectLogicalId: field.objectId, valueType: field.valueType, minCardinality: field.cardinality.min, maxCardinality: field.cardinality.max,
      ...(field.unit === undefined ? {} : { unitCode: field.unit.unitCode, dimension: field.unit.dimension }), ...(field.enumValues === undefined ? {} : { enumValues: field.enumValues }) })),
    ...authored.relations.map((relation): DefinitionCandidatePayload => ({ ...common(relation.id), kind: 'relation', fromObjectLogicalId: relation.fromObjectId, toObjectLogicalId: relation.toObjectId, minCardinality: relation.cardinality.min, maxCardinality: relation.cardinality.max })),
  ]
  const batchId = randomUUID(), recordedAt = new Date().toISOString()
  const projection: AssetCandidateVersion[] = payloads.map((payload) => ({ candidateId: randomUUID(), batchId, workspaceId: workspace.workspaceId, domain: 'definition', logicalId: payload.logicalId, kind: payload.kind, payload, inputDraftRef: { workspaceId: workspace.workspaceId, revision: '1', digest: draft.digest }, sourceRefs: [parsed.originalRef], sourceSpans: [span], state: 'produced', issues: [], pendingConfirmation: false, contentDigest: contentDigestOf(payload), idempotencyKey: contentDigestOf({ batchId, payload }), recordedAt }))
  const batch: AssetCandidateBatch = { batchId, workspaceId: workspace.workspaceId, domain: 'definition', inputDraftRef: projection[0]?.inputDraftRef ?? { workspaceId: workspace.workspaceId, revision: '1', digest: draft.digest }, modelRef: MODEL_REF,
    responseSchemaRef: { id: 'authored-declarations', version: '1.0.0', digest: contentDigestOf(payloads) }, documentSetRef: parsed.originalRef, generationPolicyRef: { id: 'authored-input', version: '1.0.0', digest: contentDigestOf('authored independent input') }, state: 'completed',
    counts: { total: projection.length, produced: projection.length, failed: 0, pendingConfirmation: 0, pendingReview: 0 }, idempotencyKey: `batch-${batchId}`, requestDigest: contentDigestOf(payloads), createdBy: ctx.principal.subjectId, recordedAt }
  await definitions.insertBatch(scope.scopeRef, batch, projection, ctx)
  for (const candidate of projection) await approve(candidate.candidateId)
  const support = new FiniteGrammarRuleSupportValidator()
  const rules = new RuleActionCandidateService({ workspaces, candidates: ruleActions, support })
  const saved = new Map<string, RuleCandidateVersion>()
  for (const fixture of INDUSTRIAL_RULES.slice(0, 3)) {
    const declaration = fixture.declaration
    const dependencyRefs = declaration.ruleDependencies.map((id) => { const upstream = saved.get(id); if (upstream === undefined || upstream.payload.conclusion === undefined) throw new Error('missing authored upstream declaration'); return { ruleId: id, ruleRef: { id: upstream.candidateId, version: '1.0.0', digest: upstream.contentDigest }, objectId: upstream.payload.applicability.objectId, predicate: upstream.payload.conclusion.predicate } })
    const candidate = await rules.saveRuleCandidate(workspace.workspaceId, { displayName: declaration.ruleId, businessMeaning: declaration.ruleId, suggestedReason: 'original authored source', ruleId: declaration.ruleId, applicability: { objectId: declaration.objectId }, condition: withSpans(declaration.condition), exceptions: declaration.exceptions.map((exception) => ({ ...exception, spans: [provenance], condition: withSpans(exception.condition) })), conclusion: declaration.conclusion, ruleDependencies: declaration.ruleDependencies, dependencyRefs, sourceRefs: [parsed.originalRef], sourceSpans: [span], expectedRevision: '1', idempotencyKey: `rule-${randomUUID()}` }, ctx.principal.subjectId, ctx)
    await approve(candidate.candidateId)
    const enabled = await rules.enableRuleCandidate(workspace.workspaceId, { candidateId: candidate.candidateId, expectedRevision: '1' }, ctx)
    saved.set(declaration.ruleId, enabled.candidate)
  }
  const editing = new DefinitionCandidateEditingService({ workspaces, candidates: definitions, editing: new PostgresDefinitionEditingStore(database), publishedDefinitions: definitionStore, publishedPacks: packs, reviews: publication, reviewableCandidates: reader,
    terminology: { getTerminology: async () => undefined } })
  const sets = new PostgresSyntheticExampleSetStore(database), reports = new PostgresIndustryValidationReportStore(database)
  const sample = await new SyntheticExampleService({ workspaces, sets }).generate(workspace.workspaceId, { expectedRevision: '1', idempotencyKey: `examples-${randomUUID()}`, caseKinds: ['missing_parameter'],
    cases: [{ caseId: 'absent-hours', caseKind: 'missing_parameter', objectTypeRef: 'asset', fields: [{ fieldId: 'exempt', value: false }] }],
    expectations: [{ expectationId: 'absent-hours', caseId: 'absent-hours', kind: 'rule', ruleId: 'service', expected: 'unknown', origin: 'authored_oracle', reason: 'missing hours supplies no positive support', confirmedBy: ctx.principal.subjectId, confirmedAt: recordedAt }] }, ctx.principal.subjectId, ctx)
  const report = await new IndustryValidationService({ workspaces, exampleSets: sets, reports, definitions: editing, ruleActions, support, evaluator: new FiniteGrammarSyntheticEvaluator() }).validate(workspace.workspaceId, { exampleSetId: sample.exampleSetId, expectedRevision: '1', idempotencyKey: `validate-${randomUUID()}` }, ctx.principal.subjectId, ctx)
  expect(report.publishable).toBe(true)
  const publishingStore = { findByRef: packs.findByRef.bind(packs), findPack: packs.findPack.bind(packs), listPacks: packs.listPacks.bind(packs), findByIdempotencyKey: packs.findByIdempotencyKey.bind(packs),
    commitApprovedPack: async (scopeRef: JobTestScope['scopeRef'], input: CommitApprovedPackInput, context: ToolContext) => { await beforeCommit?.(input, publication); return packs.commitApprovedPack(scopeRef, input, context) } }
  const asset = await new IndustryAssetPublicationService({ workspaces, validations: reports, definitionCandidates: definitions, ruleActions, syntheticSets: sets, definitions: definitionStore, store: publishingStore, reviews: publication, reviewableCandidates: reader }).publish(workspace.workspaceId, { packId: 'maintenance', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` }, ctx.principal.subjectId, ctx)
  const definition = await definitionStore.findVersion(asset.namespace, asset.definitionRef.id, asset.definitionRef.version, scope.scopeRef, ctx)
  if (definition === undefined) throw new Error('missing actual published definition')
  const schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
  const publisher = new SemanticPublicationService({ store: publication, candidates: instances, schemaSource: schemas, identity: identities, reviewableCandidates: reader })
  const identity = new IdentityDecisionService({ store: identities, candidates: instances, schemaSource: schemas })
  const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(database), control: new ControlPostgresRepository(database) })
  const importSupport = async (code: string, hours: number | undefined, exempt = false, targetId?: string): Promise<{ candidate: EntityCandidate; entityId: string }> => {
    const document = await parseText(`Synthetic observed source ${randomUUID()}: ${code} hours=${String(hours)} h; exempt=${String(exempt)}.`)
    const attributes = [{ attributeId: 'asset_code', value: code }, { attributeId: 'exempt', value: exempt }, ...(hours === undefined ? [] : [{ attributeId: 'hours', value: hours, unitCode: 'h' }])]
    const jobId = randomUUID()
    await new JobService({ store: jobs }).createJob({ jobId, kind: 'ingestion', sourceRef: document.originalRef.id, documentRef: document.originalRef.id, pipelineVersion: '1.0.0', idempotencyKey: `import-${jobId}` }, ctx)
    await budget.openLedger({ ledgerId: jobId, kind: 'background', runId: jobId }, ctx)
    const pipeline = new ExtractionPipeline({ schemaSource: schemas, candidates: instances, budget, modelRef: MODEL_REF, outputLimit: { maxTokens: 512 }, generation: new CountingGenerationPort(generationResponse({ entities: [{ objectId: 'asset', attributes }], relations: [], rules: [], exceptions: [] })) })
    const input = { jobId, parseId: document.parseId, parserVersion: document.parserVersion, pipelineVersion: '1.0.0', definitionRef: definition.ref, documentVersionRef: document.originalRef, chunks: document.chunks, truncatedChunkIds: [] }
    const run = { ledgerId: jobId, ctx, signal: new AbortController().signal }
    await pipeline.extract(input, run)
    expect((await pipeline.validate(input, run)).failed).toBe(0)
    const candidate = (await instances.listCandidates(scope.scopeRef, { jobId }, ctx))[0]
    if (candidate?.kind !== 'entity') throw new Error('missing real extracted entity')
    const pending = targetId === undefined ? await identity.decide({ candidateId: candidate.candidateId, kind: 'create_pending', expectedRevision: '0' }, ctx) : undefined
    const entityId = targetId ?? pending?.targetEntityId; if (entityId === undefined) throw new Error('missing real identity')
    await identity.decide({ candidateId: candidate.candidateId, kind: 'match', targetEntityId: entityId, expectedRevision: targetId === undefined ? '1' : '0', strongIdentity: { kind: 'native_id', attributeId: 'asset_code', value: code } }, ctx)
    await publisher.reviewCandidate({ candidateId: candidate.candidateId, decision: 'approve', reason: 'human confirmed source fields and identity', expectedRevision: '0' }, ctx)
    await publisher.publish({ schemaRef: definition.ref, approvedCandidateRefs: [{ kind: 'entity', candidateId: candidate.candidateId }], expectedRevision: await publication.latestPublicationRevision(scope.scopeRef, ctx), idempotencyKey: `fact-publish-${jobId}` }, ctx)
    return { candidate, entityId }
  }
  const publishExtractedRule = async (fixture: typeof INDUSTRIAL_RULES[number], dependencies: readonly RuleDependencyReference[] = [], sourceText?: string) => {
    const ruleDocument = sourceText === undefined ? parsed : await parseText(sourceText)
    const declaration = fixture.declaration
    const createdJob = await new JobService({ store: jobs }).createJob({ jobId: randomUUID(), kind: 'ingestion', sourceRef: `${ruleDocument.originalRef.id}:${contentDigestOf({ declaration, dependencies })}`, documentRef: ruleDocument.originalRef.id, pipelineVersion: '1.0.0', idempotencyKey: `extract-rule-${randomUUID()}` }, ctx)
    const jobId = createdJob.jobId
    await budget.openLedger({ ledgerId: jobId, kind: 'background', runId: jobId }, ctx)
    const pipeline = new ExtractionPipeline({ schemaSource: schemas, candidates: instances, budget, modelRef: MODEL_REF, outputLimit: { maxTokens: 512 }, generation: new CountingGenerationPort(generationResponse({ entities: [], relations: [], rules: [{ ruleId: `extracted-${declaration.ruleId}`, objectId: declaration.objectId, severity: 'soft', impact: 'low', expression: declaration.condition, exceptions: declaration.exceptions.map((row) => row.condition), conclusion: declaration.conclusion,
      ruleDependencies: dependencies.map((row) => row.ruleId), dependencyRefs: dependencies }], exceptions: [] })) })
    const input = { jobId, parseId: ruleDocument.parseId, parserVersion: ruleDocument.parserVersion, pipelineVersion: '1.0.0', definitionRef: definition.ref, documentVersionRef: ruleDocument.originalRef, chunks: ruleDocument.chunks, truncatedChunkIds: [] }
    const run = { ledgerId: jobId, ctx, signal: new AbortController().signal }
    await pipeline.extract(input, run); expect((await pipeline.validate(input, run)).failed).toBe(0)
    const candidate = (await instances.listCandidates(scope.scopeRef, { jobId }, ctx)).find((row) => row.kind === 'rule')
    if (candidate?.kind !== 'rule') throw new Error('missing actual extracted rule candidate')
    await publisher.reviewCandidate({ candidateId: candidate.candidateId, decision: 'approve', reason: 'human reviewed the original extracted rule source and fixed dependencies', expectedRevision: '0' }, ctx)
    const receipt = await publisher.publish({ schemaRef: definition.ref, approvedCandidateRefs: [{ kind: 'rule', candidateId: candidate.candidateId }], expectedRevision: await publication.latestPublicationRevision(scope.scopeRef, ctx), idempotencyKey: `extracted-rule-publish-${jobId}` }, ctx)
    const rule = receipt.ruleVersions[0]; if (rule === undefined) throw new Error('missing persisted rule')
    return rule
  }
  const packReader = new PublishedPackRuleDeclarationReader({ packs, registry: new PostgresComponentRegistryStore(database), definitions: definitionStore, candidates: ruleActions, reviews: publication, reviewableCandidates: reader })
  const request = { packRef: asset.packRef, definitionRef: definition.ref }
  const source = new PublishedSemanticSource(publication, { definition, identity: identities, publishedRules: { reader: packReader, request } })
  const gold = loadCompetencyQuestions().flatMap((set) => set.body.questions).find((question) => question.questionId === 'industrial-three-layer')
  if (gold?.expected.kind !== 'rule') throw new Error('missing independent literal three-layer gold')
  return { asset, definition, source, packReader, request, publisher, publication, saved, ruleActions, instances, reader, rules, approve, importSupport, publishExtractedRule, goldExpected: gold.expected, blobs, parses, identities,
    close }
  } catch (error) { await close(); throw error }
}
