import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified publication failure (SPEC D4.6/D5, C6, US-011/US-012/US-015). Every code is an
 * explicit, queryable state; publication never swallows a failure into an empty publication
 * or a partial write. Missing `If-Match` is 428 and a stale revision is 409, matching C6/§6.
 */
export type SemanticPublicationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'REVISION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_NOT_APPROVED'
  | 'CANDIDATE_REJECTED'
  | 'CANDIDATE_FAILED'
  | 'CANDIDATE_CONFLICTED'
  | 'CANDIDATE_UNREPRESENTABLE'
  | 'CANDIDATE_DOMAIN_UNPUBLISHABLE'
  | 'MISSING_SOURCE'
  | 'SCHEMA_MISMATCH'
  | 'DEFINITION_NOT_VISIBLE'
  | 'IDENTITY_UNRESOLVED'
  | 'IDENTITY_CONSTRAINT_BLOCKED'
  | 'STATEMENT_NOT_FOUND'
  | 'STATEMENT_RETRACTED'
  | 'PUBLICATION_NOT_FOUND'
  | 'REVIEW_NOT_FOUND'

const PLATFORM_CODE: Readonly<Record<SemanticPublicationErrorCode, ErrorCode>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  REVISION_REQUIRED: 'INVALID_ARGUMENT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  CANDIDATE_NOT_FOUND: 'INVALID_ARGUMENT',
  CANDIDATE_NOT_APPROVED: 'INSUFFICIENT_DATA',
  CANDIDATE_REJECTED: 'INSUFFICIENT_DATA',
  CANDIDATE_FAILED: 'INVALID_SCHEMA',
  CANDIDATE_CONFLICTED: 'DATA_CONFLICT',
  CANDIDATE_UNREPRESENTABLE: 'INVALID_SCHEMA',
  CANDIDATE_DOMAIN_UNPUBLISHABLE: 'INVALID_ARGUMENT',
  MISSING_SOURCE: 'INSUFFICIENT_DATA',
  SCHEMA_MISMATCH: 'DATA_CONFLICT',
  DEFINITION_NOT_VISIBLE: 'INVALID_ARGUMENT',
  IDENTITY_UNRESOLVED: 'INSUFFICIENT_DATA',
  IDENTITY_CONSTRAINT_BLOCKED: 'DATA_CONFLICT',
  STATEMENT_NOT_FOUND: 'INVALID_ARGUMENT',
  STATEMENT_RETRACTED: 'DATA_CONFLICT',
  PUBLICATION_NOT_FOUND: 'INVALID_ARGUMENT',
  REVIEW_NOT_FOUND: 'INVALID_ARGUMENT',
}

const HTTP_STATUS: Readonly<Record<SemanticPublicationErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  FORBIDDEN: 403,
  INVALID_ARGUMENT: 400,
  REVISION_REQUIRED: 428,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CANDIDATE_NOT_FOUND: 404,
  CANDIDATE_NOT_APPROVED: 422,
  CANDIDATE_REJECTED: 422,
  CANDIDATE_FAILED: 422,
  CANDIDATE_CONFLICTED: 409,
  CANDIDATE_UNREPRESENTABLE: 422,
  CANDIDATE_DOMAIN_UNPUBLISHABLE: 422,
  MISSING_SOURCE: 422,
  SCHEMA_MISMATCH: 409,
  DEFINITION_NOT_VISIBLE: 404,
  IDENTITY_UNRESOLVED: 409,
  IDENTITY_CONSTRAINT_BLOCKED: 409,
  STATEMENT_NOT_FOUND: 404,
  STATEMENT_RETRACTED: 409,
  PUBLICATION_NOT_FOUND: 404,
  REVIEW_NOT_FOUND: 404,
}

/** A structured, machine-readable reason attached to a publication failure. */
export interface PublicationRejectionReason {
  readonly candidateId?: string
  readonly code: string
  readonly message: string
}

export class SemanticPublicationError extends Error {
  readonly code: SemanticPublicationErrorCode
  readonly platformCode: ErrorCode
  readonly httpStatus: number
  readonly reasons: readonly PublicationRejectionReason[]

  constructor(
    code: SemanticPublicationErrorCode,
    message: string,
    options?: ErrorOptions & { readonly reasons?: readonly PublicationRejectionReason[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SemanticPublicationError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
    this.httpStatus = HTTP_STATUS[code]
    this.reasons = options?.reasons ?? []
  }
}

export function isSemanticPublicationError(value: unknown): value is SemanticPublicationError {
  return value instanceof SemanticPublicationError
}
