import { SemanticPublicationStoreError, isToolContext } from '@ontology/contracts'
import type {
  AppendCandidateReviewInput,
  CandidateReviewDecision,
  CandidateReviewRecord,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementStatus,
  PublicationMaterializationFence,
  PublicationPublishResult,
  PublishSemanticPublicationInput,
  RevisionString,
  ReviseStatementInput,
  ScopeRef,
  SemanticPublicationStore,
  SemanticPublicationVersion,
  StatementRevisionKind,
  StatementRevisionRecord,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'
import { MATERIALIZED_PROJECTION_REF } from './materialization-store'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

/**
 * Test-only fault injection. `beforeCommit` runs inside the publication transaction after
 * every write and before `COMMIT`, so a test can prove the single-transaction boundary: a
 * throw here leaves no publication, statement, rule or outbox row behind.
 */
export interface PublicationFaultInjection {
  readonly beforeCommit?: () => void
}

export interface PostgresSemanticPublicationStoreOptions {
  readonly faultInjection?: PublicationFaultInjection
}

interface ReviewRow extends QueryResultRow {
  review_id: string
  candidate_id: string
  revision: string
  decision: CandidateReviewDecision
  reason: string
  evidence_refs: CandidateReviewRecord['evidenceRefs']
  recorded_at: Date
  actor: string
  supersedes_revision: string | null
}

interface PublicationRow extends QueryResultRow {
  revision: string
  payload: Omit<SemanticPublicationVersion, 'revision'>
}

interface ReplayRow extends PublicationRow {
  request_digest: string
}

interface StatementRow extends QueryResultRow {
  statement_id: string
  proposition_key: string
  kind: 'entity' | 'relation'
  object_id: string | null
  relation_id: string | null
  subject_entity_id: string | null
  predicate: string
  value: Record<string, unknown>
  unit_code: string | null
  valid_from: Date | null
  valid_to: Date | null
  recorded_at: Date
  source_candidate_id: string
  source_refs: PublishedStatement['sourceRefs']
  publication_id: string
  version: string
  status: PublishedStatementStatus
}

interface RuleRow extends QueryResultRow {
  rule_version_id: string
  rule_id: string
  version: string
  object_id: string
  severity: 'hard' | 'soft'
  impact: 'high' | 'low'
  expression: PublishedRuleVersion['expression']
  exceptions: PublishedRuleVersion['exceptions']
  valid_from: Date | null
  valid_to: Date | null
  recorded_at: Date
  source_candidate_id: string
  publication_id: string
}

interface RevisionRow extends QueryResultRow {
  revision_id: string
  statement_id: string
  version: string
  kind: StatementRevisionKind
  reason: string
  corrected_value: Record<string, unknown> | null
  valid_from: Date | null
  valid_to: Date | null
  recorded_at: Date
  actor: string
  supersedes_version: string | null
  invalidation_outbox_id: string
}

const STATEMENT_COLUMNS = `statement_id, proposition_key, kind, object_id, relation_id, subject_entity_id,
  predicate, value, unit_code, valid_from, valid_to, recorded_at, source_candidate_id, source_refs,
  publication_id, version, status`
const RULE_COLUMNS = `rule_version_id, rule_id, version, object_id, severity, impact, expression,
  exceptions, valid_from, valid_to, recorded_at, source_candidate_id, publication_id`
const REVISION_COLUMNS = `revision_id, statement_id, version, kind, reason, corrected_value, valid_from,
  valid_to, recorded_at, actor, supersedes_version, invalidation_outbox_id`
const REVIEW_COLUMNS = `review_id, candidate_id, revision, decision, reason, evidence_refs, recorded_at,
  actor, supersedes_revision`

function toReview(row: ReviewRow): CandidateReviewRecord {
  return {
    reviewId: row.review_id,
    candidateId: row.candidate_id,
    revision: row.revision,
    decision: row.decision,
    reason: row.reason,
    evidenceRefs: row.evidence_refs,
    recordedAt: row.recorded_at.toISOString(),
    actor: row.actor,
    ...(row.supersedes_revision === null ? {} : { supersedesRevision: row.supersedes_revision }),
  }
}

function toStatement(row: StatementRow): PublishedStatement {
  return {
    statementId: row.statement_id,
    propositionKey: row.proposition_key,
    kind: row.kind,
    ...(row.object_id === null ? {} : { objectId: row.object_id }),
    ...(row.relation_id === null ? {} : { relationId: row.relation_id }),
    ...(row.subject_entity_id === null ? {} : { subjectEntityId: row.subject_entity_id }),
    predicate: row.predicate,
    value: row.value,
    ...(row.unit_code === null ? {} : { unitCode: row.unit_code }),
    ...(row.valid_from === null ? {} : { validFrom: row.valid_from.toISOString() }),
    ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    recordedAt: row.recorded_at.toISOString(),
    sourceCandidateId: row.source_candidate_id,
    sourceRefs: row.source_refs,
    publicationId: row.publication_id,
    version: row.version,
    status: row.status,
  }
}

function toRuleVersion(row: RuleRow): PublishedRuleVersion {
  return {
    ruleVersionId: row.rule_version_id,
    ruleId: row.rule_id,
    version: row.version,
    objectId: row.object_id,
    severity: row.severity,
    impact: row.impact,
    expression: row.expression,
    exceptions: row.exceptions,
    ...(row.valid_from === null ? {} : { validFrom: row.valid_from.toISOString() }),
    ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    recordedAt: row.recorded_at.toISOString(),
    sourceCandidateId: row.source_candidate_id,
    publicationId: row.publication_id,
  }
}

function toRevision(row: RevisionRow): StatementRevisionRecord {
  return {
    revisionId: row.revision_id,
    statementId: row.statement_id,
    version: row.version,
    kind: row.kind,
    reason: row.reason,
    ...(row.corrected_value === null ? {} : { correctedValue: row.corrected_value }),
    ...(row.valid_from === null ? {} : { validFrom: row.valid_from.toISOString() }),
    ...(row.valid_to === null ? {} : { validTo: row.valid_to.toISOString() }),
    recordedAt: row.recorded_at.toISOString(),
    actor: row.actor,
    ...(row.supersedes_version === null ? {} : { supersedesVersion: row.supersedes_version }),
    invalidationOutboxId: row.invalidation_outbox_id,
  }
}

/**
 * PostgreSQL-backed semantic publication store (migration 035). It connects as the non-owner
 * application role, so RLS is a real second line of defence behind the explicit
 * (tenant_id, space_id) predicates.
 *
 * `publish` locks the scope publication head with `SELECT ... FOR UPDATE`, re-checks the
 * identity constraints, writes the facts, the rule versions, the publication record and the
 * outbox message, then advances the head — all in one transaction. A replayed idempotency
 * key returns the existing publication without writing again. `reviseStatement` appends a
 * revision, advances the statement head and enqueues its invalidation message atomically.
 */
export class PostgresSemanticPublicationStore implements SemanticPublicationStore {
  readonly #database: ControlPostgresDatabase
  readonly #faultInjection: PublicationFaultInjection | undefined

  constructor(database: ControlPostgresDatabase, options?: PostgresSemanticPublicationStoreOptions) {
    this.#database = database
    this.#faultInjection = options?.faultInjection
  }

  async latestReviewRevision(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<RevisionString> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM agent_platform.candidate_review_heads
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1`,
        [candidateId],
      )
      return result.rows[0]?.revision ?? '0'
    })
  }

  async appendReview(
    scopeRef: ScopeRef,
    input: AppendCandidateReviewInput,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const draft = input.draft
      await query.query(
        `INSERT INTO agent_platform.candidate_review_heads (tenant_id, space_id, candidate_id, revision)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1, 0)
         ON CONFLICT (tenant_id, space_id, candidate_id) DO NOTHING`,
        [draft.candidateId],
      )
      const locked = await query.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM agent_platform.candidate_review_heads
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1
          FOR UPDATE`,
        [draft.candidateId],
      )
      const head = locked.rows[0]
      if (head === undefined) {
        throw new SemanticPublicationStoreError(
          'PUBLICATION_STORE_FAILED',
          `review head for candidate ${draft.candidateId} disappeared during append`,
        )
      }
      if (head.revision !== input.expectedRevision) {
        throw new SemanticPublicationStoreError(
          'REVISION_CONFLICT',
          `candidate ${draft.candidateId} is at review revision ${head.revision}, not ${input.expectedRevision}`,
        )
      }
      const revisionNumber = Number(head.revision) + 1
      const inserted = await query.query<ReviewRow>(
        `INSERT INTO agent_platform.semantic_candidate_reviews
           (tenant_id, space_id, review_id, candidate_id, revision, decision, reason, evidence_refs,
            recorded_at, actor, supersedes_revision)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8, $9)
         RETURNING ${REVIEW_COLUMNS}`,
        [
          draft.reviewId,
          draft.candidateId,
          revisionNumber,
          draft.decision,
          draft.reason,
          JSON.stringify(draft.evidenceRefs),
          draft.recordedAt,
          draft.actor,
          revisionNumber === 1 ? null : head.revision,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        throw new SemanticPublicationStoreError('PUBLICATION_STORE_FAILED', 'the review insert returned no row')
      }
      await query.query(
        `UPDATE agent_platform.candidate_review_heads
            SET revision = $1
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $2`,
        [revisionNumber, draft.candidateId],
      )
      return toReview(row)
    })
  }

  async getReview(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReviewRow>(
        `SELECT ${REVIEW_COLUMNS} FROM agent_platform.semantic_candidate_reviews
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1 AND revision = $2::bigint`,
        [candidateId, revision],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toReview(row)
    })
  }

  async listReviews(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateReviewRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReviewRow>(
        `SELECT ${REVIEW_COLUMNS} FROM agent_platform.semantic_candidate_reviews
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1
          ORDER BY revision`,
        [candidateId],
      )
      return result.rows.map(toReview)
    })
  }

  async latestPublicationRevision(scopeRef: ScopeRef, ctx: ToolContext): Promise<RevisionString> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM agent_platform.semantic_publication_heads
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid`,
      )
      return result.rows[0]?.revision ?? '0'
    })
  }

  async publish(
    scopeRef: ScopeRef,
    input: PublishSemanticPublicationInput,
    ctx: ToolContext,
  ): Promise<PublicationPublishResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.semantic_publication_heads (tenant_id, space_id, revision)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, 0)
         ON CONFLICT (tenant_id, space_id) DO NOTHING`,
      )
      const locked = await query.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM agent_platform.semantic_publication_heads
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
          FOR UPDATE`,
      )
      const head = locked.rows[0]
      if (head === undefined) {
        throw new SemanticPublicationStoreError('PUBLICATION_STORE_FAILED', 'the publication head disappeared')
      }

      const replayed = await query.query<ReplayRow>(
        `SELECT revision::text AS revision, payload, request_digest
           FROM agent_platform.semantic_publications
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND idempotency_key = $1`,
        [input.idempotencyKey],
      )
      const replayRow = replayed.rows[0]
      if (replayRow !== undefined) {
        if (replayRow.request_digest !== input.requestDigest) {
          throw new SemanticPublicationStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different publication payload',
          )
        }
        return {
          publication: { ...replayRow.payload, revision: replayRow.revision },
          created: false,
        }
      }

      if (head.revision !== input.expectedRevision) {
        throw new SemanticPublicationStoreError(
          'REVISION_CONFLICT',
          `the publication head is at revision ${head.revision}, not ${input.expectedRevision}`,
        )
      }

      for (const binding of input.identityBindings) {
        const assertion = await query.query<{ assertion_id: string }>(
          `SELECT assertion_id FROM agent_platform.identity_assertions
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND candidate_id = $1 AND entity_id = $2 AND valid_to IS NULL`,
          [binding.candidateId, binding.entityId],
        )
        if (assertion.rows[0] === undefined) {
          throw new SemanticPublicationStoreError(
            'IDENTITY_CONSTRAINT_BLOCKED',
            `candidate ${binding.candidateId} has no open identity assertion to entity ${binding.entityId}`,
          )
        }
        const constraint = await query.query<{ constraint_id: string }>(
          `SELECT constraint_id FROM agent_platform.identity_link_constraints
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND candidate_id = $1 AND entity_id = $2`,
          [binding.candidateId, binding.entityId],
        )
        if (constraint.rows[0] !== undefined) {
          throw new SemanticPublicationStoreError(
            'IDENTITY_CONSTRAINT_BLOCKED',
            `candidate ${binding.candidateId} is cannot-linked with entity ${binding.entityId}`,
          )
        }
      }

      const revisionNumber = Number(head.revision) + 1
      const ruleVersions: PublishedRuleVersion[] = []
      for (const rule of input.publication.ruleVersions) {
        const maxVersion = await query.query<{ version: string }>(
          `SELECT COALESCE(MAX(version), 0)::text AS version FROM agent_platform.published_rule_versions
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND rule_id = $1`,
          [rule.ruleId],
        )
        const version = Number(maxVersion.rows[0]?.version ?? '0') + 1
        ruleVersions.push({ ...rule, version: String(version) })
      }
      const payload: Omit<SemanticPublicationVersion, 'revision'> = {
        ...input.publication,
        ruleVersions,
      }
      const publication: SemanticPublicationVersion = {
        ...payload,
        revision: String(revisionNumber),
      }

      await query.query(
        `INSERT INTO agent_platform.semantic_publications
           (tenant_id, space_id, publication_id, idempotency_key, request_digest, revision, version,
            version_digest, schema_ref, approved_candidate_refs, statement_ids, rule_version_ids,
            payload, outbox_id, published_at, actor)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12,
           $13::timestamptz, $14)`,
        [
          publication.publicationId,
          input.idempotencyKey,
          input.requestDigest,
          revisionNumber,
          publication.versionRef.version,
          publication.versionRef.digest,
          JSON.stringify(publication.schemaRef),
          JSON.stringify(publication.approvedCandidateRefs),
          JSON.stringify(publication.statements.map((statement) => statement.statementId)),
          JSON.stringify(publication.ruleVersions.map((rule) => rule.ruleVersionId)),
          JSON.stringify(payload),
          publication.outboxId,
          publication.publishedAt,
          publication.actor,
        ],
      )

      for (const statement of publication.statements) {
        await query.query(
          `INSERT INTO agent_platform.published_statements
             (tenant_id, space_id, statement_id, proposition_key, kind, object_id, relation_id,
              subject_entity_id, predicate, value, unit_code, valid_from, valid_to, recorded_at,
              source_candidate_id, source_job_id, source_refs, publication_id, version, status)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz,
             $12::timestamptz, $13, $14, $15::jsonb, $16, 1, 'active')
           ON CONFLICT (tenant_id, space_id, statement_id) DO NOTHING`,
          [
            statement.statementId,
            statement.propositionKey,
            statement.kind,
            statement.objectId ?? null,
            statement.relationId ?? null,
            statement.subjectEntityId ?? null,
            statement.predicate,
            JSON.stringify(statement.value),
            statement.unitCode ?? null,
            statement.validFrom ?? null,
            statement.validTo ?? null,
            statement.recordedAt,
            statement.sourceCandidateId,
            input.outboxJobId,
            JSON.stringify(statement.sourceRefs),
            statement.publicationId,
          ],
        )
      }

      for (const rule of publication.ruleVersions) {
        await query.query(
          `INSERT INTO agent_platform.published_rule_versions
             (tenant_id, space_id, rule_version_id, rule_id, version, object_id, severity, impact,
              expression, exceptions, valid_from, valid_to, recorded_at, source_candidate_id,
              publication_id)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3::bigint, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz, $10::timestamptz,
             $11::timestamptz, $12, $13)`,
          [
            rule.ruleVersionId,
            rule.ruleId,
            rule.version,
            rule.objectId,
            rule.severity,
            rule.impact,
            JSON.stringify(rule.expression),
            JSON.stringify(rule.exceptions),
            rule.validFrom ?? null,
            rule.validTo ?? null,
            rule.recordedAt,
            rule.sourceCandidateId,
            rule.publicationId,
          ],
        )
      }

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
          input.outbox.outboxId,
          input.outboxJobId,
          input.outbox.topic,
          JSON.stringify(input.outbox.payload),
          input.outbox.idempotencyKey,
          input.outbox.availableAt,
        ],
      )

      await query.query(
        `UPDATE agent_platform.semantic_publication_heads
            SET revision = $1
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid`,
        [revisionNumber],
      )

      await this.#openMaterializationFences(query, input.materializationFences ?? [])

      this.#faultInjection?.beforeCommit?.()
      return { publication, created: true }
    })
  }

  async getPublication(
    scopeRef: ScopeRef,
    publicationId: Uuid,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<PublicationRow>(
        `SELECT revision::text AS revision, payload FROM agent_platform.semantic_publications
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND publication_id = $1`,
        [publicationId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : { ...row.payload, revision: row.revision }
    })
  }

  async listPublications(
    scopeRef: ScopeRef,
    limit: number,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<PublicationRow>(
        `SELECT revision::text AS revision, payload FROM agent_platform.semantic_publications
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
          ORDER BY revision
          LIMIT $1`,
        [limit],
      )
      return result.rows.map((row) => ({ ...row.payload, revision: row.revision }))
    })
  }

  async getStatement(
    scopeRef: ScopeRef,
    statementId: Uuid,
    ctx: ToolContext,
  ): Promise<PublishedStatement | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<StatementRow>(
        `SELECT ${STATEMENT_COLUMNS} FROM agent_platform.published_statements
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND statement_id = $1`,
        [statementId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toStatement(row)
    })
  }

  async listStatements(
    scopeRef: ScopeRef,
    filter: PublishedStatementFilterInput,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const clauses = [
        `tenant_id = current_setting('app.tenant_id')::uuid`,
        `space_id = current_setting('app.space_id')::uuid`,
      ]
      const values: unknown[] = []
      if (filter.propositionKey !== undefined) {
        values.push(filter.propositionKey)
        clauses.push(`proposition_key = $${String(values.length)}`)
      }
      if (filter.objectId !== undefined) {
        values.push(filter.objectId)
        clauses.push(`object_id = $${String(values.length)}`)
      }
      if (filter.sourceCandidateId !== undefined) {
        values.push(filter.sourceCandidateId)
        clauses.push(`source_candidate_id = $${String(values.length)}`)
      }
      if (filter.publicationId !== undefined) {
        values.push(filter.publicationId)
        clauses.push(`publication_id = $${String(values.length)}`)
      }
      if (filter.status !== undefined) {
        values.push(filter.status)
        clauses.push(`status = $${String(values.length)}`)
      }
      values.push(filter.limit ?? 1_000)
      const result = await query.query<StatementRow>(
        `SELECT ${STATEMENT_COLUMNS} FROM agent_platform.published_statements
          WHERE ${clauses.join(' AND ')}
          ORDER BY statement_id
          LIMIT $${String(values.length)}`,
        values,
      )
      return result.rows.map(toStatement)
    })
  }

  async listRuleVersions(
    scopeRef: ScopeRef,
    filter: PublishedRuleFilterInput,
    ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]> {
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
      if (filter.sourceCandidateId !== undefined) {
        values.push(filter.sourceCandidateId)
        clauses.push(`source_candidate_id = $${String(values.length)}`)
      }
      if (filter.publicationId !== undefined) {
        values.push(filter.publicationId)
        clauses.push(`publication_id = $${String(values.length)}`)
      }
      values.push(filter.limit ?? 1_000)
      const result = await query.query<RuleRow>(
        `SELECT ${RULE_COLUMNS} FROM agent_platform.published_rule_versions
          WHERE ${clauses.join(' AND ')}
          ORDER BY rule_id, version
          LIMIT $${String(values.length)}`,
        values,
      )
      return result.rows.map(toRuleVersion)
    })
  }

  async reviseStatement(
    scopeRef: ScopeRef,
    input: ReviseStatementInput,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<{
        statement_id: string
        version: string
        status: PublishedStatementStatus
        source_job_id: string
      }>(
        `SELECT statement_id, version::text AS version, status, source_job_id
           FROM agent_platform.published_statements
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND statement_id = $1
          FOR UPDATE`,
        [input.statementId],
      )
      const statement = locked.rows[0]
      if (statement === undefined) {
        throw new SemanticPublicationStoreError(
          'STATEMENT_NOT_FOUND',
          `statement ${input.statementId} is not visible in this scope`,
        )
      }
      if (statement.version !== input.expectedRevision) {
        throw new SemanticPublicationStoreError(
          'REVISION_CONFLICT',
          `statement ${input.statementId} is at version ${statement.version}, not ${input.expectedRevision}`,
        )
      }
      const versionNumber = Number(statement.version) + 1
      const inserted = await query.query<RevisionRow>(
        `INSERT INTO agent_platform.statement_revisions
           (tenant_id, space_id, revision_id, statement_id, version, kind, reason, corrected_value,
            valid_from, valid_to, recorded_at, actor, supersedes_version, invalidation_outbox_id)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3::bigint, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz,
           $9::timestamptz, $10, $11::bigint, $12)
         RETURNING ${REVISION_COLUMNS}`,
        [
          input.revisionId,
          input.statementId,
          versionNumber,
          input.kind,
          input.reason,
          input.correctedValue === undefined ? null : JSON.stringify(input.correctedValue),
          input.validFrom ?? null,
          input.validTo ?? null,
          input.recordedAt,
          input.actor,
          Number(statement.version),
          input.outbox.outboxId,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        throw new SemanticPublicationStoreError('PUBLICATION_STORE_FAILED', 'the revision insert returned no row')
      }
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
          input.outbox.outboxId,
          statement.source_job_id,
          input.outbox.topic,
          JSON.stringify(input.outbox.payload),
          input.outbox.idempotencyKey,
          input.outbox.availableAt,
        ],
      )
      await query.query(
        `UPDATE agent_platform.published_statements
            SET version = $1::bigint,
                status = $2,
                value = COALESCE($3::jsonb, value),
                valid_from = COALESCE($4::timestamptz, valid_from),
                valid_to = COALESCE($5::timestamptz, valid_to),
                supersedes_version = $6::bigint
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND statement_id = $7`,
        [
          versionNumber,
          input.kind === 'retraction' ? 'retracted' : 'active',
          input.correctedValue === undefined ? null : JSON.stringify(input.correctedValue),
          input.validFrom ?? null,
          input.validTo ?? null,
          Number(statement.version),
          input.statementId,
        ],
      )
      await this.#openMaterializationFences(query, input.materializationFences ?? [])
      return toRevision(row)
    })
  }

  /**
   * Open the invalidation fences in the same transaction as the publication/revision and its
   * outbox event, so the window between the commit and the worker's asynchronous advance can
   * never serve a stale conclusion (SPEC D5.1, ADR-13, LOCAL-070). The fence generation is read
   * without a lock: it is descriptive only, and `commitProjection` closes a fence by id.
   */
  async #openMaterializationFences(
    query: ScopedQuery,
    fences: readonly PublicationMaterializationFence[],
  ): Promise<void> {
    if (fences.length === 0) return
    const state = await query.query<{ generation: string }>(
      `SELECT generation::text AS generation FROM agent_platform.projection_state
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND projection_ref = $1`,
      [MATERIALIZED_PROJECTION_REF],
    )
    const generation = state.rows[0]?.generation ?? '0'
    for (const fence of fences) {
      await query.query(
        `INSERT INTO agent_platform.materialization_fences
           (tenant_id, space_id, projection_ref, fence_id, generation, reason, proposition_keys,
            state, opened_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3::bigint, $4, $5::jsonb, 'open', $6::timestamptz)`,
        [
          MATERIALIZED_PROJECTION_REF,
          fence.fenceId,
          generation,
          fence.reason,
          JSON.stringify(fence.propositionKeys),
          fence.openedAt,
        ],
      )
    }
  }

  async getStatementRevision(
    scopeRef: ScopeRef,
    statementId: Uuid,
    version: RevisionString,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM agent_platform.statement_revisions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND statement_id = $1 AND version = $2::bigint`,
        [statementId, version],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toRevision(row)
    })
  }

  async listStatementRevisions(
    scopeRef: ScopeRef,
    statementId: Uuid,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM agent_platform.statement_revisions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND statement_id = $1
          ORDER BY version`,
        [statementId],
      )
      return result.rows.map(toRevision)
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new SemanticPublicationStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new SemanticPublicationStoreError(
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

type PublishedStatementFilterInput = Parameters<SemanticPublicationStore['listStatements']>[1]
type PublishedRuleFilterInput = Parameters<SemanticPublicationStore['listRuleVersions']>[1]
