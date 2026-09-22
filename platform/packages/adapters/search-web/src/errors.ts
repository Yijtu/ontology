import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode, FieldError, PlatformError } from '@ontology/contracts'

/**
 * The closed set of provider failure codes. Every code already exists in the canonical
 * catalogue (C6.2); the provider adds no parallel code space and derives HTTP status and
 * retryability from it. `SOURCE_UNAVAILABLE` (503), `RATE_LIMITED` (429) and
 * `DEADLINE_EXCEEDED` (504, remote state unknown) are the transport-level outcomes;
 * `UNSUPPORTED_QUERY`, `FORBIDDEN`, `RESULT_TOO_LARGE` and `INVALID_ARGUMENT` are
 * refusals; `INTERNAL_ERROR` is the safe fallback.
 */
export type WebSearchProviderErrorCode =
  | 'SOURCE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'DEADLINE_EXCEEDED'
  | 'UNSUPPORTED_QUERY'
  | 'FORBIDDEN'
  | 'RESULT_TOO_LARGE'
  | 'INVALID_ARGUMENT'
  | 'INTERNAL_ERROR'

export function httpStatusForProviderError(code: WebSearchProviderErrorCode): number {
  return ERROR_CATALOG[code].httpStatus
}

/** `limited` is the only catalogue retryability the provider treats as automatically retryable. */
export function isRetryableProviderError(code: WebSearchProviderErrorCode): boolean {
  return ERROR_CATALOG[code].retryable === 'limited'
}

export interface WebSearchProviderErrorOptions extends ErrorOptions {
  readonly retryAfterMs?: number
  /**
   * True when the request may already have reached (and been billed by) the remote —
   * a timeout, a dropped connection after send, or an unparsable 5xx. It maps to a
   * `usage_unknown` budget hold rather than a free failure.
   */
  readonly remoteStateUnknown?: boolean
  readonly fieldErrors?: readonly FieldError[]
  readonly traceId?: string
}

/**
 * Classified provider failure. The message never carries a credential or a full page
 * body; only the classified reason and bounded context do.
 */
export class WebSearchProviderError extends Error {
  readonly code: WebSearchProviderErrorCode
  readonly httpStatus: number
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  readonly remoteStateUnknown: boolean
  readonly fieldErrors: readonly FieldError[] | undefined
  readonly traceId: string | undefined

  constructor(code: WebSearchProviderErrorCode, message: string, options?: WebSearchProviderErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WebSearchProviderError'
    this.code = code
    this.httpStatus = httpStatusForProviderError(code)
    this.retryable = isRetryableProviderError(code)
    this.retryAfterMs = options?.retryAfterMs
    this.remoteStateUnknown = options?.remoteStateUnknown ?? false
    this.fieldErrors = options?.fieldErrors
    this.traceId = options?.traceId
  }

  /** Render into the canonical `PlatformError`, applying the caller's secret redactor. */
  toPlatformError(redact: (text: string) => string): PlatformError {
    const message = redact(this.message)
    const safeMessage = message.length === 0 ? 'web search provider call failed' : message
    const platformCode: ErrorCode = this.code
    return {
      code: platformCode,
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

export function isWebSearchProviderError(value: unknown): value is WebSearchProviderError {
  return value instanceof WebSearchProviderError
}

/** Map an HTTP status from a search endpoint onto the canonical error taxonomy. */
export function providerErrorForHttpStatus(status: number, detail: string): WebSearchProviderError {
  const message = detail.length === 0 ? `search provider responded with HTTP ${String(status)}` : detail
  if (status === 429) return new WebSearchProviderError('RATE_LIMITED', message)
  if (status === 503) return new WebSearchProviderError('SOURCE_UNAVAILABLE', message)
  if (status === 504) {
    return new WebSearchProviderError('DEADLINE_EXCEEDED', message, { remoteStateUnknown: true })
  }
  if (status === 401 || status === 403) return new WebSearchProviderError('FORBIDDEN', message)
  if (status === 400 || status === 422) return new WebSearchProviderError('UNSUPPORTED_QUERY', message)
  if (status === 413) return new WebSearchProviderError('RESULT_TOO_LARGE', message)
  return new WebSearchProviderError('INTERNAL_ERROR', message)
}
