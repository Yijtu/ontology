import type { QueryResultRow } from 'pg'
import {
  ModelSelectionError,
  assertModelConnectionDescriptorShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ModelAdapterType,
  ModelCapability,
  ModelConnectionAdminView,
  ModelCredentialState,
  ModelConnectionDescriptor,
  ModelConnectionStore,
  ModelConnectionSummary,
  ModelConnectionTestRecord,
  ModelConnectionTestSummary,
  ModelProtocol,
  ResourceRef,
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

interface ConnectionRow extends QueryResultRow {
  connection_id: string
  revision: string
  name: string
  adapter_type: ModelAdapterType
  protocol: ModelProtocol
  capabilities: ModelCapability[]
  enabled: boolean
  base_url: string | null
  endpoint: string | null
  platform_model_id: string
  provider_model_name: string
  credential_ref: ResourceRef | null
  credential_state: ModelCredentialState
  test_summary: ModelConnectionTestSummary | null
  updated_at: string
}

const CONNECTION_COLUMNS = `connection_id, revision::text AS revision, name, adapter_type, protocol,
  capabilities, enabled, base_url, endpoint, platform_model_id, provider_model_name,
  credential_ref, credential_state, test_summary,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`

function toSummary(row: ConnectionRow): ModelConnectionSummary {
  return {
    connectionId: row.connection_id,
    name: row.name,
    revision: row.revision,
    adapterType: row.adapter_type,
    protocol: row.protocol,
    capabilities: row.capabilities,
    enabled: row.enabled,
    credentialState: row.credential_state,
    ...(row.test_summary === null ? {} : { testSummary: row.test_summary }),
    updatedAt: row.updated_at,
  }
}

function toAdminView(row: ConnectionRow): ModelConnectionAdminView {
  return {
    ...toSummary(row),
    ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    ...(row.endpoint === null ? {} : { endpoint: row.endpoint }),
    platformModelId: row.platform_model_id,
    providerModelName: row.provider_model_name,
  }
}

/** The request digest the unique idempotency key is checked against (jsonb text is canonical). */
function digestExpression(index: number): string {
  return `md5($${String(index)}::jsonb::text)`
}

/**
 * PostgreSQL model-connection catalogue (design §5.3, A-R09).
 *
 * The row carries only non-secret metadata: the API key is a value behind `credential_ref`, an
 * opaque reference the host custodian resolves. Every statement runs inside the trusted scope's
 * transaction (RLS is a second layer behind the explicit predicate). A create/update is a
 * compare-and-swap on `revision`; re-using an idempotency key with a different descriptor is
 * `IDEMPOTENCY_CONFLICT` and a stale expected revision is `VERSION_CONFLICT`.
 */
export class PostgresModelConnectionStore implements ModelConnectionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async listConnections(
    scopeRef: ScopeRef,
    filter: { readonly enabled?: boolean; readonly capability?: ModelCapability; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<readonly ModelConnectionAdminView[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM agent_platform.model_connections
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

  async getConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ModelConnectionAdminView | undefined> {
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byConnectionId(query, connectionId)
      return row === undefined ? undefined : toAdminView(row)
    })
  }

  async putConnection(
    scopeRef: ScopeRef,
    input: {
      readonly connectionId?: Uuid
      readonly descriptor: ModelConnectionDescriptor
      readonly expectedRevision?: string
      readonly idempotencyKey: string
    },
    ctx: ToolContext,
  ): Promise<ModelConnectionAdminView> {
    assertModelConnectionDescriptorShape(input.descriptor)
    if (input.connectionId === undefined || !isUuid(input.connectionId)) {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'a connection id must be minted by the caller')
    }
    const connectionId = input.connectionId
    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#byIdempotencyKey(query, input.idempotencyKey, JSON.stringify(input.descriptor))
      if (replay !== undefined) {
        if (!replay.descriptor_matches) {
          throw new ModelSelectionError('IDEMPOTENCY_CONFLICT', 'the idempotency key was already used with a different connection descriptor')
        }
        return toAdminView(replay)
      }

      const current = await this.#byConnectionId(query, connectionId)
      const descriptor = JSON.stringify(input.descriptor)
      if (current !== undefined) {
        if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) {
          throw new ModelSelectionError('VERSION_CONFLICT', 'the connection moved since it was read; re-read before writing')
        }
        const updated = await query.query<ConnectionRow>(
          `UPDATE agent_platform.model_connections SET
             revision = revision + 1, name = $3, adapter_type = $4, protocol = $5, capabilities = $6::jsonb,
             enabled = $7, base_url = $8, endpoint = $9, platform_model_id = $10, provider_model_name = $11,
             descriptor = $12::jsonb, idempotency_key = $13, request_digest = ${digestExpression(12)},
             actor = $14, updated_at = now()
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid AND revision = $2::bigint
           RETURNING ${CONNECTION_COLUMNS}`,
          [
            connectionId, current.revision, input.descriptor.name, input.descriptor.adapterType,
            input.descriptor.protocol, JSON.stringify(input.descriptor.capabilities), input.descriptor.enabled,
            input.descriptor.baseUrl ?? null, input.descriptor.endpoint ?? null, input.descriptor.platformModelId,
            input.descriptor.providerModelName, descriptor, input.idempotencyKey, ctx.principal.subjectId,
          ],
        )
        const updatedRow = updated.rows[0]
        if (updatedRow === undefined) {
          throw new ModelSelectionError('VERSION_CONFLICT', 'the connection moved during the write')
        }
        await this.#snapshot(query, updatedRow, ctx)
        return toAdminView(updatedRow)
      }

      if (input.expectedRevision !== undefined) {
        throw new ModelSelectionError('VERSION_CONFLICT', 'no connection exists yet with this id')
      }
      const inserted = await query.query<ConnectionRow>(
        `INSERT INTO agent_platform.model_connections
           (tenant_id, space_id, connection_id, revision, name, adapter_type, protocol, capabilities, enabled,
            base_url, endpoint, platform_model_id, provider_model_name, descriptor, idempotency_key, request_digest,
            actor, recorded_at, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, 1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12, ${digestExpression(11)},
           $13, now(), now())
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          connectionId, input.descriptor.name, input.descriptor.adapterType, input.descriptor.protocol,
          JSON.stringify(input.descriptor.capabilities), input.descriptor.enabled, input.descriptor.baseUrl ?? null,
          input.descriptor.endpoint ?? null, input.descriptor.platformModelId, input.descriptor.providerModelName,
          descriptor, input.idempotencyKey, ctx.principal.subjectId,
        ],
      )
      const insertedRow = inserted.rows[0]
      if (insertedRow === undefined) throw new ModelSelectionError('STORE_FAILED', 'the connection could not be written')
      await this.#snapshot(query, insertedRow, ctx)
      return toAdminView(insertedRow)
    })
  }

  async deleteConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void> {
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `DELETE FROM agent_platform.model_connections
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid`,
        [connectionId],
      )
    })
  }

  async setCredential(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly change: { readonly action: 'set'; readonly credentialRef: ResourceRef } | { readonly action: 'clear' } },
    ctx: ToolContext,
  ): Promise<ModelConnectionSummary> {
    if (!isUuid(input.connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const setting = input.change.action === 'set'
      const updated = await query.query<ConnectionRow>(
        `UPDATE agent_platform.model_connections SET
           revision = revision + 1,
           credential_ref = $2::jsonb,
           credential_state = $3,
           test_summary = NULL,
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
      if (row === undefined) throw new ModelSelectionError('NOT_FOUND', 'the connection is not visible in this scope')
      await this.#snapshot(query, row, ctx)
      return toSummary(row)
    })
  }

  async getCredentialRef(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ResourceRef | undefined> {
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ credential_ref: ResourceRef | null }>(
        `SELECT credential_ref FROM agent_platform.model_connections
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid`,
        [connectionId],
      )
      return result.rows[0]?.credential_ref ?? undefined
    })
  }

  async recordTest(scopeRef: ScopeRef, record: ModelConnectionTestRecord, ctx: ToolContext): Promise<ModelConnectionSummary> {
    if (!isUuid(record.connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const summary: ModelConnectionTestSummary = {
        revision: record.revision,
        status: record.status,
        testedAt: record.testedAt,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      }
      const updated = await query.query<ConnectionRow>(
        `UPDATE agent_platform.model_connections SET test_summary = $2::jsonb, updated_at = now()
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND connection_id = $1::uuid AND revision = $3::bigint
         RETURNING ${CONNECTION_COLUMNS}`,
        [record.connectionId, JSON.stringify(summary), record.revision],
      )
      await query.query(
        `INSERT INTO agent_platform.model_connection_tests
           (tenant_id, space_id, connection_id, revision, status, reason, latency_ms, tested_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::bigint, $3, $4, $5, $6::timestamptz)`,
        [
          record.connectionId, record.revision, record.status, record.reason ?? null,
          record.latencyMs ?? null, record.testedAt,
        ],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new ModelSelectionError('VERSION_CONFLICT', 'the connection revision changed before the test was recorded')
      return toSummary(row)
    })
  }

  async #byConnectionId(query: ScopedQuery, connectionId: string): Promise<ConnectionRow | undefined> {
    const result = await query.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM agent_platform.model_connections
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
         FROM agent_platform.model_connections
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND idempotency_key = $1`,
      [key, descriptorJson],
    )
    return result.rows[0]
  }

  async #snapshot(query: ScopedQuery, row: ConnectionRow, ctx: ToolContext): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.model_connection_revisions
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
      throw new ModelSelectionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
