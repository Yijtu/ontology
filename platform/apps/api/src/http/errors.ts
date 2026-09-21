import { ERROR_CATALOG } from '@ontology/contracts'
import { RunServiceError } from '@ontology/application'
import type { RunServiceErrorCode } from '@ontology/application'

/**
 * C6 failure shape: `{error:{code,message,retryable,...},traceId}`.
 *
 * Catalogue codes keep the catalogue's retryability. Service-level codes that the catalogue
 * cannot express (`RUN_NOT_FOUND`, `CHECKPOINT_NOT_FOUND`, `CLARIFICATION_NOT_FOUND`,
 * `REVISION_REQUIRED`, `SCOPE_MISMATCH`) are never marked retryable.
 */
export interface ApiFailureBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly retryable: boolean
    readonly missingCapabilities?: readonly unknown[]
    readonly incompatibleReasons?: readonly string[]
  }
  readonly traceId: string
}

const CATALOGUE_RETRYABILITY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([name, descriptor]) => [name, descriptor.retryable]),
)

export function isRetryable(code: RunServiceErrorCode): boolean {
  const retryability = CATALOGUE_RETRYABILITY[code]
  return retryability !== undefined && retryability !== 'never'
}

export function failureBody(error: RunServiceError, traceId: string): ApiFailureBody {
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
    },
    traceId,
  }
}
