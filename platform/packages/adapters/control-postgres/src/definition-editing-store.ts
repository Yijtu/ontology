import type { QueryResultRow } from 'pg'
import {
  DefinitionEditingStoreError,
  isToolContext,
} from '@ontology/contracts'
import type {
  DefinitionAffectedDefinition,
  DefinitionCompatibilityReport,
  DefinitionEditAdjudication,
  DefinitionEditingStore,
  DefinitionRevisionStrategy,
  DefinitionValidationFinding,
  ScopeRef,
  ToolContext,
  UnsupportedDefinitionRule,
  Uuid,
} from '@ontology/contracts'
import type { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface AdjudicationRow extends QueryResultRow {
  adjudication_id: string
  workspace_id: string
  kind: DefinitionEditAdjudication['kind']
  candidate_ids: string[]
  produced_candidate_ids: string[]
  reason: string
  affected: readonly DefinitionAffectedDefinition[]
  findings: readonly DefinitionValidationFinding[]
  compatibility: DefinitionCompatibilityReport
  strategy: DefinitionRevisionStrategy | null
  request_digest: string
  idempotency_key: string
  actor: string
  recorded_at: Date
}

interface UnsupportedRuleRow extends QueryResultRow {
  rule_id: string
  workspace_id: string
  source_candidate_id: string | null
  reason: string
  raw_form: unknown
  executable: boolean
  idempotency_key: string
  actor: string
  recorded_at: Date
}

const ADJUDICATION_COLUMNS = `adjudication_id, workspace_id, kind, candidate_ids, produced_candidate_ids,
  reason, affected, findings, compatibility, strategy, request_digest, idempotency_key, actor, recorded_at`

const RULE_COLUMNS = `rule_id, workspace_id, source_candidate_id, reason, raw_form, executable,
  idempotency_key, actor, recorded_at`

function toAdjudication(row: AdjudicationRow): DefinitionEditAdjudication {
  return {
    adjudicationId: row.adjudication_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    candidateIds: row.candidate_ids,
    producedCandidateIds: row.produced_candidate_ids,
    reason: row.reason,
    affected: row.affected,
    findings: row.findings,
    compatibility: row.compatibility,
    ...(row.strategy === null ? {} : { strategy: row.strategy }),
    requestDigest: row.request_digest as DefinitionEditAdjudication['requestDigest'],
    idempotencyKey: row.idempotency_key,
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function toUnsupportedRule(row: UnsupportedRuleRow): UnsupportedDefinitionRule {
  return {
    ruleId: row.rule_id,
    workspaceId: row.workspace_id,
    ...(row.source_candidate_id === null ? {} : { sourceCandidateId: row.source_candidate_id }),
    reason: row.reason,
    rawForm: row.raw_form,
    executable: false,
    idempotencyKey: row.idempotency_key,
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
  }
}

/**
 * Real PostgreSQL implementation of the definition-editing store (SPEC v0.3a §4.1, migration
 * 063).
 *
 * Adjudications are the append-only human decision record; the candidate revisions themselves
 * live in `asset_candidate_versions`, so this store never duplicates the approve truth. Every
 * statement runs in one transaction whose trusted scope is set with `SET LOCAL` semantics, so
 * RLS applies as a second layer behind the explicit scope predicate. Both writes are idempotent
 * on their key; a replay returns the stored row and a reused key with different content is an
 * `IDEMPOTENCY_CONFLICT`.
 */
export class PostgresDefinitionEditingStore implements DefinitionEditingStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async appendAdjudication(
    scopeRef: ScopeRef,
    adjudication: DefinitionEditAdjudication,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<AdjudicationRow>(
        `INSERT INTO agent_platform.asset_definition_adjudications
           (tenant_id, space_id, adjudication_id, workspace_id, kind, candidate_ids, produced_candidate_ids,
            reason, affected, findings, compatibility, strategy, request_digest, idempotency_key, actor,
            trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11, $12, $13, current_setting('app.trace_id', true), $14::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${ADJUDICATION_COLUMNS}`,
        [
          adjudication.adjudicationId,
          adjudication.workspaceId,
          adjudication.kind,
          JSON.stringify(adjudication.candidateIds),
          JSON.stringify(adjudication.producedCandidateIds),
          adjudication.reason,
          JSON.stringify(adjudication.affected),
          JSON.stringify(adjudication.findings),
          JSON.stringify(adjudication.compatibility),
          adjudication.strategy === undefined ? null : JSON.stringify(adjudication.strategy),
          adjudication.requestDigest,
          adjudication.idempotencyKey,
          adjudication.actor,
          adjudication.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toAdjudication(row)

      const existing = await this.#adjudicationByIdempotencyKey(query, adjudication.idempotencyKey)
      if (existing === undefined) {
        const duplicate = await query.query<AdjudicationRow>(
          `SELECT ${ADJUDICATION_COLUMNS} FROM agent_platform.asset_definition_adjudications
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND adjudication_id = $1::uuid`,
          [adjudication.adjudicationId],
        )
        if (duplicate.rows[0] !== undefined) {
          throw new DefinitionEditingStoreError(
            'ADJUDICATION_EXISTS',
            `adjudication ${adjudication.adjudicationId} already exists`,
          )
        }
        throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'the idempotent adjudication row is missing')
      }
      if (existing.request_digest !== adjudication.requestDigest) {
        throw new DefinitionEditingStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different adjudication',
        )
      }
      return toAdjudication(existing)
    })
  }

  async listAdjudications(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication[]> {
    const page = normalizeLimit(limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AdjudicationRow>(
        `SELECT ${ADJUDICATION_COLUMNS} FROM agent_platform.asset_definition_adjudications
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
          ORDER BY recorded_at ASC, adjudication_id ASC
          LIMIT $2`,
        [workspaceId, page],
      )
      return result.rows.map(toAdjudication)
    })
  }

  async findAdjudicationByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#adjudicationByIdempotencyKey(query, idempotencyKey)
      return row === undefined ? undefined : toAdjudication(row)
    })
  }

  async recordUnsupportedRule(
    scopeRef: ScopeRef,
    rule: UnsupportedDefinitionRule,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule> {
    if (rule.executable !== false) {
      throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'an unsupported rule must be non-executable')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<UnsupportedRuleRow>(
        `INSERT INTO agent_platform.asset_definition_unsupported_rules
           (tenant_id, space_id, rule_id, workspace_id, source_candidate_id, reason, raw_form, executable,
            idempotency_key, actor, trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2::uuid, $3::uuid, $4, $5::jsonb, false, $6, $7,
           current_setting('app.trace_id', true), $8::timestamptz)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
         RETURNING ${RULE_COLUMNS}`,
        [
          rule.ruleId,
          rule.workspaceId,
          rule.sourceCandidateId ?? null,
          rule.reason,
          JSON.stringify(rule.rawForm ?? null),
          rule.idempotencyKey,
          rule.actor,
          rule.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return toUnsupportedRule(row)

      const existing = await this.#ruleByIdempotencyKey(query, rule.idempotencyKey)
      if (existing === undefined) {
        const duplicate = await query.query<UnsupportedRuleRow>(
          `SELECT ${RULE_COLUMNS} FROM agent_platform.asset_definition_unsupported_rules
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND rule_id = $1`,
          [rule.ruleId],
        )
        if (duplicate.rows[0] !== undefined) {
          throw new DefinitionEditingStoreError(
            'UNSUPPORTED_RULE_EXISTS',
            `unsupported rule ${rule.ruleId} already exists`,
          )
        }
        throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'the idempotent unsupported-rule row is missing')
      }
      if (
        existing.rule_id !== rule.ruleId ||
        existing.reason !== rule.reason ||
        JSON.stringify(existing.raw_form) !== JSON.stringify(rule.rawForm ?? null)
      ) {
        throw new DefinitionEditingStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different unsupported rule',
        )
      }
      return toUnsupportedRule(existing)
    })
  }

  async listUnsupportedRules(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule[]> {
    const page = normalizeLimit(limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<UnsupportedRuleRow>(
        `SELECT ${RULE_COLUMNS} FROM agent_platform.asset_definition_unsupported_rules
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
          ORDER BY recorded_at ASC, rule_id ASC
          LIMIT $2`,
        [workspaceId, page],
      )
      return result.rows.map(toUnsupportedRule)
    })
  }

  async #adjudicationByIdempotencyKey(query: ScopedQuery, key: string): Promise<AdjudicationRow | undefined> {
    const result = await query.query<AdjudicationRow>(
      `SELECT ${ADJUDICATION_COLUMNS} FROM agent_platform.asset_definition_adjudications
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #ruleByIdempotencyKey(query: ScopedQuery, key: string): Promise<UnsupportedRuleRow | undefined> {
    const result = await query.query<UnsupportedRuleRow>(
      `SELECT ${RULE_COLUMNS} FROM agent_platform.asset_definition_unsupported_rules
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
      throw new DefinitionEditingStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new DefinitionEditingStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new DefinitionEditingStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}
