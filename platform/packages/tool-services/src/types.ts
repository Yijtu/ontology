import { sha256DigestOf } from '@ontology/core'
import type {
  ConsistencyLevel,
  DataMode,
  DomainResultStatus,
  EvidenceKind,
  OperationRegistry,
  Rfc3339UtcTimestamp,
  ResourceRef,
  ResultLimits,
  ResolvedProfile,
  SourceRef,
  SourceSnapshot,
  SourceWatermark,
  ToolCoverage,
  ToolDefinition,
  ToolId,
  ToolUsage,
  ToolWarning,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

/**
 * Result-schema validation capability (C1: boundary data is validated by a runtime
 * schema, never by a TypeScript assertion alone).
 *
 * The gateway receives this by injection: `@ontology/tool-services` is a service layer
 * and does not import a JSON Schema library. The composition root supplies an
 * implementation built from the canonical published schema bundle.
 */
export interface SchemaValidationIssue {
  /** RFC 6901 JSON Pointer into the rejected value. */
  readonly pointer: string
  readonly reason: string
}

export interface SchemaValidationResult {
  readonly valid: boolean
  readonly issues: readonly SchemaValidationIssue[]
}

export interface ToolSchemaValidator {
  /** Validate against a schema addressed by its canonical `$ref`. */
  validateRef(ref: string, value: unknown): SchemaValidationResult
  /** Validate against an inline schema document (a registered operation's input schema). */
  validateInline(schema: Readonly<Record<string, unknown>>, value: unknown): SchemaValidationResult
}

/**
 * What a handler observed at one source. The gateway fills `readAt` and the archived
 * result reference; the handler states the exact schema version, consistency and
 * (when available) watermark it read. C3.1: a `repeatable_read` is only consistent
 * inside the originating transaction and is never advertised as a permanent version.
 */
export interface ToolSourceObservation {
  readonly sourceRef: SourceRef
  readonly schemaVersion: string
  readonly asOf?: Rfc3339UtcTimestamp
  readonly watermark?: SourceWatermark
  readonly consistency: ConsistencyLevel
  readonly resultDigest?: string
}

/**
 * The bounded, already-authorized request a handler receives. It carries the trusted
 * context (identity, deadline, approved resources) and never a store, a driver or a
 * filesystem handle: a handler reaches its backend through its own injected port.
 */
export interface ToolExecutionRequest {
  readonly callId: Uuid
  readonly toolId: ToolId
  readonly arguments: Readonly<Record<string, unknown>>
  readonly resultLimits: ResultLimits
  /** The propagated child deadline (min of the run ledger and the tool limit). */
  readonly deadline: Rfc3339UtcTimestamp
  readonly traceId: string
  readonly signal: AbortSignal
}

/**
 * A handler's successful outcome. `status` is one of the three success statuses; an
 * execution failure is raised as a `ToolGatewayError`, never collapsed into `empty`.
 * `empty` means the query succeeded and matched nothing (C6.2); `partial` means the
 * recall range was truncated and must carry `coverage.truncated === true`.
 */
export interface ToolExecutionOutcome {
  readonly payload: unknown
  readonly status: 'ok' | 'partial' | 'empty'
  readonly coverage: ToolCoverage
  readonly sources: readonly ToolSourceObservation[]
  readonly warnings?: readonly ToolWarning[]
  readonly domainStatus?: DomainResultStatus
  readonly usage?: Partial<ToolUsage>
  readonly dataMode?: DataMode
  readonly evidenceKind?: EvidenceKind
}

/**
 * A registered tool implementation. There is no `code`/script field anywhere: a
 * handler is bound to a `toolId` at composition time and cannot be selected by model
 * input. Implementations must honour `request.signal` and raise a classified
 * `ToolGatewayError` for a domain/backend failure.
 */
export interface ToolHandler {
  readonly toolId: ToolId
  execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome>
}

/** Everything the gateway needs about one run's enabled tools and operations. */
export interface RunToolBinding {
  readonly runId: Uuid
  readonly ledgerId: Uuid
  readonly resolvedProfile: ResolvedProfile
  readonly operations: OperationRegistry
}

/** A resolved tool definition plus its profile binding, kept for gating evidence. */
export interface EnabledTool {
  readonly definition: ToolDefinition
  readonly binding: { readonly enabled: boolean; readonly maxCallsPerRun?: number }
}

/**
 * Stable JSON with sorted object keys, so a digest of the same schema is reproducible
 * regardless of property order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

export function digestOfSchema(schema: Readonly<Record<string, unknown>>): string {
  return sha256DigestOf(canonicalJson(schema))
}

/** The output schema reference a `ToolResult` reports. */
export function toolSchemaRef(definition: ToolDefinition): VersionRef {
  return {
    id: `${definition.toolId}.output`,
    version: definition.version,
    digest: digestOfSchema(definition.outputSchema),
  }
}

/** A convenience for building a `SourceSnapshot` from an observation. */
export function snapshotFrom(
  observation: ToolSourceObservation,
  readAt: Rfc3339UtcTimestamp,
  resultDigest: string,
  archivedResultRef: ResourceRef | undefined,
): SourceSnapshot {
  return {
    sourceRef: observation.sourceRef,
    schemaVersion: observation.schemaVersion,
    readAt,
    ...(observation.asOf === undefined ? {} : { asOf: observation.asOf }),
    ...(observation.watermark === undefined ? {} : { watermark: observation.watermark }),
    consistency: observation.consistency,
    resultDigest: observation.resultDigest ?? resultDigest,
    ...(archivedResultRef === undefined ? {} : { archivedResultRef }),
  }
}
