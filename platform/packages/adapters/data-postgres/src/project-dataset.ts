import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import { sha256DigestOf } from '@ontology/core'
import { columnTypeFromOid, normalizeCell, stableJson } from './canonical'
import {
  ProjectDatasetError,
  projectDatasetSourceObjectRef,
  projectDatasetSourceRef,
  isToolContext,
  assertProjectDatasetSnapshotShape,
  assertProjectDatasetMetadataShape,
} from '@ontology/contracts'
import type {
  AttributeValueType,
  CancelRequest,
  CancelResponse,
  ColumnType,
  PlatformError,
  ProjectDatasetCell,
  ProjectDatasetColumn,
  ProjectDatasetFieldSource,
  ProjectDatasetQueryPort,
  ProjectDatasetQueryRequest,
  ProjectDatasetQueryResult,
  ProjectDatasetReadRow,
  ProjectDatasetRef,
  ProjectDatasetRow,
  ProjectDatasetStageInput,
  ProjectDatasetStageResult,
  ProjectDatasetSnapshotMetadata,
  ProjectDatasetWriterPort,
  ProjectSnapshotQueryDescriptor,
  ProjectSnapshotQueryPort,
  QueryColumn,
  ScopeRef,
  SourceSnapshot,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  ToolContext,
  ToolCoverage,
} from '@ontology/contracts'
import { validateReadOnlySql } from './sql-validator'
import { PostgresQueryError } from './errors'
import type { BusinessObjectMapping, MappedColumn } from './mapping'

export const POSTGRES_PROJECT_DATASET_BACKEND = '@ontology/adapter-data-postgres:project-dataset'

const DEFAULT_SCHEMA = 'ontology_project_dataset'
const DEFAULT_PAGE_LIMIT = 250
const MAX_PAGE_LIMIT = 1_000
const INSERT_BATCH = 500
const DEFAULT_QUERY_TIMEOUT_MS = 30_000

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const SNAPSHOT_TABLE = 'project_dataset_snapshots'
const ROW_TABLE = 'project_dataset_rows'

export interface PostgresProjectDatasetConfig {
  readonly connectionString: string
  /**
   * A separate connection string for an independent read-only role used by the query path.
   * When omitted the writer pool is reused, but the query always runs inside a read-only
   * transaction and the AST/object whitelist still applies.
   */
  readonly readOnlyConnectionString?: string
  /** A dedicated schema in an independent business database; never the control schema. */
  readonly schema?: string
  readonly maxPoolSize?: number
  readonly maxQueryPoolSize?: number
  readonly applicationName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new ProjectDatasetError('INVALID_ARGUMENT', `invalid business identifier "${name}"`)
  }
  return `"${name}"`
}

function decodeCursor(cursor: string | undefined, pin: string): number {
  if (cursor === undefined || cursor.length === 0) return 0
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (isRecord(parsed)) {
      const offset = parsed['o']
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 && parsed['p'] === pin) return offset
    }
  } catch {
    throw new ProjectDatasetError('INVALID_ARGUMENT', 'the dataset cursor is malformed')
  }
  throw new ProjectDatasetError('INVALID_ARGUMENT', 'the dataset cursor is malformed')
}

function encodeCursor(offset: number, pin: string): string {
  return Buffer.from(JSON.stringify({ o: offset, p: pin }), 'utf8').toString('base64url')
}

function assertTrusted(ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'trusted context carries inconsistent scope')
  }
}

function assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  assertTrusted(ctx)
  if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) throw new ProjectDatasetError('SCOPE_MISMATCH', 'the dataset scope does not match the trusted principal')
}

