import type { PlatformError } from '@ontology/contracts'

/**
 * Classified failures of the project-snapshot semantic query path (V03-025). The codes are
 * the C6.2 catalogue entries; a caller maps them by `code` and never inspects the message.
 *
 * `SNAPSHOT_UNAVAILABLE` is how a query that names no active fixed snapshot is refused —
 * there is deliberately no "latest dataset" fallback.
 */
export type ProjectSemanticQueryErrorCode =
  | 'UNSUPPORTED_QUERY'
  | 'INVALID_ARGUMENT'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'FORBIDDEN'

export interface ProjectSemanticQueryErrorOptions extends ErrorOptions {
  readonly platformError?: PlatformError
}

export class ProjectSemanticQueryError extends Error {
  readonly code: ProjectSemanticQueryErrorCode
  readonly platformError: PlatformError | undefined

  constructor(
    code: ProjectSemanticQueryErrorCode,
    message: string,
    options?: ProjectSemanticQueryErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProjectSemanticQueryError'
    this.code = code
    this.platformError = options?.platformError
  }
}

export function isProjectSemanticQueryError(value: unknown): value is ProjectSemanticQueryError {
  return value instanceof ProjectSemanticQueryError
}
