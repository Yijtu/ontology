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
