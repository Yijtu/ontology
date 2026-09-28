import { DecisionStateReferenceStoreError, isToolContext } from '@ontology/contracts'
import type {
  DecisionStateReferenceRecord,
  DecisionStateReferenceStore,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ReferenceRow extends QueryResultRow {
  run_id: string
  resolved_profile_hash: string
  state_ref: ResourceRef
  registered_at: Date
}

function scopeOf(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new DecisionStateReferenceStoreError('SCOPE_MISMATCH', 'a host-minted tool context is required')
  }
  const trusted = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  if (ctx.allowedResources.tenantId !== trusted.tenantId ||
      scopeRef.tenantId !== trusted.tenantId || scopeRef.spaceId !== trusted.spaceId) {
    throw new DecisionStateReferenceStoreError('SCOPE_MISMATCH', 'decision state reference scope is not authorized')
  }
  return trusted
}

function validStateRef(ref: ResourceRef): boolean {
  return typeof ref.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ref.id) &&
    typeof ref.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(ref.version) &&
    typeof ref.digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(ref.digest) &&
    ref.kind === 'artifact'
}

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

function toRecord(row: ReferenceRow): DecisionStateReferenceRecord {
  return {
    runId: row.run_id,
    resolvedProfileHash: row.resolved_profile_hash,
    stateRef: row.state_ref,
    registeredAt: row.registered_at.toISOString(),
  }
}

/** PostgreSQL authorization index. It stores exact references only, never model state bytes. */
export class PostgresDecisionStateReferenceStore implements DecisionStateReferenceStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async register(
    scopeRef: ScopeRef,
    record: DecisionStateReferenceRecord,
    ctx: ToolContext,
  ): Promise<DecisionStateReferenceRecord> {
    const scope = scopeOf(scopeRef, ctx)
    if (record.runId !== ctx.runId) {
      throw new DecisionStateReferenceStoreError('SCOPE_MISMATCH', 'state references may only be registered for the canonical run in context')
    }
    if (record.resolvedProfileHash !== ctx.resolvedProfileHash) {
      throw new DecisionStateReferenceStoreError('PROFILE_MISMATCH', 'state reference profile hash does not match the locked run context')
    }
    if (!validStateRef(record.stateRef)) {
      throw new DecisionStateReferenceStoreError('INVALID_REFERENCE', 'only a complete immutable artifact reference may be registered')
    }

    return this.#database.withIdentityScope(scope, async (client) => {
      const run = await client.query<{ resolved_profile_hash: string; state: string } & QueryResultRow>(
        `SELECT resolved_profile_hash, state FROM agent_platform.runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
          FOR KEY SHARE`,
        [record.runId],
      )
      const runRow = run.rows[0]
      if (runRow === undefined || ['published', 'cancelled', 'failed', 'blocked'].includes(runRow.state)) {
        throw new DecisionStateReferenceStoreError('RUN_NOT_FOUND', 'the active run is not visible for decision state registration')
      }
      if (runRow.resolved_profile_hash !== record.resolvedProfileHash) {
        throw new DecisionStateReferenceStoreError('PROFILE_MISMATCH', 'decision state reference differs from the run’s locked profile hash')
      }

      const inserted = await client.query<ReferenceRow>(
        `INSERT INTO agent_platform.decision_state_refs
           (tenant_id, space_id, run_id, resolved_profile_hash, state_ref_id, state_ref_version,
            state_ref_digest, state_ref_kind, state_ref, registered_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
         ON CONFLICT (tenant_id, space_id, run_id, state_ref_id, state_ref_version, state_ref_kind) DO NOTHING
         RETURNING run_id, resolved_profile_hash, state_ref, registered_at`,
        [
          record.runId,
          record.resolvedProfileHash,
          record.stateRef.id,
          record.stateRef.version,
          record.stateRef.digest,
          record.stateRef.kind,
          JSON.stringify(record.stateRef),
          record.registeredAt,
        ],
      )
      const created = inserted.rows[0]
      if (created !== undefined) return toRecord(created)

      const existing = await client.query<ReferenceRow>(
        `SELECT run_id, resolved_profile_hash, state_ref, registered_at FROM agent_platform.decision_state_refs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1 AND state_ref_id = $2 AND state_ref_version = $3 AND state_ref_kind = $4`,
        [record.runId, record.stateRef.id, record.stateRef.version, record.stateRef.kind],
      )
      const row = existing.rows[0]
      if (row !== undefined && row.resolved_profile_hash === record.resolvedProfileHash && sameRef(row.state_ref, record.stateRef)) {
        return toRecord(row)
      }
      throw new DecisionStateReferenceStoreError('STATE_REFERENCE_CONFLICT', 'an immutable state reference registration conflicts with an existing version')
    })
  }

  async isApproved(
    scopeRef: ScopeRef,
    input: { readonly runId: Uuid; readonly resolvedProfileHash: string; readonly stateRef: ResourceRef },
    ctx: ToolContext,
  ): Promise<boolean> {
    const scope = scopeOf(scopeRef, ctx)
    if (input.runId !== ctx.runId || input.resolvedProfileHash !== ctx.resolvedProfileHash || !validStateRef(input.stateRef)) return false
    return this.#database.withIdentityScope(scope, async (client) => {
      const result = await client.query<{ approved: boolean } & QueryResultRow>(
        `SELECT EXISTS (
           SELECT 1 FROM agent_platform.decision_state_refs AS registered
           JOIN agent_platform.runs AS run
             ON run.tenant_id = registered.tenant_id
            AND run.space_id = registered.space_id
            AND run.run_id = registered.run_id
           WHERE registered.tenant_id = current_setting('app.tenant_id')::uuid
             AND registered.space_id = current_setting('app.space_id')::uuid
             AND registered.run_id = $1
             AND registered.resolved_profile_hash = $2
             AND registered.state_ref_id = $3
             AND registered.state_ref_version = $4
             AND registered.state_ref_digest = $5
             AND registered.state_ref_kind = $6
             AND registered.state_ref = $7::jsonb
             AND run.resolved_profile_hash = $2
             AND run.state NOT IN ('published', 'cancelled', 'failed', 'blocked')
         ) AS approved`,
        [
          input.runId,
          input.resolvedProfileHash,
          input.stateRef.id,
          input.stateRef.version,
          input.stateRef.digest,
          input.stateRef.kind,
          JSON.stringify(input.stateRef),
        ],
      )
      return result.rows[0]?.approved ?? false
    }, { readOnly: true })
  }
}
