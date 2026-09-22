import type {
  CatalogListRequest,
  CatalogPort,
  ConsistencyLevel,
  DataQueryOutput,
  DirectSqlQueryPlan,
  QueryColumn,
  QueryLimits,
  ScalarValue,
  ScopeRef,
  SemanticAggregation,
  SemanticQueryPlan,
  SourceObjectRef,
  SourceRef,
  SourceSnapshot,
  StructuredQueryExecuteRequest,
  StructuredQueryPort,
  StructuredQueryExecuteResponse,
  TimeWindow,
  ToolContext,
  ToolCoverage,
  ToolWarning,
} from '@ontology/contracts'
import {
  compileSemanticQuery,
  isSemanticMappingError,
  renderCompiledQuery,
  type CompilationBudget,
  type SemanticMappingErrorCode,
  type SemanticMappingRegistry,
} from '@ontology/semantic-engine'
import { ToolGatewayError } from '../errors'
import type { ToolExecutionOutcome, ToolExecutionRequest, ToolHandler, ToolSourceObservation } from '../types'

/**
 * `data_query` handler (C3/C4). It serves `describe` and the `query` union in both modes:
 *
 *  - `mode=direct`: the plan is passed to the injected `StructuredQueryPort` unchanged. No
 *    ontology is consulted, but the call still goes through the gateway, the catalogue and
 *    the adapter's source authorization.
 *  - `mode=semantic`: the concept/field/link plan is compiled against the confirmed mapping
 *    and only then handed to the port as a direct plan. Identifiers come from the mapping;
 *    values stay bound parameters.
 *
 * The handler never opens a connection (the port is injected), never calls a model and
 * never starts a planner.
 */
export interface DataQueryHandlerConfig {
  readonly query: StructuredQueryPort
  readonly catalog?: CatalogPort
  readonly mappings: SemanticMappingRegistry
  readonly ctx: ToolContext
  /** Maximum join fanout a compiled plan may declare. */
  readonly maxJoinFanout?: number
  readonly estimatedBytesPerRow?: number
  readonly consistency?: ConsistencyLevel
  /** Source a catalog describe is attributed to when it returns no resources. */
  readonly catalogSourceRef?: SourceRef
}

const DEFAULT_MAX_JOIN_FANOUT = 1000

const MAPPING_ERROR_PLATFORM: Readonly<Record<SemanticMappingErrorCode, ToolGatewayError['platformCode']>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  MAPPING_NOT_FOUND: 'CAPABILITY_NOT_CONFIGURED',
  MAPPING_VERSION_MISMATCH: 'VERSION_CONFLICT',
  INVALID_MAPPING: 'INTERNAL_ERROR',
  INVALID_QUERY_PLAN: 'INVALID_ARGUMENT',
  UNMAPPED_CONCEPT: 'INVALID_ARGUMENT',
  UNMAPPED_FIELD: 'INVALID_ARGUMENT',
  UNMAPPED_LINK: 'INVALID_ARGUMENT',
  AMBIGUOUS_FIELD: 'INVALID_ARGUMENT',
  JOIN_RELATION_REQUIRED: 'UNSUPPORTED_QUERY',
  CROSS_SOURCE_JOIN_REFUSED: 'UNSUPPORTED_QUERY',
  RELATION_KEY_REQUIRED: 'UNSUPPORTED_QUERY',
  BUDGET_EXCEEDED: 'BUDGET_EXHAUSTED',
  INVALID_FILTER_VALUE: 'INVALID_ARGUMENT',
  UNSUPPORTED_AGGREGATION: 'UNSUPPORTED_QUERY',
  TIME_FIELD_UNMAPPED: 'INVALID_ARGUMENT',
  IDENTIFIER_NOT_FROM_MAPPING: 'INVALID_ARGUMENT',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function parseDirectPlan(value: unknown): DirectSqlQueryPlan {
  if (
    !isRecord(value) ||
    value.mode !== 'direct' ||
    value.statementKind !== 'select' ||
    typeof value.sql !== 'string' ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.referencedObjects) ||
    value.readOnly !== true
  ) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'the direct query plan is malformed')
  }
  return {
    mode: 'direct',
    statementKind: 'select',
    sql: value.sql,
    parameters: value.parameters as ScalarValue[],
    referencedObjects: value.referencedObjects as SourceObjectRef[],
    readOnly: true,
  }
}

