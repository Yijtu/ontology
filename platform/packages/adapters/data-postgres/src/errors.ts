import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode, FieldError, PlatformError } from '@ontology/contracts'

export interface PostgresQueryErrorOptions extends ErrorOptions {
  readonly retryable?: boolean
  /**
   * Set when a timed-out or cancelled remote call may or may not have taken effect. The
   * adapter is read-only, but a caller still needs to know whether the remote state was
   * confirmed, so the flag is propagated instead of being assumed false.
   */
  readonly remoteStateUnknown?: boolean
  readonly safeMessage?: string
  readonly fieldErrors?: readonly FieldError[]
}

/**
 * A classified failure raised by the PostgreSQL data adapter.
 *
 * `code` is always a published catalogue entry (never a parallel invention); the
 * retryable flag defaults to the catalogue descriptor so a caller cannot widen it.
 */
export class PostgresQueryError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly remoteStateUnknown: boolean
  readonly safeMessage: string | undefined
  readonly fieldErrors: readonly FieldError[]

  constructor(code: ErrorCode, message: string, options?: PostgresQueryErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PostgresQueryError'
    this.code = code
    this.retryable = options?.retryable ?? ERROR_CATALOG[code].retryable !== 'never'
    this.remoteStateUnknown = options?.remoteStateUnknown ?? false
    this.safeMessage = options?.safeMessage
    this.fieldErrors = options?.fieldErrors ?? []
  }

  toPlatformError(traceId?: string): PlatformError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.safeMessage === undefined ? {} : { safeMessage: this.safeMessage }),
      ...(traceId === undefined ? {} : { traceId }),
      ...(this.remoteStateUnknown ? { remoteStateUnknown: true } : {}),
      ...(this.fieldErrors.length === 0 ? {} : { fieldErrors: [...this.fieldErrors] }),
    }
  }
}

export function isPostgresQueryError(value: unknown): value is PostgresQueryError {
  return value instanceof PostgresQueryError
}
