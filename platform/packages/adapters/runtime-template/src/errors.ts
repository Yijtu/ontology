import { ERROR_CATALOG } from '@ontology/contracts'
import type { ErrorCode, PlatformError } from '@ontology/contracts'

/**
 * Adapter-local classification for the template runtime. The code catalogue is
 * deliberately small: it only names failures the runtime itself decides, and each one
 * maps onto an existing canonical `ErrorCode` (C6.2). No parallel platform vocabulary is
 * invented here.
 */
export type TemplateRuntimeErrorCode =
  | 'UNTRUSTED_DEPENDENCIES'
  | 'PLAN_NOT_FOUND'
  | 'INVALID_PLAN'
  | 'CHECKPOINT_INCOMPATIBLE'
  | 'CHECKPOINT_INVALID'

const PLATFORM_CODE: Readonly<Record<TemplateRuntimeErrorCode, ErrorCode>> = {
  UNTRUSTED_DEPENDENCIES: 'FORBIDDEN',
  PLAN_NOT_FOUND: 'INVALID_ARGUMENT',
  INVALID_PLAN: 'INVALID_SCHEMA',
  CHECKPOINT_INCOMPATIBLE: 'CHECKPOINT_INCOMPATIBLE',
  CHECKPOINT_INVALID: 'CHECKPOINT_INCOMPATIBLE',
}

export class TemplateRuntimeError extends Error {
  readonly code: TemplateRuntimeErrorCode
  readonly platformCode: ErrorCode

  constructor(code: TemplateRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TemplateRuntimeError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
  }
}

export function isTemplateRuntimeError(value: unknown): value is TemplateRuntimeError {
  return value instanceof TemplateRuntimeError
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