function parseSemanticPlan(value: unknown): SemanticQueryPlan {
  if (
    !isRecord(value) ||
    value.mode !== 'semantic' ||
    !Array.isArray(value.concepts) ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.links) ||
    !Array.isArray(value.filters) ||
    !Array.isArray(value.orderBy) ||
    typeof value.limit !== 'number' ||
    !isRecord(value.mappingVersion)
  ) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'the semantic query plan is malformed')
  }
  const mappingVersion = value.mappingVersion
  if (
    typeof mappingVersion.id !== 'string' ||
    typeof mappingVersion.version !== 'string' ||
    typeof mappingVersion.digest !== 'string'
  ) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'the semantic plan pins no usable mapping version')
  }
  // The gateway has already validated the plan against the canonical schema; the record is
  // rebuilt field by field so no unchecked cast widens the trusted boundary.
  return {
    mode: 'semantic',
    concepts: value.concepts as SemanticQueryPlan['concepts'],
    fields: value.fields as SemanticQueryPlan['fields'],
    links: value.links as SemanticQueryPlan['links'],
    filters: value.filters as SemanticQueryPlan['filters'],
    orderBy: value.orderBy as SemanticQueryPlan['orderBy'],
    limit: value.limit,
    mappingVersion: { id: mappingVersion.id, version: mappingVersion.version, digest: mappingVersion.digest },
    ...(value.aggregation === undefined ? {} : { aggregation: value.aggregation as SemanticAggregation }),
    ...(value.time === undefined ? {} : { time: value.time as TimeWindow }),
  }
}

function observationFromSnapshot(snapshot: SourceSnapshot): ToolSourceObservation {
  return {
    sourceRef: snapshot.sourceRef,
    schemaVersion: snapshot.schemaVersion,
    consistency: snapshot.consistency,
    ...(snapshot.asOf === undefined ? {} : { asOf: snapshot.asOf }),
    resultDigest: snapshot.resultDigest,
  }
}

function tableOutcome(
  response: StructuredQueryExecuteResponse,
  warnings: readonly ToolWarning[],
): ToolExecutionOutcome {
  const status: ToolExecutionOutcome['status'] = response.coverage.truncated
    ? 'partial'
    : response.coverage.returned === 0
      ? 'empty'
      : 'ok'
  const payload: DataQueryOutput = {
    resultKind: 'table',
    table: { columns: [...response.columns], rows: [...response.rows] },
  }
  return {
    payload,
    status,
    coverage: response.coverage,
    sources: [observationFromSnapshot(response.snapshot)],
    usage: { rows: response.coverage.returned },
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  }
}

export class DataQueryHandler implements ToolHandler {
  readonly toolId = 'data_query'
  readonly #config: DataQueryHandlerConfig

