import type {
  ConsistencyLevel,
  DataMode,
  EvidenceDependencyDirection,
  EvidenceDependencyRelation,
  EvidenceKind,
  EvidenceProducer,
  OpaqueCursor,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  SchemaVersion,
  ScopeRef,
  Sha256Digest,
  SourceRef,
  SourceWatermark,
  ToolCoverage,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { PublishedStatementStatus } from './semantic-publication'

/**
 * On-demand provenance, history and controlled-detail read contracts (SPEC C3.1/C6, D3/D5,
 * US-017/US-022, FR-19/FR-20/FR-30).
 *
 * These are *read-side* shapes shared by the provenance service, the semantic-engine read
 * views and the HTTP host. They keep three distinctions explicit:
 *
 *  - **Re-readability of the original source.** C3.1: a `repeatable_read` snapshot is only
 *    consistent inside the transaction that produced it, so an evidence item must say whether
 *    the original source can be re-read or whether only a bounded archived snapshot survives.
 *  - **Real evidence dependencies vs. schema/type relations.** The only dependency edges a
 *    caller sees are the recorded evidence lineage and the compact rule support DAG. A
 *    schema-level relation between concepts is a different graph and is never returned as an
 *    evidence dependency.
 *  - **Explicit truncation.** A bounded dependency traversal that stops early sets
 *    `coverage.truncated`, so a caller can never conclude completeness or non-existence from a
 *    truncated page (SPEC §8/§9).
 */

/** Whether an evidence item could be resolved and its artifacts verified. */
export type ProvenanceReadOutcome = 'verifiable' | 'unverifiable'

/**
 * Whether the *original* source can be re-read. `archived_snapshot_only` means the original
 * cannot be guaranteed re-readable and only a bounded archived result survives; `unverifiable`
 * means neither the original nor a durable snapshot is available.
 */
export type SourceReReadability = 're_readable' | 'archived_snapshot_only' | 'unverifiable'

/** One source snapshot with its re-readability resolved against the artifact store. */
export interface ProvenanceSourceView {
  readonly sourceRef: SourceRef
  readonly schemaVersion: SchemaVersion
  readonly readAt: Rfc3339UtcTimestamp
  readonly asOf?: Rfc3339UtcTimestamp
  readonly watermark?: SourceWatermark
  readonly consistency: ConsistencyLevel
  readonly resultDigest: Sha256Digest
  readonly archivedResultRef?: ResourceRef
  readonly reReadability: SourceReReadability
  readonly reason?: string
}

/**
 * What produced an evidence-dependency edge. `support` is the compact rule support DAG
 * (LOCAL-032); `lineage` is the recorded evidence-to-evidence lineage. A schema/type relation
 * is neither, so it can never be returned as an evidence dependency.
 */
export type EvidenceDependencyOrigin = 'support' | 'lineage'

/** One directed evidence-to-evidence dependency edge. */
export interface EvidenceDependencyEdge {
  readonly fromEvidenceId: Uuid
  readonly toEvidenceId: Uuid
  readonly relation: EvidenceDependencyRelation
  readonly origin: EvidenceDependencyOrigin
  readonly premiseGroup?: string
}

/**
 * Whether rule-support edges were resolved for one evidence record. This is deliberately
 * separate from `ProvenanceReadOutcome`, which only describes evidence/artifact integrity.
 */
export type EvidenceDependencySupportState =
  | 'not_rule'
  | 'resolved'
  | 'not_applicable'
  | 'unknown'
  | 'conflict'
  | 'ambiguous'
  | 'unavailable'
  | 'incomplete'

/** Source-side result. `complete` is optional for structural compatibility with older readers. */
export interface EvidenceDependencySupportReadStatus {
  readonly state: EvidenceDependencySupportState
  readonly complete?: boolean
  readonly reason?: string
}

/** Detailed dependency result optionally supplied by a capable dependency source. */
export interface EvidenceDependencyReadResult {
  readonly edges: readonly EvidenceDependencyEdge[]
  readonly supportResolution: EvidenceDependencySupportReadStatus
}

/** Normalized status returned by the provenance service; completeness is always explicit. */
export interface ProvenanceSupportResolution {
  readonly state: EvidenceDependencySupportState
  readonly complete: boolean
  readonly reason?: string
}

/** Support-resolution coverage for one evidence node in a dependency traversal. */
export interface DependencySupportResolutionEntry {
  readonly evidenceId: Uuid
  readonly resolution: ProvenanceSupportResolution
}

/** Aggregate support coverage, independent of node/page truncation. */
export interface DependencySupportCoverage {
  readonly complete: boolean
  readonly resolutions: readonly DependencySupportResolutionEntry[]
}

/** `ToolCoverage` plus explicit rule-support resolution coverage. */
export interface DependencyGraphCoverage extends ToolCoverage {
  readonly support?: DependencySupportCoverage
}

/** One AND premise group of a rule justification, resolved to the evidence that satisfies it. */
export interface ProvenancePremiseGroupView {
  readonly groupId: string
  readonly alternativeEvidenceIds: readonly Uuid[]
}

/** The authorized, on-demand provenance of one evidence item (C6 `GET /evidence/{id}`). */
export interface ProvenanceEvidenceView {
  readonly evidenceId: Uuid
  readonly outcome: ProvenanceReadOutcome
  readonly reason?: string
  readonly kind: EvidenceKind
  readonly dataMode: DataMode
  readonly scopeRef: ScopeRef
  readonly producedBy: EvidenceProducer
  readonly observedAt: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly revision: RevisionString
  readonly resultDigest: Sha256Digest
  readonly integrityVerified: boolean
  /** The rule(s) this evidence was derived from; empty for a direct observation. */
  readonly ruleRefs: readonly VersionRef[]
  /** Whether rule-support edges were proven; independent of evidence/artifact `outcome`. */
  readonly supportResolution?: ProvenanceSupportResolution
  /** The AND premise groups of the real support DAG, resolved to supporting evidence ids. */
  readonly premiseGroups: readonly ProvenancePremiseGroupView[]
  readonly sources: readonly ProvenanceSourceView[]
  /** The archived result artifact, verified on read; absent when the evidence has none. */
  readonly archivedResult?: { readonly ref: ResourceRef; readonly verified: boolean }
  /** `true` only when every source is re-readable or has a verified archived snapshot. */
  readonly originalSourceReReadable: boolean
  readonly dependencies: readonly EvidenceDependencyEdge[]
  readonly asOf?: Rfc3339UtcTimestamp
  readonly validAt?: Rfc3339UtcTimestamp
}

/** `GET /evidence/{id}` query parameters. */
export interface EvidenceReadQuery {
  readonly asOf?: Rfc3339UtcTimestamp
  readonly validAt?: Rfc3339UtcTimestamp
}

/** One bounded dependency-traversal request (C6 `GET /evidence/{id}/dependencies`). */
export interface DependencyTraversalRequest {
  readonly direction: EvidenceDependencyDirection
  /** Requested hop count; the service clamps it to its configured ceiling. */
  readonly depth: number
  readonly cursor?: OpaqueCursor
  /** Requested page size; the service clamps it to its configured ceiling. */
  readonly limit?: number
}

export interface DependencyNodeView {
  readonly evidenceId: Uuid
  readonly depth: number
  readonly outcome: ProvenanceReadOutcome
  readonly kind?: EvidenceKind
}

/** The bounded dependency graph page. `coverage.truncated` marks an incomplete traversal. */
export interface DependencyGraphView {
  readonly rootEvidenceId: Uuid
  readonly direction: EvidenceDependencyDirection
  readonly depth: number
  readonly nodes: readonly DependencyNodeView[]
  readonly edges: readonly EvidenceDependencyEdge[]
  readonly coverage: DependencyGraphCoverage
}

/** One bounded historical-assertion page (C6 `GET /objects/{id}/history`). */
export interface ObjectHistoryQuery {
  readonly recordedAt?: Rfc3339UtcTimestamp
  readonly validAt?: Rfc3339UtcTimestamp
  readonly cursor?: OpaqueCursor
  readonly limit?: number
}

/**
 * One immutable assertion version. `version` is the statement version; `revisionKind` is
 * present when the version came from a correction/retraction record, so the caller can see the
 * history that the current projection must not erase.
 */
export interface HistoricalAssertionView {
  readonly statementId: Uuid
  readonly propositionKey: string
  readonly predicate: string
  readonly kind: 'entity' | 'relation'
  readonly objectId?: string
  readonly relationId?: string
  readonly subjectEntityId?: string
  readonly version: RevisionString
  readonly status: PublishedStatementStatus
  readonly value: Readonly<Record<string, unknown>>
  readonly unitCode?: string
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly revisionKind?: 'correction' | 'retraction'
  readonly revisionReason?: string
  readonly supersedesVersion?: RevisionString
  readonly sourceRefs: readonly ResourceRef[]
}

export interface ObjectHistoryView {
  readonly objectId: string
  readonly recordedAt?: Rfc3339UtcTimestamp
  readonly validAt?: Rfc3339UtcTimestamp
  readonly assertions: readonly HistoricalAssertionView[]
  readonly coverage: ToolCoverage
}

/**
 * A controlled evidence export. It carries the authorized provenance view and the verified
 * artifact bytes, so a corrupt/missing artifact yields an `unverifiable` outcome and no bytes
 * instead of a silent partial export (C3.1/§8).
 */
export interface EvidenceExportView {
  readonly view: ProvenanceEvidenceView
  readonly artifacts: readonly EvidenceExportArtifact[]
}

export interface EvidenceExportArtifact {
  readonly ref: ResourceRef
  readonly mediaType: string
  readonly byteSize: number
  readonly contentDigest: Sha256Digest
  readonly contentBase64: string
}
