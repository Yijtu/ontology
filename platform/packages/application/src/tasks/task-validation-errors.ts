/**
 * Failure codes for registered task validation policies and finalization (SPEC v0.3a
 * execution-evidence §EX-6.1).
 *
 * Every code is classified and carries an HTTP status so the API layer never guesses a
 * mapping, and a missing/failed/unknown/incomplete policy can never be reported as a
 * formal success.
 */
export type TaskValidationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'POLICY_REGISTRY_MISMATCH'
  | 'POLICY_NOT_REGISTERED'
  | 'POLICY_STAGE_UNSUPPORTED'
  | 'POLICY_REPORT_SCHEMA_UNSUPPORTED'
  | 'POLICY_HANDLER_NOT_BOUND'
  | 'POLICY_HANDLER_DIGEST_MISMATCH'
  | 'POLICY_CAPABILITY_NOT_CONFIGURED'
  | 'POLICY_REPORT_MISMATCH'
  | 'POLICY_REPORT_INVALID'
  | 'POLICY_REPORT_NOT_ARCHIVED'
  | 'POLICY_REPORT_TAMPERED'
  | 'POLICY_REPORT_UNBOUND'
  | 'TASK_HAS_NO_VALIDATION_POLICIES'
  | 'TASK_POLICY_REQUIRED_MISSING'
  | 'TASK_POLICY_NOT_PASSED'
  | 'FINALIZATION_ACYCLICITY_VIOLATION'
  | 'FINALIZATION_CONFLICT'

const HTTP_STATUS: Readonly<Record<TaskValidationErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  POLICY_REGISTRY_MISMATCH: 409,
  POLICY_NOT_REGISTERED: 409,
  POLICY_STAGE_UNSUPPORTED: 409,
  POLICY_REPORT_SCHEMA_UNSUPPORTED: 409,
  POLICY_HANDLER_NOT_BOUND: 409,
  POLICY_HANDLER_DIGEST_MISMATCH: 409,
  POLICY_CAPABILITY_NOT_CONFIGURED: 409,
  POLICY_REPORT_MISMATCH: 422,
  POLICY_REPORT_INVALID: 422,
  POLICY_REPORT_NOT_ARCHIVED: 409,
  POLICY_REPORT_TAMPERED: 422,
  POLICY_REPORT_UNBOUND: 422,
  TASK_HAS_NO_VALIDATION_POLICIES: 422,
  TASK_POLICY_REQUIRED_MISSING: 422,
  TASK_POLICY_NOT_PASSED: 422,
  FINALIZATION_ACYCLICITY_VIOLATION: 500,
  FINALIZATION_CONFLICT: 409,
}

export interface TaskValidationErrorOptions extends ErrorOptions {
  /** Concrete, actionable reasons (e.g. which required policy is missing) for a blocked result. */
  readonly reasons?: readonly string[]
}

/** Classified policy/finalization failure. It never degrades to an empty or partial success. */
export class TaskValidationError extends Error {
  readonly code: TaskValidationErrorCode
  readonly httpStatus: number
  readonly reasons: readonly string[] | undefined

  constructor(code: TaskValidationErrorCode, message: string, options?: TaskValidationErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TaskValidationError'
    this.code = code
    this.httpStatus = HTTP_STATUS[code]
    this.reasons = options?.reasons
  }
}

export function isTaskValidationError(value: unknown): value is TaskValidationError {
  return value instanceof TaskValidationError
}
