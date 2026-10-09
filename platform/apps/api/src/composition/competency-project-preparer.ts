import { createHash, randomUUID } from 'node:crypto'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { PostgresAssetCandidateStore, PostgresCandidateStore, PostgresComponentRegistryStore, PostgresEvidenceStore, PostgresIdentityDecisionStore, PostgresInstanceReviewStore, PostgresJobStore, PostgresMaterializationStore, PostgresProfileStore, PostgresProjectDocumentStore, PostgresProjectMappingStore, PostgresProjectReadinessStore, PostgresProjectRecordStore, PostgresProjectStore, PostgresSemanticDefinitionStore, PostgresSemanticPublicationStore } from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { DocumentSpanReader, LocalStructuredIngestionService, StructuredDocumentParser, StructuredDocumentProjectionService, StructuredPremiseSourceReader } from '@ontology/adapter-extraction-document'
import type { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { CompetencyQuestionError, IndustryAssetPublicationError, assertPublishedPackAssetShape, createToolContext, isRecord, isToolContext, isUuid } from '@ontology/contracts'
import type { ColumnMappingEntry, CompetencyExecutionRequest, CompetencyValidationTarget, EntityCandidate, InstanceRecordView, MappingRef, ProjectDatasetQueryPort, ProjectDatasetWriterPort, ProjectRecordVersion, ProjectRevision, ProjectRevisionBody, ProjectSnapshotQueryPort, ResolvedProfileRef, ResourceRef, RuleCandidate, CandidateSourceSpan, PublishedPackAsset, PublishedPackAssetStore, PublishedPackRuleVersion, PublishedRuleDeclarationReader, ScopeRef, SemanticDefinitionVersion, ToolContext, ToolGateway, VersionRef, RegisteredOperation } from '@ontology/contracts'
import { CompositeReviewableCandidateReader, InMemoryIndustrySchemaSource, InstanceReviewService, JobService, ProjectDataMaterializationService, ProjectMappingService, ProjectService, canonicalJson, encodeStructuredExtractionRef, sha256DigestOf, resolvedProfileDigest, publishedPackContentDigest, contentDigestOf } from '@ontology/application'
import { ArchivedRulePremiseReplayVerifier, IncrementalMaterializer, InMemoryIdentityIndexReader, MaterializedRuleDerivationEvidenceProducer, ProjectSemanticQueryService, PublishedProjectDatasetSource, PublishedRelationNavigator, PublishedSemanticSource, definitionVersionDigest, projectIndustrySchema, publishedRuleDependencyRef, publishedRuleRef } from '@ontology/semantic-engine'
import type { IdentityIndexReader, PublishedSemanticData } from '@ontology/semantic-engine'
import { createProjectFactWorkflow } from './project-facts'
import { createInstanceIdentityWorkflow } from './instance-identity'
import { createBlobArtifactWriter } from './tool-gateway'
import type { CompetencyRuleAlias, CompetencyTemplateRuleSource, CompetencyPackRuleAlias } from './competency-rule-origins'
import type { PreparedCompetencyInput } from './competency-execution'

/** Alias mappings are archived host metadata; referenced semantic/profile bodies are reread. */
export interface CompetencyTemplateBinding {
  readonly schemaVersion: 'competency-template-binding@1'
  readonly sourceOrigin?: 'published_pack'
  readonly declarationDefinitionRef: VersionRef
  readonly definitionRef: VersionRef
  readonly namespace: string
  readonly packRef: VersionRef
  readonly profileRef: ResolvedProfileRef
  readonly rules: readonly CompetencyRuleAlias[]
  readonly dataMode: 'synthetic'
  readonly businessApproval: 'none'
}

export interface CompetencyProjectPreparerOptions {
  readonly database: ControlPostgresDatabase
  readonly blobs: LocalImmutableBlobStore
  readonly parses: PostgresDocumentParseStore
  readonly structured: PostgresStructuredIngestionStore
  readonly query: ProjectDatasetWriterPort & ProjectDatasetQueryPort & ProjectSnapshotQueryPort
  /** Actual registered host producer code pin, separate from business rule declarations. */
  readonly producerComponentRef: VersionRef
  /** Scoped immutable binding artifact selected by an actual stored template/draft. */
  readonly binding: (request: CompetencyExecutionRequest, ctx: ToolContext) => Promise<ResourceRef | undefined>
  /** Missing target integration blocks draft validation; hashes alone never authorize it. */
  readonly target?: (target: CompetencyValidationTarget, template: CompetencyTemplateBinding, definition: SemanticDefinitionVersion, rules: readonly CompetencyTemplateRuleSource[], ctx: ToolContext, signal: AbortSignal) => Promise<boolean>
  readonly publishedRules?: PublishedRuleDeclarationReader
  readonly packs?: Pick<PublishedPackAssetStore, 'findByRef'>
  readonly compute?: (input: { readonly project: ProjectRevision; readonly inputRef: ResourceRef; readonly profileRef: ResolvedProfileRef }, ctx: ToolContext, signal: AbortSignal) => Promise<{ readonly gateway: ToolGateway; readonly context: ToolContext; readonly operation: RegisteredOperation }>
}

function same(a: VersionRef, b: VersionRef): boolean { return a.id === b.id && a.version === b.version && a.digest === b.digest }
function sha256DigestOfBytes(bytes: Uint8Array): string { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
function ref(value: unknown): value is VersionRef { return isRecord(value) && typeof value['id'] === 'string' && typeof value['version'] === 'string' && typeof value['digest'] === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value['digest']) }
function templateOf(value: unknown): CompetencyTemplateBinding | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 'competency-template-binding@1' || value['dataMode'] !== 'synthetic' || value['businessApproval'] !== 'none' || typeof value['namespace'] !== 'string' || !ref(value['declarationDefinitionRef']) || !ref(value['definitionRef']) || !ref(value['packRef']) || !isRecord(value['profileRef']) || typeof value['profileRef']['id'] !== 'string' || typeof value['profileRef']['version'] !== 'string' || typeof value['profileRef']['snapshotHash'] !== 'string' || !Array.isArray(value['rules']) || value['rules'].length > 16) return undefined
  const rules: CompetencyTemplateBinding['rules'][number][] = []
  if (value['sourceOrigin'] !== undefined && value['sourceOrigin'] !== 'published_pack') return undefined
  for (const row of value['rules']) {
    if (!isRecord(row) || !ref(row['declarationRef']) || !ref(row['publishedRef']) || !isUuid(row['sourceCandidateId'])) return undefined
    if (row['origin'] === 'pack') {
      if (!ref(row['publishedPackRef']) || !same(row['declarationRef'], row['publishedRef']) || Object.keys(row).some((key) => !['origin','declarationRef','publishedRef','sourceCandidateId','publishedPackRef'].includes(key))) return undefined
      rules.push({ origin: 'pack', declarationRef: row['declarationRef'], publishedRef: row['publishedRef'], sourceCandidateId: row['sourceCandidateId'], publishedPackRef: row['publishedPackRef'] })
    } else {
      if (row['origin'] !== undefined && row['origin'] !== 'extracted' || !isUuid(row['publicationId']) || Object.keys(row).some((key) => !['origin','declarationRef','publishedRef','sourceCandidateId','publicationId'].includes(key))) return undefined
      rules.push({ ...(row['origin'] === 'extracted' ? { origin: 'extracted' as const } : {}), declarationRef: row['declarationRef'], publishedRef: row['publishedRef'], sourceCandidateId: row['sourceCandidateId'], publicationId: row['publicationId'] })
    }
  }
  if (value['sourceOrigin'] === 'published_pack' ? rules.some((row) => row.origin !== 'pack') : rules.some((row) => row.origin === 'pack')) return undefined
  return { schemaVersion: 'competency-template-binding@1', ...(value['sourceOrigin'] === 'published_pack' ? { sourceOrigin: 'published_pack' as const } : {}), declarationDefinitionRef: value['declarationDefinitionRef'], definitionRef: value['definitionRef'], packRef: value['packRef'], namespace: value['namespace'], profileRef: { id: value['profileRef']['id'], version: value['profileRef']['version'], snapshotHash: value['profileRef']['snapshotHash'] }, rules, dataMode: 'synthetic', businessApproval: 'none' }
}
type PackDeclaration = NonNullable<PublishedPackAsset['ruleDeclarations']>[number]
type TemplateRule = { readonly origin: 'extracted'; readonly declarationRef: VersionRef; readonly rule: RuleCandidate; readonly sourceSpans: readonly CandidateSourceSpan[] } | { readonly origin: 'pack'; readonly declarationRef: VersionRef; readonly rule: PublishedPackRuleVersion; readonly sourceSpans: readonly CandidateSourceSpan[]; readonly declaration: PackDeclaration }
const key = (object: string, identity: string): string => `${object}\u0000${identity}`

