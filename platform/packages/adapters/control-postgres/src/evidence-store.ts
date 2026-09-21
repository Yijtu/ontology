import { EvidenceStoreError, isToolContext } from '@ontology/contracts'
import type {
  EvidenceEnvelope,
  EvidenceKind,
  EvidenceRecord,
  EvidenceStorePort,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface EvidenceRow extends QueryResultRow {
  evidence_id: string
  kind: EvidenceKind
  run_id: string | null
  envelope_digest: string
  revision: string
  recorded_at: Date
  envelope: EvidenceEnvelope
}

const EVIDENCE_COLUMNS = 'evidence_id, kind, run_id, envelope_digest, revision, recorded_at, envelope'
const SHA256 = /^sha256:[0-9a-f]{64}$/

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'observation',
  'document_span',
  'computation',
  'rule_derivation',
  'identity_decision',
  'model_output',
  'web_page',
]

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new EvidenceStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new EvidenceStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new EvidenceStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

function toRecord(row: EvidenceRow): EvidenceRecord {
  const evidenceRef: ResourceRef = {
    id: row.evidence_id,
    version: '1.0.0',
    digest: row.envelope_digest,
    kind: 'evidence',
  }
  return {
    evidenceRef,
    envelope: row.envelope,
    envelopeDigest: row.envelope_digest,
    revision: row.revision,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function validateEnvelope(envelope: EvidenceEnvelope): void {
  if (typeof envelope.evidenceId !== 'string' || envelope.evidenceId.length === 0) {
    throw new EvidenceStoreError('EVIDENCE_INVALID', 'the evidence envelope has no evidence id')
  }
  if (!EVIDENCE_KINDS.includes(envelope.kind)) {
    throw new EvidenceStoreError('EVIDENCE_INVALID', `unknown evidence kind ${String(envelope.kind)}`)
  }
  if (!SHA256.test(envelope.resultDigest)) {
    throw new EvidenceStoreError(
      'EVIDENCE_INVALID',
      'the evidence resultDigest must be a sha256 digest of the form sha256:<64 lowercase hex>',
    )
  }
  const integrityDigest = envelope.integrity?.digest
  if (typeof integrityDigest !== 'string' || !SHA256.test(integrityDigest)) {
    throw new EvidenceStoreError(
      'EVIDENCE_INVALID',
      'the evidence integrity digest must be a sha256 digest of the form sha256:<64 lowercase hex>',
    )
  }
}

/**
 * Real PostgreSQL evidence archive (C4, C3.1).
 *
 * The envelope is written as the exact canonical JSON the gateway produced, and the
 * extracted columns are only an index. Every statement runs as the non-owner
 * `ontology_app` role with the trusted scope set via `SET LOCAL`, so RLS applies to the
 * whole call and a lookup in another tenant/space returns nothing.
 */
export class PostgresEvidenceStore implements EvidenceStorePort {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async record(
    scopeRef: ScopeRef,
    envelope: EvidenceEnvelope,
    ctx: ToolContext,
  ): Promise<EvidenceRecord> {
    const scope = resolveScope(scopeRef, ctx)
    validateEnvelope(envelope)
    if (
      envelope.scopeRef.tenantId !== scope.tenantId ||
      envelope.scopeRef.spaceId !== scope.spaceId
    ) {
      throw new EvidenceStoreError(
        'SCOPE_MISMATCH',
        'the evidence envelope scope does not match the trusted scope',
      )
    }
    const envelopeDigest = envelope.integrity.digest

    return this.#database.withIdentityScope(scope, async (client) => {
      try {
        await client.query(
          `INSERT INTO agent_platform.evidence_records
             (tenant_id, space_id, evidence_id, kind, run_id, data_mode, result_digest,
              envelope_digest, payload_ref, source_snapshots, envelope, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz
           )
           ON CONFLICT (tenant_id, space_id, evidence_id) DO NOTHING`,
          [
            envelope.evidenceId,
            envelope.kind,
            envelope.producedBy.runId ?? null,
            envelope.dataMode,
            envelope.resultDigest,
            envelopeDigest,
            envelope.payloadRef === undefined ? null : JSON.stringify(envelope.payloadRef),
            JSON.stringify(envelope.sourceSnapshots),
            JSON.stringify(envelope),
            envelope.observedAt,
          ],
        )
      } catch (error) {
        throw new EvidenceStoreError(
          'EVIDENCE_PERSIST_FAILED',
          `could not persist evidence ${envelope.evidenceId}`,
          { cause: error },
        )
      }

      const stored = await client.query<EvidenceRow>(
        `SELECT ${EVIDENCE_COLUMNS}
           FROM agent_platform.evidence_records
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND evidence_id = $1`,
        [envelope.evidenceId],
      )
      const row = stored.rows[0]
      if (row === undefined) {
        throw new EvidenceStoreError(
          'EVIDENCE_PERSIST_FAILED',
          `evidence ${envelope.evidenceId} was not stored`,
        )
      }
      return toRecord(row)
    })
  }

  async get(
    scopeRef: ScopeRef,
    evidenceId: Uuid,
    ctx: ToolContext,
  ): Promise<EvidenceRecord | undefined> {
    const scope = resolveScope(scopeRef, ctx)
    return this.#database.withIdentityScope(
      scope,
      async (client) => {
        const result = await client.query<EvidenceRow>(
          `SELECT ${EVIDENCE_COLUMNS}
             FROM agent_platform.evidence_records
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND evidence_id = $1`,
          [evidenceId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toRecord(row)
      },
      { readOnly: true },
    )
  }

  async listByRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<EvidenceRecord[]> {
    const scope = resolveScope(scopeRef, ctx)
    return this.#database.withIdentityScope(
      scope,
      async (client) => {
        const result = await client.query<EvidenceRow>(
          `SELECT ${EVIDENCE_COLUMNS}
             FROM agent_platform.evidence_records
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND run_id = $1
            ORDER BY recorded_at ASC, evidence_id ASC`,
          [runId],
        )
        return result.rows.map(toRecord)
      },
      { readOnly: true },
    )
  }
}
