import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ControlPostgresRepository, PostgresAssetCandidateStore, PostgresAssetWorkspaceStore, PostgresBudgetLedgerStore, PostgresCandidateStore, PostgresComponentRegistryStore, PostgresDefinitionEditingStore, PostgresIdentityDecisionStore, PostgresIndustryValidationReportStore, PostgresJobStore, PostgresProfileStore, PostgresPublishedPackAssetStore, PostgresRuleActionCandidateStore, PostgresRuleActionGenerationStore, PostgresSemanticDefinitionStore, PostgresSemanticPublicationStore, PostgresSyntheticExampleSetStore } from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ArtifactGroundingDocumentSetReader, LocalDocumentExtractionService, ParsedSourceGroundingReader, publishGroundingDocumentSet } from '@ontology/adapter-extraction-document'
import type { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { ComponentRegistry, CompetencyRunner, CompositeReviewableCandidateReader, DefinitionCandidateEditingService, IndustryAssetPublicationService, IndustryValidationService, IndustryWorkspaceService, InMemoryIndustryManifestSource, InMemoryIndustrySchemaSource, JobService, ProfileResolver, StaticDefinitionTerminologySource, SyntheticExampleService, canonicalJson, createSourceGroundingService, sha256DigestOf } from '@ontology/application'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, SemanticDefinitionService, SemanticPublicationService, projectIndustrySchema, publishedRuleDependencyRef, publishedRuleRef } from '@ontology/semantic-engine'
import { createBlobArtifactWriter, createCompetencyQuestionWorkflow, createCompetencyValidationTargetReader, createToolGatewayComposition } from '@ontology/app-api'
import type { CompetencyProjectPreparerOptions, CompetencyTemplateBinding } from '@ontology/app-api'
import { createToolContext } from '@ontology/contracts'
import type { ComponentManifest, CompetencyQuestionSet, IndustryManifest, ResourceRef, RuleCandidate, RuleExpressionNode, RuleProvenanceSpan, ScopeRef, SemanticDefinitionVersion, ToolContext, VersionRef, PublishedRuleVersion, StructuredQueryPort, DocumentParseRecord } from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { DataQueryHandler, createExampleComputeHandlers, exampleOperationRegistry, exampleRegisteredOperation } from '@ontology/tool-services'
import { COMPETENCY_ASSETS, CQ_ADDITIONAL_SOURCES, competencyDigest } from '../fixtures/competency-questions/assets'
import { canonicalManifestValidator } from '../unit/component-registry-fixtures'
import { canonicalProfileValidator } from '../unit/profile-resolver-fixtures'
import { loadCompetencyQuestions } from '../fixtures/competency-questions/loader'
import type { CompetencyRunnerDependencies } from '@ontology/application'
import { exampleComputeArtifact } from '../helpers/example-compute-artifact'
import { canonicalToolValidator } from '../unit/tool-gateway-fixtures'
import { createActualCompetencyTargetFixture } from './competency-target-fixture'

