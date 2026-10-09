import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry, objectKeyForDigest } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, ControlPostgresRepository, PostgresAssetCandidateStore, PostgresAssetWorkspaceStore,
  PostgresCandidateStore, PostgresIdentityDecisionStore, PostgresJobStore, PostgresRuleActionCandidateStore,
  PostgresRuleActionGenerationStore, PostgresSemanticDefinitionStore, PostgresSemanticPublicationStore } from '@ontology/adapter-control-postgres'
import { PostgresDefinitionEditingStore, PostgresPublishedPackAssetStore } from '@ontology/adapter-control-postgres'
import { PostgresIndustryValidationReportStore, PostgresSyntheticExampleSetStore } from '@ontology/adapter-control-postgres'
import { ArtifactGroundingDocumentSetReader, LocalDocumentExtractionService, ParsedSourceGroundingReader,
  PostgresDocumentParseStore, PostgresStructuredIngestionStore, publishGroundingDocumentSet } from '@ontology/adapter-extraction-document'
import { CompositeReviewableCandidateReader, DefinitionCandidateGenerationService, IndustryWorkspaceService,
  InMemoryIndustrySchemaSource, JobService, RuleActionCandidateGenerationService, RuleActionCandidateService,
  SourceGroundingBudget, StaticDefinitionTerminologySource, contentDigestOf, createSourceGroundingService,
  definitionApprovalPins, ruleActionPublicationPins } from '@ontology/application'
import { DefinitionCandidateEditingService, currentDefinitionProjection, currentRuleActionProjection, ruleActionGroundedContentDigest } from '@ontology/application'
import { CompetencyRunner, IndustryAssetPublicationService, IndustryValidationService, SyntheticExampleService, canonicalJson } from '@ontology/application'
import { createCompetencyValidationTargetReader, createCompetencyQuestionWorkflow } from '@ontology/app-api'
import type { CompetencyTargetTemplate, CompetencyValidationTargetReaderOptions } from '@ontology/app-api'
import { FiniteGrammarRuleSupportValidator, SemanticDefinitionService, SemanticPublicationService,
  projectIndustrySchema, publishedRuleDependencyRef, publishedRuleRef, FiniteGrammarSyntheticEvaluator } from '@ontology/semantic-engine'
import type { CompetencyQuestionSetBody, CompetencyValidationTarget, GenerationEvent, GenerationPort, GenerationRequest, RuleCandidate,
  RuleCandidateVersion, RuleProvenanceSpan, SemanticDefinitionVersionDraft, ToolContext, VersionRef } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { toolContext } from '../unit/component-registry-fixtures'
import { createActualCompetencyTargetFixture } from './competency-target-fixture'

const POLICY = { id: 'authored-policy', version: '1.0.0', digest: contentDigestOf('author-selection-policy@1') }
const SOURCE = 'Synthetic policy: a facility has a required native identifier, inspected and exempt flags, eligible and granted outcomes, and capacity in kW. Inspected is true AND capacity is at least 10 kW, with exempt false, for eligibility. Eligibility supports granted. The identity is scoped by project.'
class AuthoredGeneration implements GenerationPort {
  constructor(readonly output: string) {}
  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    void request
    yield { type: 'text_delta', text: this.output }
    yield { type: 'completed', stopReason: 'stop', candidateOnly: true }
  }
}
let harness: JobDbHarness, database: ControlPostgresDatabase, registry: PostgresArtifactRegistry
let documents: PostgresDocumentParseStore, tables: PostgresStructuredIngestionStore, blobs: LocalImmutableBlobStore, directory = ''
let scope: JobTestScope, foreign: JobTestScope, ctx: ToolContext
let workspaces: PostgresAssetWorkspaceStore, definitions: PostgresAssetCandidateStore, rules: PostgresRuleActionCandidateStore
let ruleGeneration: PostgresRuleActionGenerationStore, publishedDefinitions: PostgresSemanticDefinitionStore
let publications: PostgresSemanticPublicationStore, instances: PostgresCandidateStore
let reader: CompositeReviewableCandidateReader, publisher: SemanticPublicationService, schemas: InMemoryIndustrySchemaSource
let workspaceService: IndustryWorkspaceService, grounding: ReturnType<typeof createSourceGroundingService>
let ruleService: RuleActionCandidateService, options: CompetencyValidationTargetReaderOptions

beforeAll(async () => {
  harness = await startJobDatabase(); scope = await createJobScope(harness.adminClient, 'cq-target'); foreign = await createJobScope(harness.adminClient, 'cq-target-foreign')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'profile-editor', 'semantic-reviewer', 'semantic-publisher'], 'human-target-reviewer')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  documents = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  tables = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  directory = await mkdtemp(join(tmpdir(), 'cq-target-')); const objects = new FileSystemObjectStore(directory); await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
  workspaces = new PostgresAssetWorkspaceStore(database); definitions = new PostgresAssetCandidateStore(database)
  rules = new PostgresRuleActionCandidateStore(database); ruleGeneration = new PostgresRuleActionGenerationStore(database)
  publishedDefinitions = new PostgresSemanticDefinitionStore(database); publications = new PostgresSemanticPublicationStore(database); instances = new PostgresCandidateStore(database)
  reader = new CompositeReviewableCandidateReader({ definition: definitions, ruleActions: rules, instance: instances })
  schemas = new InMemoryIndustrySchemaSource()
  publisher = new SemanticPublicationService({ store: publications, candidates: instances, identity: new PostgresIdentityDecisionStore(database), schemaSource: schemas, reviewableCandidates: reader })
  workspaceService = new IndustryWorkspaceService({ store: workspaces, jobs: new PostgresJobStore(database) })
  grounding = createSourceGroundingService({ workspaces, documentSets: new ArtifactGroundingDocumentSetReader(blobs), reader: new ParsedSourceGroundingReader({ blobs, documents, tables }) })
  ruleService = new RuleActionCandidateService({ workspaces, candidates: rules, support: new FiniteGrammarRuleSupportValidator() })
  options = { workspaces, definitionCandidates: definitions, ruleActions: rules, ruleGeneration, reviews: publications, reviewableCandidates: reader, definitions: publishedDefinitions, candidates: instances, grounding }
}, 60_000)

