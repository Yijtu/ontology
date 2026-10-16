import type { QueryResultRow } from 'pg'
import {
  ModelSelectionError,
  ToolConnectionError,
  assertModelExecutionSnapshotShape,
  assertToolExecutionSnapshotShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ModelExecutionConnectionSnapshot,
  ModelExecutionSnapshotStore,
  RevisionString,
  ScopeRef,
  ToolContext,
  ToolExecutionConnectionSnapshot,
  ToolExecutionSnapshotStore,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, digestOfCanonical } from '@ontology/core'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface SnapshotRow extends QueryResultRow {
  snapshot: Record<string, unknown>
}

/** The snapshot port error codes; all four are valid in both the tool and model error unions. */
type SnapshotErrorCode = 'STORE_FAILED' | 'VERSION_CONFLICT' | 'SCOPE_MISMATCH' | 'INVALID_ARGUMENT'

/**
 * PostgreSQL execution-connection snapshots (design §9, S02).
 *
 * One row per (kind, connection_id, revision); the row is write-once per revision so a pinned config
 * can never be rewritten under a running execution. The store never touches a credential: a snapshot
 * is validated to reject any credential-shaped field before it is written.
 *
 * The same class serves the tool and model ports; `kind` keeps the two catalogues apart even though
 * they share the table shape. Each write stores the digest of the canonical snapshot so a reader can
 * detect a snapshot that was replaced rather than edited.
 */
export class PostgresExecutionConnectionSnapshotStore implements ToolExecutionSnapshotStore, ModelExecutionSnapshotStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putToolSnapshot(
    scopeRef: ScopeRef,
    snapshot: ToolExecutionConnectionSnapshot,
    ctx: ToolContext,
  ): Promise<ToolExecutionConnectionSnapshot> {
    assertToolExecutionSnapshotShape(snapshot)
    return this.#put('tool', scopeRef, ctx, snapshot.connectionId, snapshot.connectionRevision, snapshot, (row) => {
      assertToolExecutionSnapshotShape(row)
      return row
    })
  }

  async getToolSnapshot(
    scopeRef: ScopeRef,
    connectionId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ToolExecutionConnectionSnapshot | undefined> {
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#get('tool', scopeRef, ctx, connectionId, revision, (row) => {
      assertToolExecutionSnapshotShape(row)
      return row
    })
  }

  async putModelSnapshot(
    scopeRef: ScopeRef,
    snapshot: ModelExecutionConnectionSnapshot,
    ctx: ToolContext,
  ): Promise<ModelExecutionConnectionSnapshot> {
    assertModelExecutionSnapshotShape(snapshot)
    return this.#put('model', scopeRef, ctx, snapshot.connectionId, snapshot.revision, snapshot, (row) => {
      assertModelExecutionSnapshotShape(row)
      return row
    })
  }

  async getModelSnapshot(
    scopeRef: ScopeRef,
    connectionId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ModelExecutionConnectionSnapshot | undefined> {
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#get('model', scopeRef, ctx, connectionId, revision, (row) => {
      assertModelExecutionSnapshotShape(row)
      return row
    })
  }

  async #put<T>(
    kind: 'tool' | 'model',
    scopeRef: ScopeRef,
    ctx: ToolContext,
    connectionId: Uuid,
    revision: RevisionString,
    snapshot: T,
    validate: (row: unknown) => T,
  ): Promise<T> {
    const digest = digestOfCanonical(snapshot)
    return this.#withScope(kind, scopeRef, ctx, async (query) => {
      const inserted = await query.query<SnapshotRow>(
        `INSERT INTO agent_platform.execution_connection_snapshots
           (tenant_id, space_id, kind, connection_id, revision, snapshot, snapshot_digest, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1,
           $2::uuid, $3::bigint, $4::jsonb, $5, now())
         ON CONFLICT (tenant_id, space_id, kind, connection_id, revision) DO NOTHING
         RETURNING snapshot`,
        [kind, connectionId, revision, canonicalJson(snapshot), digest],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return validate(row.snapshot)
      // The row already exists: a revision's snapshot is immutable, so re-read it instead of
      // rewriting it. An attempt to store a *different* snapshot for the same revision is a conflict.
      const existing = await this.#byKey(query, kind, connectionId, revision)
      if (existing === undefined) throw this.#error(kind, 'STORE_FAILED', 'the execution connection snapshot could not be written')
      if (canonicalJson(existing.snapshot) !== canonicalJson(snapshot)) {
        throw this.#error(kind, 'VERSION_CONFLICT', 'the execution connection snapshot for this revision is already fixed and differs')
      }
      return validate(existing.snapshot)
    })
  }

  async #get<T>(
    kind: 'tool' | 'model',
    scopeRef: ScopeRef,
    ctx: ToolContext,
    connectionId: Uuid,
    revision: RevisionString,
    validate: (row: unknown) => T,
  ): Promise<T | undefined> {
    return this.#withScope(kind, scopeRef, ctx, async (query) => {
      const row = await this.#byKey(query, kind, connectionId, revision)
      if (row === undefined) return undefined
      try {
        return validate(row.snapshot)
      } catch (error) {
        throw this.#error(kind, 'STORE_FAILED', 'a stored execution connection snapshot is malformed', error)
      }
    })
  }

  #error(kind: 'tool' | 'model', code: SnapshotErrorCode, message: string, cause?: unknown): Error {
    const options = cause === undefined ? undefined : { cause }
    return kind === 'model'
      ? new ModelSelectionError(code, message, options)
      : new ToolConnectionError(code, message, options)
  }

  async #byKey(
    query: ScopedQuery,
    kind: 'tool' | 'model',
    connectionId: string,
    revision: RevisionString,
  ): Promise<SnapshotRow | undefined> {
    const result = await query.query<SnapshotRow>(
      `SELECT snapshot FROM agent_platform.execution_connection_snapshots
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND kind = $1 AND connection_id = $2::uuid AND revision = $3::bigint`,
      [kind, connectionId, revision],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    kind: 'tool' | 'model',
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw this.#error(kind, 'SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw this.#error(kind, 'SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw this.#error(kind, 'SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
