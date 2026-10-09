import { WorkflowControllerError } from '@ontology/application'
import type { SemanticTaskIntent, TaskParameterValidator } from '@ontology/application'
import type {
  ApprovedCompetencyQuestionReader, MaterializationStore, OperationRegistry, ProjectRevision, ProjectStore,
  PublishedTaskBinding, RunExecutionBinding, ScopeRef, SemanticDefinitionVersion, TaskBindingStore,
  ToolContext, VersionRef,
  OntologyRuleJudgementRequest,
  PublishedRuleDeclarationReader,
} from '@ontology/contracts'
import { findRegisteredOperation } from '@ontology/contracts'
import { PublishedSemanticSource, definitionVersionDigest, publishedRuleRef } from '@ontology/semantic-engine'
import type { MaterializationPublishedSource, PublishedSemanticReadView } from '@ontology/semantic-engine'
import { canonicalJson, registeredOperationDigest } from '@ontology/tool-services'

export interface CoreSemanticTaskResolverOptions {
  readonly projects: Pick<ProjectStore, 'getProject' | 'getRevision'>
  readonly taskBindings: TaskBindingStore
  readonly materialization: Pick<MaterializationStore, 'getProjectionState' | 'readSlices'>
  readonly source: (revision: ProjectRevision, definition: SemanticDefinitionVersion) => MaterializationPublishedSource
  readonly definition: (scope: ScopeRef, ref: VersionRef, ctx: ToolContext) => Promise<SemanticDefinitionVersion | undefined>
  readonly operations: OperationRegistry
  readonly parameters: TaskParameterValidator
  readonly computeInputAvailable?: (execution: RunExecutionBinding, revision: ProjectRevision, binding: PublishedTaskBinding, ctx: ToolContext) => Promise<boolean>
  readonly competencyQuestions?: { readonly reader: ApprovedCompetencyQuestionReader; readonly refForRevision: (revision: ProjectRevision) => VersionRef | undefined }
}

export type CoreSemanticTaskSelection = { readonly taskBindingRef: VersionRef; readonly parameters: Readonly<Record<string, unknown>> }
export type CoreSemanticTaskResolution = { readonly kind: 'selected'; readonly binding: PublishedTaskBinding; readonly selection: CoreSemanticTaskSelection }
  | { readonly kind: 'clarify'; readonly reason: string }

function sameRef(a: VersionRef, b: VersionRef): boolean { return canonicalJson(a) === canonicalJson(b) }
function scopeOf(ctx: ToolContext): ScopeRef { return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId } }

/** Fixed project/definition and official confirmed identities are the only selector inventory. */
export class CoreSemanticTaskResolver {
  constructor(readonly options: CoreSemanticTaskResolverOptions) {}

