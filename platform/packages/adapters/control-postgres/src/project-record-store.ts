import type { QueryResultRow } from 'pg'
import {
  ProjectMappingStoreError,
  assertProjectRecordVersionShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  AppendProjectRecordResult,
  NewProjectRecordVersion,
  ProjectMappingWriteMeta,
  ProjectRecordPage,
  ProjectRecordQuery,
  ProjectRecordStore,
  ProjectRecordVersion,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface RecordRow extends QueryResultRow {
  revision: string
  body: ProjectRecordVersion
  request_digest?: string
}

const RECORD_SELECT = 'revision::text AS revision, body'

/**
 * Real PostgreSQL implementation of the project-record store (SPEC v0.3a §3.3/§4.1).
 *
 * The store is append-only per `(project, record, revision)`. `appendRecords` compares the
 * incoming `content_digest` with the latest stored revision: an unchanged record reuses the
 * stored revision (so an at-least-once retry never duplicates), a changed one appends the next
 * revision. Reads return the latest revision per record and never rewrite history.
 */
export class PostgresProjectRecordStore implements ProjectRecordStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async appendRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    records: readonly NewProjectRecordVersion[],
    meta: ProjectMappingWriteMeta,
    ctx: ToolContext,
  ): Promise<AppendProjectRecordResult> {
    for (const record of records) {
      assertProjectRecordVersionShape({ ...record, revision: '1' })
      if (record.projectId !== projectId) {
        throw new ProjectMappingStoreError('INVALID_RECORD', 'every record must belong to the appended project')
      }
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      // Serialize append-only record heads with project/identity/publication fences.
      await query.query(`SELECT project_id FROM agent_platform.projects
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
          AND project_id=$1::uuid FOR UPDATE`, [projectId])
      const results: ProjectRecordVersion[] = []
      let created = false
      for (const record of records) {
        const latest = await this.#latest(query, projectId, record.recordId)
        if (latest !== undefined && latest.body.contentDigest === record.contentDigest) {
          results.push(latest.body)
          continue
        }
        const revision = latest === undefined ? '1' : (BigInt(latest.revision) + 1n).toString()
        const body: ProjectRecordVersion = { ...record, revision }
        const idempotencyKey = `${meta.idempotencyKey}:${record.recordId}`
        const inserted = await query
          .query<RecordRow>(
            `INSERT INTO agent_platform.project_record_versions
               (tenant_id, space_id, project_id, record_id, revision, mapping_id, mapping_version,
                object_id, source_row_key, source_digest, content_digest, body, status,
                idempotency_key, request_digest, actor, trace_id, recorded_at)
             VALUES (
               current_setting('app.tenant_id')::uuid,
               current_setting('app.space_id')::uuid,
               $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb, $11,
               $12, $13, $14, current_setting('app.trace_id', true), $15::timestamptz)
             ON CONFLICT (tenant_id, space_id, project_id, idempotency_key) DO NOTHING
             RETURNING ${RECORD_SELECT}`,
            [
              record.projectId,
              record.recordId,
              revision,
              record.mappingId,
              record.mappingVersion,
              record.objectId,
              record.sourceRowKey,
              record.sourceDigest,
              record.contentDigest,
              JSON.stringify(body),
              record.status,
              idempotencyKey,
              meta.requestDigest,
              record.actor,
              record.recordedAt,
            ],
          )
          .catch((error: unknown) => {
            if (pgCodeOf(error) === '23505') return { rows: [], rowCount: 0 }
            throw error
          })
        const row = inserted.rows[0]
        if (row !== undefined) {
          results.push(row.body)
          created = true
          continue
        }
        const replay = await this.#byIdempotencyKey(query, projectId, idempotencyKey)
        if (replay === undefined) {
          throw new ProjectMappingStoreError('INVALID_RECORD', 'the project record could not be written')
        }
        if (replay.body.contentDigest !== record.contentDigest) {
          throw new ProjectMappingStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different record payload',
          )
        }
        results.push(replay.body)
      }
      return { records: results, created }
    })
  }

  async listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    query: ProjectRecordQuery,
    ctx: ToolContext,
  ): Promise<ProjectRecordPage> {
    const limit = normalizeLimit(query.limit)
    return this.#withScope(scopeRef, ctx, async (scoped) => {
      const filtered = `SELECT DISTINCT ON (record_id) record_id, revision, body, object_id, status
                          FROM agent_platform.project_record_versions
                         WHERE tenant_id = current_setting('app.tenant_id')::uuid
                           AND space_id = current_setting('app.space_id')::uuid
                           AND project_id = $1::uuid
                         ORDER BY record_id, revision DESC`
      const filters = `($2::text IS NULL OR object_id = $2)
                         AND ($3::text IS NULL OR status = $3)
                         AND ($4::text IS NULL OR record_id::text > $4)`
      const rows = await scoped.query<RecordRow>(
        `SELECT revision::text AS revision, body FROM (${filtered}) latest
          WHERE ${filters}
          ORDER BY record_id ASC
          LIMIT $5`,
        [projectId, query.objectId ?? null, query.status ?? null, query.cursor ?? null, limit],
      )
      const totalResult = await scoped.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM (${filtered}) latest
          WHERE ($2::text IS NULL OR object_id = $2) AND ($3::text IS NULL OR status = $3)`,
        [projectId, query.objectId ?? null, query.status ?? null],
      )
      const records = rows.rows.map((row) => row.body)
      const total = Number(totalResult.rows[0]?.total ?? '0')
      const last = records[records.length - 1]
      return {
        records,
        total,
        ...(records.length < limit || last === undefined ? {} : { nextCursor: last.recordId }),
      }
    })
  }

  async getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRecordVersion | undefined> {
    if (!isUuid(recordId)) {
      throw new ProjectMappingStoreError('INVALID_RECORD', 'recordId must be a uuid')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const latest = await this.#latest(query, projectId, recordId)
      return latest?.body
    })
  }

  async #latest(
    query: ScopedQuery,
    projectId: Uuid,
    recordId: Uuid,
  ): Promise<RecordRow | undefined> {
    const result = await query.query<RecordRow>(
      `SELECT ${RECORD_SELECT} FROM agent_platform.project_record_versions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid AND record_id = $2::uuid
         ORDER BY revision DESC
         LIMIT 1`,
      [projectId, recordId],
    )
    return result.rows[0]
  }

  async #byIdempotencyKey(
    query: ScopedQuery,
    projectId: Uuid,
    key: string,
  ): Promise<RecordRow | undefined> {
    const result = await query.query<RecordRow>(
      `SELECT ${RECORD_SELECT} FROM agent_platform.project_record_versions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid AND idempotency_key = $2`,
      [projectId, key],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ProjectMappingStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ProjectMappingStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectMappingStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope(
      { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      async (client) => {
        await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
        return run({
          query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
        })
      },
    )
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ProjectMappingStoreError('INVALID_RECORD', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}
