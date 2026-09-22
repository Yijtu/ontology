import type {
  DocumentChunkRecord,
  JobStageCounts,
  ResourceRef,
  ScopeRef,
  Semver,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

/**
 * The structured ingestion reference an extraction job carries in its `documentRef`.
 *
 * The durable job record stores only string references, so the pipeline pins the exact
 * parse, parser version and published definition version here. The reference is JSON and
 * validated field by field on decode (never trusted as a type assertion), because the job
 * body crosses the wire boundary.
 */
export interface ExtractionJobRef {
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly definitionRef: VersionRef
  readonly documentVersionRef?: ResourceRef
  /** Chunk ids the parser could not capture completely (D4.1/D4.3). */
  readonly truncatedChunkIds?: readonly Uuid[]
}

/** Everything one extraction or validation stage needs, resolved from the job and parse. */
export interface ExtractionInput {
  readonly jobId: Uuid
  readonly parseId: Uuid
  readonly parserVersion: Semver
  readonly pipelineVersion: Semver
  readonly definitionRef: VersionRef
  readonly documentVersionRef?: ResourceRef
  readonly chunks: readonly DocumentChunkRecord[]
  readonly truncatedChunkIds: readonly Uuid[]
}

/** Trusted, host-injected run context: the background ledger, scope and cancellation. */
export interface ExtractionRunContext {
  readonly ledgerId: Uuid
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}

export interface ExtractionResult {
  readonly candidateIds: readonly Uuid[]
  readonly counts: JobStageCounts
  /** Generation calls made by this stage. A deterministic-only run is zero (US-012.A2). */
  readonly modelCalls: number
  readonly deterministicCandidates: number
}

export interface ValidationResult {
  readonly counts: JobStageCounts
  readonly pendingReview: number
  readonly failed: number
}

export type { ScopeRef }
