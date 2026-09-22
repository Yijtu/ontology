import type {
  DependencyGraphView,
  DependencyTraversalRequest,
  EvidenceDependencyDirection,
  EvidenceReadQuery,
  HistoricalAssertionView,
  ObjectHistoryQuery,
  ObjectHistoryView,
} from '@ontology/contracts'

/**
 * Wire shapes for the C6 provenance/history surface (SPEC C6, C3.1, C4; US-017/US-022).
 *
 * The browser only ever renders what these server projections carry. There is deliberately no
 * "model reasoning" field: the evidence view exposes the real rule / premise group / source
 * snapshot locator, and a conclusion is expanded from that data — never from an invented
 * chain-of-thought. The read-only types are re-exported from `@ontology/contracts` (a shared
 * contracts package, not a server implementation) so the UI cannot drift from the contract.
 */
export type {
  DependencyGraphView,
  DependencyNodeView,
  DependencyTraversalRequest,
  EvidenceDependencyDirection,
  EvidenceDependencyEdge,
  EvidenceReadQuery,
  HistoricalAssertionView,
  ObjectHistoryQuery,
  ObjectHistoryView,
  ProvenanceEvidenceView,
  ProvenancePremiseGroupView,
  ProvenanceSourceView,
  SourceReReadability,
} from '@ontology/contracts'

/**
 * One dependency page plus the opaque cursor for the next page. `nextCursor` comes from the
 * response envelope `meta.nextCursor`, and `graph.coverage.truncated` says whether the
 * traversal stopped early — a truncated page must never be read as completeness.
 */
export interface DependencyPage {
  readonly graph: DependencyGraphView
  readonly nextCursor: string | undefined
}

/** One history page plus its next cursor; `coverage.truncated` marks an incomplete page. */
export interface HistoryPage {
  readonly view: ObjectHistoryView
  readonly nextCursor: string | undefined
}

/** Build the query string for `GET /evidence/{id}/dependencies`. */
export function dependencyQuery(traversal: DependencyTraversalRequest): string {
  const query = new URLSearchParams({
    direction: traversal.direction,
    depth: String(traversal.depth),
  })
  if (traversal.cursor !== undefined) query.set('cursor', traversal.cursor)
  if (traversal.limit !== undefined) query.set('limit', String(traversal.limit))
  return query.toString()
}

/** Build the query string for `GET /evidence/{id}` or `GET /objects/{id}/history`. */
export function optionalTimeQuery(query: EvidenceReadQuery | ObjectHistoryQuery): string {
  const params = new URLSearchParams()
  if ('asOf' in query && query.asOf !== undefined) params.set('asOf', query.asOf)
  if (query.validAt !== undefined) params.set('validAt', query.validAt)
  if ('recordedAt' in query && query.recordedAt !== undefined) params.set('recordedAt', query.recordedAt)
  if ('cursor' in query && query.cursor !== undefined) params.set('cursor', query.cursor)
  if ('limit' in query && query.limit !== undefined) params.set('limit', String(query.limit))
  const suffix = params.toString()
  return suffix.length === 0 ? '' : `?${suffix}`
}

/** A stable fingerprint of the assertion-version set, used to detect a version change. */
export function historyFingerprint(view: ObjectHistoryView): string {
  return view.assertions
    .map((assertion) => `${assertion.statementId}:${assertion.version}:${assertion.status}`)
    .sort()
    .join('|')
}

export type { HistoricalAssertionView as AssertionVersion }
export type { EvidenceDependencyDirection as DependencyDirection }
