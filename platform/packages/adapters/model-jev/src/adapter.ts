import { isToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  BudgetDenial,
  BudgetReservationRecord,
  BudgetSettlementStatus,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionPort,
  PlatformError,
  ResourceRef,
  SecretValue,
  ToolContext,
  ToolUsage,
} from '@ontology/contracts'
import { DEFAULT_ESTIMATED_TOKENS, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_BASE_DELAY_MS } from './constants'
import { JevAdapterError, jevErrorForHttpStatus, type JevAdapterErrorCode } from './errors'
import { degradeToClarification, degradeToDeterministic, degradeToGenerativeClassification } from './fallback'
import { JevHttpClient } from './http-client'
import { assertDecisionRequest } from './request'
import type {
  DecisionEvidenceRequest,
  DecisionEvidenceResult,
  JevAdapterConfig,
  JevFallbackPolicy,
  JevModelBinding,
  JevUsage,
} from './types'
import { decodeJevWireResponse, type JevWireResponse } from './vendor/jev-wire'
import { validateJevResponse } from './validate'

/**
 * JEV decision adapter (SPEC C2, ADR-09).
 *
 * It implements `DecisionPort` — a port distinct from `GenerationPort` — and answers
 * fixed choice/score/noul questions. It never emits generated text, code, explanation or
 * SQL, never accepts messages/tool schemas and never calls a tool. A calibrated result
 * preserves the option set, the probability distribution, `confidence` (when the provider
 * supports it) and the definition version; every probability is range- and
 * normalisation-checked.
 *
 * When JEV is unavailable or a result's confidence is too low the profile's fallback
 * policy is applied explicitly: a typed clarification, a deterministic fallback or a
 * clearly-marked generative-classification fallback. A fallback result never carries a
 * fabricated `confidence` and is never presented as an equally calibrated probability;
 * `fallback_reason` and the original failure evidence are recorded.
 *
 * Budget integration (D7.2): every attempt reserves a parallel slot and its estimated
 * token allowance from the run's single shared ledger. A retry draws from the same
 * monotonic counters and never resets them. A timeout whose remote billing is unknown
 * settles as `usage_unknown` and is never released as free allowance.
 */
export class JevDecisionAdapter implements DecisionPort {
  readonly #config: JevAdapterConfig
  readonly #client: JevHttpClient