/** Real template publication and source uploads; this helper never evaluates or derives gold. */
export async function competencyRunnerHarness(input: { db: ControlPostgresDatabase; blobs: LocalImmutableBlobStore; registry: PostgresArtifactRegistry; parses: PostgresDocumentParseStore; structured: PostgresStructuredIngestionStore; scope: ScopeRef; ctx: ToolContext }) {
  const { db, blobs, registry, parses, scope, ctx } = input
  const publications = new PostgresSemanticPublicationStore(db), candidates = new PostgresCandidateStore(db), identity = new PostgresIdentityDecisionStore(db), definitions = new PostgresSemanticDefinitionStore(db), jobs = new PostgresJobStore(db)
  const questionWorkflow = createCompetencyQuestionWorkflow({ blobs, registry, reviews: publications })
  const writer = createBlobArtifactWriter(blobs), controls = new ControlPostgresRepository(db), componentStore = new PostgresComponentRegistryStore(db)
  const components = new ComponentRegistry({ control: controls, store: componentStore, artifacts: blobs, validator: canonicalManifestValidator() })
  const sourceRefs = new Map<string, VersionRef>(), bindings = new Map<string, ResourceRef>(), uploaded: CompetencyQuestionSet[] = []
  const templates = new Map<string, { template: CompetencyTemplateBinding; definition: SemanticDefinitionVersion; rules: RuleCandidate[]; policy: ResourceRef; parse: DocumentParseRecord }>()
  const put = async (body: unknown) => (await writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson(body)) }, ctx)).blobRef
  const versionRef = (value: VersionRef): VersionRef => ({ id: value.id, version: value.version, digest: value.digest })
  const register = async (kind: ComponentManifest['kind'], id: string, code: Uint8Array, packageRef: string, buildPin?: VersionRef, capability?: string) => {
    const staged = await blobs.stage(code, { scopeRef: scope }, ctx)
    const artifact = await blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'application/octet-stream', purpose: 'artifact' }, ctx)
    const manifest: ComponentManifest = { kind, id, version: buildPin?.version ?? '1.0.0', digest: buildPin?.digest ?? artifact.contentDigest, contractRange: { min: '0.2.0' }, provides: [{ name: capability ?? (kind === 'runtime' ? 'runtime_template' : kind === 'compute_extension' ? 'registered_compute' : 'semantic_schema'), version: '1.0.0', limits: buildPin === undefined ? { maxRows: 1, maxBytes: 1_048_576, maxDurationMs: 300_000 } : exampleRegisteredOperation(exampleComputeArtifact).limits, consistency: 'immutable', cancellation: 'supported', pagination: 'none', supportedDataTypes: ['string'] }], requires: [], entrypointRef: { kind: 'package', ref: packageRef }, trustStatus: 'local_dev' }
    let record
    try { record = await components.register({ scopeRef: scope, manifest, artifactRef: artifact.blobRef, source: 'operator' }, ctx) } catch (error) { throw new Error(`real component registration failed: ${canonicalJson(error)}`) }
    if (record.lifecycleState !== 'registered') throw new Error('preview component must use real registered local_dev lifecycle')
    await components.transition({ scopeRef: scope, kind, ref: record.manifestRef, to: 'validated' }, ctx)
    const activated = await components.transition({ scopeRef: scope, kind, ref: record.manifestRef, to: 'active' }, ctx)
    return activated.manifestRef
  }
  const runtimeRef = await register('runtime', 'cq-preview-runtime-template', await readFile(fileURLToPath(new URL('../../packages/adapters/runtime-template/src/runtime.ts', import.meta.url))), '@ontology/adapter-runtime-template')
  const producerComponentRef = await register('compute_extension', 'cq-actual-rule-producer', await readFile(fileURLToPath(new URL('../../packages/semantic-engine/src/provenance/rule-derivation-producer.ts', import.meta.url))), '@ontology/semantic-engine', undefined, 'rule_derivation_evidence')
  // The handler pin hashes the verified closed build (bundle plus dependencies); its actual
  // uploaded bundle has its separate byte hash. Both are saved by the real registry.
  const operation = exampleRegisteredOperation(exampleComputeArtifact), operations = exampleOperationRegistry(exampleComputeArtifact)
  const handlerRef = await register('compute_extension', operation.handlerRef.id, exampleComputeArtifact.readArtifact(), '@ontology/tool-services', operation.handlerRef)
  const inputSchemaRef = versionRef(await put(operation.inputSchema)), outputSchemaRef = versionRef(await put(operation.outputSchema))
  if (inputSchemaRef.digest !== operation.inputSchemaDigest || outputSchemaRef.digest !== operation.outputSchemaDigest || handlerRef.digest !== operation.handlerDigest) throw new Error('actual registered build/schema pins differ')
  const policyRef = versionRef(await put({ schemaVersion: 'cq-preview-policy@1', dataMode: 'synthetic', businessApproval: 'none', finiteSources: 10, finiteRows: 200 }))
  for (const [industry, authored] of Object.entries(COMPETENCY_ASSETS)) {
    const policySource = await questionWorkflow.uploadSource(new TextEncoder().encode(authored.document.text), 'text/plain', ctx)
    sourceRefs.set(authored.document.ref.id, policySource)
    const parsed = await new LocalDocumentExtractionService({ blobs, store: parses }).parse({ scopeRef: scope, originalRef: { ...policySource, kind: 'document' }, documentVersionRef: { ...policySource, kind: 'document' } }, ctx)
    for (const additional of CQ_ADDITIONAL_SOURCES.filter((source) => source.industry === industry)) {
      const file = await readFile(fileURLToPath(new URL(`../fixtures/competency-questions/${additional.filename}`, import.meta.url)))
      const uploaded = await questionWorkflow.uploadSource(file, additional.filename.endsWith('.json') ? 'application/json' : 'text/csv', ctx)
      if (uploaded.digest !== additional.document.ref.digest) throw new Error(`original bytes changed: ${additional.filename}`)
      sourceRefs.set(additional.document.ref.id, uploaded)
    }
    const chunk = parsed.chunks[0]
    if (chunk === undefined) throw new Error('actual policy parser produced no source chunk')
    const policySpan: RuleProvenanceSpan = { parseId: parsed.parseId, chunkId: chunk.chunkId, locator: chunk.locator, spanKind: chunk.spanKind, precision: chunk.precision, quoteDigest: chunk.quoteDigest }
    const locate = (expression: RuleExpressionNode): RuleExpressionNode => expression.op === 'all' || expression.op === 'any' ? { ...expression, operands: expression.operands.map(locate), spans: [policySpan] } : expression.op === 'not' ? { ...expression, operand: locate(expression.operand), spans: [policySpan] } : expression.op === 'relation' && expression.targetCondition !== undefined ? { ...expression, targetCondition: locate(expression.targetCondition), spans: [policySpan] } : { ...expression, spans: [policySpan] }
    for (const declared of authored.definitions) {
      const provenance = declared.draft.standardProvenance.map((origin) => ({ ...origin, standardRef: versionRef(policySource) }))
      const draft = { ...declared.draft, scopeRef: scope, standardProvenance: provenance, objects: declared.draft.objects.map((item) => ({ ...item, standardProvenance: provenance })), attributes: declared.draft.attributes.map((item) => ({ ...item, standardProvenance: provenance })), relations: declared.draft.relations.map((item) => ({ ...item, standardProvenance: provenance })), identityScopes: declared.draft.identityScopes.map((item) => ({ ...item, standardProvenance: provenance })), ruleConstraints: declared.draft.ruleConstraints.map((item) => ({ ...item, standardProvenance: provenance })) }
      const definition = await new SemanticDefinitionService({ control: controls, store: definitions }).publish(draft, ctx)
      const schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
      const publisher = new SemanticPublicationService({ store: publications, candidates, schemaSource: schemas, identity, reviewableCandidates: new CompositeReviewableCandidateReader({ definition: new PostgresAssetCandidateStore(db), instance: candidates }) })
      const actualRules: { declarationRef: VersionRef; published: PublishedRuleVersion }[] = []
      for (const declaredRule of authored.rules) {
        const jobId = randomUUID()
        const job = await new JobService({ store: jobs }).createJob({ jobId, kind: 'ingestion', sourceRef: policySource.id, documentRef: policySource.id, pipelineVersion: '1.0.0', idempotencyKey: `actual-template-policy-${jobId}` }, ctx)
        const dependencyRefs = declaredRule.declaration.ruleDependencies.map((id) => {
          const upstream = actualRules.find((rule) => rule.published.ruleId === id)
          if (upstream === undefined) throw new Error('authored declaration order lost its upstream actual publication')
          return publishedRuleDependencyRef(upstream.published, scope, definition.ref)
        })
        const candidateId = randomUUID(), declaration = declaredRule.declaration
        const candidate: RuleCandidate = { candidateId, jobId: job.jobId, kind: 'rule', ruleId: declaration.ruleId, objectId: declaration.objectId, expression: locate(declaration.condition), exceptions: declaration.exceptions.map((exception) => ({ ...exception, condition: locate(exception.condition), spans: [policySpan] })), conclusion: declaration.conclusion, ruleDependencies: declaration.ruleDependencies, dependencyRefs,
          severity: 'soft', impact: 'low', reviewRequirement: 'required', conflicts: [], deterministic: true, state: 'pending_review', issues: [], sourceSpans: [{ kind: 'text', ...policySpan, textDigest: chunk.textDigest }], inputVersion: { definitionRef: definition.ref, parseId: parsed.parseId, parserVersion: parsed.parserVersion, documentVersionRef: parsed.originalRef, pipelineVersion: '1.0.0' }, idempotencyKey: sha256DigestOf(canonicalJson({ candidateId, declaration, definitionRef: definition.ref, policySource })), recordedAt: new Date().toISOString() }
        await candidates.insertCandidates(scope, [candidate], ctx)
        await publisher.reviewCandidate({ candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed the independently authored complete declaration and actual original policy text' }, ctx)
        const published = await publisher.publish({ schemaRef: definition.ref, approvedCandidateRefs: [candidate], expectedRevision: await publications.latestPublicationRevision(scope, ctx), idempotencyKey: `template-publish-${candidateId}` }, ctx)
        if (published.ruleVersions[0] === undefined) throw new Error('the real template rule publication is missing')
        actualRules.push({ declarationRef: declaredRule.ref, published: published.ruleVersions[0] })
      }
      const identityPolicyRef = await put({ schemaVersion: 'identity-policy@1', scopes: definition.identityScopes }), rulePolicyRef = await put({ schemaVersion: 'rule-policy@1', rules: actualRules.map((rule) => publishedRuleRef(rule.published)) }), queryTemplatesRef = await put({ schemaVersion: 'query-template@1', fields: definition.attributes.map((field) => field.id) }), testSuiteRef = await put({ schemaVersion: 'preview-contract-suite@1', validation: 'runtime execution required; no precomputed gold' })
      const namespace = `${definition.namespace}-${definition.version.replaceAll('.', '-')}`
      const manifest: IndustryManifest = { namespace, maturity: 'preview', standardProvenance: [...definition.standardProvenance], definitionsRef: definition.ref, identityPolicyRef: versionRef(identityPolicyRef), rulePolicyRef: versionRef(rulePolicyRef), queryTemplatesRef: versionRef(queryTemplatesRef), requiredCapabilities: [{ name: 'runtime_template', versionRange: { min: '1.0.0' } }], testSuiteRef: versionRef(testSuiteRef), operationRefs: [], extensionRefs: [] }
      const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
      const packRef = await register('industry_pack', namespace, manifestBytes, '@ontology/application')
      const source = new InMemoryIndustryManifestSource([{ ref: packRef, manifest }])
      const profiles = new ProfileResolver({ control: controls, store: new PostgresProfileStore(db), registry: componentStore, industry: source, validator: canonicalProfileValidator() })
      const profileRef = { id: `${namespace}-preview`, version: '1.0.0' }
      const identitySource = { sourceRef: { namespace: 'competency-preview', sourceId: 'confirmed-identity' }, objectPath: 'confirmed_identity_index' }
      const identityCatalogue = versionRef(await put({ schemaVersion: 'competency-identity-catalogue@1', scopeRef: scope, definitionRef: definition.ref, identityScopes: definition.identityScopes, sourceObjectRef: identitySource }))
      await profiles.publish({ scopeRef: scope, profileRef, environment: 'local_dev', spec: { industryRef: packRef, mappingRefs: [{ ...identityCatalogue, role: 'catalog', sourceObjectRef: identitySource }], runtimeRef, backendBindings: {}, modelBindings: {}, toolBindings: [{ toolId: 'data_query', enabled: true }], computeBindings: [{ operationRef: operation.operationRef, handlerRef, inputSchemaRef, outputSchemaRef, readOnly: true, enabled: true, limits: operation.limits }], policyRef } }, ctx)
      const resolved = await profiles.preflight({ scopeRef: scope, profileRef }, ctx)
      if (resolved.status !== 'resolved' || resolved.resolvedProfile === undefined) throw new Error(`actual preview profile failed: ${canonicalJson(resolved)}`)
      const binding: CompetencyTemplateBinding = { schemaVersion: 'competency-template-binding@1', declarationDefinitionRef: declared.ref, definitionRef: definition.ref, namespace: definition.namespace, packRef, profileRef: { ...profileRef, snapshotHash: resolved.resolvedProfile.snapshotHash }, rules: actualRules.map((row) => ({ declarationRef: row.declarationRef, publishedRef: publishedRuleRef(row.published), sourceCandidateId: row.published.sourceCandidateId, publicationId: row.published.publicationId })), dataMode: 'synthetic', businessApproval: 'none' }
      bindings.set(`${declared.ref.id}@${declared.ref.version}`, await put(binding))
      const storedRules: RuleCandidate[] = []
      for (const row of actualRules) { const saved = await candidates.getCandidate(scope, row.published.sourceCandidateId, ctx); if (saved?.kind !== 'rule') throw new Error('actual template source candidate disappeared'); storedRules.push(saved) }
      templates.set(`${declared.ref.id}@${declared.ref.version}`, { template: binding, definition, rules: storedRules, policy: { ...policySource, kind: 'document' }, parse: parsed })
    }
  }
  const rawSets = loadCompetencyQuestions()
  for (const original of rawSets) {
    const set = structuredClone(original)
    const locate = <T extends { sourceRef: VersionRef }>(location: T): T => {
      const actual = sourceRefs.get(location.sourceRef.id)
      if (actual === undefined || actual.digest !== location.sourceRef.digest) throw new Error('source alias has no actual original binding')
      return { ...location, sourceRef: actual }
    }
    set.body.sourceRefs = set.body.sourceRefs.map((ref) => sourceRefs.get(ref.id) ?? ref)
    for (const question of set.body.questions) {
      question.input.scopeRef = scope
      question.requiredSources = question.requiredSources.map(locate)
      question.input.observations = question.input.observations.map((observation) => ({ ...observation, source: locate(observation.source) }))
      question.input.relations = question.input.relations.map((relation) => ({ ...relation, source: locate(relation.source) }))
      if (question.input.structuredSources !== undefined) question.input.structuredSources = question.input.structuredSources.map(locate)
      if (question.intent.kind === 'registered_compute') question.intent.inputSourceRef = sourceRefs.get(question.intent.inputSourceRef.id) ?? question.intent.inputSourceRef
      if (canonicalJson(question.expected) !== canonicalJson(original.body.questions.find((source) => source.questionId === question.questionId)?.expected)) throw new Error('independent gold changed')
    }
    set.ref.digest = competencyDigest(set.body)
    const saved = await questionWorkflow.service.upload(set, ctx)
    const reviewable = new CompositeReviewableCandidateReader({ definition: new PostgresAssetCandidateStore(db), instance: candidates, competencyQuestions: questionWorkflow.service })
    const reviewer = new SemanticPublicationService({ store: publications, candidates, schemaSource: new InMemoryIndustrySchemaSource(), identity, reviewableCandidates: reviewable })
    await reviewer.reviewCandidate({ candidateId: saved.ref.id, expectedRevision: '0', decision: 'approve', reason: 'human independently reviewed all original expected values and actual source aliases' }, ctx)
    if (await questionWorkflow.service.readApproved(scope, saved.ref, ctx) === undefined) throw new Error('actual CQ body review was not retained')
    uploaded.push(saved)
  }
  const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(db), control: controls }), ledgers = new Map<string, string>()
  const computeFor = (query: StructuredQueryPort): NonNullable<CompetencyProjectPreparerOptions['compute']> => async (input, context, signal) => {
    signal.throwIfAborted()
    const profile = await new PostgresProfileStore(db).findResolvedProfile(input.profileRef, input.profileRef.snapshotHash, scope, context)
    if (profile === undefined || profile.resolved.explicitDegradations.some((item) => item.capability.startsWith('compute:'))) throw new Error('actual compute profile/build binding is unavailable')
    let ledgerId = ledgers.get(context.runId)
    if (ledgerId === undefined) { ledgerId = randomUUID(); await budget.openLedger({ ledgerId, kind: 'run', runId: context.runId }, context); ledgers.set(context.runId, ledgerId) }
    const admitted = await budget.reserve({ ledgerId, idempotencyKey: `cq-host-bind-${input.project.ref.projectId}`, toolCalls: 0, rows: 0, bytes: 0, requestedDeadline: context.deadline }, context)
    const reservation = admitted.reservation
    if (!admitted.granted || reservation === undefined) throw new Error('actual compute host admission budget was refused')
    const authorized = await blobs.getAuthorized({ scopeRef: scope, blobRef: input.inputRef }, context)
    if (!authorized.integrityVerified || authorized.contentDigest !== input.inputRef.digest) throw new Error('actual scoped compute original is unavailable')
    const bound = createToolContext({ ...context, resolvedProfileHash: input.profileRef.snapshotHash, deadline: reservation.expiresAt, budgetReservation: { reservationId: reservation.reservationId, runId: context.runId, grantedAt: reservation.grantedAt, expiresAt: reservation.expiresAt }, allowedResources: { ...context.allowedResources, resourceKinds: [input.inputRef.kind] } })
    const validator = canonicalToolValidator()
    const gateway = createToolGatewayComposition({ database: db, blobStore: blobs, budget, validator, handlers: [new DataQueryHandler({ query, mappings: { resolve: () => undefined, list: () => [] }, compute: { registry: operations, handlers: createExampleComputeHandlers(exampleComputeArtifact), artifacts: writer, reader: { read: async (request, ctx) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('actual input ref missing'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx) } }, validator } })] }).forRun({ runId: context.runId, ledgerId, resolvedProfile: profile.resolved, operations })
    signal.throwIfAborted()
    return { gateway, context: bound, operation }
  }
  const workspaces = new PostgresAssetWorkspaceStore(db), terms = new PostgresAssetCandidateStore(db), actions = new PostgresRuleActionCandidateStore(db), ruleGeneration = new PostgresRuleActionGenerationStore(db)
  const grounding = createSourceGroundingService({ workspaces, documentSets: new ArtifactGroundingDocumentSetReader(blobs), reader: new ParsedSourceGroundingReader({ blobs, documents: parses, tables: input.structured }) })
  const reviewable = new CompositeReviewableCandidateReader({ definition: terms, ruleActions: actions, instance: candidates, competencyQuestions: questionWorkflow.service })
  const targetReader = createCompetencyValidationTargetReader({ workspaces, definitionCandidates: terms, ruleActions: actions, ruleGeneration, reviews: publications, reviewableCandidates: reviewable, definitions, candidates, grounding })
  const targetFor = async (industry: 'transport' | 'industrial', context: ToolContext, signal: AbortSignal) => {
    const actual = templates.get(`cq.${industry}.definition@1.0.0`)
    const original = uploaded.find((set) => set.body.industryId === `${industry}-synthetic`)
    if (actual === undefined || original === undefined) throw new Error('the real independently authored template is missing')
    const ownerId = randomUUID()
    const empty = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', scopeRef: scope, workspaceId: ownerId, sources: [] }, context)
    let firstId = true
    const workspaceService = new IndustryWorkspaceService({ store: workspaces, jobs, newId: () => { if (firstId) { firstId = false; return ownerId }; return randomUUID() } })
    await workspaceService.createWorkspace({ namespace: `cq-originals-${ownerId}`, displayName: 'Actual synthetic policy source selection', boundary: { goals: ['preserve the independently authored normative template'], included: [], excluded: [], applicability: {} }, documentSetRef: empty }, `cq-original-owner-${ownerId}`, context.principal.subjectId, context)
    const sourceDocumentSetRef = await publishGroundingDocumentSet(blobs, { schemaVersion: '1.0.0', scopeRef: scope, workspaceId: ownerId, sources: [{ sourceRef: actual.policy, state: 'approved', kind: 'document', parseId: actual.parse.parseId, parserVersion: actual.parse.parserVersion }] }, context)
    await workspaceService.draftOperation(ownerId, { operation: 'edit', expectedRevision: '1', documentSetRef: sourceDocumentSetRef, reason: 'synthetic human selected the actual parsed normative source' }, `cq-original-mount-${ownerId}`, context.principal.subjectId, context)
    const target = await createActualCompetencyTargetFixture({ definition: actual.definition, rules: actual.rules, sourceDocumentSetRef, blobs, database: db, grounding, ctx: context, signal })
    if (!await targetReader(target.target, actual.template, actual.definition, actual.rules, context, signal)) throw new Error('the genuine generated current target does not match its immutable template')
    // A new explicitly authored current-version body has its own upload and human review.
    // The heterogeneous original remains unchanged and must still block this current target.
    const current = structuredClone(original)
    current.body.definitionRefs = [actual.template.declarationDefinitionRef]
    current.body.questions = current.body.questions.filter((question) => question.definitionRef.id === actual.template.declarationDefinitionRef.id && question.definitionRef.version === actual.template.declarationDefinitionRef.version && question.definitionRef.digest === actual.template.declarationDefinitionRef.digest)
    current.ref = { id: `${original.ref.id}.current-${ownerId}`, version: '1.0.0', digest: competencyDigest(current.body) }
    for (const question of current.body.questions) if (canonicalJson(question.expected) !== canonicalJson(original.body.questions.find((row) => row.questionId === question.questionId)?.expected)) throw new Error('selected independent literal gold changed')
    const compatible = await questionWorkflow.service.upload(current, context)
    const reviewer = new SemanticPublicationService({ store: publications, candidates, schemaSource: new InMemoryIndustrySchemaSource(), identity, reviewableCandidates: reviewable })
    await reviewer.reviewCandidate({ candidateId: compatible.ref.id, expectedRevision: '0', decision: 'approve', reason: 'human approved this explicit current-version CQ body with unchanged independent literal gold' }, context)
    const packs = new PostgresPublishedPackAssetStore(db, { competencyBodies: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined || request.approvedInputRefs.length !== 1) throw new Error('actual competency body ref is missing'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } }), exampleSets = new PostgresSyntheticExampleSetStore(db), reports = new PostgresIndustryValidationReportStore(db)
    const editing = new DefinitionCandidateEditingService({ workspaces, candidates: terms, editing: new PostgresDefinitionEditingStore(db), publishedDefinitions: definitions, publishedPacks: packs, reviews: publications, reviewableCandidates: reviewable, terminology: new StaticDefinitionTerminologySource() })
    const recordedAt = new Date().toISOString()
    const examples = await new SyntheticExampleService({ workspaces, sets: exampleSets }).generate(target.target.workspaceId, { expectedRevision: target.target.revision, idempotencyKey: `cq-missing-${ownerId}`, caseKinds: ['missing_parameter'], cases: actual.definition.objects.map((object) => ({ caseId: `missing-${object.id}`, caseKind: 'missing_parameter', objectTypeRef: object.id, fields: [] })), expectations: actual.rules.map((rule) => ({ expectationId: `missing-${rule.ruleId}`, caseId: `missing-${rule.objectId}`, kind: 'rule', ruleId: rule.ruleId, expected: 'unknown', origin: 'authored_oracle', reason: 'the independent normative case provides no premise observations', confirmedBy: context.principal.subjectId, confirmedAt: recordedAt })) }, context.principal.subjectId, context)
    const validation = (execution: CompetencyRunnerDependencies['execution']) => new IndustryValidationService({ workspaces, exampleSets, reports, definitions: editing, ruleActions: actions, support: new FiniteGrammarRuleSupportValidator(), evaluator: new FiniteGrammarSyntheticEvaluator(), readRelationDefinition: async () => actual.definition, competencyRunner: new CompetencyRunner({ questions: questionWorkflow.service, sources: questionWorkflow.sources, execution, boundary: questionWorkflow.boundary, validateActual: questionWorkflow.validateActual }), requireCompetencyQuestions: true })
    const publication = new IndustryAssetPublicationService({ workspaces, validations: reports, definitionCandidates: terms, ruleActions: actions, syntheticSets: exampleSets, definitions, store: packs, reviews: publications, reviewableCandidates: reviewable, competencyQuestions: questionWorkflow.service, requireCompetencyQuestions: true })
    return { ...target, actual, compatible, original, examples, validation, publication }
  }
  return { sets: uploaded, bindings, questionWorkflow, writer, sourceRefs, publications, candidates, definitions, computeFor, producerComponentRef, targetReader, targetFor,
    runner: (execution: CompetencyRunnerDependencies['execution']) => new CompetencyRunner({ questions: questionWorkflow.service, sources: questionWorkflow.sources, execution, boundary: questionWorkflow.boundary, validateActual: questionWorkflow.validateActual }) }
}
