import { isToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  BudgetDenial,
  BudgetReservationRecord,
  GenerationCompleted,
  GenerationErrorEvent,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  GenerationUsage,
  GenerationUsageEvent,
  SecretValue,
  ToolContext,
  ToolUsage,
} from '@ontology/contracts'
import { ModelAdapterError, modelErrorForHttpStatus } from './errors'
import { CompanyHttpClient } from './http-client'
import { mapVendorChunk, unknownUsage } from './mapping'
import type { CandidateValidationResult, CompanyGenerationAdapterConfig, ModelAdapterLogRecord } from './types'
import { createWireCodec } from './vendor/codec'
import type { CompanyWireChunk } from './vendor/company-wire'

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 200

/**
 * Company generation adapter (SPEC C2, ADR-09).
 *
 * It converts the company stream into the single canonical `GenerationEvent` union and
 * never executes a tool: a `tool_call_delta` is only a proposal for the caller to route
 * through the gateway. Model output is a candidate draft, never a published answer
 * (INV-09).
 *
 * A structured candidate is streamed as `text_delta`; once the stream completes it is
 * parsed and validated against `responseSchemaRef`, and a malformed or schema-invalid
 * candidate is surfaced as an `INVALID_SCHEMA` error event instead of a completion.
 *
 * The wire protocol is selected by `protocol`: the original private `{ type: ... }` codec
 * or the OpenAI-compatible `chat/completions` codec. Both decode into the same internal
 * chunks, so the canonical event semantics (and the budget/cancellation behaviour below)
 * are identical; only the wire decoding differs. An OpenAI-compatible stream terminates on
 * `data: [DONE]` and is flushed through the codec's `finish`, which emits complete
 * tool-call candidates (fragments accumulated, non-UUID ids normalised) and the terminal
 * completion.
 *
 * Budget integration (D7.2): every attempt reserves a parallel slot and its estimated
 * token allowance from the run's single shared ledger. A retry draws from the same
 * monotonic counters and never resets them, and the propagated run deadline is the child
 * call's deadline. A timeout or interruption whose remote billing is unknown settles as
 * `usage_unknown` and is never released as free allowance.
 */
export class CompanyGenerationAdapter implements GenerationPort {
  readonly #config: CompanyGenerationAdapterConfig
  readonly #client: CompanyHttpClient

