import { SourceStoreError, isToolContext } from '@ontology/contracts'
import type {
  Capability,
  CapabilityRequirement,
  ErrorCode,
  LogicalRole,
  MappingRef,
  ProfileRef,
  ScopeRef,
  SourceBindingRecord,
  SourceBindingUpdate,
  SourceFingerprint,
  SourceKind,
  SourcePreflightBindingRecord,
  SourceProbeJobCompletion,
  SourceProbeJobRecord,
  SourceProbeJobStatus,
  SourceStatus,
  SourceStore,
  SourceVersionRecord,
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

interface SourceBindingRow extends QueryResultRow {
  source_id: string
  kind: SourceKind
  role: LogicalRole
  adapter_id: string
  adapter_version: string
  adapter_digest: string
  secret_ref: string
  status: SourceStatus
  current_version: string
  capability_version: string | null
  revision: string
  created_at: Date
  created_by: string
  updated_at: Date
}

interface SourceVersionRow extends QueryResultRow {
  source_id: string
  version: string
  digest: string
  capability_version: string
  mapping: MappingRef | null
  registered_at: Date
  registered_by: string
}

interface SourceProbeJobRow extends QueryResultRow {
  job_id: string
  source_id: string
  status: SourceProbeJobStatus
  requested_capabilities: CapabilityRequirement[]
  capabilities: Capability[] | null
  schema_revision: string | null
  error_code: ErrorCode | null
  safe_message: string | null
  created_at: Date
  completed_at: Date | null
}

interface SourcePreflightBindingRow extends QueryResultRow {
  profile_id: string
  version: string
  snapshot_hash: string
  fingerprints: SourceFingerprint[]
  recorded_at: Date
  recorded_by: string
}

function toBinding(row: SourceBindingRow, scopeRef: ScopeRef): SourceBindingRecord {
  return {
    sourceId: row.source_id,
    scopeRef,
    kind: row.kind,
    role: row.role,
    adapterRef: { id: row.adapter_id, version: row.adapter_version, digest: row.adapter_digest },
    secretRef: row.secret_ref,
    status: row.status,
    currentVersion: row.current_version,
    ...(row.capability_version === null ? {} : { capabilityVersion: row.capability_version }),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
  }
}

function toVersion(row: SourceVersionRow): SourceVersionRecord {
  return {
    sourceId: row.source_id,
    version: row.version,
    digest: row.digest,
    capabilityVersion: row.capability_version,
    ...(row.mapping === null ? {} : { mappingRef: row.mapping }),
    registeredAt: row.registered_at.toISOString(),
    registeredBy: row.registered_by,
  }
}

function toProbeJob(row: SourceProbeJobRow): SourceProbeJobRecord {
  return {
    jobId: row.job_id,
    sourceId: row.source_id,
    status: row.status,
    requestedCapabilities: row.requested_capabilities,
    ...(row.capabilities === null ? {} : { capabilities: row.capabilities }),
    ...(row.schema_revision === null ? {} : { schemaRevision: row.schema_revision }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.safe_message === null ? {} : { safeMessage: row.safe_message }),
    createdAt: row.created_at.toISOString(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
  }
}

/**
 * Real PostgreSQL implementation of the source store port (C1/C3/C6, D2).
 *
 * Every statement runs as the non-owner `ontology_app` role inside a transaction whose
 * trusted scope is set with `SET LOCAL` semantics, so row-level security applies to the
 * whole call and a later request can never inherit the previous tenant/space. Bindings are
 * updated by compare-and-set on the monotonic revision; versions are insert-only and a
 * driver error is never leaked upward.
 */
export class PostgresSourceStore implements SourceStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insertBinding(scopeRef: ScopeRef, record: SourceBindingRecord, ctx: ToolContext): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.source_bindings
           (tenant_id, space_id, source_id, kind, role, adapter_id, adapter_version, adapter_digest,
            secret_ref, status, current_version, capability_version, revision, created_at, created_by)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13
         )
         ON CONFLICT DO NOTHING`,
        [
          record.sourceId,
          record.kind,
          record.role,
          record.adapterRef.id,
          record.adapterRef.version,
          record.adapterRef.digest,
          record.secretRef,
          record.status,
          record.currentVersion,
          record.capabilityVersion ?? null,
          record.revision,
          record.createdAt,
          record.createdBy,
        ],
      )
    })
  }

  async findBinding(
    sourceId: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourceBindingRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceBindingRow>(
        `SELECT source_id, kind, role, adapter_id, adapter_version, adapter_digest, secret_ref,
                status, current_version, capability_version, revision, created_at, created_by, updated_at
           FROM agent_platform.source_bindings
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1`,
        [sourceId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toBinding(row, scopeRef)
    })
  }

  async listBindings(scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceBindingRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceBindingRow>(
        `SELECT source_id, kind, role, adapter_id, adapter_version, adapter_digest, secret_ref,
                status, current_version, capability_version, revision, created_at, created_by, updated_at
           FROM agent_platform.source_bindings
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
          ORDER BY source_id`,
      )
      return result.rows.map((row) => toBinding(row, scopeRef))
    })
  }

  async applyBindingUpdate(
    scopeRef: ScopeRef,
    sourceId: string,
    update: SourceBindingUpdate,
    ctx: ToolContext,
  ): Promise<SourceBindingRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<SourceBindingRow>(
        `UPDATE agent_platform.source_bindings
            SET status = $3,
                current_version = COALESCE($4, current_version),
                capability_version = COALESCE($5, capability_version),
                revision = revision + 1,
                updated_at = $6::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1
            AND revision = $2
          RETURNING source_id, kind, role, adapter_id, adapter_version, adapter_digest, secret_ref,
                    status, current_version, capability_version, revision, created_at, created_by, updated_at`,
        [
          sourceId,
          update.expectedRevision,
          update.status,
          update.currentVersion ?? null,
          update.capabilityVersion ?? null,
          update.updatedAt,
        ],
      )
      const row = updated.rows[0]
      if (row !== undefined) return toBinding(row, scopeRef)

      const current = await query.query<{ revision: string }>(
        `SELECT revision
           FROM agent_platform.source_bindings
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1`,
        [sourceId],
      )
      if (current.rows[0] === undefined) {
        throw new SourceStoreError('SOURCE_NOT_FOUND', `source ${sourceId} is not registered in this scope`)
      }
      throw new SourceStoreError(
        'REVISION_CONFLICT',
        `source ${sourceId} revision changed since the expected revision`,
      )
    })
  }

  async insertVersion(scopeRef: ScopeRef, record: SourceVersionRecord, ctx: ToolContext): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.source_versions
           (tenant_id, space_id, source_id, version, digest, capability_version, mapping,
            registered_at, registered_by)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7
         )
         ON CONFLICT DO NOTHING`,
        [
          record.sourceId,
          record.version,
          record.digest,
          record.capabilityVersion,
          record.mappingRef === undefined ? null : JSON.stringify(record.mappingRef),
          record.registeredAt,
          record.registeredBy,
        ],
      )
      if (inserted.rowCount > 0) return
      const existing = await query.query<{ digest: string }>(
        `SELECT digest
           FROM agent_platform.source_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1 AND version = $2`,
        [record.sourceId, record.version],
      )
      const digest = existing.rows[0]?.digest
      if (digest === record.digest) return
      throw new SourceStoreError(
        'VERSION_EXISTS',
        `source ${record.sourceId}@${record.version} already exists with a different digest`,
      )
    })
  }

  async findVersion(
    sourceId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourceVersionRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceVersionRow>(
        `SELECT source_id, version, digest, capability_version, mapping, registered_at, registered_by
           FROM agent_platform.source_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1 AND version = $2`,
        [sourceId, version],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toVersion(row)
    })
  }

  async listVersions(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceVersionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceVersionRow>(
        `SELECT source_id, version, digest, capability_version, mapping, registered_at, registered_by
           FROM agent_platform.source_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1
          ORDER BY version`,
        [sourceId],
      )
      return result.rows.map(toVersion)
    })
  }

  async insertProbeJob(scopeRef: ScopeRef, record: SourceProbeJobRecord, ctx: ToolContext): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.source_probe_jobs
           (tenant_id, space_id, job_id, source_id, status, requested_capabilities, capabilities,
            schema_revision, error_code, safe_message, created_at, completed_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::timestamptz, $10::timestamptz
         )
         ON CONFLICT DO NOTHING`,
        [
          record.jobId,
          record.sourceId,
          record.status,
          JSON.stringify(record.requestedCapabilities),
          record.capabilities === undefined ? null : JSON.stringify(record.capabilities),
          record.schemaRevision ?? null,
          record.errorCode ?? null,
          record.safeMessage ?? null,
          record.createdAt,
          record.completedAt ?? null,
        ],
      )
    })
  }

  async findProbeJob(jobId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceProbeJobRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceProbeJobRow>(
        `SELECT job_id, source_id, status, requested_capabilities, capabilities, schema_revision,
                error_code, safe_message, created_at, completed_at
           FROM agent_platform.source_probe_jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1`,
        [jobId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toProbeJob(row)
    })
  }

  async listProbeJobs(sourceId: string, scopeRef: ScopeRef, ctx: ToolContext): Promise<SourceProbeJobRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourceProbeJobRow>(
        `SELECT job_id, source_id, status, requested_capabilities, capabilities, schema_revision,
                error_code, safe_message, created_at, completed_at
           FROM agent_platform.source_probe_jobs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND source_id = $1
          ORDER BY created_at`,
        [sourceId],
      )
      return result.rows.map(toProbeJob)
    })
  }

  async completeProbeJob(
    scopeRef: ScopeRef,
    jobId: string,
    completion: SourceProbeJobCompletion,
    ctx: ToolContext,
  ): Promise<SourceProbeJobRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<SourceProbeJobRow>(
        `UPDATE agent_platform.source_probe_jobs
            SET status = $2,
                capabilities = $3::jsonb,
                schema_revision = $4,
                error_code = $5,
                safe_message = $6,
                completed_at = $7::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1
          RETURNING job_id, source_id, status, requested_capabilities, capabilities, schema_revision,
                    error_code, safe_message, created_at, completed_at`,
        [
          jobId,
          completion.status,
          completion.capabilities === undefined ? null : JSON.stringify(completion.capabilities),
          completion.schemaRevision ?? null,
          completion.errorCode ?? null,
          completion.safeMessage ?? null,
          completion.completedAt,
        ],
      )
      const row = updated.rows[0]
      if (row === undefined) {
        throw new SourceStoreError('SOURCE_NOT_FOUND', `probe job ${jobId} is not visible in this scope`)
      }
      return toProbeJob(row)
    })
  }

  async insertPreflightBinding(
    scopeRef: ScopeRef,
    record: SourcePreflightBindingRecord,
    ctx: ToolContext,
  ): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.source_preflight_bindings
           (tenant_id, space_id, profile_id, version, snapshot_hash, fingerprints, recorded_at, recorded_by)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::jsonb, $5::timestamptz, $6
         )
         ON CONFLICT DO NOTHING`,
        [
          record.profileRef.id,
          record.profileRef.version,
          record.snapshotHash,
          JSON.stringify(record.fingerprints),
          record.recordedAt,
          record.recordedBy,
        ],
      )
    })
  }

  async findPreflightBinding(
    profileRef: ProfileRef,
    snapshotHash: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SourcePreflightBindingRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<SourcePreflightBindingRow>(
        `SELECT profile_id, version, snapshot_hash, fingerprints, recorded_at, recorded_by
           FROM agent_platform.source_preflight_bindings
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1 AND version = $2 AND snapshot_hash = $3`,
        [profileRef.id, profileRef.version, snapshotHash],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      return {
        profileRef: { id: row.profile_id, version: row.version },
        snapshotHash: row.snapshot_hash,
        fingerprints: row.fingerprints,
        recordedAt: row.recorded_at.toISOString(),
        recordedBy: row.recorded_by,
      }
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new SourceStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new SourceStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
