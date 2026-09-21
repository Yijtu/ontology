import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode } from '@ontology/contracts'

/**
 * Job-service failure codes.
 *
 * Every code that exists in the canonical catalogue keeps the catalogue's HTTP status
 * (C6.2), so the API layer never re-derives a mapping. The catalogue has no 404 or 428 code,
 * so this service adds the minimum: a missing job/attempt is 404 and a missing `If-Match` is
 * 428. No code duplicates an existing catalogue meaning.
 */
export type JobServiceErrorCode =
  | ErrorCode
  | 'SCOPE_MISMATCH'
  | 'JOB_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'REVISION_REQUIRED'
  | 'STORAGE_FAILURE'

const EXTRA_HTTP_STATUS: Readonly<Record<string, number>> = {
  SCOPE_MISMATCH: 403,
  JOB_NOT_FOUND: 404,
  ATTEMPT_NOT_FOUND: 404,
  REVISION_REQUIRED: 428,
  STORAGE_FAILURE: 500,
}

const CATALOGUE_HTTP_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.httpStatus]),
)

export function httpStatusForJobError(code: JobServiceErrorCode): number {
  const status = CATALOGUE_HTTP_STATUS[code] ?? EXTRA_HTTP_STATUS[code]
  if (status === undefined) {
    throw new Error(`no HTTP status is mapped for job error ${code}`)
  }
  return status
}

/** Classified job-service failure. Never carries a secret or a full customer payload. */
export class JobServiceError extends Error {
  readonly code: JobServiceErrorCode
  readonly httpStatus: number

  constructor(code: JobServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JobServiceError'
    this.code = code
    this.httpStatus = httpStatusForJobError(code)
  }
}

export function isJobServiceError(value: unknown): value is JobServiceError {
  return value instanceof JobServiceError
}

/**
 * A classified, secret-scrubbed stage failure raised by a stage handler. The message must be
 * safe to persist and return; the worker never copies a raw handler error message into the
 * job record, so an unexpected exception cannot leak a secret or customer payload.
 */
export class JobStageFailure extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean

  constructor(code: ErrorCode, message: string, retryable: boolean, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JobStageFailure'
    this.code = code
    this.retryable = retryable
  }
}
