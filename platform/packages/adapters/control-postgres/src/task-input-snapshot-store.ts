import type { QueryResultRow } from 'pg'
import { assertTaskInputSnapshotShape, isToolContext } from '@ontology/contracts'
import { ControlStorageError } from './errors'
import type {
  ResourceRef,
  ScopeRef,
  TaskInputSnapshot,
  TaskInputSnapshotBody,
  TaskInputSnapshotStore,
  ToolContext,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface SnapshotRow extends QueryResultRow {
  body: TaskInputSnapshotBody
  same_content?: boolean
}

/**
 * Real PostgreSQL implementation of the trusted derived-input snapshot store (SPEC v0.3a
 * §EX-2.1).
 *
 * A snapshot is immutable per exact ref: the body pins the base project revision and approved
 * input it derives from, but never its own digest. Re-writing the same body is a no-op; a
 * conflicting body under the same ref is refused, so a run admission can never be redirected to
 * a different input. Reads stay inside the trusted scope through RLS.
 */
export class PostgresTaskInputSnapshotStore implements TaskInputSnapshotStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putSnapshot(
    scopeRef: ScopeRef,
    snapshot: TaskInputSnapshot,
    ctx: ToolContext,
  ): Promise<void> {
    assertTaskInputSnapshotShape(snapshot)
    const ref = snapshot.ref
    const body = snapshot.body
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<SnapshotRow>(
        `INSERT INTO agent_platform.task_input_snapshots
           (tenant_id, space_id, snapshot_id, version, digest, project_id, project_revision, body, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::uuid, $5::bigint, $6::jsonb, $7::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, snapshot_id, version, digest) DO NOTHING
         RETURNING body`,
        [
          ref.id,
          ref.version,
          ref.digest,
          body.projectRevisionRef.projectId,
          body.projectRevisionRef.revision,
          JSON.stringify(body),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows[0] !== undefined) return
      // JSONB does not preserve key order; equality is decided by PostgreSQL so a byte-identical
      // re-write is a no-op while a genuinely different body is refused.
      const existing = await query.query<SnapshotRow>(
        `SELECT body, (body = $4::jsonb) AS same_content
           FROM agent_platform.task_input_snapshots
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND snapshot_id = $1 AND version = $2 AND digest = $3`,
        [ref.id, ref.version, ref.digest, JSON.stringify(body)],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `task input snapshot ${ref.id} already exists with different content`,
        )
      }
    })
  }

  async getSnapshot(
    scopeRef: ScopeRef,
    snapshotRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<TaskInputSnapshot | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SnapshotRow>(
        `SELECT body FROM agent_platform.task_input_snapshots
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND snapshot_id = $1 AND version = $2 AND digest = $3`,
        [snapshotRef.id, snapshotRef.version, snapshotRef.digest],
      )
      const body = result.rows[0]?.body
      return body === undefined ? undefined : { ref: snapshotRef, body }
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ControlStorageError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
