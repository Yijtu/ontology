import type { QueryResultRow } from 'pg'
import {
  RuleActionCandidateStoreError,
  assertRuleActionCandidateShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  ActionCandidatePayload,
  ResourceRef,
  RuleActionCandidateQuery,
  RuleActionCandidateStore,
  RuleActionCandidateTransition,
  RuleActionCandidateVersion,
  RuleCandidatePayload,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface CandidateRow extends QueryResultRow {
  candidate_id: string
  workspace_id: string
  logical_id: string
  domain: 'definition'
  kind: 'rule' | 'action'
  display_name: string
  business_meaning: string
  suggested_reason: string
  payload: RuleCandidatePayload | ActionCandidatePayload
  source_refs: ResourceRef[]
  source_spans: RuleActionCandidateVersion['sourceSpans']
  lifecycle: RuleActionCandidateVersion['lifecycle']
  enabled_at: Date | null
  replaces_candidate_id: string | null
  generation_call_ref: ResourceRef | null
  content_digest: string
  idempotency_key: string
  actor: string
  recorded_at: Date
}

const COLUMNS = `candidate_id, workspace_id, logical_id, domain, kind, display_name, business_meaning,
  suggested_reason, payload, source_refs, source_spans, lifecycle, enabled_at, replaces_candidate_id,
  generation_call_ref, content_digest, idempotency_key, actor, recorded_at`

function toCandidate(row: CandidateRow): RuleActionCandidateVersion {
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id,
    logicalId: row.logical_id,
    domain: row.domain,
    kind: row.kind,
    displayName: row.display_name,
    businessMeaning: row.business_meaning,
    suggestedReason: row.suggested_reason,
    payload: row.payload,
    sourceRefs: row.source_refs,
    sourceSpans: row.source_spans,
    lifecycle: row.lifecycle,
    ...(row.enabled_at === null ? {} : { enabledAt: row.enabled_at.toISOString() }),
    ...(row.replaces_candidate_id === null ? {} : { replacesCandidateId: row.replaces_candidate_id }),
    ...(row.generation_call_ref === null ? {} : { generationCallRef: row.generation_call_ref }),
    contentDigest: row.content_digest as RuleActionCandidateVersion['contentDigest'],
    idempotencyKey: row.idempotency_key as RuleActionCandidateVersion['idempotencyKey'],
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RuleActionCandidateStoreError('INVALID_CANDIDATE', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}

/**
 * Real PostgreSQL implementation of the rule/action candidate store (SPEC v0.3a §4.1,
 * migration 064).
 *
 * Every statement runs in one transaction whose trusted scope is set with `SET LOCAL`
 * semantics, so RLS applies as a second layer behind the explicit scope predicate. `insert` is
 * idempotent on `idempotencyKey` and never mutates an existing candidate; the lifecycle
 * transition only ever advances a stored row and never rewrites its payload.
 */
export class PostgresRuleActionCandidateStore implements RuleActionCandidateStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insert(
    scopeRef: ScopeRef,
    candidate: RuleActionCandidateVersion,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion> {
    assertRuleActionCandidateShape(candidate)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<CandidateRow>(
        `INSERT INTO agent_platform.asset_rule_action_candidates
           (tenant_id, space_id, candidate_id, workspace_id, logical_id, domain, kind, display_name,
            business_meaning, suggested_reason, payload, source_refs, source_spans, lifecycle, enabled_at,
            replaces_candidate_id, generation_call_ref, content_digest, idempotency_key, actor, trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::timestamptz,
           $14::uuid, $15::jsonb, $16, $17, $18, current_setting('app.trace_id', true), $19::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          candidate.candidateId,
          candidate.workspaceId,
          candidate.logicalId,
          candidate.domain,
          candidate.kind,
          candidate.displayName,
          candidate.businessMeaning,
          candidate.suggestedReason,
          JSON.stringify(candidate.payload),
          JSON.stringify(candidate.sourceRefs),
          JSON.stringify(candidate.sourceSpans),
          candidate.lifecycle,
          candidate.enabledAt ?? null,
          candidate.replacesCandidateId ?? null,
          candidate.generationCallRef === undefined ? null : JSON.stringify(candidate.generationCallRef),
          candidate.contentDigest,
          candidate.idempotencyKey,
          candidate.actor,
          candidate.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toCandidate(row)

      const existing = await this.#byIdempotencyKey(query, candidate.idempotencyKey)
      if (existing === undefined) {
        throw new RuleActionCandidateStoreError('STORE_FAILED', 'the idempotent candidate row is missing')
      }
      if (existing.content_digest !== candidate.contentDigest) {
        throw new RuleActionCandidateStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different candidate',
        )
      }
      return toCandidate(existing)
    })
  }

  async get(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CandidateRow>(
        `SELECT ${COLUMNS} FROM agent_platform.asset_rule_action_candidates
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1::uuid`,
        [candidateId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toCandidate(row)
    })
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: RuleActionCandidateQuery,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion[]> {
    const limit = normalizeLimit(query.limit)
    return this.#withScope(scopeRef, ctx, async (db) => {
      const result = await db.query<CandidateRow>(
        `SELECT ${COLUMNS} FROM agent_platform.asset_rule_action_candidates
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
            AND ($2::text IS NULL OR kind = $2)
            AND ($3::text IS NULL OR lifecycle = $3)
          ORDER BY recorded_at ASC, candidate_id ASC
          LIMIT $4`,
        [workspaceId, query.kind ?? null, query.lifecycle ?? null, limit],
      )
      return result.rows.map(toCandidate)
    })
  }

  async transition(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: RuleActionCandidateTransition,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion> {
    if (transition.lifecycle === 'enabled' && transition.enabledAt === undefined) {
      throw new RuleActionCandidateStoreError(
        'INVALID_CANDIDATE',
        'enabling a candidate requires the transition timestamp',
      )
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const updated = await query.query<CandidateRow>(
        `UPDATE agent_platform.asset_rule_action_candidates
            SET lifecycle = $2, enabled_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1::uuid
          RETURNING ${COLUMNS}`,
        [candidateId, transition.lifecycle, transition.lifecycle === 'enabled' ? transition.enabledAt ?? null : null],
      )
      const row = updated.rows[0]
      if (row === undefined) {
        throw new RuleActionCandidateStoreError(
          'CANDIDATE_NOT_FOUND',
          `candidate ${candidateId} is not visible in this scope`,
        )
      }
      return toCandidate(row)
    })
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<CandidateRow | undefined> {
    const result = await query.query<CandidateRow>(
      `SELECT ${COLUMNS} FROM agent_platform.asset_rule_action_candidates
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
