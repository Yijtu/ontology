import { MaterializationStoreError, isToolContext } from '@ontology/contracts'
import type {
  CommitProjectionInput,
  DomainResultStatus,
  MaterializationFence,
  MaterializationStore,
  MaterializedConclusion,
  MaterializedValue,
  MarkProjectionDirtyInput,
  OpenMaterializationFenceInput,
  ProjectionCommitResult,
  ProjectionSlice,
  ProjectionState,
  ReadProjectionSlicesRequest,
  ScopeRef,
  SourceWatermark,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { PoolClient, QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

/** The single materialised projection this store owns. */
export const MATERIALIZED_PROJECTION_REF = 'projection.materialized'

interface StateRow extends QueryResultRow {
  generation: string
  watermark_kind: SourceWatermark['kind']
  watermark_value: string
  dirty: boolean
}

interface FenceRow extends QueryResultRow {
  fence_id: string
  generation: string
  reason: string
  proposition_keys: string[]
  state: MaterializationFence['state']
  opened_at: Date
  closed_at: Date | null
}

interface SliceRow extends QueryResultRow {
  generation: string
  proposition_key: string
  qualified_proposition_key: string
  predicate: string
  domain_status: DomainResultStatus
  value: MaterializedValue | null
  valid_from: Date
  valid_to: Date | null
  recorded_seq: string
  conclusion: MaterializedConclusion
}

const STATE_COLUMNS = 'generation, watermark_kind, watermark_value, dirty'
const FENCE_COLUMNS = 'fence_id, generation, reason, proposition_keys, state, opened_at, closed_at'
const SLICE_COLUMNS =
  'generation, proposition_key, qualified_proposition_key, predicate, domain_status, value, valid_from, valid_to, recorded_seq, conclusion'

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new MaterializationStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new MaterializationStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new MaterializationStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

// A PostgreSQL `text` value cannot contain a NUL byte, so the composite key uses the unit
// separator. None of the components (a proposition key, an RFC3339 instant or a revision) can
// contain it.
function sliceKey(slice: ProjectionSlice): string {
  return `${slice.propositionKey}\u001f${slice.validity.validFrom}\u001f${slice.validity.validTo ?? ''}\u001f${slice.recordedSeq}`
}

function toFence(row: FenceRow, scopeRef: ScopeRef): MaterializationFence {
  return {
    fenceId: row.fence_id,
    scopeRef,
    generation: row.generation,
    reason: row.reason,
    propositionKeys: row.proposition_keys,
    state: row.state,
    openedAt: row.opened_at.toISOString(),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at.toISOString() }),
  }
}

function toState(row: StateRow, scopeRef: ScopeRef): ProjectionState {
  return {
    scopeRef,
    generation: row.generation,
    watermark: { kind: row.watermark_kind, value: row.watermark_value },
    dirty: row.dirty,
  }
}

function toSlice(row: SliceRow, scopeRef: ScopeRef): ProjectionSlice {
  return {
    scopeRef,
    generation: row.generation,
    propositionKey: row.proposition_key,
    qualifiedPropositionKey: row.qualified_proposition_key,
    predicate: row.predicate,
    domainStatus: row.domain_status,
    ...(row.value === null ? {} : { value: row.value }),
    validity: {
      validFrom: row.valid_from.toISOString(),
      ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    },
    recordedSeq: row.recorded_seq,
    conclusion: row.conclusion,
  }
}

/**
 * PostgreSQL materialisation store (SPEC D2/D3.1/D5.1). It reuses the `projection_state` table for
 * the generation/watermark/dirty row and adds the append-only `projection_slices` and the
 * `materialization_fences`. Every method runs inside the trusted tenant/space scope; RLS is a
 * second layer behind the explicit scope predicate. `commitProjection` locks the state row,
 * compares the expected generation, appends slices, advances the generation and closes the fence
 * in one transaction, so a committed generation can never be observed with an open fence.
 */
export class PostgresMaterializationStore implements MaterializationStore {
  readonly #db: ControlPostgresDatabase
  readonly #projectionRef: string

  constructor(database: ControlPostgresDatabase, projectionRef: string = MATERIALIZED_PROJECTION_REF) {
    this.#db = database
    this.#projectionRef = projectionRef
  }