function scopeKeyOf(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function canonicalDigestOf(columns: readonly ProjectDatasetColumn[], rows: readonly ProjectDatasetRow[]): string {
  return sha256DigestOf(
    stableJson({
      objectId: rows[0]?.objectId ?? '',
      columns,
      rows: rows.map((row) => ({ recordId: row.recordId, values: row.values })),
    }),
  )
}

/** The canonical column type one project attribute is queried as. */
function canonicalColumnTypeOfProject(valueType: AttributeValueType): ColumnType {
  switch (valueType) {
    case 'number':
    case 'quantity':
      return 'decimal'
    case 'boolean':
      return 'boolean'
    case 'timestamp':
      return 'timestamp'
    case 'string':
    case 'enum':
    case 'reference':
      return 'string'
  }
}

/** The exact PostgreSQL type the read-only view casts a canonical cell to. */
function postgresTypeOfProject(valueType: AttributeValueType): string {
  switch (canonicalColumnTypeOfProject(valueType)) {
    case 'decimal':
      return 'numeric'
    case 'boolean':
      return 'boolean'
    case 'timestamp':
      return 'timestamptz'
    default:
      return 'text'
  }
}

function queryViewName(snapshotId: string): string {
  return `dsq_${snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

/** A single-quoted literal for an identifier already validated by the IDENTIFIER regex. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

interface StagedQuery {
  readonly scopeKey: string
  readonly snapshotId: string
  readonly objectId: string
  readonly version: string
  readonly view: string
  readonly columns: readonly ProjectDatasetColumn[]
  readonly metadata: ProjectDatasetSnapshotMetadata
}

interface ActiveProjectQuery {
  readonly runId: string
  readonly scopeKey: string
  pid: number | undefined
  cancelled: boolean
}

interface RowRow extends QueryResultRow {
  record_id: string
  object_id: string
  source_row_key: string
  values: Record<string, ProjectDatasetCell>
  sources: ProjectDatasetFieldSource[]
}

interface MetaRow extends QueryResultRow {
  columns: ProjectDatasetColumn[]
  canonical_digest: string
  row_count: string
  metadata: ProjectDatasetSnapshotMetadata | null
}

/**
 * PostgreSQL business-backend writer and read port for project dataset snapshots
 * (SPEC v0.3a asset-data-ui §6.3).
 *
 * The writer owns a dedicated business schema (never the control schema). Every snapshot is
 * an immutable set of rows keyed by `snapshot_id`, written through the independent writer
 * role: a correction or deletion produces a *new* snapshot id and never rewrites the previous
 * rows. A read of a pinned ref whose rows are absent reports `SNAPSHOT_UNAVAILABLE`; the query
 * never falls back to another snapshot.
 */
export class PostgresProjectDatasetAdapter
  implements ProjectDatasetWriterPort, ProjectDatasetQueryPort, ProjectSnapshotQueryPort
{
  readonly backend = POSTGRES_PROJECT_DATASET_BACKEND
  readonly #pool: Pool
  /** Independent read-only role for the query path; defaults to the writer pool when unset. */
  readonly #queryPool: Pool
  readonly #ownsQueryPool: boolean
  readonly #schema: string
  readonly #staged = new Map<string, StagedQuery>()
  readonly #active = new Map<string, ActiveProjectQuery>()

  constructor(config: PostgresProjectDatasetConfig) {
    this.#schema = config.schema ?? DEFAULT_SCHEMA
    if (!IDENTIFIER.test(this.#schema) || /^(?:public|control|ontology_control|agent_platform)$/i.test(this.#schema)) {
      throw new ProjectDatasetError('INVALID_ARGUMENT', `invalid business schema "${this.#schema}"`)
    }
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 4,
      statement_timeout: DEFAULT_QUERY_TIMEOUT_MS,
      connectionTimeoutMillis: DEFAULT_QUERY_TIMEOUT_MS,
      application_name: config.applicationName ?? 'ontology-project-dataset',
    })
    this.#ownsQueryPool = config.readOnlyConnectionString !== undefined
    this.#queryPool = this.#ownsQueryPool
      ? new Pool({
          connectionString: config.readOnlyConnectionString,
          max: config.maxQueryPoolSize ?? 4,
          application_name: `${config.applicationName ?? 'ontology-project-dataset'}-readonly`,
        })
      : this.#pool
  }

  async close(): Promise<void> {
    if (this.#ownsQueryPool) await this.#queryPool.end().catch(() => undefined)
    await this.#pool.end()
  }

  async stageSnapshot(
    scopeRef: ScopeRef,
    input: ProjectDatasetStageInput,
    ctx: ToolContext,
  ): Promise<ProjectDatasetStageResult> {
    assertScope(scopeRef, ctx)
    assertProjectDatasetSnapshotShape({ ref: input.snapshotRef, body: input.body })
    if (input.body.backend !== this.backend) throw new ProjectDatasetError('INVALID_ARGUMENT', 'the snapshot declares a different business backend')
    await this.#ensureSchema()
    const { body, snapshotRef } = input
    const snapshotId = snapshotRef.id
    const { rows: _rows, ...snapshotBody } = body
    void _rows
    const metadata: ProjectDatasetSnapshotMetadata = { scopeRef, snapshotRef, body: snapshotBody, rowContentDigest: sha256DigestOf(stableJson(body.rows)) }
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO ${this.#table(SNAPSHOT_TABLE)}
           (snapshot_id, project_id, object_id, project_revision, backend, columns, row_count, schema_digest, canonical_digest, recorded_at, metadata)
         VALUES ($1::uuid, $2::uuid, $3, $4::bigint, $5, $6::jsonb, $7::bigint, $8, $9, $10::timestamptz, $11::jsonb)
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [
          snapshotId,
          body.projectId,
          body.objectId,
          body.projectRevision,
          body.backend,
          JSON.stringify(body.columns),
          body.rows.length,
          input.schemaDigest,
          input.canonicalDigest,
          body.recordedAt,
          JSON.stringify(metadata),
        ],
      )
      const existing = await client.query<MetaRow>(`SELECT metadata, canonical_digest FROM ${this.#table(SNAPSHOT_TABLE)} WHERE snapshot_id = $1::uuid FOR UPDATE`, [snapshotId])
      const stored = existing.rows[0]
      if (stored?.metadata === null || stored?.metadata === undefined ||
        stableJson({ ...stored.metadata, body: { ...stored.metadata.body, recordedAt: '' } }) !== stableJson({ ...metadata, body: { ...metadata.body, recordedAt: '' } }) || stored.canonical_digest !== input.canonicalDigest) {
        throw new ProjectDatasetError('IDEMPOTENCY_CONFLICT', 'the snapshot identity already carries different content or scope')
      }
      for (let start = 0; start < body.rows.length; start += INSERT_BATCH) {
        const batch = body.rows.slice(start, start + INSERT_BATCH)
        const valuesSql = batch
          .map((_row, index) => `($${String(index * 6 + 1)}::uuid, $${String(index * 6 + 2)}::uuid, $${String(index * 6 + 3)}, $${String(index * 6 + 4)}, $${String(index * 6 + 5)}::jsonb, $${String(index * 6 + 6)}::jsonb)`)
          .join(', ')
        const parameters = batch.flatMap((row) => [
          snapshotId,
          row.recordId,
          row.objectId,
          row.sourceRowKey,
          JSON.stringify(row.values),
          JSON.stringify(row.sources),
        ])
        await client.query(
          `INSERT INTO ${this.#table(ROW_TABLE)} (snapshot_id, record_id, object_id, source_row_key, values, sources)
           VALUES ${valuesSql}
           ON CONFLICT (snapshot_id, record_id) DO NOTHING`,
          parameters,
        )
      }
      const persisted = await this.#readRows(client, snapshotId, body.columns)
      const storedDigest = canonicalDigestOf(body.columns, persisted)
      if (storedDigest !== input.canonicalDigest || persisted.length !== body.rows.length || sha256DigestOf(stableJson(persisted)) !== metadata.rowContentDigest) {
        await client.query('ROLLBACK')
        throw new ProjectDatasetError('MATERIALIZATION_MISMATCH', 'the staged PostgreSQL rows did not match the canonical dataset digest')
      }
      // Expose the fixed rows as a typed, read-only projection: `values` are canonical cells,
      // so a quantity becomes a real `numeric` and a boolean a real `boolean`. The view is
      // pinned to this snapshot id and is the only relation the query path can address.
      const view = queryViewName(snapshotId)
      const projections = [
        `record_id::text AS ${quoteIdentifier('record_id')}`,
        `object_id AS ${quoteIdentifier('object_id')}`,
        ...body.columns.map(
          (column) =>
            `(values -> ${quoteLiteral(column.name)} ->> 'value')::${postgresTypeOfProject(column.valueType)} AS ${quoteIdentifier(column.name)}`,
        ),
        `sources::text AS ${quoteIdentifier('sources_json')}`,
      ].join(', ')
      await client.query(
        `CREATE OR REPLACE VIEW ${this.#table(view)} AS
           SELECT ${projections} FROM ${this.#table(ROW_TABLE)}
          WHERE snapshot_id = ${quoteLiteral(snapshotId)}::uuid`,
      )
      await client.query('COMMIT')
      this.#staged.set(snapshotId, {
        scopeKey: scopeKeyOf(scopeRef),
        snapshotId,
        objectId: body.objectId,
        version: snapshotRef.version,
        view,
        columns: body.columns,
        metadata: stored.metadata,
      })
      return {
        snapshotRef,
        rowCount: persisted.length,
        schemaDigest: input.schemaDigest,
        canonicalDigest: storedDigest,
        created: inserted.rowCount === 1,
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error instanceof ProjectDatasetError) throw error
      throw new ProjectDatasetError('BACKEND_UNAVAILABLE', 'the PostgreSQL business backend could not stage the dataset', { cause: error })
    } finally {
      client.release()
    }
  }

  async discardSnapshot(scopeRef: ScopeRef, snapshotRef: { readonly id: string }, ctx: ToolContext): Promise<void> {
    assertScope(scopeRef, ctx)
    const staged = await this.#restore(scopeRef, snapshotRef.id)
    if (staged === undefined) return
    this.#staged.delete(snapshotRef.id)
    await this.#pool.query(`DROP VIEW IF EXISTS ${this.#table(queryViewName(snapshotRef.id))}`)
    await this.#deleteSnapshot(snapshotRef.id)
  }

  async querySnapshot(
    scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectDatasetQueryResult> {
    assertScope(scopeRef, ctx)
    const staged = await this.#restore(scopeRef, request.snapshotRef.id)
    if (staged === undefined || stableJson(staged.metadata.snapshotRef) !== stableJson(request.snapshotRef)) {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the exact scoped dataset snapshot is unavailable')
    }
    if (request.objectId !== undefined && request.objectId !== staged.objectId) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the snapshot belongs to a different project object')
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
    const cursorPin = sha256DigestOf(stableJson({ scopeRef, snapshotRef: request.snapshotRef, objectId: request.objectId ?? null }))
    const offset = decodeCursor(request.cursor, cursorPin)
    const objectFilter = request.objectId === undefined ? '' : ' AND object_id = $3'
    const parameters: unknown[] = [request.snapshotRef.id, limit + 1]
    if (request.objectId !== undefined) parameters.push(request.objectId)
    const result = await this.#pool.query<RowRow>(
      `SELECT record_id::text AS record_id, object_id, source_row_key, values, sources
         FROM ${this.#table(ROW_TABLE)}
        WHERE snapshot_id = $1::uuid${objectFilter}
        ORDER BY record_id
        LIMIT $2 OFFSET ${String(offset)}`,
      parameters,
    )
    const truncated = result.rows.length > limit
    const kept = truncated ? result.rows.slice(0, limit) : result.rows
    const rows: ProjectDatasetReadRow[] = kept.map((row) => ({
      recordId: row.record_id,
      objectId: row.object_id,
      sourceRowKey: row.source_row_key,
      values: row.values,
      sources: row.sources,
    }))
    const nextCursor = truncated ? encodeCursor(offset + kept.length, cursorPin) : null
    const coverage: ToolCoverage = {
      returned: rows.length,
      truncated,
      completeness: 'complete',
      ...(nextCursor === null ? {} : { cursor: nextCursor }),
    }
    return { snapshotRef: request.snapshotRef, columns: staged.columns, rows, coverage }
  }

  /**
   * Report the fixed physical relation a snapshot was materialised as. `undefined` when the
   * snapshot is not staged in this backend (a restart, another scope, or a never-written ref),
   * so a caller reports `SNAPSHOT_UNAVAILABLE` instead of reading another dataset.
   */
  async describeSnapshot(
    scopeRef: ScopeRef,
    snapshotRef: ProjectDatasetRef,
    ctx: ToolContext,
  ): Promise<ProjectSnapshotQueryDescriptor | undefined> {
    assertScope(scopeRef, ctx)
    const staged = await this.#restore(scopeRef, snapshotRef.id)
    if (staged === undefined || stableJson(staged.metadata.snapshotRef) !== stableJson(snapshotRef)) return undefined
    return {
      snapshotRef,
      objectId: staged.objectId,
      dialect: 'postgres',
      schema: this.#schema,
      relation: staged.view,
      relationKind: 'view',
      sourceObjectRef: projectDatasetSourceObjectRef(staged.snapshotId, staged.objectId),
      columns: staged.columns,
      metadata: staged.metadata,
    }
  }

  /** The AST/object whitelist for the query path is exactly the staged snapshot views. */
  #allowlist(ctx: ToolContext): readonly BusinessObjectMapping[] {
    return [...this.#staged.values()].filter((staged) => staged.scopeKey === scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })).map((staged) => ({
      objectRef: projectDatasetSourceObjectRef(staged.snapshotId, staged.objectId),
      schema: this.#schema,
      relation: staged.view,
      relationKind: 'view' as const,
      columns: staged.columns.map(
        (column): MappedColumn => ({
          name: column.name,
          type: canonicalColumnTypeOfProject(column.valueType),
          ...(column.canonicalUnitCode === undefined ? {} : { unit: column.canonicalUnitCode }),
        }),
      ),
    }))
  }

  async validate(
    request: StructuredQueryValidateRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryValidateResponse> {
    assertTrusted(ctx)
    const plan = request.plan
    if (plan.mode !== 'direct') {
      return this.#rejected('UNSUPPORTED_QUERY', 'only direct SQL plans are validated by this adapter')
    }
    await this.#restoreDeclared(plan.referencedObjects, ctx)
    const validation = validateReadOnlySql({
      sql: plan.sql,
      parameters: plan.parameters,
      allowlist: this.#allowlist(ctx),
      declaredObjects: plan.referencedObjects,
      authorizedSourceRefs: ctx.allowedResources.sourceRefs,
    })
    if (!validation.valid) {
      return {
        valid: false,
        warnings: [...validation.warnings],
        rejectedReason: { code: validation.code, message: validation.reason, retryable: false },
      }
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
    assertTrusted(ctx)
    const target: ActiveProjectQuery = { runId: ctx.runId, scopeKey: scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }), cancelled: false, pid: undefined }
    const targetRef = globalThis.crypto.randomUUID()
    this.#active.set(targetRef, target)
    try { return await this.#execute(request, ctx, target) } finally { this.#active.delete(targetRef) }
  }

  async #execute(request: StructuredQueryExecuteRequest, ctx: ToolContext, target: ActiveProjectQuery): Promise<StructuredQueryExecuteResponse> {
    const plan = request.plan
    if (plan.mode !== 'direct') {
      throw new PostgresQueryError('UNSUPPORTED_QUERY', 'only direct SQL plans are executed by this adapter')
    }
    await this.#restoreDeclared(plan.referencedObjects, ctx)
    const validation = validateReadOnlySql({
      sql: plan.sql,
      parameters: plan.parameters,
      allowlist: this.#allowlist(ctx),
      declaredObjects: plan.referencedObjects,
      authorizedSourceRefs: ctx.allowedResources.sourceRefs,
    })
    if (!validation.valid) {
      throw new PostgresQueryError(validation.code, validation.reason)
    }
    const maxRows = Math.max(1, Math.min(request.limits.maxRows, ctx.allowedResources.maxRows))
    const deadlineRemaining = Date.parse(ctx.deadline) - Date.now()
    const timeoutMs = Math.max(
      1,
      Math.min(request.limits.maxDurationMs, deadlineRemaining, DEFAULT_QUERY_TIMEOUT_MS),
    )
    const cursorPin = sha256DigestOf(stableJson({ scope: scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }), plan }))
    const offset = decodeCursor(request.cursor, cursorPin)
    const raw = await this.#runReadOnly(validation.executableSql, plan.parameters, maxRows, timeoutMs, offset, target)
    const truncated = raw.rows.length > maxRows
    const kept = truncated ? raw.rows.slice(0, maxRows) : raw.rows
    const rows: unknown[][] = []
    let bytes = 0
    for (const row of kept) {
      const normalized = row.map((value) => normalizeCell(value))
      bytes += Buffer.byteLength(stableJson(normalized), 'utf8')
      if (bytes > request.limits.maxBytes) {
        if (rows.length === 0) throw new PostgresQueryError('RESULT_TOO_LARGE', 'a project query row exceeds the byte budget')
        break
      }
      rows.push(normalized)
    }
    const columns: QueryColumn[] = raw.fields.map((field) => ({
      name: field.name,
      type: columnTypeFromOid(field.dataTypeID),
    }))
    const snapshotId =
      validation.referencedObjects[0]?.sourceRef.sourceId ?? plan.referencedObjects[0]?.sourceRef.sourceId
    const staged = snapshotId === undefined ? undefined : this.#staged.get(snapshotId)
    if (staged === undefined) {
      throw new PostgresQueryError('SNAPSHOT_UNAVAILABLE', 'the pinned dataset snapshot is not materialised in this backend')
    }
    const coverage: ToolCoverage = {
      returned: rows.length,
      truncated: truncated || rows.length < kept.length,
      completeness: truncated || rows.length < kept.length ? 'truncated' : 'complete',
      ...(truncated || rows.length < kept.length ? { cursor: encodeCursor(offset + rows.length, cursorPin) } : {}),
    }
    const snapshot: SourceSnapshot = {
      sourceRef: projectDatasetSourceRef(staged.snapshotId),
      schemaVersion: staged.version,
      readAt: new Date().toISOString(),
      consistency: 'immutable',
      resultDigest: sha256DigestOf(stableJson({ columns, rows })),
    }
    return { snapshot, columns, rows, nextCursor: coverage.cursor ?? null, coverage }
  }

  activeTargets(): readonly string[] { return [...this.#active.keys()] }

  async cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse> {
    assertTrusted(ctx)
    const target = this.#active.get(request.targetRef)
    const acceptedAt = new Date().toISOString()
    if (target === undefined) return { targetRef: request.targetRef, state: 'already_terminal', acceptedAt }
    if (target.runId !== ctx.runId || target.scopeKey !== scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })) throw new ProjectDatasetError('FORBIDDEN', 'a foreign query cannot be cancelled')
    target.cancelled = true
    if (target.pid !== undefined) await this.#pool.query('SELECT pg_cancel_backend($1)', [target.pid])
    return { targetRef: request.targetRef, state: 'cancelling', acceptedAt }
  }

  async #runReadOnly(
    sql: string,
    parameters: readonly (string | number | boolean | null)[],
    maxRows: number,
    timeoutMs: number,
    offset: number,
    target: ActiveProjectQuery,
  ): Promise<{
    readonly rows: unknown[][]
    readonly fields: readonly { readonly name: string; readonly dataTypeID: number }[]
  }> {
    let client: PoolClient | undefined
    try {
      client = await this.#queryPool.connect()
      const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      target.pid = pid.rows[0]?.pid
      if (target.cancelled) throw new PostgresQueryError('INTERNAL_ERROR', 'the project query was cancelled')
      await client.query('BEGIN TRANSACTION READ ONLY')
      await client.query(`SET LOCAL statement_timeout = ${String(Math.floor(timeoutMs))}`)
      const wrapped = `SELECT * FROM (${sql}) AS "ontology_page" LIMIT ${String(maxRows + 1)} OFFSET ${String(offset)}`
      const result = await client.query<unknown[]>({ text: wrapped, values: [...parameters], rowMode: 'array' })
      if (target.cancelled) throw new PostgresQueryError('INTERNAL_ERROR', 'the project query was cancelled')
      await client.query('COMMIT')
      return {
        rows: result.rows as unknown[][],
        fields: result.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
      }
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined)
      if (error instanceof PostgresQueryError) throw error
      throw new PostgresQueryError(isRecord(error) && error['code'] === '57014' && !target.cancelled ? 'DEADLINE_EXCEEDED' : 'INTERNAL_ERROR', error instanceof Error ? error.message : 'the query failed', {
        cause: error,
      })
    } finally {
      client?.release()
    }
  }

  #rejected(code: PlatformError['code'], message: string): StructuredQueryValidateResponse {
    return { valid: false, warnings: [], rejectedReason: { code, message, retryable: false } }
  }

  async #ensureSchema(): Promise<void> {
    await this.#pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.#schema)}`)
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#table(SNAPSHOT_TABLE)} (
         snapshot_id uuid PRIMARY KEY,
         project_id uuid NOT NULL,
         object_id text NOT NULL,
         project_revision bigint NOT NULL,
         backend text NOT NULL,
         columns jsonb NOT NULL,
         row_count bigint NOT NULL,
         schema_digest text NOT NULL,
         canonical_digest text NOT NULL,
         recorded_at timestamptz NOT NULL,
         metadata jsonb
       )`,
    )
    await this.#pool.query(`ALTER TABLE ${this.#table(SNAPSHOT_TABLE)} ADD COLUMN IF NOT EXISTS metadata jsonb`)
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#table(ROW_TABLE)} (
         snapshot_id uuid NOT NULL,
         record_id uuid NOT NULL,
         object_id text NOT NULL,
         source_row_key text NOT NULL,
         values jsonb NOT NULL,
         sources jsonb NOT NULL,
         PRIMARY KEY (snapshot_id, record_id)
       )`,
    )
  }

  async #deleteSnapshot(snapshotId: string): Promise<void> {
    await this.#pool.query(`DELETE FROM ${this.#table(ROW_TABLE)} WHERE snapshot_id = $1::uuid`, [snapshotId])
    await this.#pool.query(`DELETE FROM ${this.#table(SNAPSHOT_TABLE)} WHERE snapshot_id = $1::uuid`, [snapshotId])
  }

  async #readRows(
    client: PoolClient,
    snapshotId: string,
    columns: readonly ProjectDatasetColumn[],
  ): Promise<ProjectDatasetRow[]> {
    void columns
    const result = await client.query<RowRow>(
      `SELECT record_id::text AS record_id, object_id, source_row_key, values, sources
         FROM ${this.#table(ROW_TABLE)} WHERE snapshot_id = $1::uuid ORDER BY record_id`,
      [snapshotId],
    )
    return result.rows.map((row) => ({
      recordId: row.record_id,
      objectId: row.object_id,
      sourceRowKey: row.source_row_key,
      values: row.values,
      sources: row.sources,
    }))
  }

  async #restore(scope: ScopeRef, id: string): Promise<StagedQuery | undefined> {
    let result: { readonly rows: MetaRow[] }
    try {
      result = await this.#pool.query<MetaRow>(`SELECT metadata, canonical_digest, columns, row_count::text AS row_count FROM ${this.#table(SNAPSHOT_TABLE)} WHERE snapshot_id = $1::uuid AND metadata->'scopeRef'->>'tenantId' = $2 AND metadata->'scopeRef'->>'spaceId' = $3`, [id, scope.tenantId, scope.spaceId])
    } catch (error) {
      if (isRecord(error) && (error['code'] === '42P01' || error['code'] === '42703')) return undefined
      throw error
    }
    const metadata = result.rows[0]?.metadata
    if (metadata === undefined || metadata === null) return undefined
    assertProjectDatasetMetadataShape(metadata)
    if (metadata.snapshotRef.id !== id || scopeKeyOf(metadata.scopeRef) !== scopeKeyOf(scope)) return undefined
    const relation = await this.#pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [this.#table(queryViewName(id))])
    if (relation.rows[0]?.present !== true) { this.#staged.delete(id); return undefined }
    const staged: StagedQuery = { scopeKey: scopeKeyOf(scope), snapshotId: id, objectId: metadata.body.objectId,
      version: metadata.snapshotRef.version, view: queryViewName(id), columns: metadata.body.columns, metadata }
    this.#staged.set(id, staged)
    return staged
  }

  async #restoreDeclared(objects: readonly import('@ontology/contracts').SourceObjectRef[], ctx: ToolContext): Promise<void> {
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    if (objects.length > 1) throw new PostgresQueryError('UNSUPPORTED_QUERY', 'project queries address one fixed snapshot')
    for (const object of objects) {
      if (object.sourceRef.namespace !== 'project-dataset') continue
      const staged = await this.#restore(scope, object.sourceRef.sourceId)
      if (staged === undefined) throw new PostgresQueryError('SNAPSHOT_UNAVAILABLE', 'the scoped fixed project snapshot is unavailable')
    }
  }

  #table(name: string): string {
    return `${quoteIdentifier(this.#schema)}.${quoteIdentifier(name)}`
  }
}
