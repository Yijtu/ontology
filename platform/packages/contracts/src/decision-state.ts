import type { ResourceRef, Rfc3339UtcTimestamp, ScopeRef, Sha256Digest, Uuid } from './generated/contracts'
import type { ToolContext } from './trusted'

/** A state artifact is readable by JEV only after the host registers its exact run/profile binding. */
export interface DecisionStateReferenceRecord {
  readonly runId: Uuid
  readonly resolvedProfileHash: Sha256Digest
  readonly stateRef: ResourceRef
  readonly registeredAt: Rfc3339UtcTimestamp
}

export type DecisionStateReferenceStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'PROFILE_MISMATCH'
  | 'INVALID_REFERENCE'
  | 'STATE_REFERENCE_CONFLICT'
  | 'STATE_REFERENCE_STORE_FAILED'

export class DecisionStateReferenceStoreError extends Error {
  readonly code: DecisionStateReferenceStoreErrorCode

  constructor(code: DecisionStateReferenceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DecisionStateReferenceStoreError'
    this.code = code
  }
}

/** Durable authorization index for immutable model state. It never stores state bytes. */
export interface DecisionStateReferenceStore {
  register(
    scopeRef: ScopeRef,
    record: DecisionStateReferenceRecord,
    ctx: ToolContext,
  ): Promise<DecisionStateReferenceRecord>
  isApproved(
    scopeRef: ScopeRef,
    input: {
      readonly runId: Uuid
      readonly resolvedProfileHash: Sha256Digest
      readonly stateRef: ResourceRef
    },
    ctx: ToolContext,
  ): Promise<boolean>
}
