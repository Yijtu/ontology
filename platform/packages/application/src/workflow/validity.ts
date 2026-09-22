import type {
  PublicationBlockReason,
  PublicationValidityPort,
  PublicationValidityReport,
  PublicationValidityRequest,
  Rfc3339UtcTimestamp,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

/**
 * Deterministic post-verification validity double (D7.4). It models the three invalidation
 * cases the publication gate must honour and keeps them distinct:
 *
 * - `revokePermission` / `retractEvidence` / `markUnverifiable` block publication outright;
 * - `markStale` permits only an explicitly history-limited (as-of) publication.
 *
 * It is a test/local-composition double, not a permissive fake: a triggered block is never
 * reported as publishable.
 */
export class InMemoryPublicationValidity implements PublicationValidityPort {
  readonly #revoked = new Map<Uuid, string>()
  readonly #retracted = new Map<Uuid, string>()
  readonly #unverifiable = new Map<Uuid, string>()
  readonly #stale = new Map<Uuid, { readonly asOf: Rfc3339UtcTimestamp; readonly reason: string }>()

  revokePermission(runId: Uuid, reason = 'the publisher permission was revoked'): this {
    this.#revoked.set(runId, reason)
    return this
  }

  restorePermission(runId: Uuid): this {
    this.#revoked.delete(runId)
    return this
  }

  retractEvidence(evidenceId: Uuid, reason = 'the supporting evidence was retracted'): this {
    this.#retracted.set(evidenceId, reason)
    return this
  }

  markUnverifiable(evidenceId: Uuid, reason = 'the evidence artifact is unreadable'): this {
    this.#unverifiable.set(evidenceId, reason)
    return this
  }

  markStale(runId: Uuid, asOf: Rfc3339UtcTimestamp, reason = 'the source advanced after verification'): this {
    this.#stale.set(runId, { asOf, reason })
    return this
  }

  check(request: PublicationValidityRequest, ctx: ToolContext): Promise<PublicationValidityReport> {
    void ctx
    const blockedReasons: PublicationBlockReason[] = []
    const details: string[] = []

    const revoked = this.#revoked.get(request.runId)
    if (revoked !== undefined) {
      blockedReasons.push('permission_revoked')
      details.push(revoked)
    }
    for (const ref of request.evidenceRefs) {
      const retracted = this.#retracted.get(ref.id)
      if (retracted !== undefined) {
        blockedReasons.push('evidence_retracted')
        details.push(`evidence ${ref.id}: ${retracted}`)
      }
      const unverifiable = this.#unverifiable.get(ref.id)
      if (unverifiable !== undefined) {
        blockedReasons.push('evidence_unverifiable')
        details.push(`evidence ${ref.id}: ${unverifiable}`)
      }
    }
    const stale = this.#stale.get(request.runId)
    if (stale !== undefined) {
      blockedReasons.push('data_stale')
      details.push(stale.reason)
    }

    const unique = [...new Set(blockedReasons)]
    const historyLimited = unique.length > 0 && unique.every((reason) => reason === 'data_stale')
    return Promise.resolve({
      publishable: unique.length === 0,
      blockedReasons: unique,
      historyLimited,
      ...(historyLimited && stale !== undefined ? { asOf: stale.asOf } : {}),
      details,
    })
  }
}
