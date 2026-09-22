import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode } from '@ontology/contracts'

/**
 * Workflow-controller failure codes.
 *
 * Every code that already exists in the canonical catalogue keeps the catalogue's HTTP
 * status (C6.2), so the API layer never re-derives a mapping. Only 404/403/428/422 cases
 * the catalogue lacks are added, and none duplicates an existing catalogue meaning.
 */
export type WorkflowControllerErrorCode =
  | ErrorCode
  | 'SCOPE_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'MANIFEST_NOT_FOUND'
  | 'REVISION_REQUIRED'
  | 'NO_RUNTIME_SELECTED'
  | 'PUBLICATION_REJECTED'

const EXTRA_HTTP_STATUS: Readonly<Record<string, number>> = {
  SCOPE_MISMATCH: 403,
  RUN_NOT_FOUND: 404,
  MANIFEST_NOT_FOUND: 404,
  REVISION_REQUIRED: 428,
  NO_RUNTIME_SELECTED: 409,
  PUBLICATION_REJECTED: 422,
}

const CATALOGUE_HTTP_STATUS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.httpStatus]),
)

export function httpStatusForWorkflowError(code: WorkflowControllerErrorCode): number {
  const status = CATALOGUE_HTTP_STATUS[code] ?? EXTRA_HTTP_STATUS[code]
  if (status === undefined) {
    throw new Error(`no HTTP status is mapped for workflow error ${code}`)
  }
  return status
}

export interface WorkflowControllerErrorOptions extends ErrorOptions {
  readonly staleEntryIds?: readonly string[]
  readonly failedChecks?: readonly string[]
}

/**
 * Classified workflow failure. It carries its code, HTTP status and the explicit
 * stale/failed detail so a blocked run can never be mistaken for a published one.
 */
export class WorkflowControllerError extends Error {
  readonly code: WorkflowControllerErrorCode
  readonly httpStatus: number
  readonly staleEntryIds: readonly string[] | undefined
  readonly failedChecks: readonly string[] | undefined

  constructor(
    code: WorkflowControllerErrorCode,
    message: string,
    options?: WorkflowControllerErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowControllerError'
    this.code = code
    this.httpStatus = httpStatusForWorkflowError(code)
    this.staleEntryIds = options?.staleEntryIds
    this.failedChecks = options?.failedChecks
  }
}

export function isWorkflowControllerError(value: unknown): value is WorkflowControllerError {
  return value instanceof WorkflowControllerError
}

/**
 * A rejected publication. It is thrown by the restricted publisher (and the real
 * publication service) when a draft has no recorded passing verification, when the hashes
 * do not match, or when the run is not publishable. The controller wraps it so a bypass
 * attempt surfaces as `PUBLICATION_REJECTED` and never as a published answer.
 */
export class PublicationRejectedError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'PublicationRejectedError'
    this.reason = reason
  }
}


