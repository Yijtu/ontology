import type {
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { PublicationKind, PublishedAnswer } from './workflow'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isSha256Digest, isUuid } from './asset-workspace'

/**
 * Result revision history (SPEC v0.3a execution-evidence §EX-8, asset-data-ui §9.2,
 * issue V03-041 / #214, A.US-014.AC-01 / A.FR-21).
 *
 * Each published answer is immutable and pinned to one run. A change to the inputs,
 * definitions, mapping, functions or data produces a new project revision and therefore a new
 * run with a new answer; the older answer keeps the body/table/evidence hashes it was verified
 * with and is never rewritten. The history view lists those versions newest-first so a reader
 * can read an older revision back.
 *
 * Two read kinds are always labelled apart:
 *
 *  - `fixed_version` — reading the exact version this run published (a readback of one
 *    immutable artifact set); and
 *  - `history` — reading an older revision's archived result.
 *
 * A history readback is not a recompute. A fixed-version recompute creates a new run pinned to
 * the original refs and, when the original sources cannot be rebuilt, refuses instead of
 * pretending the readback was a recompute.
 */
export const RESULT_HISTORY_SCHEMA_VERSION = 'result-history@1'

/** How a reader is reading one result revision. */
export type ResultReadKind = 'fixed_version' | 'history'

/** One immutable published result version in a project's result history. */
export interface ResultRevisionSummary {
  readonly answerId: Uuid
  readonly runId: Uuid
  /** 1-based position, newest first, inside the returned history. */
  readonly revisionIndex: number
  readonly contentHash: Sha256Digest
  readonly evidenceManifestHash: Sha256Digest
  readonly scenarioManifestHash: Sha256Digest
  readonly publicationKind: PublicationKind
  readonly publishedAt: Rfc3339UtcTimestamp
  readonly resultManifestRef?: ResourceRef
  readonly resultManifestDigest?: Sha256Digest
  readonly readKind: ResultReadKind
  /** Explicit, user-facing label; the read kind is never only implied by a styling choice. */
  readonly label: string
}

/** The ordered result history of one logical key (a project or a single run). */
export interface ResultHistoryView {
  readonly schemaVersion: 'result-history@1'
  /** The stable grouping key: the project id when known, otherwise the run id. */
  readonly logicalKey: string
  readonly projectId?: Uuid
  readonly projectRevision?: RevisionString
  /** The answer the caller asked about; present in `entries`. */
  readonly currentAnswerId: Uuid
  /** Newest first. */
  readonly entries: readonly ResultRevisionSummary[]
}

function isResourceRefOrUndefined(value: unknown): value is ResourceRef | undefined {
  return value === undefined || isResourceRef(value)
}

/** Runtime guard for a history view read at the wire boundary. */
export function isResultHistoryView(value: unknown): value is ResultHistoryView {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== RESULT_HISTORY_SCHEMA_VERSION) return false
  if (typeof value['logicalKey'] !== 'string' || value['logicalKey'].length === 0) return false
  if (value['projectId'] !== undefined && !isUuid(value['projectId'])) return false
  if (value['projectRevision'] !== undefined && typeof value['projectRevision'] !== 'string') return false
  if (!isUuid(value['currentAnswerId'])) return false
  if (!Array.isArray(value['entries'])) return false
  return value['entries'].every((entry) => {
    if (!isRecord(entry)) return false
    return (
      isUuid(entry['answerId']) &&
      isUuid(entry['runId']) &&
      typeof entry['revisionIndex'] === 'number' &&
      isSha256Digest(entry['contentHash']) &&
      isSha256Digest(entry['evidenceManifestHash']) &&
      isSha256Digest(entry['scenarioManifestHash']) &&
      (entry['publicationKind'] === 'verified' || entry['publicationKind'] === 'history_limited') &&
      typeof entry['publishedAt'] === 'string' &&
      isResourceRefOrUndefined(entry['resultManifestRef']) &&
      (entry['resultManifestDigest'] === undefined || isSha256Digest(entry['resultManifestDigest'])) &&
      (entry['readKind'] === 'fixed_version' || entry['readKind'] === 'history') &&
      typeof entry['label'] === 'string'
    )
  })
}

/**
 * One published answer as it appears in a project's result history. `projectId` is resolved by
 * the server from the run's archived execution binding; it is never client-supplied.
 */
export interface AnswerRevisionRecord {
  readonly answer: PublishedAnswer
  readonly projectId: Uuid
  readonly projectRevision?: RevisionString
}

/**
 * The durable, scope-checked source of a project's result history. The adapter resolves the
 * project linkage from the trusted run/execution-binding tables; the service never groups
 * answers by a caller-provided value.
 */
export interface ResultHistoryPort {
  listByProject(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<readonly AnswerRevisionRecord[]>
}
