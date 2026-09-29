import {
  BudgetLedgerError,
  CONTROLLER_SERVICE_IDS,
  ERROR_CATALOG,
  isToolContext,
  TOOL_CATALOGUE,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  BudgetDenialCode,
  BudgetLedgerPort,
  BudgetReservationRecord,
  CancelResponse,
  ErrorCode,
  EvidenceEnvelope,
  EvidenceKind,
  EvidenceStorePort,
  ImmutableArtifactWriter,
  PlatformError,
  ResourceRef,
  ResultLimits,
  ScopeRef,
  SourceSnapshot,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolGateway,
  ToolResult,
  ToolUsage,
  VersionRef,
} from '@ontology/contracts'
import { assertCatalogueExcludesControllerServices, findEnabledTool, resolveComputeOperation } from './catalogue'
import {
  assertBoundedArguments,
  assertNoMaliciousKeys,
  assertRequestedLimit,
  assertTrustedEnvelope,
  estimatedReservationRows,
  isRecord,
} from './envelope'
import { ToolGatewayError, toPlatformError } from './errors'
import type { ToolGatewayErrorCode } from './errors'
import { canonicalJson, snapshotFrom, toolSchemaRef } from './types'
import type { RunToolBinding, ToolExecutionOutcome, ToolHandler, ToolSchemaValidator } from './types'

/** Model-visible inline payload cap; larger results are reachable only through `dataRef`. */
export const INLINE_RESULT_BYTES = 32_768

const GATEWAY_VERSION = '1.0.0'

const EVIDENCE_KIND_BY_TOOL: Readonly<Record<string, EvidenceKind>> = {
  ontology_lookup: 'observation',
  data_query: 'observation',
  document_search: 'document_span',
  web_search: 'web_page',
}

const DENIAL_CODES: readonly string[] = [
  'BUDGET_EXHAUSTED',
  'DEADLINE_EXCEEDED',
  'RATE_LIMITED',
  'NO_PROGRESS',
] satisfies readonly BudgetDenialCode[]

export interface ToolGatewayDependencies {
  /** Canonical result-schema validation, injected by the composition root. */
  readonly validator: ToolSchemaValidator
  /** The run's single shared budget ledger (LOCAL-010). Never a second mechanism. */
  readonly budget: BudgetLedgerPort
  /** Durable evidence archive. A success is returned only after it is written. */
  readonly evidence: EvidenceStorePort
  /** Immutable artifact writer for the bounded result payload. */
  readonly artifacts: ImmutableArtifactWriter
  readonly handlers: readonly ToolHandler[]
  /** The canonical catalogue; overridable only for tests. */
  readonly catalogue?: readonly ToolDefinition[]
  readonly now?: () => string
  readonly newId?: () => string
  readonly gatewayRef?: VersionRef
}

const DEFAULT_GATEWAY_REF: VersionRef = {
  id: 'tool-gateway',
  version: GATEWAY_VERSION,
  digest: sha256DigestOf('tool-gateway@1.0.0'),
}

const CANCEL_CONFIRM_TIMEOUT_MS = 5_000

interface InFlightCall {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
}

function createInFlightCall(): InFlightCall {
  const controller = new AbortController()
  let resolveSettled: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  return { controller, settled, resolveSettled }
}

function denialCode(value: string): ErrorCode | undefined {
  return DENIAL_CODES.includes(value) ? (value as ErrorCode) : undefined
}

interface ClassifiedPortFailure {
  readonly code: ErrorCode
  readonly remoteStateUnknown: boolean
}

/**
 * Recognise a port/adapter failure that already carries a canonical `ErrorCode` and map
 * it faithfully on the tool path (C6.2).
 *
 * The gateway is the single classification point, so a backend error cannot be silently
 * downgraded to `INTERNAL_ERROR` just because the handler did not re-wrap it. The code
 * must be a published catalogue entry; an unrecognised code is left to the caller's
 * fallback. `remoteStateUnknown` is preserved from the error, and the catalogue's own
 * `recordsRemoteStateUnknown` flag (e.g. `DEADLINE_EXCEEDED`) is honoured too, so a
 * timed-out/cancelled read still settles as `usage_unknown`.
 *
 * The document_search index-state codes travel this path unchanged (LOCAL-063):
 * `INDEX_NOT_FOUND` (no active index, never retryable) and `SNAPSHOT_UNAVAILABLE`
 * (a pinned generation is gone, never retryable) stay distinct from the retryable
 * `SOURCE_UNAVAILABLE` a store read failure raises.
 */
