import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode } from '@ontology/contracts'

/**
 * Feedback-service failure codes.
 *
 * Every code that already exists in the canonical catalogue keeps the catalogue's HTTP status
 * (C6.2), so the API layer never re-derives a mapping. The catalogue has no 404 for a missing
 * run/answer, so this service adds exactly that plus a storage failure; none duplicates an
 * existing catalogue meaning.
 */
export type FeedbackServiceErrorCode =
  | ErrorCode
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'ANSWER_NOT_FOUND'
  | 'STORAGE_FAILURE'

const EXTRA_HTTP_STATUS: Readonly<Record<string, number>> = {
  SCOPE_MISMATCH: 403,
  RUN_NOT_FOUND: 404,
  ANSWER_NOT_FOUND: 404,
  STORAGE_FAILURE: 500,
}

const CATALOGUE_HTTP_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.httpStatus]),
)

export function httpStatusForFeedbackError(code: FeedbackServiceErrorCode): number {
  const status = CATALOGUE_HTTP_STATUS[code] ?? EXTRA_HTTP_STATUS[code]
  if (status === undefined) {
    throw new Error(`no HTTP status is mapped for feedback error ${code}`)
  }
  return status
}

/**
 * Classified feedback-service failure. It carries the code and its HTTP status, so a rejected
 * feedback write can never be mistaken for a stored entry.
 */
export class FeedbackServiceError extends Error {
  readonly code: FeedbackServiceErrorCode
  readonly httpStatus: number

  constructor(code: FeedbackServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'FeedbackServiceError'
    this.code = code
    this.httpStatus = httpStatusForFeedbackError(code)
  }
}

export function isFeedbackServiceError(value: unknown): value is FeedbackServiceError {
  return value instanceof FeedbackServiceError
}
