import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode, PlatformError } from '@ontology/contracts'

/**
 * Adapter-local classification for the Pi runtime. The catalogue is deliberately small:
 * it only names failures this adapter decides, and each one maps onto an existing
 * canonical `ErrorCode` (C6.2). No parallel platform vocabulary is invented here.
 */
export type PiRuntimeErrorCode =
  | 'UNTRUSTED_DEPENDENCIES'
  | 'INVALID_CONFIG'
  | 'CHECKPOINT_INCOMPATIBLE'
  | 'CHECKPOINT_INVALID'

const PLATFORM_CODE: Readonly<Record<PiRuntimeErrorCode, ErrorCode>> = {
  UNTRUSTED_DEPENDENCIES: 'FORBIDDEN',
  INVALID_CONFIG: 'INVALID_ARGUMENT',
  CHECKPOINT_INCOMPATIBLE: 'CHECKPOINT_INCOMPATIBLE',
  CHECKPOINT_INVALID: 'CHECKPOINT_INCOMPATIBLE',
}

export class PiRuntimeError extends Error {
  readonly code: PiRuntimeErrorCode
  readonly platformCode: ErrorCode

  constructor(code: PiRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PiRuntimeError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
  }
}

export function isPiRuntimeError(value: unknown): value is PiRuntimeError {
  return value instanceof PiRuntimeError
}

/**
 * Build the canonical `PlatformError` payload from the existing catalogue. `retryable`
 * is derived from the catalogue's retryability vocabulary so the runtime never re-derives
 * a mapping or weakens a "never retry" code into a retryable one.
 */
export function platformErrorFor(code: ErrorCode, message: string, traceId: string): PlatformError {
  const descriptor = ERROR_CATALOG[code]
  return {
    code,
    message,
    retryable: descriptor.retryable !== 'never',
    traceId,
  }
}
