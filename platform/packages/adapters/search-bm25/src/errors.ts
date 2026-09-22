import { ERROR_CATALOG } from '@ontology/contracts'

/**
 * Classified failures of the keyword document search adapter (SPEC C3/C4, C6.2).
 *
 * Every code is a published canonical catalogue entry: the adapter adds no parallel
 * code space, so the tool gateway can preserve the port's semantics on the tool path
 * instead of downgrading them to `INTERNAL_ERROR`.
 *
 * `UNSUPPORTED_QUERY` (422) is a first-class outcome, not a generic failure: the
 * adapter never silently degrades a `vector`/`hybrid` request to keyword scoring, so
 * a caller always learns which modes the registered backend can actually serve.
 * `INDEX_NOT_FOUND` (409, never retryable) is the missing active index;
 * `SNAPSHOT_UNAVAILABLE` (409, never) is a cursor pinned to a generation that is no
 * longer available; `SOURCE_UNAVAILABLE` (503, limited) is a store read/write that
 * failed, which is retryable inside the shared run budget. `FORBIDDEN` is a scope
 * refusal and `INVALID_ARGUMENT` a malformed request; `DEADLINE_EXCEEDED` records the
 * remote state as unknown.
 */
export type DocumentSearchErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_QUERY'
  | 'INDEX_NOT_FOUND'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'SOURCE_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'

export function httpStatusForDocumentSearchError(code: DocumentSearchErrorCode): number {
  return ERROR_CATALOG[code].httpStatus
}

export class DocumentSearchError extends Error {
  readonly code: DocumentSearchErrorCode
  readonly httpStatus: number
  readonly retryable: boolean

  constructor(code: DocumentSearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DocumentSearchError'
    this.code = code
    this.httpStatus = httpStatusForDocumentSearchError(code)
    this.retryable = ERROR_CATALOG[code].retryable !== 'never'
  }
}

export function isDocumentSearchError(value: unknown): value is DocumentSearchError {
  return value instanceof DocumentSearchError
}

/**
 * Node system error codes that mean the database endpoint could not be reached
 * or the socket died in transit. These are the `code`/`errno` fields of a
 * `net`/`tls` error raised by the driver, not a PostgreSQL SQLSTATE.
 */
const CONNECTION_ERRNO_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
])

/**
 * PostgreSQL SQLSTATEs that mean the server is unavailable rather than the
 * statement being wrong:
 *   - class `08` (connection exception): 08000/08001/08003/08004/08006/08007;
 *   - `57P01`/`57P02`/`57P03` (admin shutdown / crash shutdown / cannot connect
 *     now — the codes a server emits while stopping);
 *   - `53300` too_many_connections (server-side pool exhaustion).
 */
const CONNECTION_SQLSTATES: ReadonlySet<string> = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
])

/**
 * `pg-pool` raises these as a plain `Error` with no structured code, so the
 * stable driver message is the only signal. They are kept deliberately narrow:
 * pool exhaustion and an unexpectedly dropped connection.
 */
const CONNECTION_MESSAGE_PATTERNS: readonly RegExp[] = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
  /client has encountered a connection error/i,
  /client was closed and is not queryable/i,
]

function isSqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code)
}

/**
 * Decide whether a raw `pg`/driver failure is a connection/availability-class
 * failure. Classification is by the underlying structured field — the Node
 * `code`/`errno` or the PostgreSQL SQLSTATE — rather than by message text where
 * one exists, so a non-connection error whose message merely mentions a
 * connection (e.g. a `23505` unique violation) is never misread. Only the
 * `pg-pool` errors that carry no code fall back to a driver-message match, and a
 * wrapper is followed through its `cause` when it has no code of its own.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string' && candidate.code.length > 0) {
    if (CONNECTION_ERRNO_CODES.has(candidate.code)) return true
    if (isSqlState(candidate.code)) {
      return candidate.code.startsWith('08') || CONNECTION_SQLSTATES.has(candidate.code)
    }
    return false
  }
  const message = candidate.message
  if (
    typeof message === 'string' &&
    CONNECTION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return true
  }
  if (candidate.cause !== undefined && candidate.cause !== error) {
    return isConnectionFailure(candidate.cause)
  }
  return false
}

/**
 * Map a raw keyword-index store failure onto the canonical document-search error
 * space (SPEC C6.2).
 *
 * A connection/availability-class failure becomes the retryable
 * `SOURCE_UNAVAILABLE` (503, limited) instead of an opaque driver error that the
 * tool path would otherwise flatten to `INTERNAL_ERROR`. Every other failure is
 * returned as `undefined` so the caller rethrows it untouched: an
 * already-classified `DocumentSearchError` (e.g. `INDEX_NOT_FOUND` 409,
 * `SNAPSHOT_UNAVAILABLE` 409) keeps its code, and a genuine internal fault (a
 * constraint violation, a malformed stored row) stays on the gateway's
 * `INTERNAL_ERROR` fallback rather than being disguised as a transient outage.
 *
 * The original error is preserved as the `cause` for diagnostics; the message
 * never repeats the connection string or credentials.
 */
export function asStoreFailure(error: unknown): DocumentSearchError | undefined {
  if (isDocumentSearchError(error)) return undefined
  if (!isConnectionFailure(error)) return undefined
  return new DocumentSearchError(
    'SOURCE_UNAVAILABLE',
    'the keyword index store could not reach its PostgreSQL database',
    { cause: error },
  )
}
