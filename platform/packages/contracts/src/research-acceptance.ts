import type { ScopeRef, Uuid } from './generated/contracts'
import type { ToolContext } from './trusted'
import { isUuid } from './asset-workspace'

/**
 * Which engine accepted a research request (design §10, S10/S11 follow-up).
 *
 * `agentic` is the V2 workspace-research run; `legacy` is the retained fixed-chain facade, kept only
 * so an already-accepted `@1` request can still be read, cancelled and resumed. A new request is
 * always admitted to `agentic`.
 */
export type ResearchAcceptanceEngine = 'agentic' | 'legacy'

/**
 * One durable acceptance record. It exists so engine ownership is a **recorded fact**, not something
 * inferred from "an `@1` projection happens to exist": two concurrent submissions of one request
 * resolve to exactly one row, and a reader can always tell which engine owns a run.
 */
export interface ResearchAcceptanceRecord {
  readonly researchId: Uuid
  readonly runId?: Uuid
  readonly engine: ResearchAcceptanceEngine
  readonly requestDigest: string
  readonly idempotencyKey: string
  readonly acceptedAt: string
}

export type ResearchAcceptanceJournalErrorCode =
  | 'SCOPE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STORE_FAILED'

export class ResearchAcceptanceJournalError extends Error {
  readonly code: ResearchAcceptanceJournalErrorCode

  constructor(code: ResearchAcceptanceJournalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResearchAcceptanceJournalError'
    this.code = code
  }
}

/**
 * Persistence for the research acceptance journal.
 *
 * `record` is a write-once claim on `(tenant, space, research_id)`: the first caller inserts, and a
 * later caller with the same request digest reads the stored row back. A different digest for the
 * same research id is `IDEMPOTENCY_CONFLICT` — never an overwrite, and never a second engine.
 */
export interface ResearchAcceptanceJournal {
  record(scopeRef: ScopeRef, record: ResearchAcceptanceRecord, ctx: ToolContext): Promise<{ readonly record: ResearchAcceptanceRecord; readonly created: boolean }>
  get(scopeRef: ScopeRef, researchId: Uuid, ctx: ToolContext): Promise<ResearchAcceptanceRecord | undefined>
  findByIdempotencyKey(scopeRef: ScopeRef, idempotencyKey: string, ctx: ToolContext): Promise<ResearchAcceptanceRecord | undefined>
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

export function assertResearchAcceptanceRecordShape(value: unknown): asserts value is ResearchAcceptanceRecord {
  if (typeof value !== 'object' || value === null) {
    throw new ResearchAcceptanceJournalError('STORE_FAILED', 'a stored research acceptance record is malformed')
  }
  const record = value as Record<string, unknown>
  if (!isUuid(record['researchId'])
    || (record['runId'] !== undefined && !isUuid(record['runId']))
    || (record['engine'] !== 'agentic' && record['engine'] !== 'legacy')
    || typeof record['requestDigest'] !== 'string' || !SHA256_PATTERN.test(record['requestDigest'])
    || typeof record['idempotencyKey'] !== 'string'
    || typeof record['acceptedAt'] !== 'string') {
    throw new ResearchAcceptanceJournalError('STORE_FAILED', 'a stored research acceptance record is malformed')
  }
  if ((record['engine'] === 'legacy') !== (record['runId'] === undefined)) {
    throw new ResearchAcceptanceJournalError('STORE_FAILED', 'a research acceptance record has an inconsistent run link')
  }
}
