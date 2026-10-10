import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CompositeReviewableCandidateReader, ComponentRegistry, DefinitionCandidateEditingService, DefinitionCandidateGenerationService, IndustryAssetPublicationService, IndustryValidationService, IndustryWorkspaceService, InMemoryIndustrySchemaSource, ProfileResolver, PublishedPackRuleDeclarationReader, RuleActionCandidateGenerationService, RuleActionCandidateService, StaticDefinitionTerminologySource, StoreBackedIndustryManifestSource, SyntheticExampleService, canonicalJson, createSourceGroundingService, currentDefinitionProjection, currentRuleActionProjection, definitionApprovalPins, ruleActionPublicationPins, readWorkspacePublicationSourceDrafts } from '@ontology/application'
import { ArtifactGroundingDocumentSetReader, LocalDocumentExtractionService, ParsedSourceGroundingReader, publishGroundingDocumentSet } from '@ontology/adapter-extraction-document'
import type { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import type { LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresRepository, PostgresAssetCandidateStore, PostgresAssetWorkspaceStore, PostgresCandidateStore, PostgresComponentRegistryStore, PostgresDefinitionEditingStore, PostgresIdentityDecisionStore, PostgresIndustryValidationReportStore, PostgresJobStore, PostgresProfileStore, PostgresProjectStore, PostgresPublishedPackAssetStore, PostgresRuleActionCandidateStore, PostgresRuleActionGenerationStore, PostgresSemanticDefinitionStore, PostgresSemanticPublicationStore, PostgresSyntheticExampleSetStore } from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, SemanticPublicationService } from '@ontology/semantic-engine'
import { createBlobArtifactWriter, createCompetencyQuestionWorkflow, createCompetencyValidationTargetReader } from '@ontology/app-api'
import type { CompetencyTemplateBinding } from '@ontology/app-api'
import type { Capability, ComponentManifest, CompetencyValidationTarget, GenerationEvent, GenerationPort, GenerationRequest, RuleCandidateVersion, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { canonicalManifestValidator } from '../unit/component-registry-fixtures'
import { canonicalProfileValidator } from '../unit/profile-resolver-fixtures'

class AuthoredPolicyProposal implements GenerationPort {
  constructor(readonly output: unknown) {}
  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    void request
    yield { type: 'text_delta', text: canonicalJson(this.output) }
    yield { type: 'completed', stopReason: 'stop', candidateOnly: true }
  }
}
const version = (ref: VersionRef): VersionRef => ({ id: ref.id, version: ref.version, digest: ref.digest })
/** Real current-domain generation/review/publication. No CQ gold or expected execution result enters this factory. */
export async function createPackOriginFixture(input: { readonly database: ControlPostgresDatabase; readonly blobs: LocalImmutableBlobStore; readonly registry: PostgresArtifactRegistry; readonly parses: PostgresDocumentParseStore; readonly structured: PostgresStructuredIngestionStore; readonly scope: ScopeRef; readonly ctx: ToolContext; readonly declarationKind?: 'business_conclusion' }) {
  const { database: db, blobs, registry, parses, structured, scope, ctx } = input
  const workspaces = new PostgresAssetWorkspaceStore(db), terms = new PostgresAssetCandidateStore(db), actions = new PostgresRuleActionCandidateStore(db), batches = new PostgresRuleActionGenerationStore(db)
  const candidates = new PostgresCandidateStore(db), reviews = new PostgresSemanticPublicationStore(db), definitions = new PostgresSemanticDefinitionStore(db), jobs = new PostgresJobStore(db), identities = new PostgresIdentityDecisionStore(db)
  const questionWorkflow = createCompetencyQuestionWorkflow({ blobs, registry, reviews })
  const reviewable = new CompositeReviewableCandidateReader({ definition: terms, instance: candidates, ruleActions: actions, competencyQuestions: questionWorkflow.service })
  const reviewer = new SemanticPublicationService({ store: reviews, candidates, identity: identities, schemaSource: new InMemoryIndustrySchemaSource(), reviewableCandidates: reviewable })
  const writer = createBlobArtifactWriter(blobs)
  const put = async (body: unknown) => (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson(body)) }, ctx)).blobRef
  const business = input.declarationKind === 'business_conclusion'
  const termCount = business ? 5 : 4
  const workspaceId = randomUUID()
  const empty = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', workspaceId, scopeRef: scope, sources: [] }, ctx)
  let firstId = true
  const workspaceService = new IndustryWorkspaceService({ store: workspaces, jobs, newId: () => { if (firstId) { firstId = false; return workspaceId }; return randomUUID() } })
  const created = await workspaceService.createWorkspace({ namespace: `pack-origin-${workspaceId}`, displayName: 'Actual current pack-origin fixture', boundary: { goals: ['independently validate maintenance'], included: [], excluded: [], applicability: {} }, documentSetRef: empty }, `create-${workspaceId}`, ctx.principal.subjectId, ctx)
  if (created.workspace.workspaceId !== workspaceId) throw new Error('actual empty corpus workspace pin differs')
  const policyBytes = new TextEncoder().encode(`Machines are identified by machine_id within each project. hours is a quantity in h; batch_note is optional text. The maintenance rule applies to machines in this project when hours is at least 8 h.${business ? ' The separately reviewed business consequence sets maintenance_required to true; this is an optional boolean field.' : ''}\nOriginal policy identity: ${workspaceId}\n`)
  const policy = await questionWorkflow.uploadSource(policyBytes, 'text/plain', ctx)
  const parsed = await new LocalDocumentExtractionService({ blobs, store: parses }).parse({ scopeRef: scope, originalRef: { ...policy, kind: 'document' }, documentVersionRef: { ...policy, kind: 'document' } }, ctx)
  if (parsed.coverage.status !== 'complete') throw new Error('actual policy source did not parse completely')
  const corpus = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', workspaceId, scopeRef: scope, sources: [{ sourceRef: parsed.originalRef, state: 'approved', kind: 'document', parseId: parsed.parseId, parserVersion: parsed.parserVersion }] }, ctx)
  await workspaceService.draftOperation(workspaceId, { expectedRevision: '1', operation: 'edit', reason: 'human selected actual original policy', documentSetRef: corpus }, `source-${workspaceId}`, ctx.principal.subjectId, ctx)
  const policyRef = version(await put({ schemaVersion: 'actual-pack-origin-generation-policy@1', requiresHumanReview: true, sourceTrust: 'untrusted_source_data', maxCandidates: termCount }))
  const grounding = createSourceGroundingService({ workspaces, documentSets: new ArtifactGroundingDocumentSetReader(blobs), reader: new ParsedSourceGroundingReader({ blobs, documents: parses, tables: structured }) })
  const common = { businessMeaning: 'independently authored original machine policy', suggestedReason: 'original policy text', sourceIndex: 0, fragmentIndex: 0 }
  const proposedTerms = { objects: [{ ...common, logicalId: 'machine', displayName: 'Machine', identityAttributeIds: ['machine_id'], identityScopeDimensions: ['project'] }], attributes: [
    { ...common, logicalId: 'machine_id', objectLogicalId: 'machine', displayName: 'Machine identity', valueType: 'string', minCardinality: 1, maxCardinality: 1 },
    { ...common, logicalId: 'hours', objectLogicalId: 'machine', displayName: 'Operating hours', valueType: 'quantity', unitCode: 'h', dimension: 'time', minCardinality: 1, maxCardinality: 1 },
    { ...common, logicalId: 'batch_note', objectLogicalId: 'machine', displayName: 'Source batch note', valueType: 'string', minCardinality: 0, maxCardinality: 1 }, ...(business ? [{ ...common, logicalId: 'maintenance_required', objectLogicalId: 'machine', displayName: 'Maintenance required', valueType: 'boolean', minCardinality: 0, maxCardinality: 1 }] : [])] }
  const generated = await new DefinitionCandidateGenerationService({ workspaces, candidates: terms, terminology: new StaticDefinitionTerminologySource(), sourceGrounding: grounding, generationForRun: () => new AuthoredPolicyProposal(proposedTerms), modelRef: { modelId: 'controlled-authored-policy', version: '1.0.0' }, outputLimit: { maxTokens: 4096 } }).generate({ workspaceId, expectedRevision: '2', kinds: ['object','attribute'], sourceRefs: [parsed.originalRef], generationPolicyRef: policyRef, candidateLimit: termCount, idempotencyKey: `terms-${workspaceId}` }, ctx.principal.subjectId, ctx)
  if (generated.candidates.length !== termCount || generated.candidates.some((row) => row.pendingConfirmation || row.issues.length > 0)) throw new Error(`real TBox generation failed: ${canonicalJson(generated.batch)}`)
  const review = async (candidateId: string, decision: 'approve' | 'reject' = 'approve') => reviewer.reviewCandidate({ candidateId, expectedRevision: await reviews.latestReviewRevision(scope, candidateId, ctx), decision, reason: `human ${decision} of the actual immutable body and original source` }, ctx)
  for (const term of generated.candidates) await review(term.candidateId)
  const ruleService = new RuleActionCandidateService({ workspaces, candidates: actions, support: new FiniteGrammarRuleSupportValidator() })
  const generatedRules = await new RuleActionCandidateGenerationService({ workspaces, definitionCandidates: terms, candidates: actions, batches, service: ruleService, terminology: new StaticDefinitionTerminologySource(), sourceGrounding: grounding, generationForRun: () => new AuthoredPolicyProposal({ rules: [{ ruleId: 'maintenance', objectId: 'machine', displayName: 'Maintenance applies', businessMeaning: 'Operating hours satisfy the original policy threshold', suggestedReason: 'original policy', applicabilityNote: 'machines in this project', condition: { op: 'compare', attributeId: 'hours', operator: 'gte', value: '8', unitCode: 'h' }, exceptions: [], ...(business ? { conclusion: { predicate: 'maintenance_required', value: true } } : {}), sourceSelections: ['applicability','condition', ...(business ? ['conclusion'] : [])].map((path) => ({ path, sourceIndex: 0, fragmentIndex: 0 })) }] }), modelRef: { modelId: 'controlled-authored-rule', version: '1.0.0' }, outputLimit: { maxTokens: 4096 } }).generate({ workspaceId, expectedRevision: '2', kinds: ['rule'], sourceRefs: [parsed.originalRef], selectedDefinitionCandidateIds: generated.candidates.map((row) => row.candidateId), generationPolicyRef: policyRef, candidateLimit: 1, idempotencyKey: `rule-${workspaceId}` }, ctx.principal.subjectId, ctx)
  const generatedRule = generatedRules.candidates[0]
  if (generatedRule?.payload.kind !== 'rule' || generatedRule.generationContext?.issues.length !== 0 || !generatedRule.payload.support.executable) throw new Error(`real rule generation failed: ${canonicalJson(generatedRules.batch)}`)
  await review(generatedRule.candidateId)
  await ruleService.enableRuleCandidate(workspaceId, { candidateId: generatedRule.candidateId, expectedRevision: '2' }, ctx)
  const currentRules = currentRuleActionProjection(await actions.list(scope, workspaceId, {}, ctx)).filter((row): row is RuleCandidateVersion => row.kind === 'rule' && row.payload.kind === 'rule')
  const sourceRule = currentRules[0]; if (sourceRule === undefined) throw new Error('actual enabled current rule is missing')
  const projection = currentDefinitionProjection(await terms.listCandidates(scope, workspaceId, {}, ctx))
  const approvals = await definitionApprovalPins(projection, scope, ctx, reviewable, reviews)
  if (approvals.blockers.length > 0) throw new Error('actual full current definition is not approved')
  const targetBeforePublication: CompetencyValidationTarget = { workspaceId, revision: '2', definitionApprovalPins: approvals.pins, ruleActionPins: ruleActionPublicationPins(currentRules) }
  const reports = new PostgresIndustryValidationReportStore(db), sets = new PostgresSyntheticExampleSetStore(db)
  const packs = new PostgresPublishedPackAssetStore(db, { competencyBodies: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (request.approvedInputRefs.length !== 1 || ref === undefined) throw new Error('actual CQ body read requires one pin'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
  const editing = new DefinitionCandidateEditingService({ workspaces, candidates: terms, editing: new PostgresDefinitionEditingStore(db), publishedDefinitions: definitions, publishedPacks: packs, reviews, reviewableCandidates: reviewable, terminology: new StaticDefinitionTerminologySource() })
  const sample = await new SyntheticExampleService({ workspaces, sets }).generate(workspaceId, { expectedRevision: '2', idempotencyKey: `sample-${workspaceId}`, caseKinds: ['missing_parameter'], cases: [{ caseId: 'missing-hours', caseKind: 'missing_parameter', objectTypeRef: 'machine', fields: [{ fieldId: 'machine_id', value: 'M-1' }, { fieldId: 'hours', value: null }] }], expectations: [{ expectationId: 'missing-is-unknown', caseId: 'missing-hours', kind: 'rule', ruleId: 'maintenance', expected: 'unknown', origin: 'authored_oracle', reason: 'a missing observed value cannot establish the threshold', confirmedBy: ctx.principal.subjectId, confirmedAt: new Date().toISOString() }] }, ctx.principal.subjectId, ctx)
  const validation = new IndustryValidationService({ workspaces, exampleSets: sets, definitions: editing, ruleActions: actions, support: new FiniteGrammarRuleSupportValidator(), evaluator: new FiniteGrammarSyntheticEvaluator(), reports, requireCompetencyQuestions: true })
  const report = await validation.validate(workspaceId, { exampleSetId: sample.exampleSetId, expectedRevision: '2', idempotencyKey: `semantic-${workspaceId}` }, ctx.principal.subjectId, ctx)
  if (!report.semanticPublished.passed || report.deploymentExecutable.passed) throw new Error(`actual semantic-only gate failed: ${canonicalJson(report)}`)
  const publication = new IndustryAssetPublicationService({ workspaces, validations: reports, definitionCandidates: terms, ruleActions: actions, syntheticSets: sets, definitions, store: packs, reviews, reviewableCandidates: reviewable, requireCompetencyQuestions: true, competencyQuestions: questionWorkflow.service })
  const asset = await publication.publish(workspaceId, { packId: 'actual-origin', version: '1.0.0', validationId: report.validationId, expectedRevision: '2', idempotencyKey: `pack-${workspaceId}`, requireDeploymentExecutable: false }, ctx.principal.subjectId, ctx)
  if (!asset.capabilities.semanticPublished || asset.capabilities.deploymentExecutable) throw new Error('actual preview publication must not grant deployment authority')
  const definition = await definitions.findVersion(asset.namespace, asset.definitionRef.id, asset.definitionRef.version, scope, ctx)
  if (definition === undefined) throw new Error('actual preview definition is missing')
  const componentStore = new PostgresComponentRegistryStore(db), controls = new ControlPostgresRepository(db)
  const components = new ComponentRegistry({ control: controls, store: componentStore, artifacts: blobs, validator: canonicalManifestValidator() })
  const register = async (manifest: ComponentManifest, bytes: Uint8Array) => {
    const staged = await blobs.stage(bytes, { scopeRef: scope }, ctx), artifact = await blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'application/octet-stream', purpose: 'artifact' }, ctx)
    const registered = await components.register({ scopeRef: scope, manifest, artifactRef: artifact.blobRef, source: 'operator' }, ctx)
    await components.transition({ scopeRef: scope, kind: manifest.kind, ref: registered.manifestRef, to: 'validated' }, ctx)
    return (await components.transition({ scopeRef: scope, kind: manifest.kind, ref: registered.manifestRef, to: 'active' }, ctx)).manifestRef
  }
  const limits = { maxRows: 1, maxBytes: 1_048_576, maxDurationMs: 300_000 }, capability = (name: string): Capability => ({ name, version: '1.0.0', limits, consistency: 'immutable' as const, cancellation: 'supported' as const, pagination: 'none' as const, supportedDataTypes: ['string'] })
  await register({ kind: 'industry_pack', id: asset.packRef.id, version: asset.packRef.version, digest: asset.packRef.digest, contractRange: { min: '0.2.0', max: '1.0.0' }, provides: [capability('semantic_schema'), capability('semantic_read')], requires: [], entrypointRef: { kind: 'package', ref: 'declarative-industry-manifest' }, trustStatus: 'local_dev', namespace: asset.namespace }, new TextEncoder().encode(canonicalJson(asset)))
  const registerCode = async (kind: 'runtime' | 'compute_extension', id: string, path: string, name: string) => {
    const bytes = await readFile(fileURLToPath(new URL(path, import.meta.url)))
    const stored = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/octet-stream', content: bytes }, ctx)).blobRef
    return register({ kind, id, version: '1.0.0', digest: stored.digest, contractRange: { min: '0.2.0', max: '1.0.0' }, provides: [capability(name)], requires: [], entrypointRef: { kind: 'package', ref: kind === 'runtime' ? '@ontology/adapter-runtime-template' : '@ontology/semantic-engine' }, trustStatus: 'local_dev' }, bytes)
  }
  const runtimeRef = await registerCode('runtime', `actual-pack-runtime-${workspaceId}`, '../../packages/adapters/runtime-template/src/runtime.ts', 'runtime_template')
  const producerComponentRef = await registerCode('compute_extension', `actual-pack-producer-${workspaceId}`, '../../packages/semantic-engine/src/provenance/rule-derivation-producer.ts', 'rule_derivation_evidence')
  const catalogue = version(await put({ schemaVersion: 'actual-pack-identity-catalogue@1', scopeRef: scope, definitionRef: definition.ref, identityScopes: definition.identityScopes, dataMode: 'synthetic', businessApproval: 'none' }))
  const profilePolicy = version(await put({ schemaVersion: 'actual-pack-profile-policy@1', dataMode: 'synthetic', businessApproval: 'none' }))
  const profiles = new ProfileResolver({ control: controls, store: new PostgresProfileStore(db), registry: componentStore, industry: new StoreBackedIndustryManifestSource({ store: packs }), validator: canonicalProfileValidator() })
  const profile = { id: `actual-pack-profile-${workspaceId}`, version: '1.0.0' }
  await profiles.publish({ scopeRef: scope, profileRef: profile, environment: 'local_dev', spec: { industryRef: asset.packRef, mappingRefs: [{ ...catalogue, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'competency-preview', sourceId: catalogue.id }, objectPath: 'fixed_project_snapshots' } }], runtimeRef, backendBindings: {}, modelBindings: {}, toolBindings: [{ toolId: 'ontology_lookup', enabled: true }], computeBindings: [], policyRef: profilePolicy } }, ctx)
  const resolved = await profiles.bindRunProfile(profile, scope, ctx)
  const publishedRules = new PublishedPackRuleDeclarationReader({ packs, registry: componentStore, definitions, candidates: actions, reviews, reviewableCandidates: reviewable, projects: new PostgresProjectStore(db) })
  const rules = await publishedRules.read(scope, { packRef: asset.packRef, definitionRef: definition.ref }, ctx)
  if (rules.length !== 1 || rules[0]?.sourceCandidateId !== sourceRule.candidateId) throw new Error('actual12 reader did not preserve the same current-domain candidate')
  const template: CompetencyTemplateBinding = { schemaVersion: 'competency-template-binding@1', sourceOrigin: 'published_pack', declarationDefinitionRef: definition.ref, definitionRef: definition.ref, namespace: definition.namespace, packRef: asset.packRef, profileRef: resolved.resolvedProfileRef, rules: rules.map((rule) => ({ origin: 'pack', declarationRef: rule.ruleRef, publishedRef: rule.ruleRef, sourceCandidateId: rule.sourceCandidateId, publishedPackRef: rule.publishedPackRef })), dataMode: 'synthetic', businessApproval: 'none' }
  const bindingRef = await put(template)
  const nativeBytes = new TextEncoder().encode(`machine_id,hours,batch_note\nM-1,9.000000000000000001,source-${workspaceId}\n`)
  const original = await questionWorkflow.uploadSource(nativeBytes, 'text/csv', ctx)
  const workspace = await workspaces.getWorkspace(scope, workspaceId, ctx)
  if (workspace === undefined) throw new Error('actual published workspace is missing')
  const target: CompetencyValidationTarget = { ...targetBeforePublication, revision: workspace.headRevision }
  const targetReader = createCompetencyValidationTargetReader({ workspaces, definitionCandidates: terms, ruleActions: actions, ruleGeneration: batches, reviews, reviewableCandidates: reviewable, definitions, candidates, grounding, publishedRules, packs,
    sourceDraft: async (actualScope, actualWorkspaceId, currentDraft, actualContext, signal) => (await readWorkspacePublicationSourceDrafts({ workspaces, packs, definitions: terms, ruleActions: actions }, actualScope, actualWorkspaceId, currentDraft, actualContext, signal)).at(-1) })
  return { workspaceService, workspaces, terms, actions, reviews, reviewer, review, packs, definitions, definition, sourceRule, projection, target, targetBeforePublication, template, bindingRef, publishedRules, rules, targetReader, producerComponentRef, asset, report, sample, reports, sets, editing, publication, questionWorkflow, policy, policyBytes, original, nativeBytes, resolved, workspace, put }
}
