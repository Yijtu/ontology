import type { QueryResultRow } from 'pg'
import {
  WorkspaceResearchConfigError,
  assertResolvedWorkspaceResearchProfileShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ResolvedWorkspaceResearchProfile,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson } from '@ontology/core'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface ConfigRow extends QueryResultRow {
  config: Record<string, unknown>
}

/**
 * PostgreSQL workspace-research run configs (design §8, S04).
 *
 * One row per (workspace_id, draft_revision); the row is write-once, so editing the workspace draft
 * later (which appends a newer revision) can never rewrite the config an in-flight run pinned. The
 * stored value is the `ResolvedWorkspaceResearchProfile`; the store never touches a credential and
 * validates the shape before writing.
 */
export class PostgresWorkspaceResearchRunConfigStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putResolved(
    scopeRef: ScopeRef,
    config: ResolvedWorkspaceResearchProfile,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile> {
    assertResolvedWorkspaceResearchProfileShape(config)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ConfigRow>(
        `INSERT INTO agent_platform.workspace_research_run_configs
           (tenant_id, space_id, workspace_id, draft_revision, draft_ref, snapshot_hash, config, resolved_at, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1::uuid, $2::bigint,
           $3::jsonb, $4, $5::jsonb, $6::timestamptz, now())
         ON CONFLICT (tenant_id, space_id, workspace_id, draft_revision) DO NOTHING
         RETURNING config`,
        [config.workspaceId, config.draftRevision, canonicalJson(config.draftRef), config.snapshotHash, canonicalJson(config), config.resolvedAt],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return this.#validate(row.config)
      // The row already exists: a draft revision's config is immutable, so re-read it instead of
      // rewriting it. A *different* config for the same draft revision is a conflict, never an overwrite.
      const existing = await this.#byKey(query, config.workspaceId, config.draftRevision)
      if (existing === undefined) throw new WorkspaceResearchConfigError('STORE_FAILED', 'the workspace-research run config could not be written')
      if (canonicalJson(existing.config) !== canonicalJson(config)) {
        throw new WorkspaceResearchConfigError('VERSION_CONFLICT', 'the workspace-research run config for this draft revision is already fixed and differs')
      }
      return this.#validate(existing.config)
    })
  }

  async getResolved(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    draftRevision: RevisionString,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile | undefined> {
    if (!isUuid(workspaceId)) throw new WorkspaceResearchConfigError('INVALID_CONFIG', 'workspaceId must be a uuid')
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byKey(query, workspaceId, draftRevision)
      return row === undefined ? undefined : this.#validate(row.config)
    })
  }

  async findResolvedBySnapshot(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    draftRevision: RevisionString,
    snapshotHash: Sha256Digest,
    ctx: ToolContext,
  ): Promise<ResolvedWorkspaceResearchProfile | undefined> {
    const record = await this.getResolved(scopeRef, workspaceId, draftRevision, ctx)
    return record !== undefined && record.snapshotHash === snapshotHash ? record : undefined
  }

  async #byKey(query: ScopedQuery, workspaceId: string, draftRevision: RevisionString): Promise<ConfigRow | undefined> {
    const result = await query.query<ConfigRow>(
      `SELECT config FROM agent_platform.workspace_research_run_configs
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND workspace_id = $1::uuid AND draft_revision = $2::bigint`,
      [workspaceId, draftRevision],
    )
    return result.rows[0]
  }

  #validate(value: unknown): ResolvedWorkspaceResearchProfile {
    try {
      assertResolvedWorkspaceResearchProfileShape(value)
      return value
    } catch (error) {
      throw new WorkspaceResearchConfigError('STORE_FAILED', 'a stored workspace-research run config is malformed', { cause: error })
    }
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new WorkspaceResearchConfigError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new WorkspaceResearchConfigError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new WorkspaceResearchConfigError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
