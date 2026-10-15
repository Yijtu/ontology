import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified failures of the definition-candidate generation surface (SPEC v0.3a §8/§10,
 * AGENTS §错误保留分类). A failure keeps a category and a context instead of being swallowed
 * into an empty candidate list. `retryable` tells the caller whether a fresh attempt can help;
 * the HTTP layer maps the code to the shared error envelope.
 */
export type DefinitionCandidateErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'WORKSPACE_NOT_FOUND'
  | 'DRAFT_NOT_FOUND'
  | 'CANDIDATE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'REVISION_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VALIDATION_BLOCKED'
  | 'MODEL_NOT_CONFIGURED'
  | 'GENERATION_FAILED'
  | 'INVALID_MODEL_OUTPUT'
  | 'CANCELLED'
  | 'SCHEMA_NOT_FOUND'

const HTTP_STATUS: Readonly<Record<DefinitionCandidateErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  WORKSPACE_NOT_FOUND: 404,
  DRAFT_NOT_FOUND: 404,
  CANDIDATE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  REVISION_REQUIRED: 428,
  IDEMPOTENCY_CONFLICT: 409,
  VALIDATION_BLOCKED: 422,
  MODEL_NOT_CONFIGURED: 409,
  GENERATION_FAILED: 503,
  INVALID_MODEL_OUTPUT: 422,
  CANCELLED: 409,
  SCHEMA_NOT_FOUND: 409,
}

export interface DefinitionCandidateErrorOptions extends ErrorOptions {
  readonly platformCode?: ErrorCode
  readonly retryable?: boolean
  readonly reasons?: readonly string[]
}

export class DefinitionCandidateError extends Error {
  readonly code: DefinitionCandidateErrorCode
  readonly httpStatus: number
  readonly platformCode: ErrorCode | undefined
  readonly retryable: boolean | undefined
  readonly reasons: readonly string[] | undefined

  constructor(
    code: DefinitionCandidateErrorCode,
    message: string,
    options?: DefinitionCandidateErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DefinitionCandidateError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.platformCode = options?.platformCode
    this.retryable = options?.retryable
    this.reasons = options?.reasons
  }
}

export function isDefinitionCandidateError(value: unknown): value is DefinitionCandidateError {
  return value instanceof DefinitionCandidateError
}
