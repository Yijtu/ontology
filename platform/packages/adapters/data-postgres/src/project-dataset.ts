import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import { sha256DigestOf } from '@ontology/core'
import { stableJson } from './canonical'
import { ProjectDatasetError, isToolContext } from '@ontology/contracts'
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

export const POSTGRES_PROJECT_DATASET_BACKEND = '@ontology/adapter-data-postgres:project-dataset'

const DEFAULT_SCHEMA = 'ontology_project_dataset'
const DEFAULT_PAGE_LIMIT = 250
const MAX_PAGE_LIMIT = 1_000
const INSERT_BATCH = 500

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const SNAPSHOT_TABLE = 'project_dataset_snapshots'
const ROW_TABLE = 'project_dataset_rows'

export interface PostgresProjectDatasetConfig {
  readonly connectionString: string
  /** A dedicated schema in an independent business database; never the control schema. */
  readonly schema?: string
  readonly maxPoolSize?: number
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

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}

function assertTrusted(ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'trusted context carries inconsistent scope')
  }
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
export class PostgresProjectDatasetAdapter implements ProjectDatasetWriterPort, ProjectDatasetQueryPort {
  readonly backend = POSTGRES_PROJECT_DATASET_BACKEND
  readonly #pool: Pool
  readonly #schema: string

  constructor(config: PostgresProjectDatasetConfig) {
    this.#schema = config.schema ?? DEFAULT_SCHEMA
    if (!IDENTIFIER.test(this.#schema)) {
      throw new ProjectDatasetError('INVALID_ARGUMENT', `invalid business schema "${this.#schema}"`)
    }
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 4,
      application_name: config.applicationName ?? 'ontology-project-dataset',
    })
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }

  async stageSnapshot(
    scopeRef: ScopeRef,
    input: ProjectDatasetStageInput,
    ctx: ToolContext,
  ): Promise<ProjectDatasetStageResult> {
    assertTrusted(ctx)
    void scopeRef
    await this.#ensureSchema()
    const { body, snapshotRef } = input
    const snapshotId = snapshotRef.id
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ${this.#table(SNAPSHOT_TABLE)}
           (snapshot_id, project_id, object_id, project_revision, backend, columns, row_count, schema_digest, canonical_digest, recorded_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::bigint, $5, $6::jsonb, $7::bigint, $8, $9, $10::timestamptz)
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
        ],
      )
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
      if (storedDigest !== input.canonicalDigest || persisted.length !== body.rows.length) {
        await client.query('ROLLBACK')
        await this.#deleteSnapshot(snapshotId)
        throw new ProjectDatasetError('MATERIALIZATION_MISMATCH', 'the staged PostgreSQL rows did not match the canonical dataset digest')
      }
      await client.query('COMMIT')
      return {
        snapshotRef,
        rowCount: persisted.length,
        schemaDigest: input.schemaDigest,
        canonicalDigest: storedDigest,
        created: true,
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
    assertTrusted(ctx)
    await this.#deleteSnapshot(snapshotRef.id)
    void scopeRef
  }

  async querySnapshot(
    scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectDatasetQueryResult> {
    assertTrusted(ctx)
    void scopeRef
    const meta = await this.#pool.query<MetaRow>(
      `SELECT columns, canonical_digest, row_count::text AS row_count FROM ${this.#table(SNAPSHOT_TABLE)} WHERE snapshot_id = $1::uuid`,
      [request.snapshotRef.id],
    )
    const record = meta.rows[0]
    if (record === undefined || record.canonical_digest !== request.snapshotRef.digest) {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the pinned dataset snapshot is not materialised in this PostgreSQL backend')
    }
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
    const offset = decodeCursor(request.cursor)
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
    const nextCursor = truncated ? encodeCursor(offset + kept.length) : null
    const coverage: ToolCoverage = {
      returned: rows.length,
      truncated,
      completeness: 'complete',
      ...(nextCursor === null ? {} : { cursor: nextCursor }),
    }
    return { snapshotRef: request.snapshotRef, columns: record.columns, rows, coverage }
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
         recorded_at timestamptz NOT NULL
       )`,
    )
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

  #table(name: string): string {
    return `${quoteIdentifier(this.#schema)}.${quoteIdentifier(name)}`
  }
}
