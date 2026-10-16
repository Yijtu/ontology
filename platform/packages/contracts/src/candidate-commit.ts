import type {
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type {
  AssetCandidateBatch,
  AssetCandidateInsertGuard,
  AssetCandidateInsertResult,
  AssetCandidateVersion,
} from './asset-candidates'
import type { CandidateSource, CandidateSourceRecord } from './candidate-source'
import type { CandidateSubmissionRecord } from './candidate-submission'
import type { ActionCandidateVersion, RuleCandidateVersion } from './rule-action-candidates'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isSha256Digest, isUuid } from './asset-workspace'

/**
 * The atomic candidate-commit boundary (design §5/§7, node S08).
 *
 * A `submit_candidates` command must never leave a candidate that has no receipt, and must never
 * write a candidate after the run was cancelled or after this worker lost its durable lease. The
 * service therefore does all of its domain validation in memory and then commits through a **narrow
 * atomic port**: one PostgreSQL transaction that re-checks the run cancel state, the durable
 * dispatch owner/attempt fence, the authorization admission, the frozen draft revision and the
 * candidate quota, and only then writes the candidate, its source links and the idempotent receipt.
 *
 * The candidate itself is built by the existing domain logic (`buildDefinitionCandidate`,
 * `saveRuleCandidate`, `ingestArchivedWebSnapshot`, …); this port only changes *where the write
 * lands*, never what is validated.
 */

/** The exact durable dispatch ownership a worker must still hold to commit a candidate. */
export interface CandidateDispatchFence {
  readonly dispatchId: Uuid
  readonly ownerId: Uuid
  /** The dispatch attempt the worker holds; a reclaim bumps it, so a stale worker is refused. */
  readonly attempt: RevisionString
}

/**
 * The run's frozen binding: the single workspace and pinned draft revision/digest the run was
 * admitted against. The submit path resolves the target workspace and the fixed draft from here,
 * never from the model's command and never from "the latest draft".
 */
export interface CandidateRunBinding {
  readonly runId: Uuid
  readonly workspaceId: Uuid
  readonly draftRevision: RevisionString
  readonly draftDigest: Sha256Digest
  readonly documentSetRef: ResourceRef
}

/**
 * Resolve a run's frozen research binding from its durable admission. A run that is not an admitted
 * research run (or whose admission is no longer readable) resolves to `undefined`, and the submit
 * path refuses the command instead of falling back to a model-chosen workspace.
 */
export interface CandidateRunBindingPort {
  resolve(scopeRef: ScopeRef, runId: Uuid, ctx: ToolContext): Promise<CandidateRunBinding | undefined>
}

/**
 * One write performed inside the atomic commit transaction. The service builds the rows with the
 * existing domain logic and hands them here; the adapter writes them on the transaction's own
 * connection, so a later failure rolls all of them back together.
 */
export interface CandidateCommitTransaction {
  insertDefinitionBatch(
    batch: AssetCandidateBatch,
    candidates: readonly AssetCandidateVersion[],
    guard?: AssetCandidateInsertGuard,
  ): Promise<AssetCandidateInsertResult>
  putSource(input: { readonly source: CandidateSource; readonly idempotencyKey: string }): Promise<CandidateSourceRecord>
  insertRuleCandidate(candidate: RuleCandidateVersion): Promise<RuleCandidateVersion>
  insertActionCandidate(candidate: ActionCandidateVersion): Promise<ActionCandidateVersion>
  record(record: CandidateSubmissionRecord): Promise<{ readonly record: CandidateSubmissionRecord; readonly replayed: boolean }>
}

/** The fence/authorization the atomic commit re-checks before it writes anything. */
export interface CandidateCommitRequest {
  readonly runId: Uuid
  readonly idempotencyKey: string
  readonly commandDigest: Sha256Digest
  readonly binding: CandidateRunBinding
  /** Absent only for a trusted host-only commit; a worker commit must carry its live lease. */
  readonly fence?: CandidateDispatchFence
  /** The run's one shared ledger and the candidate reservation made just before the commit. */
  readonly ledgerId?: Uuid
  readonly reservationId?: Uuid
}

export interface CandidateCommitResult {
  readonly record: CandidateSubmissionRecord
  readonly replayed: boolean
}

/**
 * The atomic commit port. `commit` opens one transaction, re-checks the fence conditions, invokes
 * `run` with transaction-scoped write helpers, and commits — so the candidate, its links and the
 * receipt are all-or-nothing. A replay of an already-committed key returns the stored receipt
 * without re-running `run`.
 */
export interface CandidateCommitPort {
  commit(
    scopeRef: ScopeRef,
    request: CandidateCommitRequest,
    ctx: ToolContext,
    run: (tx: CandidateCommitTransaction) => Promise<CandidateSubmissionRecord>,
  ): Promise<CandidateCommitResult>
}

export type CandidateCommitErrorCode =
  | 'SCOPE_MISMATCH'
  | 'RUN_CANCELLED'
  | 'LEASE_LOST'
  | 'AUTHORIZATION_REVOKED'
  | 'DRAFT_CHANGED'
  | 'BUDGET_EXHAUSTED'
  | 'STORE_FAILED'

export class CandidateCommitError extends Error {
  readonly code: CandidateCommitErrorCode

  constructor(code: CandidateCommitErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CandidateCommitError'
    this.code = code
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

/** Runtime validation of a candidate run binding resolved from the admission. */
export function assertCandidateRunBindingShape(value: unknown): asserts value is CandidateRunBinding {
  if (
    !isRecord(value) ||
    !isUuid(value['runId']) ||
    !isUuid(value['workspaceId']) ||
    typeof value['draftRevision'] !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(value['draftRevision']) ||
    !isSha256Digest(value['draftDigest']) ||
    !isResourceRef(value['documentSetRef'])
  ) {
    throw new CandidateCommitError('STORE_FAILED', 'a resolved candidate run binding is malformed')
  }
}

/** Runtime validation of a persisted commit-fence row before it is trusted. */
export function assertCandidateCommitFenceShape(value: unknown): asserts value is {
  runId: Uuid
  workspaceId: Uuid
  draftRevision: RevisionString
  draftDigest: Sha256Digest
  recordedAt: Rfc3339UtcTimestamp
} {
  if (
    !isRecord(value) ||
    !isUuid(value['runId']) ||
    !isUuid(value['workspaceId']) ||
    typeof value['draftRevision'] !== 'string' ||
    typeof value['draftDigest'] !== 'string' ||
    !SHA256_PATTERN.test(value['draftDigest'])
  ) {
    throw new CandidateCommitError('STORE_FAILED', 'a stored candidate commit fence is malformed')
  }
}
