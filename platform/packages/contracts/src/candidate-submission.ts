import type {
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { CandidateSourceSpan } from './extraction'
import type { SourceTrustTier } from './source-grounding'
import type {
  CandidateEvidence,
  CandidateSubmissionKind,
  SubmitCandidatesReceipt,
} from './submit-candidates'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid } from './asset-workspace'

/**
 * The controlled candidate-submission support contracts (design §5/§7).
 *
 * These complete the write port in `submit-candidates.ts` with the two capabilities the service
 * cannot implement itself:
 *
 *  - **Evidence resolution** (`CandidateEvidencePort`): a candidate's evidence is only accepted
 *    when it resolves to material *this run* already obtained and may read back — a staged research
 *    archive or an authorized document — and the re-read bytes match the recorded digest. The model
 *    supplies a reference; the platform decides whether it is authorized and current.
 *  - **The idempotent record** (`CandidateSubmissionStore`): the command receipt and the
 *    candidate↔source links are persisted together under the host idempotency key, so a crash
 *    between "candidate written" and "checkpoint saved" replays the same receipt instead of writing
 *    a second candidate, and a later source review can re-ground exactly the candidates that cited
 *    the source.
 *
 * Everything here is data or a port: no database, HTTP or industry type appears.
 */

/** One evidence item resolved against the material this run is authorized to read. */
export interface ResolvedCandidateEvidence {
  /** The index of the evidence item inside its submission's `evidence` array. */
  readonly index: number
  /** The readable reference the candidate is actually grounded in. */
  readonly sourceRef: ResourceRef
  /** The located span, when the evidence is a located span. */
  readonly sourceSpan?: CandidateSourceSpan
  readonly parserVersion: Semver
  readonly contentDigest: Sha256Digest
  /** The provenance tier the server assigns; the model never supplies this. */
  readonly trustTier: SourceTrustTier
  /** The origin page address for a web page evidence; absent for a located span. */
  readonly url?: string
  /** True when the archived bytes were re-read and their digest matched the recorded digest. */
  readonly reReadVerified: boolean
}

export interface CandidateEvidenceResolutionRequest {
  readonly workspaceId: Uuid
  readonly runId: Uuid
  readonly evidence: readonly CandidateEvidence[]
}

/**
 * Resolve one submission's evidence against the run's authorized material. It must reject (never
 * silently drop) evidence this execution never obtained or whose digest no longer matches, so an
 * ungrounded or forged reference cannot reach a write.
 */
export interface CandidateEvidencePort {
  resolve(
    request: CandidateEvidenceResolutionRequest,
    ctx: ToolContext,
  ): Promise<readonly ResolvedCandidateEvidence[]>
}

/** Re-reads the archived bytes of one evidence reference so the service can verify its digest. */
export interface CandidateEvidenceContentPort {
  read(ref: ResourceRef, ctx: ToolContext): Promise<{ readonly bytes: Uint8Array; readonly contentDigest: Sha256Digest }>
}

/**
 * The durable association between one persisted candidate and one source it cited. A candidate may
 * have several links (one per evidence item), and a source may back several candidates, so a source
 * review can find exactly the candidates that must be re-grounded.
 */
