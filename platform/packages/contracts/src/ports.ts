import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPutImmutableRequest,
  BlobPutImmutableResponse,
  BudgetRemaining,
  BudgetReservationRef,
  CancelRequest,
  CancelResponse,
  Capability,
  CatalogDescribeRequest,
  CatalogDescribeResponse,
  CatalogListRequest,
  CatalogListResponse,
  ComponentManifest,
  ComputeDescribeOperationRequest,
  ComputeDescribeOperationResponse,
  ComputeExecuteRequest,
  ComputeExecuteResponse,
  ControlAppendEventRequest,
  ControlAppendEventResponse,
  ControlReadProjectionRequest,
  ControlTransactionRequest,
  DecisionRequest,
  DecisionResult,
  DocumentSearchRequest,
  DocumentSearchResponse,
  ForecastReadRequest,
  ForecastReadResponse,
  GenerationEvent,
  GenerationRequest,
  NonEmptyString,
  ProjectionState,
  ReadSpanRequest,
  ReadSpanResponse,
  ResumeInput,
  RuntimeCancelReceipt,
  RuntimeCheckpointRef,
  RuntimeEvent,
  RuntimeInput,
  ScopedArtifactReaderRequest,
  ScopeRef,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  TelemetryReadCurrentRequest,
  TelemetryReadCurrentResponse,
  TelemetryReadSeriesRequest,
  TelemetryReadSeriesResponse,
  ToolCall,
  ToolResult,
  ToolUsage,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * C2/C3 port contracts. These are type-only interfaces: this package contains no
 * adapters, services or persistence. Every method takes the trusted ToolContext,
 * which the host injects and the model can never supply.
 */
