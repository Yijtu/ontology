import type { QueryResultRow } from 'pg'
import {
  ProjectStoreError,
  assertProjectRevisionShape,
  isRecord,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isToolContext,
  isUuid,
  assertProjectEvolutionPlan,
} from '@ontology/contracts'
import type {
  AppendFieldConfirmationInput,
  AppendProjectRevisionInput,
  CreateProjectInput,
  FieldConfirmationEventRecord,
  FieldConfirmationStatus,
  NewOutboxMessage,
  ProjectListFilter,
  ProjectRecord,
  ProjectRevision,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ProjectState,
  ProjectStore,
  ProjectWriteResult,
  ResourceRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'
import { assertEvolutionSourcePins } from './project-evolution-store'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface ProjectRow extends QueryResultRow {
  project_id: string
  title: string
  head_revision: string
  active_revision: string
  staging_writable: boolean
  state: ProjectState
  create_request_digest: string
  created_by: string
  created_at: Date
  updated_at: Date
}

interface RevisionRow extends QueryResultRow {
  revision: string
  digest: string
  body: ProjectRevisionBody
  request_digest: string
}

interface ConfirmationRow extends QueryResultRow {
  project_id: string
  record_id: string
  field_id: string
  revision: string
  record_revision: string
  content_digest: string
  status: FieldConfirmationStatus
  actor: string
  source_ref: ResourceRef
  reason: string | null
  event_payload: Readonly<Record<string, unknown>>
  request_digest: string
  recorded_at: Date
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

const PROJECT_COLUMNS = `project_id, title, head_revision, active_revision, staging_writable, state, create_request_digest, created_by,
  created_at, updated_at`

function toProject(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id,
    title: row.title,
    headRevision: row.head_revision,
    activeRevision: row.active_revision,
    stagingWritable: row.staging_writable,
    state: row.state,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function revisionBodyOf(revision: ProjectRevision): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: revision.ref.projectId,
    revision: revision.ref.revision,
    ...(revision.executionPurpose === undefined ? {} : { executionPurpose: revision.executionPurpose }),
    industryPackRef: revision.industryPackRef,
    definitionRef: revision.definitionRef,
    mappingRefs: revision.mappingRefs,
    profileRef: revision.profileRef,
    documentSetRef: revision.documentSetRef,
    ...(revision.approvedInputRef === undefined ? {} : { approvedInputRef: revision.approvedInputRef }),
    ...(revision.datasetSnapshotRef === undefined ? {} : { datasetSnapshotRef: revision.datasetSnapshotRef }),
    ...(revision.documentIndexRef === undefined ? {} : { documentIndexRef: revision.documentIndexRef }),
    semanticPublicationRefs: revision.semanticPublicationRefs,
    sourceVisibilityEpoch: revision.sourceVisibilityEpoch,
    changeReason: revision.changeReason,
  }
}

function toRevision(row: RevisionRow): ProjectRevision {
  const body = row.body
  const ref: ProjectRevisionRef = {
    projectId: body.projectId,
    revision: String(row.revision),
    digest: row.digest,
  }
  return {
    ref,
    ...(body.executionPurpose === undefined ? {} : { executionPurpose: body.executionPurpose }),
    industryPackRef: body.industryPackRef,
    definitionRef: body.definitionRef,
    mappingRefs: body.mappingRefs,
    profileRef: body.profileRef,
    documentSetRef: body.documentSetRef,
    ...(body.approvedInputRef === undefined ? {} : { approvedInputRef: body.approvedInputRef }),
    ...(body.datasetSnapshotRef === undefined ? {} : { datasetSnapshotRef: body.datasetSnapshotRef }),
    ...(body.documentIndexRef === undefined ? {} : { documentIndexRef: body.documentIndexRef }),
    semanticPublicationRefs: body.semanticPublicationRefs,
    sourceVisibilityEpoch: body.sourceVisibilityEpoch,
    changeReason: body.changeReason,
  }
}

function toConfirmation(row: ConfirmationRow): FieldConfirmationEventRecord {
  return {
    projectId: row.project_id,
    recordId: row.record_id,
    recordRevision: row.record_revision,
    fieldId: row.field_id,
    confirmationRevision: row.revision,
    contentDigest: row.content_digest,
    status: row.status,
    actor: row.actor,
    sourceRef: row.source_ref,
    ...(row.reason === null ? {} : { reason: row.reason }),
    eventPayload: row.event_payload,
    recordedAt: row.recorded_at.toISOString(),
  }
}

/**
 * Real PostgreSQL implementation of the project store (SPEC v0.3a §3.2/§3.3/§4.1).
 *
 * Every statement runs inside one transaction whose trusted scope is set with
 * `SET LOCAL` semantics, so RLS applies as a second layer behind the explicit
 * scope predicate. `appendRevision` locks the project head `FOR UPDATE`, checks
 * the expected revision and only then appends the immutable revision, advances
 * the head and writes the transactional outbox message; a stale expected
 * revision is a VERSION_CONFLICT. Field confirmations are append-only events
 * whose revision the store assigns per `(record, field)`; a correction never
 * rewrites the earlier decision.
 */
export class PostgresProjectStore implements ProjectStore {
  readonly #database: ControlPostgresDatabase
  readonly #excludeSyntheticValidationProjects: boolean

  constructor(database: ControlPostgresDatabase, options: { readonly excludeSyntheticValidationProjects?: boolean } = {}) {
    this.#database = database
    this.#excludeSyntheticValidationProjects = options.excludeSyntheticValidationProjects === true
  }

  async createProject(
    input: CreateProjectInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProjectWriteResult> {
    assertProjectRevisionShape(input.firstRevision)
    const revision = input.firstRevision
    if (revision.ref.projectId !== input.projectId || revision.ref.revision !== '1') {
      throw new ProjectStoreError('INVALID_REVISION', 'a new project must start with its own revision 1')
    }
    const state = input.state ?? 'draft'

    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#projectByCreateKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.create_request_digest !== input.requestDigest) {
          throw new ProjectStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        const stored = await this.#revisionAt(query, replay.project_id, '1')
        if (stored === undefined) {
          throw new ProjectStoreError('REVISION_NOT_FOUND', 'the project has no first revision')
        }
        return { project: toProject(replay), revision: toRevision(stored), created: false }
      }

      const inserted = await query
        .query<{ project_id: string }>(
          `INSERT INTO agent_platform.projects
             (tenant_id, space_id, project_id, title, head_revision, state,
              create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1::uuid, $2, 1, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)
           ON CONFLICT (tenant_id, space_id, create_idempotency_key) DO NOTHING
           RETURNING project_id`,
          [
            input.projectId,
            input.title,
            state,
            input.idempotencyKey,
            input.requestDigest,
            input.actor,
            input.recordedAt,
          ],
        )
        .catch((error: unknown) => {
          if (pgCodeOf(error) === '23505') return { rows: [], rowCount: 0 }
          throw error
        })

      if (inserted.rows[0] === undefined) {
        const concurrent = await this.#projectByCreateKey(query, input.idempotencyKey)
        if (concurrent === undefined) {
          throw new ProjectStoreError('IDEMPOTENCY_CONFLICT', 'the project id already exists in this scope')
        }
        if (concurrent.create_request_digest !== input.requestDigest) {
          throw new ProjectStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        const stored = await this.#revisionAt(query, concurrent.project_id, '1')
        if (stored === undefined) {
          throw new ProjectStoreError('REVISION_NOT_FOUND', 'the project has no first revision')
        }
        return { project: toProject(concurrent), revision: toRevision(stored), created: false }
      }

      await this.#insertRevision(query, input.outboxJobId, revision, input.idempotencyKey, input.requestDigest, input.actor, input.recordedAt)
      await this.#insertOutbox(query, input.outboxJobId, input.outbox)

      return {
        project: {
          projectId: input.projectId,
          title: input.title,
          headRevision: '1',
          activeRevision: '1',
          stagingWritable: true,
          state,
          createdBy: input.actor,
          createdAt: input.recordedAt,
          updatedAt: input.recordedAt,
        },
        revision,
        created: true,
      }
    })
  }

  async getProject(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#projectById(query, projectId)
      return row === undefined ? undefined : toProject(row)
    })
  }

  async listProjects(
    scopeRef: ScopeRef,
    filter: ProjectListFilter,
    ctx: ToolContext,
  ): Promise<ProjectRecord[]> {
    const limit = normalizeLimit(filter.limit)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM agent_platform.projects
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND ($1::text IS NULL OR state = $1)
             ${this.#excludeSyntheticValidationProjects ? `AND NOT EXISTS (SELECT 1 FROM agent_platform.project_revisions AS purpose_revision
               WHERE purpose_revision.tenant_id=projects.tenant_id AND purpose_revision.space_id=projects.space_id
                 AND purpose_revision.project_id=projects.project_id AND purpose_revision.revision=projects.head_revision
                 AND purpose_revision.body->>'executionPurpose'='synthetic_validation')` : ''}
           ORDER BY updated_at, project_id
           LIMIT $2`,
        [filter.state ?? null, limit],
      )
      return result.rows.map(toProject)
    })
  }

  async getRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectRevision | undefined> {
    if (!isRevisionString(revision)) {
      throw new ProjectStoreError('REVISION_INVALID', 'revision must be a decimal string')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#revisionAt(query, projectId, revision)
      return row === undefined ? undefined : toRevision(row)
    })
  }

  async listRevisions(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRevision[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<RevisionRow>(
        `SELECT revision, digest, body, request_digest FROM agent_platform.project_revisions
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid
           ORDER BY revision ASC`,
        [projectId],
      )
      return result.rows.map(toRevision)
    })
  }

  async appendRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendProjectRevisionInput,
    ctx: ToolContext,
  ): Promise<ProjectWriteResult> {
    assertProjectRevisionShape(input.revision)
    const revision = input.revision
    if (revision.ref.projectId !== projectId) {
      throw new ProjectStoreError('INVALID_REVISION', 'the appended revision must belong to the appended project')
    }

    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM agent_platform.projects
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid
           FOR UPDATE`,
        [projectId],
      )
      const projectRow = locked.rows[0]
      if (projectRow === undefined) {
        throw new ProjectStoreError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in the requested scope`)
      }

      const replay = await this.#revisionByIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== input.requestDigest) {
          throw new ProjectStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        return { project: toProject(projectRow), revision: toRevision(replay), created: false }
      }

      const head = projectRow.head_revision
      if (head !== input.expectedRevision) {
        throw new ProjectStoreError(
          'VERSION_CONFLICT',
          `project head is ${head}, not the expected ${input.expectedRevision}`,
        )
      }
      const nextRevision = (BigInt(head) + 1n).toString()
      if (revision.ref.revision !== nextRevision) {
        throw new ProjectStoreError('INVALID_REVISION', `the appended revision must be ${nextRevision}`)
      }
      const live = await query.query<{ evolution_id: string }>(`SELECT evolution_id FROM agent_platform.project_evolutions
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid
          AND project_id=$1::uuid AND state IN ('queued','running','awaiting_review','needs_human','failed') LIMIT 1`, [projectId])
      if (live.rows.length > 0 || (input.evolution === undefined && projectRow.active_revision !== head)) throw new ProjectStoreError('VERSION_CONFLICT', 'complete or cancel the explicit evolution before changing this project')
      const previous = await this.#revisionAt(query,projectId,head)
      if (previous === undefined || previous.body.executionPurpose !== revision.executionPurpose) throw new ProjectStoreError('INVALID_REVISION', 'a project execution purpose is immutable across all revisions')
      if(input.evolution===undefined && (previous?.body.definitionRef.id!==revision.definitionRef.id || previous.body.definitionRef.version!==revision.definitionRef.version || previous.body.definitionRef.digest!==revision.definitionRef.digest)) {
        const populated=await query.query(`SELECT 1 FROM agent_platform.project_record_versions WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND project_id=$1::uuid
          UNION ALL SELECT 1 FROM agent_platform.published_rule_versions WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND project_id=$1::uuid LIMIT 1`,[projectId])
        if(populated.rows.length>0) throw new ProjectStoreError('VERSION_CONFLICT','a populated project must use explicit bounded evolution instead of replacing definitionRef')
      }
      if (input.evolution !== undefined) {
        assertProjectEvolutionPlan(input.evolution)
        const active=await this.#revisionAt(query,projectId,projectRow.active_revision)
        if(active?.digest!==input.evolution.previousRevisionRef.digest || input.evolution.requestDigest!==input.requestDigest || input.evolution.sources.some((source)=>!revision.mappingRefs.some((ref)=>ref.id===source.mappingRef.id && ref.version===source.mappingRef.version && ref.digest===source.mappingRef.digest))) throw new ProjectStoreError('INVALID_REVISION','the complete evolution plan must match its real previous revision and new mapping pins')
        if (input.evolution.targetRevisionRef.digest !== revision.ref.digest || input.evolution.targetRevisionRef.revision !== revision.ref.revision || input.evolution.previousRevisionRef.revision !== projectRow.active_revision || input.evolution.targetRevisionRef.projectId !== projectId || input.evolution.previousRevisionRef.projectId !== projectId) throw new ProjectStoreError('INVALID_REVISION', 'evolution revision pins disagree')
        await assertEvolutionSourcePins(query,input.evolution)
        await query.query(`INSERT INTO agent_platform.project_evolutions (tenant_id,space_id,project_id,evolution_id,job_id,plan,idempotency_key,request_digest,actor,trace_id,recorded_at)
          VALUES(current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,$7,$8,$9::timestamptz)`, [projectId,input.evolution.evolutionId,input.evolution.jobId,JSON.stringify(input.evolution),input.idempotencyKey,input.requestDigest,input.actor,ctx.traceId,input.recordedAt])
      }

      await this.#insertRevision(query, input.outboxJobId, revision, input.idempotencyKey, input.requestDigest, input.actor, input.recordedAt)
      const advanced = await query.query<ProjectRow>(
        `UPDATE agent_platform.projects
            SET head_revision = $2::bigint, active_revision = CASE WHEN $4::boolean THEN active_revision ELSE $2::bigint END, staging_writable=true, updated_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND project_id = $1::uuid
          RETURNING ${PROJECT_COLUMNS}`,
        [projectId, nextRevision, input.recordedAt, input.evolution !== undefined],
      )
      const updated = advanced.rows[0]
      if (updated === undefined) {
        throw new ProjectStoreError('PROJECT_NOT_FOUND', 'the project disappeared during append')
      }
      await this.#insertOutbox(query, input.outboxJobId, input.outbox)

      return { project: toProject(updated), revision, created: true }
    })
  }

  async appendFieldConfirmation(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendFieldConfirmationInput,
    ctx: ToolContext,
  ): Promise<FieldConfirmationEventRecord> {
    assertFieldConfirmationInput(input)

    return this.#withScope(scopeRef, ctx, async (query) => {
      const locked = await query.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM agent_platform.projects
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid
           FOR UPDATE`,
        [projectId],
      )
      if (locked.rows[0] === undefined) {
        throw new ProjectStoreError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in the requested scope`)
      }

      const replay = await this.#confirmationByIdempotencyKey(query, input.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== input.requestDigest) {
          throw new ProjectStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different payload',
          )
        }
        return toConfirmation(replay)
      }

      const maxRevision = await query.query<{ revision: string }>(
        `SELECT COALESCE(MAX(revision), 0)::text AS revision
           FROM agent_platform.field_confirmation_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND project_id = $1::uuid AND record_id = $2::uuid AND field_id = $3`,
        [projectId, input.recordId, input.fieldId],
      )
      const nextRevision = (BigInt(maxRevision.rows[0]?.revision ?? '0') + 1n).toString()

      const inserted = await query.query<ConfirmationRow>(
        `INSERT INTO agent_platform.field_confirmation_events
           (tenant_id, space_id, project_id, record_id, field_id, revision, record_revision,
            content_digest, status, source_ref, reason, event_payload, idempotency_key, request_digest, actor,
            trace_id, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3, $4::bigint, $5::bigint, $6, $7, $8::jsonb, $9, $10::jsonb,
           $11, $12, $13, current_setting('app.trace_id', true), $14::timestamptz)
         RETURNING project_id, record_id, field_id, revision, record_revision, content_digest, status,
                   actor, source_ref, reason, event_payload, request_digest, recorded_at`,
        [
          projectId,
          input.recordId,
          input.fieldId,
          nextRevision,
          input.recordRevision,
          input.contentDigest,
          input.status,
          JSON.stringify(input.sourceRef),
          input.reason ?? null,
          JSON.stringify(input.eventPayload),
          input.idempotencyKey,
          input.requestDigest,
          input.actor,
          input.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        throw new ProjectStoreError('INVALID_CONFIRMATION', 'the field confirmation was not written')
      }
      return toConfirmation(row)
    })
  }

  async listFieldConfirmations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<FieldConfirmationEventRecord[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ConfirmationRow>(
        `SELECT project_id, record_id, field_id, revision, record_revision, content_digest, status,
                actor, source_ref, reason, event_payload, request_digest, recorded_at
           FROM agent_platform.field_confirmation_events
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND project_id = $1::uuid AND record_id = $2::uuid
          ORDER BY field_id, revision ASC`,
        [projectId, recordId],
      )
      return result.rows.map(toConfirmation)
    })
  }

  async #insertRevision(
    query: ScopedQuery,
    outboxId: Uuid,
    revision: ProjectRevision,
    idempotencyKey: string,
    requestDigest: string,
    actor: string,
    recordedAt: string,
  ): Promise<void> {
    const body = revisionBodyOf(revision)
    await query.query(
      `INSERT INTO agent_platform.project_revisions
         (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason,
          idempotency_key, request_digest, outbox_id, actor, trace_id, recorded_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1::uuid, $2::bigint, $3, $4::jsonb, $5::bigint, $6, $7, $8, $9::uuid, $10,
         current_setting('app.trace_id', true), $11::timestamptz)`,
      [
        revision.ref.projectId,
        revision.ref.revision,
        revision.ref.digest,
        JSON.stringify(body),
        body.sourceVisibilityEpoch,
        body.changeReason,
        idempotencyKey,
        requestDigest,
        outboxId,
        actor,
        recordedAt,
      ],
    )
  }

  async #insertOutbox(query: ScopedQuery, jobId: Uuid, outbox: NewOutboxMessage): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.job_outbox
         (tenant_id, space_id, outbox_id, job_id, topic, payload, idempotency_key, state, attempts,
          available_at, created_at)
       VALUES (
         current_setting('app.tenant_id')::uuid,
         current_setting('app.space_id')::uuid,
         $1::uuid, $2::uuid, $3, $4::jsonb, $5, 'pending', 0, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
      [
        outbox.outboxId,
        jobId,
        outbox.topic,
        JSON.stringify(outbox.payload),
        outbox.idempotencyKey,
        outbox.availableAt,
        outbox.createdAt,
      ],
    )
  }

  async #projectById(query: ScopedQuery, projectId: Uuid): Promise<ProjectRow | undefined> {
    const result = await query.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM agent_platform.projects
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid`,
      [projectId],
    )
    return result.rows[0]
  }

  async #projectByCreateKey(query: ScopedQuery, key: string): Promise<ProjectRow | undefined> {
    const result = await query.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM agent_platform.projects
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND create_idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #revisionAt(query: ScopedQuery, projectId: Uuid, revision: string): Promise<RevisionRow | undefined> {
    const result = await query.query<RevisionRow>(
      `SELECT revision, digest, body, request_digest FROM agent_platform.project_revisions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid AND revision = $2::bigint`,
      [projectId, revision],
    )
    return result.rows[0]
  }

  async #revisionByIdempotencyKey(query: ScopedQuery, key: string): Promise<RevisionRow | undefined> {
    const result = await query.query<RevisionRow>(
      `SELECT revision, digest, body, request_digest FROM agent_platform.project_revisions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #confirmationByIdempotencyKey(
    query: ScopedQuery,
    key: string,
  ): Promise<ConfirmationRow | undefined> {
    const result = await query.query<ConfirmationRow>(
      `SELECT project_id, record_id, field_id, revision, record_revision, content_digest, status,
                actor, source_ref, reason, event_payload, request_digest, recorded_at
           FROM agent_platform.field_confirmation_events
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
      throw new ProjectStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ProjectStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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

function assertFieldConfirmationInput(input: AppendFieldConfirmationInput): void {
  if (!isUuid(input.recordId)) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'recordId must be a uuid')
  }
  if (typeof input.fieldId !== 'string' || input.fieldId.length === 0) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'fieldId must be a non-empty string')
  }
  if (!isRevisionString(input.recordRevision)) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'recordRevision must be a decimal string')
  }
  if (!isSha256Digest(input.contentDigest)) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'contentDigest must be a sha256 digest')
  }
  if (!isSha256Digest(input.requestDigest)) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'requestDigest must be a sha256 digest')
  }
  if (input.status !== 'pending' && input.status !== 'confirmed' && input.status !== 'conflict') {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'status is not a known confirmation status')
  }
  if (!isResourceRef(input.sourceRef)) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'sourceRef is malformed')
  }
  if (!isRecord(input.eventPayload)) {
    throw new ProjectStoreError('INVALID_CONFIRMATION', 'eventPayload must be an object')
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ProjectStoreError('INVALID_REVISION', 'list limit must be a positive integer')
  }
  return Math.min(limit, 250)
}
