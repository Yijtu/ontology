import type { IdentityDecisionStore, RelationNavigationResult, RunExecutionBindingStore, SemanticPublicationStore, ToolContext } from '@ontology/contracts'
import { isRelationNavigationRequest } from '@ontology/contracts'
import { PublishedRelationNavigator } from '@ontology/semantic-engine'
import { ToolGatewayError, canonicalJson, isRecord } from '@ontology/tool-services'
import type { ToolExecutionRequest, ToolHandler } from '@ontology/tool-services'
import type { CoreSemanticTaskResolver } from './core-semantic-task-resolver'

export interface CoreRelationsTaskHandlerOptions {
  readonly executions: RunExecutionBindingStore
  readonly selectors: CoreSemanticTaskResolver
  readonly publications: SemanticPublicationStore
  readonly identity: IdentityDecisionStore
}

/** Run-scoped navigation over the actual official project relation and endpoint inventory. */
export class CoreRelationsTaskHandler implements ToolHandler {
  readonly toolId = 'ontology_lookup'
  constructor(readonly options: CoreRelationsTaskHandlerOptions) {}

  async navigate(args: Readonly<Record<string, unknown>>, ctx: ToolContext, signal?: AbortSignal): Promise<RelationNavigationResult> {
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const execution = await this.options.executions.getBindingByRun(scope, ctx.runId, ctx)
    const raw = args['request']
    if (execution === undefined || !isRecord(raw) || raw['kind'] !== 'relation_navigation' || !isRelationNavigationRequest(raw) || Object.keys(raw).some((key) => !['kind', 'startEntityId', 'relationIds', 'validAt'].includes(key))) throw new ToolGatewayError('INVALID_ARGUMENTS', 'the relation task requires its exact scoped run and finite navigation parameters')
    const request = raw
    const loaded = await this.options.selectors.load(execution.binding, new Set(['ontology_lookup']), ctx)
    if (!loaded.bindings.some((binding) => binding.kind === 'relations') || !loaded.entities.some((entity) => entity.entityId === request.startEntityId)) throw new ToolGatewayError('INVALID_ARGUMENTS', 'the relation start is outside the published project inventory', { platformCode: 'FORBIDDEN' })
    const statements = loaded.source.premiseInput?.relationStatements ?? []
    const navigator = new PublishedRelationNavigator({
      identity: this.options.identity, definitionRef: loaded.definition.ref,
      allowedRelationIds: loaded.definition.relations.map((relation) => relation.id),
      relationTargets: new Map(loaded.definition.relations.map((relation) => [relation.id, { fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId }])),
      publications: {
        getPublication: (scope, id, ctx) => this.options.publications.getPublication(scope, id, ctx),
        getStatement: (scope, id, ctx) => this.options.publications.getStatement(scope, id, ctx),
        latestPublicationRevision: (scope, ctx) => this.options.publications.latestPublicationRevision(scope, ctx),
        listStatements: async (_scope, filter) => statements.filter((statement) => (filter.status === undefined || statement.status === filter.status) && (filter.afterStatementId === undefined || statement.statementId > filter.afterStatementId)).sort((a, b) => a.statementId.localeCompare(b.statementId)).slice(0, filter.limit),
      },
    })
    return navigator.navigate({ ...request, ...(signal === undefined ? {} : { signal }) }, ctx)
  }

  async execute(request: ToolExecutionRequest) {
    const payload = await this.navigate(request.arguments, request.ctx, request.signal)
    return { payload: { resultKind: 'relations', ...payload, navigation: request.arguments['request'] }, status: payload.completeness === 'complete' ? 'ok' as const : 'partial' as const,
      coverage: { returned: payload.paths.length, truncated: payload.completeness !== 'complete' },
      sources: [{ sourceRef: { namespace: 'ontology-core-local', sourceId: 'published-project-relations' }, schemaVersion: 'relation-navigation@1', consistency: 'repeatable_read' as const }], dataMode: 'observed' as const }
  }

  async verify(payload: Readonly<Record<string, unknown>>, ctx: ToolContext): Promise<boolean> {
    const startEntityId = payload['startEntityId']
    const navigation = payload['navigation']
    if (typeof startEntityId !== 'string' || !isRecord(navigation)) return false
    const current = await this.navigate({ request: { kind: 'relation_navigation', ...navigation } }, ctx)
    const prior = { ...payload }
    delete prior['navigation']
    delete prior['resultKind']
    return canonicalJson(current) === canonicalJson(prior)
  }
}
