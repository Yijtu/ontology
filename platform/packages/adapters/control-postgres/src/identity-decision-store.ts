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
  IdentityPublishedBindingSnapshot,
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
  scope_dimensions: Record<string, string>
  created_from_candidate_id: string | null
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
    scopeDimensions: row.scope_dimensions,
    ...(row.created_from_candidate_id === null ? {} : { createdFromCandidateId: row.created_from_candidate_id }),
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

const ENTITY_COLUMNS = `entity_id, object_id, identity_scope_id, scope_dimensions, created_from_candidate_id,
  display_name, state, revision, recorded_at, updated_at`
const DECISION_COLUMNS = `decision_id, candidate_id, object_id, identity_scope_id, kind, revision,
  target_entity_id, separated_candidate_ids, evidence_refs, justification, strong_identity,
  score_evidence, valid_from, valid_to, recorded_at, actor, supersedes_revision, invalidation_outbox_id`
const ASSERTION_COLUMNS = `assertion_id, candidate_id, entity_id, object_id, identity_scope_id, decision_id,
  valid_from, valid_to, recorded_at`
const MAX_BINDING_CANDIDATES = 1_000

async function readScopeRevision(query: ScopedQuery): Promise<RevisionString> {
  const result = await query.query<{ revision: string }>(
    `SELECT revision::text AS revision FROM agent_platform.identity_scope_read_heads
      WHERE tenant_id = current_setting('app.tenant_id')::uuid
        AND space_id = current_setting('app.space_id')::uuid`,
  )
  return result.rows[0]?.revision ?? '0'
}

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

  async latestReadRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString> {
    return this.#withScope(scopeRef, ctx, readScopeRevision)
  }

  async readPublishedBindings(
    scopeRef: ScopeRef,
    candidateIds: readonly Uuid[],
    ctx: ToolContext,
  ): Promise<IdentityPublishedBindingSnapshot> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const before = await readScopeRevision(query)
      const boundedIds = [...new Set(candidateIds)].slice(0, MAX_BINDING_CANDIDATES)
      const rowsByCandidate = new Map(
        boundedIds.map((candidateId) => [
          candidateId,
          { candidateId, openAssertions: [] as IdentityAssertionRecord[], cannotLinkEntityIds: new Set<string>() },
        ]),
      )

      if (boundedIds.length > 0) {
        const assertions = await query.query<AssertionRow>(
          `SELECT ${ASSERTION_COLUMNS} FROM agent_platform.identity_assertions
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND candidate_id = ANY($1::uuid[])
              AND valid_to IS NULL
            ORDER BY candidate_id, recorded_at, assertion_id`,
          [boundedIds],
        )
        for (const row of assertions.rows) rowsByCandidate.get(row.candidate_id)?.openAssertions.push(toAssertion(row))

        const constraints = await query.query<{ candidate_id: string; entity_id: string }>(
          `SELECT candidate_id, entity_id FROM agent_platform.identity_link_constraints
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND candidate_id = ANY($1::uuid[])
            ORDER BY candidate_id, entity_id`,
          [boundedIds],
        )
        for (const row of constraints.rows) rowsByCandidate.get(row.candidate_id)?.cannotLinkEntityIds.add(row.entity_id)
      }

      const after = await readScopeRevision(query)
      if (before !== after) return { readRevision: after, bindings: [], complete: false }
      const bindings = boundedIds.map((candidateId) => {
        const row = rowsByCandidate.get(candidateId)
        return {
          candidateId,
          openAssertions: row?.openAssertions ?? [],
          cannotLinkEntityIds: [...(row?.cannotLinkEntityIds ?? new Set<string>())].sort(),
        }
      })
      return {
        readRevision: before,
        bindings,
        complete: new Set(candidateIds).size <= MAX_BINDING_CANDIDATES,
      }
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
      const revisionNumber = BigInt(head.revision) + 1n
      const revision = String(revisionNumber)

      const changesCluster =
        input.openAssertion !== undefined ||
        (input.closeAssertions?.length ?? 0) > 0 ||
        input.linkConstraint !== undefined
      if (changesCluster && (input.expectedTargetEntityRevision === undefined || draft.targetEntityId === undefined)) {
        throw new IdentityDecisionStoreError(
          'DECISION_STORE_FAILED',
          'a match, split or cannot-link write requires the target entity revision it read',
        )
      }
      if (input.expectedTargetEntityRevision !== undefined) {
        if (draft.targetEntityId === undefined) {
          throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'target entity revision was supplied without a target entity')
        }
        const target = await query.query<{ revision: string }>(
          `SELECT revision::text AS revision FROM agent_platform.identity_entities
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND entity_id = $1
            FOR UPDATE`,
          [draft.targetEntityId],
        )
        const targetHead = target.rows[0]?.revision
        if (targetHead === undefined) {
          throw new IdentityDecisionStoreError('ENTITY_NOT_FOUND', `target entity ${draft.targetEntityId} is not visible`)
        }
        if (targetHead !== input.expectedTargetEntityRevision) {
          throw new IdentityDecisionStoreError(
            'REVISION_CONFLICT',
            `target entity ${draft.targetEntityId} is at revision ${targetHead}, not ${input.expectedTargetEntityRevision}`,
          )
        }
      }

      if (input.entity !== undefined) {
        if (input.expectedTargetEntityRevision !== undefined) {
          if (input.entity.entityId !== draft.targetEntityId) {
            throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'entity update does not match the revision-checked target')
          }
          const updated = await query.query(
            `UPDATE agent_platform.identity_entities
                SET display_name = $1,
                    state = $2,
                    revision = revision + 1,
                    updated_at = $3::timestamptz
              WHERE tenant_id = current_setting('app.tenant_id')::uuid
                AND space_id = current_setting('app.space_id')::uuid
                AND entity_id = $4
                AND revision = $5::bigint`,
            [
              input.entity.displayName ?? null,
              input.entity.state,
              input.entity.updatedAt,
              input.entity.entityId,
              input.expectedTargetEntityRevision,
            ],
          )
          if (updated.rowCount !== 1) {
            throw new IdentityDecisionStoreError('REVISION_CONFLICT', `target entity ${input.entity.entityId} changed before update`)
          }
        } else {
          await query.query(
            `INSERT INTO agent_platform.identity_entities
               (tenant_id, space_id, entity_id, object_id, identity_scope_id, scope_dimensions,
                created_from_candidate_id, display_name, state, revision, recorded_at, updated_at)
             VALUES (
               current_setting('app.tenant_id')::uuid,
               current_setting('app.space_id')::uuid,
               $1, $2, $3, $4::jsonb, $5, $6, $7, 1, $8::timestamptz, $9::timestamptz)`,
            [
              input.entity.entityId,
              input.entity.objectId,
              input.entity.identityScopeId,
              JSON.stringify(input.entity.scopeDimensions),
              input.entity.createdFromCandidateId ?? null,
              input.entity.displayName ?? null,
              input.entity.state,
              input.entity.recordedAt,
              input.entity.updatedAt,
            ],
          )
        }
      } else if (input.expectedTargetEntityRevision !== undefined) {
        const updated = await query.query(
          `UPDATE agent_platform.identity_entities
              SET revision = revision + 1, updated_at = $1::timestamptz
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND entity_id = $2
              AND revision = $3::bigint`,
          [draft.recordedAt, draft.targetEntityId, input.expectedTargetEntityRevision],
        )
        if (updated.rowCount !== 1) {
          throw new IdentityDecisionStoreError('REVISION_CONFLICT', `target entity ${draft.targetEntityId} changed before update`)
        }
      }
      if (input.openAssertion !== undefined) {
        const assertion = input.openAssertion
        if (assertion.entityId !== draft.targetEntityId || assertion.candidateId !== draft.candidateId) {
          throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'opened assertion does not match the reviewed target and candidate')
        }
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
        if (draft.targetEntityId === undefined) {
          throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'closed assertions need a target entity')
        }
        const updated = await query.query(
          `UPDATE agent_platform.identity_assertions
              SET valid_to = $1::timestamptz
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND assertion_id = $2
              AND entity_id = $3
              AND valid_to IS NULL`,
          [close.validTo, close.assertionId, draft.targetEntityId],
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
        if (constraint.entityId !== draft.targetEntityId || constraint.candidateId !== draft.candidateId) {
          throw new IdentityDecisionStoreError('DECISION_STORE_FAILED', 'cannot-link does not match the reviewed target and candidate')
        }
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
          revisionNumber === 1n ? null : head.revision,
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
        [revision, draft.candidateId],
      )
      await query.query(
        `INSERT INTO agent_platform.identity_scope_read_heads (tenant_id, space_id, revision)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, 1)
         ON CONFLICT (tenant_id, space_id) DO UPDATE
           SET revision = agent_platform.identity_scope_read_heads.revision + 1`,
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

  async hasReviewedIdentity(
    scopeRef: ScopeRef,
    entityId: string,
    identity: IdentityStrongIdentity,
    ctx: ToolContext,
  ): Promise<boolean> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ matched: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM agent_platform.identity_assertions AS a
             JOIN agent_platform.identity_decisions AS d
               ON d.tenant_id = a.tenant_id
              AND d.space_id = a.space_id
              AND d.decision_id = a.decision_id
            WHERE a.tenant_id = current_setting('app.tenant_id')::uuid
              AND a.space_id = current_setting('app.space_id')::uuid
              AND a.entity_id = $1
              AND a.valid_to IS NULL
              AND d.kind = 'match'
              AND d.target_entity_id = a.entity_id
              AND d.strong_identity->>'kind' = $2
              AND d.strong_identity->>'value' = $3
              AND d.strong_identity->>'attributeId' IS NOT DISTINCT FROM $4
         ) AS matched`,
        [entityId, identity.kind, identity.value, identity.attributeId ?? null],
      )
      return result.rows[0]?.matched ?? false
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
