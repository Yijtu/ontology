import type {
  EvidenceEnvelope,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Durable evidence archive (C4, C3.1, D7).
 *
 * Every tool execution archives the exact `EvidenceEnvelope` it observed before a
 * traceable success can be returned. The record is immutable and tenant/space scoped,
 * and its `evidenceRef` is the `kind: 'evidence'` reference the gateway settles onto the
 * budget reservation. The port lives next to `ProfileStore`/`RunStore` so an adapter can
 * implement it while depending on `contracts` alone (SPEC §2: adapters → contracts);
 * the service layer receives it by construction injection and never imports a driver.
 */
export interface EvidenceRecord {
  readonly evidenceRef: ResourceRef
  readonly envelope: EvidenceEnvelope
  /**
   * Canonical digest of the archived envelope. It is the same value as
   * `envelope.integrity.digest`, so the evidence reference and the integrity proof
   * cannot drift.
   */
  readonly envelopeDigest: Sha256Digest
  readonly revision: RevisionString
  readonly recordedAt: Rfc3339UtcTimestamp
}

export type EvidenceStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_PERSIST_FAILED'
  | 'EVIDENCE_NOT_FOUND'

export class EvidenceStoreError extends Error {
  readonly code: EvidenceStoreErrorCode

  constructor(code: EvidenceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EvidenceStoreError'
    this.code = code
  }
}

/**
 * Control persistence for evidence. `record` is append-only: an already recorded
 * envelope is returned unchanged instead of overwritten, so a retry of the same
 * execution cannot rewrite history.
 */
export interface EvidenceStorePort {
  record(scopeRef: ScopeRef, envelope: EvidenceEnvelope, ctx: ToolContext): Promise<EvidenceRecord>
  get(scopeRef: ScopeRef, evidenceId: Uuid, ctx: ToolContext): Promise<EvidenceRecord | undefined>
  listByRun(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<EvidenceRecord[]>
}
