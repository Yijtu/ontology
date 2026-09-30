/**
 * Classified failures of the customer-project and version-mounting surface (SPEC v0.3a §3.2/§8/§10).
 *
 * The HTTP layer renders this through the shared C6 envelope, so a project referencing an
 * unpublished pack, a stale CAS revision or a scope mismatch is a domain error with a stable
 * code and status — never a raw 500.
 */
export type ProjectErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'PACK_NOT_PUBLISHED'
  | 'MAPPING_NOT_FOUND'
  | 'SOURCE_UNREADABLE'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_REQUIRED'
  | 'READINESS_CONFLICT'

const HTTP_STATUS: Readonly<Record<ProjectErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  PROJECT_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  PACK_NOT_PUBLISHED: 404,
  MAPPING_NOT_FOUND: 404,
  SOURCE_UNREADABLE: 422,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_REQUIRED: 428,
  READINESS_CONFLICT: 409,
}

export interface ProjectErrorOptions extends ErrorOptions {
  readonly reasons?: readonly string[]
}

export class ProjectError extends Error {
  readonly code: ProjectErrorCode
  readonly httpStatus: number
  readonly reasons: readonly string[] | undefined

  constructor(code: ProjectErrorCode, message: string, options?: ProjectErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProjectError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.reasons = options?.reasons
  }
}
