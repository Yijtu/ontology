import { sha256DigestOf } from '@ontology/core'
import {
  ProjectDatasetError,
  projectDatasetSourceObjectRef,
  projectDatasetSourceRef,
  isToolContext,
  assertProjectDatasetSnapshotShape,
  assertProjectDatasetMetadataShape,
  assertProjectDatasetActivationShape,
  projectDatasetPhysicalCellsMatch,
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
  ProjectDatasetActivationReceipt,
  ProjectDatasetSnapshotMetadata,
  ProjectDatasetWriterPort,
  ProjectSnapshotQueryDescriptor,
  ProjectSnapshotQueryPort,
  QueryColumn,
  ScalarValue,
  ScopeRef,
  SourceSnapshot,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  ToolContext,
  ToolCoverage,
} from '@ontology/contracts'
import { DuckDBTypeId, DuckDbEngine } from './engine'
import type { DuckDbSession, SessionExecution } from './engine'
import { RelationRegistry } from './config'
import type { RegisteredRelation } from './config'
import { canonicalJson, normaliseColumnType, normaliseValue, resultDigestOf } from './normalise'
import { validateSql } from './validator'
import { DuckDbAdapterError } from './errors'

export const DUCKDB_PROJECT_DATASET_BACKEND = '@ontology/adapter-data-duckdb:project-dataset'

