import { ERROR_CATALOG } from '@ontology/contracts'
import type { FieldError, PlatformError } from '@ontology/contracts'

/**
 * The closed set of failure codes the JEV decision adapter can classify. Every code
 * already exists in the canonical catalogue (C6.2); the adapter adds no parallel code
 * space and derives HTTP status/retryability from it, so the API layer never re-derives
 * a mapping.
 *
 * `CAPABILITY_NOT_CONFIGURED` is used when the profile declares a generative
 * classification fallback but no classifier was injected: a missing capability is
 * surfaced explicitly instead of being silently substituted.
 */
export type JevAdapterErrorCode =
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'DEADLINE_EXCEEDED'
  | 'BUDGET_EXHAUSTED'
  | 'NO_PROGRESS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_SCHEMA'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL_ERROR'
  | 'EVIDENCE_PERSIST_FAILED'
  | 'INSUFFICIENT_DATA'
  | 'CAPABILITY_NOT_CONFIGURED'

export function httpStatusForJevError(code: JevAdapterErrorCode): number {
  return ERROR_CATALOG[code].httpStatus
}

/**
 * Only `limited` retries automatically. `depends_on_effect` (DEADLINE_EXCEEDED) stays
 * manual because a timed-out call may already have been billed, and a decision call is
 * not provably idempotent at the provider.
 */
export function isRetryableJevError(code: JevAdapterErrorCode): boolean {
  return ERROR_CATALOG[code].retryable === 'limited'
}

export interface JevAdapterErrorOptions extends ErrorOptions {
  readonly retryAfterMs?: number
  readonly remoteStateUnknown?: boolean
  readonly fieldErrors?: readonly FieldError[]
  readonly traceId?: string
}

/**
 * Classified JEV-adapter failure. `toPlatformError` renders it into the canonical
 * `PlatformError` embedded in a `DecisionFallback`, applying the caller's secret
 * redactor so no credential can reach a result, an error or a log line.
 */
export class JevAdapterError extends Error {
  readonly code: JevAdapterErrorCode
  readonly httpStatus: number
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  readonly remoteStateUnknown: boolean
  readonly fieldErrors: readonly FieldError[] | undefined
  readonly traceId: string | undefined

  constructor(code: JevAdapterErrorCode, message: string, options?: JevAdapterErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JevAdapterError'
    this.code = code
    this.httpStatus = httpStatusForJevError(code)
    this.retryable = isRetryableJevError(code)
    this.retryAfterMs = options?.retryAfterMs
    this.remoteStateUnknown = options?.remoteStateUnknown ?? false
    this.fieldErrors = options?.fieldErrors
    this.traceId = options?.traceId
  }

  /** `redact` is applied to the message; it must never be omitted at the boundary. */
  toPlatformError(redact: (text: string) => string): PlatformError {
    const message = redact(this.message)
    const safeMessage = message.length === 0 ? 'decision call failed' : message
    return {
      code: this.code,
      message: safeMessage,
      retryable: this.retryable,
      safeMessage,
      ...(this.traceId === undefined ? {} : { traceId: this.traceId }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      ...(this.remoteStateUnknown ? { remoteStateUnknown: true } : {}),
      ...(this.fieldErrors === undefined ? {} : { fieldErrors: [...this.fieldErrors] }),
    }
  }
}

export function isJevAdapterError(value: unknown): value is JevAdapterError {
  return value instanceof JevAdapterError
}

/** Map an HTTP status from the JEV API onto the canonical error taxonomy (C6.2). */
export function jevErrorForHttpStatus(status: number, detail: string): JevAdapterError {
  const message = detail.length === 0 ? `JEV responded with HTTP ${status}` : detail
  if (status === 429) return new JevAdapterError('RATE_LIMITED', message)
  if (status === 503) return new JevAdapterError('MODEL_UNAVAILABLE', message)
  if (status === 504) {
    return new JevAdapterError('DEADLINE_EXCEEDED', message, { remoteStateUnknown: true })
  }
  if (status === 401) return new JevAdapterError('UNAUTHENTICATED', message)
  if (status === 403) return new JevAdapterError('FORBIDDEN', message)
  if (status === 400 || status === 422) return new JevAdapterError('INVALID_ARGUMENT', message)
  return new JevAdapterError('INTERNAL_ERROR', message)
}
