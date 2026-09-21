import {
  ComponentStoreError,
  componentKeyString,
  isToolContext,
} from '@ontology/contracts'
import type {
  ActiveComponentReference,
  ComponentKey,
  ComponentLifecycleAudit,
  ComponentLifecycleEvent,
  ComponentListFilter,
  ComponentManifest,
  ComponentRegistrationRecordInput,
  ComponentRegistryStore,
  ComponentVersionRecord,
  ModuleLifecycleState,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface VersionRow extends QueryResultRow {
  manifest: ComponentManifest
  lifecycle_state: ModuleLifecycleState
  registered_at: Date
  validated_at: Date | null
  activated_at: Date | null
  deprecated_at: Date | null
  retired_at: Date | null
}

interface LifecycleEventRow extends QueryResultRow {
  from_state: ModuleLifecycleState | null
  to_state: ModuleLifecycleState
  digest: string
  payload_digest: string
  idempotency_key: string
  occurred_at: Date
  actor: string
}

interface ReferenceRow extends QueryResultRow {
  run_id: string
  acquired_at: Date
}

const SELECT_VERSION_COLUMNS = `
  manifest, lifecycle_state, registered_at, validated_at, activated_at, deprecated_at, retired_at`

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

function timestampOrNull(value: string | undefined): string | null {
  return value === undefined ? null : value
}

function toRecord(row: VersionRow): ComponentVersionRecord {
  return {
    manifestRef: {
      id: row.manifest.id,
      version: row.manifest.version,
      digest: row.manifest.digest,
    },
    manifest: row.manifest,
    lifecycleState: row.lifecycle_state,
    registeredAt: row.registered_at.toISOString(),
    ...(row.validated_at === null ? {} : { validatedAt: row.validated_at.toISOString() }),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at.toISOString() }),
    ...(row.deprecated_at === null ? {} : { deprecatedAt: row.deprecated_at.toISOString() }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at.toISOString() }),
  }
}

/**
 * Real PostgreSQL implementation of the registry store port (D2).
 *
 * Every statement runs as the non-owner `ontology_app` role inside a transaction whose
 * trusted scope is set with `SET LOCAL` semantics, so row-level security applies to the
 * whole call and a later request can never inherit the previous tenant/space. It
 * enforces the same invariants as the in-memory reference store — version freeze,
 * compare-and-set transitions, refuse-to-retire-while-referenced — and never leaks a
 * driver error upward.
 */
