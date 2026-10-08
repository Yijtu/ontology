import { WorkflowControllerError } from '@ontology/application'
import { ProjectDatasetError, projectDatasetSourceRef, isRecord } from '@ontology/contracts'
import type {
  ProjectPublishedDatasetSource, ProjectReadinessStore, ProjectRevision, ProjectRevisionRef,
  ProjectSnapshotQueryDescriptor, ProjectSnapshotQueryPort, ResourceRef, RunExecutionBinding,
  RunExecutionBindingStore, ScopeRef, TaskBindingStore, ToolContext,
  SemanticDefinitionVersion, VersionRef,
  ColumnType, DataQueryOutput,
} from '@ontology/contracts'
import { InMemorySemanticMappingRegistry, buildProjectSnapshotMapping, projectSnapshotMappingRef, definitionVersionDigest } from '@ontology/semantic-engine'
import { DataQueryHandler, ToolGatewayError } from '@ontology/tool-services'
import type { ToolExecutionRequest, ToolHandler } from '@ontology/tool-services'

export interface CoreProjectQueryOptions {
  readonly query: ProjectSnapshotQueryPort
  readonly publishedSource: ProjectPublishedDatasetSource
  readonly projects: {
    getProject(scope: ScopeRef, projectId: string, ctx: ToolContext): Promise<{ readonly headRevision: string } | undefined>
    getRevision(scope: ScopeRef, projectId: string, revision: string, ctx: ToolContext): Promise<ProjectRevision | undefined>
  }
  readonly readiness: ProjectReadinessStore
  readonly executionBindings: RunExecutionBindingStore
  readonly taskBindings: TaskBindingStore
  readonly definition: (scope: ScopeRef, ref: VersionRef, ctx: ToolContext) => Promise<SemanticDefinitionVersion | undefined>
}

function sameRef(a: ResourceRef, b: ResourceRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest && a.kind === b.kind
}

function isColumnType(value: unknown): value is ColumnType {
  return typeof value === 'string' && ['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json', 'binary'].includes(value)
}

