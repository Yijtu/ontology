/**
 * Incremental materialisation errors (SPEC D5/D5.1, §8). The taxonomy is small and typed so a
 * caller can distinguish an authorization/scope fault from a stale-generation conflict.
 */
export type MaterializationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'GENERATION_CONFLICT'
  | 'INVALID_CHANGE'
  | 'MATERIALIZATION_FAILED'

export class MaterializationError extends Error {
  readonly code: MaterializationErrorCode

  constructor(code: MaterializationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MaterializationError'
    this.code = code
  }
}

export function isMaterializationError(error: unknown): error is MaterializationError {
  return error instanceof MaterializationError
}