  constructor(config: JevAdapterConfig) {
    this.#config = config
    this.#client = new JevHttpClient({
      baseUrl: config.baseUrl,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    })
  }

  /**
   * The `DecisionPort` method returns a single `DecisionResult`, so it accepts exactly one
   * question. A multi-question batch is answered atomically by `decideAll`; `decide` never
   * silently drops a question to fit the single-result contract.
   */
  async decide(request: DecisionRequest, ctx: ToolContext): Promise<DecisionResult> {
    const parsed = assertDecisionRequest(request)
    if (parsed.questions.length !== 1) {
      throw new JevAdapterError(
        'INVALID_ARGUMENT',
        'DecisionPort.decide returns one result; call decideAll for a multi-question batch',
      )
    }
    const results = await this.#decideValidated(parsed, ctx)
    const [only] = results
    if (only === undefined) {
      throw new JevAdapterError('INTERNAL_ERROR', 'the decision call produced no result')
    }
    return only
  }

  /** Answer a batch of questions atomically, returning one result per question in order. */
  async decideAll(request: DecisionRequest, ctx: ToolContext): Promise<readonly DecisionResult[]> {
    return this.#decideValidated(assertDecisionRequest(request), ctx)
  }

  async #decideValidated(
    request: DecisionRequest,
    ctx: ToolContext,
  ): Promise<readonly DecisionResult[]> {
    if (!isToolContext(ctx)) {
      throw new JevAdapterError('INVALID_ARGUMENT', 'a host-minted trusted tool context is required')
    }

    let secret: SecretValue
    try {
      secret = await this.#config.secrets.resolve(this.#config.secretRef, ctx)
    } catch (error) {
      throw new JevAdapterError('INTERNAL_ERROR', 'the decision credential could not be resolved', {
        cause: error,
      })
    }
    const redact = (text: string): string => secret.redact(text)

    const binding = this.#config.models[request.modelRef.modelId]
    if (binding === undefined) {
      throw new JevAdapterError(
        'INVALID_ARGUMENT',
        `no JEV model binding is configured for ${request.modelRef.modelId}`,
      )
    }

    const outcome = await this.#attempt(request, ctx, binding, secret, redact)
    if (outcome.kind === 'calibrated') return outcome.results
    return this.#degrade(request, ctx, binding, redact, outcome.failure, outcome.modelVersion)
  }

  async #attempt(
    request: DecisionRequest,
    ctx: ToolContext,
    binding: JevModelBinding,
    secret: SecretValue,
    redact: (text: string) => string,
  ): Promise<AttemptOutcome> {
    const maxAttempts = this.#config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const retryBaseDelayMs = this.#config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
    const estimatedTokens = this.#config.estimatedTokens ?? DEFAULT_ESTIMATED_TOKENS
    const deadlineMs = Date.parse(ctx.deadline)
    const decisionId = (this.#config.newId ?? defaultNewId)()
    let outstanding: BudgetReservationRecord | undefined
    let lastModelVersion: string | undefined

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (this.#isCancelled()) throw this.#cancelledError()
        const startedMs = Date.now()
        if (startedMs >= deadlineMs) {
          throw new JevAdapterError('DEADLINE_EXCEEDED', 'the run deadline has already passed', {
            remoteStateUnknown: true,
          })
        }

        const reserved = await this.#reserve(ctx, decisionId, attempt, estimatedTokens)
        if (reserved.kind === 'denied') throw reserved.error
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

        let usage: JevUsage | undefined
        let calibrated: readonly DecisionResult[] | undefined
        let failure: JevAdapterError | undefined
        let billingUnknown = false
        let cancelled = false

        try {
          const http = await this.#client.send({
            vendorModel: binding.vendorModel,
            stateRef: request.stateRef,
            questions: request.questions,
            apiKey: secret.reveal(),
            signal: controller.signal,
          })

          if (http.status >= 400) {
            // A clean HTTP refusal means the provider did not run the model.
            failure = jevErrorForHttpStatus(http.status, redact(http.errorDetail ?? ''))
            if (http.retryAfterMs !== undefined) failure = withRetryAfter(failure, http.retryAfterMs)
          } else {
            const decoded = decodeJevWireResponse(http.body)
            if (decoded.kind === 'malformed') {
              failure = new JevAdapterError('INVALID_SCHEMA', redact(decoded.detail), {
                remoteStateUnknown: true,
              })
              billingUnknown = true
            } else {
              lastModelVersion = decoded.response.model_version
              const validated = validateJevResponse(request.questions, decoded.response, redact)
              if (validated.kind === 'error') {
                failure = validated.error
                billingUnknown = true
              } else {
                const low = this.#lowConfidence(validated.results)
                if (low === undefined) {
                  calibrated = validated.results
                  usage = usageOf(decoded.response)
                } else {
                  failure = low
                  usage = usageOf(decoded.response)
                  billingUnknown = true
                }
              }
            }
          }
        } catch (error) {
          if (this.#isCancelled()) {
            cancelled = true
          } else {
            billingUnknown = true
            failure = timedOut
              ? new JevAdapterError('DEADLINE_EXCEEDED', 'the decision call exceeded the run deadline', {
                  remoteStateUnknown: true,
                })
              : error instanceof JevAdapterError
                ? error
                : new JevAdapterError('MODEL_UNAVAILABLE', 'the decision call was interrupted', {
                    remoteStateUnknown: true,
                    cause: error,
                  })
          }
        } finally {
          clearTimeout(timer)
          this.#config.signal?.removeEventListener('abort', onExternalAbort)
        }

        if (cancelled) {
          const status: BudgetSettlementStatus =
            usage !== undefined && usage.usageUnknown !== true ? 'cancelled' : 'usage_unknown'
          await this.#settle(outstanding, usage, status, Date.now() - startedMs, ctx)
          outstanding = undefined
          this.#log('info', 'decision call cancelled', { runId: ctx.runId, attempt })
          throw this.#cancelledError()
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
            !this.#isCancelled() &&
            Date.now() < deadlineMs
          if (retryable) {
            const delayMs = Math.min(
              failure.retryAfterMs ?? retryBaseDelayMs,
              Math.max(0, deadlineMs - Date.now()),
            )
            this.#log('warn', 'retrying decision call', {
              runId: ctx.runId,
              attempt,
              code: failure.code,
              delayMs,
            })
            if (await sleep(delayMs, this.#config.signal)) continue
            throw this.#cancelledError()
          }
          if (DEGRADABLE_CODES.has(failure.code)) {
            return { kind: 'degrade', failure, modelVersion: lastModelVersion }
          }
          throw failure
        }

        if (calibrated === undefined) {
          // Unreachable by construction: a non-failure attempt always carries a result.
          throw new JevAdapterError('INTERNAL_ERROR', 'the decision call ended without a result')
        }

        const evidenceRef = await this.#recordEvidence(
          request,
          ctx,
          calibrated,
          'calibrated',
          undefined,
          lastModelVersion,
        )
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
        return { kind: 'calibrated', results: calibrated, evidenceRef, modelVersion: lastModelVersion }
      }

      throw new JevAdapterError('MODEL_UNAVAILABLE', 'the decision call exhausted its attempts')
    } finally {
      if (outstanding !== undefined) {
        // The consumer stopped early or an unexpected error escaped: never leak a
        // reservation. The remote may already have been billed, so hold it as unknown.
        try {
          await this.#settle(outstanding, undefined, 'usage_unknown', 0, ctx)
        } catch {
          this.#log('error', 'could not settle an abandoned decision reservation', {
            runId: ctx.runId,
            reservationId: outstanding.reservationId,
          })
        }
      }
    }
  }

  async #degrade(
    request: DecisionRequest,
    ctx: ToolContext,
    binding: JevModelBinding,
    redact: (text: string) => string,
    failure: JevAdapterError,
    modelVersion: string | undefined,
  ): Promise<readonly DecisionResult[]> {
    const policy = fallbackPolicyOf(binding, this.#config)
    if (policy === 'reject') throw failure

    const safeMessage = redact(failure.message)
    const fallbackReason = `${failure.code}: ${safeMessage.length === 0 ? 'JEV is unavailable' : safeMessage}`
    const originalFailure = failure.toPlatformError(redact)

    let results: readonly DecisionResult[]
    switch (policy) {
      case 'clarify':
        results = degradeToClarification(request.questions, fallbackReason, originalFailure)
        break
      case 'deterministic':
        results = degradeToDeterministic(request.questions, fallbackReason, originalFailure)
        break
      case 'generative_classification':
        results = await this.#generativeFallback(
          request,
          ctx,
          fallbackReason,
          originalFailure,
        )
        break
    }

    const evidenceRef = await this.#recordEvidence(
      request,
      ctx,
      results,
      'fallback',
      fallbackReason,
      modelVersion,
    )
    return results.map((result) => withFailureEvidence(result, evidenceRef))
  }

  async #generativeFallback(
    request: DecisionRequest,
    ctx: ToolContext,
    fallbackReason: string,
    originalFailure: PlatformError,
  ): Promise<readonly DecisionResult[]> {
    const classifier = this.#config.generativeClassification
    if (classifier === undefined) {
      throw new JevAdapterError(
        'CAPABILITY_NOT_CONFIGURED',
        'the profile declares a generative classification fallback but no classifier is configured',
      )
    }
    const results: DecisionResult[] = []
    for (const question of request.questions) {
      const output = await classifier.classify(
        { question, stateRef: request.stateRef, modelRef: request.modelRef },
        ctx,
      )
      results.push(
        degradeToGenerativeClassification(question, output, fallbackReason, originalFailure),
      )
    }
    return results
  }

  async #recordEvidence(
    request: DecisionRequest,
    ctx: ToolContext,
    results: readonly DecisionResult[],
    outcome: 'calibrated' | 'fallback',
    fallbackReason: string | undefined,
    modelVersion: string | undefined,
  ): Promise<ResourceRef> {
    const byId = new Map(request.questions.map((question) => [question.questionId, question]))
    const evidenceResults: DecisionEvidenceResult[] = []
    for (const result of results) {
      const question = byId.get(result.questionId)
      if (question === undefined) continue
      evidenceResults.push(toEvidenceResult(result, question))
    }
    const evidenceRequest: DecisionEvidenceRequest = {
      runId: ctx.runId,
      modelRef: request.modelRef,
      stateRef: request.stateRef,
      outcome,
      results: evidenceResults,
      ...(modelVersion === undefined ? {} : { modelVersion }),
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    }
    try {
      return await this.#config.evidence.record(evidenceRequest, ctx)
    } catch (error) {
      throw new JevAdapterError(
        'EVIDENCE_PERSIST_FAILED',
        'the decision output could not be recorded as evidence',
        { cause: error, remoteStateUnknown: true },
      )
    }
  }

  #lowConfidence(results: readonly DecisionResult[]): JevAdapterError | undefined {
    const threshold = this.#config.minConfidence
    if (threshold === undefined) return undefined
    for (const result of results) {
      if (result.confidence !== undefined && result.confidence < threshold) {
        return new JevAdapterError(
          'INSUFFICIENT_DATA',
          `decision confidence ${String(result.confidence)} for question ${result.questionId} is below the minimum ${String(threshold)}`,
        )
      }
    }
    return undefined
  }

  async #reserve(
    ctx: ToolContext,
    decisionId: string,
    attempt: number,
    estimatedTokens: number,
  ): Promise<
    | { kind: 'granted'; reservation: BudgetReservationRecord }
    | { kind: 'denied'; error: JevAdapterError }
  > {
    try {
      const outcome = await this.#config.budget.reserve(
        {
          ledgerId: this.#config.ledgerId,
          idempotencyKey: reservationKey(decisionId, attempt),
          parallel: true,
          modelTokens: estimatedTokens,
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
        error: new JevAdapterError('INTERNAL_ERROR', 'the shared budget could not be reserved', {
          cause: error,
        }),
      }
    }
  }

  async #settleAfterFailure(
    reservation: BudgetReservationRecord,
    usage: JevUsage | undefined,
    failure: JevAdapterError,
    billingUnknown: boolean,
    durationMs: number,
    ctx: ToolContext,
  ): Promise<void> {
    if (usage !== undefined && usage.usageUnknown !== true) {
      await this.#settle(reservation, usage, 'failed', durationMs, ctx)
      return
    }
    if (billingUnknown || failure.remoteStateUnknown) {
      await this.#settle(reservation, usage, 'usage_unknown', durationMs, ctx)
      return
    }
    await this.#settle(reservation, undefined, 'failed', durationMs, ctx)
  }

  async #settle(
    reservation: BudgetReservationRecord,
    usage: JevUsage | undefined,
    status: 'failed' | 'cancelled' | 'usage_unknown',
    durationMs: number,
    ctx: ToolContext,
  ): Promise<void> {
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
  }

  #cancelledError(): JevAdapterError {
    return new JevAdapterError('DEADLINE_EXCEEDED', 'the decision call was cancelled', {
      remoteStateUnknown: true,
    })
  }

  #isCancelled(): boolean {
    return this.#config.signal?.aborted === true
  }

  #log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    this.#config.log?.({ level, message, fields })
  }
}