function classifyPortFailure(error: unknown): ClassifiedPortFailure | undefined {
  if (!(error instanceof Error)) return undefined
  const candidate = error as { code?: unknown; remoteStateUnknown?: unknown }
  if (typeof candidate.code !== 'string' || !Object.hasOwn(ERROR_CATALOG, candidate.code)) {
    return undefined
  }
  const code = candidate.code as ErrorCode
  return {
    code,
    remoteStateUnknown:
      candidate.remoteStateUnknown === true ||
      ERROR_CATALOG[code].recordsRemoteStateUnknown === true,
  }
}

function inlineDataOf(
  payload: unknown,
  byteSize: number,
): NonNullable<ToolResult['inlineData']> | undefined {
  if (byteSize > INLINE_RESULT_BYTES) return undefined
  if (Array.isArray(payload)) return payload
  if (isRecord(payload)) return Object.fromEntries(Object.entries(payload))
  return undefined
}

/**
 * The single execution path for every model-proposed tool call (ADR-04, C4).
 *
 * Fixed order, with no shortcut:
 *   1. resolve the call against the registered catalogue for the run's resolved profile
 *   2. validate the arguments against the tool's input schema
 *   3. atomically reserve budget
 *   4. persist the intent
 *   5. execute the registered handler
 *   6. archive the result artifact and persist the evidence envelope
 *   7. settle the reservation
 *
 * Step 6 gates the outcome: if the result or its evidence cannot be persisted the call
 * is settled as failed and an error result is returned, never an `ok`/`partial`/`empty`.
 */
export class ToolGatewayService implements ToolGateway {
  readonly #deps: ToolGatewayDependencies
  readonly #binding: RunToolBinding
  readonly #catalogue: readonly ToolDefinition[]
  readonly #handlers: ReadonlyMap<string, ToolHandler>
  readonly #now: () => string
  readonly #newId: () => string
  readonly #gatewayRef: VersionRef
  /** In-flight handler calls, so a run cancellation can interrupt the backend. */
  readonly #inFlight = new Map<string, InFlightCall>()

  constructor(deps: ToolGatewayDependencies, binding: RunToolBinding) {
    assertCatalogueExcludesControllerServices(deps.catalogue ?? TOOL_CATALOGUE)
    this.#deps = deps
    this.#binding = binding
    this.#catalogue = deps.catalogue ?? TOOL_CATALOGUE
    this.#handlers = new Map(deps.handlers.map((handler) => [handler.toolId, handler]))
    this.#now = deps.now ?? (() => new Date().toISOString())
    this.#newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
    this.#gatewayRef = deps.gatewayRef ?? DEFAULT_GATEWAY_REF
  }

