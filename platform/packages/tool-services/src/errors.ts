import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode, FieldError, PlatformError } from '@ontology/contracts'

/**
 * Gateway-level refusal codes (C4, ADR-04/ADR-11, C6.2).
 *
 * These are the reasons a model-proposed call is rejected before, or instead of,
 * becoming a traceable success. They are deliberately not the canonical `ErrorCode`
 * union: several of them (an unregistered compute operation, a call to a controller
 * service) are gateway policy, and mapping them to the published catalogue keeps the
 * wire contract stable without inventing new public error names.
 */
export type ToolGatewayErrorCode =
  | 'UNKNOWN_TOOL'
  | 'CONTROLLER_SERVICE_NOT_CALLABLE'
  | 'TOOL_NOT_ENABLED'
  | 'INVALID_ARGUMENTS'
  | 'MALICIOUS_ARGUMENTS'
  | 'UNKNOWN_COMPUTE_OPERATION'
  | 'OPERATION_NOT_ENABLED'
  | 'RESOURCE_NOT_ALLOWED'
  | 'LIMIT_EXCEEDED'
  | 'BUDGET_DENIED'
  | 'INTENT_NOT_RECORDED'
  | 'EVIDENCE_PERSIST_FAILED'
  | 'SETTLEMENT_FAILED'
  | 'HANDLER_NOT_REGISTERED'
  | 'HANDLER_FAILED'
  | 'INVALID_CALL'
  | 'UNTRUSTED_CONTEXT'
  | 'SCOPE_MISMATCH'
  | 'OUTCOME_INVALID'

const PLATFORM_CODE: Readonly<Record<ToolGatewayErrorCode, ErrorCode>> = {
  UNKNOWN_TOOL: 'INVALID_ARGUMENT',
  CONTROLLER_SERVICE_NOT_CALLABLE: 'FORBIDDEN',
  TOOL_NOT_ENABLED: 'CAPABILITY_NOT_CONFIGURED',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENT',
  MALICIOUS_ARGUMENTS: 'INVALID_ARGUMENT',
  UNKNOWN_COMPUTE_OPERATION: 'CAPABILITY_NOT_CONFIGURED',
  OPERATION_NOT_ENABLED: 'CAPABILITY_NOT_CONFIGURED',
  RESOURCE_NOT_ALLOWED: 'FORBIDDEN',
  LIMIT_EXCEEDED: 'RESULT_TOO_LARGE',
  BUDGET_DENIED: 'BUDGET_EXHAUSTED',
  INTENT_NOT_RECORDED: 'INTERNAL_ERROR',
  EVIDENCE_PERSIST_FAILED: 'EVIDENCE_PERSIST_FAILED',
  SETTLEMENT_FAILED: 'INTERNAL_ERROR',
  HANDLER_NOT_REGISTERED: 'INTERNAL_ERROR',
  HANDLER_FAILED: 'INTERNAL_ERROR',
  INVALID_CALL: 'INVALID_ARGUMENT',
  UNTRUSTED_CONTEXT: 'FORBIDDEN',
  SCOPE_MISMATCH: 'FORBIDDEN',
  OUTCOME_INVALID: 'INTERNAL_ERROR',
}

const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = Object.fromEntries(
  Object.entries(ERROR_CATALOG).map(([code, descriptor]) => [code, descriptor.retryable !== 'never']),
) as Readonly<Record<ErrorCode, boolean>>

/**
 * A classified refusal raised by the gateway. `code` is the gateway policy reason;
 * `platformCode` is the canonical catalogue entry the wire result reports. It never
 * carries a secret, credential or full customer payload.
 *
 * `remoteStateUnknown` marks a failure where the remote call may already have taken
 * effect (a timeout or a dropped connection after send). The gateway settles such a
 * reservation as `usage_unknown` instead of a free failure, so the estimate stays held.
 */
export class ToolGatewayError extends Error {
  readonly code: ToolGatewayErrorCode
  readonly platformCode: ErrorCode
  readonly retryable: boolean
  readonly fieldErrors: readonly FieldError[]
  readonly remoteStateUnknown: boolean

  constructor(
    code: ToolGatewayErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly fieldErrors?: readonly FieldError[]
      /** Override the catalogue entry, e.g. report a specific budget denial code. */
      readonly platformCode?: ErrorCode
      /** True when the remote may already have been billed. */
      readonly remoteStateUnknown?: boolean
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ToolGatewayError'
    this.code = code
    this.platformCode = options?.platformCode ?? PLATFORM_CODE[code]
    this.retryable = RETRYABLE[this.platformCode]
    this.fieldErrors = options?.fieldErrors ?? []
    this.remoteStateUnknown = options?.remoteStateUnknown ?? false
  }
}

export function isToolGatewayError(value: unknown): value is ToolGatewayError {
  return value instanceof ToolGatewayError
}

/** Project a refusal onto the canonical `PlatformError` wire shape. */
export function toPlatformError(error: ToolGatewayError, traceId: string): PlatformError {
  const platformError: PlatformError = {
    code: error.platformCode,
    message: error.message,
    retryable: error.retryable,
    traceId,
    ...(error.remoteStateUnknown ? { remoteStateUnknown: true } : {}),
  }
  if (error.fieldErrors.length === 0) return platformError
  return { ...platformError, fieldErrors: [...error.fieldErrors] }
}