/** Production synthetic sandbox: originals and human ledgers are real; no gold enters here. */
export function createCompetencyProjectPreparer(options: CompetencyProjectPreparerOptions) {
  const db = options.database, projects = new PostgresProjectStore(db), mappings = new PostgresProjectMappingStore(db), records = new PostgresProjectRecordStore(db), documents = new PostgresProjectDocumentStore(db)
  const candidates = new PostgresCandidateStore(db), instances = new PostgresInstanceReviewStore(db), jobs = new PostgresJobStore(db), definitions = new PostgresSemanticDefinitionStore(db)
  const evidence = new PostgresEvidenceStore(db), readiness = new PostgresProjectReadinessStore(db)
  const writer = createBlobArtifactWriter(options.blobs), originalReader = { read: async (request: { readonly approvedInputRefs: readonly ResourceRef[] }, ctx: ToolContext) => {
    const source = request.approvedInputRefs[0]
    if (source === undefined || request.approvedInputRefs.length !== 1) throw new CompetencyQuestionError('INVALID_DECLARATION', 'one original source is required')
    return options.blobs.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: source }, ctx)
  } }

  return async (request: CompetencyExecutionRequest, ctx: ToolContext, signal: AbortSignal): Promise<PreparedCompetencyInput> => {
    signal.throwIfAborted()
    if (!isToolContext(ctx) || ctx.principal.tenantId !== request.input.scopeRef.tenantId || ctx.allowedResources.spaceId !== request.input.scopeRef.spaceId || !ctx.principal.roles.some((role) => role === 'platform-admin' || role === 'semantic-reviewer')) throw new CompetencyQuestionError('FORBIDDEN', 'a scoped synthetic validation reviewer is required')
    const projectId = randomUUID(), projectionNamespace = `projection.competency.${projectId}`
    const publications = new PostgresSemanticPublicationStore(db, { materializationProjectionRef: projectionNamespace })
    const identities = new PostgresIdentityDecisionStore(db, { materializationProjectionRef: projectionNamespace })
    const materialization = new PostgresMaterializationStore(db, projectionNamespace)
    const scope: ScopeRef = request.input.scopeRef, artifactRef = await options.binding(request, ctx)
    if (artifactRef === undefined) return { status: 'not_yet_executable', reason: 'the actual reviewed template binding is unavailable' }
    const metadata = await options.blobs.getAuthorized({ scopeRef: scope, blobRef: artifactRef }, ctx)
    if (!metadata.integrityVerified || metadata.byteSize > 1_048_576) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'template binding metadata is invalid')
    const bytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: artifactRef }, ctx)
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifactRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'template binding bytes changed')
    const template = templateOf(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    if (template === undefined || !same(template.declarationDefinitionRef, request.definitionRef)) return { status: 'not_yet_executable', reason: 'the exact declaration template binding is unavailable' }
    const definition = await definitions.findVersion(template.namespace, template.definitionRef.id, template.definitionRef.version, scope, ctx)
    const pack = await new PostgresComponentRegistryStore(db).findVersion({ kind: 'industry_pack', id: template.packRef.id, version: template.packRef.version }, scope, ctx)
    const profile = await new PostgresProfileStore(db).findResolvedProfile(template.profileRef, template.profileRef.snapshotHash, scope, ctx)
    const producerComponent = await new PostgresComponentRegistryStore(db).findVersion({ kind: 'compute_extension', id: options.producerComponentRef.id, version: options.producerComponentRef.version }, scope, ctx)
    if (definition === undefined || definitionVersionDigest(definition) !== template.definitionRef.digest || !same(definition.ref, template.definitionRef) || pack?.manifestRef.digest !== template.packRef.digest || profile === undefined || resolvedProfileDigest(profile.profileRef, profile.resolved) !== template.profileRef.snapshotHash || !same(profile.resolved.industryRef, template.packRef) || producerComponent?.lifecycleState !== 'active' || producerComponent.manifestRef.digest !== options.producerComponentRef.digest) return { status: 'not_yet_executable', reason: 'template definition, registered host components or resolved profile is unavailable' }
    if (definition.identityScopes.some((identity) => identity.identityAttributeIds.length !== 1)) return { status: 'not_yet_executable', reason: 'this bounded synthetic preparer requires one exact original native identity field per object' }
    if (request.input.relations.some((relation) => relation.status === 'retracted')) return { status: 'not_yet_executable', reason: 'a declared relation withdrawal requires an actual stored relation event mapping' }
    const schema = projectIndustrySchema(definition), schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema }])
    const templates: TemplateRule[] = []
    const packAliases = template.rules.filter((row): row is CompetencyPackRuleAlias => row.origin === 'pack')
    const publishedPackSource = template.sourceOrigin === 'published_pack'
    const readPack = async (context: ToolContext, projectId?: string) => {
      if (!publishedPackSource) return undefined
      if (options.publishedRules === undefined || options.packs === undefined || packAliases.some((alias) => !same(alias.publishedPackRef, template.packRef))) return undefined
      const asset = await options.packs.findByRef(scope, template.packRef, context)
      if (asset === undefined) return undefined
      assertPublishedPackAssetShape(asset)
      if (!same(asset.packRef, template.packRef) || !same(asset.definitionRef, template.definitionRef) || publishedPackContentDigest(asset) !== template.packRef.digest || asset.ruleDeclarations === undefined || contentDigestOf(asset.ruleDeclarations) !== asset.manifest.rulePolicyRef.digest || asset.packAsset.ruleDeclarationsRef?.digest !== asset.manifest.rulePolicyRef.digest) return undefined
      let rules: readonly PublishedPackRuleVersion[]
      try { rules = await options.publishedRules.read(scope, { packRef: template.packRef, definitionRef: template.definitionRef, ...(projectId === undefined ? {} : { projectId }) }, context) }
      catch (error) { if (error instanceof IndustryAssetPublicationError && ['VALIDATION_BLOCKED','FORBIDDEN','VERSION_CONFLICT','SCHEMA_NOT_FOUND'].includes(error.code)) return undefined; throw error }
      if (packAliases.some((alias) => rules.filter((row) => row.sourceCandidateId === alias.sourceCandidateId && row.ruleVersionId === alias.sourceCandidateId && same(row.ruleRef, alias.publishedRef) && same(row.publishedPackRef, alias.publishedPackRef)).length !== 1)) return undefined
      return { asset, rules }
    }
    const packOrigin = await readPack(ctx)
    signal.throwIfAborted()
    if (publishedPackSource && packOrigin === undefined) return { status: 'not_yet_executable', reason: 'the exact currently reviewed published-pack rule origin is unavailable' }
    for (const row of template.rules) {
      if (row.origin === 'pack') {
        const published = packOrigin?.rules.find((rule) => rule.sourceCandidateId === row.sourceCandidateId && same(rule.ruleRef, row.publishedRef))
        const declaration = packOrigin?.asset.ruleDeclarations?.find((declaration) => declaration.candidateId === row.sourceCandidateId && declaration.contentDigest === row.publishedRef.digest)
        if (published === undefined || declaration === undefined || !same(row.declarationRef, published.ruleRef)) return { status: 'not_yet_executable', reason: 'a pack alias does not name its real stored declaration body and source candidate' }
        templates.push({ origin: 'pack', declarationRef: row.declarationRef, rule: published, sourceSpans: declaration.sourceSpans, declaration })
        continue
      }
      const storedRules = await publications.listRuleVersions(scope, { sourceCandidateId: row.sourceCandidateId, publicationId: row.publicationId, limit: 2 }, ctx)
      if (storedRules.length !== 1) return { status: 'not_yet_executable', reason: 'the exact template publication origin is unavailable or ambiguous' }
      const published = storedRules.find((rule) => same(publishedRuleRef(rule), row.publishedRef))
      const source = published === undefined ? undefined : await candidates.getCandidate(scope, published.sourceCandidateId, ctx)
      const origin = published === undefined ? undefined : await publications.getPublication(scope, published.publicationId, ctx)
      const reviewRevision = source === undefined ? '0' : await publications.latestReviewRevision(scope, source.candidateId, ctx)
      const review = source === undefined ? undefined : await publications.getReview(scope, source.candidateId, reviewRevision, ctx)
      const view = source === undefined ? undefined : await new CompositeReviewableCandidateReader({ definition: new PostgresAssetCandidateStore(db), instance: candidates }).readCandidate(scope, source.candidateId, ctx)
      if (published === undefined || source?.kind !== 'rule' || origin === undefined || !same(origin.schemaRef, definition.ref) || !same(source.inputVersion.definitionRef, definition.ref) || review?.decision !== 'approve' || review.contentDigest !== view?.contentDigest || source.ruleId !== published.ruleId || source.objectId !== published.objectId || source.severity !== published.severity || source.impact !== published.impact || canonicalJson(source.expression) !== canonicalJson(published.expression) || canonicalJson(source.exceptions) !== canonicalJson(published.exceptions) || canonicalJson(source.conclusion) !== canonicalJson(published.conclusion) || canonicalJson(source.ruleDependencies ?? []) !== canonicalJson(published.ruleDependencies ?? []) || canonicalJson(source.dependencyRefs ?? []) !== canonicalJson(published.dependencyRefs ?? [])) return { status: 'not_yet_executable', reason: 'the actual complete template rule body/origin or current content-pinned human review is unavailable' }
      templates.push({ origin: 'extracted', declarationRef: row.declarationRef, rule: source, sourceSpans: source.sourceSpans })
    }
    if (request.ruleRefs.some((wanted) => !templates.some((row) => same(row.declarationRef, wanted)))) return { status: 'not_yet_executable', reason: 'a requested rule has no real reviewed declaration binding' }
    if (request.validationTarget !== undefined && await options.target?.(request.validationTarget, template, definition, templates.map((row) => row.rule), ctx, signal) !== true) return { status: 'not_yet_executable', reason: 'current draft bodies or human definition/rule approval pins do not match the actual template' }
    const validationTargetDigest = request.validationTarget === undefined ? undefined : sha256DigestOf(canonicalJson(request.validationTarget))
    const projectionConfiguration = { schemaVersion: 'competency-projection-configuration@1', scopeRef: scope, projectId, definitionRef: definition.ref, packRef: template.packRef, producerComponentRef: options.producerComponentRef }
    const projectionConfigRef = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson(projectionConfiguration)) }, ctx)).blobRef
    const projectionRef: VersionRef = { id: projectionNamespace, version: projectionConfigRef.version, digest: projectionConfigRef.digest }
    const validateTemplateAuthority = async (context: ToolContext, cancellation: AbortSignal): Promise<void> => {
      cancellation.throwIfAborted()
      if (!isToolContext(context) || canonicalJson(context.principal) !== canonicalJson(ctx.principal) || context.runId !== ctx.runId || context.allowedResources.spaceId !== scope.spaceId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'the actual template authority has another trusted identity')
      const bindingBytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: artifactRef }, context)
      const projectionBytes = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: projectionConfigRef }, context)
      if (sha256DigestOfBytes(projectionBytes) !== projectionConfigRef.digest || canonicalJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(projectionBytes)) as unknown) !== canonicalJson(projectionConfiguration)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual isolated projection configuration changed')
      const currentDefinition = await definitions.findVersion(template.namespace, definition.definitionId, definition.version, scope, context)
      const currentProfile = await new PostgresProfileStore(db).findResolvedProfile(template.profileRef, template.profileRef.snapshotHash, scope, context)
      const registry = new PostgresComponentRegistryStore(db)
      const currentPack = await registry.findVersion({ kind: 'industry_pack', id: template.packRef.id, version: template.packRef.version }, scope, context)
      const currentProducer = await registry.findVersion({ kind: 'compute_extension', id: options.producerComponentRef.id, version: options.producerComponentRef.version }, scope, context)
      if (sha256DigestOfBytes(bindingBytes) !== artifactRef.digest || currentDefinition === undefined || definitionVersionDigest(currentDefinition) !== definition.ref.digest || currentProfile === undefined || resolvedProfileDigest(currentProfile.profileRef, currentProfile.resolved) !== template.profileRef.snapshotHash || currentPack?.lifecycleState !== 'active' || !same(currentPack.manifestRef, template.packRef) || currentProducer?.lifecycleState !== 'active' || !same(currentProducer.manifestRef, options.producerComponentRef)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual immutable template, definition, profile or host component authority changed')
      const currentPackOrigin = await readPack(context)
      if (packOrigin !== undefined && (currentPackOrigin === undefined || canonicalJson(currentPackOrigin) !== canonicalJson(packOrigin))) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual published pack rule body, original pins or current human approval changed')
      for (const expected of templates.filter((row): row is Extract<TemplateRule, { origin: 'extracted' }> => row.origin === 'extracted').map((row) => row.rule)) {
        const current = await candidates.getCandidate(scope, expected.candidateId, context)
        const view = await new CompositeReviewableCandidateReader({ definition: new PostgresAssetCandidateStore(db), instance: candidates }).readCandidate(scope, expected.candidateId, context)
        const revision = await publications.latestReviewRevision(scope, expected.candidateId, context), review = await publications.getReview(scope, expected.candidateId, revision, context)
        if (canonicalJson(current) !== canonicalJson(expected) || review?.decision !== 'approve' || view?.contentDigest === undefined || review.contentDigest !== view.contentDigest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the current human template body approval changed')
      }
      cancellation.throwIfAborted()
    }

    const jobId = randomUUID(), now = new Date().toISOString()
    const inputRef = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'competency-preview-input@1', questionSetRef: request.questionSetRef, inputDigest: request.inputDigest, declarationProjectId: request.input.projectId, templateBindingRef: artifactRef, dataMode: 'synthetic', businessApproval: 'none' })) }, ctx)).blobRef
    const emptySet = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(JSON.stringify({ schemaVersion: 'project-document-set@1', projectId, members: [] })) }, ctx)).blobRef
    await new JobService({ store: jobs }).createJob({ jobId, kind: 'dataset_materialization', sourceRef: emptySet.id, datasetRef: emptySet.id, pipelineVersion: '1.0.0', idempotencyKey: `competency-project-${projectId}` }, ctx)
    const identitySource = { sourceRef: { namespace: 'competency-preview', sourceId: projectId }, objectPath: 'confirmed_identity_index' }
    const identityCatalogue = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'competency-identity-catalogue@1', scopeRef: scope, projectId, definitionRef: definition.ref, identityScopes: definition.identityScopes, sourceObjectRef: identitySource })) }, ctx)).blobRef
    const identityMapping: MappingRef = { id: identityCatalogue.id, version: identityCatalogue.version, digest: identityCatalogue.digest, role: 'catalog', sourceObjectRef: identitySource }
    const body: ProjectRevisionBody = { schemaVersion: 'project-revision@1', projectId, revision: '1', executionPurpose: 'synthetic_validation', industryPackRef: template.packRef, definitionRef: definition.ref, profileRef: template.profileRef, mappingRefs: [identityMapping], documentSetRef: emptySet, semanticPublicationRefs: [], sourceVisibilityEpoch: '0', changeReason: 'internal synthetic preview; no business approval' }
    const revision: ProjectRevision = { ref: { projectId, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }, ...(body.executionPurpose === undefined ? {} : { executionPurpose: body.executionPurpose }), industryPackRef: body.industryPackRef, definitionRef: body.definitionRef, profileRef: body.profileRef, mappingRefs: body.mappingRefs, documentSetRef: body.documentSetRef, semanticPublicationRefs: [], sourceVisibilityEpoch: '0', changeReason: body.changeReason }
    await projects.createProject({ projectId, title: 'Synthetic competency preview', firstRevision: revision, idempotencyKey: `preview-${projectId}`, requestDigest: request.inputDigest, actor: ctx.principal.subjectId, recordedAt: now, outboxJobId: jobId,
      outbox: { outboxId: randomUUID(), topic: 'competency.preview.created', payload: { projectId, inputDigest: request.inputDigest }, idempotencyKey: `preview-outbox-${projectId}`, availableAt: now, createdAt: now } }, scope, ctx)
    const projectService = new ProjectService({ projects, readiness, jobs, catalogue: { listEntries: async () => [], findPack: async () => undefined } })
    const mappingService = new ProjectMappingService({ projects, revisions: projects, mappings, records, ingestion: options.structured, originals: originalReader, parser: new StructuredDocumentParser(), schemaSource: schemas })
    const sourceJobs = new Map<string, string>()
    const facts = createProjectFactWorkflow({ materialization: { projects, mappings, records, projectDocuments: documents, ingestion: options.structured, candidates, schemaSource: schemas, jobs, resolveSourceJob: async (_scope, parseId) => sourceJobs.get(parseId) }, publication: { store: publications, identity: identities }, instanceRecords: instances })
    const reviewService = new InstanceReviewService({ store: instances })
    const index: IdentityIndexReader = { query: async (query, context) => {
      const entries = []
      const stored = await identities.listEntities(scope, { objectId: query.objectId, state: 'confirmed', limit: 1000 }, context)
      if (stored.length === 1000) throw new CompetencyQuestionError('INVALID_DECLARATION', 'the actual identity inventory exceeded the bounded complete reader')
      for (const entity of stored) {
        if (entity.scopeDimensions['project'] !== projectId || entity.createdFromCandidateId === undefined) continue
        const candidate = await candidates.getCandidate(scope, entity.createdFromCandidateId, context)
        if (candidate?.kind !== 'entity') continue
        const native = candidate.attributes.find((value) => definition.identityScopes.find((identity) => identity.id === entity.identityScopeId)?.identityAttributeIds.includes(value.attributeId))?.value
        if (typeof native !== 'string') continue
        entries.push({ tenantId: scope.tenantId, spaceId: scope.spaceId, entityId: entity.entityId, objectId: entity.objectId, identityScopeId: entity.identityScopeId, nativeId: native, displayName: native, normalizedName: native.toLowerCase(), aliasConfirmed: false, dimensions: entity.scopeDimensions })
      }
      return new InMemoryIdentityIndexReader(entries).query(query, context)
    } }
    const identity = createInstanceIdentityWorkflow({ service: reviewService, projects, projectDocuments: documents, candidates, identityStore: identities, schemaSource: schemas, identityMappingRef: identityMapping, index })
    const consumed = new Map<string, ResourceRef>(), selected = new Map<string, EntityCandidate>(), entities = new Map<string, string>(), businessIds = new Map<string, string>()
    const parsedInputs: { documentId: string; parseId: string; originalRef: ResourceRef; mapping: MappingRef; objectId: string; recordRefs: { recordId: string; revision: string }[] }[] = []
    const captureAdmissionAuthority = async () => {
      const head = await projects.getProject(scope, projectId, ctx), visibility = await documents.getVisibility(scope, projectId, ctx)
      const project = head === undefined ? undefined : await projects.getRevision(scope, projectId, head.headRevision, ctx)
      const members = await documents.listDocuments(scope, projectId, { state: 'active', limit: 200 }, ctx)
      if (project === undefined || members.nextCursor !== null) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual admission project/source snapshot is unavailable')
      const originals = [...consumed.values()]
      return { project, validateCurrent: async (context: ToolContext, cancellation: AbortSignal) => {
        await validateTemplateAuthority(context, cancellation)
        const currentHead = await projects.getProject(scope, projectId, context), currentVisibility = await documents.getVisibility(scope, projectId, context)
        const currentProject = await projects.getRevision(scope, projectId, project.ref.revision, context), currentMembers = await documents.listDocuments(scope, projectId, { state: 'active', limit: 200 }, context)
        if (canonicalJson(currentHead) !== canonicalJson(head) || canonicalJson(currentProject) !== canonicalJson(project) || canonicalJson(currentVisibility) !== canonicalJson(visibility) || currentMembers.nextCursor !== null || canonicalJson(currentMembers.memberships) !== canonicalJson(members.memberships)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual partial admission source/project authority changed')
        for (const original of originals) { cancellation.throwIfAborted(); const raw = await originalReader.read({ approvedInputRefs: [original] }, context); if (sha256DigestOfBytes(raw) !== original.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual admission original changed') }
        if (request.validationTarget !== undefined && await options.target?.(request.validationTarget, template, definition, templates.map((row) => row.rule), context, cancellation) !== true) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual admission target changed during source reads')
        if (canonicalJson(await projects.getProject(scope, projectId, context)) !== canonicalJson(head) || canonicalJson(await documents.getVisibility(scope, projectId, context)) !== canonicalJson(visibility)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the final actual admission project/source epoch changed')
        cancellation.throwIfAborted()
      } }
    }
    const sources = request.input.structuredSources ?? []
    if (sources.length > 10 || request.input.observations.length > 200) return { status: 'not_yet_executable', reason: 'the synthetic source or observation inventory exceeds its finite bound' }
    const policyParses = new Set<string>()
    for (const row of templates) for (const span of row.sourceSpans) {
      if (policyParses.has(span.parseId)) continue
      policyParses.add(span.parseId)
      const parsed = await options.parses.getParse(scope, span.parseId, ctx)
      if (parsed === undefined) return { status: 'not_yet_executable', reason: 'actual reviewed template policy source is unavailable' }
      const raw = await originalReader.read({ approvedInputRefs: [parsed.originalRef] }, ctx)
      if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== parsed.originalRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'reviewed template policy bytes changed')
      consumed.set(parsed.originalRef.id, parsed.originalRef)
      await documents.registerDocument(scope, projectId, { documentId: randomUUID(), documentRef: parsed.originalRef, documentDigest: parsed.originalRef.digest, parseId: parsed.parseId, parseRef: parsed.spanMapRef, textDigest: parsed.normalizedRef.digest, precision: 'exact', actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() }, ctx)
    }
    for (const source of sources) {
      signal.throwIfAborted()
      const original: ResourceRef = { ...source.sourceRef, kind: 'document' }
      const originalBytes = await originalReader.read({ approvedInputRefs: [original] }, ctx)
      if (`sha256:${createHash('sha256').update(originalBytes).digest('hex')}` !== original.digest || originalBytes.byteLength > 8_388_608) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the synthetic original source is unavailable or changed')
      consumed.set(original.id, original)
      const parsed = await new LocalStructuredIngestionService({ blobs: options.blobs, store: options.structured }).parse({ scopeRef: scope, originalRef: original, options: { headerRow: 1 } }, ctx)
      const table = new StructuredDocumentParser().parse(originalBytes, { mediaType: 'text/csv', headerRow: 1 }).tables[0]
      if (table === undefined) return { status: 'not_yet_executable', reason: 'the original did not produce a complete structured table' }
      const identityFields = definition.identityScopes.find((identity) => identity.objectId === source.objectId)?.identityAttributeIds ?? []
      const fields = new Set([...source.attributeIds, ...identityFields])
      const entries: ColumnMappingEntry[] = table.columns.flatMap((column, columnIndex) => {
        if (!fields.has(column.header)) return []
        const attribute = definition.attributes.find((attribute) => attribute.objectId === source.objectId && attribute.id === column.header)
        const declared = request.input.observations.find((observation) => same(observation.source.sourceRef, source.sourceRef) && observation.attributeId === column.header)
        const suppliedUnit = declared !== undefined && typeof declared.value === 'object' && 'unit' in declared.value ? declared.value.unit : attribute?.unit?.unitCode
        return [{ fieldRef: column.header, header: column.header, headerDigest: column.headerDigest, columnIndex, ...(suppliedUnit === undefined ? {} : { sourceUnitCode: suppliedUnit, canonicalUnitCode: attribute?.unit?.unitCode ?? suppliedUnit }) }]
      })
      const correspondence = { format: 'csv' as const, parseId: parsed.parse.parseId, originalRef: original, originalMediaType: 'text/csv', options: { headerRow: 1 }, objectId: source.objectId, entries }
      const preview = await mappingService.previewMapping(projectId, correspondence, ctx)
      if (!preview.confirmable) {
        const reasons = preview.issues.filter((issue) => issue.severity === 'error')
        const reason = reasons.some((issue) => issue.code === 'UNIT_MISMATCH' || issue.code === 'MISSING_UNIT_CONVERSION') ? 'unit_mismatch' : reasons.some((issue) => issue.code === 'UNKNOWN_ATTRIBUTE' || issue.code === 'ATTRIBUTE_NOT_ON_OBJECT') ? 'definition_version_mismatch' : undefined
        if (reason === undefined) return { status: 'not_yet_executable', reason: 'the actual original mapping could not be confirmed' }
        const admission = await captureAdmissionAuthority()
        const refusal = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'competency-admission-refusal@1', kind: reason, preview, original, definitionRef: definition.ref, projectRevisionRef: admission.project.ref, inputDigest: request.inputDigest, dataMode: 'synthetic' })) }, ctx)).blobRef
        return { status: 'refused', validateCurrent: admission.validateCurrent, reason, artifacts: [inputRef, refusal], consumedOriginals: [...consumed.values()], ...(validationTargetDigest === undefined ? {} : { validationTargetDigest }) }
      }
      const mapped = await mappingService.confirmMapping(projectId, correspondence, `mapping-${projectId}-${original.id}`, ctx.principal.subjectId, ctx)
      const documentId = randomUUID()
      const projected = await new StructuredDocumentProjectionService({ blobs: options.blobs, parses: options.parses, ingestion: options.structured }).project(parsed.parse, ctx)
      await documents.registerDocument(scope, projectId, { documentId, documentRef: original, documentDigest: original.digest, parseId: projected.parseId, parseRef: projected.spanMapRef, textDigest: projected.normalizedRef.digest, precision: 'approximate', actor: ctx.principal.subjectId, recordedAt: now }, ctx)
      const head = await projects.getProject(scope, projectId, ctx), current = head === undefined ? undefined : await projects.getRevision(scope, projectId, head.headRevision, ctx)
      if (current === undefined) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'preview project revision disappeared')
      await projectService.appendRevision(projectId, { expectedRevision: current.ref.revision, reason: 'synthetic human mapping selection', mappingRefs: [...current.mappingRefs, mapped.mapping.ref] }, `mount-${projectId}-${original.id}`, ctx.principal.subjectId, ctx)
      const bound = await mappingService.bindRecords(projectId, { parseId: parsed.parse.parseId, mappingId: mapped.mapping.mappingId, mappingVersion: mapped.mapping.version }, `bind-${projectId}-${original.id}`, ctx.principal.subjectId, ctx)
      const requested = new Set(request.input.observations.filter((observation) => same(observation.source.sourceRef, source.sourceRef)).map((observation) => observation.entityId))
      const chosen = bound.records.filter((record) => record.fields.some((field) => identityFields.includes(field.fieldId) && field.normalized.kind === 'scalar' && typeof field.normalized.value === 'string' && requested.has(field.normalized.value)))
      const nativeKeys = chosen.map((record) => canonicalJson(record.fields.filter((field) => identityFields.includes(field.fieldId)).map((field) => field.normalized)))
      if (new Set(nativeKeys).size !== nativeKeys.length) return { status: 'not_yet_executable', reason: 'the actual original has ambiguous native rows requiring an explicit record selector' }
      const extractionJobId = randomUUID()
      const extractionJob = await new JobService({ store: jobs }).createJob({ jobId: extractionJobId, kind: 'ingestion', sourceRef: `competency-original:${original.id}`, documentRef: encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId: parsed.parse.parseId, parserVersion: parsed.parse.parserVersion, definitionRef: definition.ref, format: 'csv', originalRef: original, originalMediaType: 'text/csv', options: { headerRow: 1 } }), pipelineVersion: '1.0.0', idempotencyKey: `source-job-${projectId}-${original.id}` }, ctx)
      sourceJobs.set(parsed.parse.parseId, extractionJob.jobId)
      parsedInputs.push({ documentId, parseId: parsed.parse.parseId, originalRef: original, mapping: mapped.mapping.ref, objectId: source.objectId, recordRefs: chosen.map((record) => ({ recordId: record.recordId, revision: record.revision })) })
    }
    const corpus = await documents.listDocuments(scope, projectId, { state: 'active', limit: 200 }, ctx)
    if (corpus.nextCursor !== null && corpus.nextCursor !== undefined) return { status: 'not_yet_executable', reason: 'actual source corpus exceeds the finite preview bound' }
    const documentSet = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(JSON.stringify({ schemaVersion: 'project-document-set@1', projectId, members: corpus.memberships.map((member) => ({ documentId: member.documentId, documentRef: member.documentRef, parseId: member.parseId, parseRef: member.parseRef, membershipRevision: member.membershipRevision, precision: member.precision })) })) }, ctx)).blobRef
    const sourceHead = await projects.getProject(scope, projectId, ctx), visibility = await documents.getVisibility(scope, projectId, ctx)
    if (sourceHead === undefined || visibility === undefined && parsedInputs.length > 0) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual preview source corpus is unavailable')
    await projectService.appendRevision(projectId, { expectedRevision: sourceHead.headRevision, reason: 'seal actual scoped preview corpus before human fields and publication', documentSetRef: documentSet, sourceVisibilityEpoch: visibility?.epoch ?? '0' }, `corpus-${projectId}`, ctx.principal.subjectId, ctx)
    for (const source of parsedInputs) {
      const staged = source.recordRefs.length === 0 ? [] : await facts.materialization.stageRecords(projectId, { documentId: source.documentId, recordRefs: source.recordRefs, validFrom: request.input.validAt }, ctx)
      for (const candidate of staged) {
        const nativeField = definition.identityScopes.find((identity) => identity.objectId === candidate.objectId)?.identityAttributeIds[0]
        const native = candidate.attributes.find((attribute) => attribute.attributeId === nativeField)?.value
        if (typeof native !== 'string') throw new CompetencyQuestionError('INVALID_DECLARATION', 'original mapped identity is missing')
        const created = await identity.createRecord(scope, projectId, { candidateId: candidate.candidateId, documentId: source.documentId, relations: [], idempotencyKey: `instance-${candidate.candidateId}` }, ctx)
        const confirmed = await reviewService.confirmFields(scope, projectId, candidate.candidateId, { expectedRevision: created.record.recordRevision, decisions: created.record.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })), idempotencyKey: `fields-${candidate.candidateId}` }, ctx)
        const existing = entities.get(key(candidate.objectId, native))
        const decided = await identity.adjudicateIdentity(scope, projectId, candidate.candidateId, { expectedRevision: confirmed.record.recordRevision, kind: existing === undefined ? 'create' : 'match', ...(existing === undefined ? {} : { targetEntityId: existing }), reason: 'synthetic reviewer compared original mapped identity and fields', idempotencyKey: `identity-${candidate.candidateId}` }, ctx)
        const entityId = decided.identity.matchedEntityId
        if (entityId === undefined) throw new CompetencyQuestionError('INVALID_DECLARATION', 'stored human identity decision has no entity')
        entities.set(key(candidate.objectId, native), entityId); businessIds.set(entityId, native)
        selected.set(`${source.parseId}:${key(candidate.objectId, native)}`, candidate)
        await facts.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '0', decision: 'approve', reason: 'synthetic human reviewed exact original mapped cells' }, ctx)
      }
    }
    const head = await projects.getProject(scope, projectId, ctx), project = head === undefined ? undefined : await projects.getRevision(scope, projectId, head.headRevision, ctx)
    if (project === undefined) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the prepared project is missing')
    if (request.intent.projectId !== request.input.projectId) {
      let refused = false
      try { await projectService.getProject(request.intent.projectId, ctx) } catch (error) { if (isRecord(error) && error['code'] === 'PROJECT_NOT_FOUND') refused = true; else throw error }
      if (!refused) return { status: 'not_yet_executable', reason: 'foreign admission requires an actual authorization/input binding refusal' }
      const admission = await captureAdmissionAuthority()
      const refusal = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'competency-admission-refusal@1', kind: 'cross_project', requestedProjectId: request.intent.projectId, fixedProjectRevisionRef: admission.project.ref, inputDigest: request.inputDigest, dataMode: 'synthetic' })) }, ctx)).blobRef
      return { status: 'refused', validateCurrent: admission.validateCurrent, reason: 'cross_project', artifacts: [inputRef, refusal], consumedOriginals: [...consumed.values()], ...(validationTargetDigest === undefined ? {} : { validationTargetDigest }) }
    }
    const publisher = facts.publication
    const versions: { declarationRef: VersionRef; published: import('@ontology/contracts').PublishedExecutableRule }[] = []
    const projectPackOrigin = await readPack(ctx, projectId)
    signal.throwIfAborted()
    if (publishedPackSource && projectPackOrigin === undefined) return { status: 'not_yet_executable', reason: 'the actual sandbox project does not pin its reviewed pack rule origin' }
    for (const row of templates.filter((row): row is Extract<TemplateRule, { origin: 'pack' }> => row.origin === 'pack')) {
      const published = projectPackOrigin?.rules.find((published) => published.sourceCandidateId === row.rule.sourceCandidateId && same(published.ruleRef, row.rule.ruleRef))
      if (published === undefined) return { status: 'not_yet_executable', reason: 'the actual project-qualified pack rule is unavailable' }
      versions.push({ declarationRef: row.declarationRef, published })
    }
    const ruleQueue = templates.filter((row): row is Extract<TemplateRule, { origin: 'extracted' }> => row.origin === 'extracted')
    while (ruleQueue.length > 0) {
      const readyIndex = ruleQueue.findIndex((row) => (row.rule.ruleDependencies ?? []).every((id) => versions.some((version) => version.published.ruleId === id)))
      if (readyIndex < 0) return { status: 'not_yet_executable', reason: 'actual template dependencies cannot be bound topologically' }
      const row = ruleQueue.splice(readyIndex, 1)[0]!
      const dependencies = (row.rule.ruleDependencies ?? []).map((id) => {
        const upstream = versions.find((version) => version.published.ruleId === id)
        if (upstream === undefined) throw new CompetencyQuestionError('INVALID_DECLARATION', 'an actual published upstream rule is missing')
        return publishedRuleDependencyRef(upstream.published, scope, definition.ref)
      })
      const candidateId = randomUUID()
      const candidate: RuleCandidate = { ...row.rule, candidateId, projectId, dependencyRefs: dependencies, state: 'pending_review', idempotencyKey: sha256DigestOf(canonicalJson({ projectId, templateRuleId: row.rule.candidateId, definitionRef: definition.ref, dependencies, candidateId })), recordedAt: new Date().toISOString() }
      for (const span of candidate.sourceSpans) {
        const parse = await options.parses.getParse(scope, span.parseId, ctx)
        if (parse === undefined) throw new CompetencyQuestionError('INVALID_DECLARATION', 'actual template policy parse is unavailable')
        const policyBytes = await originalReader.read({ approvedInputRefs: [parse.originalRef] }, ctx)
        if (`sha256:${createHash('sha256').update(policyBytes).digest('hex')}` !== parse.originalRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual policy original changed')
        consumed.set(parse.originalRef.id, parse.originalRef)
      }
      await candidates.insertCandidates(scope, [candidate], ctx)
      await publisher.reviewCandidate({ candidateId, expectedRevision: '0', decision: 'approve', reason: 'synthetic reviewer verified actual published template declaration and original policy spans' }, ctx)
      const saved = await publisher.publish({ approvedCandidateRefs: [candidate], schemaRef: definition.ref, expectedRevision: await publications.latestPublicationRevision(scope, ctx), idempotencyKey: `preview-rule-${candidateId}` }, ctx)
      const published = saved.ruleVersions[0]
      if (published === undefined) throw new CompetencyQuestionError('INVALID_DECLARATION', 'actual tagged template rule was not published')
      versions.push({ declarationRef: row.declarationRef, published })
    }
    const official = new PublishedSemanticSource(publications, { definition, identity: identities, projectId, maxRecords: 1000, ...(!publishedPackSource || options.publishedRules === undefined ? {} : { publishedRules: { reader: options.publishedRules, request: { packRef: template.packRef, definitionRef: definition.ref, projectId } } }) })
    const materializer = new IncrementalMaterializer({ publishedSource: official, materialization, projectionRef })
    const points = new Map<string, string>(), captures = new Map<string, PublishedSemanticData>(), captureRefs = new Map<string, ResourceRef>()
    const inputByParse = new Map(parsedInputs.map((input) => [input.parseId, input]))
    const pointFor = (candidate: EntityCandidate): string => {
      const source = inputByParse.get(candidate.inputVersion.parseId)
      const nativeField = definition.identityScopes.find((identity) => identity.objectId === candidate.objectId)?.identityAttributeIds[0]
      const native = candidate.attributes.find((attribute) => attribute.attributeId === nativeField)?.value
      const observations = request.input.observations.filter((observation) => observation.status === 'active' && observation.entityId === native && source !== undefined && same(observation.source.sourceRef, source.originalRef))
      return observations.map((observation) => observation.recordedSeq).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)[0] ?? '1'
    }
    const logicalPoints = new Set(['1', ...request.input.observations.map((observation) => observation.recordedSeq), ...request.input.relations.map((relation) => relation.recordedSeq)])
    const publishedCandidates = new Set<string>()
    const statementForFact = new Map<string, string>()
    for (const logical of [...logicalPoints].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)) {
      signal.throwIfAborted()
      const group = [...selected.values()].filter((candidate) => pointFor(candidate) === logical)
      if (group.length > 0) {
        const saved = await publisher.publish({ approvedCandidateRefs: group, schemaRef: definition.ref, expectedRevision: await publications.latestPublicationRevision(scope, ctx), idempotencyKey: `preview-facts-${projectId}-${logical}` }, ctx)
        for (const statement of saved.statements) {
          publishedCandidates.add(statement.sourceCandidateId)
          const candidate = group.find((candidate) => candidate.candidateId === statement.sourceCandidateId)
          if (candidate === undefined) continue
          for (const observation of request.input.observations.filter((observation) => observation.status === 'active')) {
            const original = candidate.inputVersion.projectFact?.sources[0]
            const originalRef = original === undefined ? undefined : await mappings.getMapping(scope, projectId, original.mappingRef.id, original.mappingRef.version, ctx)
            const attributes = statement.value['attributes']
            const matching = Array.isArray(attributes) ? attributes.find((attribute: unknown) => isRecord(attribute) && attribute['attributeId'] === observation.attributeId) : undefined
            const expectedValue = typeof observation.value === 'object' && 'amount' in observation.value ? observation.value.amount : observation.value
            const expectedUnit = typeof observation.value === 'object' && 'unit' in observation.value ? observation.value.unit : undefined
            if (originalRef !== undefined && same(originalRef.originalRef, observation.source.sourceRef) && statement.objectId === observation.objectId && statement.subjectEntityId === entities.get(key(observation.objectId, observation.entityId)) && isRecord(matching) && canonicalJson(matching['value']) === canonicalJson(expectedValue) && matching['unitCode'] === expectedUnit) statementForFact.set(observation.factId, statement.statementId)
          }
        }
      }
      for (const relation of request.input.relations.filter((relation) => relation.status === 'active' && relation.recordedSeq === logical)) {
        const declared = definition.relations.find((definition) => definition.id === relation.relationId)
        if (declared === undefined) throw new CompetencyQuestionError('INVALID_DECLARATION', 'relation is not declared')
        const nativeField = (objectId: string) => definition.identityScopes.find((scope) => scope.objectId === objectId)?.identityAttributeIds[0]
        const from = [...selected.values()].find((candidate) => candidate.objectId === declared.fromObjectId && candidate.attributes.some((field) => field.attributeId === nativeField(candidate.objectId) && field.value === relation.fromEntityId) && publishedCandidates.has(candidate.candidateId))
        const to = [...selected.values()].find((candidate) => candidate.objectId === declared.toObjectId && candidate.attributes.some((field) => field.attributeId === nativeField(candidate.objectId) && field.value === relation.toEntityId) && publishedCandidates.has(candidate.candidateId))
        if (from === undefined || to === undefined || !relation.endpointsResolved) return { status: 'not_yet_executable', reason: 'actual confirmed relation endpoints are unavailable' }
        const actualSource = inputByParse.get(from.inputVersion.parseId)
        if (actualSource === undefined || !same(actualSource.originalRef, relation.source.sourceRef)) return { status: 'not_yet_executable', reason: 'the relation source does not own its actual confirmed subject' }
        const original = await originalReader.read({ approvedInputRefs: [actualSource.originalRef] }, ctx)
        if (sha256DigestOfBytes(original) !== actualSource.originalRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the relation original changed')
        const table = new StructuredDocumentParser().parse(original, { mediaType: 'text/csv', headerRow: 1 }).tables[0]
        const identityColumn = table?.columns.findIndex((column) => column.header === nativeField(declared.fromObjectId)) ?? -1
        const relationColumn = table?.columns.findIndex((column) => column.header === relation.relationId) ?? -1
        const rows = table?.rows.filter((row) => row.cells[identityColumn]?.raw === relation.fromEntityId) ?? []
        if (identityColumn < 0 || relationColumn < 0 || rows.length !== 1 || rows[0]?.cells[relationColumn]?.raw !== relation.toEntityId) return { status: 'not_yet_executable', reason: 'the actual original relation column does not bind the selected endpoints' }
        const edge = await facts.materialization.stageRelation(projectId, { relationId: relation.relationId, fromCandidateId: from.candidateId, toCandidateId: to.candidateId }, ctx)
        await publisher.reviewCandidate({ candidateId: edge.candidateId, expectedRevision: '0', decision: 'approve', reason: 'synthetic human verified the original relation column and actual endpoint identities' }, ctx)
        await publisher.publish({ approvedCandidateRefs: [edge], schemaRef: definition.ref, expectedRevision: await publications.latestPublicationRevision(scope, ctx), idempotencyKey: `preview-relation-${edge.candidateId}` }, ctx)
      }
      const retractions = [...new Set(request.input.observations.filter((observation) => observation.status === 'retracted' && observation.recordedSeq === logical).map((observation) => statementForFact.get(observation.factId)))]
      for (const statementId of retractions) {
        if (statementId === undefined) return { status: 'not_yet_executable', reason: 'the logical withdrawal has no actual published statement' }
        const statement = await publications.getStatement(scope, statementId, ctx)
        if (statement === undefined) return { status: 'not_yet_executable', reason: 'the actual withdrawal statement is unavailable' }
        await publisher.reviseStatement({ statementId, kind: 'retraction', expectedRevision: statement.version, reason: 'synthetic source explicitly withdraws this independently published support', idempotencyKey: `withdraw-${projectId}-${statementId}-${logical}` }, ctx)
      }
      const recorded = await publications.latestReadRevision(scope, ctx)
      points.set(logical, recorded)
      if (versions.length > 0) await materializer.applyChange({ changeId: randomUUID(), scopeRef: scope, recordedSeq: recorded, recordedAt: new Date().toISOString(), kind: 'rule_changed', ruleId: request.intent.kind === 'rule' ? request.intent.ruleId : versions[0]!.published.ruleId, propositionKey: request.intent.kind === 'rule' ? request.intent.objectId : versions[0]!.published.objectId }, ctx)
      const captured = await official.load(scope, ctx)
      if (captured.readRevision?.semantic !== recorded || captured.complete !== true) return { status: 'not_yet_executable', reason: 'the actual recorded semantic capture is incomplete or changed' }
      const savedCapture = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'competency-published-capture@1', projectRevisionRef: project.ref, definitionRef: definition.ref, recordedPoint: recorded, data: captured })) }, ctx)).blobRef
      captures.set(logical, captured); captureRefs.set(logical, savedCapture)
    }
    const selectedPoint = points.get(request.input.asOfRecordedSeq), captured = captures.get(request.input.asOfRecordedSeq), selectedCapture = captureRefs.get(request.input.asOfRecordedSeq)
    if (selectedPoint === undefined || captured === undefined || selectedCapture === undefined) return { status: 'not_yet_executable', reason: 'the exact logical recorded point has no actual stored event binding' }
    if (request.intent.kind === 'relation' && selectedPoint !== points.get([...points.keys()].at(-1) ?? '1')) return { status: 'not_yet_executable', reason: 'the existing relation navigator cannot read an earlier actual recorded point' }
    const spans = new DocumentSpanReader({ blobs: options.blobs, store: options.parses })
    const structuredSources = new StructuredPremiseSourceReader({ artifacts: options.blobs, mappings, ingestion: options.structured })
    const producer = new MaterializedRuleDerivationEvidenceProducer({ materialization, projectionRef, evidence, artifacts: writer, candidates, documentParses: options.parses, documentSpans: spans, structuredSources, componentRef: options.producerComponentRef })
    const replay = new ArchivedRulePremiseReplayVerifier({ materialization, projectionRef, publications, evidence, artifacts: options.blobs, candidates, identity: identities, documentParses: options.parses, documentSpans: spans, structuredSources, projects, projectDocuments: documents, records, readMode: 'published_snapshot', ...(!publishedPackSource || options.publishedRules === undefined ? {} : { publishedRules: options.publishedRules }) })
    const snapshotSource = new PublishedProjectDatasetSource({ publications, identity: identities, records, mappings, projectDocuments: documents, definition: async (_scope, wanted) => same(wanted, definition.ref) ? definition : undefined })
    let query: import('./competency-execution').PreparedCompetencyCase['query']
    if (request.intent.kind === 'quantity_sum') {
      const built = await new ProjectDataMaterializationService({ projects, publishedSource: snapshotSource, readiness, schemaSource: schemas, writer: options.query, query: options.query }).materialize(projectId, { objectId: request.intent.objectId }, ctx)
      if (built.snapshotRef === undefined || built.state !== 'ready') return { status: 'not_yet_executable', reason: 'actual official physical SQL snapshot is not activated' }
      const descriptor = await options.query.describeSnapshot(scope, built.snapshotRef, ctx)
      if (descriptor === undefined || descriptor.metadata?.body.factRecordedPoint?.semantic !== selectedPoint) return { status: 'not_yet_executable', reason: 'the physical SQL snapshot recorded point differs from the actual event binding' }
      // The host grants this fixed activated snapshot only. The finite compiler emits one
      // aggregate row with a two-row ceiling; the request context remains unchanged.
      const context = createToolContext({ ...ctx, resolvedProfileHash: template.profileRef.snapshotHash, allowedResources: { ...ctx.allowedResources, sourceRefs: [descriptor.sourceObjectRef.sourceRef], maxRows: 2 } })
      query = { service: new ProjectSemanticQueryService({ query: options.query }), descriptor, context }
    }
    let compute: import('./competency-execution').PreparedCompetencyCase['compute']
    if (request.intent.kind === 'registered_compute') {
      const original: ResourceRef = { ...request.intent.inputSourceRef, kind: 'document' }
      const raw = await originalReader.read({ approvedInputRefs: [original] }, ctx)
      if (`sha256:${createHash('sha256').update(raw).digest('hex')}` !== original.digest || options.compute === undefined) return { status: 'not_yet_executable', reason: 'the actual registered compute input or deployment is unavailable' }
      consumed.set(original.id, original)
      const resolved = await options.compute({ project, inputRef: original, profileRef: template.profileRef }, ctx, signal)
      compute = { ...resolved, inputRef: original }
    }
    signal.throwIfAborted()
    if (request.validationTarget !== undefined && await options.target?.(request.validationTarget, template, definition, templates.map((row) => row.rule), ctx, signal) !== true) return { status: 'not_yet_executable', reason: 'the reviewed target changed during actual sandbox execution' }
    const fixedProject = await projects.getProject(scope, projectId, ctx), fixedVisibility = await documents.getVisibility(scope, projectId, ctx)
    const fixedIdentities = await identities.readPublishedBindings(scope, [...selected.values()].map((row) => row.candidateId), ctx)
    if (fixedProject === undefined || fixedIdentities === undefined || !fixedIdentities.complete) return { status: 'not_yet_executable', reason: 'the exact current project/source/identity authority cannot be captured' }
    const fixedRules: RuleCandidate[] = []
    for (const row of versions.filter((version) => !('publishedPackRef' in version.published))) { const stored = await candidates.getCandidate(scope, row.published.sourceCandidateId, ctx); if (stored?.kind !== 'rule') throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual sandbox rule disappeared'); fixedRules.push(stored) }
    const fixedRecords: ProjectRecordVersion[] = []
    const fixedInstanceRecords: InstanceRecordView[] = []
    for (const candidate of selected.values()) {
      const stored = await instances.getRecord(scope, projectId, candidate.candidateId, ctx)
      if (stored === undefined || stored.fields.some((field) => field.status !== 'confirmed')) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual human field confirmation is unavailable before execution')
      fixedInstanceRecords.push(stored)
    }
    for (const source of parsedInputs) for (const selected of source.recordRefs) {
      const stored = await records.getRecord(scope, projectId, selected.recordId, ctx)
      if (stored === undefined || stored.revision !== selected.revision) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual selected record changed before execution')
      fixedRecords.push(stored)
    }
    const validateCurrent = async (context: ToolContext, cancellation: AbortSignal): Promise<void> => {
      await validateTemplateAuthority(context, cancellation)
      if (!isToolContext(context) || canonicalJson(context.principal) !== canonicalJson(ctx.principal) || context.runId !== ctx.runId || context.allowedResources.spaceId !== scope.spaceId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'the current validation reader has another trusted identity')
      const head = await projects.getProject(scope, projectId, context), visibility = await documents.getVisibility(scope, projectId, context)
      const mounted = await projects.getRevision(scope, projectId, project.ref.revision, context)
      const members = await documents.listDocuments(scope, projectId, { state: 'active', limit: 200 }, context)
      const identity = await identities.readPublishedBindings(scope, [...selected.values()].map((row) => row.candidateId), context)
      if (canonicalJson(head) !== canonicalJson(fixedProject) || canonicalJson(mounted) !== canonicalJson(project) || canonicalJson(visibility) !== canonicalJson(fixedVisibility) || members.nextCursor != null || canonicalJson(members.memberships) !== canonicalJson(corpus.memberships)
        || canonicalJson(identity) !== canonicalJson(fixedIdentities)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the current project, source or identity authority changed during execution')
      for (const source of consumed.values()) { cancellation.throwIfAborted(); const bytes = await originalReader.read({ approvedInputRefs: [source] }, context); if (sha256DigestOfBytes(bytes) !== source.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual original changed during execution') }
      for (const expected of fixedRecords) if (canonicalJson(await records.getRecord(scope, projectId, expected.recordId, context)) !== canonicalJson(expected)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'an actual selected record changed during execution')
      for (const expected of fixedInstanceRecords) if (canonicalJson(await instances.getRecord(scope, projectId, expected.recordId, context)) !== canonicalJson(expected)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'an actual human field or instance approval changed during execution')
      const currentProjectPackOrigin = await readPack(context, projectId)
      if (projectPackOrigin !== undefined && (currentProjectPackOrigin === undefined || canonicalJson(currentProjectPackOrigin) !== canonicalJson(projectPackOrigin))) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual project-qualified pack rule origin or current human approval changed')
      for (const expected of fixedRules) {
        const current = await candidates.getCandidate(scope, expected.candidateId, context)
        const view = await new CompositeReviewableCandidateReader({ definition: new PostgresAssetCandidateStore(db), instance: candidates }).readCandidate(scope, expected.candidateId, context)
        const revision = await publications.latestReviewRevision(scope, expected.candidateId, context), review = await publications.getReview(scope, expected.candidateId, revision, context)
        if (canonicalJson(current) !== canonicalJson(expected) || review?.decision !== 'approve' || view?.contentDigest === undefined || review.contentDigest !== view.contentDigest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'an actual template or sandbox human rule approval changed during execution')
      }
      if (request.validationTarget !== undefined && await options.target?.(request.validationTarget, template, definition, templates.map((row) => row.rule), context, cancellation) !== true) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual reviewed target changed during execution')
      if (canonicalJson(await projects.getProject(scope, projectId, context)) !== canonicalJson(fixedProject) || canonicalJson(await documents.getVisibility(scope, projectId, context)) !== canonicalJson(fixedVisibility)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the final actual project/source epoch changed during validation reads')
      cancellation.throwIfAborted()
    }
    const bindingRef = (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'competency-actual-input-binding@1', inputDigest: request.inputDigest, templateBindingRef: artifactRef, declarationProjectId: request.input.projectId, projectRevisionRef: project.ref, declarationDefinitionRef: request.definitionRef, definitionRef: definition.ref, projectionRef, projectionConfigRef, selectedRecordedPoint: selectedPoint, rules: versions.map((version) => ({ declarationRef: version.declarationRef, actualRef: publishedRuleRef(version.published) })), recordedPoints: [...points].map(([logical, actual]) => ({ logical, actual, captureRef: captureRefs.get(logical) })), originals: [...consumed.values()], entityBindings: [...entities], businessBindings: [...businessIds], withdrawals: [...statementForFact].map(([logicalFactId, actualStatementId]) => ({ logicalFactId, actualStatementId })), ...(validationTargetDigest === undefined ? {} : { validationTargetDigest }), dataMode: 'synthetic', businessApproval: 'none' })) }, ctx)).blobRef
    return { status: 'prepared', input: { validateCurrent, executionInputRef: bindingRef, projection: { ref: projectionRef, configRef: projectionConfigRef }, declaredProjectId: request.input.projectId, declarationDefinitionRef: request.definitionRef, project, definition, recordedPoint: selectedPoint, entities, businessIds, consumedOriginals: [...consumed.values()], ...(validationTargetDigest === undefined ? {} : { validationTargetDigest }), facts: { load: async (requestedScope) => {
      if (requestedScope.tenantId !== scope.tenantId || requestedScope.spaceId !== scope.spaceId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'captured input belongs to another scope')
      const actual = await publications.latestReadRevision(scope, ctx)
      if (points.get([...points.keys()].at(-1) ?? '1') !== actual) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual published head changed after capture')
      const saved = await options.blobs.readAuthorized({ scopeRef: scope, blobRef: selectedCapture }, ctx)
      if (sha256DigestOfBytes(saved) !== selectedCapture.digest || canonicalJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved)) as unknown) !== canonicalJson({ schemaVersion: 'competency-published-capture@1', projectRevisionRef: project.ref, definitionRef: definition.ref, recordedPoint: selectedPoint, data: captured })) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the archived official point capture changed')
      return captured
    } }, ...(query === undefined ? {} : { query }), ...(compute === undefined ? {} : { compute }), ...(versions.length === 0 ? {} : { rules: { materializer, recordedPoint: selectedPoint, projectionRef, versions, producer, replay } }),
      relations: { navigator: new PublishedRelationNavigator({ publications, identity: identities, definitionRef: definition.ref, allowedRelationIds: definition.relations.map((relation) => relation.id), relationTargets: new Map(definition.relations.map((relation) => [relation.id, { fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId }])) }), readRecordedPoint: async (requestedScope, context) => {
        if (requestedScope.tenantId !== scope.tenantId || requestedScope.spaceId !== scope.spaceId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'the actual relation head belongs to another scope')
        return publications.latestReadRevision(requestedScope, context)
      } } } }
  }
}
