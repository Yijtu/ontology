import type { QueryResultRow } from 'pg'
import type { ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { ControlPostgresDatabase } from './database'

export interface IdentityRecallAuditRecord {
  readonly auditId: string
  readonly candidateId: string
  readonly definitionRef: VersionRef
  readonly queryDigest: string
  readonly resultDigest: string
  readonly result: unknown
  readonly actor: string
  readonly recordedAt: string
}

interface RecallRow extends QueryResultRow {
  audit_id: string
  candidate_id: string
  definition_ref: VersionRef
  query_digest: string
  result: unknown
  actor: string
  recorded_at: Date
}

/** Scoped append-only audit for source-backed identity recall; a score never mutates identity. */
export class PostgresIdentityRecallAuditStore {
  readonly #database: ControlPostgresDatabase
  constructor(database: ControlPostgresDatabase) { this.#database = database }

  async record(input: { readonly auditId: string; readonly scopeRef: ScopeRef; readonly candidateId: string; readonly definitionRef: VersionRef; readonly queryDigest: string; readonly result: unknown; readonly recordedAt: string }, ctx: ToolContext): Promise<IdentityRecallAuditRecord> {
    const { scopeRef } = input
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) throw new Error('identity recall audit scope does not match trusted context')
    return this.#database.withIdentityScope(scopeRef, async (client) => {
      await client.query(`INSERT INTO agent_platform.identity_recall_audits
        (tenant_id,space_id,audit_id,candidate_id,definition_ref,query_digest,result,actor,recorded_at)
        VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2,$3::jsonb,$4,$5::jsonb,$6,$7::timestamptz)
        ON CONFLICT (tenant_id,space_id,candidate_id,query_digest) DO NOTHING`,
      [input.auditId, input.candidateId, JSON.stringify(input.definitionRef), input.queryDigest, JSON.stringify(input.result), ctx.principal.subjectId, input.recordedAt])
      const read = await client.query<RecallRow>(`SELECT audit_id,candidate_id,definition_ref,query_digest,result,actor,recorded_at
        FROM agent_platform.identity_recall_audits
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND candidate_id=$1 AND query_digest=$2`, [input.candidateId, input.queryDigest])
      const row = read.rows[0]
      if (row === undefined) throw new Error('identity recall audit insert returned no record')
      return {
        auditId: row.audit_id, candidateId: row.candidate_id, definitionRef: row.definition_ref,
        queryDigest: row.query_digest,
        resultDigest: sha256DigestOf(JSON.stringify(row.result)),
        result: row.result, actor: row.actor, recordedAt: row.recorded_at.toISOString(),
      }
    })
  }

  async get(auditId: string, ctx: ToolContext): Promise<IdentityRecallAuditRecord | undefined> {
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    return this.#database.withIdentityScope(scopeRef, async (client) => {
      const read = await client.query<RecallRow>(`SELECT audit_id,candidate_id,definition_ref,query_digest,result,actor,recorded_at
        FROM agent_platform.identity_recall_audits
        WHERE tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid AND audit_id=$1`, [auditId])
      const row = read.rows[0]
      if (row === undefined) return undefined
      return { auditId: row.audit_id, candidateId: row.candidate_id, definitionRef: row.definition_ref, queryDigest: row.query_digest, resultDigest: sha256DigestOf(JSON.stringify(row.result)), result: row.result, actor: row.actor, recordedAt: row.recorded_at.toISOString() }
    }, { readOnly: true })
  }
}