export interface RuntimeAdapter {
  readonly manifest: ComponentManifest
  start(input: RuntimeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent>
  resume(input: ResumeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent>
  cancel(runId: string, reason: string): Promise<RuntimeCancelReceipt>
}

/**
 * Host-injected restricted closure. It is built in process from real adapters and is
 * never deserialized from model-serializable parameters.
 *
 * `ctx` is the host-minted trusted tool context. Every port method takes it, and it
 * cannot be produced by JSON.parse of model output, so it belongs to the injected
 * closure rather than to `RuntimeInput`. It is not one of the six C2 capability ports;
 * it is the server-established identity/scope/deadline the runtime passes through.
 */
export interface RuntimeDependencies {
  readonly ctx: ToolContext
  readonly gateway: ToolGateway
  readonly generation: GenerationPort
  readonly decision: DecisionPort
  readonly checkpoints: RuntimeCheckpointPort
  readonly budget: BudgetPort
  readonly signal: AbortSignal
}

export interface RuntimeCheckpointPort {
  save(
    runId: string,
    state: RuntimeCheckpointRef,
    payload: Uint8Array,
    ctx: ToolContext,
  ): Promise<RuntimeCheckpointRef>
  load(runId: string, checkpointRef: RuntimeCheckpointRef, ctx: ToolContext): Promise<Uint8Array>
}

export interface BudgetReservationRequest {
  readonly toolCalls: number
  readonly bytes: number
  readonly modelTokens?: number
}

export interface BudgetPort {
  reserve(
    runId: string,
    request: BudgetReservationRequest,
    ctx: ToolContext,
  ): Promise<BudgetReservationRef>
  settle(reservation: BudgetReservationRef, usage: ToolUsage, ctx: ToolContext): Promise<void>
  remaining(runId: string, ctx: ToolContext): Promise<BudgetRemaining>
}

/**
 * ADR-04: every tool path goes through this gateway. The gateway validates the call,
 * atomically reserves budget, records intent, executes, persists evidence/result and
 * settles. No transport, SDK or model call may bypass it.
 */
export interface ToolGateway {
  invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult>
  cancel(callId: string, reason: string, ctx: ToolContext): Promise<CancelResponse>
}

/**
 * ADR-09: generation streams candidates and proposed tool calls. It never executes a
 * tool, and its final natural-language output is only a candidate draft (INV-09).
 */
export interface GenerationPort {
  generate(request: GenerationRequest, ctx: ToolContext): AsyncIterable<GenerationEvent>
}

/**
 * ADR-09: decision answers fixed choice/score/noul questions and returns a preserved
 * option set, distribution, confidence and definition version. It is a different port
 * from GenerationPort and cannot be mocked or replaced by it.
 */
export interface DecisionPort {
  decide(request: DecisionRequest, ctx: ToolContext): Promise<DecisionResult>
}

export interface CatalogPort {
  describe(request: CatalogDescribeRequest, ctx: ToolContext): Promise<CatalogDescribeResponse>
  listResources(request: CatalogListRequest, ctx: ToolContext): Promise<CatalogListResponse>
}

export interface StructuredQueryPort {
  validate(
    request: StructuredQueryValidateRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryValidateResponse>
  execute(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryExecuteResponse>
  cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse>
}

export interface DocumentSearchPort {
  search(request: DocumentSearchRequest, ctx: ToolContext): Promise<DocumentSearchResponse>
  readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse>
}

export interface TelemetryPort {
  readSeries(
    request: TelemetryReadSeriesRequest,
    ctx: ToolContext,
  ): Promise<TelemetryReadSeriesResponse>
  readCurrent(
    request: TelemetryReadCurrentRequest,
    ctx: ToolContext,
  ): Promise<TelemetryReadCurrentResponse>
}

/**
 * C3/E1 forecast port. It is separate from `TelemetryPort` because a forecast is not an
 * observation: it is issued at a time, targets a future window and comes from a model or a
 * declared scenario, so it must be marked and versioned as such (INV-10).
 *
 * `readForecast` takes an `asOf` bound and must never return a forecast issued after it, so a
 * snapshot taken at `T` cannot be given future information. The result carries the issue time,
 * the validity window, the model version and an honest `SourceSnapshot`; the energy normaliser
 * re-checks the issue time as defence in depth.
 *
 * `capability` is the same declared capability/limits shape preflight resolves, so a run that
 * requires forecast support can be checked before it starts. When no backend is configured the
 * capability is absent and the caller reports `not_configured` rather than inventing a forecast.
 */
export interface ForecastPort {
  readonly capability: Capability
  readForecast(request: ForecastReadRequest, ctx: ToolContext): Promise<ForecastReadResponse>
}

export interface BlobPort {
  putImmutable(
    request: BlobPutImmutableRequest,
    ctx: ToolContext,
  ): Promise<BlobPutImmutableResponse>
  getAuthorized(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<BlobGetAuthorizedResponse>
}

/**
 * C3: ComputePort never opens a database connection. The service layer resolves the
 * source bindings, then hands the handler bounded immutable snapshot refs.
 */
export interface ComputePort {
  describeOperation(
    request: ComputeDescribeOperationRequest,
    ctx: ToolContext,
  ): Promise<ComputeDescribeOperationResponse>
  execute(request: ComputeExecuteRequest, ctx: ToolContext): Promise<ComputeExecuteResponse>
  cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse>
}

export interface ScopedArtifactReader {
  read(request: ScopedArtifactReaderRequest, ctx: ToolContext): Promise<Uint8Array>
}

/**
 * Write side of the immutable artifact store (ADR-08, C3.1).
 *
 * `BlobPort.putImmutable` only declares an already-staged digest, so a service that
 * must archive bounded result bytes (a tool result, an evidence payload) needs a port
 * that accepts the content. The adapter stages, verifies and publishes in that order
 * and derives the object key from the content digest, so a retry of the same bytes is
 * idempotent. The service receives this capability by injection and never a driver,
 * a connection string or a filesystem handle.
 */
export interface ArtifactWriteRequest {
  readonly scopeRef: ScopeRef
  readonly content: Uint8Array
  readonly mediaType: NonEmptyString
  readonly tenantAuthorizedRef?: NonEmptyString
}

export interface ImmutableArtifactWriter {
  putBytes(request: ArtifactWriteRequest, ctx: ToolContext): Promise<BlobPutImmutableResponse>
}

/**
 * C3: control persistence is its own port and is never merged with
 * StructuredQueryPort.
 */
export interface ControlRepository {
  transaction(request: ControlTransactionRequest, ctx: ToolContext): Promise<void>
  readProjection(
    request: ControlReadProjectionRequest,
    ctx: ToolContext,
  ): Promise<ProjectionState>
  appendEvent(
    request: ControlAppendEventRequest,
    ctx: ToolContext,
  ): Promise<ControlAppendEventResponse>
  /** Optional bounded append for up to 64 events in one trusted scope and stream. */
  appendEvents?(
    requests: readonly ControlAppendEventRequest[],
    ctx: ToolContext,
  ): Promise<readonly ControlAppendEventResponse[]>
}
