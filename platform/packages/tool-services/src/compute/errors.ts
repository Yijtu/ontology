import type { ErrorCode } from '@ontology/contracts'

/**
 * Explicit, classified blocks raised by the registered compute execution service (SPEC v0.3a
 * §EX-6, §5.3). Each code maps onto a published catalogue entry so the wire contract stays
 * stable, and each carries a `retryable` flag so a caller knows whether an unmodified retry of
 * the same logical action can succeed or whether the fixed input/binding must change first.
 */
export type ComputeExecutionErrorCode =
  | 'COMPUTE_INPUT_MISSING'
  | 'COMPUTE_FUNCTION_UNBOUND'
  | 'COMPUTE_CONTRACT_MISMATCH'
  | 'COMPUTE_PARAMETERS_INVALID'
  | 'COMPUTE_FUNCTION_FAILED'
  | 'COMPUTE_EXECUTION_IN_PROGRESS'
  | 'COMPUTE_OUTCOME_UNKNOWN'
  | 'COMPUTE_SCOPE_MISMATCH'

interface ComputeExecutionErrorDescriptor {
  readonly platformCode: ErrorCode
  readonly retryable: boolean
}

const DESCRIPTORS: Readonly<Record<ComputeExecutionErrorCode, ComputeExecutionErrorDescriptor>> = {
  COMPUTE_INPUT_MISSING: { platformCode: 'INVALID_ARGUMENT', retryable: false },
  COMPUTE_FUNCTION_UNBOUND: { platformCode: 'CAPABILITY_NOT_CONFIGURED', retryable: false },
  COMPUTE_CONTRACT_MISMATCH: { platformCode: 'PROFILE_INCOMPATIBLE', retryable: false },
  COMPUTE_PARAMETERS_INVALID: { platformCode: 'INVALID_ARGUMENT', retryable: false },
  COMPUTE_FUNCTION_FAILED: { platformCode: 'INTERNAL_ERROR', retryable: true },
  COMPUTE_EXECUTION_IN_PROGRESS: { platformCode: 'IDEMPOTENCY_CONFLICT', retryable: true },
  COMPUTE_OUTCOME_UNKNOWN: { platformCode: 'INTERNAL_ERROR', retryable: false },
  COMPUTE_SCOPE_MISMATCH: { platformCode: 'FORBIDDEN', retryable: false },
}

export class ComputeExecutionError extends Error {
  readonly code: ComputeExecutionErrorCode
  readonly platformCode: ErrorCode
  readonly retryable: boolean

  constructor(
    code: ComputeExecutionErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly retryable?: boolean
      readonly platformCode?: ErrorCode
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ComputeExecutionError'
    this.code = code
    const descriptor = DESCRIPTORS[code]
    this.platformCode = options?.platformCode ?? descriptor.platformCode
    this.retryable = options?.retryable ?? descriptor.retryable
  }
}

export function isComputeExecutionError(value: unknown): value is ComputeExecutionError {
  return value instanceof ComputeExecutionError
}
