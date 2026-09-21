import { ProfileStoreError, isToolContext } from '@ontology/contracts'
import type {
  ActiveProfileRecord,
  DeploymentEnvironment,
  ProfileActivation,
  ProfileListFilter,
  ProfileRef,
  ProfileSpec,
  ProfileStore,
  ProfileVersionRecord,
  ResolvedProfile,
  ResolvedProfileRecord,
  RevisionString,
  ScopeRef,
  Sha256Digest,
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

interface ProfileVersionRow extends QueryResultRow {
  profile_id: string
  version: string
  digest: string
  environment: DeploymentEnvironment
  spec: ProfileSpec
  created_at: Date
  created_by: string
}

interface ResolvedProfileRow extends QueryResultRow {
  output_version: string
  output_digest: string
  resolved_profile: ResolvedProfile
  checked_at: Date
  resolved_at: Date
  recorded_at: Date
}

interface ActiveProfileRow extends QueryResultRow {
  version: string
  snapshot_hash: string
  revision: string
  activated_at: Date
  activated_by: string
}

function toProfileVersionRecord(row: ProfileVersionRow): ProfileVersionRecord {
  return {
    profileRef: { id: row.profile_id, version: row.version },
    spec: row.spec,
    digest: row.digest,
    environment: row.environment,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  }
}

function toResolvedProfileRecord(
  profileRef: ProfileRef,
  snapshotHash: Sha256Digest,
  row: ResolvedProfileRow,
): ResolvedProfileRecord {
  return {
    profileRef,
    snapshotHash,
    outputVersion: row.output_version,
    outputDigest: row.output_digest,
    resolved: row.resolved_profile,
    checkedAt: row.checked_at.toISOString(),
    resolvedAt: row.resolved_at.toISOString(),
    createdAt: row.recorded_at.toISOString(),
  }
}

function toActiveProfileRecord(profileId: string, row: ActiveProfileRow): ActiveProfileRecord {
  return {
    profileRef: { id: profileId, version: row.version },
    snapshotHash: row.snapshot_hash,
    revision: row.revision,
    activatedAt: row.activated_at.toISOString(),
    activatedBy: row.activated_by,
  }
}

/**
 * Real PostgreSQL implementation of the profile store port (C1/C6, D2).
 *
 * Every statement runs as the non-owner `ontology_app` role inside a transaction whose
 * trusted scope is set with `SET LOCAL` semantics, so row-level security applies to the
 * whole call and a later request can never inherit the previous tenant/space. Profile
 * versions and resolved manifests are insert-only; activation is a compare-and-set on the
 * monotonic revision, and a driver error is never leaked upward.
 */
export class PostgresProfileStore implements ProfileStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async findProfileVersion(
    ref: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ProfileVersionRow>(
        `SELECT profile_id, version, digest, environment, spec, created_at, created_by
           FROM agent_platform.profile_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1 AND version = $2`,
        [ref.id, ref.version],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toProfileVersionRecord(row)
    })
  }

  async listProfileVersions(
    scopeRef: ScopeRef,
    filter: ProfileListFilter,
    ctx: ToolContext,
  ): Promise<ProfileVersionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ProfileVersionRow>(
        `SELECT profile_id, version, digest, environment, spec, created_at, created_by
           FROM agent_platform.profile_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND ($1::text IS NULL OR environment = $1)
          ORDER BY profile_id, version`,
        [filter.environment ?? null],
      )
      return result.rows.map(toProfileVersionRecord)
    })
  }

  async insertProfileVersion(
    scopeRef: ScopeRef,
    record: ProfileVersionRecord,
    ctx: ToolContext,
  ): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.profile_versions
           (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7
         )
         ON CONFLICT DO NOTHING`,
        [
          record.profileRef.id,
          record.profileRef.version,
          record.digest,
          record.environment,
          JSON.stringify(record.spec),
          record.createdAt,
          record.createdBy,
        ],
      )
      if (inserted.rowCount > 0) return
      const existing = await query.query<{ digest: string }>(
        `SELECT digest
           FROM agent_platform.profile_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1 AND version = $2`,
        [record.profileRef.id, record.profileRef.version],
      )
      const digest = existing.rows[0]?.digest
      if (digest === record.digest) return
      throw new ProfileStoreError(
        'VERSION_EXISTS',
        `profile ${record.profileRef.id}@${record.profileRef.version} is already published with a different digest`,
      )
    })
  }

  async findResolvedProfile(
    profileRef: ProfileRef,
    snapshotHash: Sha256Digest,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ResolvedProfileRow>(
        `SELECT output_version, output_digest, resolved_profile, checked_at, resolved_at, recorded_at
           FROM agent_platform.resolved_profiles
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1 AND version = $2 AND snapshot_hash = $3`,
        [profileRef.id, profileRef.version, snapshotHash],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toResolvedProfileRecord(profileRef, snapshotHash, row)
    })
  }

  async listResolvedProfiles(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResolvedProfileRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ResolvedProfileRow & { snapshot_hash: string }>(
        `SELECT snapshot_hash, output_version, output_digest, resolved_profile, checked_at,
                resolved_at, recorded_at
           FROM agent_platform.resolved_profiles
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1 AND version = $2
          ORDER BY snapshot_hash`,
        [profileRef.id, profileRef.version],
      )
      return result.rows.map((row) => toResolvedProfileRecord(profileRef, row.snapshot_hash, row))
    })
  }

  async insertResolvedProfile(
    scopeRef: ScopeRef,
    record: ResolvedProfileRecord,
    ctx: ToolContext,
  ): Promise<void> {
    await this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.resolved_profiles
           (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
            resolved_profile, checked_at, resolved_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz
         )
         ON CONFLICT DO NOTHING`,
        [
          record.profileRef.id,
          record.profileRef.version,
          record.snapshotHash,
          record.outputVersion,
          record.outputDigest,
          JSON.stringify(record.resolved),
          record.checkedAt,
          record.resolvedAt,
        ],
      )
    })
  }

  async getActiveProfile(
    profileId: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ActiveProfileRow>(
        `SELECT version, snapshot_hash, revision, activated_at, activated_by
           FROM agent_platform.active_profiles
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1`,
        [profileId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toActiveProfileRecord(profileId, row)
    })
  }

  async compareAndSetActiveProfile(
    scopeRef: ScopeRef,
    expectedRevision: RevisionString | null,
    activation: ProfileActivation,
    ctx: ToolContext,
  ): Promise<ActiveProfileRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const profileId = activation.profileRef.id
      if (expectedRevision === null) {
        const inserted = await query.query<{ revision: string }>(
          `INSERT INTO agent_platform.active_profiles
             (tenant_id, space_id, profile_id, version, snapshot_hash, revision, activated_at, activated_by)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, 1, $4::timestamptz, $5
           )
           ON CONFLICT (tenant_id, space_id, profile_id) DO NOTHING
           RETURNING revision`,
          [
            profileId,
            activation.profileRef.version,
            activation.snapshotHash,
            activation.activatedAt,
            activation.activatedBy,
          ],
        )
        const revision = inserted.rows[0]?.revision
        if (revision === undefined) {
          throw new ProfileStoreError(
            'REVISION_CONFLICT',
            `profile ${profileId} already has an active version`,
          )
        }
        return {
          ...activation,
          revision,
        }
      }

      const updated = await query.query<{ revision: string }>(
        `UPDATE agent_platform.active_profiles
            SET version = $3,
                snapshot_hash = $4,
                revision = revision + 1,
                activated_at = $5::timestamptz,
                activated_by = $6,
                updated_at = now()
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND profile_id = $1
            AND revision = $2
          RETURNING revision`,
        [
          profileId,
          expectedRevision,
          activation.profileRef.version,
          activation.snapshotHash,
          activation.activatedAt,
          activation.activatedBy,
        ],
      )
      const revision = updated.rows[0]?.revision
      if (revision === undefined) {
        const current = await query.query<{ revision: string }>(
          `SELECT revision
             FROM agent_platform.active_profiles
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND profile_id = $1`,
          [profileId],
        )
        if (current.rows[0] === undefined) {
          throw new ProfileStoreError(
            'NO_ACTIVE_PROFILE',
            `profile ${profileId} has no active version to update`,
          )
        }
        throw new ProfileStoreError(
          'REVISION_CONFLICT',
          `profile ${profileId} active revision changed since the expected revision`,
        )
      }
      return {
        ...activation,
        revision,
      }
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ProfileStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new ProfileStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
