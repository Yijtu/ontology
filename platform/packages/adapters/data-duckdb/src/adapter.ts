import {
  isToolContext,
  type CancelRequest,
  type CancelResponse,
  type CatalogDescribeRequest,
  type CatalogDescribeResponse,
  type CatalogListRequest,
  type CatalogListResponse,
  type CatalogResource,
  type ColumnType,
  type DirectSqlQueryPlan,
  type OpaqueCursor,
  type PlatformError,
  type QueryColumn,
  type QueryLimits,
  type QueryPlan,
  type ScalarValue,
  type ScopeRef,
  type SourceObjectRef,
  type SourceRef,
  type SourceSnapshot,
  type StructuredQueryExecuteRequest,
  type StructuredQueryExecuteResponse,
  type StructuredQueryValidateRequest,
  type StructuredQueryValidateResponse,
  type ToolContext,
  type ToolCoverage,
} from '@ontology/contracts'
import { DuckDbAdapterError } from './errors'
import type { DuckDbAdapterErrorCode } from './errors'
import { DuckDbEngine } from './engine'
import type { SessionExecution } from './engine'
import type { DuckDbAdapterConfig, DuckDbAdapterLimits, RegisteredRelation } from './config'
import { DEFAULT_DUCKDB_LIMITS, RelationRegistry } from './config'
import {
  canonicalJson,
  normaliseColumnType,
  normaliseValue,
  resultDigestOf,
} from './normalise'
import { validateSql } from './validator'
import type { SandboxValidation } from './validator'

const DEFAULT_PAGE_LIMIT = 50

const DEFAULT_PHYSICAL_TYPES: Readonly<Record<ColumnType, string>> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  decimal: 'DECIMAL(38,10)',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP',
  json: 'JSON',
  binary: 'BLOB',
}

interface PreparedPlan {
  readonly plan: DirectSqlQueryPlan
  readonly cleanedSql: string
  readonly validation: SandboxValidation
  readonly referenced: readonly RegisteredRelation[]
}

interface ExecutePage {
  readonly execution: SessionExecution
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly unknown[][]
  readonly truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function quoteRelation(relation: string): string {
  return relation
    .split('.')
    .map((part) => quoteIdentifier(part))
    .join('.')
}

function encodeCursor(offset: number): OpaqueCursor {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: OpaqueCursor): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (error) {
    throw new DuckDbAdapterError('INVALID_ARGUMENT', 'the pagination cursor is malformed', {
      cause: error,
    })
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.offset !== 'number' ||
    !Number.isInteger(parsed.offset) ||
    parsed.offset < 0
  ) {
    throw new DuckDbAdapterError('INVALID_ARGUMENT', 'the pagination cursor is malformed')
  }
  return parsed.offset
}

function sameSourceRef(left: SourceRef, right: SourceRef): boolean {
  return left.namespace === right.namespace && left.sourceId === right.sourceId
}

function sameObjectRef(left: SourceObjectRef, right: SourceObjectRef): boolean {
  return sameSourceRef(left.sourceRef, right.sourceRef) && left.objectPath === right.objectPath
}

function platformError(code: PlatformError['code'], message: string): PlatformError {
  return { code, message, retryable: false }
}

/**
 * Adapter codes are finer-grained than the platform catalogue (there is no
 * `SCOPE_MISMATCH`/`CANCELLED` platform code), so they are folded onto the closest
 * catalogue entry when a `PlatformError` is needed (the `validate` rejection path).
 */
const PLATFORM_CODE: Readonly<Record<DuckDbAdapterErrorCode, PlatformError['code']>> = {
  UNSUPPORTED_QUERY: 'UNSUPPORTED_QUERY',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  FORBIDDEN: 'FORBIDDEN',
  SCOPE_MISMATCH: 'FORBIDDEN',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  SNAPSHOT_UNAVAILABLE: 'SNAPSHOT_UNAVAILABLE',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  CANCELLED: 'DEADLINE_EXCEEDED',
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
}

