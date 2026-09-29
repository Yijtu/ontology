/**
 * Classified failures of the industry-workspace management surface (SPEC v0.3a §8/§10).
 *
 * The HTTP layer renders this through the shared C6 envelope, so an unauthorised or
 * missing-capability call is a domain error with a stable code and status — never a raw
 * 500. `reasons` carries the conflict localisation (expected/current revision) so a client
 * can show the exact field that moved instead of a bare "conflict".
 */
export type IndustryWorkspaceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'WORKSPACE_NOT_FOUND'
  | 'DRAFT_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_REQUIRED'

const HTTP_STATUS: Readonly<Record<IndustryWorkspaceErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  WORKSPACE_NOT_FOUND: 404,
  DRAFT_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_REQUIRED: 428,
}

export interface IndustryWorkspaceErrorOptions extends ErrorOptions {
  readonly reasons?: readonly string[]
}

export class IndustryWorkspaceError extends Error {
  readonly code: IndustryWorkspaceErrorCode
  readonly httpStatus: number
  readonly reasons: readonly string[] | undefined

  constructor(code: IndustryWorkspaceErrorCode, message: string, options?: IndustryWorkspaceErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IndustryWorkspaceError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.reasons = options?.reasons
  }
}
