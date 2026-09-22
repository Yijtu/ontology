export type DraftVerificationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'INVALID_DRAFT'
  | 'EVIDENCE_READ_FAILED'

export class DraftVerificationError extends Error {
  readonly code: DraftVerificationErrorCode

  constructor(code: DraftVerificationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DraftVerificationError'
    this.code = code
  }
}

export function isDraftVerificationError(value: unknown): value is DraftVerificationError {
  return value instanceof DraftVerificationError
}
