import type { QueryResultRow } from 'pg'
import {
  ToolConnectionError,
  assertToolAssignmentSetShape,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  ScopeRef,
  ToolAssignmentSet,
  ToolAssignmentStore,
  ToolConnectionSelection,
  ToolConnectionSelectionEntry,
  ToolContext,
  ToolTargetScope,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'
import { SPACE_SCOPE_ID } from './model-assignment-store'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface AssignmentRow extends QueryResultRow {
  scope_kind: 'space' | 'industry_workspace' | 'project'
  scope_id: string
  revision: string
  default_selection: ToolConnectionSelection
  tool_selections: ToolConnectionSelectionEntry[]
  updated_at: string
}

const ASSIGNMENT_COLUMNS = `scope_kind, scope_id, revision::text AS revision, default_selection,
  tool_selections,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`

function scopeParts(scope: ToolTargetScope): { kind: string; id: string } {
  switch (scope.kind) {
    case 'space':
      return { kind: 'space', id: SPACE_SCOPE_ID }
    case 'industry_workspace':
      return { kind: 'industry_workspace', id: scope.workspaceId }
    case 'project':
      return { kind: 'project', id: scope.projectId }
  }
}

function scopeOfRow(row: AssignmentRow): ToolTargetScope {
  if (row.scope_kind === 'space') return { kind: 'space' }
  if (row.scope_kind === 'industry_workspace') return { kind: 'industry_workspace', workspaceId: row.scope_id }
  return { kind: 'project', projectId: row.scope_id }
}

function toSet(row: AssignmentRow): ToolAssignmentSet {
  return {
    schemaVersion: 'tool-assignment-set@1',
    scope: scopeOfRow(row),
    defaultSelection: row.default_selection,
    toolSelections: row.tool_selections,
    revision: row.revision,
    updatedAt: row.updated_at,
  }
}

/**
 * PostgreSQL tool assignment sets (design §9). One row per (tenant, space, target scope); the
 * `space` scope uses the shared sentinel id so the primary key stays a plain composite. A write is a
 * compare-and-swap on `revision`, so a concurrent per-tool change cannot be silently overwritten.
 */
export class PostgresToolAssignmentStore implements ToolAssignmentStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async getAssignmentSet(scopeRef: ScopeRef, scope: ToolTargetScope, ctx: ToolContext): Promise<ToolAssignmentSet | undefined> {
    const parts = scopeParts(scope)
    if (scope.kind !== 'space' && !isUuid(parts.id)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a target scope id must be a uuid')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byScope(query, parts.kind, parts.id)
      return row === undefined ? undefined : toSet(row)
    })
  }

  async listAssignmentSets(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly ToolAssignmentSet[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AssignmentRow>(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM agent_platform.tool_assignment_sets
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
           ORDER BY scope_kind, scope_id`,
      )
      return result.rows.map(toSet)
    })
  }

  async putAssignmentSet(
    scopeRef: ScopeRef,
    input: { readonly set: ToolAssignmentSet; readonly expectedRevision?: string },
    ctx: ToolContext,
  ): Promise<ToolAssignmentSet> {
    assertToolAssignmentSetShape(input.set)
    const parts = scopeParts(input.set.scope)
    if (input.set.scope.kind !== 'space' && !isUuid(parts.id)) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a target scope id must be a uuid')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const current = await this.#byScope(query, parts.kind, parts.id)
      if (current !== undefined) {
        if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) {
          throw new ToolConnectionError('VERSION_CONFLICT', 'the assignment set moved since it was read; re-read before writing')
        }
        const updated = await query.query<AssignmentRow>(
          `UPDATE agent_platform.tool_assignment_sets SET
             revision = revision + 1, default_selection = $4::jsonb, tool_selections = $5::jsonb, updated_at = now()
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND scope_kind = $1 AND scope_id = $2::uuid AND revision = $3::bigint
           RETURNING ${ASSIGNMENT_COLUMNS}`,
          [
            parts.kind, parts.id, current.revision,
            JSON.stringify(input.set.defaultSelection), JSON.stringify(input.set.toolSelections),
          ],
        )
        const row = updated.rows[0]
        if (row === undefined) throw new ToolConnectionError('VERSION_CONFLICT', 'the assignment set moved during the write')
        return toSet(row)
      }

      if (input.expectedRevision !== undefined) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'no assignment set exists yet for this scope')
      }
      const inserted = await query.query<AssignmentRow>(
        `INSERT INTO agent_platform.tool_assignment_sets
           (tenant_id, space_id, scope_kind, scope_id, revision, default_selection, tool_selections, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1, $2::uuid, 1, $3::jsonb, $4::jsonb, now())
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [parts.kind, parts.id, JSON.stringify(input.set.defaultSelection), JSON.stringify(input.set.toolSelections)],
      )
      const row = inserted.rows[0]
      if (row === undefined) throw new ToolConnectionError('STORE_FAILED', 'the assignment set could not be written')
      return toSet(row)
    })
  }

  async #byScope(query: ScopedQuery, kind: string, id: string): Promise<AssignmentRow | undefined> {
    const result = await query.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM agent_platform.tool_assignment_sets
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND scope_kind = $1 AND scope_id = $2::uuid`,
      [kind, id],
    )
    return result.rows[0]
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
