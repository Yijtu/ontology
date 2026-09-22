import { IdentityDecisionStoreError, isToolContext } from '@ontology/contracts'
import type {
  AppendIdentityDecisionInput,
  IdentityAssertionFilter,
  IdentityAssertionRecord,
  IdentityDecisionRecord,
  IdentityDecisionStore,
  IdentityEntityFilter,
  IdentityEntityRecord,
  IdentityEntityState,
  IdentityLinkConstraintRecord,
  IdentityScoreEvidence,
  IdentityStrongIdentity,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface EntityRow extends QueryResultRow {
  entity_id: string
  object_id: string
  identity_scope_id: string
  display_name: string | null
  state: IdentityEntityState
  revision: string
  recorded_at: Date
  updated_at: Date
}

interface DecisionRow extends QueryResultRow {
  decision_id: string
  candidate_id: string
  object_id: string
  identity_scope_id: string
  kind: IdentityDecisionRecord['kind']
  revision: string
  target_entity_id: string | null
  separated_candidate_ids: string[] | null
  evidence_refs: IdentityDecisionRecord['evidenceRefs']
  justification: string | null
  strong_identity: IdentityStrongIdentity | null
  score_evidence: IdentityScoreEvidence | null
  valid_from: Date | null
  valid_to: Date | null
  recorded_at: Date
  actor: string
  supersedes_revision: string | null
  invalidation_outbox_id: string | null
}

interface AssertionRow extends QueryResultRow {
  assertion_id: string
  candidate_id: string
  entity_id: string
  object_id: string
  identity_scope_id: string
  decision_id: string
  valid_from: Date
  valid_to: Date | null
  recorded_at: Date
}

interface ConstraintRow extends QueryResultRow {
  constraint_id: string
  candidate_id: string
  entity_id: string
  kind: 'cannot_link'
  decision_id: string
  recorded_at: Date
}

function toEntity(row: EntityRow): IdentityEntityRecord {
  return {
    entityId: row.entity_id,
    objectId: row.object_id,
    identityScopeId: row.identity_scope_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    state: row.state,
    revision: row.revision,
    recordedAt: row.recorded_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toDecision(row: DecisionRow): IdentityDecisionRecord {
  return {
    decisionId: row.decision_id,
    candidateId: row.candidate_id,
    objectId: row.object_id,
    identityScopeId: row.identity_scope_id,
    kind: row.kind,
    revision: row.revision,
    ...(row.target_entity_id === null ? {} : { targetEntityId: row.target_entity_id }),
    ...(row.separated_candidate_ids === null
      ? {}
      : { separatedCandidateIds: row.separated_candidate_ids }),
    evidenceRefs: row.evidence_refs,
    ...(row.justification === null ? {} : { justification: row.justification }),
    ...(row.strong_identity === null ? {} : { strongIdentity: row.strong_identity }),
    ...(row.score_evidence === null ? {} : { scoreEvidence: row.score_evidence }),
    ...(row.valid_from === null ? {} : { validFrom: row.valid_from.toISOString() }),
    ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    recordedAt: row.recorded_at.toISOString(),
    actor: row.actor,
    ...(row.supersedes_revision === null ? {} : { supersedesRevision: row.supersedes_revision }),
    ...(row.invalidation_outbox_id === null
      ? {}
      : { invalidationOutboxId: row.invalidation_outbox_id }),
  }
}

function toAssertion(row: AssertionRow): IdentityAssertionRecord {
  return {
    assertionId: row.assertion_id,
    candidateId: row.candidate_id,
    entityId: row.entity_id,
    objectId: row.object_id,
    identityScopeId: row.identity_scope_id,
    decisionId: row.decision_id,
    validFrom: row.valid_from.toISOString(),
    ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    recordedAt: row.recorded_at.toISOString(),
  }
}

function toConstraint(row: ConstraintRow): IdentityLinkConstraintRecord {
  return {
    constraintId: row.constraint_id,
    candidateId: row.candidate_id,
    entityId: row.entity_id,
    kind: row.kind,
    decisionId: row.decision_id,
    recordedAt: row.recorded_at.toISOString(),
  }
}

const ENTITY_COLUMNS = 'entity_id, object_id, identity_scope_id, display_name, state, revision, recorded_at, updated_at'
const DECISION_COLUMNS = `decision_id, candidate_id, object_id, identity_scope_id, kind, revision,
  target_entity_id, separated_candidate_ids, evidence_refs, justification, strong_identity,
  score_evidence, valid_from, valid_to, recorded_at, actor, supersedes_revision, invalidation_outbox_id`
const ASSERTION_COLUMNS = `assertion_id, candidate_id, entity_id, object_id, identity_scope_id, decision_id,
  valid_from, valid_to, recorded_at`

/**
 * PostgreSQL-backed identity decision store (migration 032). It connects as the non-owner
 * application role, so RLS is a real second line of defence behind the explicit
 * (tenant_id, space_id) predicates.
 *
 * `appendDecision` locks the candidate's decision head with `SELECT ... FOR UPDATE`, so two
 * concurrent decisions cannot both pass the same `expectedRevision`: the loser is a
 * `REVISION_CONFLICT` rather than an overwrite. The decision, the assertion/entity side
 * effect and the split invalidation outbox message all commit in one transaction.
 */
export class PostgresIdentityDecisionStore implements IdentityDecisionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async getEntity(
    scopeRef: ScopeRef,
    entityId: string,
    ctx: ToolContext,
  ): Promise<IdentityEntityRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<EntityRow>(
        `SELECT ${ENTITY_COLUMNS} FROM agent_platform.identity_entities
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND entity_id = $1`,
        [entityId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toEntity(row)
    })
  }

  async listEntities(
    scopeRef: ScopeRef,
    filter: IdentityEntityFilter,
    ctx: ToolContext,
  ): Promise<IdentityEntityRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const clauses = [
        `tenant_id = current_setting('app.tenant_id')::uuid`,
        `space_id = current_setting('app.space_id')::uuid`,
      ]
      const values: unknown[] = []
      if (filter.objectId !== undefined) {
        values.push(filter.objectId)
        clauses.push(`object_id = $${String(values.length)}`)
      }
      if (filter.state !== undefined) {
        values.push(filter.state)
        clauses.push(`state = $${String(values.length)}`)
      }
      values.push(filter.limit ?? 1000)
      const result = await query.query<EntityRow>(
        `SELECT ${ENTITY_COLUMNS} FROM agent_platform.identity_entities
          WHERE ${clauses.join(' AND ')}
          ORDER BY entity_id
          LIMIT $${String(values.length)}`,
        values,
      )
      return result.rows.map(toEntity)
    })
  }

  async latestRevision(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<RevisionString> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM agent_platform.identity_decision_heads
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1`,
        [candidateId],
      )
      return result.rows[0]?.revision ?? '0'
    })
  }

  async appendDecision(
    scopeRef: ScopeRef,
    input: AppendIdentityDecisionInput,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const draft = input.draft
      await query.query(
        `INSERT INTO agent_platform.identity_decision_heads (tenant_id, space_id, candidate_id, revision)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1, 0)
         ON CONFLICT (tenant_id, space_id, candidate_id) DO NOTHING`,
        [draft.candidateId],
      )
      const locked = await query.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM agent_platform.identity_decision_heads
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1
          FOR UPDATE`,
        [draft.candidateId],
      )
      const head = locked.rows[0]
      if (head === undefined) {
        throw new IdentityDecisionStoreError(
          'DECISION_STORE_FAILED',
          `decision head for candidate ${draft.candidateId} disappeared during append`,
        )
      }
      if (head.revision !== input.expectedRevision) {
        throw new IdentityDecisionStoreError(
          'REVISION_CONFLICT',
          `candidate ${draft.candidateId} is at revision ${head.revision}, not ${input.expectedRevision}`,
        )
      }
      const revisionNumber = Number(head.revision) + 1
      const revision = String(revisionNumber)

      if (input.entity !== undefined) {
        await query.query(
          `INSERT INTO agent_platform.identity_entities
             (tenant_id, space_id, entity_id, object_id, identity_scope_id, display_name, state,
              revision, recorded_at, updated_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, 1, $6::timestamptz, $7::timestamptz)
           ON CONFLICT (tenant_id, space_id, entity_id) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 state = EXCLUDED.state,
                 revision = agent_platform.identity_entities.revision + 1,
                 updated_at = EXCLUDED.updated_at`,
          [
            input.entity.entityId,
            input.entity.objectId,
            input.entity.identityScopeId,
            input.entity.displayName ?? null,
            input.entity.state,
            input.entity.recordedAt,
            input.entity.updatedAt,
          ],
        )
      }
      if (input.openAssertion !== undefined) {
        const assertion = input.openAssertion
        await query.query(
          `INSERT INTO agent_platform.identity_assertions
             (tenant_id, space_id, assertion_id, candidate_id, entity_id, object_id,
              identity_scope_id, decision_id, valid_from, valid_to, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)`,
          [
            assertion.assertionId,
            assertion.candidateId,
            assertion.entityId,
            assertion.objectId,
            assertion.identityScopeId,
            assertion.decisionId,
            assertion.validFrom,
            assertion.validTo ?? null,
            assertion.recordedAt,
          ],
        )
      }
      for (const close of input.closeAssertions ?? []) {
        const updated = await query.query(
          `UPDATE agent_platform.identity_assertions
              SET valid_to = $1::timestamptz
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND assertion_id = $2
              AND valid_to IS NULL`,
          [close.validTo, close.assertionId],
        )
        if (updated.rowCount === 0) {
          throw new IdentityDecisionStoreError(
            'DECISION_STORE_FAILED',
            `assertion ${close.assertionId} is not open in this scope`,
          )
        }
      }
      if (input.linkConstraint !== undefined) {
        const constraint = input.linkConstraint
        await query.query(
          `INSERT INTO agent_platform.identity_link_constraints
             (tenant_id, space_id, constraint_id, candidate_id, entity_id, kind, decision_id, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6::timestamptz)
           ON CONFLICT (tenant_id, space_id, candidate_id, entity_id, kind) DO NOTHING`,
          [
            constraint.constraintId,
            constraint.candidateId,
            constraint.entityId,
            constraint.kind,
            constraint.decisionId,
            constraint.recordedAt,
          ],
        )
      }
      let invalidationOutboxId: string | undefined
      if (input.invalidation !== undefined) {
        const event = input.invalidation
        const jobId = input.outboxJobId
        if (jobId === undefined) {
          throw new IdentityDecisionStoreError(
            'DECISION_STORE_FAILED',
            'a split invalidation needs the anchoring job id for the outbox message',
          )
        }
        invalidationOutboxId = event.eventId
        await query.query(
          `INSERT INTO agent_platform.job_outbox
             (tenant_id, space_id, outbox_id, job_id, topic, payload, idempotency_key, state,
              available_at, created_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4::jsonb, $5, 'pending', $6::timestamptz, $6::timestamptz)
           ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
          [
            event.eventId,
            jobId,
            event.topic,
            JSON.stringify(event),
            `identity-invalidation:${draft.decisionId}`,
            event.recordedAt,
          ],
        )
      }

      const inserted = await query.query<DecisionRow>(
        `INSERT INTO agent_platform.identity_decisions (
           tenant_id, space_id, decision_id, candidate_id, object_id, identity_scope_id, kind,
           revision, target_entity_id, separated_candidate_ids, evidence_refs, justification,
           strong_identity, score_evidence, valid_from, valid_to, recorded_at, actor,
           supersedes_revision, invalidation_outbox_id)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12::jsonb,
           $13::timestamptz, $14::timestamptz, $15::timestamptz, $16, $17, $18)
         RETURNING ${DECISION_COLUMNS}`,
        [
          draft.decisionId,
          draft.candidateId,
          draft.objectId,
          draft.identityScopeId,
          draft.kind,
          revision,
          draft.targetEntityId ?? null,
          draft.separatedCandidateIds === undefined ? null : JSON.stringify(draft.separatedCandidateIds),
          JSON.stringify(draft.evidenceRefs),
          draft.justification ?? null,
          draft.strongIdentity === undefined ? null : JSON.stringify(draft.strongIdentity),
          draft.scoreEvidence === undefined ? null : JSON.stringify(draft.scoreEvidence),
          draft.validFrom ?? null,
          draft.validTo ?? null,
          draft.recordedAt,
          draft.actor,
          revisionNumber === 1 ? null : head.revision,
          invalidationOutboxId ?? null,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'the decision insert returned no row')
      }
      await query.query(
        `UPDATE agent_platform.identity_decision_heads
            SET revision = $1
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $2`,
        [revisionNumber, draft.candidateId],
      )
      return toDecision(row)
    })
  }

  async getDecision(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<DecisionRow>(
        `SELECT ${DECISION_COLUMNS} FROM agent_platform.identity_decisions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1
            AND revision = $2::bigint`,
        [candidateId, revision],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toDecision(row)
    })
  }

  async listDecisions(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<IdentityDecisionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<DecisionRow>(
        `SELECT ${DECISION_COLUMNS} FROM agent_platform.identity_decisions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1
          ORDER BY revision`,
        [candidateId],
      )
      return result.rows.map(toDecision)
    })
  }

  async listAssertions(
    scopeRef: ScopeRef,
    filter: IdentityAssertionFilter,
    ctx: ToolContext,
  ): Promise<IdentityAssertionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const clauses = [
        `tenant_id = current_setting('app.tenant_id')::uuid`,
        `space_id = current_setting('app.space_id')::uuid`,
      ]
      const values: unknown[] = []
      if (filter.entityId !== undefined) {
        values.push(filter.entityId)
        clauses.push(`entity_id = $${String(values.length)}`)
      }
      if (filter.candidateId !== undefined) {
        values.push(filter.candidateId)
        clauses.push(`candidate_id = $${String(values.length)}`)
      }
      if (filter.openOnly === true) {
        clauses.push(`valid_to IS NULL`)
      }
      const result = await query.query<AssertionRow>(
        `SELECT ${ASSERTION_COLUMNS} FROM agent_platform.identity_assertions
          WHERE ${clauses.join(' AND ')}
          ORDER BY recorded_at, assertion_id`,
        values,
      )
      return result.rows.map(toAssertion)
    })
  }

  async listLinkConstraints(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<IdentityLinkConstraintRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ConstraintRow>(
        `SELECT constraint_id, candidate_id, entity_id, kind, decision_id, recorded_at
           FROM agent_platform.identity_link_constraints
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1`,
        [candidateId],
      )
      return result.rows.map(toConstraint)
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new IdentityDecisionStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new IdentityDecisionStoreError(
        'SCOPE_MISMATCH',
        'request scope does not match the trusted principal scope',
      )
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