afterAll(async () => {
  await documents?.close(); await tables?.close(); await registry?.close(); await database?.close(); await harness?.stop()
  if (directory !== '') { const path = resolve(directory); if (!path.startsWith(resolve(tmpdir(), 'cq-target-'))) throw new Error('fixture cleanup escaped owned directory'); await rm(path, { recursive: true, force: true }) }
})

async function review(candidateId: string, decision: 'approve' | 'reject' = 'approve') {
  return publisher.reviewCandidate({ candidateId, expectedRevision: await publications.latestReviewRevision(scope.scopeRef, candidateId, ctx), decision, reason: `${decision}: human independently checked the unchanged synthetic source and complete body ${randomUUID()}` }, ctx)
}
function tboxOutput(unresolved = false) {
  const common = { businessMeaning: 'authored facility declaration', suggestedReason: 'original synthetic policy', sourceIndex: 0, fragmentIndex: 0 }
  return JSON.stringify({ objects: [{ ...common, ...(unresolved ? { sourceIndex: 1 } : {}), logicalId: 'facility', displayName: 'Facility', identityAttributeIds: ['native'], identityScopeDimensions: ['project'] }],
    attributes: [{ ...common, logicalId: 'native', objectLogicalId: 'facility', displayName: 'Native identity', valueType: 'string', minCardinality: 1, maxCardinality: 1 },
      ...['inspected', 'exempt', 'eligible', 'granted'].map((logicalId) => ({ ...common, logicalId, objectLogicalId: 'facility', displayName: logicalId, valueType: 'boolean', minCardinality: 0, maxCardinality: 1 })),
      { ...common, logicalId: 'capacity', objectLogicalId: 'facility', displayName: 'Capacity', valueType: 'quantity', unitCode: 'kW', dimension: 'power', minCardinality: 0, maxCardinality: 1 }] })
}
function templateDraft(namespace: string, source: VersionRef): SemanticDefinitionVersionDraft {
  const standardProvenance = [{ standardRef: source, provenanceKind: 'synthetic_assumption' as const }]
  return { scopeRef: scope.scopeRef, definitionId: `authored.facility.${randomUUID()}`, version: '1.0.0', namespace, layer: 'industry_core', standardProvenance,
    objects: [{ kind: 'object', id: 'facility', namespace, displayName: 'Facility independent template', identityScopeId: 'facility.identity', standardProvenance }],
    attributes: [{ kind: 'attribute', id: 'native', namespace, objectId: 'facility', valueType: 'string', cardinality: { min: 1, max: 1 }, identityKey: true, standardProvenance },
      ...['inspected', 'exempt', 'eligible', 'granted'].map((id) => ({ kind: 'attribute' as const, id, namespace, objectId: 'facility', valueType: 'boolean' as const, cardinality: { min: 0, max: 1 }, standardProvenance })),
      { kind: 'attribute', id: 'capacity', namespace, objectId: 'facility', valueType: 'quantity', cardinality: { min: 0, max: 1 }, unit: { unitCode: 'kW', dimension: 'power' }, standardProvenance }],
    relations: [], identityScopes: [{ kind: 'identity_scope', id: 'facility.identity', namespace, objectId: 'facility', scopeDimensions: ['project'], identityAttributeIds: ['native'], standardProvenance }], ruleConstraints: [] }
}

