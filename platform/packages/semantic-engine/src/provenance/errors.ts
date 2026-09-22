import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified historical-read failures (SPEC C6, D3.1, US-017, FR-19/FR-20). A history read is
 * a read of immutable records, so it never silently returns an empty page for a failure: a
 * bad cursor is `INVALID_CURSOR` and a storage fault is `HISTORY_READ_FAILED`.
 */
export type HistoryReadErrorCode =
  | 'SCOPE_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_CURSOR'
  | 'HISTORY_READ_FAILED'

const PLATFORM_CODE: Readonly<Record<HistoryReadErrorCode, ErrorCode>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_CURSOR: 'INVALID_ARGUMENT',
  HISTORY_READ_FAILED: 'SOURCE_UNAVAILABLE',
}

const HTTP_STATUS: Readonly<Record<HistoryReadErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  INVALID_ARGUMENT: 400,
  INVALID_CURSOR: 400,
  HISTORY_READ_FAILED: 503,
}

export class HistoryReadError extends Error {
  readonly code: HistoryReadErrorCode
  readonly platformCode: ErrorCode
  readonly httpStatus: number

  constructor(code: HistoryReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HistoryReadError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
    this.httpStatus = HTTP_STATUS[code]
  }
}

export function isHistoryReadError(value: unknown): value is HistoryReadError {
  return value instanceof HistoryReadError
}
