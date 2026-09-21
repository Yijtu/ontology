import { setTimeout as delay } from 'node:timers/promises'
import { sha256DigestOf } from '@ontology/core'
import { isToolContext } from '@ontology/contracts'
import type {
  CancelRequest,
  CancelResponse,
  CapabilityLimits,
  CatalogDescribeRequest,
  CatalogDescribeResponse,
  CatalogListRequest,
  CatalogListResponse,
  CatalogPort,
  CatalogResource,
  ConsistencyLevel,
  ErrorCode,
  ImmutableArtifactWriter,
  QueryColumn,
  ResourceRef,
  ScopeRef,
  SourceObjectRef,
  SourceProbeAdapter,
  SourceProbeObservation,
  SourceProbeRequest,
  SourceRef,
  SourceSnapshot,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryPort,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  ToolContext,
  ToolCoverage,
  VersionRef,
} from '@ontology/contracts'
import { byteLengthOf, columnTypeFromOid, normalizeCell, stableJson } from './canonical'
import { BusinessPostgresDatabase } from './database'
import type { ReadOnlySession } from './database'
import { PostgresQueryError } from './errors'
import {
  catalogResourceOf,
  catalogRevisionOf,
  columnTypeOf,
  queryColumnOf,
  relationKey,
  sourceRefAuthorized,
  sourceRefsEqual,
  SUPPORTED_DATA_TYPES,
} from './mapping'
import type { BusinessObjectMapping, MappedColumn } from './mapping'
import { validateReadOnlySql } from './sql-validator'

export const DATA_POSTGRES_ADAPTER_REF: VersionRef = {
  id: '@ontology/adapter-data-postgres',
  version: '1.0.0',
  digest: sha256DigestOf('@ontology/adapter-data-postgres@1.0.0'),
}

const DEFAULT_LIMITS: CapabilityLimits = {
  maxRows: 1000,
  maxBytes: 1_048_576,
  maxDurationMs: 60_000,
}

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 1000
const CANCEL_CONFIRM_TIMEOUT_MS = 5_000
const PROBE_CANCEL_TIMEOUT_MS = 8_000
const PROBE_REGISTER_TIMEOUT_MS = 2_000
const PROBE_SLEEP_SECONDS = 5

interface InFlightQuery {
  readonly targetRef: string
  backendPid: number | undefined
  cancelRequested: boolean
  cancelConfirmed: boolean
  settled: boolean
  readonly settledPromise: Promise<void>
  readonly resolveSettled: () => void
}

function createInFlight(targetRef: string): InFlightQuery {
  let resolveSettled: () => void = () => undefined
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  return {
    targetRef,
    backendPid: undefined,
    cancelRequested: false,
    cancelConfirmed: false,
    settled: false,
    settledPromise,
    resolveSettled,
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const offset = (parsed as { o?: unknown }).o
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset
    }
  } catch {
    return 0
  }
  return 0
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

function singleSourceOf(objects: readonly SourceObjectRef[]): SourceRef | undefined {
  const first = objects[0]
  if (first === undefined) return undefined
  const multiple = objects.some((objectRef) => !sourceRefsEqual(objectRef.sourceRef, first.sourceRef))
  return multiple ? undefined : first.sourceRef
}

export interface PostgresQueryAdapterConfig {
  readonly database: BusinessPostgresDatabase
  /** Confirmed mappings. The only source of physical schema/relation names. */
  readonly mappings: readonly BusinessObjectMapping[]
  /** Fallback source ref for a statement that references no table. */
  readonly sourceRef: SourceRef
  readonly adapterRef?: VersionRef
  readonly limits?: Partial<CapabilityLimits>
  /** Needed only to satisfy an `immutable` snapshot request (archive-on-demand). */
  readonly archiver?: ImmutableArtifactWriter
  readonly now?: () => string
  readonly newId?: () => string
}

