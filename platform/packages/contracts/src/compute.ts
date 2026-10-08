import type {
  CapabilityLimits,
  ConsistencyLevel,
  DataMode,
  DataQueryOutput,
  DomainResultStatus,
  OperationRef,
  ResourceRef,
  Rfc3339UtcTimestamp,
  SourceRef,
  SourceWatermark,
  Sha256Digest,
  ToolCoverage,
  ToolWarning,
} from './generated/contracts'
import type { ImmutableArtifactWriter, ScopedArtifactReader } from './ports'
import type { ToolContext } from './trusted'

/**
 * C3/ADR-11: the contract an industry compute extension implements so the generic
 * `data_query.kind=compute` path can dispatch to it without the tool service importing the
 * industry package.
 *
 * The handler receives a bounded, already-authorized execution:
 *   - typed `parameters`, validated against the registered operation schema by the gateway;
 *   - read-only `inputRefs`, reachable only through a `ScopedArtifactReader` bound to exactly
 *     those refs — never a filesystem or database credential;
 *   - the declared operation `limits` (CPU/rows/bytes) and the propagated child deadline;
 *   - an `ImmutableArtifactWriter` so it may archive a bounded result artifact.
 *
 * There is no `code`/script field: the handler is bound to a registered operation id at
 * composition time and can never be selected by model input.
 */
export interface ComputeSourceObservation {
  readonly sourceRef: SourceRef
  readonly schemaVersion: string
  readonly asOf?: Rfc3339UtcTimestamp
  readonly watermark?: SourceWatermark
  readonly consistency: ConsistencyLevel
  readonly resultDigest?: string
}

export interface ComputeOperationRequest {
  readonly operationRef: OperationRef
  readonly parameters: Readonly<Record<string, unknown>>
  readonly inputRefs: readonly ResourceRef[]
  readonly readInput: ScopedArtifactReader
  readonly artifacts: ImmutableArtifactWriter
  readonly limits: CapabilityLimits
  readonly deadline: Rfc3339UtcTimestamp
  readonly ctx: ToolContext
  readonly signal: AbortSignal
}

export interface ComputeOperationResult {
  /** A `DataQueryOutput` whose `resultKind` is `computation`. */
  readonly payload: DataQueryOutput
  readonly status: 'ok' | 'partial' | 'empty'
  readonly coverage: ToolCoverage
  readonly sources: readonly ComputeSourceObservation[]
  readonly warnings?: readonly ToolWarning[]
  readonly domainStatus?: DomainResultStatus
  readonly dataMode: DataMode
  readonly evidenceKind: 'computation'
}

export interface ComputeOperationHandler {
  readonly operationRef: OperationRef
  /** Trusted host pin for an actual closed build artifact. Required by registered task execution. */
  readonly artifact?: {
    readonly handlerDigest: Sha256Digest
    /** Recheck the finite artifact before execution or replay; absence/inconsistency fails closed. */
    assertIntegrity(): void
  }
  execute(request: ComputeOperationRequest): Promise<ComputeOperationResult>
}

/** Stable key for a versioned operation id, shared by the registry, profile and dispatcher. */
export function computeOperationKey(ref: OperationRef): string {
  return `${ref.id}@${ref.version}`
}
