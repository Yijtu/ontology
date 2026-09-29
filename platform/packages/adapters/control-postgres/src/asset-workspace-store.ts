import type { QueryResultRow } from 'pg'
import {
  IndustryWorkspaceStoreError,
  assertAssetDraftVersionShape,
  assertIndustryWorkspacePatchShape,
  assertIndustryWorkspaceShape,
  isRevisionString,
  isToolContext,
} from '@ontology/contracts'
import type {
  AppendAssetDraftInput,
  AssetDraftVersion,
  CreateIndustryWorkspaceInput,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  IndustryWorkspaceState,
  IndustryWorkspaceWriteResult,
  NewOutboxMessage,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface WorkspaceRow extends QueryResultRow {
  workspace_id: string
  namespace: string
  display_name: string
  boundary: IndustryWorkspace['boundary']
  head_revision: string
  state: IndustryWorkspaceState
  latest_pack_ref: VersionRef | null
  create_request_digest: string
}

interface DraftRow extends QueryResultRow {
  body: AssetDraftVersion
  request_digest: string
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

function toWorkspace(row: WorkspaceRow): IndustryWorkspace {
  return {
    workspaceId: row.workspace_id,
    namespace: row.namespace,
    displayName: row.display_name,
    boundary: row.boundary,
    headRevision: row.head_revision,
    ...(row.latest_pack_ref === null ? {} : { latestPublishedPackRef: row.latest_pack_ref }),
    state: row.state,
  }
}

const WORKSPACE_COLUMNS = `workspace_id, namespace, display_name, boundary, head_revision, state,
  latest_pack_ref, create_request_digest`

/**
 * Real PostgreSQL implementation of the industry-workspace store (SPEC v0.3a
 * §3.1/§4.1).
 *
 * Every statement runs inside one transaction whose trusted scope is set with
 * `SET LOCAL` semantics, so RLS applies to the whole call as a second layer
 * behind the explicit scope predicate. `appendDraft` locks the workspace head
 * `FOR UPDATE`, checks the expected revision and only then appends the immutable
 * draft revision, advances the head and writes the transactional outbox message;
 * a stale expected revision is a VERSION_CONFLICT. A replayed Idempotency-Key
 * reads back the original draft; the same key with a different payload is an
 * IDEMPOTENCY_CONFLICT.
 */
export class PostgresAssetWorkspaceStore implements IndustryWorkspaceStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async createWorkspace(
    input: CreateIndustryWorkspaceInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    assertIndustryWorkspaceShape(input.workspace)
    assertAssetDraftVersionShape(input.firstDraft)
    if (input.workspace.headRevision !== '1') {
      throw new IndustryWorkspaceStoreError('INVALID_WORKSPACE', 'a new workspace must start at revision 1')
    }
    if (input.firstDraft.revision !== '1') {
      throw new IndustryWorkspaceStoreError('INVALID_DRAFT', 'the first draft must be revision 1')
    }
    if (input.firstDraft.workspaceId !== input.workspace.workspaceId) {
      throw new IndustryWorkspaceStoreError('INVALID_DRAFT', 'the first draft must belong to the created workspace')
    }
    const workspace = input.workspace
    const draft = input.firstDraft

    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#workspaceByCreateKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.create_request_digest !== input.requestDigest) {
          throw new IndustryWorkspaceStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        const stored = await this.#draftAt(query, replay.workspace_id, '1')
        if (stored === undefined) {
          throw new IndustryWorkspaceStoreError('DRAFT_NOT_FOUND', 'the workspace has no first draft revision')
        }
        return { workspace: toWorkspace(replay), draft: stored.body, created: false }
      }

      const inserted = await query
        .query<{ workspace_id: string }>(
          `INSERT INTO agent_platform.industry_workspaces
             (tenant_id, space_id, workspace_id, namespace, display_name, boundary, head_revision, state,
              latest_pack_ref, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1::uuid, $2, $3, $4::jsonb, 1, $5, $6::jsonb, $7, $8, $9, $10::timestamptz, $10::timestamptz)
           ON CONFLICT (tenant_id, space_id, create_idempotency_key) DO NOTHING
           RETURNING workspace_id`,
          [
            workspace.workspaceId,
            workspace.namespace,
            workspace.displayName,
            JSON.stringify(workspace.boundary),
            workspace.state,
            workspace.latestPublishedPackRef === undefined
              ? null
              : JSON.stringify(workspace.latestPublishedPackRef),
            input.idempotencyKey,
            input.requestDigest,
            input.actor,
            input.recordedAt,
          ],
        )
        .catch((error: unknown) => {
          // The same workspace id created concurrently loses on the primary key.
          if (pgCodeOf(error) === '23505') return { rows: [], rowCount: 0 }
          throw error
        })

      if (inserted.rows[0] === undefined) {
        const concurrent = await this.#workspaceByCreateKey(query, input.idempotencyKey)
        if (concurrent === undefined) {
          throw new IndustryWorkspaceStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the workspace id already exists in this scope',
          )
        }
        if (concurrent.create_request_digest !== input.requestDigest) {
          throw new IndustryWorkspaceStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        const stored = await this.#draftAt(query, concurrent.workspace_id, '1')
        if (stored === undefined) {
          throw new IndustryWorkspaceStoreError('DRAFT_NOT_FOUND', 'the workspace has no first draft revision')
        }
        return { workspace: toWorkspace(concurrent), draft: stored.body, created: false }
      }

      await this.#insertDraft(query, input.outboxJobId, draft, input)
      await this.#insertOutbox(query, input.outboxJobId, input.outbox)

      return {
        workspace: { ...workspace, headRevision: '1' },
        draft,
        created: true,
      }
    })
  }

  async getWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#workspaceById(query, workspaceId)
      return row === undefined ? undefined : toWorkspace(row)
    })
  }

  async listWorkspaces(
    scopeRef: ScopeRef,
    filter: IndustryWorkspaceListFilter,
    ctx: ToolContext,
  ): Promise<IndustryWorkspace[]> {
    const limit = normalizeLimit(filter.limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<WorkspaceRow>(
        `SELECT ${WORKSPACE_COLUMNS} FROM agent_platform.industry_workspaces
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND ($1::text IS NULL OR state = $1)
           ORDER BY updated_at, workspace_id
           LIMIT $2`,
        [filter.state ?? null, limit],
      )
      return result.rows.map(toWorkspace)
    })
  }

  async getDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion | undefined> {
    if (!isRevisionString(revision)) {
      throw new IndustryWorkspaceStoreError('DRAFT_NOT_FOUND', 'revision must be a decimal string')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#draftAt(query, workspaceId, revision)
      return row === undefined ? undefined : row.body
    })
  }

  async listDrafts(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetDraftVersion[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<DraftRow>(
        `SELECT body, request_digest FROM agent_platform.asset_draft_versions
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND workspace_id = $1::uuid
           ORDER BY revision ASC`,
        [workspaceId],
      )
      return result.rows.map((row) => row.body)
    })
  }

  async appendDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    input: AppendAssetDraftInput,
    ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    assertAssetDraftVersionShape(input.draft)
    if (input.draft.workspaceId !== workspaceId) {
      throw new IndustryWorkspaceStoreError('INVALID_DRAFT', 'the draft must belong to the appended workspace')
    }
    if (input.workspacePatch !== undefined) {
      assertIndustryWorkspacePatchShape(input.workspacePatch)
    }
    const draft = input.draft
    const patch = input.workspacePatch

    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<WorkspaceRow>(
        `SELECT ${WORKSPACE_COLUMNS} FROM agent_platform.industry_workspaces
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND workspace_id = $1::uuid
           FOR UPDATE`,
        [workspaceId],
      )
      const workspaceRow = locked.rows[0]
      if (workspaceRow === undefined) {
        throw new IndustryWorkspaceStoreError(
          'WORKSPACE_NOT_FOUND',
          `workspace ${workspaceId} is not visible in the requested scope`,
        )
      }

      const replay = await query.query<DraftRow>(
        `SELECT body, request_digest FROM agent_platform.asset_draft_versions
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND idempotency_key = $1`,
        [input.idempotencyKey],
      )
      const replayed = replay.rows[0]
      if (replayed !== undefined) {
        if (replayed.request_digest !== input.requestDigest) {
          throw new IndustryWorkspaceStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        return { workspace: toWorkspace(workspaceRow), draft: replayed.body, created: false }
      }

      const head = workspaceRow.head_revision
      if (head !== input.expectedRevision) {
        throw new IndustryWorkspaceStoreError(
          'VERSION_CONFLICT',
          `workspace head is ${head}, not the expected ${input.expectedRevision}`,
        )
      }
      const nextRevision = (BigInt(head) + 1n).toString()
      if (draft.revision !== nextRevision) {
        throw new IndustryWorkspaceStoreError(
          'DRAFT_REVISION_INVALID',
          `appended draft must be revision ${nextRevision}`,
        )
      }

      await this.#insertDraft(query, input.outboxJobId, draft, input)
      const advanced = await query.query<WorkspaceRow>(
        `UPDATE agent_platform.industry_workspaces
            SET head_revision = $2::bigint,
                display_name = COALESCE($4, display_name),
                boundary = COALESCE($5::jsonb, boundary),
                updated_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
          RETURNING ${WORKSPACE_COLUMNS}`,
        [
          workspaceId,
          nextRevision,
          input.recordedAt,
          patch?.displayName ?? null,
          patch?.boundary === undefined ? null : JSON.stringify(patch.boundary),
        ],
      )
      const updated = advanced.rows[0]
      if (updated === undefined) {
        throw new IndustryWorkspaceStoreError('WORKSPACE_NOT_FOUND', 'the workspace disappeared during append')
      }
      await this.#insertOutbox(query, input.outboxJobId, input.outbox)

      return { workspace: toWorkspace(updated), draft, created: true }
    })
  }

  async #insertDraft(
    query: ScopedQuery,
    outboxId: Uuid,
    draft: AssetDraftVersion,
    input: {
      readonly idempotencyKey: string
      readonly requestDigest: string
      readonly actor: string
      readonly recordedAt: string
    },
  ): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.asset_draft_versions
         (tenant_id, space_id, workspace_id, revision, digest, body, document_set_ref,
          idempotency_key, request_digest, outbox_id, actor, trace_id, recorded_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1::uuid, $2::bigint, $3, $4::jsonb, $5::jsonb, $6, $7, $8::uuid, $9,
         current_setting('app.trace_id', true), $10::timestamptz)`,
      [
        draft.workspaceId,
        draft.revision,
        draft.digest,
        JSON.stringify(draft),
        JSON.stringify(draft.documentSetRef),
        input.idempotencyKey,
        input.requestDigest,
        outboxId,
        input.actor,
        input.recordedAt,
      ],
    )
  }

  async #insertOutbox(query: ScopedQuery, jobId: Uuid, outbox: NewOutboxMessage): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.job_outbox
         (tenant_id, space_id, outbox_id, job_id, topic, payload, idempotency_key, state, attempts,
          available_at, created_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1::uuid, $2::uuid, $3, $4::jsonb, $5, 'pending', 0, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
      [
        outbox.outboxId,
        jobId,
        outbox.topic,
        JSON.stringify(outbox.payload),
        outbox.idempotencyKey,
        outbox.availableAt,
        outbox.createdAt,
      ],
    )
  }

  async #workspaceById(query: ScopedQuery, workspaceId: Uuid): Promise<WorkspaceRow | undefined> {
    const result = await query.query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM agent_platform.industry_workspaces
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND workspace_id = $1::uuid`,
      [workspaceId],
    )
    return result.rows[0]
  }

  async #workspaceByCreateKey(query: ScopedQuery, key: string): Promise<WorkspaceRow | undefined> {
    const result = await query.query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM agent_platform.industry_workspaces
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND create_idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #draftAt(query: ScopedQuery, workspaceId: Uuid, revision: string): Promise<DraftRow | undefined> {
    const result = await query.query<DraftRow>(
      `SELECT body, request_digest FROM agent_platform.asset_draft_versions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND workspace_id = $1::uuid AND revision = $2::bigint`,
      [workspaceId, revision],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new IndustryWorkspaceStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new IndustryWorkspaceStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new IndustryWorkspaceStoreError(
        'SCOPE_MISMATCH',
        'request scope does not match the trusted principal scope',
      )
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
    throw new IndustryWorkspaceStoreError('INVALID_WORKSPACE', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}
