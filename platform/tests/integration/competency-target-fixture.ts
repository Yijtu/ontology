import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { CompositeReviewableCandidateReader, DefinitionCandidateGenerationService, IndustryWorkspaceService, RuleActionCandidateGenerationService,
  RuleActionCandidateService, SourceGroundingBudget, StaticDefinitionTerminologySource, canonicalJson, currentDefinitionProjection,
  currentRuleActionProjection, definitionApprovalPins, groundingFragments, ruleActionPublicationPins } from '@ontology/application'
import { ArtifactGroundingDocumentSetReader, publishGroundingDocumentSet } from '@ontology/adapter-extraction-document'
import { PostgresAssetCandidateStore, PostgresAssetWorkspaceStore, PostgresCandidateStore, PostgresIdentityDecisionStore,
  PostgresJobStore, PostgresRuleActionCandidateStore, PostgresRuleActionGenerationStore, PostgresSemanticPublicationStore } from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { FiniteGrammarRuleSupportValidator, SemanticPublicationService, projectIndustrySchema } from '@ontology/semantic-engine'
import { InMemoryIndustrySchemaSource } from '@ontology/application'
import type { CompetencyValidationTarget, GenerationEvent, GenerationPort, GenerationRequest, ResourceRef, RuleCandidate,
  RuleCandidateVersion, SemanticDefinitionVersion, SourceGroundingPort, ToolContext } from '@ontology/contracts'
import { isRecord } from '@ontology/contracts'

/** Bounded synthetic target preparation from actual templates and actual originals only.
 * No expected values, CQ question bodies or gold declarations enter this input. */
export interface ActualCompetencyTargetFixtureInput {
  readonly definition: SemanticDefinitionVersion
  readonly rules: readonly RuleCandidate[]
  readonly sourceDocumentSetRef: ResourceRef
  readonly blobs: LocalImmutableBlobStore
  readonly database: ControlPostgresDatabase
  readonly grounding: SourceGroundingPort
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}
class TemplateDeclarationGeneration implements GenerationPort {
  constructor(readonly declaration: unknown) {}
  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    void request
    yield { type: 'text_delta', text: canonicalJson(this.declaration) }
    yield { type: 'completed', stopReason: 'stop', candidateOnly: true }
  }
}
const digest = (body: unknown) => `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`
const stripSpans = (body: unknown): unknown => Array.isArray(body) ? body.map(stripSpans) : isRecord(body)
  ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'spans').map(([key, value]) => [key, stripSpans(value)])) : body
function clausePaths(body: unknown, path: string): { readonly path: string; readonly spans: readonly unknown[] }[] {
  if (!isRecord(body)) return []
  const result: { readonly path: string; readonly spans: readonly unknown[] }[] = [{ path, spans: Array.isArray(body['spans']) ? body['spans'] : [] }]
  if (Array.isArray(body['operands'])) body['operands'].forEach((operand, index) => result.push(...clausePaths(operand, `${path}.operands[${index}]`)))
  if (body['operand'] !== undefined) result.push(...clausePaths(body['operand'], `${path}.operand`))
  if (body['targetCondition'] !== undefined) result.push(...clausePaths(body['targetCondition'], `${path}.targetCondition`))
  return result
}

