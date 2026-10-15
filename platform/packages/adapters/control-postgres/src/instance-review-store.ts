import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { IdentityDecisionStoreError, InstanceReviewError, isToolContext } from '@ontology/contracts'
import type {
  AppendInstanceConfirmationInput,
  AppendInstanceRecordInput,
  InstanceConfirmationEvent,
  InstanceFieldStatus,
  InstanceFieldValue,
  InstanceIdentityAdjudication,
  InstanceIdentityCandidate,
  InstanceIdentityBinding,
  InstanceIdentityConfidence,
  InstanceIdentityState,
  InstanceRecordView,
  InstanceRelationEndpoint,
  InstanceReviewListFilter,
  InstanceReviewStore,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { assertIdentityProjectFence, assertPublishedInstanceBinding } from './identity-project-fence'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface RecordRow extends QueryResultRow {
  project_id: string
  record_id: string
  revision: string
  object_type_ref: string
  identity_state: InstanceIdentityState
  identity_confidence: InstanceIdentityConfidence
  same_name_different_meaning: boolean
  matched_entity_id: string | null
  publication_state: InstanceRecordView['publicationState']
  published_revision: string | null
  body: {
    identity: {
      binding?: InstanceIdentityBinding
      candidates: InstanceIdentityCandidate[]
      cannotLinkEntityIds: string[]
      adjudications: InstanceIdentityAdjudication[]
    }
    fields: InstanceFieldValue[]
    relations: InstanceRelationEndpoint[]
    sourceRef: ResourceRef
  }
  idempotency_key: string
  actor: string
  recorded_at: Date
}

interface ConfirmationRow extends QueryResultRow {
  project_id: string
  record_id: string
  field_id: string
  revision: string
  record_revision: string
  status: InstanceFieldStatus
  reason: string | null
  source_ref: ResourceRef
  content_digest: string
  idempotency_key: string
  actor: string
  recorded_at: Date
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

const RECORD_COLUMNS = `project_id, record_id, revision, object_type_ref, identity_state,
  identity_confidence, same_name_different_meaning, matched_entity_id, publication_state,
  published_revision, body, idempotency_key, actor, recorded_at`

const CONFIRMATION_COLUMNS = `project_id, record_id, field_id, revision, record_revision, status,
  reason, source_ref, content_digest, idempotency_key, actor, recorded_at`

function toRecord(row: RecordRow): InstanceRecordView {
  const body = row.body
  return {
    projectId: row.project_id,
    recordId: row.record_id,
    recordRevision: String(row.revision),
    objectTypeRef: row.object_type_ref,
    identity: {
      ...(body.identity.binding === undefined ? {} : { binding: body.identity.binding }),
      state: row.identity_state,
      confidence: row.identity_confidence,
      candidates: body.identity.candidates,
      ...(row.matched_entity_id === null ? {} : { matchedEntityId: row.matched_entity_id }),
      sameNameDifferentMeaning: row.same_name_different_meaning,
      cannotLinkEntityIds: body.identity.cannotLinkEntityIds,
      adjudications: body.identity.adjudications,
      decisionRevision: body.identity.adjudications.length === 0 ? '0' : String(body.identity.adjudications.length),
    },
    fields: body.fields,
    relations: body.relations,
    publicationState: row.publication_state,
    ...(row.published_revision === null ? {} : { publishedRevision: String(row.published_revision) }),
    sourceRef: body.sourceRef,
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function toConfirmation(row: ConfirmationRow): InstanceConfirmationEvent {
  return {
    projectId: row.project_id,
    recordId: row.record_id,
    fieldId: row.field_id,
    recordRevision: String(row.record_revision),
    confirmationRevision: String(row.revision),
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
  }
}

/**
 * Real PostgreSQL implementation of the instance review store (SPEC v0.3a §3.3/§4.1).
 *
 * Every statement runs inside one transaction whose trusted scope is set with `SET LOCAL`
 * semantics, so RLS applies as a second layer behind the explicit scope predicate. A record
 * append locks the project row `FOR UPDATE`, checks the expected head and only then inserts a
 * new immutable revision; a stale head or a lost race is VERSION_CONFLICT. Confirmations are
 * append-only and their revision is assigned per `(record, field)`.
 */
export class PostgresInstanceReviewStore implements InstanceReviewStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: InstanceReviewListFilter,
    ctx: ToolContext,
  ): Promise<InstanceRecordView[]> {
    const limit = normalizeLimit(filter.limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RecordRow>(
        `SELECT ${RECORD_COLUMNS} FROM (
           SELECT DISTINCT ON (record_id) *
             FROM agent_platform.instance_review_records
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND project_id = $1::uuid
              AND ($2::text IS NULL OR publication_state = $2)
            ORDER BY record_id, revision DESC
         ) latest
         ORDER BY record_id
         LIMIT $3`,
        [projectId, filter.publicationState ?? null, limit],
      )
      const records = result.rows.map(toRecord)
      return filter.status === undefined
        ? records
        : records.filter((record) => record.fields.some((field) => field.status === filter.status))
    })
  }

  async getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceRecordView | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#latestRecord(query, projectId, recordId)
      return row === undefined ? undefined : toRecord(row)
    })
  }

  async appendRecordRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendInstanceRecordInput,
    ctx: ToolContext,
  ): Promise<InstanceRecordView> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await this.#lockProject(query, projectId)
      if (!locked) {
        throw new InstanceReviewError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`)
      }
      if (input.identityBinding !== undefined) {
        const binding = input.identityBinding
        const parseId = input.fields[0]?.source.parseId
        if (binding.projectRevisionRef.projectId !== projectId || parseId === undefined) throw new InstanceReviewError('IDENTITY_CONFLICT', 'instance identity binding has no matching project/source')
        try {
          await assertIdentityProjectFence(query, { projectRevisionRef: binding.projectRevisionRef, definitionRef: binding.definitionRef, documentId: binding.documentId, parseId, membershipRevision: binding.membershipRevision, visibilityEpoch: binding.visibilityEpoch })
        } catch (error) {
          if (error instanceof IdentityDecisionStoreError && error.code === 'PROJECT_FENCE_STALE') throw new InstanceReviewError('IDENTITY_CONFLICT', 'instance project/source pins changed before revision commit', { cause: error })
          throw error
        }
      }
      if (input.publicationState === 'approved' || input.publicationState === 'published') await assertPublishedInstanceBinding(query, projectId, input)
      const replay = await this.#recordByIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.project_id !== projectId || replay.record_id !== input.recordId || digestOf(replay.body.identity.binding ?? null) !== digestOf(input.identityBinding ?? null)) {
          throw new InstanceReviewError('IDEMPOTENCY_CONFLICT', 'record key was used for another project/candidate binding')
        }
        return toRecord(replay)
      }
      const current = await this.#latestRecord(query, projectId, input.recordId)
      const currentRevision = current === undefined ? '0' : String(current.revision)
      if (currentRevision !== input.expectedRevision) {
        throw new InstanceReviewError(
          'VERSION_CONFLICT',
          `record head is ${currentRevision}, not the expected ${input.expectedRevision}`,
        )
      }
      const revision = (BigInt(currentRevision) + 1n).toString()
      const body = {
        identity: {
          ...(input.identityBinding === undefined ? {} : { binding: input.identityBinding }),
          candidates: input.identityCandidates,
          cannotLinkEntityIds: input.cannotLinkEntityIds,
          adjudications: input.adjudications,
        },
        fields: input.fields,
        relations: input.relations,
        sourceRef: input.sourceRef,
      }
      try {
        const inserted = await query.query<RecordRow>(
          `INSERT INTO agent_platform.instance_review_records
             (tenant_id, space_id, project_id, record_id, revision, object_type_ref, identity_state,
              identity_confidence, same_name_different_meaning, matched_entity_id, publication_state,
              published_revision, body, content_digest, idempotency_key, actor, trace_id, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7, $8, $9, $10::bigint, $11::jsonb, $12, $13, $14,
             current_setting('app.trace_id', true), $15::timestamptz)
           RETURNING ${RECORD_COLUMNS}`,
          [
            projectId,
            input.recordId,
            revision,
            input.objectTypeRef,
            input.identityState,
            input.identityConfidence,
            input.sameNameDifferentMeaning,
            input.matchedEntityId ?? null,
            input.publicationState,
            input.publishedRevision ?? null,
            JSON.stringify(body),
            digestOf(body),
            input.idempotencyKey,
            input.actor,
            input.recordedAt,
          ],
        )
        const row = inserted.rows[0]
        if (row === undefined) {
          throw new InstanceReviewError('STORE_FAILED', 'the record revision was not written')
        }
        return toRecord(row)
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          const concurrent = await this.#recordByIdempotencyKey(query, input.idempotencyKey)
          if (concurrent !== undefined && concurrent.project_id === projectId && concurrent.record_id === input.recordId && digestOf(concurrent.body.identity.binding ?? null) === digestOf(input.identityBinding ?? null)) return toRecord(concurrent)
          throw new InstanceReviewError('VERSION_CONFLICT', 'a concurrent write won the record revision', {
            cause: error,
          })
        }
        if (pgCodeOf(error) === '23503') {
          throw new InstanceReviewError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`, {
            cause: error,
          })
        }
        throw error
      }
    })
  }

  async appendConfirmation(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendInstanceConfirmationInput,
    ctx: ToolContext,
  ): Promise<InstanceConfirmationEvent> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await this.#lockProject(query, projectId)
      if (!locked) {
        throw new InstanceReviewError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`)
      }
      const replay = await this.#confirmationByIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        return toConfirmation(replay)
      }
      const max = await query.query<{ revision: string }>(
        `SELECT COALESCE(MAX(revision), 0)::text AS revision
           FROM agent_platform.instance_review_confirmations
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND project_id = $1::uuid AND record_id = $2::uuid AND field_id = $3`,
        [projectId, input.recordId, input.fieldId],
      )
      const revision = (BigInt(max.rows[0]?.revision ?? '0') + 1n).toString()
      const payload = {
        recordRevision: input.recordRevision,
        status: input.status,
        reason: input.reason ?? null,
        sourceRef: input.sourceRef,
      }
      const inserted = await query.query<ConfirmationRow>(
        `INSERT INTO agent_platform.instance_review_confirmations
           (tenant_id, space_id, project_id, record_id, field_id, revision, record_revision, status,
            reason, source_ref, content_digest, idempotency_key, actor, trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3, $4::bigint, $5::bigint, $6, $7, $8::jsonb, $9, $10, $11,
           current_setting('app.trace_id', true), $12::timestamptz)
         RETURNING ${CONFIRMATION_COLUMNS}`,
        [
          projectId,
          input.recordId,
          input.fieldId,
          revision,
          input.recordRevision,
          input.status,
          input.reason ?? null,
          JSON.stringify(input.sourceRef),
          digestOf(payload),
          input.idempotencyKey,
          input.actor,
          input.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        throw new InstanceReviewError('STORE_FAILED', 'the confirmation event was not written')
      }
      return toConfirmation(row)
    })
  }

  async listConfirmations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceConfirmationEvent[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ConfirmationRow>(
        `SELECT ${CONFIRMATION_COLUMNS} FROM agent_platform.instance_review_confirmations
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND project_id = $1::uuid AND record_id = $2::uuid
          ORDER BY field_id, revision ASC`,
        [projectId, recordId],
      )
      return result.rows.map(toConfirmation)
    })
  }

  // Serialize instance writers while allowing document-membership FK key-share locks.
  async #lockProject(query: ScopedQuery, projectId: Uuid): Promise<boolean> {
    const row = await query.query<{ project_id: string }>(
      `SELECT project_id FROM agent_platform.projects
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND project_id = $1::uuid
        FOR NO KEY UPDATE`,
      [projectId],
    )
    return row.rows[0] !== undefined
  }

  async #latestRecord(query: ScopedQuery, projectId: Uuid, recordId: Uuid): Promise<RecordRow | undefined> {
    const result = await query.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM agent_platform.instance_review_records
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND project_id = $1::uuid AND record_id = $2::uuid
        ORDER BY revision DESC
        LIMIT 1`,
      [projectId, recordId],
    )
    return result.rows[0]
  }

  async #recordByIdempotencyKey(query: ScopedQuery, key: string): Promise<RecordRow | undefined> {
    const result = await query.query<RecordRow>(
      `SELECT ${RECORD_COLUMNS} FROM agent_platform.instance_review_records
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #confirmationByIdempotencyKey(query: ScopedQuery, key: string): Promise<ConfirmationRow | undefined> {
    const result = await query.query<ConfirmationRow>(
      `SELECT ${CONFIRMATION_COLUMNS} FROM agent_platform.instance_review_confirmations
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
      throw new InstanceReviewError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new InstanceReviewError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new InstanceReviewError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
    throw new InstanceReviewError('INVALID_ARGUMENT', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}
