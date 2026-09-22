/**
 * Classified extraction-pipeline failures (SPEC D4/C6.2, AGENTS §错误保留分类).
 *
 * A failure keeps a category and a context instead of being swallowed into an empty
 * candidate list or a default value. The stage handlers map these onto `JobStageFailure`
 * so the job record carries a precise failed stage and a retryable flag.
 */
export type ExtractionErrorCode =
  | 'SCOPE_MISMATCH'
  | 'SCHEMA_NOT_FOUND'
  | 'INVALID_JOB_REF'
  | 'NO_CHUNKS'
  | 'GENERATION_FAILED'
  | 'INVALID_MODEL_OUTPUT'
  | 'BUDGET_REFUSED'
  | 'CANCELLED'

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode

  constructor(code: ExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExtractionError'
    this.code = code
  }
}

export function isExtractionError(value: unknown): value is ExtractionError {
  return value instanceof ExtractionError
}
