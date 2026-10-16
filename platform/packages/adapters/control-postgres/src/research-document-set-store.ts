import type { QueryResultRow } from 'pg'
import {
  ResearchDocumentSetError,
  assertResearchDocumentMemberShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  ResearchDocumentMember,
  ResearchDocumentMemberKind,
  ResearchDocumentMemberPage,
  ResearchDocumentSetStore,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}

interface MemberRow extends QueryResultRow {
  member_id: string
  workspace_id: string
  run_id: string
  kind: ResearchDocumentMemberKind
  document_ref: ResourceRef
  document_digest: string
  parse_id: string
  parser_version: string
  parse_ref: ResourceRef
  normalized_ref: ResourceRef | null
  provenance_ref: ResourceRef | null
  content_digest: string
  fetched_at: Date | null
  source_url: string | null
  recorded_at: Date
}

const MEMBER_COLUMNS = `member_id, workspace_id, run_id, kind, document_ref, document_digest, parse_id,
  parser_version, parse_ref, normalized_ref, provenance_ref, content_digest, fetched_at, source_url, recorded_at`

function toMember(row: MemberRow): ResearchDocumentMember {
  return {
    schemaVersion: 'research-document-member@1',
    memberId: row.member_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    kind: row.kind,
    documentRef: row.document_ref,
    parseId: row.parse_id,
    parserVersion: row.parser_version,
    parseRef: row.parse_ref,
    ...(row.normalized_ref === null ? {} : { normalizedRef: row.normalized_ref }),
    ...(row.provenance_ref === null ? {} : { provenanceRef: row.provenance_ref }),
    contentDigest: row.content_digest,
    ...(row.fetched_at === null ? {} : { fetchedAt: row.fetched_at.toISOString() }),
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    staged: true,
    inGroundingCorpus: false,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function encodeCursor(recordedAt: Date, memberId: string): string {
  return Buffer.from(`${recordedAt.toISOString()}|${memberId}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): { recordedAt: string; memberId: string } | undefined {
  if (cursor === undefined) return undefined
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) throw new ResearchDocumentSetError('INVALID_REQUEST', 'the member cursor is malformed')
  return { recordedAt: decoded.slice(0, separator), memberId: decoded.slice(separator + 1) }
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ResearchDocumentSetError('INVALID_REQUEST', 'the member page limit must be a positive integer')
  }
  return Math.min(limit, 200)
}

/**
 * Real PostgreSQL implementation of the research-document-set store (migration 094).
 *
 * Each call runs inside the trusted tenant/space scope, so RLS is a second layer behind the
 * explicit scope predicate. A member is unique per `(workspace, run, kind, document digest)`, so a
 * repeated staging of the same archived page or authorized document is an idempotent no-op that
 * returns the stored member. The `staged`/`in_grounding_corpus` columns are literal CHECK
 * constraints, so no write path can turn a staged research member into a formal corpus entry.
 */
export class PostgresResearchDocumentSetStore implements ResearchDocumentSetStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async appendMember(
    scopeRef: ScopeRef,
    member: ResearchDocumentMember,
    ctx: ToolContext,
  ): Promise<{ readonly member: ResearchDocumentMember; readonly created: boolean }> {
    assertResearchDocumentMemberShape(member)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<MemberRow>(
        `INSERT INTO agent_platform.research_document_members
           (tenant_id, space_id, workspace_id, run_id, member_id, kind, document_ref, document_digest,
            parse_id, parser_version, parse_ref, normalized_ref, provenance_ref, content_digest,
            fetched_at, source_url, staged, in_grounding_corpus, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid,
           $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7::uuid, $8, $9::jsonb, $10::jsonb,
           $11::jsonb, $12, $13::timestamptz, $14, true, false, $15::timestamptz)
         ON CONFLICT (tenant_id, space_id, workspace_id, run_id, kind, document_digest) DO NOTHING
         RETURNING ${MEMBER_COLUMNS}`,
        [
          member.workspaceId, member.runId, member.memberId, member.kind,
          JSON.stringify(member.documentRef), member.documentRef.digest,
          member.parseId, member.parserVersion, JSON.stringify(member.parseRef),
          member.normalizedRef === undefined ? null : JSON.stringify(member.normalizedRef),
          member.provenanceRef === undefined ? null : JSON.stringify(member.provenanceRef),
          member.contentDigest, member.fetchedAt ?? null, member.sourceUrl ?? null, member.recordedAt,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return { member: toMember(row), created: true }

      const existing = await query.query<MemberRow>(
        `SELECT ${MEMBER_COLUMNS} FROM agent_platform.research_document_members
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid AND run_id = $2::uuid AND kind = $3 AND document_digest = $4`,
        [member.workspaceId, member.runId, member.kind, member.documentRef.digest],
      )
      const stored = existing.rows[0]
      if (stored === undefined) throw new ResearchDocumentSetError('STORE_FAILED', 'the research document member was not written')
      return { member: toMember(stored), created: false }
    })
  }

  async getMember(scopeRef: ScopeRef, memberId: Uuid, ctx: ToolContext): Promise<ResearchDocumentMember | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<MemberRow>(
        `SELECT ${MEMBER_COLUMNS} FROM agent_platform.research_document_members
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND member_id = $1::uuid`,
        [memberId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toMember(row)
    })
  }

  async listMembers(
    scopeRef: ScopeRef,
    input: { readonly workspaceId: Uuid; readonly runId: Uuid; readonly limit: number; readonly cursor?: string },
    ctx: ToolContext,
  ): Promise<ResearchDocumentMemberPage> {
    const limit = normalizeLimit(input.limit)
    const cursor = decodeCursor(input.cursor)
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<MemberRow>(
        `SELECT ${MEMBER_COLUMNS} FROM agent_platform.research_document_members
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND workspace_id = $1::uuid AND run_id = $2::uuid
            AND ($3::timestamptz IS NULL OR (recorded_at, member_id) > ($3::timestamptz, $4::uuid))
          ORDER BY recorded_at ASC, member_id ASC
          LIMIT $5`,
        [input.workspaceId, input.runId, cursor?.recordedAt ?? null, cursor?.memberId ?? null, limit + 1],
      )
      const rows = result.rows.slice(0, limit)
      const last = rows[rows.length - 1]
      const complete = result.rows.length <= limit
      return {
        members: rows.map(toMember),
        ...(complete || last === undefined ? {} : { nextCursor: encodeCursor(last.recorded_at, last.member_id) }),
      }
    })
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (query: ScopedQuery) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) throw new ResearchDocumentSetError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new ResearchDocumentSetError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ResearchDocumentSetError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
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
