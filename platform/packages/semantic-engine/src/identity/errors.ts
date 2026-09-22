import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified identity-recall failure. Every code is an explicit, queryable state; the
 * recall never swallows a failure into an empty candidate list, because an empty list is
 * a meaningful `undecided` outcome and must not be produced by an error path.
 */
export type IdentityRecallErrorCode =
  | 'SCOPE_MISMATCH'
  | 'DEFINITION_NOT_VISIBLE'
  | 'IDENTITY_SCOPE_NOT_FOUND'
  | 'MISSING_SCOPE_DIMENSION'
  | 'UNMAPPED_SCOPE_DIMENSION'
  | 'INDEX_NOT_VISIBLE'
  | 'INDEX_UNAVAILABLE'
  | 'MAPPING_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'BUDGET_REQUIRED'
  | 'BUDGET_REFUSED'
  | 'SIMILARITY_FAILED'

const PLATFORM_CODE: Readonly<Record<IdentityRecallErrorCode, ErrorCode>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  DEFINITION_NOT_VISIBLE: 'INVALID_ARGUMENT',
  IDENTITY_SCOPE_NOT_FOUND: 'INVALID_ARGUMENT',
  MISSING_SCOPE_DIMENSION: 'INVALID_ARGUMENT',
  UNMAPPED_SCOPE_DIMENSION: 'CAPABILITY_NOT_CONFIGURED',
  INDEX_NOT_VISIBLE: 'CAPABILITY_NOT_CONFIGURED',
  INDEX_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  MAPPING_NOT_FOUND: 'CAPABILITY_NOT_CONFIGURED',
  INVALID_REQUEST: 'INVALID_ARGUMENT',
  BUDGET_REQUIRED: 'CAPABILITY_NOT_CONFIGURED',
  BUDGET_REFUSED: 'BUDGET_EXHAUSTED',
  SIMILARITY_FAILED: 'MODEL_UNAVAILABLE',
}

export class IdentityRecallError extends Error {
  readonly code: IdentityRecallErrorCode
  readonly platformCode: ErrorCode

  constructor(code: IdentityRecallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IdentityRecallError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
  }
}

export function isIdentityRecallError(value: unknown): value is IdentityRecallError {
  return value instanceof IdentityRecallError
}