type AttemptOutcome =
  | {
      readonly kind: 'calibrated'
      readonly results: readonly DecisionResult[]
      readonly evidenceRef: ResourceRef
      readonly modelVersion: string | undefined
    }
  | {
      readonly kind: 'degrade'
      readonly failure: JevAdapterError
      readonly modelVersion: string | undefined
    }

const DEGRADABLE_CODES: ReadonlySet<JevAdapterErrorCode> = new Set([
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'DEADLINE_EXCEEDED',
  'INSUFFICIENT_DATA',
])

function fallbackPolicyOf(binding: JevModelBinding, config: JevAdapterConfig): JevFallbackPolicy {
  return binding.fallbackPolicy ?? config.fallbackPolicy
}

function toEvidenceResult(result: DecisionResult, question: DecisionQuestion): DecisionEvidenceResult {
  return {
    questionId: result.questionId,
    questionType: result.questionType,
    prompt: question.prompt,
    definitionVersion: result.definitionVersion,
    optionSetHash: result.optionSetHash,
    options: question.type === 'noul' ? [] : question.options,
    ...(result.selectedOptionId === undefined ? {} : { selectedOptionId: result.selectedOptionId }),
    ...(result.distribution === undefined
      ? {}
      : {
          probabilities: result.distribution.entries.map((entry) => ({
            optionId: entry.optionId,
            probability: entry.probability,
          })),
        }),
    ...(result.scores === undefined
      ? {}
      : {
          scores: result.scores.map((score) => ({
            optionId: score.optionId,
            score: score.score,
            ...(score.confidence === undefined ? {} : { confidence: score.confidence }),
          })),
        }),
    ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
  }
}