  async load(execution: RunExecutionBinding, enabledTools: ReadonlySet<string>, ctx: ToolContext, enabledOperations: ReadonlySet<string> = new Set()) {
    const scope = scopeOf(ctx)
    if (execution.runId !== ctx.runId) throw new WorkflowControllerError('FORBIDDEN', 'semantic task selection must use this trusted run execution binding')
    const ref = execution.request.projectRevisionRef
    const revision = await this.options.projects.getRevision(scope, ref.projectId, ref.revision, ctx)
    const head = await this.options.projects.getProject(scope, ref.projectId, ctx)
    if (revision?.executionPurpose === 'synthetic_validation') throw new WorkflowControllerError('FORBIDDEN', 'private competency inputs cannot become ordinary observed business task selections')
    if (revision === undefined || head === undefined || head.state === 'archived' || revision.ref.digest !== ref.digest || (head.activeRevision ?? head.headRevision) !== ref.revision) {
      throw new WorkflowControllerError('FORBIDDEN', 'semantic task selection requires the authorized active project revision')
    }
    const definition = await this.options.definition(scope, revision.definitionRef, ctx)
    if (definition === undefined || definition.scopeRef.tenantId !== scope.tenantId || definition.scopeRef.spaceId !== scope.spaceId || !sameRef(definition.ref, revision.definitionRef) || definitionVersionDigest(definition) !== definition.ref.digest) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the fixed project definition is unavailable')
    const bindings: PublishedTaskBinding[] = []
    for (const ref of execution.allowedTaskBindingRefs) {
      const binding = await this.options.taskBindings.getBinding(scope, ref, ctx)
      if (binding === undefined || !sameRef(binding.taskBindingRef, ref) || !sameRef(binding.actionDefinitionRef, definition.ref)) continue
      const tool = binding.kind === 'structured_query' || binding.kind === 'compute' ? 'data_query' : binding.kind === 'document_qa' ? 'document_search' : 'ontology_lookup'
      if (!enabledTools.has(tool) || binding.kind === 'published_facts') continue
      if (binding.kind === 'structured_query' && execution.projectDatasetSnapshotRef === undefined) continue
      if (binding.kind === 'compute') {
        const operation = binding.operationRef === undefined ? undefined : findRegisteredOperation(this.options.operations, binding.operationRef)
        if (operation === undefined || !enabledOperations.has(`${operation.operationRef.id}@${operation.operationRef.version}`) || binding.registeredOperationDigest !== registeredOperationDigest(operation)) continue
        if (this.options.computeInputAvailable !== undefined && !await this.options.computeInputAvailable(execution, revision, binding, ctx)) continue
      }
      bindings.push(binding)
    }
    if (bindings.length > 32) throw new WorkflowControllerError('INVALID_SCHEMA', 'the project task inventory exceeds its finite bound')
    return this.#readInventory(revision, definition, bindings, ctx)
  }

  /** Read-only catalogue admission from actual current project/profile selectors, before a run exists. */
  async readCurrentInventory(projectId: string, enabledTools: ReadonlySet<string>, enabledOperations: ReadonlySet<string>, ctx: ToolContext) {
    const scope = scopeOf(ctx)
    const project = await this.options.projects.getProject(scope, projectId, ctx)
    const revision = project === undefined ? undefined : await this.options.projects.getRevision(scope, projectId, project.activeRevision ?? project.headRevision, ctx)
    if (revision?.executionPurpose === 'synthetic_validation') throw new WorkflowControllerError('FORBIDDEN', 'private competency projects have no ordinary business selector inventory')
    const definition = revision === undefined ? undefined : await this.options.definition(scope, revision.definitionRef, ctx)
    if (project === undefined || project.state === 'archived' || revision === undefined || definition === undefined || !sameRef(definition.ref, revision.definitionRef) || definitionVersionDigest(definition) !== definition.ref.digest || definition.scopeRef.tenantId !== scope.tenantId || definition.scopeRef.spaceId !== scope.spaceId) throw new WorkflowControllerError('FORBIDDEN', 'a current exact authorized project definition is required')
    const inventory = await this.options.taskBindings.listBindings(scope, { definitionRef: definition.ref }, ctx)
    if (inventory.length > 32) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the task catalogue exceeds its finite bound')
    const bindings = inventory.filter((binding) => {
      if (!sameRef(binding.actionDefinitionRef, definition.ref)) return false
      const tool = binding.kind === 'structured_query' || binding.kind === 'compute' ? 'data_query' : binding.kind === 'document_qa' ? 'document_search' : 'ontology_lookup'
      if (!enabledTools.has(tool)) return false
      if (binding.kind !== 'compute') return true
      const operation = binding.operationRef === undefined ? undefined : findRegisteredOperation(this.options.operations, binding.operationRef)
      return operation !== undefined && enabledOperations.has(`${operation.operationRef.id}@${operation.operationRef.version}`) && binding.registeredOperationDigest === registeredOperationDigest(operation)
    })
    const result = await this.#readInventory(revision, definition, bindings, ctx)
    const current = await this.options.projects.getProject(scope, projectId, ctx)
    // During an explicit evolution the head may advance while the old active
    // revision remains the authorized business catalogue. Recheck that active
    // selector and project state, rather than treating the independent staging
    // head as a change to the inventory we just read.
    const selectedRevision = project.activeRevision ?? project.headRevision
    const currentRevision = await this.options.projects.getRevision(scope, projectId, selectedRevision, ctx)
    if (current === undefined || current.state !== project.state || (current.activeRevision ?? current.headRevision) !== selectedRevision || canonicalJson(currentRevision) !== canonicalJson(revision)) {
      throw new WorkflowControllerError('VERSION_CONFLICT', 'the actual task catalogue project changed during readback')
    }
    return result
  }

