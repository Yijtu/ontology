/**
 * Control-storage errors keep a stable, classified code so callers can map them
 * to the C6.2 error table instead of inspecting messages.
 */
export type ControlStorageErrorCode =
  | 'SCOPE_MISMATCH'
  | 'PROJECTION_NOT_FOUND'
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_OPERATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'LOCAL_DEV_PRINCIPAL_NOT_ALLOWED'

export class ControlStorageError extends Error {
  readonly code: ControlStorageErrorCode

  constructor(code: ControlStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ControlStorageError'
    this.code = code
  }
}
