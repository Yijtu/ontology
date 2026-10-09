import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { ParsedSourceGroundingReader, deterministicUuid } from '@ontology/adapter-extraction-document'
import type { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { ProjectService, SourceGroundingBudget, WorkflowControllerError, canonicalJson, evaluateTaskCapability } from '@ontology/application'
import type { ProfileResolver } from '@ontology/application'
import type { ProjectFactMaterializationService } from '@ontology/application'
import { isRecord, isUuid, isRevisionString, tryParseSemver } from '@ontology/contracts'
import type { IndustryPackCatalogue, IndustrySchemaSource, ImportMappingVersion, JobStore, MappingRef, OperationRegistry, ProjectDocumentStore, ProjectEvolutionStore, ProjectReadinessStore, ProjectStore, ResolvedCapability, ResourceRef, SemanticPublicationStore, TaskBindingStore, ToolContext, VersionRef } from '@ontology/contracts'
import { createRequestToolContext } from '../http/context'
import { authenticateRequest, ForbiddenError, InvalidRequestFieldError, readHeader, readTraceId } from '../http/shared'
import type { RequestAuthenticator } from '../http/shared'
import type { createCoreAuthoring } from './core-authoring'
import type { createCoreInstanceIdentity } from './core-instance-identity'
import type { CoreSemanticTaskResolver } from './core-semantic-task-resolver'
import { mountCoreDefinitionTaskBindings } from './core-task-bindings'
import type { CoreDefinitionLabelReader } from './core-definition-labels'
import { EXAMPLE_COMPUTE_INPUT_REQUIREMENTS, EXAMPLE_OPERATION_REF } from '@ontology/tool-services'

export function createCoreProjectApi(options: {
  readonly projects: ProjectStore; readonly documents: ProjectDocumentStore; readonly jobs: JobStore
  readonly readiness: ProjectReadinessStore; readonly catalogue: IndustryPackCatalogue; readonly profiles: ProfileResolver
  readonly schemas: IndustrySchemaSource; readonly tasks: TaskBindingStore; readonly operations: OperationRegistry
  readonly availableCapabilities: readonly ResolvedCapability[]; readonly resultSchemaRef: VersionRef
  readonly blobs: LocalImmutableBlobStore; readonly parses: PostgresDocumentParseStore; readonly structured: PostgresStructuredIngestionStore
  readonly authoring: ReturnType<typeof createCoreAuthoring>; readonly identity: ReturnType<typeof createCoreInstanceIdentity>
  readonly facts: ProjectFactMaterializationService
  readonly evolutions: Pick<ProjectEvolutionStore, 'activeRebuild'>
  readonly selectors: Pick<CoreSemanticTaskResolver, 'readCurrentInventory'>
  readonly termLabels: CoreDefinitionLabelReader
  readonly computeInputConfigured: boolean
  readonly publications: Pick<SemanticPublicationStore, 'listStatements'>
  readonly documentSetFor: (projectId: string,ctx: ToolContext) => Promise<ResourceRef>
}) {
  const scope = (ctx: ToolContext) => ({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })
  const sourceReader = new ParsedSourceGroundingReader({ blobs: options.blobs, documents: options.parses, tables: options.structured })
  const afterMappingConfirmed = async (mapping: ImportMappingVersion, key: string, ctx: ToolContext) => {
    const project = await options.projects.getProject(scope(ctx),mapping.projectId,ctx)
    const revision = project === undefined ? undefined : await options.projects.getRevision(scope(ctx),mapping.projectId,project.headRevision,ctx)
    if (project === undefined || project.state === 'archived' || revision === undefined || revision.executionPurpose === 'synthetic_validation' ||
      (project.activeRevision ?? project.headRevision) !== project.headRevision || canonicalJson(mapping.definitionRef) !== canonicalJson(revision.definitionRef)) throw new InvalidRequestFieldError('confirmed input mapping requires this exact current business definition outside a staged upgrade')
    const members = await options.documents.listDocuments(scope(ctx),mapping.projectId,{ state: 'active',limit: 200 },ctx)
    const visibility = await options.documents.getVisibility(scope(ctx),mapping.projectId,ctx)
    if (members.nextCursor !== null || visibility === undefined || members.memberships.filter((member) => member.parseId === mapping.parseId && canonicalJson(member.documentRef) === canonicalJson(mapping.originalRef)).length !== 1) throw new InvalidRequestFieldError('the confirmed mapping has no unique current authorized original membership')
    const documentSetRef = await options.documentSetFor(mapping.projectId,ctx)
    if (revision.mappingRefs.some((ref) => canonicalJson(ref) === canonicalJson(mapping.ref)) && revision.documentSetRef.digest === documentSetRef.digest && revision.sourceVisibilityEpoch === visibility.epoch) return
    const schema = await options.schemas.getSchema(scope(ctx),revision.definitionRef,ctx)
    if (schema === undefined || schema.objects.length > 64) throw new InvalidRequestFieldError('the exact input definition is unavailable or exceeds its finite bound')
    let inspected = 0
    for (const object of schema.objects) {
      let afterStatementId: string | undefined
      while (true) {
        const statements = await options.publications.listStatements(scope(ctx), { objectId: object.objectId,status: 'active',limit: 250,...(afterStatementId === undefined ? {} : { afterStatementId }) },ctx)
        inspected += statements.length
        if (inspected > 20_000) throw new InvalidRequestFieldError('the exact published-input admission exceeds its finite bound')
        if (statements.some((statement) => { const provenance = statement.value['provenance']; return isRecord(provenance) && Array.isArray(provenance['sources']) && provenance['sources'].some((pin: unknown) => isRecord(pin) && isRecord(pin['projectRevisionRef']) && pin['projectRevisionRef']['projectId'] === project.projectId) })) throw new InvalidRequestFieldError('已有正式事实的项目需要通过明确升级与原始资料重建流程更新映射；当前生效版本保持可查询。')
        if (statements.length < 250) break
        const last = statements.at(-1)?.statementId
        if (last === undefined || last === afterStatementId) throw new InvalidRequestFieldError('the published-input inventory did not advance')
        afterStatementId = last
      }
    }
    if (revision.mappingRefs.length >= 200) throw new InvalidRequestFieldError('the current confirmed input mapping inventory exceeds its finite bound')
    const service = new ProjectService({ projects: options.projects,readiness: options.readiness,jobs: options.jobs,catalogue: options.catalogue,evolutionPolicy: 'staged_only' })
    await service.appendRevision(mapping.projectId,{ expectedRevision: project.headRevision, reason: '人工确认原始字段映射并固定当前资料',
      mappingRefs: [...revision.mappingRefs.filter((ref) => ref.id !== mapping.ref.id),mapping.ref],documentSetRef,sourceVisibilityEpoch: visibility.epoch },`confirmed-input-mount:${key}`,ctx.principal.subjectId,ctx)
  }
  const sourceCatalogue = async (projectId: string, ctx: ToolContext) => {
    const revision = await options.identity.revisionFor(projectId, ctx)
    const project = await options.projects.getProject(scope(ctx), projectId, ctx)
    const schema = await options.schemas.getSchema(scope(ctx), revision.definitionRef, ctx)
    if (schema === undefined) throw new InvalidRequestFieldError('the exact project definition is unavailable')
    const termLabels = await options.termLabels(scope(ctx), revision.industryPackRef, revision.definitionRef, ctx)
    const memberships = await options.documents.listDocuments(scope(ctx), projectId, { state: 'active', limit: 200 }, ctx)
    if (memberships.nextCursor !== null) throw new InvalidRequestFieldError('the source catalogue exceeds its bounded complete inventory')
    const budget = new SourceGroundingBudget(new AbortController().signal, { pages: 64 })
    const sources = []
    for (const member of memberships.memberships) {
      const native = await options.structured.getParse(scope(ctx), member.parseId, ctx)
      const parsed = await options.parses.getParse(scope(ctx), member.parseId, ctx)
      if (parsed === undefined || canonicalJson(parsed.originalRef) !== canonicalJson(member.documentRef)) throw new InvalidRequestFieldError('an active membership lacks its actual document projection')
      const tables = []
      if (native !== undefined && (native.format === 'csv' || native.format === 'xlsx')) {
        if (native.parseOptions === undefined || canonicalJson(native.originalRef) !== canonicalJson(member.documentRef)) throw new InvalidRequestFieldError('the active native parse has no exact saved selection')
        const page = await sourceReader.readPage(scope(ctx), { sourceRef: native.originalRef, state: 'approved', kind: 'table', parseId: native.parseId, parserVersion: native.parserVersion, tableOptions: native.parseOptions }, { limit: 8 }, ctx, budget)
        for (const table of page.contents) if (table.kind === 'table') tables.push({ tableId: `${native.parseId}:${table.sheetId ?? 'csv'}`, name: table.sheetName,
          sheetId: table.sheetId, sheetName: table.sheetName, headerRow: table.headerRow,
          columns: table.columns.map((column) => ({ columnIndex: column.index, header: column.header, headerDigest: column.headerDigest })),
          rows: table.rows.map((row) => ({ sourceRowKey: row.sourceSpan.kind === 'structured' ? row.sourceSpan.sourceRowKey : '', cells: row.cells.map((cell, columnIndex) => ({ columnIndex, raw: cell.raw, locator: cell.locator })) })) })
      }
      sources.push({ sourceRef: member.documentRef, originalRef: member.documentRef, documentId: member.documentId, parseRef: member.parseRef,
        parseId: member.parseId, parserVersion: native?.parserVersion ?? parsed.parserVersion, kind: native === undefined ? 'document' : 'table',
        mediaType: parsed.originalMediaType, originalMediaType: parsed.originalMediaType, status: native?.status ?? parsed.coverage.status,
        coverage: native?.coverage ?? parsed.coverage, precision: member.precision,
        ...(native === undefined ? {} : { format: native.format, ...(native.parseOptions === undefined ? {} : { options: native.parseOptions }) }), tables })
    }
    if (canonicalJson(await options.identity.revisionFor(projectId, ctx)) !== canonicalJson(revision) || canonicalJson(await options.documents.listDocuments(scope(ctx), projectId, { state: 'active', limit: 200 }, ctx)) !== canonicalJson(memberships)) throw new InvalidRequestFieldError('the project/source catalogue changed during readback')
    const activeEvolution = await options.evolutions.activeRebuild(scope(ctx), projectId, ctx)
    const referenceChoices = await options.identity.referenceChoices(projectId, ctx)
    return { project, revision, sources, ...(activeEvolution === undefined ? {} : { activeEvolution }), objects: schema.objects.map((object) => ({ objectId: object.objectId, displayName: object.displayName,
      entities: referenceChoices.filter((entity) => entity.objectId === object.objectId),
      attributes: object.attributes.map((attribute) => ({ attributeId: attribute.attributeId, displayName: termLabels?.attributes.find((entry) => entry.objectId === object.objectId && entry.attributeId === attribute.attributeId)?.displayName ?? '未提供名称', valueType: attribute.valueType,
        ...(attribute.unitCode === undefined ? {} : { unit: attribute.unitCode }), ...(attribute.enumValues === undefined ? {} : { enumValues: attribute.enumValues }),
        ...(attribute.referencesObjectId === undefined ? {} : { referencesObjectId: attribute.referencesObjectId }), required: attribute.minCardinality > 0 })) })) }
  }
  const taskCatalogue = async (projectId: string, ctx: ToolContext) => {
    const project = await options.projects.getProject(scope(ctx), projectId, ctx)
    const revision = project === undefined ? undefined : await options.projects.getRevision(scope(ctx), projectId, project.activeRevision ?? project.headRevision, ctx)
    if (project === undefined || project.state === 'archived' || revision === undefined) throw new InvalidRequestFieldError('the current active business project is unavailable')
    if (revision.executionPurpose === 'synthetic_validation') throw new InvalidRequestFieldError('private competency projects have no ordinary business task catalogue')
    const schema = await options.schemas.getSchema(scope(ctx), revision.definitionRef, ctx)
    if (schema === undefined) throw new InvalidRequestFieldError('the exact project definition is unavailable')
    const termLabels = await options.termLabels(scope(ctx), revision.industryPackRef, revision.definitionRef, ctx)
    const resolved = await options.profiles.getResolvedProfile({ scopeRef: scope(ctx), profileRef: revision.profileRef, snapshotHash: revision.profileRef.snapshotHash }, ctx)
    const readiness = await options.readiness.listProjections(scope(ctx), revision.ref, ctx)
    await mountCoreDefinitionTaskBindings(options.tasks, revision.definitionRef, scope(ctx), ctx)
    const bindings = await options.tasks.listBindings(scope(ctx), { definitionRef: revision.definitionRef }, ctx)
    if (bindings.length > 32) throw new InvalidRequestFieldError('the task inventory exceeds its bounded catalogue')
    const labels: Readonly<Record<string, string>> = { published_facts: '已发布事实', structured_query: '查询项目数据', document_qa: '查阅项目资料', rule_judgement: '判断规则条件', relations: '追踪对象关系', compute: '执行已登记计算' }
    let inventory: Awaited<ReturnType<CoreSemanticTaskResolver['readCurrentInventory']>> | undefined
    let selectorFailure: string | undefined
    try {
      inventory = await options.selectors.readCurrentInventory(projectId, new Set(resolved.resolved.toolBindings.filter((binding) => binding.enabled).map((binding) => binding.toolId)),
        new Set(resolved.resolved.computeBindings.filter((binding) => binding.enabled).map((binding) => `${binding.operationRef.id}@${binding.operationRef.version}`)), ctx)
    } catch (cause) {
      if (!(cause instanceof WorkflowControllerError) || cause.code !== 'CAPABILITY_NOT_CONFIGURED') throw cause
      selectorFailure = cause.message
    }
    const tasks = bindings.map((binding) => {
      const tool = binding.kind === 'structured_query' || binding.kind === 'compute' ? 'data_query' : binding.kind === 'document_qa' ? 'document_search' : 'ontology_lookup'
      const capability = evaluateTaskCapability({ binding, availableCapabilities: options.availableCapabilities, readiness,
        operations: options.operations, supportedResultSchemaRefs: [options.resultSchemaRef] })
      const enabled = resolved.resolved.toolBindings.some((entry) => entry.toolId === tool && entry.enabled)
      const needsSelectors = binding.kind === 'rule_judgement' || binding.kind === 'relations'
      const computeReady = binding.kind !== 'compute' || options.computeInputConfigured && readiness.some((projection) => projection.kind === 'dataset' && projection.state === 'ready') && resolved.resolved.computeBindings.some((entry) => entry.enabled && entry.operationRef.id === binding.operationRef?.id && entry.operationRef.version === binding.operationRef.version)
      return { bindingRef: binding.taskBindingRef, taskKind: binding.kind, displayName: labels[binding.kind], parameterSchema: binding.parameterSchema,
        requiredCapabilities: binding.requiredCapabilities, requiredReadiness: binding.requiredReadiness,
        available: binding.kind !== 'published_facts' && enabled && capability.state === 'available' && computeReady && (!needsSelectors || selectorFailure === undefined), unavailableReasons: [...capability.blockers.map((blocker) => blocker.message), ...(enabled ? [] : ['当前配置未启用所需工具']), ...(binding.kind === 'published_facts' ? ['请使用项目数据查询查看已发布事实'] : []), ...(!computeReady ? ['项目计算需要实际就绪数据和明确选择的输入字段'] : []), ...(needsSelectors && selectorFailure !== undefined ? [selectorFailure] : [])],
        ...(binding.kind === 'compute' ? { requiresInputSelection: true,...(binding.operationRef?.id !== EXAMPLE_OPERATION_REF.id || binding.operationRef.version !== EXAMPLE_OPERATION_REF.version ? {} : { inputRequirements: { ...EXAMPLE_COMPUTE_INPUT_REQUIREMENTS,maxRows: options.operations.operations.find((operation) => operation.operationRef.id === binding.operationRef?.id && operation.operationRef.version === binding.operationRef.version)?.limits.maxRows } }) } : {}),
        ...(binding.kind === 'relations' ? { hostParameters: ['validAt'] } : {}),
        objects: schema.objects.map((object) => ({ objectId: object.objectId, displayName: object.displayName,
          attributes: object.attributes.map((attribute) => ({ attributeId: attribute.attributeId, displayName: termLabels?.attributes.find((entry) => entry.objectId === object.objectId && entry.attributeId === attribute.attributeId)?.displayName ?? '未提供名称', valueType: attribute.valueType, required: attribute.minCardinality > 0, minCardinality: attribute.minCardinality, maxCardinality: attribute.maxCardinality,
            ...(attribute.unitCode === undefined ? {} : { unit: attribute.unitCode }), ...(attribute.enumValues === undefined ? {} : { enumValues: attribute.enumValues }), ...(attribute.referencesObjectId === undefined ? {} : { referencesObjectId: attribute.referencesObjectId }) })),
          entities: inventory?.entities.filter((entity) => entity.objectId === object.objectId && entity.labels.length > 0).map((entity) => ({ entityId: entity.entityId, displayName: entity.labels[0] })) ?? [] })),
        rules: inventory?.declarations.map((rule) => ({ ruleId: rule.ruleId, displayName: rule.ruleId, objectId: rule.objectId })) ?? [],
        relations: schema.relations.map((relation) => ({ relationId: relation.relationId, displayName: termLabels?.relations.find((entry) => entry.relationId === relation.relationId)?.displayName ?? '未提供名称', fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId })) }
    })
    const after = await options.projects.getProject(scope(ctx), projectId, ctx)
    if (after === undefined || (after.activeRevision ?? after.headRevision) !== revision.ref.revision || after.state === 'archived') throw new InvalidRequestFieldError('the active business project changed during catalogue readback')
    return { project, revision, tasks, selectorCoverage: selectorFailure === undefined ? 'complete' : 'unavailable' }
  }
  return { sourceCatalogue, taskCatalogue, afterMappingConfirmed, register(app: FastifyInstance, authenticate: RequestAuthenticator) {
    const trusted = (request: Parameters<RequestAuthenticator>[0], reply: Parameters<typeof authenticateRequest>[2]) => {
      const auth = authenticateRequest(authenticate, request, reply); if (auth === undefined) return undefined
      const traceId = readTraceId(request)
      return { traceId, ctx: createRequestToolContext({ ...auth, traceId, runId: randomUUID() }) }
    }
    app.post('/api/v1/core/project-bootstrap', async (request, reply) => {
      const context = trusted(request, reply); if (context === undefined) return reply
      if (!context.ctx.principal.roles.some((role) => role === 'profile-editor' || role === 'platform-admin')) throw new ForbiddenError('project creation requires an editor role')
      const body = request.body, key = readHeader(request, 'idempotency-key')
      if (!isRecord(body) || Object.keys(body).some((field) => !['title', 'profileRef'].includes(field)) || typeof body['title'] !== 'string' || !isRecord(body['profileRef']) || Object.keys(body['profileRef']).some((field) => !['id', 'version'].includes(field)) || typeof body['profileRef']['id'] !== 'string' || typeof body['profileRef']['version'] !== 'string' || tryParseSemver(body['profileRef']['version']) === undefined || key === undefined || key.length < 8 || key.length > 200) throw new InvalidRequestFieldError('title, exact profile identity and a bounded idempotency key are required')
      const profileRef = { id: body['profileRef']['id'], version: body['profileRef']['version'] }
      const bound = await options.profiles.bindRunProfile(profileRef, scope(context.ctx), context.ctx)
      const profile = await options.profiles.getResolvedProfile({ scopeRef: scope(context.ctx), profileRef, snapshotHash: bound.resolvedProfileHash }, context.ctx)
      const pack = await options.catalogue.findPack(profile.resolved.industryRef.id, profile.resolved.industryRef.version, scope(context.ctx), context.ctx)
      if (pack === undefined || canonicalJson(pack.ref) !== canonicalJson(profile.resolved.industryRef)) throw new InvalidRequestFieldError('the resolved published industry pack is unavailable')
      const definitionRef = pack.manifest.definitionsRef
      const definition = await options.schemas.getSchema(scope(context.ctx), definitionRef, context.ctx)
      if (definition === undefined) throw new InvalidRequestFieldError('the published pack definition is unavailable')
      await mountCoreDefinitionTaskBindings(options.tasks, definitionRef, scope(context.ctx), context.ctx)
      const projectId = deterministicUuid(`${context.ctx.principal.tenantId}|${context.ctx.allowedResources.spaceId}|project:${key}`)
      const emptySet = await options.authoring.stableWrite(`project:${key}:empty`, new TextEncoder().encode(canonicalJson({ schemaVersion: 'project-document-set@1', projectId, members: [] })), 'application/json', 'artifact', context.ctx)
      const sourceObjectRef = { sourceRef: { namespace: 'ontology.identity_index', sourceId: projectId }, objectPath: 'confirmed_identity_index' }
      const catalogue = await options.authoring.stableWrite(`project:${key}:identity`, new TextEncoder().encode(canonicalJson({ schemaVersion: 'core-identity-catalogue@1', scopeRef: scope(context.ctx), projectId, definitionRef, identityScopes: definition.identityScopes, sourceObjectRef })), 'application/json', 'artifact', context.ctx)
      const identityMapping: MappingRef = { id: catalogue.id, version: catalogue.version, digest: catalogue.digest, role: 'catalog', sourceObjectRef }
      let first = true
      const service = new ProjectService({ projects: options.projects, readiness: options.readiness, jobs: options.jobs, catalogue: options.catalogue,
        evolutionPolicy: 'staged_only', newId: () => { if (first) { first = false; return projectId } return randomUUID() } })
      const result = await service.createProject({ title: body['title'], industryPackRef: profile.resolved.industryRef, profileRef: bound.resolvedProfileRef,
        mappingRefs: [...profile.resolved.mappingRefs, identityMapping], documentSetRef: emptySet }, key, context.ctx.principal.subjectId, context.ctx)
      return reply.status(result.created ? 201 : 200).send({ data: { ...result, scopeRef: scope(context.ctx) }, meta: { traceId: context.traceId } })
    })
    app.get<{ Params: { projectId: string } }>('/api/v1/core/projects/:projectId/source-catalogue', async (request, reply) => {
      const context = trusted(request, reply); if (context === undefined) return reply
      if (!isUuid(request.params.projectId)) throw new InvalidRequestFieldError('projectId must be a UUID')
      return reply.send({ data: await sourceCatalogue(request.params.projectId, context.ctx), meta: { traceId: context.traceId } })
    })
    app.get<{ Params: { projectId: string } }>('/api/v1/core/projects/:projectId/task-catalogue', async (request, reply) => {
      const context = trusted(request, reply); if (context === undefined) return reply
      if (!isUuid(request.params.projectId)) throw new InvalidRequestFieldError('projectId must be a UUID')
      return reply.send({ data: await taskCatalogue(request.params.projectId, context.ctx), meta: { traceId: context.traceId } })
    })
    app.post<{ Params: { projectId: string } }>('/api/v1/core/projects/:projectId/fact-candidates', async (request, reply) => {
      const context = trusted(request, reply); if (context === undefined) return reply
      const body = request.body
      if (!isUuid(request.params.projectId) || !isRecord(body) || Object.keys(body).some((field) => !['documentId', 'recordRefs', 'validFrom', 'validTo'].includes(field)) || !isUuid(body['documentId']) || !Array.isArray(body['recordRefs']) || body['recordRefs'].length === 0 || body['recordRefs'].length > 200) throw new InvalidRequestFieldError('actual document and one to 200 exact record revisions are required')
      const recordRefs = body['recordRefs'].map((entry: unknown) => {
        if (!isRecord(entry) || Object.keys(entry).some((field) => !['recordId', 'revision'].includes(field)) || !isUuid(entry['recordId']) || !isRevisionString(entry['revision'])) throw new InvalidRequestFieldError('each record must carry only its actual ID and revision')
        return { recordId: entry['recordId'], revision: entry['revision'] }
      })
      for (const field of ['validFrom', 'validTo']) if (body[field] !== undefined && typeof body[field] !== 'string') throw new InvalidRequestFieldError('valid times must be UTC strings')
      const candidates = await options.facts.stageRecords(request.params.projectId, { documentId: body['documentId'], recordRefs,
        ...(typeof body['validFrom'] === 'string' ? { validFrom: body['validFrom'] } : {}), ...(typeof body['validTo'] === 'string' ? { validTo: body['validTo'] } : {}) }, context.ctx)
      return reply.status(201).send({ data: { candidates }, meta: { traceId: context.traceId } })
    })
  } }
}