  async getProjectionState(scopeRef: ScopeRef, ctx: ToolContext): Promise<ProjectionState | undefined> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const result = await client.query<StateRow>(
        `SELECT ${STATE_COLUMNS} FROM agent_platform.projection_state
          WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3`,
        [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toState(row, scopeRef)
    })
  }

  async markDirty(
    scopeRef: ScopeRef,
    input: MarkProjectionDirtyInput,
    ctx: ToolContext,
  ): Promise<ProjectionState> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const result = await client.query<StateRow>(
        `INSERT INTO agent_platform.projection_state
           (tenant_id, space_id, projection_ref, generation, watermark_kind, watermark_value, dirty, dirty_reason, updated_at)
         VALUES ($1, $2, $3, 0, 'sequence', '0', true, $4, now())
         ON CONFLICT (tenant_id, space_id, projection_ref)
         DO UPDATE SET dirty = true, dirty_reason = EXCLUDED.dirty_reason, updated_at = now()
         RETURNING ${STATE_COLUMNS}`,
        [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef, input.reason],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new MaterializationStoreError('MATERIALIZATION_STORE_FAILED', 'markDirty returned no row')
      }
      return toState(row, scopeRef)
    })
  }

  async openFence(
    scopeRef: ScopeRef,
    input: OpenMaterializationFenceInput,
    ctx: ToolContext,
  ): Promise<MaterializationFence> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const generation = await this.#lockGeneration(client, scopeRef)
      await client.query(
        `INSERT INTO agent_platform.materialization_fences
           (tenant_id, space_id, projection_ref, fence_id, generation, reason, proposition_keys, state, opened_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'open', $8)`,
        [
          scopeRef.tenantId,
          scopeRef.spaceId,
          this.#projectionRef,
          input.fenceId,
          generation,
          input.reason,
          JSON.stringify(input.propositionKeys),
          input.openedAt,
        ],
      )
      return {
        fenceId: input.fenceId,
        scopeRef,
        generation: String(generation),
        reason: input.reason,
        propositionKeys: [...input.propositionKeys],
        state: 'open',
        openedAt: input.openedAt,
      }
    })
  }

  async closeFence(
    scopeRef: ScopeRef,
    fenceId: Uuid,
    closedAt: string,
    ctx: ToolContext,
  ): Promise<MaterializationFence> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const result = await client.query<FenceRow>(
        `UPDATE agent_platform.materialization_fences
            SET state = 'closed', closed_at = $4
          WHERE tenant_id = $1 AND space_id = $2 AND fence_id = $3
          RETURNING ${FENCE_COLUMNS}`,
        [scopeRef.tenantId, scopeRef.spaceId, fenceId, closedAt],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new MaterializationStoreError('FENCE_NOT_FOUND', `fence ${fenceId} is not visible in this scope`)
      }
      return toFence(row, scopeRef)
    })
  }

  async getFence(
    scopeRef: ScopeRef,
    fenceId: Uuid,
    ctx: ToolContext,
  ): Promise<MaterializationFence | undefined> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const result = await client.query<FenceRow>(
        `SELECT ${FENCE_COLUMNS} FROM agent_platform.materialization_fences
          WHERE tenant_id = $1 AND space_id = $2 AND fence_id = $3`,
        [scopeRef.tenantId, scopeRef.spaceId, fenceId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toFence(row, scopeRef)
    })
  }

  async listOpenFences(scopeRef: ScopeRef, ctx: ToolContext): Promise<MaterializationFence[]> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      const result = await client.query<FenceRow>(
        `SELECT ${FENCE_COLUMNS} FROM agent_platform.materialization_fences
          WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3 AND state = 'open'
          ORDER BY opened_at, fence_id`,
        [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef],
      )
      return result.rows.map((row) => toFence(row, scopeRef))
    })
  }

  async readSlices(
    scopeRef: ScopeRef,
    request: ReadProjectionSlicesRequest,
    ctx: ToolContext,
  ): Promise<ProjectionSlice[]> {
    resolveScope(scopeRef, ctx)
    return this.#db.withIdentityScope(
      { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      async (client) => {
        const conditions = ['tenant_id = $1', 'space_id = $2', 'projection_ref = $3']
        const values: unknown[] = [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef]
        if (request.propositionKeys !== undefined) {
          values.push([...request.propositionKeys])
          conditions.push(`proposition_key = ANY($${String(values.length)}::text[])`)
        }
        if (request.validAt !== undefined) {
          values.push(request.validAt)
          const position = values.length
          conditions.push(`valid_from <= $${String(position)}`)
          conditions.push(`(valid_to IS NULL OR $${String(position)} < valid_to)`)
        }
        if (request.asOfRecordedSeq !== undefined) {
          values.push(request.asOfRecordedSeq)
          const position = values.length
          conditions.push(`(recorded_seq !~ '^[0-9]+$' OR recorded_seq::numeric <= $${String(position)}::numeric)`)
        }
        const limit = request.limit ?? 10_000
        values.push(limit)
        const result = await client.query<SliceRow>(
          `SELECT ${SLICE_COLUMNS} FROM agent_platform.projection_slices
            WHERE ${conditions.join(' AND ')}
            ORDER BY proposition_key, valid_from, recorded_seq
            LIMIT $${String(values.length)}`,
          values,
        )
        return result.rows.map((row) => toSlice(row, scopeRef))
      },
      { readOnly: true },
    )
  }

  async commitProjection(
    scopeRef: ScopeRef,
    input: CommitProjectionInput,
    ctx: ToolContext,
  ): Promise<ProjectionCommitResult> {
    resolveScope(scopeRef, ctx)
    const fenceIds = [...input.fenceId === undefined ? [] : [input.fenceId], ...input.additionalFenceIds ?? []]
    if ((input.additionalFenceIds?.length ?? 0) > 0 && (input.fenceId === undefined || fenceIds.length > 8 || new Set(fenceIds).size !== fenceIds.length)) {
      throw new MaterializationStoreError('MATERIALIZATION_STORE_FAILED', 'a projection batch requires at most eight distinct fences')
    }
    return this.#db.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      await client.query(
        `INSERT INTO agent_platform.projection_state
           (tenant_id, space_id, projection_ref, generation, watermark_kind, watermark_value, dirty, updated_at)
         VALUES ($1, $2, $3, 0, 'sequence', '0', false, now())
         ON CONFLICT (tenant_id, space_id, projection_ref) DO NOTHING`,
        [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef],
      )
      const current = await this.#lockGeneration(client, scopeRef)
      if (String(current) !== input.expectedGeneration) {
        throw new MaterializationStoreError(
          'GENERATION_CONFLICT',
          `the projection is at generation ${String(current)}, not ${input.expectedGeneration}`,
        )
      }
      if ((input.additionalFenceIds?.length ?? 0) > 0) {
        const fences = await client.query(
          `SELECT fence_id FROM agent_platform.materialization_fences
             WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3 AND fence_id = ANY($4::uuid[])
             FOR UPDATE`,
          [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef, fenceIds],
        )
        if (fences.rows.length !== fenceIds.length) throw new MaterializationStoreError('FENCE_NOT_FOUND', 'the projection batch contains a fence outside its actual scope or projection')
      }
      const next = current + 1
      let appended = 0
      for (const slice of input.slices) {
        const inserted = await client.query(
          `INSERT INTO agent_platform.projection_slices
             (tenant_id, space_id, projection_ref, slice_key, generation, proposition_key,
              qualified_proposition_key, predicate, domain_status, value, valid_from, valid_to,
              recorded_seq, conclusion)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::jsonb)
           ON CONFLICT (tenant_id, space_id, slice_key) DO NOTHING`,
          [
            scopeRef.tenantId,
            scopeRef.spaceId,
            this.#projectionRef,
            sliceKey(slice),
            next,
            slice.propositionKey,
            slice.qualifiedPropositionKey,
            slice.predicate,
            slice.domainStatus,
            slice.value === undefined ? null : JSON.stringify(slice.value),
            slice.validity.validFrom,
            slice.validity.validTo ?? null,
            slice.recordedSeq,
            JSON.stringify(slice.conclusion),
          ],
        )
        appended += inserted.rowCount ?? 0
      }
      const updated = await client.query<StateRow>(
        `UPDATE agent_platform.projection_state
            SET generation = $4, watermark_kind = $5, watermark_value = $6, dirty = false,
                dirty_reason = NULL, updated_at = now()
          WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3
          RETURNING ${STATE_COLUMNS}`,
        [
          scopeRef.tenantId,
          scopeRef.spaceId,
          this.#projectionRef,
          next,
          input.watermark.kind,
          input.watermark.value,
        ],
      )
      const row = updated.rows[0]
      if (row === undefined) {
        throw new MaterializationStoreError('MATERIALIZATION_STORE_FAILED', 'commitProjection updated no state row')
      }
      if (fenceIds.length > 0) {
        await client.query(
          `UPDATE agent_platform.materialization_fences
              SET state = 'closed', closed_at = $5
            WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3 AND fence_id = ANY($4::uuid[]) AND state = 'open'`,
          [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef, fenceIds, input.committedAt],
        )
      }
      return { state: toState(row, scopeRef), appendedSlices: appended }
    })
  }

  async #lockGeneration(client: PoolClient, scopeRef: ScopeRef): Promise<number> {
    const result = await client.query<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM agent_platform.projection_state
        WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3
        FOR UPDATE`,
      [scopeRef.tenantId, scopeRef.spaceId, this.#projectionRef],
    )
    const row = result.rows[0]
    return row === undefined ? 0 : Number(row.generation)
  }
}