export interface CandidateSourceLink {
  readonly candidateId: Uuid
  readonly candidateKind: CandidateSubmissionKind
  readonly submissionIndex: number
  readonly evidenceIndex: number
  readonly sourceRef: ResourceRef
  readonly sourceSpan?: CandidateSourceSpan
  readonly trustTier: SourceTrustTier
  readonly parserVersion: Semver
  /** True while the link's source is not yet confirmed, so the candidate stays pending. */
  readonly pendingConfirmation: boolean
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** The persisted receipt of one accepted `submit_candidates` command, with its candidate↔source links. */
export interface CandidateSubmissionRecord {
  readonly schemaVersion: 'candidate-submission-record@1'
  readonly runId: Uuid
  readonly workspaceId: Uuid
  readonly idempotencyKey: string
  readonly commandDigest: Sha256Digest
  readonly receipt: SubmitCandidatesReceipt
  readonly links: readonly CandidateSourceLink[]
  readonly createdBy: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * Control persistence for candidate-submission receipts and their candidate↔source links. Every
 * method runs in the trusted tenant/space scope and RLS is a second layer behind the explicit scope
 * predicate. `record` is idempotent on `(scope, runId, idempotencyKey)`: replaying a key returns the
 * stored record instead of writing a second one.
 */
export interface CandidateSubmissionStore {
  findByKey(
    scopeRef: ScopeRef,
    input: { readonly runId: Uuid; readonly idempotencyKey: string },
    ctx: ToolContext,
  ): Promise<CandidateSubmissionRecord | undefined>
  record(
    scopeRef: ScopeRef,
    input: { readonly record: CandidateSubmissionRecord },
    ctx: ToolContext,
  ): Promise<{ readonly record: CandidateSubmissionRecord; readonly replayed: boolean }>
  /** The links that pin a candidate to its sources; used to re-ground after a source review. */
  listLinksForCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSourceLink[]>
  /** Workspace candidates that still cite an unconfirmed source, so a review can find them. */
  listUnconfirmedByWorkspace?(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSubmissionRecord[]>
  /**
   * Every candidate-submission receipt a run produced, in recorded order (design §8: 持久候选回执).
   * The run-completion projection reads this instead of an in-memory list, so a resumed or
   * restarted run still reports the candidates it actually wrote.
   */
  listByRun?(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly CandidateSubmissionRecord[]>
}

export type CandidateSubmissionStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STORE_FAILED'

export class CandidateSubmissionStoreError extends Error {
  readonly code: CandidateSubmissionStoreErrorCode

  constructor(code: CandidateSubmissionStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CandidateSubmissionStoreError'
    this.code = code
  }
}

/**
 * The re-grounding command (design §7). It is issued after a source a candidate cited is reviewed
 * and admitted; it re-reads the now-approved source and appends a new candidate version that keeps
 * the original content but drops the block, rather than editing the earlier candidate in place.
 */
export interface RegroundCandidateCommand {
  readonly schemaVersion: 'reground-candidate@1'
  readonly workspaceId: Uuid
  readonly candidateId: Uuid
  /** The candidate revision the caller read; a mismatch is a version conflict. */
  readonly expectedContentDigest: Sha256Digest
  readonly idempotencyKey: NonEmptyString
}

export interface RegroundCandidateReceipt {
  readonly workspaceId: Uuid
  readonly candidateId: Uuid
  readonly newCandidateId: Uuid
  readonly sourceRefs: readonly ResourceRef[]
  /** False when an earlier idempotent re-ground returned the stored new version. */
  readonly replayed: boolean
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function assertCandidateSourceLinkShape(value: unknown): asserts value is CandidateSourceLink {
  if (!isRecord(value) || !isUuid(value['candidateId'])
    || typeof value['candidateKind'] !== 'string'
    || !Number.isSafeInteger(value['submissionIndex']) || !Number.isSafeInteger(value['evidenceIndex'])
    || !isResourceRef(value['sourceRef'])
    || (value['sourceSpan'] !== undefined && !isRecord(value['sourceSpan']))
    || typeof value['trustTier'] !== 'string'
    || typeof value['parserVersion'] !== 'string' || !SEMVER_PATTERN.test(value['parserVersion'])
    || typeof value['pendingConfirmation'] !== 'boolean'
    || !isNonEmptyString(value['recordedAt'])) {
    throw new CandidateSubmissionStoreError('STORE_FAILED', 'invalid candidate source link')
  }
}

export function assertCandidateSubmissionRecordShape(value: unknown): asserts value is CandidateSubmissionRecord {
  if (!isRecord(value) || value['schemaVersion'] !== 'candidate-submission-record@1'
    || !isUuid(value['runId']) || !isUuid(value['workspaceId'])
    || !isNonEmptyString(value['idempotencyKey'])
    || typeof value['commandDigest'] !== 'string' || !SHA256_PATTERN.test(value['commandDigest'])
    || !isRecord(value['receipt'])
    || !Array.isArray(value['links']) || !value['links'].every((link) => isRecord(link)
      && isUuid(link['candidateId']) && typeof link['trustTier'] === 'string')
    || !isNonEmptyString(value['createdBy']) || !isNonEmptyString(value['recordedAt'])) {
    throw new CandidateSubmissionStoreError('STORE_FAILED', 'invalid candidate submission record')
  }
}

/** The receipt record shape is validated by the store; this keeps the digest helper in one place. */
export function isCandidateSubmissionRecord(value: unknown): value is CandidateSubmissionRecord {
  try {
    assertCandidateSubmissionRecordShape(value)
    return true
  } catch {
    return false
  }
}
