import { ERROR_CATALOG } from '@ontology/contracts'

/**
 * Classified failures of the keyword document search adapter (SPEC C3/C4, C6.2).
 *
 * `UNSUPPORTED_QUERY` is a first-class outcome, not a generic failure: the adapter
 * never silently degrades a `vector`/`hybrid` request to keyword scoring, so a
 * caller always learns which modes the registered backend can actually serve.
 * The remaining codes are adapter-local classifications that keep the failure
 * specific instead of collapsing it into an empty result.
 */
export type DocumentSearchErrorCode =
  | 'INVALID_REQUEST'
  | 'SCOPE_MISMATCH'
  | 'UNSUPPORTED_QUERY'
  | 'INDEX_NOT_FOUND'
  | 'INDEX_VERSION_NOT_FOUND'
  | 'INDEX_BUILD_FAILED'
  | 'CORPUS_UNAVAILABLE'
  | 'STORE_FAILED'

const EXTRA_HTTP_STATUS: Readonly<Record<DocumentSearchErrorCode, number>> = {
  INVALID_REQUEST: 400,
  SCOPE_MISMATCH: 403,
  UNSUPPORTED_QUERY: 422,
  INDEX_NOT_FOUND: 409,
  INDEX_VERSION_NOT_FOUND: 409,
  INDEX_BUILD_FAILED: 500,
  CORPUS_UNAVAILABLE: 503,
  STORE_FAILED: 500,
}

const CATALOGUE_HTTP_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.httpStatus]),
)

export function httpStatusForDocumentSearchError(code: DocumentSearchErrorCode): number {
  return CATALOGUE_HTTP_STATUS[code] ?? EXTRA_HTTP_STATUS[code]
}

export class DocumentSearchError extends Error {
  readonly code: DocumentSearchErrorCode
  readonly httpStatus: number

  constructor(code: DocumentSearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DocumentSearchError'
    this.code = code
    this.httpStatus = httpStatusForDocumentSearchError(code)
  }
}

export function isDocumentSearchError(value: unknown): value is DocumentSearchError {
  return value instanceof DocumentSearchError
}
