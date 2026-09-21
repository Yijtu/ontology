import { ERROR_CATALOG } from '@ontology/contracts'

/**
 * C6 failure shape: `{error:{code,message,retryable,...},traceId}`.
 *
 * Any classified service error (`RunServiceError`, `ProfileResolverError`,
 * `SourceRegistryError`) already carries a code and its HTTP status, so the HTTP layer
 * renders it without re-deriving the mapping. Catalogue codes keep the catalogue's
 * retryability; service-level codes the catalogue cannot express (`RUN_NOT_FOUND`,
 * `REVISION_REQUIRED`, `PREFLIGHT_STALE`, `SCOPE_MISMATCH`, …) are never marked retryable.
 */
export interface ApiFailureBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
    readonly missingCapabilities?: readonly unknown[]
    readonly incompatibleReasons?: readonly string[]
    readonly reasons?: readonly string[]
  }
  readonly traceId: string
}

/**
 * The structural shape every application-layer failure shares. Declared here (rather than
 * importing the three concrete error classes) so the HTTP layer depends on the contract,
 * not on which service happened to throw.
 */
export interface ClassifiedApiError {
  readonly code: string
  readonly httpStatus: number
  readonly message: string
  readonly missingCapabilities?: readonly unknown[]
  readonly incompatibleReasons?: readonly string[]
  readonly reasons?: readonly string[]
}

const CATALOGUE_RETRYABILITY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.retryable]),
)

export function isRetryable(code: string): boolean {
  const retryability = CATALOGUE_RETRYABILITY[code]
  return retryability !== undefined && retryability !== 'never'
}

export function failureBody(error: ClassifiedApiError, traceId: string): ApiFailureBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: isRetryable(error.code),
      ...(error.missingCapabilities === undefined
        ? {}
        : { missingCapabilities: error.missingCapabilities }),
      ...(error.incompatibleReasons === undefined
        ? {}
        : { incompatibleReasons: error.incompatibleReasons }),
      ...(error.reasons === undefined ? {} : { reasons: error.reasons }),
    },
    traceId,
  }
}

/**
 * A classified failure is any thrown value that carries a numeric HTTP status and a string
 * code. Checking structurally keeps a foreign library error from being rendered as if it
 * were a domain failure: anything else stays a 500 `INTERNAL_ERROR`.
 */
export function isClassifiedError(value: unknown): value is ClassifiedApiError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as {
    readonly code?: unknown
    readonly httpStatus?: unknown
    readonly message?: unknown
  }
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.httpStatus === 'number' &&
    typeof candidate.message === 'string'
  )
}
