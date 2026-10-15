import type { QueryResultRow } from 'pg'
import {
  SourceAdmissionError,
  assertAssetDraftVersionShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  AdmitSourceInput,
  AppendAssetDraftInput,
  AssetDraftVersion,
  IndustryWorkspace,
  NewOutboxMessage,
  ResourceRef,
  ScopeRef,
  SourceAdmission,
  SourceAdmissionKind,
  SourceAdmissionStore,
  SourceAdmissionTableOptions,
  SourceAdmissionWriteResult,
  SourceTrustTier,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

interface AdmissionRow extends QueryResultRow {
  admission_id: string
  workspace_id: string
  source_id: string
  source_revision: string
  source_review_event_id: string | null
  trust_tier: SourceTrustTier
  source_ref: ResourceRef
  parse_id: string
  parser_version: string
  kind: SourceAdmissionKind
  table_options: SourceAdmissionTableOptions | null
  document_set_ref: ResourceRef
  draft_revision: string
  draft_digest: string
  admitted_by: string
  admitted_at: Date
  idempotency_key: string
}

interface WorkspaceRow extends QueryResultRow {
  workspace_id: string
  namespace: string
  display_name: string
  boundary: IndustryWorkspace['boundary']
  head_revision: string
  state: IndustryWorkspace['state']
  latest_pack_ref: VersionRef | null
}

const ADMISSION_COLUMNS = `admission_id, workspace_id, source_id, source_revision, source_review_event_id,
  trust_tier, source_ref, parse_id, parser_version, kind, table_options, document_set_ref, draft_revision,
  draft_digest, admitted_by, admitted_at, idempotency_key`
const WORKSPACE_COLUMNS = `workspace_id, namespace, display_name, boundary, head_revision, state, latest_pack_ref`

function toAdmission(row: AdmissionRow): SourceAdmission {
  return {
    schemaVersion: 'source-admission@1',
    admissionId: row.admission_id,
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    ...(row.source_review_event_id === null ? {} : { sourceReviewEventId: row.source_review_event_id }),
    trustTier: row.trust_tier,
    sourceRef: row.source_ref,
    parseId: row.parse_id,
    parserVersion: row.parser_version,
    kind: row.kind,
    ...(row.table_options === null ? {} : { tableOptions: row.table_options }),
    documentSetRef: row.document_set_ref,
    draftRevision: row.draft_revision,
    draftDigest: row.draft_digest,
    admittedBy: row.admitted_by,
    admittedAt: row.admitted_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  }
}

function toWorkspace(row: WorkspaceRow): IndustryWorkspace {
  return {
    workspaceId: row.workspace_id,
    namespace: row.namespace,
    displayName: row.display_name,
    boundary: row.boundary,
    headRevision: row.head_revision,
    state: row.state,
    ...(row.latest_pack_ref === null ? {} : { latestPublishedPackRef: row.latest_pack_ref }),
  }
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}

function encodeCursor(admittedAt: Date, id: string): string {
  return Buffer.from(`${admittedAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}
function decodeCursor(cursor: string | undefined): { admittedAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) throw new SourceAdmissionError('INVALID_REQUEST', 'the list cursor is malformed')
  return { admittedAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) }
}

/**
 * Real PostgreSQL implementation of the source-admission store. `admitSource` runs one control
 * transaction: it re-reads (and locks) the candidate-source row, verifies its expected revision,
 * approved state and recorded tier, re-reads the workspace head under the same transaction, and
 * only then appends the immutable draft + its transactional outbox and the admission record. A
 * replayed Idempotency-Key returns the stored admission instead of writing a second one.
 */
export class PostgresSourceAdmissionStore implements SourceAdmissionStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async getAdmission(scopeRef: ScopeRef, admissionId: Uuid, ctx: ToolContext): Promise<SourceAdmission | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AdmissionRow>(
        `SELECT ${ADMISSION_COLUMNS} FROM agent_platform.workspace_source_admissions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND admission_id = $1::uuid`,
        [admissionId],
      )
      return result.rows[0] === undefined ? undefined : toAdmission(result.rows[0])
    })
  }

  async findAdmissionBySource(scopeRef: ScopeRef, workspaceId: Uuid, sourceId: Uuid, ctx: ToolContext): Promise<SourceAdmission | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AdmissionRow>(
        `SELECT ${ADMISSION_COLUMNS} FROM agent_platform.workspace_source_admissions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid AND source_id = $2::uuid
          ORDER BY admitted_at DESC, admission_id DESC LIMIT 1`,
        [workspaceId, sourceId],
      )
      return result.rows[0] === undefined ? undefined : toAdmission(result.rows[0])
    })
  }

  async listAdmissions(scopeRef: ScopeRef, workspaceId: Uuid, page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext): Promise<{ readonly admissions: readonly SourceAdmission[]; readonly nextCursor?: string }> {
    const limit = Number.isInteger(page.limit) && page.limit > 0 ? Math.min(page.limit, 250) : 100
    const cursor = decodeCursor(page.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<AdmissionRow>(
        `SELECT ${ADMISSION_COLUMNS} FROM agent_platform.workspace_source_admissions
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid
            AND ($2::timestamptz IS NULL OR (admitted_at, admission_id) > ($2::timestamptz, $3::uuid))
          ORDER BY admitted_at ASC, admission_id ASC LIMIT $4`,
        [workspaceId, cursor?.admittedAt ?? null, cursor?.id ?? null, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const last = rows[rows.length - 1]
      return { admissions: rows.map(toAdmission),
        ...(result.rows.length <= limit || last === undefined ? {} : { nextCursor: encodeCursor(last.admitted_at, last.admission_id) }) }
    })
  }

  async admitSource(scopeRef: ScopeRef, input: AdmitSourceInput, ctx: ToolContext): Promise<SourceAdmissionWriteResult> {
    assertAssetDraftVersionShape(input.append.draft)
    if (input.append.draft.workspaceId !== input.admission.workspaceId) {
      throw new SourceAdmissionError('INVALID_REQUEST', 'the appended draft must belong to the admission workspace')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#admissionByKey(query, input.append.idempotencyKey)
      if (replay !== undefined) {
        const workspace = await this.#workspaceById(query, replay.workspace_id)
        const draft = await this.#draftAt(query, replay.workspace_id, replay.draft_revision)
        if (workspace === undefined || draft === undefined) {
          throw new SourceAdmissionError('STORE_FAILED', 'the replayed admission is missing its workspace or draft')
        }
        return { admission: toAdmission(replay), workspace: toWorkspace(workspace), draft, created: false }
      }

      const source = await this.#lockSource(query, input.admission.sourceId)
      if (source === undefined) throw new SourceAdmissionError('NOT_FOUND', 'the candidate source is not visible in this scope')
      if (source.workspace_id !== input.admission.workspaceId) {
        throw new SourceAdmissionError('SCOPE_MISMATCH', 'the candidate source belongs to another workspace')
      }
      if (source.review_state !== 'approved') throw new SourceAdmissionError('NOT_APPROVED', 'only an approved candidate source may be admitted')
      if (source.retracted_at !== null) throw new SourceAdmissionError('SOURCE_RETRACTED', 'the candidate source was retracted and cannot be admitted')
      if (source.revision !== input.expectedSourceRevision) {
        throw new SourceAdmissionError('VERSION_CONFLICT', `candidate source head is ${source.revision}, not the expected ${input.expectedSourceRevision}`)
      }
      if (source.trust_tier !== input.admission.trustTier) {
        throw new SourceAdmissionError('VERSION_CONFLICT', 'the admission tier does not match the reviewed source tier')
      }

      const locked = await query.query<WorkspaceRow>(
        `SELECT ${WORKSPACE_COLUMNS} FROM agent_platform.industry_workspaces
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid FOR UPDATE`,
        [input.admission.workspaceId],
      )
      const workspaceRow = locked.rows[0]
      if (workspaceRow === undefined) throw new SourceAdmissionError('NOT_FOUND', 'the target workspace is not visible in this scope')
      const head = workspaceRow.head_revision
      if (head !== input.expectedWorkspaceRevision) {
        throw new SourceAdmissionError('VERSION_CONFLICT', `workspace head is ${head}, not the expected ${input.expectedWorkspaceRevision}`)
      }
      const nextRevision = (BigInt(head) + 1n).toString()
      if (input.append.draft.revision !== nextRevision) {
        throw new SourceAdmissionError('VERSION_CONFLICT', `the admitted draft must be revision ${nextRevision}`)
      }

      try {
        await this.#insertAdmission(query, input.admission, input.requestDigest)
        await this.#insertDraft(query, input.append)
        const advanced = await query.query<WorkspaceRow>(
          `UPDATE agent_platform.industry_workspaces
              SET head_revision = $2::bigint, updated_at = $3::timestamptz
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND workspace_id = $1::uuid
            RETURNING ${WORKSPACE_COLUMNS}`,
          [input.admission.workspaceId, nextRevision, input.append.recordedAt],
        )
        const updated = advanced.rows[0]
        if (updated === undefined) throw new SourceAdmissionError('STORE_FAILED', 'the workspace disappeared during admission')
        await this.#insertOutbox(query, input.append)
        return { admission: input.admission, workspace: toWorkspace(updated), draft: input.append.draft, created: true }
      } catch (error) {
        if (pgCodeOf(error) === '23505') {
          const concurrent = await this.#admissionByKey(query, input.append.idempotencyKey)
          if (concurrent !== undefined) {
            const workspace = await this.#workspaceById(query, concurrent.workspace_id)
            const draft = await this.#draftAt(query, concurrent.workspace_id, concurrent.draft_revision)
            if (workspace === undefined || draft === undefined) {
              throw new SourceAdmissionError('STORE_FAILED', 'the replayed admission is missing its workspace or draft', { cause: error })
            }
            return { admission: toAdmission(concurrent), workspace: toWorkspace(workspace), draft, created: false }
          }
          throw new SourceAdmissionError('ALREADY_ADMITTED', 'this source revision was already admitted', { cause: error })
        }
        throw error
      }
    })
  }

  async #insertAdmission(query: ScopedQuery, admission: SourceAdmission, requestDigest: string): Promise<void> {
    await query.query(
      `INSERT INTO agent_platform.workspace_source_admissions
         (tenant_id, space_id, workspace_id, admission_id, source_id, source_revision, source_review_event_id,
          trust_tier, source_ref, parse_id, parser_version, kind, table_options, document_set_ref, draft_revision,
          draft_digest, idempotency_key, request_digest, admitted_by, admitted_at)
       VALUES (
         current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1::uuid, $2::uuid, $3::uuid,
         $4::bigint, $5::uuid, $6, $7::jsonb, $8::uuid, $9, $10, $11::jsonb, $12::jsonb, $13::bigint, $14, $15,
         $16, $17, $18::timestamptz)`,
      [admission.workspaceId, admission.admissionId, admission.sourceId, admission.sourceRevision,
        admission.sourceReviewEventId ?? null, admission.trustTier, JSON.stringify(admission.sourceRef),
        admission.parseId, admission.parserVersion, admission.kind,
        admission.tableOptions === undefined ? null : JSON.stringify(admission.tableOptions),
        JSON.stringify(admission.documentSetRef), admission.draftRevision, admission.draftDigest,
        admission.idempotencyKey, requestDigest, admission.admittedBy, admission.admittedAt],
    )
  }

  async #insertDraft(query: ScopedQuery, append: AppendAssetDraftInput): Promise<void> {
    const draft = append.draft
    await query.query(
      `INSERT INTO agent_platform.asset_draft_versions
         (tenant_id, space_id, workspace_id, revision, digest, body, document_set_ref,
          idempotency_key, request_digest, outbox_id, actor, trace_id, recorded_at)
       VALUES (
         current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
         $1::uuid, $2::bigint, $3, $4::jsonb, $5::jsonb, $6, $7, $8::uuid, $9,
         current_setting('app.trace_id', true), $10::timestamptz)`,
      [draft.workspaceId, draft.revision, draft.digest, JSON.stringify(draft), JSON.stringify(draft.documentSetRef),
        append.idempotencyKey, append.requestDigest, append.outboxJobId, append.actor, append.recordedAt],
    )
  }

  async #insertOutbox(query: ScopedQuery, append: AppendAssetDraftInput): Promise<void> {
    const outbox: NewOutboxMessage = append.outbox
    await query.query(
      `INSERT INTO agent_platform.job_outbox
         (tenant_id, space_id, outbox_id, job_id, topic, payload, idempotency_key, state, attempts,
          available_at, created_at)
       VALUES (
         current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
         $1::uuid, $2::uuid, $3, $4::jsonb, $5, 'pending', 0, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
      [outbox.outboxId, append.outboxJobId, outbox.topic, JSON.stringify(outbox.payload),
        outbox.idempotencyKey, outbox.availableAt, outbox.createdAt],
    )
  }

  async #lockSource(query: ScopedQuery, sourceId: Uuid): Promise<(QueryResultRow & { workspace_id: string; revision: string; review_state: string; trust_tier: string; retracted_at: Date | null }) | undefined> {
    const result = await query.query<QueryResultRow & { workspace_id: string; revision: string; review_state: string; trust_tier: string; retracted_at: Date | null }>(
      `SELECT workspace_id, revision, review_state, trust_tier, retracted_at
         FROM agent_platform.candidate_sources
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND source_id = $1::uuid FOR UPDATE`,
      [sourceId],
    )
    return result.rows[0]
  }

  async #admissionByKey(query: ScopedQuery, key: string): Promise<AdmissionRow | undefined> {
    const result = await query.query<AdmissionRow>(
      `SELECT ${ADMISSION_COLUMNS} FROM agent_platform.workspace_source_admissions
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #workspaceById(query: ScopedQuery, workspaceId: string): Promise<WorkspaceRow | undefined> {
    const result = await query.query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM agent_platform.industry_workspaces
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND workspace_id = $1::uuid`,
      [workspaceId],
    )
    return result.rows[0]
  }

  async #draftAt(query: ScopedQuery, workspaceId: string, revision: string): Promise<AssetDraftVersion | undefined> {
    const result = await query.query<QueryResultRow & { body: AssetDraftVersion }>(
      `SELECT body FROM agent_platform.asset_draft_versions
        WHERE tenant_id = current_setting('app.tenant_id')::uuid
          AND space_id = current_setting('app.space_id')::uuid
          AND workspace_id = $1::uuid AND revision = $2::bigint`,
      [workspaceId, revision],
    )
    return result.rows[0]?.body
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) throw new SourceAdmissionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new SourceAdmissionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new SourceAdmissionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
      return run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      })
    })
  }
}