  async invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now()
    const traceId = isToolContext(ctx) ? ctx.traceId : 'untrusted'
    try {
      const context = this.#assertTrustedContext(ctx)
      const definition = this.#assertCallable(call)
      const args = call.arguments
      if (!isRecord(args)) {
        throw new ToolGatewayError('INVALID_ARGUMENTS', 'tool arguments must be a JSON object')
      }
      assertNoMaliciousKeys(args)
      assertBoundedArguments(args)
      const ref = definition.inputSchema.$ref
      if (typeof ref !== 'string') {
        throw new ToolGatewayError('INVALID_ARGUMENTS', 'the tool input schema has no resolvable $ref')
      }
      const validation = this.#deps.validator.validateRef(ref, args)
      if (!validation.valid) {
        throw new ToolGatewayError(
          'INVALID_ARGUMENTS',
          'tool arguments do not match the tool input schema',
          {
            fieldErrors: validation.issues.map((issue) => ({
              pointer: issue.pointer === '' ? '/' : issue.pointer,
              reason: issue.reason,
            })),
          },
        )
      }
      assertTrustedEnvelope(args, context)
      assertRequestedLimit(args, definition.resultLimits)
      if (definition.toolId === 'data_query') {
        this.#assertComputeCall(args)
      }
      return await this.#execute(call, definition, args, context, startedAt)
    } catch (error) {
      return this.#errorResult(call, error, traceId, startedAt)
    }
  }

  /**
   * Cancel one in-flight tool call. The gateway owns the call's signal, so it aborts it
   * and waits briefly for the handler to unwind. This is best-effort notification (C5):
   * a backend that cannot confirm it stopped yields `cancelling`, and the run's late
   * output is quarantined as abandoned rather than revived. A call that already settled
   * is `already_terminal`.
   */
  async cancel(callId: string, reason: string, ctx: ToolContext): Promise<CancelResponse> {
    this.#assertTrustedContext(ctx)
    const acceptedAt = this.#now()
    const inFlight = this.#inFlight.get(callId)
    if (inFlight === undefined) {
      return { targetRef: callId, state: 'already_terminal', acceptedAt }
    }
    inFlight.controller.abort(reason)
    const settled = await this.#waitFor(inFlight.settled, CANCEL_CONFIRM_TIMEOUT_MS)
    return { targetRef: callId, state: settled ? 'cancelled' : 'cancelling', acceptedAt }
  }

  async #waitFor(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #assertTrustedContext(ctx: ToolContext): ToolContext {
    if (!isToolContext(ctx)) {
      throw new ToolGatewayError(
        'UNTRUSTED_CONTEXT',
        'a host-minted trusted tool context is required',
      )
    }
    if (ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
      throw new ToolGatewayError(
        'SCOPE_MISMATCH',
        'the trusted context carries inconsistent tenant scope',
      )
    }
    if (ctx.runId !== this.#binding.runId) {
      throw new ToolGatewayError(
        'SCOPE_MISMATCH',
        'the trusted context run does not match the run this gateway was bound to',
      )
    }
    return ctx
  }

  #assertCallable(call: ToolCall): ToolDefinition {
    if (typeof call.callId !== 'string' || call.callId.length === 0) {
      throw new ToolGatewayError('INVALID_CALL', 'a tool call requires a callId')
    }
    const controllerIds: readonly string[] = CONTROLLER_SERVICE_IDS
    if (controllerIds.includes(call.toolId)) {
      throw new ToolGatewayError(
        'CONTROLLER_SERVICE_NOT_CALLABLE',
        `${call.toolId} is a controller service and is not reachable through the tool gateway`,
      )
    }
    const canonical = this.#catalogue.find((definition) => definition.toolId === call.toolId)
    if (canonical === undefined) {
      throw new ToolGatewayError('UNKNOWN_TOOL', `${call.toolId} is not a registered tool`)
    }
    const enabled = findEnabledTool(this.#binding.resolvedProfile, call.toolId, this.#catalogue)
    if (enabled === undefined) {
      throw new ToolGatewayError(
        'TOOL_NOT_ENABLED',
        `${call.toolId} is not enabled by the run's resolved profile`,
      )
    }
    return enabled.definition
  }

  #assertComputeCall(args: Readonly<Record<string, unknown>>): void {
    if (args.kind !== 'compute') return
    resolveComputeOperation(
      args,
      this.#binding.resolvedProfile,
      this.#binding.operations,
      this.#deps.validator,
    )
  }

  async #execute(
    call: ToolCall,
    definition: ToolDefinition,
    args: Readonly<Record<string, unknown>>,
    ctx: ToolContext,
    startedAt: number,
  ): Promise<ToolResult> {
    const scopeRef = this.#scopeOf(ctx)
    const limits = definition.resultLimits
    const attempt = call.attempt ?? 1
    const now = this.#now()
    const deadline = this.#deadline(ctx, limits, now)

    // 3. atomic budget reservation (before any execution).
    const outcome = await this.#deps.budget.reserve(
      {
        ledgerId: this.#binding.ledgerId,
        idempotencyKey: `tool:${call.callId}:${String(attempt)}`,
        toolCalls: 1,
        parallel: true,
        rows: estimatedReservationRows(args, limits),
        requiresIntent: true,
        requestedDeadline: deadline,
      },
      ctx,
    )
    if (!outcome.granted || outcome.reservation === undefined) {
      const denial = outcome.denial
      throw new ToolGatewayError(
        'BUDGET_DENIED',
        denial?.message ?? 'the budget reservation was denied',
        { platformCode: denial === undefined ? 'BUDGET_EXHAUSTED' : denialCode(denial.code) ?? 'BUDGET_EXHAUSTED' },
      )
    }
    const reservation: BudgetReservationRecord = outcome.reservation

    // 4. intent, persisted before the handler runs.
    const argumentsDigest = sha256DigestOf(canonicalJson(args))
    try {
      await this.#deps.budget.recordIntent(
        {
          ledgerId: this.#binding.ledgerId,
          reservationId: reservation.reservationId,
          intentId: this.#newId(),
          descriptor: { callId: call.callId, toolId: definition.toolId, argumentsDigest, attempt },
        },
        ctx,
      )
    } catch (error) {
      await this.#settleFailed(reservation, ctx, startedAt)
      throw this.#classify(error, 'INTENT_NOT_RECORDED', 'the tool intent could not be persisted')
    }

    // 5. execute the registered handler under the propagated deadline and the run's
    // cancellation. The trusted context is injected here; a handler never captures it.
    const inFlight = createInFlightCall()
    const timer = setTimeout(() => inFlight.controller.abort(), this.#remainingMs(deadline))
    this.#inFlight.set(call.callId, inFlight)
    let result: ToolExecutionOutcome
    try {
      result = await this.#handlerFor(definition.toolId).execute({
        callId: call.callId,
        toolId: definition.toolId,
        arguments: args,
        resultLimits: limits,
        deadline,
        traceId: ctx.traceId,
        ctx,
        signal: inFlight.controller.signal,
      })
    } catch (error) {
      const classified = this.#classify(error, 'HANDLER_FAILED', 'the tool handler failed')
      // A timeout or dropped connection may already have been billed by the remote, so
      // the reservation is held as `usage_unknown` instead of released as a free failure.
      await this.#settleFailed(reservation, ctx, startedAt, classified.remoteStateUnknown)
      throw classified
    } finally {
      clearTimeout(timer)
      this.#inFlight.delete(call.callId)
      inFlight.resolveSettled()
    }
    if (inFlight.controller.signal.aborted) {
      await this.#settleFailed(reservation, ctx, startedAt, true)
      throw new ToolGatewayError('HANDLER_FAILED', 'the tool handler exceeded its deadline', {
        platformCode: 'DEADLINE_EXCEEDED',
        remoteStateUnknown: true,
      })
    }

    // 6. persist the result artifact and the evidence envelope before any success.
    let prepared: { readonly returned: number }
    try {
      prepared = this.#validateOutcome(result, limits)
    } catch (error) {
      await this.#settleFailed(reservation, ctx, startedAt)
      throw error
    }
    const payloadBytes = new TextEncoder().encode(canonicalJson(result.payload))
    if (payloadBytes.byteLength > limits.maxBytes) {
      await this.#settleFailed(reservation, ctx, startedAt)
      throw new ToolGatewayError(
        'LIMIT_EXCEEDED',
        `the result is ${String(payloadBytes.byteLength)} bytes and exceeds the ${String(limits.maxBytes)} byte ceiling`,
      )
    }
    const resultDigest = sha256DigestOf(canonicalJson(result.payload))
    let artifactRef: ResourceRef
    try {
      const archived = await this.#deps.artifacts.putBytes(
        { scopeRef, content: payloadBytes, mediaType: 'application/json' },
        ctx,
      )
      artifactRef = archived.blobRef
    } catch (error) {
      await this.#settleFailed(reservation, ctx, startedAt)
      throw new ToolGatewayError('EVIDENCE_PERSIST_FAILED', 'the tool result artifact could not be archived', {
        cause: error,
      })
    }

    const snapshots = result.sources.map((source) =>
      snapshotFrom(source, now, resultDigest, artifactRef),
    )
    const envelope = this.#evidenceEnvelope({
      definition,
      args,
      result,
      snapshots,
      artifactRef,
      resultDigest,
      scopeRef,
      ctx,
      now,
    })
    let evidenceRef: ResourceRef
    try {
      const recorded = await this.#deps.evidence.record(scopeRef, envelope, ctx)
      evidenceRef = recorded.evidenceRef
    } catch (error) {
      await this.#settleFailed(reservation, ctx, startedAt)
      throw new ToolGatewayError(
        'EVIDENCE_PERSIST_FAILED',
        'the tool evidence could not be persisted, so no traceable success can be returned',
        { cause: error },
      )
    }

    const durationMs = Date.now() - startedAt
    const usage: ToolUsage = {
      durationMs,
      rows: prepared.returned,
      bytes: payloadBytes.byteLength,
      calls: 1,
    }
    // 7. settle with the persisted evidence reference.
    try {
      await this.#deps.budget.settle(
        {
          ledgerId: this.#binding.ledgerId,
          reservationId: reservation.reservationId,
          status: 'completed',
          usage,
          evidenceRefs: [evidenceRef],
        },
        ctx,
      )
    } catch (error) {
      throw this.#classify(error, 'SETTLEMENT_FAILED', 'the tool call could not be settled')
    }

    const inline = inlineDataOf(result.payload, payloadBytes.byteLength)
    return {
      callId: call.callId,
      status: result.status,
      dataRef: artifactRef,
      ...(inline === undefined ? {} : { inlineData: inline }),
      schemaRef: toolSchemaRef(definition),
      evidenceRefs: [evidenceRef],
      sourceSnapshots: snapshots,
      coverage: result.coverage,
      usage,
      warnings: result.warnings === undefined ? [] : [...result.warnings],
      ...(result.domainStatus === undefined ? {} : { domainStatus: result.domainStatus }),
    }
  }

  #validateOutcome(
    result: ToolExecutionOutcome,
    limits: ResultLimits,
  ): { readonly returned: number } {
    const returned = result.coverage.returned
    if (!Number.isInteger(returned) || returned < 0) {
      throw new ToolGatewayError(
        'OUTCOME_INVALID',
        'coverage.returned must be a non-negative integer',
      )
    }
    if (result.status === 'partial' && result.coverage.truncated !== true) {
      throw new ToolGatewayError(
        'OUTCOME_INVALID',
        'a partial result must declare coverage.truncated === true',
      )
    }
    if (result.status === 'ok' && result.coverage.truncated === true) {
      throw new ToolGatewayError(
        'OUTCOME_INVALID',
        'a truncated result must be reported as partial, not ok',
      )
    }
    if (result.status === 'empty' && returned !== 0) {
      throw new ToolGatewayError('OUTCOME_INVALID', 'an empty result must have coverage.returned === 0')
    }
    if (returned > limits.maxRows) {
      throw new ToolGatewayError(
        'LIMIT_EXCEEDED',
        `the result returned ${String(returned)} rows and exceeds the ${String(limits.maxRows)} row ceiling`,
      )
    }
    if (result.sources.length === 0) {
      throw new ToolGatewayError(
        'OUTCOME_INVALID',
        'a successful tool result must record at least one source snapshot',
      )
    }
    return { returned }
  }

  #evidenceEnvelope(input: {
    readonly definition: ToolDefinition
    readonly args: Readonly<Record<string, unknown>>
    readonly result: ToolExecutionOutcome
    readonly snapshots: readonly SourceSnapshot[]
    readonly artifactRef: ResourceRef
    readonly resultDigest: string
    readonly scopeRef: ScopeRef
    readonly ctx: ToolContext
    readonly now: string
  }): EvidenceEnvelope {
    const { definition, result, snapshots, artifactRef, resultDigest, scopeRef, ctx, now } = input
    const operation = input.args.operationRef
    const isCompute = definition.toolId === 'data_query' && isRecord(operation)
    const kind: EvidenceKind =
      result.evidenceKind ?? (isCompute ? 'computation' : EVIDENCE_KIND_BY_TOOL[definition.toolId] ?? 'observation')
    const body = {
      evidenceId: this.#newId(),
      kind,
      scopeRef,
      producedBy: {
        componentRef: this.#gatewayRef,
        runId: ctx.runId,
      },
      observedAt: now,
      ...(result.validity === undefined ? {} : { validity: result.validity }),
      sourceSnapshots: [...snapshots],
      resultDigest,
      dependencies: [],
      dataMode: result.dataMode ?? (isCompute ? 'simulation' : 'observed'),
      payloadRef: artifactRef,
    } satisfies Omit<EvidenceEnvelope, 'integrity'>
    const envelopeDigest = sha256DigestOf(canonicalJson(body))
    return {
      ...body,
      integrity: { algorithm: 'sha256', digest: envelopeDigest, verifiedAt: now },
    }
  }

  #handlerFor(toolId: string): ToolHandler {
    const handler = this.#handlers.get(toolId)
    if (handler === undefined) {
      throw new ToolGatewayError(
        'HANDLER_NOT_REGISTERED',
        `no handler is registered for the enabled tool ${toolId}`,
      )
    }
    return handler
  }

  #scopeOf(ctx: ToolContext): ScopeRef {
    return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  }

  #deadline(ctx: ToolContext, limits: ResultLimits, now: string): string {
    const toolDeadline = Date.parse(now) + limits.maxDurationMs
    const runDeadline = Date.parse(ctx.deadline)
    return new Date(Math.min(toolDeadline, runDeadline)).toISOString()
  }

  #remainingMs(deadline: string): number {
    return Math.max(0, Date.parse(deadline) - Date.now())
  }

  async #settleFailed(
    reservation: BudgetReservationRecord,
    ctx: ToolContext,
    startedAt: number,
    usageUnknown = false,
  ): Promise<void> {
    try {
      await this.#deps.budget.settle(
        {
          ledgerId: this.#binding.ledgerId,
          reservationId: reservation.reservationId,
          status: 'failed',
          usage: {
            durationMs: Date.now() - startedAt,
            calls: 1,
            rows: 0,
            bytes: 0,
            ...(usageUnknown ? { usageUnknown: true } : {}),
          },
          evidenceRefs: [],
        },
        ctx,
      )
    } catch {
      // Best-effort: the reservation expires with the ledger deadline. The original
      // failure is what the caller must see, so it is never replaced by this one.
    }
  }

  #classify(error: unknown, code: ToolGatewayErrorCode, message: string): ToolGatewayError {
    if (error instanceof ToolGatewayError) return error
    if (error instanceof BudgetLedgerError) {
      const platformCode = denialCode(error.code)
      return new ToolGatewayError(code, `${message}: ${error.message}`, {
        cause: error,
        ...(platformCode === undefined ? {} : { platformCode }),
      })
    }
    // An adapter-raised port error (PostgresQueryError, DocumentSearchError,
    // WebSearchProviderError, …) already carries a canonical code: keep it instead of
    // collapsing the port's semantics into INTERNAL_ERROR.
    const detail = error instanceof Error ? error.message : 'unknown failure'
    const portFailure = classifyPortFailure(error)
    if (portFailure !== undefined) {
      return new ToolGatewayError(code, `${message}: ${detail}`, {
        cause: error,
        platformCode: portFailure.code,
        ...(portFailure.remoteStateUnknown ? { remoteStateUnknown: true } : {}),
      })
    }
    return new ToolGatewayError(code, `${message}: ${detail}`, { cause: error })
  }

  #errorResult(call: ToolCall, error: unknown, traceId: string, startedAt: number): ToolResult {
    const gatewayError =
      error instanceof ToolGatewayError
        ? error
        : new ToolGatewayError('HANDLER_FAILED', 'the tool call failed unexpectedly', { cause: error })
    const platformError: PlatformError = toPlatformError(gatewayError, traceId)
    return {
      callId: call.callId,
      status: 'error',
      schemaRef: {
        id: `${call.toolId}.result`,
        version: '1.0.0',
        digest: sha256DigestOf('tool-result'),
      },
      evidenceRefs: [],
      sourceSnapshots: [],
      coverage: { returned: 0, truncated: false },
      usage: { durationMs: Date.now() - startedAt },
      warnings: [],
      error: platformError,
    }
  }
}

/** Bind a gateway to exactly one run's ledger, resolved profile and operations. */
export function createRunToolGateway(
  deps: ToolGatewayDependencies,
  binding: RunToolBinding,
): ToolGatewayService {
  return new ToolGatewayService(deps, binding)
}