const DEFAULT_PAGE_LIMIT = 250
const MAX_PAGE_LIMIT = 1_000
const INSERT_BATCH = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function tableFor(snapshotId: string): string {
  return `ds_${snapshotId.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

function encodeCursor(offset: number, pin: string): string {
  return Buffer.from(JSON.stringify({ o: offset, p: pin }), 'utf8').toString('base64url')
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

function assertTrusted(ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'trusted context carries inconsistent scope')
  }
}

/** The canonical column type a project attribute is queried as (never a client declaration). */
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

/** The exact physical DuckDB type the fixed canonical column is materialised as. */
function physicalTypeOfProject(valueType: AttributeValueType, scale = 0): string {
  switch (canonicalColumnTypeOfProject(valueType)) {
    case 'decimal':
      return `DECIMAL(38,${String(scale)})`
    case 'boolean':
      return 'BOOLEAN'
    case 'timestamp':
      return 'TIMESTAMP'
    default:
      return 'VARCHAR'
  }
}

/**
 * The typed value written into a canonical query column. A quantity is written as its exact
 * decimal string (never a lossy float); a scalar keeps its string/boolean/null identity.
 */
function typedCellValue(cell: ProjectDatasetCell): ScalarValue {
  return cell.kind === 'quantity' ? cell.value : cell.value
}

function decimalScalesOf(columns: readonly ProjectDatasetColumn[], rows: readonly ProjectDatasetRow[]): Record<string, number> {
  const scales: Record<string, number> = {}
  for (const column of columns) {
    if (column.valueType !== 'number' && column.valueType !== 'quantity') continue
    let scale = 0
    let integerDigits = 1
    for (const row of rows) {
      const value = row.values[column.name]?.value
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new ProjectDatasetError('INVALID_ARGUMENT', 'numeric project values must be exact lexical decimals')
      const [integer = '', fraction = ''] = value.replace(/^-/, '').split('.')
      scale = Math.max(scale, fraction.length)
      integerDigits = Math.max(integerDigits, integer.length)
    }
    if (integerDigits + scale > 38) throw new ProjectDatasetError('INVALID_ARGUMENT', 'the exact project decimal exceeds DuckDB precision 38; it cannot be rounded')
    scales[column.name] = scale
  }
  return scales
}

interface ActiveProjectQuery {
  readonly scopeKey: string
  readonly runId: string
  session: DuckDbSession | undefined
  cancelled: boolean
  running: boolean
}

interface StagedSnapshot {
  readonly scopeKey: string
  readonly snapshotId: string
  readonly objectId: string
  readonly version: string
  readonly table: string
  readonly columns: readonly ProjectDatasetColumn[]
  readonly rowCount: number
  readonly schemaDigest: string
  readonly canonicalDigest: string
  readonly metadata: ProjectDatasetSnapshotMetadata
}

function assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  assertTrusted(ctx)
  if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) throw new ProjectDatasetError('SCOPE_MISMATCH', 'the dataset scope does not match the trusted principal')
}

function scopeKeyOf(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function valuesJsonOf(row: ProjectDatasetRow): string {
  return JSON.stringify(row.values)
}

function sourcesJsonOf(row: ProjectDatasetRow): string {
  return JSON.stringify(row.sources)
}

function sameSourceRef(
  left: { readonly namespace: string; readonly sourceId: string },
  right: { readonly namespace: string; readonly sourceId: string },
): boolean {
  return left.namespace === right.namespace && left.sourceId === right.sourceId
}

function sameObjectRef(
  left: { readonly sourceRef: { readonly namespace: string; readonly sourceId: string }; readonly objectPath: string },
  right: { readonly sourceRef: { readonly namespace: string; readonly sourceId: string }; readonly objectPath: string },
): boolean {
  return sameSourceRef(left.sourceRef, right.sourceRef) && left.objectPath === right.objectPath
}

function canonicalDigestOf(columns: readonly ProjectDatasetColumn[], rows: readonly ProjectDatasetRow[]): string {
  return sha256DigestOf(
    canonicalJson({
      objectId: rows[0]?.objectId ?? '',
      columns,
      rows: rows.map((row) => ({ recordId: row.recordId, values: row.values })),
    }),
  )
}

/**
 * DuckDB business-backend writer and read port for project dataset snapshots
 * (SPEC v0.3a asset-data-ui §6.3).
 *
 * Each snapshot is a real DuckDB table built in a dedicated in-process instance, separate
 * from the startup demo snapshot: the table is created only from the service's canonical
 * columns and rows, never by reading the demo data. A staged table is queryable by exact
 * `snapshotRef`; when the instance is restarted (a fresh adapter) the snapshot is gone, so a
 * read of the pinned ref reports `SNAPSHOT_UNAVAILABLE` until the dataset is re-materialised.
 */
export class DuckDbProjectDatasetAdapter
  implements ProjectDatasetWriterPort, ProjectDatasetQueryPort, ProjectSnapshotQueryPort
{
  readonly backend = DUCKDB_PROJECT_DATASET_BACKEND
  readonly #engine: DuckDbEngine
  readonly #snapshots = new Map<string, StagedSnapshot>()
  readonly #active = new Map<string, ActiveProjectQuery>()
  #writeTail: Promise<void> = Promise.resolve()
  #started = false

  constructor(options: { readonly instancePath?: string } = {}) {
    this.#engine = new DuckDbEngine(options.instancePath === undefined ? {} : { instancePath: options.instancePath, writableProjection: true })
  }

  async start(): Promise<void> {
    if (this.#started) return
    await this.#engine.start()
    await this.#engine.runTrusted('CREATE TABLE IF NOT EXISTS "project_dataset_metadata" (snapshot_id VARCHAR PRIMARY KEY, metadata VARCHAR NOT NULL, schema_digest VARCHAR NOT NULL, canonical_digest VARCHAR NOT NULL)')
    this.#started = true
  }

  close(): void {
    this.#engine.close()
    this.#snapshots.clear()
    this.#started = false
  }

  async stageSnapshot(
    scopeRef: ScopeRef,
    input: ProjectDatasetStageInput,
    ctx: ToolContext,
  ): Promise<ProjectDatasetStageResult> {
    const previous = this.#writeTail
    let release: () => void = () => undefined
    this.#writeTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await this.#stageSnapshot(scopeRef, input, ctx) } finally { release() }
  }

  async #stageSnapshot(scopeRef: ScopeRef, input: ProjectDatasetStageInput, ctx: ToolContext): Promise<ProjectDatasetStageResult> {
    assertScope(scopeRef, ctx)
    assertProjectDatasetSnapshotShape({ ref: input.snapshotRef, body: input.body })
    if (input.body.backend !== this.backend) throw new ProjectDatasetError('INVALID_ARGUMENT', 'the snapshot declares a different business backend')
    await this.start()
    const { body, snapshotRef } = input
    const snapshotId = snapshotRef.id
    const { rows: _rows, ...snapshotBody } = body
    void _rows
    const metadata: ProjectDatasetSnapshotMetadata = { scopeRef, snapshotRef, body: snapshotBody, decimalScales: decimalScalesOf(body.columns, body.rows), rowContentDigest: sha256DigestOf(canonicalJson(body.rows)) }
    const existing = await this.#restore(scopeRef, snapshotId)
    if (existing !== undefined) {
      if (canonicalJson({ ...existing.metadata, activation: undefined, body: { ...existing.metadata.body, recordedAt: '' } }) !== canonicalJson({ ...metadata, activation: undefined, body: { ...metadata.body, recordedAt: '' } }) || existing.canonicalDigest !== input.canonicalDigest) throw new ProjectDatasetError('IDEMPOTENCY_CONFLICT', 'the snapshot identity already carries different content')
      return { snapshotRef, rowCount: existing.rowCount, schemaDigest: existing.schemaDigest, canonicalDigest: existing.canonicalDigest, created: false }
    }
    await this.#engine.runTrusted('BEGIN TRANSACTION')
    try {
      const scopeKey = `${scopeKeyOf(scopeRef)}`
      const table = tableFor(snapshotId)
      const columns = body.columns
      const definitions = [
        `${quoteIdentifier('record_id')} VARCHAR NOT NULL`,
        `${quoteIdentifier('object_id')} VARCHAR NOT NULL`,
        `${quoteIdentifier('source_row_key')} VARCHAR NOT NULL`,
        `${quoteIdentifier('values_json')} VARCHAR NOT NULL`,
        `${quoteIdentifier('sources_json')} VARCHAR NOT NULL`,
        ...columns.map((column) => `${quoteIdentifier(column.name)} ${physicalTypeOfProject(column.valueType, metadata.decimalScales?.[column.name])}`),
      ].join(', ')
      await this.#engine.runTrusted(`CREATE TABLE ${quoteIdentifier(table)} (${definitions})`)

      // The canonical columns keep their exact physical type: a quantity is inserted through an
      // explicit DECIMAL cast of its exact decimal string (never a float), so a later numeric
      // comparison is a real numeric comparison, not a lexical one.
      const columnPlaceholders = columns
        .map((column) => `CAST(? AS ${physicalTypeOfProject(column.valueType, metadata.decimalScales?.[column.name])})`)
        .join(', ')
      const placeholders = `(${['?', '?', '?', '?', '?', columnPlaceholders].join(', ')})`
      const rows = body.rows
      for (let start = 0; start < rows.length; start += INSERT_BATCH) {
        const batch = rows.slice(start, start + INSERT_BATCH)
        const valuesSql = batch.map(() => placeholders).join(', ')
        const parameters = batch.flatMap((row) => [
          row.recordId,
          row.objectId,
          row.sourceRowKey,
          valuesJsonOf(row),
          sourcesJsonOf(row),
          ...columns.map((column) => {
            const cell = row.values[column.name]
            return cell === undefined ? null : typedCellValue(cell)
          }),
        ])
        await this.#engine.runTrusted(
          `INSERT INTO ${quoteIdentifier(table)}
             (${['record_id', 'object_id', 'source_row_key', 'values_json', 'sources_json', ...columns.map((column) => column.name)].map(quoteIdentifier).join(', ')})
           VALUES ${valuesSql}`,
          parameters,
        )
      }

      const persisted = await this.#readBack(table, columns)
      const storedDigest = canonicalDigestOf(columns, persisted)
      if (storedDigest !== input.canonicalDigest) {
        await this.#engine.runTrusted(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`).catch(() => undefined)
        throw new ProjectDatasetError('MATERIALIZATION_MISMATCH', 'the staged DuckDB rows did not match the canonical dataset digest')
      }
      await this.#engine.runTrusted('INSERT INTO "project_dataset_metadata" VALUES (?, ?, ?, ?)', [snapshotId, JSON.stringify(metadata), input.schemaDigest, storedDigest])
      await this.#engine.runTrusted('COMMIT')
      this.#snapshots.set(snapshotId, {
        scopeKey,
        snapshotId,
        objectId: body.objectId,
        version: snapshotRef.version,
        table,
        columns,
        rowCount: persisted.length,
        schemaDigest: input.schemaDigest,
        canonicalDigest: storedDigest,
        metadata,
      })
      return {
        snapshotRef,
        rowCount: persisted.length,
        schemaDigest: input.schemaDigest,
        canonicalDigest: storedDigest,
        created: true,
      }
    } catch (error) {
      await this.#engine.runTrusted('ROLLBACK').catch(() => undefined)
      throw error
    }
  }

  async discardSnapshot(scopeRef: ScopeRef, snapshotRef: { readonly id: string }, ctx: ToolContext): Promise<void> {
    assertScope(scopeRef, ctx)
    await this.start()
    const staged = await this.#restore(scopeRef, snapshotRef.id)
    if (staged === undefined) return
    if (staged.metadata.activation !== undefined) throw new ProjectDatasetError('FORBIDDEN', 'an activated historical snapshot cannot be discarded')
    this.#snapshots.delete(snapshotRef.id)
    await this.#engine.runTrusted('DELETE FROM "project_dataset_metadata" WHERE snapshot_id = ?', [snapshotRef.id])
    await this.#engine.runTrusted(`DROP TABLE IF EXISTS ${quoteIdentifier(tableFor(snapshotRef.id))}`)
  }

  async recordActivation(scopeRef: ScopeRef, receipt: ProjectDatasetActivationReceipt, ctx: ToolContext): Promise<void> {
    assertScope(scopeRef, ctx)
    assertProjectDatasetActivationShape(receipt)
    if (!ctx.principal.roles.some((role) => ['operator', 'profile-editor', 'platform-admin'].includes(role))) throw new ProjectDatasetError('FORBIDDEN', 'snapshot activation is a host materialization operation')
    await this.start()
    const staged = await this.#restore(scopeRef, receipt.snapshotRef.id)
    if (staged === undefined) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the activated snapshot is missing')
    if (staged.metadata.activation !== undefined) return
    const metadata = { ...staged.metadata, activation: receipt }
    assertProjectDatasetMetadataShape(metadata)
    await this.#engine.runTrusted('UPDATE "project_dataset_metadata" SET metadata = ? WHERE snapshot_id = ?', [JSON.stringify(metadata), receipt.snapshotRef.id])
  }

  async getActivation(scopeRef: ScopeRef, snapshotRef: ProjectDatasetRef, ctx: ToolContext): Promise<ProjectDatasetActivationReceipt | undefined> {
    assertScope(scopeRef, ctx)
    await this.start()
    const staged = await this.#restore(scopeRef, snapshotRef.id)
    return staged !== undefined && canonicalJson(staged.metadata.snapshotRef) === canonicalJson(snapshotRef) ? staged.metadata.activation : undefined
  }

  async querySnapshot(
    scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectDatasetQueryResult> {
    assertScope(scopeRef, ctx)
    await this.start()
    const staged = await this.#restore(scopeRef, request.snapshotRef.id)
    if (staged === undefined || canonicalJson(staged.metadata.snapshotRef) !== canonicalJson(request.snapshotRef)) {
      throw new ProjectDatasetError(
        'SNAPSHOT_UNAVAILABLE',
        'the pinned dataset snapshot is not materialised in this DuckDB backend',
      )
    }
    if (request.objectId !== undefined && request.objectId !== staged.objectId) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the snapshot belongs to a different project object')
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
    const cursorPin = sha256DigestOf(canonicalJson({ scopeRef, snapshotRef: request.snapshotRef, objectId: request.objectId ?? null }))
    const offset = decodeCursor(request.cursor, cursorPin)
    const session = await this.#engine.createSession()
    try {
      const objectFilter = request.objectId === undefined ? '' : ` WHERE ${quoteIdentifier('object_id')} = ?`
      const parameters = request.objectId === undefined ? [] : [request.objectId]
      const execution = await session.executeReadOnly(
        `SELECT ${['record_id', 'object_id', 'source_row_key', 'values_json', 'sources_json'].map(quoteIdentifier).join(', ')}
           FROM ${quoteIdentifier(staged.table)}${objectFilter}
          ORDER BY ${quoteIdentifier('record_id')}
          LIMIT ${String(limit + 1)} OFFSET ${String(offset)}`,
        parameters,
        limit + 1,
      )
      const rawRows = execution.rawRows
      const truncated = rawRows.length > limit
      const kept = truncated ? rawRows.slice(0, limit) : rawRows
      const rows: ProjectDatasetReadRow[] = kept.map((raw) => ({
        recordId: String(raw[0]),
        objectId: String(raw[1]),
        sourceRowKey: String(raw[2]),
        values: JSON.parse(String(raw[3])) as Record<string, ProjectDatasetCell>,
        sources: JSON.parse(String(raw[4])) as ProjectDatasetFieldSource[],
      }))
      const nextCursor = truncated ? encodeCursor(offset + kept.length, cursorPin) : null
      const coverage: ToolCoverage = {
        returned: rows.length,
        truncated,
        completeness: 'complete',
        ...(nextCursor === null ? {} : { cursor: nextCursor }),
      }
      return { snapshotRef: request.snapshotRef, columns: staged.columns, rows, coverage }
    } finally {
      session.close()
    }
  }

  /**
   * Report the fixed physical relation a snapshot was materialised as. `undefined` when the
   * snapshot is not staged in this backend (a restart, another scope, or a never-written ref),
   * so a caller must report `SNAPSHOT_UNAVAILABLE` instead of reading another dataset.
   */
  async describeSnapshot(
    scopeRef: ScopeRef,
    snapshotRef: ProjectDatasetRef,
    ctx: ToolContext,
  ): Promise<ProjectSnapshotQueryDescriptor | undefined> {
    assertScope(scopeRef, ctx)
    await this.start()
    const staged = await this.#restore(scopeRef, snapshotRef.id)
    if (staged === undefined || canonicalJson(staged.metadata.snapshotRef) !== canonicalJson(snapshotRef)) return undefined
    return {
      snapshotRef,
      objectId: staged.objectId,
      dialect: 'duckdb',
      schema: 'main',
      relation: staged.table,
      relationKind: 'table',
      sourceObjectRef: projectDatasetSourceObjectRef(staged.snapshotId, staged.objectId),
      columns: staged.columns,
      metadata: staged.metadata,
    }
  }

  /** The AST/object whitelist for the query path is exactly the staged snapshot relations. */
  #registry(ctx: ToolContext): RelationRegistry {
    return new RelationRegistry(
      [...this.#snapshots.values()].filter((staged) => staged.scopeKey === scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })).map((staged) => this.#registeredRelation(staged)),
    )
  }

  #registeredRelation(staged: StagedSnapshot): RegisteredRelation {
    return {
      relation: staged.table,
      objectRef: projectDatasetSourceObjectRef(staged.snapshotId, staged.objectId),
      schemaRevision: staged.version,
      columns: staged.columns.map((column) => ({
        name: column.name,
        type: canonicalColumnTypeOfProject(column.valueType),
      })),
      physicalTypes: Object.fromEntries(
        staged.columns.map((column) => [column.name, physicalTypeOfProject(column.valueType, staged.metadata.decimalScales?.[column.name])]),
      ),
    }
  }

  /**
   * Static pre-execution check of one generated plan (LOCAL-077): the DuckDB AST sandbox
   * resolves every relation against the staged snapshot relations, refuses any object outside
   * the trusted source allowlist and binds the declared parameters. It opens no connection.
   */
  async validate(
    request: StructuredQueryValidateRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryValidateResponse> {
    try {
      assertTrusted(ctx)
      const plan = request.plan
      if (plan.mode !== 'direct') {
        return this.#rejected('UNSUPPORTED_QUERY', 'only direct SQL plans are validated by this adapter')
      }
      await this.#restoreDeclared(plan.referencedObjects, ctx)
      const checked = this.#checkPlan(plan, ctx)
      return { valid: true, normalizedPlan: { ...plan, sql: checked.cleanedSql }, warnings: [] }
    } catch (error) {
      if (error instanceof DuckDbAdapterError) {
        return this.#rejected(error.code === 'FORBIDDEN' ? 'FORBIDDEN' : error.code === 'SNAPSHOT_UNAVAILABLE' ? 'SNAPSHOT_UNAVAILABLE' : error.code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'UNSUPPORTED_QUERY', error.message)
      }
      const detail = error instanceof Error ? error.message : 'the plan could not be validated'
      return this.#rejected('UNSUPPORTED_QUERY', detail)
    }
  }

  async execute(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryExecuteResponse> {
    assertTrusted(ctx)
    const target: ActiveProjectQuery = { scopeKey: scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }), runId: ctx.runId, session: undefined, cancelled: false, running: false }
    const targetRef = globalThis.crypto.randomUUID()
    this.#active.set(targetRef, target)
    try { return await this.#execute(request, ctx, target) } finally { this.#active.delete(targetRef) }
  }

  async #execute(request: StructuredQueryExecuteRequest, ctx: ToolContext, target: ActiveProjectQuery): Promise<StructuredQueryExecuteResponse> {
    const plan = request.plan
    if (plan.mode !== 'direct') {
      throw new DuckDbAdapterError('UNSUPPORTED_QUERY', 'only direct SQL plans are executed by this adapter')
    }
    await this.#restoreDeclared(plan.referencedObjects, ctx)
    const checked = this.#checkPlan(plan, ctx)
    const cursorPin = sha256DigestOf(canonicalJson({ scope: scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }), plan }))
    const offset = decodeCursor(request.cursor, cursorPin)
    const maxRows = Math.min(request.limits.maxRows, ctx.allowedResources.maxRows)
    if (target.cancelled) throw new DuckDbAdapterError('CANCELLED', 'the project query was cancelled before execution')
    const session = await this.#engine.createSession()
    target.session = session
    const duration = Math.min(request.limits.maxDurationMs, Date.parse(ctx.deadline) - Date.now())
    if (duration <= 0) { session.close(); throw new DuckDbAdapterError('DEADLINE_EXCEEDED', 'the project query deadline expired') }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; session.interrupt() }, duration)
    let page: {
      readonly columns: readonly QueryColumn[]
      readonly rows: readonly unknown[][]
      readonly truncated: boolean
    }
    try {
      const execution = await session.executeReadOnly(`SELECT * FROM (${checked.cleanedSql}) AS "ontology_page" LIMIT ${String(maxRows + 1)} OFFSET ${String(offset)}`, plan.parameters, maxRows, {
        beforeExecute: () => {
          if (target.cancelled) throw new DuckDbAdapterError('CANCELLED', 'the project query was cancelled before execution')
          if (timedOut) throw new DuckDbAdapterError('DEADLINE_EXCEEDED', 'the project query deadline expired')
        },
        onExecuting: () => { target.running = true },
      })
      if (timedOut) throw new DuckDbAdapterError('DEADLINE_EXCEEDED', 'the project query deadline expired')
      if (target.cancelled) throw new DuckDbAdapterError('CANCELLED', 'the project query was cancelled')
      page = this.#buildPage(execution, request.limits.maxBytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'the DuckDB query failed'
      if (error instanceof DuckDbAdapterError) throw error
      throw new DuckDbAdapterError(timedOut ? 'DEADLINE_EXCEEDED' : target.cancelled ? 'CANCELLED' : 'INTERNAL_ERROR', message, { cause: error })
    } finally {
      clearTimeout(timer)
      session.close()
    }
    const truncated = page.truncated
    const coverage: ToolCoverage = {
      returned: page.rows.length,
      truncated,
      completeness: truncated ? 'truncated' : 'complete',
      ...(truncated ? { cursor: encodeCursor(offset + page.rows.length, cursorPin) } : {}),
    }
    const relation = checked.referenced[0]
    const snapshot: SourceSnapshot = {
      sourceRef: projectDatasetSourceRef(relation?.objectRef.sourceRef.sourceId ?? 'unavailable'),
      schemaVersion: relation?.schemaRevision ?? checked.cleanedSql.length.toString(),
      readAt: new Date().toISOString(),
      consistency: 'immutable',
      resultDigest: resultDigestOf({ columns: page.columns, rows: page.rows }),
    }
    return {
      snapshot,
      columns: [...page.columns],
      rows: [...page.rows],
      nextCursor: coverage.cursor ?? null,
      coverage,
    }
  }

  /** The project query path is a bounded in-process read; a caller-side signal stops waiting. */
  activeTargets(): readonly string[] { return [...this.#active.keys()] }
  /** Execution probe used to verify native interrupt rather than a queued cancellation. */
  runningTargets(): readonly string[] { return [...this.#active].filter(([, target]) => target.running).map(([id]) => id) }

  async cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse> {
    assertTrusted(ctx)
    const target = this.#active.get(request.targetRef)
    const acceptedAt = new Date().toISOString()
    if (target === undefined) return { targetRef: request.targetRef, state: 'already_terminal', acceptedAt }
    if (target.runId !== ctx.runId || target.scopeKey !== scopeKeyOf({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })) throw new ProjectDatasetError('FORBIDDEN', 'a foreign query cannot be cancelled')
    target.cancelled = true
    target.session?.interrupt()
    return { targetRef: request.targetRef, state: 'cancelling', acceptedAt }
  }

  #checkPlan(
    plan: StructuredQueryExecuteRequest['plan'],
    ctx: ToolContext,
  ): { readonly cleanedSql: string; readonly referenced: readonly RegisteredRelation[] } {
    if (plan.mode !== 'direct' || plan.statementKind !== 'select' || plan.readOnly !== true) {
      throw new DuckDbAdapterError('UNSUPPORTED_QUERY', 'only read-only SELECT plans are accepted')
    }
    const validation = validateSql({
      sql: plan.sql,
      registry: this.#registry(ctx),
      allowedTableFunctions: new Set(),
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
          `the snapshot source "${relation.objectRef.sourceRef.sourceId}" is not in the trusted allowlist`,
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
      throw new DuckDbAdapterError('UNSUPPORTED_QUERY', 'a query must read at least one snapshot object')
    }
    return {
      cleanedSql: plan.sql.slice(0, validation.parsed.endOffset).trim(),
      referenced: validation.referencedRelations,
    }
  }

  #buildPage(
    execution: SessionExecution,
    maxBytes: number,
  ): { readonly columns: readonly QueryColumn[]; readonly rows: readonly unknown[][]; readonly truncated: boolean } {
    const columns: QueryColumn[] = execution.columnNames.map((name, index) => ({
      name,
      type: normaliseColumnType(execution.columnTypeIds[index] ?? DuckDBTypeId.INVALID),
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
      if (bytes + rowBytes > maxBytes) {
        if (rows.length === 0) throw new DuckDbAdapterError('RESULT_TOO_LARGE', 'a project query row exceeds the byte budget')
        byteTruncated = true
        break
      }
      bytes += rowBytes
      rows.push(row)
    }
    return { columns, rows, truncated: execution.truncated || byteTruncated }
  }

  #rejected(code: PlatformError['code'], message: string): StructuredQueryValidateResponse {
    return { valid: false, warnings: [], rejectedReason: { code, message, retryable: false } }
  }

  async #restore(scope: ScopeRef, id: string): Promise<StagedSnapshot | undefined> {
    const session = await this.#engine.createSession()
    try {
      const result = await session.executeReadOnly('SELECT metadata, schema_digest, canonical_digest FROM "project_dataset_metadata" WHERE snapshot_id = ?', [id], 1)
      const row = result.rawRows[0]
      if (row === undefined) return undefined
      const raw: unknown = JSON.parse(String(row[0]))
      if (!isRecord(raw) || !isRecord(raw['scopeRef']) || raw['scopeRef']['tenantId'] !== scope.tenantId || raw['scopeRef']['spaceId'] !== scope.spaceId || !isRecord(raw['body'])) return undefined
      assertProjectDatasetMetadataShape(raw)
      const metadata = raw
      if (metadata.snapshotRef.id !== id) return undefined
      const relation = await session.executeReadOnly('SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', ['main', tableFor(id)], 1)
      if (relation.rawRows.length === 0) { this.#snapshots.delete(id); return undefined }
      const verified = await session.executeReadOnly(`SELECT ${['record_id', 'object_id', 'source_row_key', 'values_json', 'sources_json', ...metadata.body.columns.map((column) => column.name)].map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(tableFor(id))} ORDER BY "record_id" LIMIT 20001`, [], 20001)
      const persisted: ProjectDatasetRow[] = verified.rawRows.map((row) => ({ recordId: String(row[0]), objectId: String(row[1]), sourceRowKey: String(row[2]),
        values: JSON.parse(String(row[3])) as Record<string, ProjectDatasetCell>, sources: JSON.parse(String(row[4])) as ProjectDatasetFieldSource[] }))
      const physical = verified.rawRows.map((row, rowIndex) => ({ recordId: String(row[0]), values: Object.fromEntries(metadata.body.columns.map((column, columnIndex) => {
        const index = columnIndex + 5
        return [column.name, normaliseValue(verified.columnTypeIds[index] ?? 0, row[index], verified.jsRows[rowIndex]?.[index])]
      })) }))
      assertProjectDatasetSnapshotShape({ ref: metadata.snapshotRef, body: { ...metadata.body, rows: persisted } })
      if (persisted.length !== metadata.body.coverage.processedCount || metadata.rowContentDigest !== sha256DigestOf(canonicalJson(persisted)) ||
        canonicalDigestOf(metadata.body.columns, persisted) !== String(row[2]) || sha256DigestOf(canonicalJson(metadata.body.columns)) !== String(row[1]) ||
        !projectDatasetPhysicalCellsMatch(metadata.body.columns, persisted, physical)) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the immutable DuckDB projection JSON or typed columns changed')
      const staged: StagedSnapshot = { scopeKey: scopeKeyOf(scope), snapshotId: id, objectId: metadata.body.objectId,
        version: metadata.snapshotRef.version, table: tableFor(id), columns: metadata.body.columns, rowCount: metadata.body.coverage.processedCount,
        schemaDigest: String(row[1]), canonicalDigest: String(row[2]), metadata }
      this.#snapshots.set(id, staged)
      return staged
    } finally { session.close() }
  }

  async #restoreDeclared(objects: readonly import('@ontology/contracts').SourceObjectRef[], ctx: ToolContext): Promise<void> {
    await this.start()
    if (objects.length > 1) throw new DuckDbAdapterError('UNSUPPORTED_QUERY', 'project queries address one fixed snapshot')
    for (const object of objects) {
      if (object.sourceRef.namespace !== 'project-dataset') continue
      const staged = await this.#restore({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, object.sourceRef.sourceId)
      if (staged === undefined) throw new DuckDbAdapterError('SNAPSHOT_UNAVAILABLE', 'the scoped fixed project snapshot is unavailable')
    }
  }

  async #readBack(table: string, columns: readonly ProjectDatasetColumn[]): Promise<ProjectDatasetRow[]> {
    void columns
    const rows = await this.#engine.readTrusted(`SELECT ${['record_id', 'object_id', 'source_row_key', 'values_json', 'sources_json'].map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier('record_id')}`)
    return rows.map((raw) => ({ recordId: String(raw[0]), objectId: String(raw[1]), sourceRowKey: String(raw[2]),
      values: JSON.parse(String(raw[3])) as Record<string, ProjectDatasetCell>, sources: JSON.parse(String(raw[4])) as ProjectDatasetFieldSource[] }))
  }
}
