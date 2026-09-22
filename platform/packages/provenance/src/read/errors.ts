import type { ErrorCode } from '@ontology/contracts'

/**
 * Classified provenance/history read failures (SPEC C6, §8).
 *
 * Every code carries an explicit HTTP status so the shared C6 error boundary renders it
 * without re-deriving the mapping. `EVIDENCE_NOT_FOUND` deliberately covers both "does not
 * exist" and "not authorized in this scope": an unauthorized reference must be
 * indistinguishable from a missing one so a cross-tenant caller learns nothing (C6, D3.2).
 */
export type ProvenanceReadErrorCode =
  | 'SCOPE_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_CURSOR'
  | 'EVIDENCE_NOT_FOUND'
  | 'ARTIFACT_READER_NOT_CONFIGURED'
  | 'HISTORY_READ_FAILED'

const PLATFORM_CODE: Readonly<Record<ProvenanceReadErrorCode, ErrorCode>> = {
  SCOPE_MISMATCH: 'FORBIDDEN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_CURSOR: 'INVALID_ARGUMENT',
  EVIDENCE_NOT_FOUND: 'INVALID_ARGUMENT',
  ARTIFACT_READER_NOT_CONFIGURED: 'CAPABILITY_NOT_CONFIGURED',
  HISTORY_READ_FAILED: 'SOURCE_UNAVAILABLE',
}

const HTTP_STATUS: Readonly<Record<ProvenanceReadErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  INVALID_ARGUMENT: 400,
  INVALID_CURSOR: 400,
  EVIDENCE_NOT_FOUND: 404,
  ARTIFACT_READER_NOT_CONFIGURED: 409,
  HISTORY_READ_FAILED: 503,
}

export class ProvenanceReadError extends Error {
  readonly code: ProvenanceReadErrorCode
  readonly platformCode: ErrorCode
  readonly httpStatus: number

  constructor(code: ProvenanceReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProvenanceReadError'
    this.code = code
    this.platformCode = PLATFORM_CODE[code]
    this.httpStatus = HTTP_STATUS[code]
  }
}

export function isProvenanceReadError(value: unknown): value is ProvenanceReadError {
  return value instanceof ProvenanceReadError
}
