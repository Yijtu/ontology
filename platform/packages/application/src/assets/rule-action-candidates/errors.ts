import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified failures of the rule/action candidate surface (SPEC v0.3a §8/§10, issue V03-010 /
 * #184, AGENTS §错误保留分类). A failure keeps a category and a context instead of being
 * swallowed into an empty candidate list; the HTTP layer maps the code to the shared envelope.
 */
export type RuleActionCandidateErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'WORKSPACE_NOT_FOUND'
  | 'CANDIDATE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'REVISION_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SUPPORT_VALIDATION_BLOCKED'
  | 'CAPABILITY_NOT_BOUND'
  | 'LIFECYCLE_INVALID'
  | 'INVALID_MODEL_OUTPUT'
  | 'ARBITRARY_EXECUTABLE_REJECTED'
  | 'MODEL_NOT_CONFIGURED'
  | 'GENERATION_FAILED'
  | 'CANCELLED'
  | 'VALIDATION_BLOCKED'

const HTTP_STATUS: Readonly<Record<RuleActionCandidateErrorCode, number>> = {
  INVALID_ARGUMENT: 400,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  WORKSPACE_NOT_FOUND: 404,
  CANDIDATE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  REVISION_REQUIRED: 428,
  IDEMPOTENCY_CONFLICT: 409,
  SUPPORT_VALIDATION_BLOCKED: 422,
  CAPABILITY_NOT_BOUND: 409,
  LIFECYCLE_INVALID: 409,
  INVALID_MODEL_OUTPUT: 422,
  ARBITRARY_EXECUTABLE_REJECTED: 422,
  MODEL_NOT_CONFIGURED: 409,
  GENERATION_FAILED: 503,
  CANCELLED: 409,
  VALIDATION_BLOCKED: 422,
}

export interface RuleActionCandidateErrorOptions extends ErrorOptions {
  readonly platformCode?: ErrorCode
  readonly retryable?: boolean
  readonly reasons?: readonly string[]
}

export class RuleActionCandidateError extends Error {
  readonly code: RuleActionCandidateErrorCode
  readonly httpStatus: number
  readonly platformCode: ErrorCode | undefined
  readonly retryable: boolean | undefined
  readonly reasons: readonly string[] | undefined

  constructor(
    code: RuleActionCandidateErrorCode,
    message: string,
    options?: RuleActionCandidateErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RuleActionCandidateError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.platformCode = options?.platformCode
    this.retryable = options?.retryable
    this.reasons = options?.reasons
  }
}

export function isRuleActionCandidateError(value: unknown): value is RuleActionCandidateError {
  return value instanceof RuleActionCandidateError
}
