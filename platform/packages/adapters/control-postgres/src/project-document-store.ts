import type { QueryResultRow } from 'pg'
import {
  ProjectDocumentStoreError,
  assertProjectDocumentMembershipShape,
  isToolContext,
  isUuid,
  sha256OfCanonical,
} from '@ontology/contracts'
import type {
  CompletenessStatus,
  ListProjectDocumentsFilter,
  ProjectDocumentMembership,
  ProjectDocumentPage,
  ProjectDocumentState,
  ProjectDocumentStore,
  ProjectDocumentWriteResult,
  ProjectIndexReceipt,
  ProjectIndexReceiptWriteResult,
  ProjectVisibility,
  RecordProjectIndexReceiptInput,
  RegisterProjectDocumentInput,
  ResourceRef,
  ReviseProjectDocumentInput,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface VisibilityRow extends QueryResultRow {
  visibility_epoch: string
  membership_revision: string
}

interface MembershipRow extends QueryResultRow {
  document_id: string
  membership_revision: string
  state: ProjectDocumentState
  document_ref: ResourceRef
  document_digest: Sha256Digest
  parse_id: string
  parse_ref: ResourceRef
  text_digest: Sha256Digest
  precision: 'exact' | 'approximate'
  source_namespace: string | null
  source_id: string | null
  visibility_epoch: string
  replaced_by: string | null
  reason: string | null
  recorded_at: Date
}

interface ReceiptRow extends QueryResultRow {
  project_id: string
  collection_ref: string
  generation: string
  visibility_epoch: string
  membership_revision: string
  target_digest: Sha256Digest
  index_ref: VersionRef
  doc_count: string
  source_document_count: string
  completeness: CompletenessStatus
  recorded_at: Date
}

const MEMBERSHIP_COLUMNS = `document_id, membership_revision::text AS membership_revision, state,
  document_ref, document_digest, parse_id, parse_ref, text_digest, precision,
  source_namespace, source_id, visibility_epoch::text AS visibility_epoch, replaced_by, reason,
  recorded_at`

const RECEIPT_COLUMNS = `project_id, collection_ref, generation, visibility_epoch::text AS visibility_epoch,
  membership_revision::text AS membership_revision, target_digest, index_ref,
  doc_count::text AS doc_count, source_document_count::text AS source_document_count,
  completeness, recorded_at`

const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 500

function invalid(message: string): ProjectDocumentStoreError {
  return new ProjectDocumentStoreError('INVALID_MEMBERSHIP', message)
}

function scopeMismatch(message: string): ProjectDocumentStoreError {
  return new ProjectDocumentStoreError('SCOPE_MISMATCH', message)
}

function toRevision(value: unknown): RevisionString {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalid('a stored revision is not a decimal string')
  }
  return value
}

