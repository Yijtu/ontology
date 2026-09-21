import type { CapabilityRequirement } from '@ontology/contracts'

export type SourceRegistryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'SOURCE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'CAPABILITY_NOT_CONFIGURED'
  | 'SOURCE_UNAVAILABLE'
  | 'PREFLIGHT_STALE'
  | 'AUDIT_PERSIST_FAILED'

/** C6.2 error mapping for the source/probe surface. */
const HTTP_STATUS: Readonly<Record<SourceRegistryErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  SOURCE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  CAPABILITY_NOT_CONFIGURED: 409,
  SOURCE_UNAVAILABLE: 503,
  PREFLIGHT_STALE: 409,
  AUDIT_PERSIST_FAILED: 500,
}

export interface SourceRegistryErrorOptions extends ErrorOptions {
  readonly missingCapabilities?: readonly CapabilityRequirement[]
  readonly reasons?: readonly string[]
}

/**
 * Classified source-registration/probe failure. It carries the code, its HTTP status and
 * the explicit missing/stale detail so the API layer renders C6.2 without re-deriving it.
 * The message is always a safe, server-authored string: a resolved secret value is never
 * interpolated here.
 */
export class SourceRegistryError extends Error {
  readonly code: SourceRegistryErrorCode
  readonly httpStatus: number
  readonly missingCapabilities: readonly CapabilityRequirement[] | undefined
  readonly reasons: readonly string[] | undefined

  constructor(code: SourceRegistryErrorCode, message: string, options?: SourceRegistryErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SourceRegistryError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.missingCapabilities = options?.missingCapabilities
    this.reasons = options?.reasons
  }
}

export function isSourceRegistryErrorCode(value: unknown): value is SourceRegistryErrorCode {
  return typeof value === 'string' && value in HTTP_STATUS
}
