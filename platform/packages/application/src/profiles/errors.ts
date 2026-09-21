import type { MissingCapability } from '@ontology/contracts'

export type ProfileResolverErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'PROFILE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'PROFILE_INCOMPATIBLE'
  | 'CAPABILITY_NOT_CONFIGURED'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'REVISION_REQUIRED'
  | 'AUDIT_PERSIST_FAILED'

/** C6.2 error mapping: a missing If-Match is 428, a stale expectation is 409. */
const HTTP_STATUS: Readonly<Record<ProfileResolverErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  PROFILE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  PROFILE_INCOMPATIBLE: 409,
  CAPABILITY_NOT_CONFIGURED: 409,
  SNAPSHOT_UNAVAILABLE: 409,
  REVISION_REQUIRED: 428,
  AUDIT_PERSIST_FAILED: 500,
}

export interface ProfileResolverErrorOptions extends ErrorOptions {
  readonly missingCapabilities?: readonly MissingCapability[]
  readonly incompatibleReasons?: readonly string[]
}

/**
 * Classified profile-composition failure. It carries the error code, its HTTP status and
 * the explicit missing/incompatible detail, so the API layer can render C6.2 without
 * re-deriving anything and a caller can never mistake a failure for an empty success.
 */
export class ProfileResolverError extends Error {
  readonly code: ProfileResolverErrorCode
  readonly httpStatus: number
  readonly missingCapabilities: readonly MissingCapability[] | undefined
  readonly incompatibleReasons: readonly string[] | undefined

  constructor(code: ProfileResolverErrorCode, message: string, options?: ProfileResolverErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProfileResolverError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.missingCapabilities = options?.missingCapabilities
    this.incompatibleReasons = options?.incompatibleReasons
  }
}

export function isProfileResolverErrorCode(value: unknown): value is ProfileResolverErrorCode {
  return typeof value === 'string' && value in HTTP_STATUS
}