  async #readInventory(revision: ProjectRevision, definition: SemanticDefinitionVersion, bindings: readonly PublishedTaskBinding[], ctx: ToolContext) {
    const scope = scopeOf(ctx)
    const source = await this.options.source(revision, definition).load(scope, ctx)
    if (source.complete !== true || source.facts.length > 1000 || (source.premiseInput?.declarations.length ?? 0) > 250) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the official project selector inventory is incomplete or exceeds its bound')
    const entities = new Map<string, { readonly entityId: string; readonly objectId: string; readonly labels: string[] }>()
    const identityFields = new Set(definition.identityScopes.flatMap((identity) => identity.identityAttributeIds))
    for (const fact of source.facts) {
      if (fact.op === 'retract' || fact.objectId === undefined || fact.projectId !== revision.ref.projectId || fact.relation !== undefined) continue
      const key = `${fact.objectId}\u0000${fact.subject}`
      let entity = entities.get(key)
      if (entity === undefined) { entity = { entityId: fact.subject, objectId: fact.objectId, labels: [] }; entities.set(key, entity) }
      if (typeof fact.value === 'string' && identityFields.has(fact.attributeId ?? fact.predicate) && !entity.labels.includes(fact.value)) entity.labels.push(fact.value)
    }
    const declarations = source.premiseInput?.declarations ?? []
    for (const entity of entities.values()) {
      const identity = definition.identityScopes.find((identity) => identity.objectId === entity.objectId)
      const facts = source.facts.filter((fact) => fact.subject === entity.entityId && fact.objectId === entity.objectId && fact.op !== 'retract')
      const dimensions = identity?.scopeDimensions.flatMap((field) => {
        const values = [...new Set(facts.filter((fact) => fact.attributeId === field && typeof fact.value === 'string').map((fact) => String(fact.value)))]
        return values.length === 1 ? [`${field}=${values[0]}`] : []
      }) ?? []
      if (dimensions.length > 0) for (const label of [...entity.labels]) entity.labels.push(`${label} / ${dimensions.join(', ')}`)
    }
    const cq = this.options.competencyQuestions
    const cqRef = cq?.refForRevision(revision)
    const approved = cq !== undefined && cqRef !== undefined ? await cq.reader.readApproved(scope, cqRef, ctx) : undefined
    if (cqRef !== undefined && (approved === undefined || !sameRef(approved.ref, cqRef) || !approved.body.definitionRefs.some((ref) => sameRef(ref, definition.ref)))) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the selected competency questions are not approved for the fixed definition')
    const permitted = approved === undefined ? bindings : bindings.filter((binding) => approved.body.questions.some((question) => question.taskKind === binding.kind))
    return { revision, definition, bindings: permitted, entities: [...entities.values()], declarations, source,
      catalog: {
        tasks: permitted.map((binding) => ({ kind: binding.kind, ...(binding.kind === 'rule_judgement' ? { judgementAxis: 'applicability' } : {}), ...(binding.kind === 'compute' ? { operation: binding.taskBindingRef.id, parameterSchema: binding.parameterSchema } : {}) })),
        objects: definition.objects.map((object) => ({ name: object.id, label: object.displayName, fields: definition.attributes.filter((field) => field.objectId === object.id).map((field) => field.id) })),
        entities: [...entities.values()].map((entity) => ({ object: entity.objectId, labels: entity.labels })),
        rules: declarations.map((rule) => ({ name: rule.ruleId, object: rule.objectId })),
        relations: definition.relations.map((relation) => ({ name: relation.id, from: relation.fromObjectId, to: relation.toObjectId })),
        questions: approved?.body.questions.map((question) => ({ taskKind: question.taskKind, question: question.question })) ?? [],
      },
    }
  }

  async authorizeRule(request: OntologyRuleJudgementRequest, execution: RunExecutionBinding, ctx: ToolContext): Promise<boolean> {
    const loaded = await this.load(execution, new Set(['ontology_lookup']), ctx)
    if (!loaded.bindings.some((binding) => binding.kind === 'rule_judgement') || !sameRef(request.definitionRef, loaded.definition.ref) || !loaded.entities.some((entity) => entity.entityId === request.subjectEntityId && entity.objectId === request.objectId)) return false
    const declared = loaded.declarations.some((rule) => rule.objectId === request.objectId && sameRef('ruleRef' in rule ? rule.ruleRef : publishedRuleRef(rule), request.ruleRef))
    if (!declared) return false
    const slices = await this.options.materialization.readSlices(scopeOf(ctx), { validAt: request.validAt, asOfRecordedSeq: request.asOfRecordedSeq, limit: 1001 }, ctx)
    return slices.length <= 1000 && slices.some((slice) => slice.conclusion.ruleArtifacts?.some((artifact) => artifact.projectId === execution.request.projectRevisionRef.projectId && artifact.subjectEntityId === request.subjectEntityId && artifact.objectId === request.objectId && sameRef(artifact.ruleRef, request.ruleRef) && sameRef(artifact.definitionRef, request.definitionRef) && artifact.validAt === request.validAt && artifact.asOfRecordedSeq === request.asOfRecordedSeq))
  }

  async resolve(intent: SemanticTaskIntent, loaded: Awaited<ReturnType<CoreSemanticTaskResolver['load']>>, execution: RunExecutionBinding, ctx: ToolContext): Promise<CoreSemanticTaskResolution> {
    if (intent.kind === 'clarify') return { kind: 'clarify', reason: intent.reason }
    const bindings = loaded.bindings.filter((binding) => binding.kind === intent.kind && (intent.kind !== 'compute' || binding.taskBindingRef.id === intent.operation))
    if (bindings.length === 0) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the selected task is not enabled and ready in this project/profile')
    if (bindings.length !== 1) return { kind: 'clarify', reason: 'Choose one published task for this operation.' }
    const binding = bindings[0]!
    let parameters: Readonly<Record<string, unknown>>
    if (intent.kind === 'structured_query') {
      const objects = loaded.definition.objects.filter((object) => object.id === intent.object || object.displayName === intent.object)
      if (objects.length !== 1) return { kind: 'clarify', reason: 'Choose one object from this project.' }
      const objectId = objects[0]!.id
      if (intent.fields.some((field) => !loaded.definition.attributes.some((attribute) => attribute.id === field && attribute.objectId === objectId))) throw new WorkflowControllerError('INVALID_ARGUMENT', 'the query names a field outside the fixed object definition')
      parameters = { objectId, fields: [...intent.fields], ...(intent.limit === undefined ? {} : { limit: intent.limit }) }
    } else if (intent.kind === 'document_qa') parameters = { query: intent.query, ...(intent.limit === undefined ? {} : { limit: intent.limit }) }
    else if (intent.kind === 'compute') parameters = intent.parameters
    else {
      const entities = loaded.entities.filter((entity) => (entity.entityId === intent.entity || entity.labels.includes(intent.entity)) && (intent.object === undefined || entity.objectId === intent.object || loaded.definition.objects.some((object) => object.id === entity.objectId && object.displayName === intent.object)))
      if (entities.length !== 1) return { kind: 'clarify', reason: entities.length === 0 ? 'Choose a confirmed entity in this project.' : 'This entity name identifies several confirmed entities. Specify its object and full identity.' }
      const entity = entities[0]!
      if (intent.kind === 'relations') {
        let objectId = entity.objectId
        for (const name of intent.relations) {
          const relation = loaded.definition.relations.find((relation) => relation.id === name && relation.fromObjectId === objectId)
          if (relation === undefined) throw new WorkflowControllerError('INVALID_ARGUMENT', 'the selected relation path is not declared for this object')
          objectId = relation.toObjectId
        }
        parameters = { startEntityId: entity.entityId, relationIds: [...intent.relations], validAt: execution.effectiveTime.validAt }
      } else {
        const rules = loaded.declarations.filter((rule) => rule.ruleId === intent.rule && rule.objectId === entity.objectId)
        if (rules.length !== 1) return { kind: 'clarify', reason: 'Choose one currently published rule for this object.' }
        const rule = rules[0]!
        const ruleRef = 'ruleRef' in rule ? rule.ruleRef : publishedRuleRef(rule)
        const state = await this.options.materialization.getProjectionState(scopeOf(ctx), ctx)
        if (state === undefined || state.dirty || state.watermark.kind !== 'sequence') throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the published rule projection is not ready')
        const slices = await this.options.materialization.readSlices(scopeOf(ctx), { validAt: execution.effectiveTime.validAt, asOfRecordedSeq: state.watermark.value, limit: 1001 }, ctx)
        if (slices.length > 1000) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the rule selector read exceeds its bound')
        const artifacts = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).filter((artifact) => sameRef(artifact.ruleRef, ruleRef) && artifact.subjectEntityId === entity.entityId && artifact.objectId === entity.objectId && artifact.projectId === execution.request.projectRevisionRef.projectId && sameRef(artifact.definitionRef, loaded.definition.ref))
        const points = artifacts.flatMap((artifact) => artifact.asOfRecordedSeq !== undefined && /^\d+$/u.test(artifact.asOfRecordedSeq) ? [BigInt(artifact.asOfRecordedSeq)] : [])
        const latest = points.reduce<bigint | undefined>((prior, point) => prior === undefined || point > prior ? point : prior, undefined)
        const unique = [...new Map(artifacts.filter((artifact) => latest !== undefined && artifact.asOfRecordedSeq === String(latest)).map((artifact) => [artifact.computationDigest, artifact])).values()]
        if (unique.length !== 1) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'one exact published rule instance is required at the recorded point')
        parameters = { ruleRef, objectId: entity.objectId, subjectEntityId: entity.entityId, validAt: unique[0]!.validAt, asOfRecordedSeq: unique[0]!.asOfRecordedSeq }
      }
    }
    const validation = this.options.parameters.validate(binding.parameterSchema, parameters)
    if (!validation.valid) throw new WorkflowControllerError('INVALID_ARGUMENT', 'the selected task parameters do not satisfy the published schema')
    return { kind: 'selected', binding, selection: { taskBindingRef: binding.taskBindingRef, parameters } }
  }
}

/** Narrow host construction helper: no generic registry, function lookup or alternate truth. */
export function createCoreSemanticTaskSource(publications: PublishedSemanticReadView, options: Omit<NonNullable<ConstructorParameters<typeof PublishedSemanticSource>[1]>, 'definition' | 'projectId'>,
  packReader?: { readonly reader: PublishedRuleDeclarationReader; readonly applies: (revision: ProjectRevision, scope: ScopeRef, ctx: ToolContext) => boolean | Promise<boolean> }) {
  return (revision: ProjectRevision, definition: SemanticDefinitionVersion): MaterializationPublishedSource => ({ load: async (scope, ctx) => {
    const applies = await packReader?.applies(revision, scope, ctx) === true
    return new PublishedSemanticSource(publications, { ...options, definition, projectId: revision.ref.projectId, maxRecords: 1000,
      ...(!applies || packReader === undefined ? {} : { publishedRules: { reader: packReader.reader, request: { packRef: revision.industryPackRef, definitionRef: definition.ref, projectId: revision.ref.projectId } } }) }).load(scope, ctx)
  } })
}