function toMembership(row: MembershipRow, projectId: Uuid): ProjectDocumentMembership {
  const membership: ProjectDocumentMembership = {
    projectId,
    documentId: row.document_id,
    state: row.state,
    membershipRevision: toRevision(row.membership_revision),
    documentRef: row.document_ref,
    documentDigest: row.document_digest,
    parseId: row.parse_id,
    parseRef: row.parse_ref,
    textDigest: row.text_digest,
    precision: row.precision === 'approximate' ? 'approximate' : 'exact',
    ...(row.source_namespace === null || row.source_id === null
      ? {}
      : { sourceRef: { namespace: row.source_namespace, sourceId: row.source_id } }),
    visibilityEpoch: toRevision(row.visibility_epoch),
    ...(row.replaced_by === null ? {} : { replacedBy: row.replaced_by }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    recordedAt: row.recorded_at.toISOString(),
  }
  assertProjectDocumentMembershipShape(membership)
  return membership
}

function toReceipt(row: ReceiptRow): ProjectIndexReceipt {
  return {
    projectId: row.project_id,
    collectionRef: row.collection_ref,
    generation: toRevision(row.generation),
    visibilityEpoch: toRevision(row.visibility_epoch),
    membershipRevision: toRevision(row.membership_revision),
    targetDigest: row.target_digest,
    indexRef: row.index_ref,
    documentCount: Number(row.doc_count),
    sourceDocumentCount: Number(row.source_document_count),
    completeness: row.completeness,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function encodeCursor(documentId: Uuid): string {
  return Buffer.from(JSON.stringify({ after: documentId }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): Uuid {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('bad cursor')
    const after = (parsed as { after?: unknown }).after
    if (!isUuid(after)) throw new Error('bad cursor')
    return after
  } catch (error) {
    throw new ProjectDocumentStoreError('INVALID_MEMBERSHIP', 'the project document cursor is malformed', {
      cause: error,
    })
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503'
}

/**
 * Real PostgreSQL implementation of the project document corpus store (migration
 * 069, SPEC v0.3a §7).
 *
 * `registerDocument`/`reviseDocument` append a membership revision and bump the
 * project visibility epoch inside one transaction. `recordIndexReceipt` is the
 * epoch CAS: within a locked transaction the current epoch is compared to the
 * build's epoch and a stale build is reported not-activated without touching the
 * active pointer, so a build that finished after a retraction can never
 * resurrect a withdrawn corpus.
 */
export class PostgresProjectDocumentStore implements ProjectDocumentStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async registerDocument(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: RegisterProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentWriteResult> {
    if (!isUuid(projectId) || !isUuid(input.documentId)) {
      throw invalid('projectId and documentId must be uuids')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      await this.#lockProject(query, projectId)
      const current = await this.#currentMembershipRow(query, projectId, input.documentId, true)
      if (current !== undefined) {
        const membership = toMembership(current, projectId)
        const pins = (value: RegisterProjectDocumentInput | ProjectDocumentMembership) => ({ documentRef: value.documentRef, documentDigest: value.documentDigest,
          parseId: value.parseId, parseRef: value.parseRef, textDigest: value.textDigest, precision: value.precision, sourceRef: value.sourceRef ?? null })
        if (membership.state !== 'active' || sha256OfCanonical(pins(membership)) !== sha256OfCanonical(pins(input))) throw invalid('an existing or withdrawn document requires an explicit revision; import cannot revive or mutate it')
        const visibility = await this.#visibilityRow(query, projectId)
        return { membership, visibility: { projectId, epoch: toRevision(visibility?.visibility_epoch ?? '0'), membershipRevision: toRevision(visibility?.membership_revision ?? '0') }, created: false }
      }
      const visibility = await this.#bumpEpoch(query, projectId)
      const membership: ProjectDocumentMembership = {
        projectId,
        documentId: input.documentId,
        state: 'active',
        membershipRevision: visibility.membershipRevision,
        documentRef: input.documentRef,
        documentDigest: input.documentDigest,
        parseId: input.parseId,
        parseRef: input.parseRef,
        textDigest: input.textDigest,
        precision: input.precision,
        ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
        visibilityEpoch: visibility.epoch,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        recordedAt: input.recordedAt,
      }
      assertProjectDocumentMembershipShape(membership)
      await this.#insertMembership(query, membership)
      return { membership, visibility, created: true }
    })
  }

  async reviseDocument(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: ReviseProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentWriteResult> {
    if (!isUuid(projectId) || !isUuid(input.documentId)) {
      throw invalid('projectId and documentId must be uuids')
    }
    if (input.op === 'retract' && input.replacement !== undefined) {
      throw invalid('a retract revision must not carry a replacement document')
    }
    if (input.op === 'replace' && input.replacement === undefined) {
      throw invalid('a replace revision requires a replacement document')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      await this.#lockProject(query, projectId)
      const current = await this.#currentMembershipRow(query, projectId, input.documentId, true)
      if (current === undefined) {
        throw new ProjectDocumentStoreError(
          'DOCUMENT_NOT_FOUND',
          `document ${input.documentId} is not a member of project ${projectId}`,
        )
      }
      if (current.state !== 'active') {
        throw new ProjectDocumentStoreError(
          'INVALID_REVISION',
          `document ${input.documentId} is already ${current.state} and cannot be revised again`,
        )
      }
      const visibility = await this.#bumpEpoch(query, projectId)
      const revised: ProjectDocumentMembership = {
        projectId,
        documentId: input.documentId,
        state: input.op === 'retract' ? 'retracted' : 'replaced',
        membershipRevision: visibility.membershipRevision,
        documentRef: current.document_ref,
        documentDigest: current.document_digest,
        parseId: current.parse_id,
        parseRef: current.parse_ref,
        textDigest: current.text_digest,
        precision: current.precision === 'approximate' ? 'approximate' : 'exact',
        ...(current.source_namespace === null || current.source_id === null
          ? {}
          : { sourceRef: { namespace: current.source_namespace, sourceId: current.source_id } }),
        visibilityEpoch: visibility.epoch,
        ...(input.replacement === undefined ? {} : { replacedBy: input.replacement.documentId }),
        reason: input.reason,
        recordedAt: input.recordedAt,
      }
      assertProjectDocumentMembershipShape(revised)
      await this.#insertMembership(query, revised)

      if (input.replacement !== undefined) {
        const replacement: ProjectDocumentMembership = {
          projectId,
          documentId: input.replacement.documentId,
          state: 'active',
          membershipRevision: visibility.membershipRevision,
          documentRef: input.replacement.documentRef,
          documentDigest: input.replacement.documentDigest,
          parseId: input.replacement.parseId,
          parseRef: input.replacement.parseRef,
          textDigest: input.replacement.textDigest,
          precision: input.replacement.precision,
          ...(input.replacement.sourceRef === undefined
            ? {}
            : { sourceRef: input.replacement.sourceRef }),
          visibilityEpoch: visibility.epoch,
          reason: input.reason,
          recordedAt: input.recordedAt,
        }
        assertProjectDocumentMembershipShape(replacement)
        await this.#insertMembership(query, replacement)
      }
      return { membership: revised, visibility, created: true }
    })
  }

  async getVisibility(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectVisibility | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#visibilityRow(query, projectId)
      return row === undefined
        ? undefined
        : {
            projectId,
            epoch: toRevision(row.visibility_epoch),
            membershipRevision: toRevision(row.membership_revision),
          }
    })
  }

  async getMembership(
    scopeRef: ScopeRef,
    projectId: Uuid,
    documentId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectDocumentMembership | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#currentMembershipRow(query, projectId, documentId, false)
      return row === undefined ? undefined : toMembership(row, projectId)
    })
  }

  async listDocuments(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: ListProjectDocumentsFilter,
    ctx: ToolContext,
  ): Promise<ProjectDocumentPage> {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)
    const after = filter.cursor === undefined ? null : decodeCursor(filter.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<MembershipRow>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM (
           SELECT DISTINCT ON (document_id) *
             FROM agent_platform.project_document_memberships
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND project_id = $1::uuid
            ORDER BY document_id, membership_revision DESC
         ) current
         WHERE ($2::text IS NULL OR state = $2)
           AND ($3::uuid IS NULL OR document_id > $3::uuid)
         ORDER BY document_id
         LIMIT $4`,
        [projectId, filter.state ?? null, after, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const more = result.rows.length > limit
      const last = rows.at(-1)
      return {
        memberships: rows.map((row) => toMembership(row, projectId)),
        nextCursor: more && last !== undefined ? encodeCursor(last.document_id) : null,
      }
    })
  }

  async recordIndexReceipt(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: RecordProjectIndexReceiptInput,
    ctx: ToolContext,
  ): Promise<ProjectIndexReceiptWriteResult> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const visibility = await this.#visibilityRow(query, projectId, true)
      const currentEpoch = visibility === undefined ? '0' : toRevision(visibility.visibility_epoch)
      const receipt: ProjectIndexReceipt = {
        projectId,
        collectionRef: input.collectionRef,
        generation: input.generation,
        visibilityEpoch: input.visibilityEpoch,
        membershipRevision: input.membershipRevision,
        targetDigest: input.targetDigest,
        indexRef: input.indexRef,
        documentCount: input.documentCount,
        sourceDocumentCount: input.sourceDocumentCount,
        completeness: input.completeness,
        recordedAt: input.recordedAt,
      }
      if (input.visibilityEpoch !== currentEpoch) {
        return { receipt, activated: false }
      }
      const inserted = await query.query<ReceiptRow>(
        `INSERT INTO agent_platform.project_document_index_receipts (
           tenant_id, space_id, project_id, collection_ref, generation, visibility_epoch,
           membership_revision, target_digest, index_ref, doc_count, source_document_count,
           completeness, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2, $3, $4::bigint, $5::bigint, $6, $7::jsonb, $8::bigint, $9::bigint,
           $10, $11::timestamptz)
         ON CONFLICT (tenant_id, space_id, project_id, collection_ref, generation)
         DO UPDATE SET visibility_epoch = EXCLUDED.visibility_epoch,
                       membership_revision = EXCLUDED.membership_revision,
                       target_digest = EXCLUDED.target_digest,
                       index_ref = EXCLUDED.index_ref,
                       doc_count = EXCLUDED.doc_count,
                       source_document_count = EXCLUDED.source_document_count,
                       completeness = EXCLUDED.completeness,
                       recorded_at = EXCLUDED.recorded_at
         RETURNING ${RECEIPT_COLUMNS}`,
        [
          projectId,
          input.collectionRef,
          input.generation,
          input.visibilityEpoch,
          input.membershipRevision,
          input.targetDigest,
          JSON.stringify(input.indexRef),
          input.documentCount,
          input.sourceDocumentCount,
          input.completeness,
          input.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) {
        throw invalid('the project document index receipt could not be written')
      }
      return { receipt: toReceipt(row), activated: true }
    })
  }

  async getIndexReceipt(
    scopeRef: ScopeRef,
    projectId: Uuid,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectIndexReceipt | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM agent_platform.project_document_index_receipts
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid AND generation = $2`,
        [projectId, generation],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toReceipt(row)
    })
  }

  async #visibilityRow(
    query: ScopedQuery,
    projectId: Uuid,
    forUpdate = false,
  ): Promise<VisibilityRow | undefined> {
    const result = await query.query<VisibilityRow>(
      `SELECT visibility_epoch::text AS visibility_epoch, membership_revision::text AS membership_revision
         FROM agent_platform.project_visibility
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND project_id = $1::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
      [projectId],
    )
    return result.rows[0]
  }

  async #lockProject(query: ScopedQuery, projectId: Uuid): Promise<void> {
    const owner = await query.query<{ project_id: string }>(`SELECT project_id FROM agent_platform.projects
      WHERE tenant_id = current_setting('app.tenant_id')::uuid AND space_id = current_setting('app.space_id')::uuid AND project_id = $1::uuid FOR UPDATE`, [projectId])
    if (owner.rows[0] === undefined) throw new ProjectDocumentStoreError('PROJECT_NOT_FOUND', 'the project is not visible in this scope')
  }

  async #bumpEpoch(query: ScopedQuery, projectId: Uuid): Promise<ProjectVisibility> {
    try {
      await query.query(
        `INSERT INTO agent_platform.project_visibility
           (tenant_id, space_id, project_id, visibility_epoch, membership_revision, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, 0, 0, now())
         ON CONFLICT (tenant_id, space_id, project_id) DO NOTHING`,
        [projectId],
      )
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ProjectDocumentStoreError(
          'PROJECT_NOT_FOUND',
          `project ${projectId} is not visible in this scope`,
        )
      }
      throw error
    }
    const updated = await query.query<VisibilityRow>(
      `UPDATE agent_platform.project_visibility
          SET visibility_epoch = visibility_epoch + 1,
              membership_revision = membership_revision + 1,
              updated_at = now()
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND project_id = $1::uuid
        RETURNING visibility_epoch::text AS visibility_epoch, membership_revision::text AS membership_revision`,
      [projectId],
    )
    const row = updated.rows[0]
    if (row === undefined) {
      throw invalid('the project visibility epoch could not be advanced')
    }
    // Visibility moves first, in this transaction. Facts have their own readiness owner.
    await query.query(`UPDATE agent_platform.project_readiness SET state = 'revoked', completeness = 'partial'
      WHERE tenant_id = current_setting('app.tenant_id')::uuid AND space_id = current_setting('app.space_id')::uuid
        AND project_id = $1::uuid AND kind = 'document_index'`, [projectId])
    return {
      projectId,
      epoch: toRevision(row.visibility_epoch),
      membershipRevision: toRevision(row.membership_revision),
    }
  }

  async #currentMembershipRow(
    query: ScopedQuery,
    projectId: Uuid,
    documentId: Uuid,
    forUpdate: boolean,
  ): Promise<MembershipRow | undefined> {
    const result = await query.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM agent_platform.project_document_memberships
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid AND document_id = $2::uuid
         ORDER BY membership_revision DESC
         LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [projectId, documentId],
    )
    return result.rows[0]
  }

  async #insertMembership(
    query: ScopedQuery,
    membership: ProjectDocumentMembership,
  ): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.project_document_memberships (
         tenant_id, space_id, project_id, document_id, membership_revision, state, document_ref,
         document_digest, parse_id, parse_ref, text_digest, precision, source_namespace, source_id,
         visibility_epoch, replaced_by, reason, recorded_at)
       VALUES (
         current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
         $1::uuid, $2::uuid, $3::bigint, $4, $5::jsonb, $6, $7::uuid, $8::jsonb, $9, $10,
         $11, $12, $13::bigint, $14::uuid, $15, $16::timestamptz)
       ON CONFLICT (tenant_id, space_id, project_id, document_id, membership_revision) DO NOTHING`,
      [
        membership.projectId,
        membership.documentId,
        membership.membershipRevision,
        membership.state,
        JSON.stringify(membership.documentRef),
        membership.documentDigest,
        membership.parseId,
        JSON.stringify(membership.parseRef),
        membership.textDigest,
        membership.precision,
        membership.sourceRef?.namespace ?? null,
        membership.sourceRef?.sourceId ?? null,
        membership.visibilityEpoch,
        membership.replacedBy ?? null,
        membership.reason ?? null,
        membership.recordedAt,
      ],
    )
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw scopeMismatch('a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw scopeMismatch('trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw scopeMismatch('request scope does not match the trusted principal scope')
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
