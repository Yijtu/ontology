import { sha256DigestOf } from '@ontology/core'
import {
  ProjectDatasetError,
  isToolContext,
} from '@ontology/contracts'
import type {
  ProjectDatasetCell,
  ProjectDatasetColumn,
  ProjectDatasetFieldSource,
  ProjectDatasetQueryPort,
  ProjectDatasetQueryRequest,
  ProjectDatasetQueryResult,
  ProjectDatasetReadRow,
  ProjectDatasetRow,
  ProjectDatasetStageInput,
  ProjectDatasetStageResult,
  ProjectDatasetWriterPort,
  ScopeRef,
  ToolContext,
  ToolCoverage,
} from '@ontology/contracts'
import { DuckDbEngine } from './engine'
import { canonicalJson } from './normalise'

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

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (isRecord(parsed)) {
      const offset = parsed['o']
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset
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

interface StagedSnapshot {
  readonly scopeKey: string
  readonly table: string
  readonly columns: readonly ProjectDatasetColumn[]
  readonly rowCount: number
  readonly schemaDigest: string
  readonly canonicalDigest: string
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
export class DuckDbProjectDatasetAdapter implements ProjectDatasetWriterPort, ProjectDatasetQueryPort {
  readonly backend = DUCKDB_PROJECT_DATASET_BACKEND
  readonly #engine: DuckDbEngine
  readonly #snapshots = new Map<string, StagedSnapshot>()
  #started = false

  constructor(options: { readonly instancePath?: string } = {}) {
    this.#engine = new DuckDbEngine(options.instancePath === undefined ? {} : { instancePath: options.instancePath })
  }

  async start(): Promise<void> {
    if (this.#started) return
    await this.#engine.start()
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
    assertTrusted(ctx)
    await this.start()
    const { body, snapshotRef } = input
    const snapshotId = snapshotRef.id
    const scopeKey = `${scopeKeyOf(scopeRef)}`
    const table = tableFor(snapshotId)
    const columns = body.columns
    const definitions = [
      `${quoteIdentifier('record_id')} VARCHAR NOT NULL`,
      `${quoteIdentifier('object_id')} VARCHAR NOT NULL`,
      `${quoteIdentifier('source_row_key')} VARCHAR NOT NULL`,
      `${quoteIdentifier('values_json')} VARCHAR NOT NULL`,
      `${quoteIdentifier('sources_json')} VARCHAR NOT NULL`,
      ...columns.map((column) => `${quoteIdentifier(column.name)} VARCHAR`),
    ].join(', ')
    await this.#engine.runTrusted(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`)
    await this.#engine.runTrusted(`CREATE TABLE ${quoteIdentifier(table)} (${definitions})`)

    const placeholders = `(${Array.from({ length: 5 + columns.length }, () => '?').join(', ')})`
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
          return cell === undefined ? null : canonicalCellText(cell)
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
    this.#snapshots.set(snapshotId, {
      scopeKey,
      table,
      columns,
      rowCount: persisted.length,
      schemaDigest: input.schemaDigest,
      canonicalDigest: storedDigest,
    })
    return {
      snapshotRef,
      rowCount: persisted.length,
      schemaDigest: input.schemaDigest,
      canonicalDigest: storedDigest,
      created: true,
    }
  }

  async discardSnapshot(scopeRef: ScopeRef, snapshotRef: { readonly id: string }, ctx: ToolContext): Promise<void> {
    assertTrusted(ctx)
    await this.start()
    this.#snapshots.delete(snapshotRef.id)
    await this.#engine.runTrusted(`DROP TABLE IF EXISTS ${quoteIdentifier(tableFor(snapshotRef.id))}`)
    void scopeRef
  }

  async querySnapshot(
    scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectDatasetQueryResult> {
    assertTrusted(ctx)
    await this.start()
    const staged = this.#snapshots.get(request.snapshotRef.id)
    if (staged === undefined || staged.scopeKey !== scopeKeyOf(scopeRef)) {
      throw new ProjectDatasetError(
        'SNAPSHOT_UNAVAILABLE',
        'the pinned dataset snapshot is not materialised in this DuckDB backend',
      )
    }
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
    const offset = decodeCursor(request.cursor)
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
      const nextCursor = truncated ? encodeCursor(offset + kept.length) : null
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

  async #readBack(table: string, columns: readonly ProjectDatasetColumn[]): Promise<ProjectDatasetRow[]> {
    const session = await this.#engine.createSession()
    try {
      const execution = await session.executeReadOnly(
        `SELECT ${['record_id', 'object_id', 'source_row_key', 'values_json', 'sources_json'].map(quoteIdentifier).join(', ')}
           FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier('record_id')}`,
        [],
        Number.MAX_SAFE_INTEGER,
      )
      void columns
      return execution.rawRows.map((raw) => ({
        recordId: String(raw[0]),
        objectId: String(raw[1]),
        sourceRowKey: String(raw[2]),
        values: JSON.parse(String(raw[3])) as Record<string, ProjectDatasetCell>,
        sources: JSON.parse(String(raw[4])) as ProjectDatasetFieldSource[],
      }))
    } finally {
      session.close()
    }
  }
}

function canonicalCellText(cell: ProjectDatasetCell): string {
  return cell.kind === 'quantity' ? `${cell.value} ${cell.unitCode}` : String(cell.value)
}