  constructor(config: DataQueryHandlerConfig) {
    this.#config = config
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const args = request.arguments
    if (args.kind === 'describe') return this.#describe(args, request)
    if (args.kind === 'query') return this.#query(args, request)
    throw new ToolGatewayError(
      'HANDLER_FAILED',
      'compute data_query is served by a registered operation handler, not the query handler',
      { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
    )
  }

  #limits(request: ToolExecutionRequest, requested: number | undefined): QueryLimits {
    const ceiling = Math.min(request.resultLimits.maxRows, this.#config.ctx.allowedResources.maxRows)
    const maxRows = Math.max(1, Math.min(requested ?? ceiling, ceiling))
    return {
      maxRows,
      maxBytes: request.resultLimits.maxBytes,
      maxDurationMs: request.resultLimits.maxDurationMs,
    }
  }

  async #query(
    args: Readonly<Record<string, unknown>>,
    request: ToolExecutionRequest,
  ): Promise<ToolExecutionOutcome> {
    const requestedLimit = typeof args.limit === 'number' ? args.limit : undefined
    const limits = this.#limits(request, requestedLimit)
    const cursor = typeof args.cursor === 'string' ? args.cursor : undefined
    const consistency: ConsistencyLevel = this.#config.consistency ?? 'repeatable_read'
    const warnings: ToolWarning[] = []

    let plan: DirectSqlQueryPlan
    if (args.mode === 'direct') {
      plan = parseDirectPlan(args.queryPlan)
    } else if (args.mode === 'semantic') {
      const semanticPlan = parseSemanticPlan(args.queryPlan)
      const mapping = this.#config.mappings.resolve(semanticPlan.mappingVersion)
      if (mapping === undefined) {
        throw new ToolGatewayError(
          'INVALID_ARGUMENTS',
          `the pinned semantic mapping ${semanticPlan.mappingVersion.id}@${semanticPlan.mappingVersion.version} is not available`,
          { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
        )
      }
      const budget: CompilationBudget = {
        maxRows: limits.maxRows,
        maxBytes: limits.maxBytes,
        maxJoinFanout: this.#config.maxJoinFanout ?? DEFAULT_MAX_JOIN_FANOUT,
        ...(this.#config.estimatedBytesPerRow === undefined
          ? {}
          : { estimatedBytesPerRow: this.#config.estimatedBytesPerRow }),
      }
      try {
        const compiled = compileSemanticQuery(semanticPlan, mapping, { budget })
        const rendered = renderCompiledQuery(compiled)
        plan = {
          mode: 'direct',
          statementKind: 'select',
          sql: rendered.sql,
          parameters: [...rendered.parameters],
          referencedObjects: [...rendered.referencedObjects],
          readOnly: true,
        }
        warnings.push({
          code: 'SEMANTIC_MAPPING_VERSION',
          message: `compiled with mapping ${compiled.mappingRef.id}@${compiled.mappingRef.version} (${compiled.mappingRef.digest})`,
        })
      } catch (error) {
        throw this.#mapCompileError(error)
      }
    } else {
      throw new ToolGatewayError('INVALID_ARGUMENTS', 'data_query requires mode "direct" or "semantic"')
    }

    const executeRequest: StructuredQueryExecuteRequest = {
      plan,
      limits,
      snapshotRequest: { consistency },
      ...(cursor === undefined ? {} : { cursor }),
    }
    const response = await this.#config.query.execute(executeRequest, this.#config.ctx)
    return tableOutcome(response, warnings)
  }

  async #describe(
    args: Readonly<Record<string, unknown>>,
    request: ToolExecutionRequest,
  ): Promise<ToolExecutionOutcome> {
    const catalog = this.#config.catalog
    if (catalog === undefined) {
      throw new ToolGatewayError('HANDLER_FAILED', 'catalog describe is not configured for this run', {
        platformCode: 'CAPABILITY_NOT_CONFIGURED',
      })
    }
    const limits = this.#limits(request, typeof args.limit === 'number' ? args.limit : undefined)
    const cursor = typeof args.cursor === 'string' ? args.cursor : undefined
    const listRequest: CatalogListRequest = {
      scopeRef: scopeOf(this.#config.ctx),
      limit: limits.maxRows,
      ...(cursor === undefined ? {} : { cursor }),
    }
    const response = await catalog.listResources(listRequest, this.#config.ctx)
    const columns: QueryColumn[] = [
      { name: 'object_path', type: 'string' },
      { name: 'schema_revision', type: 'string' },
      { name: 'columns', type: 'string' },
    ]
    const rows = response.resources.map((resource) => [
      resource.objectRef.objectPath,
      resource.schemaRevision,
      resource.columns.map((column) => `${column.name}:${column.type}`).join(', '),
    ])
    const truncated = response.nextCursor !== null
    const coverage: ToolCoverage = {
      returned: rows.length,
      truncated,
      ...(response.nextCursor === null ? {} : { cursor: response.nextCursor }),
      completeness: truncated ? 'truncated' : 'complete',
    }
    const sourceRef = this.#config.catalogSourceRef ?? response.resources[0]?.objectRef.sourceRef
    if (sourceRef === undefined) {
      throw new ToolGatewayError(
        'HANDLER_FAILED',
        'the catalog returned no resource and no source reference is configured for the describe',
      )
    }
    const payload: DataQueryOutput = {
      resultKind: 'table',
      table: { columns, rows },
    }
    return {
      payload,
      status: truncated ? 'partial' : rows.length === 0 ? 'empty' : 'ok',
      coverage,
      sources: [
        {
          sourceRef,
          schemaVersion: response.schemaRevision,
          consistency: this.#config.consistency ?? 'repeatable_read',
        },
      ],
      usage: { rows: rows.length },
    }
  }

  #mapCompileError(error: unknown): ToolGatewayError {
    if (isSemanticMappingError(error)) {
      return new ToolGatewayError('INVALID_ARGUMENTS', error.message, {
        platformCode: MAPPING_ERROR_PLATFORM[error.code],
        ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }),
      })
    }
    const detail = error instanceof Error ? error.message : 'the semantic plan could not be compiled'
    return new ToolGatewayError('HANDLER_FAILED', detail, { platformCode: 'UNSUPPORTED_QUERY' })
  }
}