async function setup(unresolved = false) {
  const initial = { id: randomUUID(), version: '1.0.0', digest: POLICY.digest, kind: 'artifact' as const }
  const created = await workspaceService.createWorkspace({ namespace: `target-${randomUUID()}`, displayName: 'Independently authored target', boundary: { goals: ['eligible'], included: [], excluded: [], applicability: {} }, documentSetRef: initial }, `create-${randomUUID()}`, ctx.principal.subjectId, ctx)
  const workspaceId = created.workspace.workspaceId
  const staged = await blobs.stage(new TextEncoder().encode(`1. ${SOURCE}\n\n2. This independently authored unrelated fragment describes review scheduling.\n${workspaceId}`), { scopeRef: scope.scopeRef }, ctx)
  const sourceRef = (await blobs.publish({ scopeRef: scope.scopeRef, ...staged, mediaType: 'text/plain', purpose: 'document' }, ctx)).blobRef
  const parse = await new LocalDocumentExtractionService({ blobs, store: documents }).parse({ scopeRef: scope.scopeRef, originalRef: sourceRef }, ctx)
  expect(parse.chunks.length).toBeGreaterThanOrEqual(2)
  const documentSetRef = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', scopeRef: scope.scopeRef, workspaceId, sources: [{ sourceRef, state: 'approved', kind: 'document', parseId: parse.parseId, parserVersion: parse.parserVersion }] }, ctx)
  await workspaceService.draftOperation(workspaceId, { operation: 'edit', expectedRevision: '1', reason: 'human selected the real source', documentSetRef }, `draft-${randomUUID()}`, ctx.principal.subjectId, ctx)
  const termGenerator = new DefinitionCandidateGenerationService({ workspaces, candidates: definitions, terminology: new StaticDefinitionTerminologySource(), sourceGrounding: grounding,
    generationForRun: () => new AuthoredGeneration(tboxOutput(unresolved)), modelRef: { modelId: 'authored-declaration', version: '1.0.0' }, outputLimit: { maxTokens: 4096 } })
  let terms = await termGenerator.generate({ workspaceId, expectedRevision: '2', sourceRefs: [sourceRef], kinds: ['object', 'attribute'], generationPolicyRef: POLICY, candidateLimit: 7, idempotencyKey: `terms-${randomUUID()}` }, ctx.principal.subjectId, ctx)
  expect(terms.batch, JSON.stringify(terms.batch.error)).toMatchObject({ state: 'completed' })
  expect(terms.candidates).toHaveLength(7)
  if (unresolved) {
    const object = terms.candidates.find((row) => row.kind === 'object'); if (object === undefined) throw new Error('missing actual unresolved object')
    expect(object.pendingConfirmation).toBe(true)
    const confirmed = await termGenerator.confirmSource({ workspaceId, candidateId: object.candidateId, contentDigest: object.contentDigest, expectedRevision: '2', sourceRef, fragmentIndex: 0, reason: 'human located the genuinely unresolved source suggestion in the real policy', idempotencyKey: `human-source-${randomUUID()}` }, ctx.principal.subjectId, ctx)
    expect(confirmed.candidates[0]?.replacesCandidateId).toBe(object.candidateId)
    terms = { ...terms, candidates: currentDefinitionProjection(await definitions.listCandidates(scope.scopeRef, workspaceId, {}, ctx)) }
  }
  expect(terms.candidates.every((row) => row.issues.length === 0)).toBe(true)
  // Real producer digest includes draft/provenance; a payload-only invented digest must not be required.
  expect(terms.candidates[0]?.contentDigest).not.toBe(contentDigestOf(terms.candidates[0]?.payload))
  const generator = (output: string) => new RuleActionCandidateGenerationService({ workspaces, definitionCandidates: definitions, candidates: rules, batches: ruleGeneration, service: ruleService,
    terminology: new StaticDefinitionTerminologySource(), sourceGrounding: grounding, generationForRun: () => new AuthoredGeneration(output), bindingContext: () => ({ registry: { namespace: 'authored', registryVersion: '1.0.0', registryDigest: contentDigestOf('empty-registered-operations'), operations: [] }, availableCapabilities: [], recordedAt: new Date().toISOString() }), modelRef: { modelId: 'authored-rules', version: '1.0.0' }, outputLimit: { maxTokens: 4096 } })
  const locations = ['applicability', 'condition', 'condition.operands[0]', 'condition.operands[1]', 'exceptions[0]', 'exceptions[0].condition', 'conclusion']
  const upstreamOutput = JSON.stringify({ rules: [{ ruleId: 'eligible-rule', objectId: 'facility', displayName: 'Eligibility', businessMeaning: 'inspected, sufficient capacity and not exempt', suggestedReason: 'original policy', condition: { op: 'all', operands: [{ op: 'compare', attributeId: 'inspected', operator: 'eq', value: true }, { op: 'range', attributeId: 'capacity', min: 10, unitCode: 'kW' }] }, exceptions: [{ exceptionId: 'exemption', condition: { op: 'compare', attributeId: 'exempt', operator: 'eq', value: true } }], conclusion: { predicate: 'eligible', value: true }, sourceSelections: locations.map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })) }] })
  const input = { workspaceId, expectedRevision: '2', sourceRefs: [sourceRef], kinds: ['rule' as const], selectedDefinitionCandidateIds: terms.candidates.map((row) => row.candidateId), generationPolicyRef: POLICY, candidateLimit: 2 }
  const upstream = (await generator(upstreamOutput).generate({ ...input, idempotencyKey: `upstream-${randomUUID()}` }, ctx.principal.subjectId, ctx)).candidates[0]
  if (upstream?.payload.kind !== 'rule') throw new Error('missing real upstream')
  await review(upstream.candidateId); await ruleService.enableRuleCandidate(workspaceId, { candidateId: upstream.candidateId, expectedRevision: '2' }, ctx)
  const upstreamRef = { id: upstream.candidateId, version: '1.0.0', digest: upstream.contentDigest }
  const downstreamOutput = JSON.stringify({ rules: [{ ruleId: 'grant-rule', objectId: 'facility', displayName: 'Grant', businessMeaning: 'eligibility supports grant', suggestedReason: 'original policy', condition: { op: 'compare', attributeId: 'eligible', operator: 'eq', value: true }, exceptions: [], conclusion: { predicate: 'granted', value: true }, ruleDependencies: ['eligible-rule'], dependencyRefs: [{ ruleId: 'eligible-rule', ruleRef: upstreamRef, objectId: 'facility', predicate: 'eligible' }], sourceSelections: ['applicability', 'condition', 'conclusion', 'dependencyRefs[0]'].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })) }] })
  const downstream = (await generator(downstreamOutput).generate({ ...input, idempotencyKey: `downstream-${randomUUID()}` }, ctx.principal.subjectId, ctx)).candidates[0]
  if (downstream?.payload.kind !== 'rule') throw new Error('missing real downstream')
  expect(downstream.generationContext?.issues).toEqual([])
  await review(downstream.candidateId); await ruleService.enableRuleCandidate(workspaceId, { candidateId: downstream.candidateId, expectedRevision: '2' }, ctx)
  for (const term of terms.candidates) await review(term.candidateId)
  const definition = await new SemanticDefinitionService({ control: new ControlPostgresRepository(database), store: publishedDefinitions }).publish(templateDraft(`template-${randomUUID()}`, sourceRef), ctx)
  schemas.register(definition.ref, projectIndustrySchema(definition))
  const grounded = await grounding.read({ workspaceId, sourceRefs: [sourceRef] }, ctx, new SourceGroundingBudget(new AbortController().signal))
  const origin = grounded.sources[0]?.contents[0]
  if (origin?.kind !== 'text' || origin.sourceSpan.kind === 'structured') throw new Error('missing actual policy text')
  const span: RuleProvenanceSpan = { parseId: origin.sourceSpan.parseId, chunkId: origin.sourceSpan.chunkId, locator: origin.sourceSpan.locator, spanKind: origin.sourceSpan.spanKind, precision: origin.sourceSpan.precision, quoteDigest: origin.sourceSpan.quoteDigest }
  const jobId = randomUUID(); await new JobService({ store: new PostgresJobStore(database) }).createJob({ jobId, kind: 'ingestion', sourceRef: sourceRef.id, documentRef: parse.parseId, pipelineVersion: '1.0.0', idempotencyKey: `policy-job-${jobId}` }, ctx)
  const templateRules: RuleCandidate[] = [], aliases: CompetencyTargetTemplate['rules'][number][] = []
  for (const logical of ['eligible-rule', 'grant-rule']) {
    const targetRow = logical === 'eligible-rule' ? upstream : downstream
    const dependencyRefs = logical === 'eligible-rule' ? [] : [publishedRuleDependencyRef((await publications.listRuleVersions(scope.scopeRef, {}, ctx)).find((row) => row.sourceCandidateId === templateRules[0]?.candidateId)!, scope.scopeRef, definition.ref)]
    const candidate: RuleCandidate = { candidateId: randomUUID(), jobId, kind: 'rule', ruleId: logical, objectId: 'facility', severity: 'soft', impact: 'low', reviewRequirement: 'required',
      expression: logical === 'eligible-rule' ? { op: 'all', operands: [{ op: 'compare', attributeId: 'inspected', operator: 'eq', value: true, spans: [span] }, { op: 'range', attributeId: 'capacity', min: 10, unitCode: 'kW', spans: [span] }], spans: [span] }
        : { op: 'compare', attributeId: 'eligible', operator: 'eq', value: true, spans: [span] },
      exceptions: logical === 'eligible-rule' ? [{ exceptionId: 'exemption', condition: { op: 'compare', attributeId: 'exempt', operator: 'eq', value: true, spans: [span] }, spans: [span] }] : [],
      conclusion: { predicate: logical === 'eligible-rule' ? 'eligible' : 'granted', value: true }, ruleDependencies: logical === 'eligible-rule' ? [] : ['eligible-rule'], dependencyRefs,
      conflicts: [], sourceSpans: [origin.sourceSpan], deterministic: false, state: 'pending_review', issues: [], inputVersion: { definitionRef: definition.ref, parseId: parse.parseId, parserVersion: parse.parserVersion, pipelineVersion: '1.0.0', documentVersionRef: sourceRef }, idempotencyKey: contentDigestOf({ logical, jobId, definition: definition.ref, dependencyRefs }), recordedAt: new Date().toISOString() }
    await instances.insertCandidates(scope.scopeRef, [candidate], ctx); await review(candidate.candidateId)
    const publication = await publisher.publish({ approvedCandidateRefs: [candidate], schemaRef: definition.ref, expectedRevision: await publications.latestPublicationRevision(scope.scopeRef, ctx), idempotencyKey: `template-publication-${candidate.candidateId}` }, ctx)
    const version = publication.ruleVersions[0]; if (version === undefined) throw new Error('actual template rule publication missing')
    const saved = await instances.getCandidate(scope.scopeRef, candidate.candidateId, ctx)
    if (saved?.kind !== 'rule') throw new Error('actual stored template candidate missing')
    templateRules.push(saved)
    aliases.push({ declarationRef: { id: targetRow.candidateId, version: '1.0.0', digest: targetRow.contentDigest }, publishedRef: publishedRuleRef(version), sourceCandidateId: candidate.candidateId, publicationId: publication.publicationId })
  }
  const currentRules = (await rules.list(scope.scopeRef, workspaceId, {}, ctx)).filter((row): row is RuleCandidateVersion => row.kind === 'rule' && row.payload.kind === 'rule')
  const approvals = await definitionApprovalPins(terms.candidates, scope.scopeRef, ctx, reader, publications)
  expect(approvals.blockers).toEqual([])
  const target: CompetencyValidationTarget = { workspaceId, revision: '2', definitionApprovalPins: approvals.pins, ruleActionPins: ruleActionPublicationPins(currentRules) }
  const template: CompetencyTargetTemplate = { schemaVersion: 'competency-template-binding@1', declarationDefinitionRef: definition.ref, definitionRef: definition.ref, namespace: definition.namespace,
    packRef: { id: 'authored-template', version: '1.0.0', digest: contentDigestOf('actual-template-binding') }, profileRef: { id: 'authored-template-profile', version: '1.0.0', snapshotHash: contentDigestOf('actual-template-profile') }, rules: aliases, dataMode: 'synthetic', businessApproval: 'none' }
  return { target, template, definition, templateRules, terms, currentRules, sourceRef, documentSetRef, parse, generator, input }
}

