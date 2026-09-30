import type { QueryResultRow } from 'pg'
import {
  AssetCandidateStoreError,
  assertAssetCandidateBatchShape,
  assertAssetCandidateVersionShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  AssetCandidateBatch,
  AssetCandidateInsertResult,
  AssetCandidateQuery,
  AssetCandidateStateTransition,
  AssetCandidateStore,
  AssetCandidateVersion,
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

interface BatchRow extends QueryResultRow {
  batch_id: string
  workspace_id: string
  input_draft_ref: AssetCandidateBatch['inputDraftRef']
  model_ref: AssetCandidateBatch['modelRef']
  response_schema_ref: AssetCandidateBatch['responseSchemaRef']
  schema_digest: string | null
  document_set_ref: AssetCandidateBatch['documentSetRef']
  generation_policy_ref: AssetCandidateBatch['generationPolicyRef']
  state: AssetCandidateBatch['state']
  counts: AssetCandidateBatch['counts']
  error: AssetCandidateBatch['error'] | null
  idempotency_key: string
  request_digest: string
  created_by: string
  recorded_at: Date
}

interface CandidateRow extends QueryResultRow {
  candidate_id: string
  batch_id: string
  workspace_id: string
  logical_id: string
  kind: AssetCandidateVersion['kind']
  payload: AssetCandidateVersion['payload']
  input_draft_ref: AssetCandidateVersion['inputDraftRef']
  source_refs: AssetCandidateVersion['sourceRefs']
  source_spans: AssetCandidateVersion['sourceSpans']
  state: AssetCandidateVersion['state']
  issues: AssetCandidateVersion['issues']
  pending_confirmation: boolean
  replaces_candidate_id: string | null
  generation_call_ref: AssetCandidateVersion['generationCallRef'] | null
  content_digest: string
  idempotency_key: string
  recorded_at: Date
}

const BATCH_COLUMNS = `batch_id, workspace_id, input_draft_ref, model_ref, response_schema_ref,
  schema_digest, document_set_ref, generation_policy_ref, state, counts, error, idempotency_key,
  request_digest, created_by, recorded_at`

const CANDIDATE_COLUMNS = `candidate_id, batch_id, workspace_id, logical_id, kind, payload,
  input_draft_ref, source_refs, source_spans, state, issues, pending_confirmation,
  replaces_candidate_id, generation_call_ref, content_digest, idempotency_key, recorded_at`

function toBatch(row: BatchRow): AssetCandidateBatch {
  return {
    batchId: row.batch_id,
    workspaceId: row.workspace_id,
    domain: 'definition',
    inputDraftRef: row.input_draft_ref,
    modelRef: row.model_ref,
    responseSchemaRef: row.response_schema_ref,
    ...(row.schema_digest === null ? {} : { schemaDigest: row.schema_digest }),
    documentSetRef: row.document_set_ref,
    generationPolicyRef: row.generation_policy_ref,
    state: row.state,
    counts: row.counts,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    ...(row.error == null ? {} : { error: row.error }),
    createdBy: row.created_by,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function toCandidate(row: CandidateRow): AssetCandidateVersion {
  return {
    candidateId: row.candidate_id,
    batchId: row.batch_id,
    workspaceId: row.workspace_id,
    logicalId: row.logical_id,
    domain: 'definition',
    kind: row.kind,
    payload: row.payload,
    inputDraftRef: row.input_draft_ref,
    sourceRefs: row.source_refs,
    sourceSpans: row.source_spans,
    state: row.state,
    issues: row.issues,
    pendingConfirmation: row.pending_confirmation,
    ...(row.replaces_candidate_id === null ? {} : { replacesCandidateId: row.replaces_candidate_id }),
    ...(row.generation_call_ref == null ? {} : { generationCallRef: row.generation_call_ref }),
    contentDigest: row.content_digest,
    idempotencyKey: row.idempotency_key,
    recordedAt: row.recorded_at.toISOString(),
  }
}

/**
 * Real PostgreSQL implementation of the definition-candidate store (SPEC v0.3a §4.1).
 *
 * Every statement runs inside one transaction whose trusted scope is set with `SET LOCAL`
 * semantics, so RLS applies to the whole call as a second layer behind the explicit scope
 * predicate. `insertBatch` writes the immutable batch and its candidates atomically and is
 * idempotent on `idempotency_key`: a replayed generation reads back the stored batch, and the
 * same key with a different request digest is an IDEMPOTENCY_CONFLICT (never an overwrite).
 * Candidate rows are append-only; a state transition never rewrites the payload.
 */
export class PostgresAssetCandidateStore implements AssetCandidateStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insertBatch(
    scopeRef: ScopeRef,
    batch: AssetCandidateBatch,
    candidates: readonly AssetCandidateVersion[],
    ctx: ToolContext,
  ): Promise<AssetCandidateInsertResult> {
    assertAssetCandidateBatchShape(batch)
    for (const candidate of candidates) assertAssetCandidateVersionShape(candidate)

    return this.#withScope(scopeRef, ctx, async (query) => {
      const prior = await this.#batchByIdempotencyKey(query, batch.idempotencyKey)
      if (prior !== undefined) {
        if (prior.request_digest !== batch.requestDigest) {
          throw new AssetCandidateStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        const stored = await this.#candidatesOfBatch(query, prior.batch_id)
        return { batch: toBatch(prior), candidates: stored, created: false }
      }

      const inserted = await query.query<{ batch_id: string }>(
        `INSERT INTO agent_platform.asset_candidate_batches (
           tenant_id, space_id, batch_id, workspace_id, input_draft_ref, model_ref,
           response_schema_ref, schema_digest, document_set_ref, generation_policy_ref, state,
           counts, error, idempotency_key, request_digest, created_by, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb,
           $11::jsonb, $12, $13, $14, $15::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING batch_id`,
        [
          batch.batchId,
          batch.workspaceId,
          JSON.stringify(batch.inputDraftRef),
          JSON.stringify(batch.modelRef),
          JSON.stringify(batch.responseSchemaRef),
          batch.schemaDigest ?? null,
          JSON.stringify(batch.documentSetRef),
          JSON.stringify(batch.generationPolicyRef),
          batch.state,
          JSON.stringify(batch.counts),
          batch.error === undefined ? null : JSON.stringify(batch.error),
          batch.idempotencyKey,
          batch.requestDigest,
          batch.createdBy,
          batch.recordedAt,
        ],
      )
      if (inserted.rows[0] === undefined) {
        // A concurrent identical request won the insert; read back the committed winner.
        const winner = await this.#batchByIdempotencyKey(query, batch.idempotencyKey)
        if (winner === undefined) {
          throw new AssetCandidateStoreError('STORE_FAILED', 'the batch conflicted without an existing row')
        }
        if (winner.request_digest !== batch.requestDigest) {
          throw new AssetCandidateStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        return {
          batch: toBatch(winner),
          candidates: await this.#candidatesOfBatch(query, winner.batch_id),
          created: false,
        }
      }

      for (const candidate of candidates) {
        await query.query(
          `INSERT INTO agent_platform.asset_candidate_versions (
             tenant_id, space_id, candidate_id, batch_id, workspace_id, logical_id, kind, payload,
             input_draft_ref, source_refs, source_spans, state, issues, pending_confirmation,
             replaces_candidate_id, generation_call_ref, content_digest, idempotency_key, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb,
             $12, $13, $14::jsonb, $15, $16, $17::timestamptz)
           ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
          [
            candidate.candidateId,
            candidate.batchId,
            candidate.workspaceId,
            candidate.logicalId,
            candidate.kind,
            JSON.stringify(candidate.payload),
            JSON.stringify(candidate.inputDraftRef),
            JSON.stringify(candidate.sourceRefs),
            JSON.stringify(candidate.sourceSpans),
            candidate.state,
            JSON.stringify(candidate.issues),
            candidate.pendingConfirmation,
            candidate.replacesCandidateId ?? null,
            candidate.generationCallRef === undefined ? null : JSON.stringify(candidate.generationCallRef),
            candidate.contentDigest,
            candidate.idempotencyKey,
            candidate.recordedAt,
          ],
        )
      }
      const stored = await this.#candidatesOfBatch(query, batch.batchId)
      return { batch, candidates: stored, created: true }
    })
  }

  async getBatch(
    scopeRef: ScopeRef,
    batchId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<BatchRow>(
        `SELECT ${BATCH_COLUMNS} FROM agent_platform.asset_candidate_batches
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND batch_id = $1`,
        [batchId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toBatch(row)
    })
  }

  async findBatchByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#batchByIdempotencyKey(query, idempotencyKey)
      return row === undefined ? undefined : toBatch(row)
    })
  }

  async listBatches(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<BatchRow>(
        `SELECT ${BATCH_COLUMNS} FROM agent_platform.asset_candidate_batches
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1
          ORDER BY recorded_at, batch_id
          LIMIT $2`,
        [workspaceId, limit],
      )
      return result.rows.map(toBatch)
    })
  }

  async getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM agent_platform.asset_candidate_versions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1`,
        [candidateId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toCandidate(row)
    })
  }

  async listCandidates(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: AssetCandidateQuery,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]> {
    return this.#withScope(scopeRef, ctx, async (scoped) => {
      const clauses = [
        `tenant_id = current_setting('app.tenant_id')::uuid`,
        `space_id = current_setting('app.space_id')::uuid`,
        `workspace_id = $1`,
      ]
      const values: unknown[] = [workspaceId]
      if (query.kind !== undefined) {
        values.push(query.kind)
        clauses.push(`kind = $${String(values.length)}`)
      }
      if (query.state !== undefined) {
        values.push(query.state)
        clauses.push(`state = $${String(values.length)}`)
      }
      values.push(query.limit ?? 1_000)
      const result = await scoped.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM agent_platform.asset_candidate_versions
          WHERE ${clauses.join(' AND ')}
          ORDER BY recorded_at, candidate_id
          LIMIT $${String(values.length)}`,
        values,
      )
      return result.rows.map(toCandidate)
    })
  }

  async listCandidatesByBatch(
    scopeRef: ScopeRef,
    batchId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]> {
    return this.#withScope(scopeRef, ctx, (query) => this.#candidatesOfBatch(query, batchId))
  }

  async transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: AssetCandidateStateTransition,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CandidateRow>(
        `UPDATE agent_platform.asset_candidate_versions
            SET state = $1, issues = $2::jsonb, transitioned_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $4
          RETURNING ${CANDIDATE_COLUMNS}`,
        [transition.state, JSON.stringify(transition.issues), transition.transitionedAt, candidateId],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new AssetCandidateStoreError(
          'CANDIDATE_NOT_FOUND',
          `candidate ${candidateId} is not visible in this scope`,
        )
      }
      return toCandidate(row)
    })
  }

  async #batchByIdempotencyKey(query: ScopedQuery, idempotencyKey: string): Promise<BatchRow | undefined> {
    const result = await query.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM agent_platform.asset_candidate_batches
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [idempotencyKey],
    )
    return result.rows[0]
  }

  async #candidatesOfBatch(query: ScopedQuery, batchId: Uuid): Promise<AssetCandidateVersion[]> {
    const result = await query.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM agent_platform.asset_candidate_versions
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND batch_id = $1
        ORDER BY recorded_at, candidate_id`,
      [batchId],
    )
    return result.rows.map(toCandidate)
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new AssetCandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new AssetCandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