/** Use real generation services, PG batches, existing human ledger and enablement. */
export async function createActualCompetencyTargetFixture(input: ActualCompetencyTargetFixtureInput): Promise<{
  readonly target: CompetencyValidationTarget
  readonly definitionCandidates: ReturnType<typeof currentDefinitionProjection>
  readonly ruleCandidates: readonly RuleCandidateVersion[]
}> {
  const { database, ctx, definition, signal } = input
  signal.throwIfAborted()
  if (definition.ruleConstraints.length !== 0 || definition.objects.length === 0 || input.rules.length > 100) throw new Error('actual target template is outside the complete bounded candidate representation')
  const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  if (definition.scopeRef.tenantId !== scope.tenantId || definition.scopeRef.spaceId !== scope.spaceId) throw new Error('actual target template belongs to another scope')
  const original = await new ArtifactGroundingDocumentSetReader(input.blobs).read(scope, input.sourceDocumentSetRef, ctx, new SourceGroundingBudget(signal))
  if (original.sources.length === 0 || original.sources.length > 64 || original.sources.some((source) => source.state !== 'approved')) throw new Error('actual target requires a complete approved original corpus')
  const workspaces = new PostgresAssetWorkspaceStore(database), definitions = new PostgresAssetCandidateStore(database), candidates = new PostgresRuleActionCandidateStore(database)
  const workspaceService = new IndustryWorkspaceService({ store: workspaces, jobs: new PostgresJobStore(database) })
  const created = await workspaceService.createWorkspace({ namespace: `cq-target-${randomUUID()}`, displayName: 'Actual reviewed synthetic target',
    boundary: { goals: ['validate the complete actual template'], included: [], excluded: [], applicability: {} }, documentSetRef: input.sourceDocumentSetRef }, `cq-target-create-${randomUUID()}`, ctx.principal.subjectId, ctx)
  const workspaceId = created.workspace.workspaceId
  const documentSetRef = await publishGroundingDocumentSet(input.blobs, { ...original, workspaceId, scopeRef: scope }, ctx)
  await workspaceService.draftOperation(workspaceId, { operation: 'edit', expectedRevision: '1', reason: 'human selected the real original template corpus', documentSetRef }, `cq-target-source-${randomUUID()}`, ctx.principal.subjectId, ctx)
  const sourceRefs = original.sources.map((source) => source.sourceRef)
  const grounded = await input.grounding.read({ workspaceId, sourceRefs }, ctx, new SourceGroundingBudget(signal))
  if (grounded.coverage !== 'complete') throw new Error('actual target corpus cannot be read completely within the existing source budget')
  const fragments = groundingFragments(grounded.sources)
  const common = { businessMeaning: 'synthetic human declaration from the actual normative template', suggestedReason: 'human selected the actual original policy', sourceIndex: 0, fragmentIndex: 0 }
  const declaration = {
    objects: definition.objects.map((object) => {
      const identity = definition.identityScopes.find((scope) => scope.id === object.identityScopeId && scope.objectId === object.id)
      if (identity === undefined) throw new Error('actual object identity declaration does not resolve')
      return { ...common, logicalId: object.id, displayName: object.displayName, identityAttributeIds: identity.identityAttributeIds, identityScopeDimensions: identity.scopeDimensions }
    }),
    attributes: definition.attributes.map((attribute) => ({ ...common, logicalId: attribute.id, displayName: attribute.id, objectLogicalId: attribute.objectId,
      valueType: attribute.valueType, minCardinality: attribute.cardinality.min, maxCardinality: attribute.cardinality.max,
      ...(attribute.unit === undefined ? {} : { unitCode: attribute.unit.unitCode, dimension: attribute.unit.dimension }),
      ...(attribute.enumValues === undefined ? {} : { enumValues: attribute.enumValues }),
      ...(attribute.referencesObjectId === undefined ? {} : { referencesObjectLogicalId: attribute.referencesObjectId }) })),
    relations: definition.relations.map((relation) => ({ ...common, logicalId: relation.id, displayName: relation.id, fromObjectLogicalId: relation.fromObjectId,
      toObjectLogicalId: relation.toObjectId, minCardinality: relation.cardinality.min, maxCardinality: relation.cardinality.max })),
  }
  const count = declaration.objects.length + declaration.attributes.length + declaration.relations.length
  if (count > 100) throw new Error('actual complete target definition exceeds the generation candidate bound')
  const generationPolicyRef = { id: 'actual-template-target-declaration', version: '1.0.0', digest: digest({ definitionRef: definition.ref, sourceDocumentSetRef: input.sourceDocumentSetRef }) }
  const terms = await new DefinitionCandidateGenerationService({ workspaces, candidates: definitions, terminology: new StaticDefinitionTerminologySource(), sourceGrounding: input.grounding,
    generationForRun: () => new TemplateDeclarationGeneration(declaration), modelRef: { modelId: 'synthetic-human-declaration', version: '1.0.0' }, outputLimit: { maxTokens: 16_000 } }).generate({ workspaceId,
      expectedRevision: '2', sourceRefs, kinds: ['object', 'attribute', 'relation'], candidateLimit: count, generationPolicyRef, idempotencyKey: `cq-target-terms-${randomUUID()}` }, ctx.principal.subjectId, ctx, signal)
  if (terms.batch.state !== 'completed' || terms.candidates.length !== count || terms.candidates.some((row) => row.issues.length > 0 || row.pendingConfirmation)) throw new Error(`actual complete target declaration failed: ${canonicalJson(terms.batch.error ?? terms.candidates.flatMap((row) => row.issues))}`)
  const instances = new PostgresCandidateStore(database), reviews = new PostgresSemanticPublicationStore(database)
  const reviewable = new CompositeReviewableCandidateReader({ definition: definitions, ruleActions: candidates, instance: instances })
  const reviewer = new SemanticPublicationService({ store: reviews, candidates: instances, identity: new PostgresIdentityDecisionStore(database), schemaSource: new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }]), reviewableCandidates: reviewable })
  const review = async (candidateId: string) => { signal.throwIfAborted(); await reviewer.reviewCandidate({ candidateId, expectedRevision: '0', decision: 'approve', reason: 'synthetic human inspected this complete actual template declaration and original source' }, ctx) }
  for (const term of terms.candidates) await review(term.candidateId)
  const service = new RuleActionCandidateService({ workspaces, candidates, support: new FiniteGrammarRuleSupportValidator(), readRelationDefinition: async () => definition })
  const saved = new Map<string, RuleCandidateVersion>(), queue = [...input.rules]
  while (queue.length > 0) {
    signal.throwIfAborted()
    const index = queue.findIndex((rule) => (rule.ruleDependencies ?? []).every((id) => saved.has(id)))
    if (index < 0) throw new Error('actual template dependencies do not resolve topologically')
    const rule = queue.splice(index, 1)[0]!
    const dependencyRefs = (rule.dependencyRefs ?? []).map((ref) => {
      const upstream = saved.get(ref.ruleId)
      if (upstream === undefined || upstream.payload.conclusion?.predicate !== ref.predicate || upstream.payload.applicability.objectId !== ref.objectId) throw new Error('actual upstream body/object/predicate is not representable')
      if (ref.projectId !== undefined || ref.publishedPackRef !== undefined || ref.scopeRef !== undefined && (ref.scopeRef.tenantId !== scope.tenantId || ref.scopeRef.spaceId !== scope.spaceId)
        || ref.definitionRef !== undefined && canonicalJson(ref.definitionRef) !== canonicalJson(definition.ref)) throw new Error('actual upstream reference qualifiers cannot be normalized to the exact target scope/definition')
      return { ruleId: ref.ruleId, ruleRef: { id: upstream.candidateId, version: '1.0.0', digest: upstream.contentDigest }, objectId: ref.objectId, predicate: ref.predicate }
    })
    if (dependencyRefs.length !== (rule.ruleDependencies?.length ?? 0)) throw new Error('actual dependency references are incomplete')
    const locate = (spans: readonly unknown[]) => {
      const origins = fragments.filter((fragment) => spans.some((span) => isRecord(span) && fragment.sourceSpan.kind !== 'structured'
        && span['parseId'] === fragment.sourceSpan.parseId && span['chunkId'] === fragment.sourceSpan.chunkId && span['quoteDigest'] === fragment.sourceSpan.quoteDigest
        && span['spanKind'] === fragment.sourceSpan.spanKind && span['precision'] === fragment.sourceSpan.precision
        && canonicalJson(span['locator']) === canonicalJson(fragment.sourceSpan.locator)))
      if (origins.length !== 1) throw new Error('actual rule clause source is missing or ambiguous in the approved original corpus')
      return origins[0]!
    }
    const paths = [{ path: 'applicability', spans: rule.sourceSpans }, ...clausePaths(rule.expression, 'condition'), ...rule.exceptions.flatMap((exception, index) => [{ path: `exceptions[${index}]`, spans: exception.spans }, ...clausePaths(exception.condition, `exceptions[${index}].condition`)]),
      ...(rule.conclusion === undefined ? [] : [{ path: 'conclusion', spans: rule.sourceSpans }]), ...dependencyRefs.map((_, index) => ({ path: `dependencyRefs[${index}]`, spans: rule.sourceSpans }))]
    const output = { rules: [{ ruleId: rule.ruleId, objectId: rule.objectId, displayName: rule.ruleId, businessMeaning: 'human-preserved full actual template rule', suggestedReason: 'actual original policy source',
      condition: stripSpans(rule.expression), exceptions: stripSpans(rule.exceptions), ...(rule.conclusion === undefined ? {} : { conclusion: rule.conclusion }), ruleDependencies: rule.ruleDependencies ?? [], dependencyRefs,
      sourceSelections: paths.map(({ path, spans }) => { const source = locate(spans); return { path, sourceIndex: source.sourceIndex, fragmentIndex: source.fragmentIndex } }) }] }
    const produced = await new RuleActionCandidateGenerationService({ workspaces, definitionCandidates: definitions, candidates, batches: new PostgresRuleActionGenerationStore(database), service,
      terminology: new StaticDefinitionTerminologySource(), sourceGrounding: input.grounding, generationForRun: () => new TemplateDeclarationGeneration(output),
      modelRef: { modelId: 'synthetic-human-rule-declaration', version: '1.0.0' }, outputLimit: { maxTokens: 16_000 } }).generate({ workspaceId, expectedRevision: '2', sourceRefs, kinds: ['rule'], selectedDefinitionCandidateIds: terms.candidates.map((term) => term.candidateId),
        generationPolicyRef, candidateLimit: 1, idempotencyKey: `cq-target-rule-${randomUUID()}` }, ctx.principal.subjectId, ctx, signal)
    const candidate = produced.candidates[0]
    if (produced.batch.state !== 'completed' || candidate?.payload.kind !== 'rule') throw new Error('actual complete target rule is not executable with its real source bindings')
    await review(candidate.candidateId)
    const enabled = await service.enableRuleCandidate(workspaceId, { candidateId: candidate.candidateId, expectedRevision: '2' }, ctx)
    saved.set(rule.ruleId, enabled.candidate)
  }
  const projection = currentDefinitionProjection(await definitions.listCandidates(scope, workspaceId, { limit: 250 }, ctx))
  const rules = currentRuleActionProjection(await candidates.list(scope, workspaceId, { limit: 250 }, ctx))
  const approval = await definitionApprovalPins(projection, scope, ctx, reviewable, reviews)
  if (approval.blockers.length > 0) throw new Error('actual target lacks current scoped human approvals')
  signal.throwIfAborted()
  return { target: { workspaceId, revision: '2', definitionApprovalPins: approval.pins, ruleActionPins: ruleActionPublicationPins(rules) }, definitionCandidates: projection,
    ruleCandidates: rules.filter((row): row is RuleCandidateVersion => row.kind === 'rule' && row.payload.kind === 'rule') }
}