describe('authoritative actual current target against independently stored templates', () => {
  it('accepts genuine generated approved bodies, identity dimensions, two actual publications and exact upstream qualifiers', async () => {
    const fixture = await setup()
    expect(await createCompetencyValidationTargetReader(options)(fixture.target, fixture.template, fixture.definition, fixture.templateRules, ctx, new AbortController().signal)).toBe(true)
    const batchId = fixture.currentRules[0]?.generationContext?.batchId; if (batchId === undefined) throw new Error('missing saved generated batch')
    expect(await ruleGeneration.getById(scope.scopeRef, batchId, ctx)).toMatchObject({ workspaceId: fixture.target.workspaceId, generationFamily: 'rule_action', state: 'completed' })
    const foreignCtx = toolContext(foreign.tenantId, foreign.spaceId, ['platform-admin'])
    expect(await ruleGeneration.getById(foreign.scopeRef, batchId, foreignCtx)).toBeUndefined()
    expect(await ruleGeneration.getById(scope.scopeRef, fixture.terms.batch.batchId, ctx)).toBeUndefined()
    expect(await createCompetencyValidationTargetReader(options)(fixture.target, fixture.template, fixture.definition, fixture.templateRules, foreignCtx, new AbortController().signal)).toBe(false)
    const seeded = await createActualCompetencyTargetFixture({ definition: fixture.definition, rules: fixture.templateRules, sourceDocumentSetRef: fixture.documentSetRef, blobs, database, grounding, ctx, signal: new AbortController().signal })
    expect(await createCompetencyValidationTargetReader(options)(seeded.target, fixture.template, fixture.definition, fixture.templateRules, ctx, new AbortController().signal)).toBe(true)
  }, 30_000)

  it('allows same-content real reapproval but refuses current rejection, stale target pins and an altered supplied template body', async () => {
    const f = await setup(); const check = () => createCompetencyValidationTargetReader(options)(f.target, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)
    await review(f.terms.candidates[0]!.candidateId); await review(f.currentRules[0]!.candidateId); await review(f.templateRules[0]!.candidateId)
    expect(await check()).toBe(true)
    expect(await createCompetencyValidationTargetReader(options)({ ...f.target, definitionApprovalPins: f.target.definitionApprovalPins.slice(1) }, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(false)
    const changed = { ...f.definition, attributes: f.definition.attributes.map((attribute, index) => index === 0 ? { ...attribute, cardinality: { min: 0, max: 1 } } : attribute) }
    expect(await createCompetencyValidationTargetReader(options)(f.target, f.template, changed, f.templateRules, ctx, new AbortController().signal)).toBe(false)
    await review(f.currentRules[0]!.candidateId, 'reject'); expect(await check()).toBe(false)
    await review(f.currentRules[0]!.candidateId); expect(await check()).toBe(true)
    await review(f.templateRules[0]!.candidateId, 'reject'); expect(await check()).toBe(false)
  }, 30_000)

  it('accepts actual definition editing and source confirmations, then refuses a genuinely reviewed wrong unit', async () => {
    const f = await setup(true), gate = createCompetencyValidationTargetReader(options)
    expect(await gate(f.target, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(true)
    const editing = new DefinitionCandidateEditingService({ workspaces, candidates: definitions, editing: new PostgresDefinitionEditingStore(database), publishedDefinitions,
      publishedPacks: new PostgresPublishedPackAssetStore(database), reviews: publications, reviewableCandidates: reader, terminology: new StaticDefinitionTerminologySource() })
    const object = f.terms.candidates.find((row) => row.kind === 'object'); if (object === undefined) throw new Error('missing actual object')
    const edited = await editing.edit(f.target.workspaceId, { candidateId: object.candidateId, expectedRevision: '2', payload: { ...object.payload, displayName: 'Human wording; unchanged formal declaration' }, reason: 'human changed display wording only', idempotencyKey: `edit-${randomUUID()}` }, ctx.principal.subjectId, ctx)
    const revision = edited.candidates[0]; if (revision === undefined) throw new Error('missing actual edited revision')
    expect(revision.contentDigest).not.toBe(contentDigestOf(revision.payload)); await review(revision.candidateId)
    const fresh = async (): Promise<CompetencyValidationTarget> => ({ workspaceId: f.target.workspaceId, revision: '2', definitionApprovalPins: (await definitionApprovalPins(currentDefinitionProjection(await definitions.listCandidates(scope.scopeRef, f.target.workspaceId, {}, ctx)), scope.scopeRef, ctx, reader, publications)).pins,
      ruleActionPins: ruleActionPublicationPins(currentRuleActionProjection(await rules.list(scope.scopeRef, f.target.workspaceId, {}, ctx))) })
    expect(await gate(await fresh(), f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(true)
    const downstream = f.currentRules.find((row) => row.logicalId === 'grant-rule'); if (downstream?.generationContext === undefined) throw new Error('missing grounded downstream')
    const regrounded = await f.generator('{}').confirmSources({ workspaceId: f.target.workspaceId, candidateId: downstream.candidateId, contentDigest: downstream.contentDigest, expectedRevision: '2', sourceRefs: downstream.generationContext.inputSourceRefs,
      sourceSelections: downstream.generationContext.sourceSelections, reason: 'human selected the actual source clauses again', idempotencyKey: `confirm-rule-${randomUUID()}` }, ctx.principal.subjectId, ctx)
    const rule = regrounded.candidates[0]; if (rule === undefined) throw new Error('missing actual regrounded rule')
    await review(rule.candidateId); await ruleService.enableRuleCandidate(f.target.workspaceId, { candidateId: rule.candidateId, expectedRevision: '2' }, ctx)
    expect(await gate(f.target, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(false)
    expect(await gate(await fresh(), f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(true)
    const capacity = (await definitions.listCandidates(scope.scopeRef, f.target.workspaceId, {}, ctx)).find((row) => row.logicalId === 'capacity')
    if (capacity?.payload.kind !== 'attribute') throw new Error('missing current capacity')
    const wrong = await editing.edit(f.target.workspaceId, { candidateId: capacity.candidateId, expectedRevision: '2', payload: { ...capacity.payload, unitCode: 'MW' }, reason: 'independent negative: author changed unit although original template is kW', idempotencyKey: `wrong-unit-${randomUUID()}` }, ctx.principal.subjectId, ctx)
    const wrongTerm = wrong.candidates[0]; if (wrongTerm === undefined) throw new Error('missing actual wrong-unit body')
    await review(wrongTerm.candidateId)
    expect(await gate(await fresh(), f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(false)
  }, 30_000)

  it('refuses current body, dependency, source and fragment corruption even after the real ledger reviews the actual changed digest', async () => {
    const f = await setup(), gate = createCompetencyValidationTargetReader(options)
    const original = f.currentRules.find((row) => row.logicalId === 'grant-rule')
    if (original?.generationContext === undefined) throw new Error('missing actual downstream context')
    const forgedClause = { ...original.payload.condition, spans: original.payload.condition.spans.map((span) => ({ ...span, chunkId: randomUUID() })) }
    const actualSources = await grounding.read({ workspaceId: f.target.workspaceId, sourceRefs: [f.sourceRef] }, ctx, new SourceGroundingBudget(new AbortController().signal))
    const other = actualSources.sources[0]?.contents[1]
    if (other?.kind !== 'text' || other.sourceSpan.kind === 'structured') throw new Error('missing actual second policy fragment')
    const wrongRealClause = { ...original.payload.condition, spans: [other.sourceSpan] }
    const cases = [
      { label: 'conclusion', payload: { ...original.payload, conclusion: { predicate: 'granted', value: false } }, context: original.generationContext, spans: original.sourceSpans },
      { label: 'condition', payload: { ...original.payload, condition: { op: 'compare' as const, attributeId: 'eligible', operator: 'eq' as const, value: false, spans: original.payload.condition.spans } }, context: original.generationContext, spans: original.sourceSpans },
      { label: 'dependency', payload: { ...original.payload, dependencyRefs: (original.payload.dependencyRefs ?? []).map((ref) => ({ ...ref, predicate: 'exempt' })) }, context: original.generationContext, spans: original.sourceSpans },
      { label: 'forged-rule-clause', payload: { ...original.payload, condition: forgedClause, support: { ...original.payload.support, condition: forgedClause } }, context: original.generationContext, spans: original.sourceSpans },
      { label: 'empty-condition-origin', payload: { ...original.payload, condition: { ...original.payload.condition, spans: [] }, support: { ...original.payload.support, condition: { ...original.payload.condition, spans: [] } } }, context: original.generationContext, spans: original.sourceSpans },
      { label: 'wrong-real-clause-origin', payload: { ...original.payload, condition: wrongRealClause, support: { ...original.payload.support, condition: wrongRealClause } }, context: original.generationContext, spans: original.sourceSpans },
      { label: 'wrong-real-fragment', payload: original.payload, context: { ...original.generationContext, sourceSelections: original.generationContext.sourceSelections.map((selection) => ({ ...selection, fragmentIndex: 1 })) }, spans: original.sourceSpans },
      { label: 'source', payload: original.payload, context: original.generationContext, spans: original.sourceSpans.map((span) => ({ ...span, parseId: randomUUID() })) },
    ]
    for (const input of cases) {
      // Fault injection into the real saved body, followed by the actual human
      // ledger: no fake stores or supplied approval flags can pass this gate.
      const digest = ruleActionGroundedContentDigest({ ...original, payload: input.payload, generationContext: input.context, sourceSpans: input.spans })
      await harness.adminClient.query('UPDATE agent_platform.asset_rule_action_candidates SET payload=$1::jsonb,generation_context=$2::jsonb,source_spans=$3::jsonb,content_digest=$4 WHERE tenant_id=$5 AND space_id=$6 AND candidate_id=$7', [JSON.stringify(input.payload), JSON.stringify(input.context), JSON.stringify(input.spans), digest, scope.tenantId, scope.spaceId, original.candidateId])
      await review(original.candidateId)
      const pins = f.target.ruleActionPins.map((pin) => pin.candidateId === original.candidateId ? { ...pin, contentDigest: digest } : pin)
      expect(await gate({ ...f.target, ruleActionPins: pins }, f.template, f.definition, f.templateRules, ctx, new AbortController().signal), input.label).toBe(false)
    }
  }, 30_000)

  it('fences actual late current review changes and cancellation after real source reads', async () => {
    const f = await setup()
    const reaffirm = createCompetencyValidationTargetReader({ ...options, grounding: { read: async (...args) => { const actual = await grounding.read(...args); await review(f.currentRules[0]!.candidateId); return actual } } })
    expect(await reaffirm(f.target, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(true)
    const reject = createCompetencyValidationTargetReader({ ...options, grounding: { read: async (...args) => { const actual = await grounding.read(...args); await review(f.terms.candidates[0]!.candidateId, 'reject'); return actual } } })
    expect(await reject(f.target, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(false)
    await review(f.terms.candidates[0]!.candidateId)
    const controller = new AbortController()
    const cancel = createCompetencyValidationTargetReader({ ...options, grounding: { read: async (...args) => { const actual = await grounding.read(...args); controller.abort(); return actual } } })
    await expect(cancel(f.target, f.template, f.definition, f.templateRules, ctx, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const move = createCompetencyValidationTargetReader({ ...options, grounding: { read: async (...args) => { const actual = await grounding.read(...args); const draft = await workspaces.getDraft(scope.scopeRef, f.target.workspaceId, '2', ctx); if (draft === undefined) throw new Error('missing actual draft');
      await workspaceService.draftOperation(f.target.workspaceId, { operation: 'edit', expectedRevision: '2', documentSetRef: draft.documentSetRef, reason: 'actual human moved the current source draft during read' }, `move-${randomUUID()}`, ctx.principal.subjectId, ctx); return actual } } })
    expect(await move(f.target, f.template, f.definition, f.templateRules, ctx, new AbortController().signal)).toBe(false)
  }, 30_000)

  it('keeps honest required CQ preview blocked and rechecks the actual body review at application and physical PG publication', async () => {
    const f = await setup(), workflow = createCompetencyQuestionWorkflow({ blobs, registry, reviews: publications })
    const reviewable = new CompositeReviewableCandidateReader({ definition: definitions, instance: instances, ruleActions: rules, competencyQuestions: workflow.service })
    const cqReviewer = new SemanticPublicationService({ store: publications, candidates: instances, identity: new PostgresIdentityDecisionStore(database), schemaSource: schemas, reviewableCandidates: reviewable })
    const bytes = new TextEncoder().encode('Actual foreign original: inspected=true; no current-scope permission.\n')
    const foreignCtx = toolContext(foreign.tenantId, foreign.spaceId, ['platform-admin'])
    const foreignOriginal = await workflow.uploadSource(bytes, 'text/plain', foreignCtx)
    const projectId = randomUUID()
    const body: CompetencyQuestionSetBody = { schemaVersion: 'competency-questions@1', classification: 'synthetic_demo_not_an_industry_standard', execution: 'not_run', industryId: 'actual-source-permission-negative',
      definitionRefs: [f.definition.ref], ruleRefs: [], sourceRefs: [foreignOriginal], allowedCapabilities: ['semantic_read'],
      questions: [{ questionId: 'unavailable-authorized-original', question: 'Can this current target use the independently archived foreign original?', taskKind: 'published_facts', definitionRef: f.definition.ref, ruleRefs: [],
        input: { dataMode: 'synthetic', scopeRef: scope.scopeRef, projectId, validAt: '2026-10-09T00:00:00Z', asOfRecordedSeq: '1', observations: [], relations: [] },
        intent: { kind: 'attribute', projectId, objectId: 'facility', subjectEntityId: 'F-01', attributeId: 'inspected' }, requiredCapabilities: ['semantic_read'],
        requiredSources: [{ sourceRef: foreignOriginal, offsetUnit: 'utf8_byte', startOffset: 0, endOffset: bytes.length, quoteDigest: foreignOriginal.digest }],
        expected: { kind: 'unknown', reason: 'no authorized source or observations exist in the current scope' }, goldOrigin: 'authored_oracle', derivation: 'independent source authorization negative, never a successful execution', specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'] }],
      externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] } }
    const declaration = { ref: { id: 'actual-cq-preview', version: '1.0.0', digest: contentDigestOf(body) }, body }
    const valid = workflow.boundary.validate(declaration)
    expect(valid, 'errors' in workflow.boundary.validate ? JSON.stringify(workflow.boundary.validate.errors) : 'actual canonical declaration schema').toBe(true)
    const saved = await workflow.service.upload(declaration, ctx)
    const cqReview = async (decision: 'approve' | 'reject') => cqReviewer.reviewCandidate({ candidateId: saved.ref.id, expectedRevision: await publications.latestReviewRevision(scope.scopeRef, saved.ref.id, ctx), decision, reason: `human ${decision} of exact source-permission negative body ${randomUUID()}` }, ctx)
    await cqReview('approve')
    let executed = false
    const runner = new CompetencyRunner({ questions: workflow.service, boundary: workflow.boundary, sources: workflow.sources, validateActual: workflow.validateActual,
      execution: { execute: async () => { executed = true; throw new Error('an actually unavailable authorized original must stop before execution') } } })
    let physicalReads = 0
    const packs = new PostgresPublishedPackAssetStore(database, { competencyBodies: { read: async (request, context) => {
      physicalReads += 1
      const ref = request.approvedInputRefs[0]; if (ref === undefined || request.approvedInputRefs.length !== 1) throw new Error('physical CQ read requires its exact actual body')
      return blobs.readAuthorized({ scopeRef: { tenantId: context.principal.tenantId, spaceId: context.allowedResources.spaceId }, blobRef: ref }, context)
    } } }), sets = new PostgresSyntheticExampleSetStore(database), reports = new PostgresIndustryValidationReportStore(database)
    const editing = new DefinitionCandidateEditingService({ workspaces, candidates: definitions, editing: new PostgresDefinitionEditingStore(database), publishedDefinitions, publishedPacks: packs, reviews: publications, reviewableCandidates: reviewable, terminology: new StaticDefinitionTerminologySource() })
    const sample = await new SyntheticExampleService({ workspaces, sets }).generate(f.target.workspaceId, { expectedRevision: '2', idempotencyKey: `preview-example-${randomUUID()}`, caseKinds: ['missing_parameter'],
      cases: [{ caseId: 'missing', caseKind: 'missing_parameter', objectTypeRef: 'facility', fields: [{ fieldId: 'native', value: 'F-01' }, { fieldId: 'inspected', value: null }, { fieldId: 'exempt', value: false }, { fieldId: 'eligible', value: null }] }],
      expectations: ['eligible-rule', 'grant-rule'].map((ruleId) => ({ expectationId: ruleId, caseId: 'missing', kind: 'rule' as const, ruleId, expected: 'unknown' as const, origin: 'authored_oracle' as const, reason: 'authored missing observation retains unknown', confirmedBy: ctx.principal.subjectId, confirmedAt: new Date().toISOString() })) }, ctx.principal.subjectId, ctx)
    const report = await new IndustryValidationService({ workspaces, exampleSets: sets, definitions: editing, ruleActions: rules, support: new FiniteGrammarRuleSupportValidator(), evaluator: new FiniteGrammarSyntheticEvaluator(), reports, competencyRunner: runner, requireCompetencyQuestions: true }).validate(f.target.workspaceId,
      { exampleSetId: sample.exampleSetId, expectedRevision: '2', idempotencyKey: `preview-validation-${randomUUID()}`, competencyQuestionRef: saved.ref }, ctx.principal.subjectId, ctx)
    expect(executed).toBe(false); expect(report.semanticPublished.passed).toBe(true); expect(report.deploymentExecutable.passed).toBe(false)
    expect(report.competency?.results[0]?.status).toBe('not_yet_executable'); expect(report.competency?.passed).toBe(false)
    const publishing = new IndustryAssetPublicationService({ workspaces, validations: reports, definitionCandidates: definitions, ruleActions: rules, syntheticSets: sets, definitions: publishedDefinitions, store: packs, reviews: publications, reviewableCandidates: reviewable, requireCompetencyQuestions: true, competencyQuestions: workflow.service })
    const publish = (packId: string, requireDeploymentExecutable = false) => publishing.publish(f.target.workspaceId, { packId, version: '1.0.0', validationId: report.validationId, expectedRevision: '2', idempotencyKey: `preview-publish-${randomUUID()}`, requireDeploymentExecutable }, ctx.principal.subjectId, ctx)
    await expect(publish('blocked-required-deployment', true)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
    await cqReview('reject'); await expect(publish('rejected-before-application')).rejects.toMatchObject({ code: 'VALIDATION_STALE' })
    await cqReview('approve')
    const commit = packs.commitApprovedPack.bind(packs)
    const rejecting = vi.spyOn(packs, 'commitApprovedPack').mockImplementationOnce(async (...args) => { await cqReview('reject'); return commit(...args) })
    try {
      const error: unknown = await publish('rejected-before-pg').catch((error: unknown) => error)
      expect(error, error instanceof Error ? `${error.message} cause=${error.cause instanceof Error ? error.cause.message : String(error.cause)}` : 'physical PG review guard').toMatchObject({ code: 'VERSION_CONFLICT' })
    } finally { rejecting.mockRestore() }
    await cqReview('approve')
    const missingReader = vi.spyOn(packs, 'commitApprovedPack').mockImplementationOnce((...args) => new PostgresPublishedPackAssetStore(database).commitApprovedPack(...args))
    try { await expect(publish('missing-physical-body-reader')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }) } finally { missingReader.mockRestore() }
    const original = new TextEncoder().encode(canonicalJson(body)), bodyPath = join(directory, 'objects', objectKeyForDigest(saved.ref.digest))
    const corrupting = vi.spyOn(packs, 'commitApprovedPack').mockImplementationOnce(async (...args) => { const changed = original.slice(); changed[0] = 32; await writeFile(bodyPath, changed); return commit(...args) })
    try { await expect(publish('body-changed-before-pg')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }) } finally { corrupting.mockRestore(); await writeFile(bodyPath, original) }
    expect(physicalReads).toBeGreaterThan(0)
    expect((await harness.adminClient.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_platform.published_pack_assets WHERE tenant_id=$1 AND space_id=$2 AND asset->>'workspaceId'=$3", [scope.tenantId, scope.spaceId, f.target.workspaceId])).rows[0]?.count).toBe('0')
    expect((await harness.adminClient.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND topic='asset.pack.published' AND payload->>'workspaceId'=$3", [scope.tenantId, scope.spaceId, f.target.workspaceId])).rows[0]?.count).toBe('0')
    await cqReview('approve')
    const reaffirming = vi.spyOn(packs, 'commitApprovedPack').mockImplementationOnce(async (...args) => { await cqReview('approve'); return commit(...args) })
    try { const published = await publish('same-body-preview'); expect(published.capabilities.deploymentExecutable).toBe(false) } finally { reaffirming.mockRestore() }
  }, 30_000)
})
