/**
 * Classified errors for the DuckDB data adapter.
 *
 * The codes map onto the platform error catalogue (C6.2): a sandbox rejection is
 * `UNSUPPORTED_QUERY`/`FORBIDDEN`, a bounded result that had to stop early is
 * `RESULT_TOO_LARGE`, and an interrupted execution is `CANCELLED`/`DEADLINE_EXCEEDED`.
 *
 * `remoteStateUnknown` is deliberately explicit. An in-process DuckDB interrupt is
 * deterministic (the query stops), so the state is known and the reservation is not a
 * `usage_unknown` hold. If an interrupt cannot be confirmed within the grace period the
 * flag is set, which tells the gateway to settle conservatively.
 */
export type DuckDbAdapterErrorCode =
  | 'UNSUPPORTED_QUERY'
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'UNAUTHENTICATED'
  | 'SOURCE_UNAVAILABLE'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'CANCELLED'
  | 'RESULT_TOO_LARGE'
  | 'INTERNAL_ERROR'

export interface DuckDbAdapterErrorOptions {
  readonly cause?: unknown
  readonly remoteStateUnknown?: boolean
}

export class DuckDbAdapterError extends Error {
  readonly code: DuckDbAdapterErrorCode
  readonly remoteStateUnknown: boolean

  constructor(
    code: DuckDbAdapterErrorCode,
    message: string,
    options: DuckDbAdapterErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DuckDbAdapterError'
    this.code = code
    this.remoteStateUnknown = options.remoteStateUnknown ?? false
  }
}
