import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode, MissingCapability } from '@ontology/contracts'

/**
 * Run-service failure codes.
 *
 * Every code that exists in the canonical catalogue keeps the catalogue's HTTP status
 * (C6.2), so the API layer never re-derives a mapping. The catalogue has no code that
 * renders 404 or 428, so — exactly like `ProfileResolverError` — this service adds the
 * minimum: a missing run/checkpoint/clarification is 404 and a missing `If-Match` is 428.
 * No code duplicates an existing catalogue meaning.
 */
export type RunServiceErrorCode =
  | ErrorCode
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CLARIFICATION_NOT_FOUND'
  | 'REVISION_REQUIRED'
  | 'STORAGE_FAILURE'
  | 'PROJECT_NOT_FOUND'
  | 'TASK_NOT_BOUND'
  | 'TASK_NOT_READY'
  | 'TASK_UNAVAILABLE'
  | 'TASK_PARAMETER_INVALID'
  | 'INPUT_SNAPSHOT_INVALID'

const EXTRA_HTTP_STATUS: Readonly<Record<string, number>> = {
  SCOPE_MISMATCH: 403,
  RUN_NOT_FOUND: 404,
  CHECKPOINT_NOT_FOUND: 404,
  CLARIFICATION_NOT_FOUND: 404,
  REVISION_REQUIRED: 428,
  STORAGE_FAILURE: 500,
  PROJECT_NOT_FOUND: 404,
  TASK_NOT_BOUND: 409,
  TASK_NOT_READY: 409,
  TASK_UNAVAILABLE: 409,
  TASK_PARAMETER_INVALID: 422,
  INPUT_SNAPSHOT_INVALID: 409,
}

const CATALOGUE_HTTP_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.httpStatus]),
)

export function httpStatusForRunError(code: RunServiceErrorCode): number {
  const status = CATALOGUE_HTTP_STATUS[code] ?? EXTRA_HTTP_STATUS[code]
  if (status === undefined) {
    throw new Error(`no HTTP status is mapped for run error ${code}`)
  }
  return status
}

export interface RunServiceErrorOptions extends ErrorOptions {
  readonly missingCapabilities?: readonly MissingCapability[]
  readonly incompatibleReasons?: readonly string[]
  /** Concrete, actionable reasons (e.g. task capability blockers) for an explicit failure. */
  readonly reasons?: readonly string[]
}

/**
 * Classified run-service failure. It carries the code, its HTTP status and the explicit
 * missing/incompatible detail, so a failure can never be mistaken for an empty success.
 */
export class RunServiceError extends Error {
  readonly code: RunServiceErrorCode
  readonly httpStatus: number
  readonly missingCapabilities: readonly MissingCapability[] | undefined
  readonly incompatibleReasons: readonly string[] | undefined
  readonly reasons: readonly string[] | undefined

  constructor(code: RunServiceErrorCode, message: string, options?: RunServiceErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RunServiceError'
    this.code = code
    this.httpStatus = httpStatusForRunError(code)
    this.missingCapabilities = options?.missingCapabilities
    this.incompatibleReasons = options?.incompatibleReasons
    this.reasons = options?.reasons
  }
}

export function isRunServiceError(value: unknown): value is RunServiceError {
  return value instanceof RunServiceError
}