/**
 * The DuckDB data adapter: a real, sandboxed `StructuredQueryPort` and `CatalogPort`
 * over a materialised read-only snapshot (SPEC C3/C3.1; US-008/009/020/024).
 *
 * `execute` accepts only the declared read-only SQL subset. Dialect-specific behaviour
 * (type mapping, value normalisation, snapshot consistency) is confined here; callers
 * see canonical columns, canonical values and a `SourceSnapshot`. Semantic plans are not
 * compiled here (that is LOCAL-026), so they are answered with `UNSUPPORTED_QUERY`.
 */
export class DuckDbQueryAdapter {
  readonly #config: DuckDbAdapterConfig
  readonly #registry: RelationRegistry
  readonly #engine: DuckDbEngine
  readonly #allowedTableFunctions: ReadonlySet<string>
  readonly #limits: DuckDbAdapterLimits
  readonly #now: () => string
  readonly #inFlight = new Map<string, Set<{ interrupt(): void; close(): void }>>()
  readonly #cancelled = new Set<string>()
  readonly #deadline = new Set<string>()
  #started = false

  constructor(config: DuckDbAdapterConfig) {
    this.#config = config
    this.#registry = new RelationRegistry(config.relations)
    this.#allowedTableFunctions = new Set(
      (config.allowedTableFunctions ?? []).map((name) => name.toLowerCase()),
    )
    this.#limits = { ...DEFAULT_DUCKDB_LIMITS, ...config.defaultLimits }
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#engine = new DuckDbEngine(
      config.instancePath === undefined ? {} : { instancePath: config.instancePath },
    )
  }

  async start(): Promise<void> {
    if (this.#started) return
    await this.#engine.start()
    this.#started = true
  }

  close(): void {
    for (const sessions of this.#inFlight.values()) {
      for (const session of sessions) session.close()
    }
    this.#inFlight.clear()
    this.#engine.close()
    this.#started = false
  }

  async engineVersion(): Promise<string> {
    await this.start()
    return this.#engine.version()
  }

  /**
   * Trusted snapshot import. The composition root (or a test) loads the registered
   * relation's rows; the model can never reach this path. Only declared relations are
   * accepted, and values are bound as parameters, never interpolated.
   */
  async materialiseRelation(relationName: string, rows: readonly (readonly ScalarValue[])[]): Promise<void> {
    await this.start()
    const relation = this.#registry.resolve(relationName)
    if (relation === undefined) {
      throw new DuckDbAdapterError(
        'INVALID_ARGUMENT',
        `"${relationName}" is not a registered relation`,
      )
    }
    if (relation.columns.length === 0) {
      throw new DuckDbAdapterError('INVALID_ARGUMENT', `relation "${relationName}" has no columns`)
    }
    for (const row of rows) {
      if (row.length !== relation.columns.length) {
        throw new DuckDbAdapterError(
          'INVALID_ARGUMENT',
          `relation "${relationName}" expects ${String(relation.columns.length)} columns per row`,
        )
      }
    }
    const target = quoteRelation(relation.relation)
    const definitions = relation.columns
      .map((column) => `${quoteIdentifier(column.name)} ${this.#physicalType(relation, column)}`)
      .join(', ')
    await this.#engine.runTrusted(`DROP TABLE IF EXISTS ${target}`)
    await this.#engine.runTrusted(`CREATE TABLE ${target} (${definitions})`)
    if (rows.length === 0) return
    const placeholders = `(${relation.columns.map(() => '?').join(', ')})`
    const batchSize = 200
    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize)
      const valuesSql = batch.map(() => placeholders).join(', ')
      const parameters = batch.flatMap((row) => [...row])
      await this.#engine.runTrusted(
        `INSERT INTO ${target} VALUES ${valuesSql}`,
        parameters,
      )
    }
  }

  async describe(
    request: CatalogDescribeRequest,
    ctx: ToolContext,
  ): Promise<CatalogDescribeResponse> {
    this.#assertTrustedScope(request.scopeRef, ctx)
    const wanted = request.resourceRefs
    const resources = this.#registry
      .list()
      .filter((relation) =>
        wanted === undefined
          ? true
          : wanted.some((ref) => sameObjectRef(ref, relation.objectRef)),
      )
      .map((relation) => this.#catalogResource(relation))
    return { resources, schemaRevision: this.#config.catalogSchemaRevision }
  }

  async listResources(
    request: CatalogListRequest,
    ctx: ToolContext,
  ): Promise<CatalogListResponse> {
    this.#assertTrustedScope(request.scopeRef, ctx)
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new DuckDbAdapterError('INVALID_ARGUMENT', 'limit must be a positive integer')
    }
    const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor)
    const all = this.#registry
      .list()
      .sort((left, right) => (left.relation < right.relation ? -1 : left.relation > right.relation ? 1 : 0))
    const page = all.slice(offset, offset + limit)
    const nextCursor = offset + limit < all.length ? encodeCursor(offset + limit) : null
    return {
      resources: page.map((relation) => this.#catalogResource(relation)),
      schemaRevision: this.#config.catalogSchemaRevision,
      nextCursor,
    }
  }

  async validate(
    request: StructuredQueryValidateRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryValidateResponse> {
    try {
      const prepared = this.#prepare(request.plan, ctx)
      return {
        valid: true,
        normalizedPlan: { ...prepared.plan, sql: prepared.cleanedSql },
        warnings: [],
      }
    } catch (error) {
      const failure =
        error instanceof DuckDbAdapterError
          ? error
          : new DuckDbAdapterError('UNSUPPORTED_QUERY', 'the plan could not be validated', {
              cause: error,
            })
      return {
        valid: false,
        warnings: [],
        rejectedReason: platformError(PLATFORM_CODE[failure.code], failure.message),
      }
    }
  }

  async execute(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryExecuteResponse> {
    const prepared = this.#prepare(request.plan, ctx)
    const limits = this.#effectiveLimits(request.limits, ctx)
    const canPage = !prepared.validation.facts.hasExplicitLimit &&
      !prepared.validation.facts.hasExplicitOffset
    let offset = 0
    let sql = prepared.cleanedSql
    if (request.cursor !== undefined) {
      if (!canPage) {
        throw new DuckDbAdapterError(
          'UNSUPPORTED_QUERY',
          'cursor pagination is not available for a query that declares its own LIMIT/OFFSET',
        )
      }
      offset = decodeCursor(request.cursor)
      sql = `${prepared.cleanedSql} OFFSET ${String(offset)}`
    }

    const runId = ctx.runId
    const session = await this.#engine.createSession()
    this.#register(runId, session)
    const deadlineMs = this.#remainingMs(ctx, limits)
    if (deadlineMs <= 0) {
      this.#unregister(runId, session)
      session.close()
      throw new DuckDbAdapterError('DEADLINE_EXCEEDED', 'the run deadline has already passed')
    }
    const timer = setTimeout(() => {
      this.#deadline.add(runId)
      session.interrupt()
    }, deadlineMs)

    let page: ExecutePage
    try {
      const execution = await session.executeReadOnly(
        sql,
        prepared.plan.parameters,
        limits.maxRows,
      )
      page = this.#buildPage(execution, limits)
    } catch (error) {
      throw this.#classifyExecutionError(error, runId)
    } finally {
      clearTimeout(timer)
      this.#unregister(runId, session)
      session.close()
    }

    const truncated = page.truncated
    const nextCursor = truncated && canPage ? encodeCursor(offset + page.rows.length) : null
    const coverage: ToolCoverage = {
      returned: page.rows.length,
      truncated,
      completeness: truncated ? 'truncated' : 'complete',
      ...(nextCursor === null ? {} : { cursor: nextCursor }),
    }
    const snapshot = this.#snapshot(prepared, request, page)

    return {
      snapshot,
      columns: [...page.columns],
      rows: [...page.rows],
      nextCursor,
      coverage,
    }
  }

  /**
   * Cancellation is best-effort but real: it interrupts the DuckDB connection running the
   * query for this run. The engine is in-process, so the interrupted state is known and
   * the failure is classified `CANCELLED` (not `usage_unknown`); the gateway owns the
   * reservation settlement that follows.
   */
  async cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse> {
    if (!isToolContext(ctx)) {
      throw new DuckDbAdapterError('UNAUTHENTICATED', 'a trusted tool context is required')
    }
    const sessions = this.#inFlight.get(ctx.runId)
    const acceptedAt = this.#now()
    if (sessions === undefined || sessions.size === 0) {
      return { targetRef: request.targetRef, state: 'already_terminal', acceptedAt }
    }
    this.#cancelled.add(ctx.runId)
    for (const session of sessions) session.interrupt()
    return { targetRef: request.targetRef, state: 'cancelling', acceptedAt }
  }

  #prepare(plan: QueryPlan, ctx: ToolContext): PreparedPlan {
    this.#assertTrustedContext(ctx)
    if (plan.mode !== 'direct') {
      throw new DuckDbAdapterError(
        'UNSUPPORTED_QUERY',
        'semantic plans are compiled by the mapping resolver, not by this adapter',
      )
    }
    if (plan.statementKind !== 'select' || plan.readOnly !== true) {
      throw new DuckDbAdapterError('UNSUPPORTED_QUERY', 'only read-only SELECT plans are accepted')
    }
    const validation = validateSql({
      sql: plan.sql,
      registry: this.#registry,
      allowedTableFunctions: this.#allowedTableFunctions,
    })
    if (validation.facts.parameters !== plan.parameters.length) {
      throw new DuckDbAdapterError(
        'INVALID_ARGUMENT',
        `the plan binds ${String(plan.parameters.length)} parameters but the SQL has ${String(validation.facts.parameters)} placeholders`,
      )
    }
    const allowed = ctx.allowedResources.sourceRefs
    for (const relation of validation.referencedRelations) {
      if (!allowed.some((ref) => sameSourceRef(ref, relation.objectRef.sourceRef))) {
        throw new DuckDbAdapterError(
          'FORBIDDEN',
          `the source "${relation.objectRef.sourceRef.sourceId}" is not in the trusted allowlist`,
        )
      }
      if (!plan.referencedObjects.some((ref) => sameObjectRef(ref, relation.objectRef))) {
        throw new DuckDbAdapterError(
          'UNSUPPORTED_QUERY',
          `the SQL reads "${relation.objectRef.objectPath}" but the plan does not declare it`,
        )
      }
    }
    if (validation.referencedRelations.length === 0) {
      throw new DuckDbAdapterError(
        'UNSUPPORTED_QUERY',
        'a query must read at least one registered object',
      )
    }
    const cleanedSql = plan.sql.slice(0, validation.parsed.endOffset).trim()
    return { plan, cleanedSql, validation, referenced: validation.referencedRelations }
  }

  #buildPage(execution: SessionExecution, limits: DuckDbAdapterLimits): ExecutePage {
    const columns: QueryColumn[] = execution.columnNames.map((name, index) => ({
      name,
      type: normaliseColumnType(execution.columnTypeIds[index] ?? 0),
    }))
    const rows: unknown[][] = []
    let bytes = 0
    let byteTruncated = false
    for (let index = 0; index < execution.rawRows.length; index += 1) {
      const raw = execution.rawRows[index] ?? []
      const js = execution.jsRows[index] ?? []
      const row = columns.map((_column, columnIndex) =>
        normaliseValue(execution.columnTypeIds[columnIndex] ?? 0, raw[columnIndex], js[columnIndex]),
      )
      const rowBytes = Buffer.byteLength(canonicalJson(row), 'utf8')
      if (bytes + rowBytes > limits.maxBytes) {
        byteTruncated = true
        break
      }
      bytes += rowBytes
      rows.push(row)
    }
    return {
      execution,
      columns,
      rows,
      truncated: execution.truncated || byteTruncated,
    }
  }

  #snapshot(
    prepared: PreparedPlan,
    request: StructuredQueryExecuteRequest,
    page: ExecutePage,
  ): SourceSnapshot {
    const primary = prepared.referenced[0]
    const sourceRef: SourceRef = primary?.objectRef.sourceRef ?? {
      namespace: 'duckdb',
      sourceId: 'unregistered',
    }
    const consistency = this.#config.consistency ?? 'repeatable_read'
    return {
      sourceRef,
      schemaVersion: primary?.schemaRevision ?? this.#config.catalogSchemaRevision,
      readAt: this.#now(),
      consistency,
      resultDigest: resultDigestOf({ columns: page.columns, rows: page.rows }),
      ...(request.snapshotRequest.asOf === undefined ? {} : { asOf: request.snapshotRequest.asOf }),
    }
  }

  #catalogResource(relation: RegisteredRelation): CatalogResource {
    return {
      objectRef: relation.objectRef,
      schemaRevision: relation.schemaRevision,
      columns: [...relation.columns],
    }
  }

  #physicalType(relation: RegisteredRelation, column: QueryColumn): string {
    return relation.physicalTypes?.[column.name] ?? DEFAULT_PHYSICAL_TYPES[column.type]
  }

  #effectiveLimits(requested: QueryLimits, ctx: ToolContext): DuckDbAdapterLimits {
    const maxRows = Math.min(requested.maxRows, this.#limits.maxRows, ctx.allowedResources.maxRows)
    const maxBytes = Math.min(requested.maxBytes, this.#limits.maxBytes)
    const maxDurationMs = Math.min(requested.maxDurationMs, this.#limits.maxDurationMs)
    if (maxRows <= 0 || maxBytes <= 0 || maxDurationMs <= 0) {
      throw new DuckDbAdapterError('INVALID_ARGUMENT', 'query limits must be positive')
    }
    return { maxRows, maxBytes, maxDurationMs }
  }

  #remainingMs(ctx: ToolContext, limits: DuckDbAdapterLimits): number {
    const runDeadline = Date.parse(ctx.deadline)
    const toolDeadline = Date.now() + limits.maxDurationMs
    return Math.min(toolDeadline, runDeadline) - Date.now()
  }

  #classifyExecutionError(error: unknown, runId: string): DuckDbAdapterError {
    if (error instanceof DuckDbAdapterError) return error
    const message = error instanceof Error ? error.message : 'the DuckDB query failed'
    const interrupted = /INTERRUPT|Interrupted/i.test(message)
    if (interrupted) {
      if (this.#cancelled.has(runId)) {
        return new DuckDbAdapterError('CANCELLED', 'the query was cancelled', { cause: error })
      }
      if (this.#deadline.has(runId)) {
        return new DuckDbAdapterError('DEADLINE_EXCEEDED', 'the query exceeded its deadline', {
          cause: error,
        })
      }
      return new DuckDbAdapterError('CANCELLED', 'the query was interrupted', { cause: error })
    }
    if (/read-only mode/i.test(message)) {
      return new DuckDbAdapterError(
        'UNSUPPORTED_QUERY',
        'the read-only transaction rejected a write',
        { cause: error },
      )
    }
    if (/Permission Error|Cannot access|file system operations are disabled/i.test(message)) {
      return new DuckDbAdapterError(
        'UNSUPPORTED_QUERY',
        'the engine refused a forbidden file/extension operation',
        { cause: error },
      )
    }
    if (/Parser Error|Binder Error|Catalog Error|Conversion Error|syntax error/i.test(message)) {
      return new DuckDbAdapterError('INVALID_ARGUMENT', message, { cause: error })
    }
    return new DuckDbAdapterError('INTERNAL_ERROR', message, { cause: error })
  }

  #register(runId: string, session: { interrupt(): void; close(): void }): void {
    const existing = this.#inFlight.get(runId)
    if (existing === undefined) {
      this.#inFlight.set(runId, new Set([session]))
      return
    }
    existing.add(session)
  }

  #unregister(runId: string, session: { interrupt(): void; close(): void }): void {
    const existing = this.#inFlight.get(runId)
    if (existing === undefined) return
    existing.delete(session)
    if (existing.size === 0) {
      this.#inFlight.delete(runId)
      this.#cancelled.delete(runId)
      this.#deadline.delete(runId)
    }
  }

  #assertTrustedContext(ctx: ToolContext): void {
    if (!isToolContext(ctx)) {
      throw new DuckDbAdapterError('UNAUTHENTICATED', 'a host-minted trusted tool context is required')
    }
    if (ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
      throw new DuckDbAdapterError('SCOPE_MISMATCH', 'the trusted context carries inconsistent scope')
    }
  }

  #assertTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
    this.#assertTrustedContext(ctx)
    if (
      scopeRef.tenantId !== ctx.principal.tenantId ||
      scopeRef.spaceId !== ctx.allowedResources.spaceId
    ) {
      throw new DuckDbAdapterError(
        'SCOPE_MISMATCH',
        'the request scope does not match the trusted principal scope',
      )
    }
  }
}