  constructor(config: CompanyGenerationAdapterConfig) {
    this.#config = config
    this.#client = new CompanyHttpClient({
      baseUrl: config.baseUrl,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    })
  }

  async *generate(
    request: GenerationRequest,
    ctx: ToolContext,
  ): AsyncGenerator<GenerationEvent, void, void> {
    if (!isToolContext(ctx)) {
      throw new ModelAdapterError('INVALID_ARGUMENT', 'a host-minted trusted tool context is required')
    }

    let secret: SecretValue
    try {
      secret = await this.#config.secrets.resolve(this.#config.secretRef, ctx)
    } catch (error) {
      yield this.#errorEvent(
        new ModelAdapterError('INTERNAL_ERROR', 'the model credential could not be resolved', {
          cause: error,
        }),
        identity,
      )
      return
    }
    const redact = (text: string): string => secret.redact(text)

    const binding = this.#config.models[request.modelRef.modelId]
    if (binding === undefined) {
      yield this.#errorEvent(
        new ModelAdapterError(
          'INVALID_ARGUMENT',
          `no company model binding is configured for ${request.modelRef.modelId}`,
        ),
        redact,
      )
      return
    }

    const maxAttempts = this.#config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const retryBaseDelayMs = this.#config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    const deadlineMs = Date.parse(ctx.deadline)
    // One generation id per call: two calls for the same run/model must not collide on the
    // budget idempotency key, while retries inside one call stay distinct by attempt.
    const generationId = (this.#config.newId ?? defaultNewId)()
    let outstanding: BudgetReservationRecord | undefined

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this.#isCancelled()) return
        const startedMs = Date.now()
        if (startedMs >= deadlineMs) {
          yield this.#errorEvent(
            new ModelAdapterError('DEADLINE_EXCEEDED', 'the run deadline has already passed'),
            redact,
          )
          return
        }

        const reserved = await this.#reserve(request, ctx, generationId, attempt)
        if (reserved.kind === 'denied') {
          yield this.#errorEvent(reserved.error, redact)
          return
        }
        outstanding = reserved.reservation

        const controller = new AbortController()
        let timedOut = false
        const onExternalAbort = (): void =>
          controller.abort(new DOMException('cancelled', 'AbortError'))
        this.#config.signal?.addEventListener('abort', onExternalAbort, { once: true })
        const cappedMs =
          this.#config.requestTimeoutMs === undefined
            ? deadlineMs
            : Math.min(deadlineMs, startedMs + this.#config.requestTimeoutMs)
        const timer = setTimeout(
          () => {
            timedOut = true
            controller.abort(new DOMException('timeout', 'TimeoutError'))
          },
          Math.max(0, cappedMs - Date.now()),
        )

        let usage: GenerationUsage | undefined
        let usageEmitted = false
        let completed: GenerationCompleted | undefined
        let candidateText = ''
        let toolCallText = ''
        let emitted = false
        let failure: ModelAdapterError | undefined
        let billingUnknown = false
        let cancelled = false

        try {
          const response = await this.#client.send({
            vendorModel: binding.vendorModel,
            messages: request.messages,
            evidenceRefs: request.evidenceRefs,
            maxTokens: request.outputLimit.maxTokens,
            apiKey: secret.reveal(),
            signal: controller.signal,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.toolSchemas === undefined ? {} : { toolIds: request.toolSchemas }),
            ...(request.responseSchemaRef === undefined
              ? {}
              : { responseSchemaRef: request.responseSchemaRef }),
          })

          if (response.status >= 400) {
            // A clean HTTP refusal means the provider did not run the model, so billing
            // is known to be zero. It is still surfaced through the same error event.
            failure = modelErrorForHttpStatus(
              response.status,
              redact(response.errorDetail ?? ''),
            )
            if (response.retryAfterMs !== undefined) {
              failure = withRetryAfter(failure, response.retryAfterMs)
            }
          } else {
            // A fresh codec per attempt: cross-payload state (fragmented tool calls,
            // finish reason) must never leak into a retry or a later call.
            const codec = createWireCodec(this.#config.protocol)
            let stop = false
            const consume = function* (chunk: CompanyWireChunk): Generator<GenerationEvent, void, void> {
              const mapped = mapVendorChunk(chunk, redact)
              for (const event of mapped.events) {
                if (event.type === 'text_delta') {
                  candidateText += event.text
                } else if (event.type === 'tool_call_delta') {
                  toolCallText += event.argumentsDelta
                } else if (event.type === 'usage') {
                  usage = event.usage
                  usageEmitted = true
                } else if (event.type === 'completed') {
                  // The vendor completion is not yielded directly: the adapter emits the
                  // single canonical `completed` (with the candidate digest) only after it
                  // has recorded the model-output evidence.
                  completed = event
                  continue
                }
                emitted = true
                yield event
              }
              if (mapped.failure !== undefined) {
                failure = mapped.failure
                billingUnknown = true
                stop = true
              }
              if (completed !== undefined) stop = true
            }

            for await (const payload of response.payloads) {
              const chunks = codec.decode(payload)
              if (chunks === undefined) {
                failure = new ModelAdapterError(
                  'INTERNAL_ERROR',
                  'the provider stream contained an unrecognised chunk',
                  { remoteStateUnknown: true },
                )
                billingUnknown = true
                break
              }
              for (const chunk of chunks) {
                yield* consume(chunk)
                if (stop) break
              }
              if (stop) break
            }
            if (!stop && failure === undefined && completed === undefined) {
              // Flush state that only completes at end-of-stream (fragmented tool calls,
              // the terminal completion). The stream is exhausted, so this is the only
              // point at which a complete tool-call candidate can be emitted.
              for (const chunk of codec.finish()) {
                yield* consume(chunk)
                if (stop) break
              }
            }
            if (failure === undefined && completed === undefined) {
              failure = new ModelAdapterError(
                'MODEL_UNAVAILABLE',
                'the provider stream ended before a completed event',
                { remoteStateUnknown: true },
              )
              billingUnknown = true
            }
          }
        } catch (error) {
          if (this.#isCancelled()) {
            cancelled = true
          } else {
            billingUnknown = true
            failure = timedOut
              ? new ModelAdapterError(
                  'DEADLINE_EXCEEDED',
                  'the model call exceeded the run deadline',
                  { remoteStateUnknown: true },
                )
              : error instanceof ModelAdapterError
                ? error
                : new ModelAdapterError(
                    'MODEL_UNAVAILABLE',
                    'the provider stream was interrupted',
                    { remoteStateUnknown: true, cause: error },
                  )
          }
        } finally {
          clearTimeout(timer)
          this.#config.signal?.removeEventListener('abort', onExternalAbort)
        }

        if (cancelled) {
          const settled =
            usage !== undefined && usage.usageUnknown !== true ? 'cancelled' : 'usage_unknown'
          await this.#settle(outstanding, usage, settled, Date.now() - startedMs, ctx)
          outstanding = undefined
          this.#log('info', 'model generation cancelled', { runId: ctx.runId, attempt })
          return
        }

        if (failure !== undefined) {
          await this.#settleAfterFailure(
            outstanding,
            usage,
            failure,
            billingUnknown,
            Date.now() - startedMs,
            ctx,
          )
          outstanding = undefined
          const retryable =
            failure.retryable &&
            attempt < maxAttempts &&
            !emitted &&
            !this.#isCancelled() &&
            Date.now() < deadlineMs
          if (retryable) {
            const delayMs = Math.min(
              failure.retryAfterMs ?? retryBaseDelayMs,
              Math.max(0, deadlineMs - Date.now()),
            )
            this.#log('warn', 'retrying model call', {
              runId: ctx.runId,
              attempt,
              code: failure.code,
              delayMs,
            })
            if (await sleep(delayMs, this.#config.signal)) continue
            if (this.#isCancelled()) return
          }
          if (!usageEmitted) yield usageEvent(usage ?? unknownUsage())
          yield this.#errorEvent(failure, redact)
          return
        }

        if (completed === undefined) {
          // Unreachable by construction: a non-failure attempt always carries a completion.
          yield this.#errorEvent(
            new ModelAdapterError('INTERNAL_ERROR', 'the model call ended without a result'),
            redact,
          )
          return
        }

        const candidateFailure = await this.#validateCandidate(request, candidateText, ctx, redact)
        if (candidateFailure !== undefined) {
          await this.#settleAfterFailure(
            outstanding,
            usage,
            candidateFailure,
            true,
            Date.now() - startedMs,
            ctx,
          )
          outstanding = undefined
          if (!usageEmitted) yield usageEvent(usage ?? unknownUsage())
          yield this.#errorEvent(candidateFailure, redact)
          return
        }

        const outputDigest = sha256DigestOf(candidateText + toolCallText)
        let evidenceRef
        try {
          evidenceRef = await this.#config.evidence.record(
            {
              runId: ctx.runId,
              role: request.role,
              outputDigest,
              stopReason: completed.stopReason,
            },
            ctx,
          )
        } catch (error) {
          const evidenceFailure = new ModelAdapterError(
            'EVIDENCE_PERSIST_FAILED',
            'the model output could not be recorded as evidence',
            { cause: error, remoteStateUnknown: true },
          )
          await this.#settle(outstanding, usage, 'usage_unknown', Date.now() - startedMs, ctx)
          outstanding = undefined
          if (!usageEmitted) yield usageEvent(usage ?? unknownUsage())
          yield this.#errorEvent(evidenceFailure, redact)
          return
        }

        await this.#config.budget.settle(
          {
            ledgerId: this.#config.ledgerId,
            reservationId: outstanding.reservationId,
            status: 'completed',
            usage: settlementUsage(usage, Date.now() - startedMs),
            evidenceRefs: [evidenceRef],
          },
          ctx,
        )
        outstanding = undefined
        if (!usageEmitted) yield usageEvent(usage ?? unknownUsage())
        yield {
          type: 'completed',
          stopReason: completed.stopReason,
          candidateOnly: true,
          outputDigest,
        }
        return
      }

      yield this.#errorEvent(
        new ModelAdapterError('MODEL_UNAVAILABLE', 'the model call exhausted its attempts'),
        redact,
      )
    } finally {
      if (outstanding !== undefined) {
        // The consumer stopped early (or an unexpected error escaped): never leak a
        // reservation. The remote may already have been billed, so hold it as unknown.
        try {
          await this.#settle(outstanding, undefined, 'usage_unknown', 0, ctx)
        } catch {
          this.#log('error', 'could not settle an abandoned model reservation', {
            runId: ctx.runId,
            reservationId: outstanding.reservationId,
          })
        }
      }
    }
  }

  async #reserve(
    request: GenerationRequest,
    ctx: ToolContext,
    generationId: string,
    attempt: number,
  ): Promise<
    { kind: 'granted'; reservation: BudgetReservationRecord } | { kind: 'denied'; error: ModelAdapterError }
  > {
    try {
      const outcome = await this.#config.budget.reserve(
        {
          ledgerId: this.#config.ledgerId,
          idempotencyKey: reservationKey(generationId, attempt),
          // A model call consumes one parallel slot and its estimated token allowance
          // before it starts (D7.2). It does not consume the data-tool call counter.
          parallel: true,
          modelTokens: request.outputLimit.maxTokens,
          requestedDeadline: ctx.deadline,
        },
        ctx,
      )
      if (outcome.granted && outcome.reservation !== undefined) {
        return { kind: 'granted', reservation: outcome.reservation }
      }
      return { kind: 'denied', error: denialError(outcome.denial) }
    } catch (error) {
      return {
        kind: 'denied',
        error: new ModelAdapterError('INTERNAL_ERROR', 'the shared budget could not be reserved', {
          cause: error,
        }),
      }
    }
  }

  async #validateCandidate(
    request: GenerationRequest,
    candidateText: string,
    ctx: ToolContext,
    redact: (text: string) => string,
  ): Promise<ModelAdapterError | undefined> {
    if (request.responseSchemaRef === undefined) return undefined

    let parsed: unknown
    try {
      parsed = JSON.parse(candidateText)
    } catch {
      return new ModelAdapterError('INVALID_SCHEMA', 'the structured candidate was not valid JSON')
    }
    const validator = this.#config.schemaValidator
    if (validator === undefined) {
      // A declared response schema with no validator is a host misconfiguration, not a
      // candidate problem: the adapter refuses to report an unvalidated candidate.
      return new ModelAdapterError(
        'INTERNAL_ERROR',
        'no response schema validator is configured for this profile',
        { remoteStateUnknown: true },
      )
    }
    let result: CandidateValidationResult
    try {
      result = await validator.validate(request.responseSchemaRef, parsed, ctx)
    } catch (error) {
      return new ModelAdapterError('INTERNAL_ERROR', 'the response schema validator failed', {
        cause: error,
        remoteStateUnknown: true,
      })
    }
    if (result.valid) return undefined
    const detail = (result.errors ?? []).map(redact).join('; ')
    return new ModelAdapterError(
      'INVALID_SCHEMA',
      detail.length === 0
        ? 'the structured candidate failed schema validation'
        : `the structured candidate failed schema validation: ${detail}`,
    )
  }

  async #settleAfterFailure(
    reservation: BudgetReservationRecord,
    usage: GenerationUsage | undefined,
    failure: ModelAdapterError,
    billingUnknown: boolean,
    durationMs: number,
    ctx: ToolContext,
  ): Promise<void> {
    if (usage !== undefined && usage.usageUnknown !== true) {
      // The provider reported measured usage: settle it exactly, never as free.
      await this.#settle(reservation, usage, 'failed', durationMs, ctx)
      return
    }
    if (billingUnknown || failure.remoteStateUnknown) {
      // The remote may already have been billed; hold the estimate as `usage_unknown`.
      await this.#settle(reservation, usage, 'usage_unknown', durationMs, ctx)
      return
    }
    await this.#settle(reservation, undefined, 'failed', durationMs, ctx)
  }

  async #settle(
    reservation: BudgetReservationRecord,
    usage: GenerationUsage | undefined,
    status: 'failed' | 'cancelled' | 'usage_unknown',
    durationMs: number,
    ctx: ToolContext,
  ): Promise<void> {
    try {
      await this.#config.budget.settle(
        {
          ledgerId: this.#config.ledgerId,
          reservationId: reservation.reservationId,
          status,
          usage: settlementUsageForStatus(status, usage, durationMs),
          evidenceRefs: [],
        },
        ctx,
      )
    } catch (error) {
      this.#log('error', 'model reservation settlement failed', {
        runId: ctx.runId,
        reservationId: reservation.reservationId,
        status,
      })
      throw error
    }
  }

  #isCancelled(): boolean {
    return this.#config.signal?.aborted === true
  }

  #errorEvent(error: ModelAdapterError, redact: (text: string) => string): GenerationErrorEvent {
    this.#log('warn', 'model call failed', {
      code: error.code,
      httpStatus: error.httpStatus,
      remoteStateUnknown: error.remoteStateUnknown,
    })
    return { type: 'error', error: error.toPlatformError(redact) }
  }

  #log(level: ModelAdapterLogRecord['level'], message: string, fields: Record<string, unknown>): void {
    this.#config.log?.({ level, message, fields })
  }
}

