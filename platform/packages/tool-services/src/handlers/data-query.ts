import type {
  CatalogListRequest,
  CatalogPort,
  ComputeOperationHandler,
  ConsistencyLevel,
  DataQueryOutput,
  DataMode,
  DirectSqlQueryPlan,
  FieldError,
  ImmutableArtifactWriter,
  OperationRegistry,
  OperationRef,
  QueryColumn,
  QueryLimits,
  ResourceRef,
  ScalarValue,
  ScopeRef,
  ScopedArtifactReader,
  SemanticAggregation,
  SemanticQueryPlan,
  SourceObjectRef,
  SourceRef,
  SourceSnapshot,
  StructuredQueryExecuteRequest,
  StructuredQueryPort,
  StructuredQueryExecuteResponse,
  StructuredQueryValidateResponse,
  TimeWindow,
  ToolContext,
  ToolCoverage,
  ToolWarning,
} from '@ontology/contracts'
import { findRegisteredOperation } from '@ontology/contracts'
import { cancellationError, raceWithAbort } from '../cancellation'
import {
  compileSemanticQuery,
  isSemanticMappingError,
  renderCompiledQuery,
  type CompilationBudget,
  type SemanticMappingErrorCode,
  type SemanticMappingRegistry,
} from '@ontology/semantic-engine'
import { ToolGatewayError } from '../errors'
import {
  assertNoComputeBypass,
  computeOutcomeOf,
  computeRequestOf,
  createScopedArtifactReader,
  resolveComputeHandler,
  runComputeWithBudget,
} from './compute'
import type {
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolHandler,
  ToolSchemaValidator,
  ToolSourceObservation,
} from '../types'

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
export interface DataQueryComputeConfig {
  /** The deployment's registered operations (ADR-11). */
  readonly registry: OperationRegistry
  /** The registered operation handlers, bound at the composition root, keyed by operation id. */
  readonly handlers: readonly ComputeOperationHandler[]
  /** Immutable, content-addressed result archive for a compute handler's own artifact. */
  readonly artifacts: ImmutableArtifactWriter
  /** Scoped reader for the approved immutable input refs; never a filesystem/DB credential. */
  readonly reader: ScopedArtifactReader
  /** Canonical schema validator, so the handler re-checks the registered input schema. */
  readonly validator: ToolSchemaValidator
}