export class PostgresComponentRegistryStore implements ComponentRegistryStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findVersion(
    key: ComponentKey,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<VersionRow>(
        `SELECT ${SELECT_VERSION_COLUMNS}
           FROM agent_platform.component_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3`,
        [key.kind, key.id, key.version],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRecord(row)
    })
  }

  async listVersions(
    scopeRef: ScopeRef,
    filter: ComponentListFilter,
    ctx: ToolContext,
  ): Promise<ComponentVersionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<VersionRow>(
        `SELECT ${SELECT_VERSION_COLUMNS}
           FROM agent_platform.component_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ($1::text IS NULL OR kind = $1)
            AND ($2::text IS NULL OR lifecycle_state = $2)
          ORDER BY registered_at, component_id, version`,
        [filter.kind ?? null, filter.lifecycleState ?? null],
      )
      return result.rows.map(toRecord)
    })
  }

  async insertVersion(
    scopeRef: ScopeRef,
    input: ComponentRegistrationRecordInput,
    ctx: ToolContext,
  ): Promise<void> {
    const manifest = input.record.manifest
    const key: ComponentKey = { kind: manifest.kind, id: manifest.id, version: manifest.version }
    await this.#withScope(scopeRef, ctx, async (query) => {
      try {
        await query.query(
          `INSERT INTO agent_platform.component_versions
             (tenant_id, space_id, kind, component_id, version, digest, manifest, artifact_ref,
              trust_status, lifecycle_state, registered_at, updated_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::timestamptz, now()
           )`,
          [
            key.kind,
            key.id,
            key.version,
            manifest.digest,
            JSON.stringify(manifest),
            JSON.stringify(input.artifactRef),
            manifest.trustStatus,
            input.record.lifecycleState,
            input.record.registeredAt,
          ],
        )
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          throw new ComponentStoreError(
            'VERSION_EXISTS',
            `component ${componentKeyString(key)} is already registered`,
            { cause: error },
          )
        }
        throw error
      }
      await this.#insertEvent(query, key, input.audit)
    })
  }

  async applyTransition(
    scopeRef: ScopeRef,
    key: ComponentKey,
    expectedFrom: ModuleLifecycleState,
    next: ComponentVersionRecord,
    audit: ComponentLifecycleAudit,
    ctx: ToolContext,
  ): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<{ lifecycle_state: ModuleLifecycleState }>(
        `SELECT lifecycle_state
           FROM agent_platform.component_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3
          FOR UPDATE`,
        [key.kind, key.id, key.version],
      )
      if (locked.rows[0] === undefined) {
        throw new ComponentStoreError('VERSION_NOT_FOUND', `component ${componentKeyString(key)} is not registered`)
      }
      if (next.lifecycleState === 'retired') {
        const references = await query.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM agent_platform.component_active_references
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND kind = $1 AND component_id = $2 AND version = $3`,
          [key.kind, key.id, key.version],
        )
        if (Number(references.rows[0]?.count ?? '0') > 0) {
          throw new ComponentStoreError(
            'ACTIVE_REFERENCE_EXISTS',
            `component ${componentKeyString(key)} is referenced by an active run`,
          )
        }
      }
      const updated = await query.query(
        `UPDATE agent_platform.component_versions
            SET lifecycle_state = $4,
                validated_at = $5::timestamptz,
                activated_at = $6::timestamptz,
                deprecated_at = $7::timestamptz,
                retired_at = $8::timestamptz,
                updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3
            AND lifecycle_state = $9`,
        [
          key.kind,
          key.id,
          key.version,
          next.lifecycleState,
          timestampOrNull(next.validatedAt),
          timestampOrNull(next.activatedAt),
          timestampOrNull(next.deprecatedAt),
          timestampOrNull(next.retiredAt),
          expectedFrom,
        ],
      )
      if (updated.rowCount === 0) {
        throw new ComponentStoreError(
          'CONCURRENT_MODIFICATION',
          `component ${componentKeyString(key)} changed concurrently`,
        )
      }
      await this.#insertEvent(query, key, audit)
    })
  }

  async listActiveReferences(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReferenceRow>(
        `SELECT run_id, acquired_at
           FROM agent_platform.component_active_references
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3
          ORDER BY acquired_at`,
        [key.kind, key.id, key.version],
      )
      return result.rows.map((row) => ({
        key: { kind: key.kind, id: key.id, version: key.version },
        runId: row.run_id,
        acquiredAt: row.acquired_at.toISOString(),
      }))
    })
  }

  async acquireActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<ActiveComponentReference> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      // FOR KEY SHARE conflicts with the transition's FOR UPDATE, so a concurrent
      // retire cannot commit between this read and the reference insert; after the
      // wait the row is re-read and a now-retired version is refused.
      const version = await query.query<{ lifecycle_state: ModuleLifecycleState }>(
        `SELECT lifecycle_state
           FROM agent_platform.component_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3
          FOR KEY SHARE`,
        [key.kind, key.id, key.version],
      )
      const current = version.rows[0]
      if (current === undefined) {
        throw new ComponentStoreError('VERSION_NOT_FOUND', `component ${componentKeyString(key)} is not registered`)
      }
      if (current.lifecycle_state === 'retired') {
        throw new ComponentStoreError('VERSION_RETIRED', `component ${componentKeyString(key)} is retired`)
      }
      await query.query(
        `INSERT INTO agent_platform.component_active_references
           (tenant_id, space_id, kind, component_id, version, run_id)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4
         )
         ON CONFLICT DO NOTHING`,
        [key.kind, key.id, key.version, runId],
      )
      const stored = await query.query<ReferenceRow>(
        `SELECT run_id, acquired_at
           FROM agent_platform.component_active_references
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3 AND run_id = $4`,
        [key.kind, key.id, key.version, runId],
      )
      const reference = stored.rows[0]
      if (reference === undefined) {
        throw new ComponentStoreError('VERSION_NOT_FOUND', 'the active reference was not persisted')
      }
      return {
        key: { kind: key.kind, id: key.id, version: key.version },
        runId: reference.run_id,
        acquiredAt: reference.acquired_at.toISOString(),
      }
    })
  }

  async releaseActiveReference(
    scopeRef: ScopeRef,
    key: ComponentKey,
    runId: string,
    ctx: ToolContext,
  ): Promise<boolean> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query(
        `DELETE FROM agent_platform.component_active_references
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3 AND run_id = $4`,
        [key.kind, key.id, key.version, runId],
      )
      return result.rowCount > 0
    })
  }

  async listLifecycleEvents(
    scopeRef: ScopeRef,
    key: ComponentKey,
    ctx: ToolContext,
  ): Promise<ComponentLifecycleEvent[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<LifecycleEventRow>(
        `SELECT from_state, to_state, digest, payload_digest, idempotency_key, occurred_at, actor
           FROM agent_platform.component_lifecycle_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND kind = $1 AND component_id = $2 AND version = $3
          ORDER BY seq`,
        [key.kind, key.id, key.version],
      )
      return result.rows.map((row) => ({
        key: { kind: key.kind, id: key.id, version: key.version },
        digest: row.digest,
        fromState: row.from_state,
        toState: row.to_state,
        payloadDigest: row.payload_digest,
        idempotencyKey: row.idempotency_key,
        occurredAt: row.occurred_at.toISOString(),
        actor: row.actor,
      }))
    })
  }

  async #insertEvent(query: ScopedQuery, key: ComponentKey, audit: ComponentLifecycleAudit): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.component_lifecycle_events
         (tenant_id, space_id, kind, component_id, version, seq, from_state, to_state, digest,
          payload_digest, idempotency_key, actor, occurred_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1, $2, $3,
         (SELECT coalesce(max(seq), 0) + 1
            FROM agent_platform.component_lifecycle_events
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND kind = $1 AND component_id = $2 AND version = $3),
         $4, $5, $6, $7, $8, $9, $10::timestamptz
       )
       ON CONFLICT DO NOTHING`,
      [
        key.kind,
        key.id,
        key.version,
        audit.fromState,
        audit.toState,
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
    if (!isToolContext(ctx)) {
      throw new ComponentStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new ComponentStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId, spaceId }, async (client) =>
      run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      }),
    )
  }
}