function withRetryAfter(error: ModelAdapterError, retryAfterMs: number): ModelAdapterError {
  return new ModelAdapterError(error.code, error.message, {
    retryAfterMs,
    remoteStateUnknown: error.remoteStateUnknown,
  })
}

function usageEvent(usage: GenerationUsage): GenerationUsageEvent {
  return { type: 'usage', usage }
}

function settlementUsage(usage: GenerationUsage | undefined, durationMs: number): ToolUsage {
  if (usage === undefined || usage.usageUnknown === true) {
    return { durationMs, usageUnknown: true }
  }
  return { durationMs, modelTokens: usage.inputTokens + usage.outputTokens }
}

/**
 * Usage for a terminal failure/cancel settlement. Only `usage_unknown` deliberately
 * holds the estimate; a definitive `failed`/`cancelled` records what was actually
 * measured (zero when the provider never ran the model).
 */
function settlementUsageForStatus(
  status: 'failed' | 'cancelled' | 'usage_unknown',
  usage: GenerationUsage | undefined,
  durationMs: number,
): ToolUsage {
  if (status === 'usage_unknown') return { durationMs, usageUnknown: true }
  if (usage !== undefined && usage.usageUnknown !== true) {
    return { durationMs, modelTokens: usage.inputTokens + usage.outputTokens }
  }
  return { durationMs, modelTokens: 0 }
}

function denialError(denial: BudgetDenial | undefined): ModelAdapterError {
  if (denial === undefined) {
    return new ModelAdapterError('INTERNAL_ERROR', 'the budget reservation was refused without a reason')
  }
  switch (denial.code) {
    case 'BUDGET_EXHAUSTED':
      return new ModelAdapterError('BUDGET_EXHAUSTED', denial.message)
    case 'DEADLINE_EXCEEDED':
      return new ModelAdapterError('DEADLINE_EXCEEDED', denial.message)
    case 'RATE_LIMITED':
      return new ModelAdapterError(
        'RATE_LIMITED',
        denial.message,
        denial.retryAfterMs === undefined ? undefined : { retryAfterMs: denial.retryAfterMs },
      )
    case 'NO_PROGRESS':
      return new ModelAdapterError('NO_PROGRESS', denial.message)
  }
}

function reservationKey(generationId: string, attempt: number): string {
  return `model-${sha256DigestOf(`${generationId}:${String(attempt)}`)}`
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID()
}

function identity(text: string): string {
  return text
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (ms <= 0) return signal?.aborted !== true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      cleanup()
      resolve(false)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