export interface DataQueryHandlerConfig {
  readonly query: StructuredQueryPort
  readonly catalog?: CatalogPort
  readonly mappings: SemanticMappingRegistry
  /** Maximum join fanout a compiled plan may declare. */
  readonly maxJoinFanout?: number
  readonly estimatedBytesPerRow?: number
  readonly consistency?: ConsistencyLevel
  /** Source a catalog describe is attributed to when it returns no resources. */
  readonly catalogSourceRef?: SourceRef
  /** Deployment-declared mode for the backend snapshot read by this handler. */
  readonly dataMode?: DataMode
  /** Absent means `data_query.kind=compute` is explicitly not configured for this deployment. */
  readonly compute?: DataQueryComputeConfig
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

/**
 * Turn a `validate` rejection into a locatable gateway refusal. The adapter's
 * `rejectedReason` already carries the catalogue code and a message that names the
 * failing rule and the offending object/parameter (e.g. an unmapped relation, a
 * forbidden function or an unsupplied `$n`); that message is preserved and mirrored
 * into `fieldErrors` so a correction loop has a structured locator.
 */
function rejectedByPrecheck(validation: StructuredQueryValidateResponse): ToolGatewayError {
  const reason = validation.rejectedReason
  const message =
    reason?.message ?? 'the generated SQL did not pass the static pre-execution check'
  const fieldErrors: readonly FieldError[] =
    reason !== undefined && reason.fieldErrors !== undefined && reason.fieldErrors.length > 0
      ? reason.fieldErrors
      : [{ pointer: '/queryPlan/sql', reason: message }]
  return new ToolGatewayError('INVALID_ARGUMENTS', message, {
    platformCode: reason?.code ?? 'UNSUPPORTED_QUERY',
    fieldErrors,
  })
}

/**
 * Optional backend capability: an adapter that lists the in-flight target refs it can
 * cancel. The real PostgreSQL adapter exposes this (`activeTargets`) for its probe and
 * cancellation path; a backend without it is still cancellable from the caller's side
 * (the handler stops waiting), just without a confirmed remote interrupt.
 */
function activeTargetLister(port: StructuredQueryPort): (() => readonly string[]) | undefined {
  // `Reflect.get` walks the prototype chain, so a class method is found too.
  const list: unknown = Reflect.get(port, 'activeTargets')
  if (typeof list !== 'function') return undefined
  return () => {
    const value: unknown = Reflect.apply(list, port, [])
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : []
  }
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
  dataMode?: DataMode,
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
    ...(dataMode === undefined ? {} : { dataMode }),
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
    if (args.kind === 'compute') return this.#compute(args, request)
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'data_query requires kind describe, query or compute')
  }

  /**
   * `kind=compute` (ADR-11, C3/C4). The gateway has already resolved the operation against
   * the registered registry, the resolved profile and the operation schema. The handler
   * re-checks the registered schema, refuses any file/network/script bypass field, hands the
   * registered industry handler only a reader scoped to the approved input refs, and runs it
   * under the operation's declared CPU budget and the propagated deadline. The operation
   * handler itself is bound at the composition root, never selected by model input.
   */
  async #compute(
    args: Readonly<Record<string, unknown>>,
    request: ToolExecutionRequest,
  ): Promise<ToolExecutionOutcome> {
    const compute = this.#config.compute
    if (compute === undefined) {
      throw new ToolGatewayError(
        'HANDLER_FAILED',
        'compute operations are not configured for this deployment',
        { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
      )
    }
    const operationRefValue = args.operationRef
    const digest = args.inputSchemaDigest
    const parameters = args.parameters
    const inputRefs = args.inputRefs
    if (
      !isRecord(operationRefValue) ||
      typeof operationRefValue.id !== 'string' ||
      typeof operationRefValue.version !== 'string' ||
      typeof digest !== 'string' ||
      !isRecord(parameters) ||
      !Array.isArray(inputRefs)
    ) {
      throw new ToolGatewayError(
        'INVALID_ARGUMENTS',
        'a compute call requires operationRef{id,version}, inputSchemaDigest, inputRefs and typed parameters',
      )
    }
    const operationRef: OperationRef = { id: operationRefValue.id, version: operationRefValue.version }
    const operation = findRegisteredOperation(compute.registry, operationRef, digest)
    if (operation === undefined) {
      throw new ToolGatewayError(
        'UNKNOWN_COMPUTE_OPERATION',
        `operation ${operationRef.id}@${operationRef.version} is not registered with the declared input schema digest`,
        { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
      )
    }
    const validation = compute.validator.validateInline(operation.inputSchema, parameters)
    if (!validation.valid) {
      throw new ToolGatewayError(
        'INVALID_ARGUMENTS',
        'compute parameters do not match the registered operation schema',
        {
          fieldErrors: validation.issues.map((issue) => ({
            pointer: `/parameters${issue.pointer === '' ? '' : issue.pointer}`,
            reason: issue.reason,
          })),
        },
      )
    }
    const refs = inputRefs as ResourceRef[]
    if (args.dataMode === 'live') {
      throw new ToolGatewayError(
        'INVALID_ARGUMENTS',
        'the compute path is simulation-only; a model-supplied live data mode is refused',
        { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
      )
    }
    assertNoComputeBypass(parameters, refs)
    const handler = resolveComputeHandler(compute.handlers, operationRef)
    if (handler === undefined) {
      throw new ToolGatewayError(
        'HANDLER_NOT_REGISTERED',
        `no handler is registered for the enabled operation ${operationRef.id}@${operationRef.version}`,
        { platformCode: 'CAPABILITY_NOT_CONFIGURED' },
      )
    }
    const readInput = createScopedArtifactReader(compute.reader, refs)
    const result = await runComputeWithBudget(
      ({ signal }) =>
        handler.execute(
          computeRequestOf({
            operationRef,
            parameters,
            inputRefs: refs,
            readInput,
            artifacts: compute.artifacts,
            limits: operation.limits,
            deadline: request.deadline,
            ctx: request.ctx,
            signal,
          }),
        ),
      operation.limits.maxDurationMs,
      request.deadline,
      request.signal,
    )
    return computeOutcomeOf(result)
  }

  #limits(request: ToolExecutionRequest, requested: number | undefined): QueryLimits {
    const ceiling = Math.min(request.resultLimits.maxRows, request.ctx.allowedResources.maxRows)
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

    // Static pre-execution check (LOCAL-077). Every generated plan — direct or compiled
    // from a semantic plan — must pass the adapter's AST/allowlist/parameter validation
    // before a single row is read. The handler no longer skips `validate`.
    const precheck = await this.#precheckQuery(plan, limits, request)
    warnings.push(...precheck.warnings)

    const executeRequest: StructuredQueryExecuteRequest = {
      plan: precheck.plan,
      limits,
      snapshotRequest: { consistency },
      ...(cursor === undefined ? {} : { cursor }),
    }
    const response = await this.#executeQuery(executeRequest, request)
    return tableOutcome(response, warnings, this.#config.dataMode)
  }

  /**
   * The static dry-run stage (C3/C4, LOCAL-077).
   *
   * The project's SQL subset is a single read-only SELECT / controlled CTE, so the
   * textbook `EXPLAIN`-based dry-run is deliberately not used: it would conflict with
   * the read-only subset and the DuckDB sandbox forbids `DESCRIBE`/`SHOW`. The dry-run
   * is therefore a static/AST pre-check through the same `StructuredQueryPort.validate`
   * the backend already exposes: it parses the statement, resolves every relation
   * through the confirmed mapping, checks the function/object allowlists and binds the
   * declared parameters. It opens no connection and reads no data.
   *
   * The normalized plan is returned so execution uses the exact plan that was checked,
   * on the same read-only role and parameter-binding path (`validate` and `execute` are
   * methods of the same injected port and receive the same context).
   *
   * A rejection is data (`valid: false` + `rejectedReason`), not an exception; it is
   * raised here as a locatable gateway refusal that names the failing rule, object or
   * parameter so the correction loop can act on it.
   */
  async #precheckQuery(
    plan: DirectSqlQueryPlan,
    limits: QueryLimits,
    request: ToolExecutionRequest,
  ): Promise<{ readonly plan: DirectSqlQueryPlan; readonly warnings: ToolWarning[] }> {
    const validation = await this.#config.query.validate({ plan, limits }, request.ctx)
    if (!validation.valid) {
      throw rejectedByPrecheck(validation)
    }
    const normalized = validation.normalizedPlan
    const checkedPlan = normalized !== undefined && normalized.mode === 'direct' ? normalized : plan
    const warnings: ToolWarning[] = validation.warnings.map((message) => ({
      code: 'QUERY_PRECHECK_WARNING',
      message,
    }))
    return { plan: checkedPlan, warnings }
  }

  /**
   * Run the plan under the propagated signal. Cancelling the run aborts the signal, so
   * the handler asks the backend to interrupt the real query and stops waiting: a
   * cancelled read is never returned as a success. The original adapter error wins if it
   * arrives first, keeping its own classification.
   */
  async #executeQuery(
    executeRequest: StructuredQueryExecuteRequest,
    request: ToolExecutionRequest,
  ): Promise<StructuredQueryExecuteResponse> {
    const { signal } = request
    if (signal.aborted) throw cancellationError('the data query was cancelled before it started')
    const listTargets = activeTargetLister(this.#config.query)
    const before = listTargets === undefined ? undefined : new Set(listTargets())
    const onAbort = (): void => {
      if (listTargets === undefined) return
      for (const targetRef of listTargets()) {
        if (before?.has(targetRef) === true) continue
        void this.#config.query
          .cancel({ targetRef, reason: 'the run was cancelled' }, request.ctx)
          .catch(() => undefined)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await raceWithAbort(
        this.#config.query.execute(executeRequest, request.ctx),
        signal,
        'the data query was cancelled',
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
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
      scopeRef: scopeOf(request.ctx),
      limit: limits.maxRows,
      ...(cursor === undefined ? {} : { cursor }),
    }
    const response = await catalog.listResources(listRequest, request.ctx)
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