function withFailureEvidence(result: DecisionResult, evidenceRef: ResourceRef): DecisionResult {
  const fallback = result.fallback
  if (fallback === undefined) return result
  return {
    ...result,
    fallback: {
      ...fallback,
      originalFailure: { ...fallback.originalFailure, detailsRef: evidenceRef },
    },
  }
}

function withRetryAfter(error: JevAdapterError, retryAfterMs: number): JevAdapterError {
  return new JevAdapterError(error.code, error.message, {
    retryAfterMs,
    remoteStateUnknown: error.remoteStateUnknown,
  })
}

function usageOf(response: JevWireResponse): JevUsage | undefined {
  const usage = response.usage
  if (usage === undefined) return undefined
  const partial = usage.input_tokens === undefined || usage.output_tokens === undefined
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(partial ? { usageUnknown: true } : {}),
  }
}

function settlementUsage(usage: JevUsage | undefined, durationMs: number): ToolUsage {
  if (usage === undefined || usage.usageUnknown === true) {
    return { durationMs, usageUnknown: true }
  }
  return { durationMs, modelTokens: usage.inputTokens + usage.outputTokens }
}

function settlementUsageForStatus(
  status: 'failed' | 'cancelled' | 'usage_unknown',
  usage: JevUsage | undefined,
  durationMs: number,
): ToolUsage {
  if (status === 'usage_unknown') return { durationMs, usageUnknown: true }
  if (usage !== undefined && usage.usageUnknown !== true) {
    return { durationMs, modelTokens: usage.inputTokens + usage.outputTokens }
  }
  return { durationMs, modelTokens: 0 }
}

function denialError(denial: BudgetDenial | undefined): JevAdapterError {
  if (denial === undefined) {
    return new JevAdapterError(
      'INTERNAL_ERROR',
      'the budget reservation was refused without a reason',
    )
  }
  switch (denial.code) {
    case 'BUDGET_EXHAUSTED':
      return new JevAdapterError('BUDGET_EXHAUSTED', denial.message)
    case 'DEADLINE_EXCEEDED':
      return new JevAdapterError('DEADLINE_EXCEEDED', denial.message)
    case 'RATE_LIMITED':
      return new JevAdapterError(
        'RATE_LIMITED',
        denial.message,
        denial.retryAfterMs === undefined ? undefined : { retryAfterMs: denial.retryAfterMs },
      )
    case 'NO_PROGRESS':
      return new JevAdapterError('NO_PROGRESS', denial.message)
  }
}

function reservationKey(decisionId: string, attempt: number): string {
  return `jev-${sha256DigestOf(`${decisionId}:${String(attempt)}`)}`
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID()
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
