import { ERROR_CATALOG } from '@ontology/contracts'
import type { FieldError, PlatformError } from '@ontology/contracts'

/**
 * The closed set of failure codes the generation adapter can classify. Every code
 * already exists in the canonical catalogue (C6.2); the adapter adds no parallel code
 * space and derives HTTP status/retryability from it.
 */
export type ModelAdapterErrorCode =
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

export function httpStatusForModelError(code: ModelAdapterErrorCode): number {
  return ERROR_CATALOG[code].httpStatus
}

/**
 * `limited` is the only catalogue retryability that maps to an automatic retry here.
 * `depends_on_effect`/`depends_on_idempotency` stay manual: a generation call is not
 * provably idempotent in billing, so the adapter never silently repeats it.
 */
export function isRetryableModelError(code: ModelAdapterErrorCode): boolean {
  return ERROR_CATALOG[code].retryable === 'limited'
}

export interface ModelAdapterErrorOptions extends ErrorOptions {
  readonly retryAfterMs?: number
  readonly remoteStateUnknown?: boolean
  readonly fieldErrors?: readonly FieldError[]
  readonly traceId?: string
}

/**
 * Classified model-adapter failure. `toPlatformError` renders it into the canonical
 * `PlatformError` carried by a `GenerationErrorEvent`, applying the caller's secret
 * redactor so no credential can reach an event or a log line.
 */
export class ModelAdapterError extends Error {
  readonly code: ModelAdapterErrorCode
  readonly httpStatus: number
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  readonly remoteStateUnknown: boolean
  readonly fieldErrors: readonly FieldError[] | undefined
  readonly traceId: string | undefined

  constructor(code: ModelAdapterErrorCode, message: string, options?: ModelAdapterErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelAdapterError'
    this.code = code
    this.httpStatus = httpStatusForModelError(code)
    this.retryable = isRetryableModelError(code)
    this.retryAfterMs = options?.retryAfterMs
    this.remoteStateUnknown = options?.remoteStateUnknown ?? false
    this.fieldErrors = options?.fieldErrors
    this.traceId = options?.traceId
  }

  /** `redact` is applied to the message; it must never be omitted at the boundary. */
  toPlatformError(redact: (text: string) => string): PlatformError {
    const message = redact(this.message)
    const safeMessage = message.length === 0 ? 'model call failed' : message
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

export function isModelAdapterError(value: unknown): value is ModelAdapterError {
  return value instanceof ModelAdapterError
}

/** Map an HTTP status from the company API onto the canonical error taxonomy. */
export function modelErrorForHttpStatus(status: number, detail: string): ModelAdapterError {
  const message = detail.length === 0 ? `provider responded with HTTP ${status}` : detail
  if (status === 429) return new ModelAdapterError('RATE_LIMITED', message)
  if (status === 503) return new ModelAdapterError('MODEL_UNAVAILABLE', message)
  if (status === 504) {
    return new ModelAdapterError('DEADLINE_EXCEEDED', message, { remoteStateUnknown: true })
  }
  if (status === 401) return new ModelAdapterError('UNAUTHENTICATED', message)
  if (status === 403) return new ModelAdapterError('FORBIDDEN', message)
  if (status === 400 || status === 422) return new ModelAdapterError('INVALID_ARGUMENT', message)
  return new ModelAdapterError('INTERNAL_ERROR', message)
}