/** Fixed project snapshot resolution, shared by task creation, planning and the tool handler. */
export function createCoreProjectQueryWorkflow(options: CoreProjectQueryOptions) {
  const describe = async (scope: ScopeRef, revisionRef: ProjectRevisionRef, ref: ResourceRef, objectId: string, ctx: ToolContext): Promise<ProjectSnapshotQueryDescriptor> => {
    const revision = await options.projects.getRevision(scope, revisionRef.projectId, revisionRef.revision, ctx)
    const gate = await options.readiness.getProjection(scope, revisionRef, 'dataset', ctx)
    const readyRef = gate?.targetRef
    if (gate?.state !== 'ready' || readyRef === undefined || !('kind' in readyRef) || !sameRef(readyRef, ref) || gate.targetDigest !== ref.digest) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the exact historical project snapshot readiness gate is not ready')
    const descriptor = await options.query.describeSnapshot(scope, ref, ctx)
    const definition = revision === undefined ? undefined : await options.definition(scope, revision.definitionRef, ctx)
    const metadata = descriptor?.metadata
    if (revision === undefined || definition === undefined || definition.ref.id !== revision.definitionRef.id || definition.ref.version !== revision.definitionRef.version ||
      definition.ref.digest !== revision.definitionRef.digest || definitionVersionDigest(definition) !== revision.definitionRef.digest ||
      definition.scopeRef.tenantId !== scope.tenantId || definition.scopeRef.spaceId !== scope.spaceId ||
      revision.ref.digest !== revisionRef.digest || descriptor === undefined || metadata === undefined ||
      !sameRef(metadata.snapshotRef, ref) || descriptor.objectId !== objectId || metadata.body.projectRevisionRef?.projectId !== revisionRef.projectId ||
      metadata.body.projectRevisionRef.revision !== revisionRef.revision || metadata.body.projectRevisionRef.digest !== revisionRef.digest ||
      metadata.body.definitionRef.id !== revision.definitionRef.id || metadata.body.definitionRef.version !== revision.definitionRef.version ||
      metadata.body.definitionRef.digest !== revision.definitionRef.digest || metadata.body.factRecordedPoint === undefined || metadata.body.sourceDigest === undefined) {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the exact official project query snapshot is not ready')
    }
    return descriptor
  }
  const resolveForCreation = async (scope: ScopeRef, revision: ProjectRevision, parameters: Readonly<Record<string, unknown>>, ctx: ToolContext): Promise<ResourceRef> => {
    const objectId = parameters['objectId']
    if (typeof objectId !== 'string') throw new ProjectDatasetError('INVALID_ARGUMENT', 'a project query requires an objectId')
    const head = await options.projects.getProject(scope, revision.ref.projectId, ctx)
    if (head === undefined || head.headRevision !== revision.ref.revision) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'new project query runs require the current project revision')
    const projection = await options.readiness.getProjection(scope, revision.ref, 'dataset', ctx)
    const target = projection?.targetRef
    if (projection?.state !== 'ready' || target === undefined || !('kind' in target) || target.kind !== 'dataset' || projection.targetDigest !== target.digest) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the project dataset readiness gate is not ready')
    const descriptor = await describe(scope, revision.ref, target, objectId, ctx)
    const current = await options.publishedSource.read(scope, revision, objectId, ctx)
    if (current.sourceDigest !== descriptor.metadata?.body.sourceDigest) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the official published sources changed; rebuild the project projection')
    return target
  }
  const resolveExecution = async (execution: RunExecutionBinding, objectId: string, ctx: ToolContext): Promise<ProjectSnapshotQueryDescriptor> => {
    const request = execution.request
    const ref = execution.projectDatasetSnapshotRef
    if (request.mode !== 'task' || ref === undefined) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the structured query run has no archived project dataset snapshot')
    return describe({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, request.projectRevisionRef, ref, objectId, ctx)
  }
  const handler = (fallback: ToolHandler): ToolHandler => ({
    toolId: 'data_query',
    async execute(request: ToolExecutionRequest) {
      const scope = { tenantId: request.ctx.principal.tenantId, spaceId: request.ctx.allowedResources.spaceId }
      const archived = await options.executionBindings.getBindingByRun(scope, request.ctx.runId, request.ctx)
      const execution = archived?.binding
      if (execution?.request.mode !== 'task') return fallback.execute(request)
      const binding = await options.taskBindings.getBinding(scope, execution.request.taskBindingRef, request.ctx)
      if (binding?.kind !== 'structured_query') return fallback.execute(request)
      const objectId = execution.request.parameters['objectId']
      if (typeof objectId !== 'string' || request.arguments['kind'] !== 'query' || request.arguments['mode'] !== 'semantic') throw new ToolGatewayError('INVALID_ARGUMENTS', 'the fixed structured query task requires its semantic project query')
      const descriptor = await resolveExecution(execution, objectId, request.ctx)
      if (!request.ctx.allowedResources.sourceRefs.some((ref) => ref.namespace === 'project-dataset' && ref.sourceId === descriptor.snapshotRef.id)) throw new ToolGatewayError('INVALID_ARGUMENTS', 'the archived project snapshot is outside the trusted run allowlist', { platformCode: 'FORBIDDEN' })
      const outcome = await new DataQueryHandler({ query: options.query, consistency: 'immutable', dataMode: 'observed',
        mappings: new InMemorySemanticMappingRegistry([buildProjectSnapshotMapping({ descriptor })]) }).execute(request)
      const payload = outcome.payload
      const table = isRecord(payload) ? payload['table'] : undefined
      if (!isRecord(table) || !Array.isArray(table['columns']) || !Array.isArray(table['rows'])) throw new ToolGatewayError('HANDLER_FAILED', 'the fixed project query returned a malformed table')
      const columns = table['columns'].map((column: unknown) => {
        if (!isRecord(column) || typeof column['name'] !== 'string' || !isColumnType(column['type'])) throw new ToolGatewayError('HANDLER_FAILED', 'the fixed project query returned a malformed column')
        const declared = descriptor.columns.find((field) => field.name === column['name'])
        return { name: column['name'], type: column['type'], ...(declared === undefined ? {} : { semanticFieldRef: declared.name }),
          ...(column['type'] !== 'decimal' || declared?.canonicalUnitCode === undefined ? {} : { unit: declared.canonicalUnitCode }) }
      })
      const rows = table['rows'].map((row: unknown): unknown[] => {
        if (!Array.isArray(row)) throw new ToolGatewayError('HANDLER_FAILED', 'the fixed project query returned a malformed row')
        return [...row]
      })
      const located: DataQueryOutput = { resultKind: 'table', table: { columns, rows } }
      return { ...outcome, payload: located }
    },
  })
  return { resolveForCreation, resolveExecution, handler,
    mappingRef: projectSnapshotMappingRef,
    sourceRef: projectDatasetSourceRef }
}

export type CoreProjectQueryWorkflow = ReturnType<typeof createCoreProjectQueryWorkflow>
