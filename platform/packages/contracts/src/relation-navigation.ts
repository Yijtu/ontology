import type { ResourceRef, RevisionString, Rfc3339UtcTimestamp, VersionRef } from './generated/contracts'

/**
 * Bounded, published-relation entity navigation (SPEC v0.3a execution-evidence EX-4.3,
 * issue V03-027 / #195; A.US-008.AC-02, A.FR-14).
 *
 * Navigation walks ACTUAL published relation statements (`PublishedStatement(kind=relation)`)
 * between confirmed entities. It is deliberately separate from:
 *
 *  - a physical data-table JOIN (a `data_query` mapping concern), and
 *  - an evidence-dependency graph (a provenance concern):
 * neither is ever surfaced as an entity relation edge.
 *
 * A traversal is bounded in every dimension (depth ≤ `MAX_RELATION_NAVIGATION_HOPS`, fan-out,
 * visited entities, scanned statements and returned paths). A bound that is hit makes the
 * result `partial`/`unknown` with an explicit gap; it never silently claims a complete or
 * unique answer. A relation that changed, an endpoint whose identity is stale, a mismatched
 * definition or a refused cycle is reported as an explicit gap instead of being dropped.
 */

/** The maximum number of relation hops one traversal may follow (frozen by SPEC EX-4.3). */
export const MAX_RELATION_NAVIGATION_HOPS = 3

/**
 * How much of the requested traversal the read actually covered.
 * `complete` means every bound held and the result is the full confirmed path set.
 */
export type RelationNavigationCompleteness = 'complete' | 'partial' | 'unknown'

/**
 * One confirmed published relation edge on a path. It pins the statement version, the
 * publication and its schema definition so a later reader can detect drift instead of
 * trusting a mutable head.
 */
export interface RelationNavigationHop {
  readonly statementId: string
  readonly statementVersion: RevisionString
  readonly publicationId: string
  readonly relationId: string
  /** The pinned definition version the relation statement was published against. */
  readonly definitionRef: VersionRef
  readonly fromEntityId: string
  readonly toEntityId: string
  readonly fromCandidateId: string
  readonly toCandidateId: string
  readonly sourceRefs: readonly ResourceRef[]
}

/** One start→end traversal: the ordered list of confirmed relation edges it followed. */
export interface RelationNavigationPath {
  readonly startEntityId: string
  readonly endEntityId: string
  readonly hops: readonly RelationNavigationHop[]
}

export interface RelationNavigationRequest {
  readonly startEntityId: string
  /** Exact ordered relation ids from a published definition; at most three hops. */
  readonly relationIds: readonly string[]
  readonly validAt: Rfc3339UtcTimestamp
  /** Per-hop cap on returned paths; bounded by the navigator's own maximum. */
  readonly maxPaths?: number
  readonly signal?: AbortSignal
}

/**
 * The result of one bounded traversal. `visitedEntityIds` and `relationVersionIds` are the
 * exact entities/statements that were read and grounded, so a caller can attribute the answer
 * without re-reading. `gaps` is non-empty whenever any bound, staleness or mismatch was hit.
 */
export interface RelationNavigationResult {
  readonly startEntityId: string
  readonly paths: readonly RelationNavigationPath[]
  readonly visitedEntityIds: readonly string[]
  /** `statementId@version` for every relation edge that participated in the result. */
  readonly relationVersionIds: readonly string[]
  readonly completeness: RelationNavigationCompleteness
  readonly gaps: readonly string[]
  readonly scannedStatements: number
  readonly publicationRevision: RevisionString
}

export type RelationNavigationErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'DEADLINE_EXCEEDED'
  | 'START_ENTITY_NOT_FOUND'

export class RelationNavigationError extends Error {
  readonly code: RelationNavigationErrorCode

  constructor(code: RelationNavigationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RelationNavigationError'
    this.code = code
  }
}

export function isRelationNavigationError(value: unknown): value is RelationNavigationError {
  return value instanceof RelationNavigationError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Runtime guard for a navigation request at the service boundary. A request is only valid with
 * a non-empty start entity, 1–`MAX_RELATION_NAVIGATION_HOPS` non-empty relation ids and a UTC
 * `validAt`; anything else is refused before any read.
 */
export function isRelationNavigationRequest(value: unknown): value is RelationNavigationRequest {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['startEntityId'])) return false
  const relationIds = value['relationIds']
  if (!Array.isArray(relationIds)) return false
  if (relationIds.length < 1 || relationIds.length > MAX_RELATION_NAVIGATION_HOPS) return false
  if (!relationIds.every(isNonEmptyString)) return false
  if (typeof value['validAt'] !== 'string' || !/Z$/u.test(value['validAt'])) return false
  if (!Number.isFinite(Date.parse(value['validAt']))) return false
  const maxPaths = value['maxPaths']
  if (maxPaths !== undefined && (typeof maxPaths !== 'number' || !Number.isSafeInteger(maxPaths) || maxPaths < 1)) {
    return false
  }
  return true
}
