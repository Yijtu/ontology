import type { QueryResultRow } from 'pg'
import {
  ToolConnectionError,
  assertToolConnectionDescriptorShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ResourceRef,
  ScopeRef,
  ToolAdapterType,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionCredentialChange,
  ToolConnectionDescriptor,
  ToolConnectionProbeResult,
  ToolConnectionStore,
  ToolConnectionSummary,
  ToolCredentialState,
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

interface ConnectionRow extends QueryResultRow {
  connection_id: string
  revision: string
  name: string
  adapter_type: ToolAdapterType
  capabilities: ToolConnectionCapability[]
  enabled: boolean
  endpoint: string | null
  /** The stored descriptor jsonb; carries the optional search strategy / archive limits (S03). */
  descriptor: ToolConnectionDescriptor | null
  credential_ref: ResourceRef | null
  credential_state: ToolCredentialState
  probe_summary: ToolConnectionProbeResult | null
  updated_at: string
}

const CONNECTION_COLUMNS = `connection_id, revision::text AS revision, name, adapter_type,
  capabilities, enabled, endpoint, descriptor, credential_ref, credential_state, probe_summary,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`

function toSummary(row: ConnectionRow): ToolConnectionSummary {
  return {
    connectionId: row.connection_id,
    name: row.name,
    revision: row.revision,
    adapterType: row.adapter_type,
    capabilities: row.capabilities,
    enabled: row.enabled,
    credentialState: row.credential_state,
    ...(row.probe_summary === null ? {} : { probeSummary: row.probe_summary }),
    updatedAt: row.updated_at,
  }
}

function toAdminView(row: ConnectionRow): ToolConnectionAdminView {
  // The search strategy / archive limits are read back from the stored descriptor jsonb, so the
  // imported endpoint path, timeout and archive byte bound survive a restart (S03).
  const strategy = row.descriptor?.searchStrategy
  const limits = row.descriptor?.archiveLimits
  return {
    ...toSummary(row),
    ...(row.endpoint === null ? {} : { endpoint: row.endpoint }),
    ...(strategy === undefined ? {} : { searchStrategy: strategy }),
    ...(limits === undefined ? {} : { archiveLimits: limits }),
  }
}

/** The request digest the unique idempotency key is checked against (jsonb text is canonical). */
function digestExpression(index: number): string {
  return `md5($${String(index)}::jsonb::text)`
}

/**
 * PostgreSQL tool-connection catalogue (design §9).
 *
 * The row carries only non-secret metadata: the API key is a value behind `credential_ref`, an
 * opaque reference the host custodian resolves. Every statement runs inside the trusted scope's
 * transaction (RLS is a second layer behind the explicit predicate). A create/update is a
 * compare-and-swap on `revision`; re-using an idempotency key with a different descriptor is
 * `IDEMPOTENCY_CONFLICT` and a stale expected revision is `VERSION_CONFLICT`.
 */
export class PostgresToolConnectionStore implements ToolConnectionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async listConnections(
    scopeRef: ScopeRef,
    filter: { readonly enabled?: boolean; readonly capability?: ToolConnectionCapability; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<readonly ToolConnectionAdminView[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM agent_platform.tool_connections
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND ($1::boolean IS NULL OR enabled = $1)
             AND ($2::text IS NULL OR capabilities ? $2)
           ORDER BY updated_at DESC, connection_id
           LIMIT ${String(limit)}`,
        [filter.enabled ?? null, filter.capability ?? null],
      )
      return result.rows.map(toAdminView)
    })
  }

  async getConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ToolConnectionAdminView | undefined> {
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byConnectionId(query, connectionId)
      return row === undefined ? undefined : toAdminView(row)
    })
  }

  async putConnection(
    scopeRef: ScopeRef,
    input: {
      readonly connectionId?: Uuid
      readonly descriptor: ToolConnectionDescriptor
      readonly expectedRevision?: string
      readonly idempotencyKey: string
    },
    ctx: ToolContext,
  ): Promise<ToolConnectionAdminView> {
    assertToolConnectionDescriptorShape(input.descriptor)
    if (input.connectionId === undefined || !isUuid(input.connectionId)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a connection id must be minted by the caller')
    }
    const connectionId = input.connectionId
    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#byIdempotencyKey(query, input.idempotencyKey, JSON.stringify(input.descriptor))
      if (replay !== undefined) {
        if (!replay.descriptor_matches) {
          throw new ToolConnectionError('IDEMPOTENCY_CONFLICT', 'the idempotency key was already used with a different connection descriptor')
        }
        return toAdminView(replay)
      }

      const current = await this.#byConnectionId(query, connectionId)
      const descriptor = JSON.stringify(input.descriptor)
      if (current !== undefined) {
        if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) {
          throw new ToolConnectionError('VERSION_CONFLICT', 'the connection moved since it was read; re-read before writing')
        }
        const updated = await query.query<ConnectionRow>(
          `UPDATE agent_platform.tool_connections SET
             revision = revision + 1, name = $3, adapter_type = $4, capabilities = $5::jsonb,
             enabled = $6, endpoint = $7, descriptor = $8::jsonb, idempotency_key = $9,
             request_digest = ${digestExpression(8)}, actor = $10, updated_at = now()
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid AND revision = $2::bigint
           RETURNING ${CONNECTION_COLUMNS}`,
          [
            connectionId, current.revision, input.descriptor.name, input.descriptor.adapterType,
            JSON.stringify(input.descriptor.capabilities), input.descriptor.enabled,
            input.descriptor.endpoint ?? null, descriptor, input.idempotencyKey, ctx.principal.subjectId,
          ],
        )
        const updatedRow = updated.rows[0]
        if (updatedRow === undefined) {
          throw new ToolConnectionError('VERSION_CONFLICT', 'the connection moved during the write')
        }
        await this.#snapshot(query, updatedRow, ctx)
        return toAdminView(updatedRow)
      }

      if (input.expectedRevision !== undefined) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'no connection exists yet with this id')
      }
      const inserted = await query.query<ConnectionRow>(
        `INSERT INTO agent_platform.tool_connections
           (tenant_id, space_id, connection_id, revision, name, adapter_type, capabilities, enabled,
            endpoint, descriptor, idempotency_key, request_digest, actor, recorded_at, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, 1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, ${digestExpression(7)},
           $9, now(), now())
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          connectionId, input.descriptor.name, input.descriptor.adapterType,
          JSON.stringify(input.descriptor.capabilities), input.descriptor.enabled,
          input.descriptor.endpoint ?? null, descriptor, input.idempotencyKey, ctx.principal.subjectId,
        ],
      )
      const insertedRow = inserted.rows[0]
      if (insertedRow === undefined) throw new ToolConnectionError('STORE_FAILED', 'the connection could not be written')
      await this.#snapshot(query, insertedRow, ctx)
      return toAdminView(insertedRow)
    })
  }

  async deleteConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void> {
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `DELETE FROM agent_platform.tool_connections
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid`,
        [connectionId],
      )
    })
  }

  async setCredential(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly change: ToolConnectionCredentialChange },
    ctx: ToolContext,
  ): Promise<ToolConnectionSummary> {
    if (!isUuid(input.connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const setting = input.change.action === 'set'
      const updated = await query.query<ConnectionRow>(
        `UPDATE agent_platform.tool_connections SET
           revision = revision + 1,
           credential_ref = $2::jsonb,
           credential_state = $3,
           probe_summary = NULL,
           updated_at = now()
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND connection_id = $1::uuid
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          input.connectionId,
          setting ? JSON.stringify(input.change.credentialRef) : null,
          setting ? 'present' : 'missing',
        ],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new ToolConnectionError('NOT_FOUND', 'the connection is not visible in this scope')
      await this.#snapshot(query, row, ctx)
      return toSummary(row)
    })
  }

  async getCredentialRef(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ResourceRef | undefined> {
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ credential_ref: ResourceRef | null }>(
        `SELECT credential_ref FROM agent_platform.tool_connections
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid`,
        [connectionId],
      )
      return result.rows[0]?.credential_ref ?? undefined
    })
  }

  async recordProbe(scopeRef: ScopeRef, result: ToolConnectionProbeResult, ctx: ToolContext): Promise<ToolConnectionSummary> {
    if (result.connectionId === undefined || !isUuid(result.connectionId)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a recorded probe must name its connection')
    }
    if (result.connectionRevision === undefined) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a recorded probe must name the connection revision it tested')
    }
    const connectionId = result.connectionId
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<ConnectionRow>(
        `UPDATE agent_platform.tool_connections SET probe_summary = $2::jsonb, updated_at = now()
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid AND revision = $3::bigint
         RETURNING ${CONNECTION_COLUMNS}`,
        [connectionId, JSON.stringify(result), result.connectionRevision],
      )
      await query.query(
        `INSERT INTO agent_platform.tool_connection_tests
           (tenant_id, space_id, connection_id, revision, draft, credential_configured,
            search_status, search_reason, search_latency_ms, archive_status, archive_reason, archive_latency_ms, tested_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
        [
          connectionId, result.connectionRevision, result.draft, result.credentialConfigured,
          result.search.status, result.search.reason ?? null, result.search.latencyMs ?? null,
          result.archive.status, result.archive.reason ?? null, result.archive.latencyMs ?? null,
          result.testedAt,
        ],
      )
      const row = updated.rows[0]
      if (row === undefined) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'the connection revision changed before the probe was recorded')
      }
      return toSummary(row)
    })
  }

  async #byConnectionId(query: ScopedQuery, connectionId: string): Promise<ConnectionRow | undefined> {
    const result = await query.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM agent_platform.tool_connections
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND connection_id = $1::uuid`,
      [connectionId],
    )
    return result.rows[0]
  }

  async #byIdempotencyKey(
    query: ScopedQuery,
    key: string,
    descriptorJson: string,
  ): Promise<(ConnectionRow & { descriptor_matches: boolean }) | undefined> {
    const result = await query.query<ConnectionRow & { descriptor_matches: boolean }>(
      `SELECT ${CONNECTION_COLUMNS}, (descriptor = $2::jsonb) AS descriptor_matches
         FROM agent_platform.tool_connections
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND idempotency_key = $1`,
      [key, descriptorJson],
    )
    return result.rows[0]
  }

  async #snapshot(query: ScopedQuery, row: ConnectionRow, ctx: ToolContext): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.tool_connection_revisions
         (tenant_id, space_id, connection_id, revision, body, actor, recorded_at)
       VALUES (
         current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
         $1::uuid, $2::bigint, $3::jsonb, $4, now())
       ON CONFLICT (tenant_id, space_id, connection_id, revision) DO NOTHING`,
      [row.connection_id, row.revision, JSON.stringify(toSummary(row)), ctx.principal.subjectId],
    )
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ToolConnectionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
