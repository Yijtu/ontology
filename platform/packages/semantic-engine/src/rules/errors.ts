import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified rule-evaluation failure (SPEC D5, C6, US-016). Every code is an explicit,
 * queryable state: a cyclic or unsupported rule is rejected with a typed error instead of
 * being silently degraded into a looser rule or an empty result.
 */
export type RuleEvaluationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RULE'
  | 'CYCLE_DETECTED'
  | 'DEPENDENCY_DEPTH_EXCEEDED'
  | 'UNRESOLVED_DEPENDENCY'
  | 'UNSUPPORTED_NEGATION'
  | 'UNSUPPORTED_FILTER'

const PLATFORM_CODE: Readonly<Record<RuleEvaluationErrorCode, ErrorCode>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_RULE: 'INVALID_SCHEMA',
  CYCLE_DETECTED: 'DATA_CONFLICT',
  DEPENDENCY_DEPTH_EXCEEDED: 'UNSUPPORTED_QUERY',
  UNRESOLVED_DEPENDENCY: 'INVALID_SCHEMA',
  UNSUPPORTED_NEGATION: 'UNSUPPORTED_QUERY',
  UNSUPPORTED_FILTER: 'UNSUPPORTED_QUERY',
}

const HTTP_STATUS: Readonly<Record<RuleEvaluationErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  INVALID_ARGUMENT: 400,
  INVALID_RULE: 422,
  CYCLE_DETECTED: 409,
  DEPENDENCY_DEPTH_EXCEEDED: 422,
  UNRESOLVED_DEPENDENCY: 422,
  UNSUPPORTED_NEGATION: 422,
  UNSUPPORTED_FILTER: 422,
}

export class RuleEvaluationError extends Error {
  readonly code: RuleEvaluationErrorCode
  readonly platformCode: ErrorCode
  readonly httpStatus: number

  constructor(code: RuleEvaluationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RuleEvaluationError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
    this.httpStatus = HTTP_STATUS[code]
  }
}

export function isRuleEvaluationError(value: unknown): value is RuleEvaluationError {
  return value instanceof RuleEvaluationError
}