interface ExecuteOutcome {
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly unknown[][]
  readonly coverage: ToolCoverage
  readonly nextCursor: string | null
  readonly readAt: string
}

/**
 * Real `StructuredQueryPort`/`CatalogPort`/`SourceProbeAdapter` against PostgreSQL.
 *
 * The adapter connects to a *business* database with an independent read-only role. It
 * accepts only the declared read-only SQL subset (a single SELECT / controlled CTE),
 * enforced by a real AST, an accessible-object allowlist, parameter binding and a
 * read-only transaction. Every result carries an honest `SourceSnapshot`; a
 * `repeatable_read` snapshot is scoped to the query transaction and is never advertised
 * as a permanently re-readable version.
 */
export class PostgresQueryAdapter implements StructuredQueryPort, CatalogPort, SourceProbeAdapter {
  readonly #db: BusinessPostgresDatabase
  readonly #mappings: readonly BusinessObjectMapping[]
  readonly #sourceRef: SourceRef
  readonly #adapterRef: VersionRef
  readonly #limits: CapabilityLimits
  readonly #archiver: ImmutableArtifactWriter | undefined
  readonly #now: () => string
  readonly #newId: () => string
  readonly #inFlight = new Map<string, InFlightQuery>()

  constructor(config: PostgresQueryAdapterConfig) {
    this.#db = config.database
    this.#mappings = config.mappings
    this.#sourceRef = config.sourceRef
    this.#adapterRef = config.adapterRef ?? DATA_POSTGRES_ADAPTER_REF
    this.#limits = {
      maxRows: config.limits?.maxRows ?? DEFAULT_LIMITS.maxRows,
      maxBytes: config.limits?.maxBytes ?? DEFAULT_LIMITS.maxBytes,
      maxDurationMs: config.limits?.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs,
      ...(config.limits?.maxConcurrency === undefined
        ? {}
        : { maxConcurrency: config.limits.maxConcurrency }),
    }
    this.#archiver = config.archiver
    this.#now = config.now ?? (() => new Date().toISOString())
    this.#newId = config.newId ?? (() => globalThis.crypto.randomUUID())
  }

  get adapterRef(): VersionRef {
    return this.#adapterRef
  }

  /** Test/diagnostic view of the executions that can still be cancelled. */
  activeTargets(): readonly string[] {
    return [...this.#inFlight.keys()]
  }

  async validate(
    request: StructuredQueryValidateRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryValidateResponse> {
    assertTrustedContext(ctx)
    const plan = request.plan
    if (plan.mode !== 'direct') {
      return rejected(ctx, 'UNSUPPORTED_QUERY', 'only direct SQL plans are validated by this adapter')
    }
    const validation = validateReadOnlySql({
      sql: plan.sql,
      parameters: plan.parameters,
      allowlist: this.#mappings,
      declaredObjects: plan.referencedObjects,
      authorizedSourceRefs: ctx.allowedResources.sourceRefs,
    })
    if (!validation.valid) {
      return {
        valid: false,
        warnings: [...validation.warnings],
        rejectedReason: new PostgresQueryError(validation.code, validation.reason).toPlatformError(
          ctx.traceId,
        ),
      }
    }
    if (singleSourceOf(validation.referencedObjects) === undefined && validation.referencedObjects.length > 1) {
      return rejected(
        ctx,
        'UNSUPPORTED_QUERY',
        'a query spanning multiple sources requires an explicit relationship, which is not declared',
      )
    }
    return {
      valid: true,
      normalizedPlan: { ...plan, referencedObjects: [...validation.referencedObjects] },
      warnings: [...validation.warnings],
    }
  }

  async execute(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryExecuteResponse> {
    assertTrustedContext(ctx)
    const plan = request.plan
    if (plan.mode !== 'direct') {
      throw new PostgresQueryError('UNSUPPORTED_QUERY', 'only direct SQL plans are executed by this adapter')
    }
    const validation = validateReadOnlySql({
      sql: plan.sql,
      parameters: plan.parameters,
      allowlist: this.#mappings,
      declaredObjects: plan.referencedObjects,
      authorizedSourceRefs: ctx.allowedResources.sourceRefs,
    })
    if (!validation.valid) {
      throw new PostgresQueryError(validation.code, validation.reason)
    }
    const sourceRef = singleSourceOf(validation.referencedObjects)
    if (sourceRef === undefined && validation.referencedObjects.length > 1) {
      throw new PostgresQueryError(
        'UNSUPPORTED_QUERY',
        'a query spanning multiple sources requires an explicit relationship, which is not declared',
      )
    }

    const effectiveMaxRows = Math.max(1, Math.min(request.limits.maxRows, ctx.allowedResources.maxRows))
    const statementTimeoutMs = this.#effectiveTimeoutMs(request.limits.maxDurationMs, ctx)
    const offset = decodeCursor(request.cursor)
    const target = createInFlight(this.#newId())

    let raw: {
      readonly rows: unknown[][]
      readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[]
      readonly readAt: string
    }
    try {
      raw = await this.#db.withReadOnlySnapshot({
        statementTimeoutMs,
        operation: async (session) => this.#runTracked(session, target, validation.executableSql, plan.parameters, effectiveMaxRows, offset),
      })
    } catch (error) {
      throw this.#classifyQueryFailure(error, target)
    }

    const outcome = this.#boundResult(raw, request.limits.maxBytes, effectiveMaxRows, offset)
    const snapshot = await this.#snapshot(request, ctx, outcome, sourceRef ?? this.#sourceRef)
    return {
      snapshot,
      columns: [...outcome.columns],
      rows: [...outcome.rows],
      nextCursor: outcome.nextCursor,
      coverage: outcome.coverage,
    }
  }

  async cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse> {
    assertTrustedContext(ctx)
    const acceptedAt = this.#now()
    const target = this.#inFlight.get(request.targetRef)
    if (target === undefined) {
      return { targetRef: request.targetRef, state: 'already_terminal', acceptedAt }
    }
    target.cancelRequested = true
    let confirmed = false
    if (target.backendPid !== undefined) {
      confirmed = await this.#db.cancelBackend(target.backendPid).catch(() => false)
    }
    target.cancelConfirmed = confirmed
    if (!confirmed) {
      return { targetRef: request.targetRef, state: 'cancelling', acceptedAt }
    }
    const settled = await this.#waitFor(target.settledPromise, CANCEL_CONFIRM_TIMEOUT_MS)
    return {
      targetRef: request.targetRef,
      state: settled ? 'cancelled' : 'cancelling',
      acceptedAt,
    }
  }

  async describe(request: CatalogDescribeRequest, ctx: ToolContext): Promise<CatalogDescribeResponse> {
    assertTrustedContext(ctx)
    assertScope(request.scopeRef, ctx)
    const all = await this.#discoverResources(ctx)
    const schemaRevision = catalogRevisionOf(all)
    const requested = request.resourceRefs
    const resources =
      requested === undefined
        ? all
        : all.filter((resource) =>
            requested.some(
              (ref) =>
                ref.objectPath === resource.objectRef.objectPath &&
                sourceRefsEqual(ref.sourceRef, resource.objectRef.sourceRef),
            ),
          )
    return {
      resources: resources.map((resource) => ({ ...resource, schemaRevision })),
      schemaRevision,
    }
  }

  async listResources(request: CatalogListRequest, ctx: ToolContext): Promise<CatalogListResponse> {
    assertTrustedContext(ctx)
    assertScope(request.scopeRef, ctx)
    const all = await this.#discoverResources(ctx)
    const schemaRevision = catalogRevisionOf(all)
    const offset = decodeCursor(request.cursor)
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    const page = all.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    return {
      resources: page.map((resource) => ({ ...resource, schemaRevision })),
      schemaRevision,
      nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
    }
  }

  /**
   * Bounded, real probe (C3/C6): it discovers the catalog, fetches a page, attempts a real
   * cancel and reports the snapshot consistency it actually observed.
   */
  async probe(request: SourceProbeRequest, ctx: ToolContext): Promise<SourceProbeObservation> {
    assertTrustedContext(ctx)
    void request
    const resources = await this.#discoverResources(ctx)
    const schemaRevision = catalogRevisionOf(resources)
    const catalog: CatalogDescribeResponse = {
      resources: resources.map((resource) => ({ ...resource, schemaRevision })),
      schemaRevision,
    }
    const page = await this.listResources({ scopeRef: scopeOf(ctx), limit: 1 }, ctx)
    const cancellation = await this.#attemptCancellation()
    return {
      adapterRef: this.#adapterRef,
      catalog,
      pagination: {
        kind: 'opaque_cursor',
        pagesFetched: 1,
        exhausted: page.nextCursor === null,
      },
      cancellation,
      snapshot: { consistency: 'repeatable_read', schemaRevision },
      limits: this.#limits,
      supportedDataTypes: [...SUPPORTED_DATA_TYPES],
      capabilities: [
        { name: 'catalog.describe', version: '1.0.0' },
        { name: 'structured_query.execute', version: '1.0.0' },
      ],
    }
  }

  async #runTracked(
    session: ReadOnlySession,
    target: InFlightQuery,
    sql: string,
    parameters: readonly (string | number | boolean | null)[],
    effectiveMaxRows: number,
    offset: number,
  ): Promise<{
    readonly rows: unknown[][]
    readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[]
    readonly readAt: string
  }> {
    target.backendPid = session.backendPid
    this.#inFlight.set(target.targetRef, target)
    try {
      // LIMIT/OFFSET are adapter-authored integers, never model text, so they are inlined.
      const text = `SELECT * FROM (${sql}) AS "ontology_page" LIMIT ${String(effectiveMaxRows + 1)} OFFSET ${String(offset)}`
      const result = await session.client.query<unknown[]>({
        text,
        values: [...parameters],
        rowMode: 'array',
      })
      return { rows: result.rows, fields: result.fields, readAt: session.readAt }
    } finally {
      this.#inFlight.delete(target.targetRef)
      target.settled = true
      target.resolveSettled()
    }
  }

  #boundResult(
    raw: {
      readonly rows: unknown[][]
      readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[]
      readonly readAt: string
    },
    maxBytes: number,
    effectiveMaxRows: number,
    offset: number,
  ): ExecuteOutcome {
    const truncatedByRows = raw.rows.length > effectiveMaxRows
    const candidates = truncatedByRows ? raw.rows.slice(0, effectiveMaxRows) : raw.rows
    const rows: unknown[][] = []
    let bytes = 0
    let truncatedByBytes = false
    for (const row of candidates) {
      const cells = row.map((value) => normalizeCell(value))
      const size = byteLengthOf(cells)
      if (bytes + size > maxBytes) {
        if (rows.length === 0) {
          throw new PostgresQueryError(
            'RESULT_TOO_LARGE',
            'the first row exceeds the byte ceiling; narrow the projection or aggregate',
          )
        }
        truncatedByBytes = true
        break
      }
      rows.push(cells)
      bytes += size
    }
    const truncated = truncatedByRows || truncatedByBytes
    const nextCursor = truncated ? encodeCursor(offset + rows.length) : null
    const columns: QueryColumn[] = raw.fields.map((field) => ({
      name: field.name,
      type: columnTypeFromOid(field.dataTypeID),
    }))
    const coverage: ToolCoverage = {
      returned: rows.length,
      truncated,
      completeness: truncated ? 'truncated' : 'complete',
      ...(nextCursor === null ? {} : { cursor: nextCursor }),
    }
    return { columns, rows, coverage, nextCursor, readAt: raw.readAt }
  }

  async #snapshot(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
    outcome: ExecuteOutcome,
    sourceRef: SourceRef,
  ): Promise<SourceSnapshot> {
    const requested = request.snapshotRequest.consistency
    if (request.snapshotRequest.asOf !== undefined) {
      throw new PostgresQueryError(
        'SNAPSHOT_UNAVAILABLE',
        'historical as-of reads are not supported; repeatable_read is scoped to the query transaction',
      )
    }
    if (requested === 'read_time' || requested === 'unknown') {
      throw new PostgresQueryError(
        'SNAPSHOT_UNAVAILABLE',
        `the ${requested} consistency level is not offered by this adapter`,
      )
    }
    const payload = { columns: outcome.columns, rows: outcome.rows }
    const resultDigest = sha256DigestOf(stableJson(payload))
    let consistency: ConsistencyLevel = 'repeatable_read'
    let archivedResultRef: ResourceRef | undefined
    if (requested === 'immutable') {
      const archiver = this.#archiver
      if (archiver === undefined) {
        throw new PostgresQueryError(
          'SNAPSHOT_UNAVAILABLE',
          'an immutable snapshot was requested but no archiver is configured',
        )
      }
      const content = new TextEncoder().encode(stableJson(payload))
      const written = await archiver.putBytes(
        { scopeRef: scopeOf(ctx), content, mediaType: 'application/json' },
        ctx,
      )
      archivedResultRef = written.blobRef
      consistency = 'immutable'
    }
    return {
      sourceRef,
      schemaVersion: await this.#schemaRevisionFor(ctx),
      readAt: outcome.readAt,
      asOf: outcome.readAt,
      consistency,
      resultDigest,
      ...(archivedResultRef === undefined ? {} : { archivedResultRef }),
    }
  }

  async #schemaRevisionFor(ctx: ToolContext): Promise<string> {
    const resources = await this.#discoverResources(ctx)
    return catalogRevisionOf(resources)
  }

  async #discoverResources(ctx: ToolContext): Promise<CatalogResource[]> {
    const authorized = this.#mappings.filter((mapping) =>
      sourceRefAuthorized(mapping.objectRef.sourceRef, ctx.allowedResources.sourceRefs),
    )
    if (authorized.length === 0) return []
    const schemas = authorized.map((mapping) => mapping.schema)
    const relations = authorized.map((mapping) => mapping.relation)
    const rows = await this.#db.query<{
      table_schema: string
      table_name: string
      column_name: string
      data_type: string
    }>(
      `SELECT table_schema, table_name, column_name, data_type
         FROM information_schema.columns
        WHERE (table_schema, table_name) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        ORDER BY table_schema, table_name, ordinal_position`,
      [schemas, relations],
    )
    const byRelation = new Map<string, { columnName: string; dataType: string }[]>()
    for (const row of rows) {
      const key = relationKey(row.table_schema, row.table_name)
      const list = byRelation.get(key) ?? []
      list.push({ columnName: row.column_name, dataType: row.data_type })
      byRelation.set(key, list)
    }
    const resources: CatalogResource[] = []
    for (const mapping of authorized) {
      const discovered = byRelation.get(relationKey(mapping.schema, mapping.relation)) ?? []
      if (discovered.length === 0) continue
      const declared = new Map<string, MappedColumn>(
        (mapping.columns ?? []).map((column) => [column.name, column]),
      )
      const columns: QueryColumn[] = discovered.map((column) => {
        const mapped = declared.get(column.columnName)
        if (mapped !== undefined) return queryColumnOf(mapped)
        return { name: column.columnName, type: columnTypeOf(column.dataType) }
      })
      resources.push(catalogResourceOf(mapping, columns, ''))
    }
    resources.sort((left, right) =>
      left.objectRef.objectPath < right.objectRef.objectPath
        ? -1
        : left.objectRef.objectPath > right.objectRef.objectPath
          ? 1
          : 0,
    )
    return resources
  }

  async #attemptCancellation(): Promise<{
    readonly support: 'supported' | 'best_effort' | 'unsupported'
    readonly attempted: boolean
  }> {
    const target = createInFlight(this.#newId())
    const run = this.#db
      .withReadOnlySnapshot({
        statementTimeoutMs: PROBE_CANCEL_TIMEOUT_MS,
        operation: async (session) => {
          target.backendPid = session.backendPid
          this.#inFlight.set(target.targetRef, target)
          try {
            await session.client.query('SELECT pg_sleep($1)', [PROBE_SLEEP_SECONDS])
          } finally {
            this.#inFlight.delete(target.targetRef)
            target.settled = true
            target.resolveSettled()
          }
        },
      })
      .catch(() => undefined)
    void run
    const registered = await this.#waitUntil(() => this.#inFlight.has(target.targetRef), PROBE_REGISTER_TIMEOUT_MS)
    if (!registered || target.backendPid === undefined) {
      return { support: 'best_effort', attempted: false }
    }
    const confirmed = await this.#db.cancelBackend(target.backendPid).catch(() => false)
    const settled = await this.#waitFor(target.settledPromise, PROBE_CANCEL_TIMEOUT_MS)
    return confirmed && settled
      ? { support: 'supported', attempted: true }
      : { support: 'best_effort', attempted: false }
  }

  #effectiveTimeoutMs(maxDurationMs: number, ctx: ToolContext): number {
    const deadlineRemaining = Date.parse(ctx.deadline) - Date.now()
    const effective = Math.min(maxDurationMs, this.#limits.maxDurationMs, deadlineRemaining)
    if (!Number.isFinite(effective) || effective <= 0) {
      throw new PostgresQueryError('DEADLINE_EXCEEDED', 'the run deadline has already passed')
    }
    return effective
  }

  #classifyQueryFailure(error: unknown, target: InFlightQuery): PostgresQueryError {
    if (error instanceof PostgresQueryError) return error
    const state = sqlStateOf(error)
    if (state === '57014') {
      if (target.cancelRequested) {
        return new PostgresQueryError('INTERNAL_ERROR', 'the query was cancelled', {
          remoteStateUnknown: !target.cancelConfirmed,
        })
      }
      return new PostgresQueryError('DEADLINE_EXCEEDED', 'the query exceeded its statement timeout', {
        remoteStateUnknown: true,
      })
    }
    if (state === '42501') {
      return new PostgresQueryError(
        'FORBIDDEN',
        'the read-only role was refused access to a mapped object',
        { cause: error },
      )
    }
    if (state !== undefined && state.startsWith('08')) {
      return new PostgresQueryError('SOURCE_UNAVAILABLE', 'the business database is unavailable', {
        cause: error,
      })
    }
    const detail = error instanceof Error ? error.message : 'the query failed'
    return new PostgresQueryError('INTERNAL_ERROR', detail, { cause: error })
  }

  async #waitFor(promise: Promise<void>, ms: number): Promise<boolean> {
    return Promise.race([promise.then(() => true), delay(ms).then(() => false)])
  }

  async #waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return true
      await delay(10)
    }
    return predicate()
  }
}

function rejected(
  ctx: ToolContext,
  code: ErrorCode,
  reason: string,
): StructuredQueryValidateResponse {
  return {
    valid: false,
    warnings: [],
    rejectedReason: new PostgresQueryError(code, reason).toPlatformError(ctx.traceId),
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertTrustedContext(ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new PostgresQueryError('UNAUTHENTICATED', 'a host-minted trusted tool context is required')
  }
}

function assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (
    scopeRef.tenantId !== ctx.principal.tenantId ||
    scopeRef.spaceId !== ctx.allowedResources.spaceId
  ) {
    throw new PostgresQueryError('FORBIDDEN', 'request scope does not match the trusted principal scope')
  }
}
