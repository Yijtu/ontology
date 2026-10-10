import type { QueryResultRow } from 'pg'
import {
  SemanticDefinitionStoreError,
  definitionRecordOf,
  definitionVersionFromRecord,
} from '@ontology/contracts'
import type {
  DefinitionBinding,
  ResourceRef,
  ScopeRef,
  SemanticDefinitionAudit,
  SemanticDefinitionListFilter,
  SemanticDefinitionRecord,
  SemanticDefinitionStore,
  SemanticDefinitionVersion,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface VersionRow extends QueryResultRow {
  definition: SemanticDefinitionRecord
}

interface EventRow extends QueryResultRow {
  namespace: string
  definition_id: string
  version: string
  seq: string
  digest: string
  payload_digest: string
  idempotency_key: string
  actor: string
  occurred_at: Date
}

interface BindingRow extends QueryResultRow {
  data_ref: ResourceRef
  namespace: string
  definition_id: string
  definition_version: string
  definition_digest: string
  bound_at: Date
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

type DefinitionBindingInput = Parameters<SemanticDefinitionStore['bindData']>[1]

/**
 * Real PostgreSQL implementation of the semantic definition store port (D2/D3).
 *
 * It runs as the non-owner `ontology_app` role inside a transaction whose trusted scope
 * is set with `SET LOCAL` semantics, so row-level security applies to every statement and
 * a later request can never inherit the previous tenant/space. It enforces the same
 * invariants as the in-memory reference store: immutable append-only versions, an audit
 * event per publication and a data set bound to exactly one version. A driver error is
 * mapped onto the classified `SemanticDefinitionStoreError`; it never escapes the port.
 */
export class PostgresSemanticDefinitionStore implements SemanticDefinitionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findVersionByRef(scopeRef: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<SemanticDefinitionVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<VersionRow>(`SELECT definition FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = current_setting('app.tenant_id')::uuid AND space_id = current_setting('app.space_id')::uuid
        AND definition_id = $1 AND version = $2 AND definition->'ref'->>'digest' = $3 LIMIT 2`, [ref.id, ref.version, ref.digest])
      if (result.rows.length > 1) throw new SemanticDefinitionStoreError('VERSION_EXISTS', 'the exact immutable definition reference is ambiguous')
      const row = result.rows[0]
      return row === undefined ? undefined : definitionVersionFromRecord(row.definition, scopeRef)
    })
  }

  async findVersion(
    namespace: string,
    definitionId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<VersionRow>(
        `SELECT definition
           FROM agent_platform.semantic_definition_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND namespace = $1 AND definition_id = $2 AND version = $3`,
        [namespace, definitionId, version],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : definitionVersionFromRecord(row.definition, scopeRef)
    })
  }

  async listVersions(
    scopeRef: ScopeRef,
    filter: SemanticDefinitionListFilter,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<VersionRow>(
        `SELECT definition
           FROM agent_platform.semantic_definition_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ($1::text IS NULL OR namespace = $1)
            AND ($2::text IS NULL OR layer = $2)
          ORDER BY published_at, definition_id, version`,
        [filter.namespace ?? null, filter.layer ?? null],
      )
      return result.rows.map((row) => definitionVersionFromRecord(row.definition, scopeRef))
    })
  }

  async insertVersion(
    scopeRef: ScopeRef,
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
    ctx: ToolContext,
  ): Promise<void> {
    const record = definitionRecordOf(version)
    await this.#withScope(scopeRef, ctx, async (query) => {
      try {
        await query.query(
          `INSERT INTO agent_platform.semantic_definition_versions
             (tenant_id, space_id, namespace, definition_id, version, digest, layer, definition, published_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz
           )`,
          [
            version.namespace,
            version.ref.id,
            version.ref.version,
            version.ref.digest,
            version.layer,
            JSON.stringify(record),
            version.publishedAt,
          ],
        )
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          throw new SemanticDefinitionStoreError(
            'VERSION_EXISTS',
            `definition ${version.namespace}/${version.ref.id}@${version.ref.version} is already published`,
            { cause: error },
          )
        }
        throw error
      }
      await this.#insertEvent(query, version, audit)
    })
  }

  async listEvents(scopeRef: ScopeRef, definitionId: string, ctx: ToolContext) {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<EventRow>(
        `SELECT namespace, definition_id, version, seq, digest, payload_digest, idempotency_key,
                actor, occurred_at
           FROM agent_platform.semantic_definition_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND definition_id = $1
          ORDER BY occurred_at, seq`,
        [definitionId],
      )
      return result.rows.map((row) => ({
        definitionId: row.definition_id,
        version: row.version,
        namespace: row.namespace,
        digest: row.digest,
        payloadDigest: row.payload_digest,
        idempotencyKey: row.idempotency_key,
        occurredAt: row.occurred_at.toISOString(),
        actor: row.actor,
        seq: Number(row.seq),
      }))
    })
  }

  async bindData(scopeRef: ScopeRef, binding: DefinitionBindingInput, ctx: ToolContext): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.semantic_definition_bindings
           (tenant_id, space_id, data_ref_id, data_ref, namespace, definition_id,
            definition_version, definition_digest, bound_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::jsonb, $3, $4, $5, $6, $7::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, data_ref_id) DO NOTHING
         RETURNING data_ref_id`,
        [
          binding.dataRef.id,
          JSON.stringify(binding.dataRef),
          binding.namespace,
          binding.definitionRef.id,
          binding.definitionRef.version,
          binding.definitionRef.digest,
          binding.boundAt,
        ],
      )
      if (inserted.rowCount > 0) return

      const existing = await query.query<BindingRow>(
        `SELECT data_ref, namespace, definition_id, definition_version, definition_digest, bound_at
           FROM agent_platform.semantic_definition_bindings
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND data_ref_id = $1::uuid`,
        [binding.dataRef.id],
      )
      const row = existing.rows[0]
      if (
        row !== undefined &&
        row.definition_id === binding.definitionRef.id &&
        row.definition_version === binding.definitionRef.version &&
        row.definition_digest === binding.definitionRef.digest
      ) {
        return
      }
      throw new SemanticDefinitionStoreError(
        'BINDING_CONFLICT',
        `data ${binding.dataRef.id} is already bound to another definition version`,
      )
    })
  }

  async findBinding(
    scopeRef: ScopeRef,
    dataRefId: string,
    ctx: ToolContext,
  ): Promise<DefinitionBinding | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<BindingRow>(
        `SELECT data_ref, namespace, definition_id, definition_version, definition_digest, bound_at
           FROM agent_platform.semantic_definition_bindings
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND data_ref_id = $1::uuid`,
        [dataRefId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      return {
        dataRef: row.data_ref,
        namespace: row.namespace,
        definitionRef: {
          id: row.definition_id,
          version: row.definition_version,
          digest: row.definition_digest,
        },
        boundAt: row.bound_at.toISOString(),
      }
    })
  }

  async #insertEvent(
    query: ScopedQuery,
    version: SemanticDefinitionVersion,
    audit: SemanticDefinitionAudit,
  ): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.semantic_definition_events
         (tenant_id, space_id, namespace, definition_id, version, seq, digest, payload_digest,
          idempotency_key, actor, occurred_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1, $2, $3,
         (SELECT coalesce(max(seq), 0) + 1
            FROM agent_platform.semantic_definition_events
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND namespace = $1 AND definition_id = $2 AND version = $3),
         $4, $5, $6, $7, $8::timestamptz
       )
       ON CONFLICT DO NOTHING`,
      [
        version.namespace,
        version.ref.id,
        version.ref.version,
        audit.digest,
        audit.payloadDigest,
        audit.idempotencyKey,
        audit.actor,
        audit.occurredAt,
      ],
    )
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new SemanticDefinitionStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new SemanticDefinitionStoreError(
        'SCOPE_MISMATCH',
        'request scope does not match the trusted principal scope',
      )
    }
    return this.#database.withIdentityScope(
      { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      async (client) =>
        run({
          query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
        }),
    )
  }
}
