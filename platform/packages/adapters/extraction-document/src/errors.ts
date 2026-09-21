/**
 * Classified extraction failures. Nothing is swallowed into an empty result:
 * a document that cannot be parsed at all raises, and a document that is only
 * partly parsed returns an explicit `partial` coverage instead.
 */
export type DocumentExtractionErrorCode =
  | 'INVALID_REQUEST'
  | 'SCOPE_MISMATCH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'ORIGINAL_UNREADABLE'
  | 'DOCUMENT_PARSE_FAILED'
  | 'DOCUMENT_NOT_PARSED'
  | 'OCR_UNAVAILABLE'
  | 'SPAN_OUT_OF_RANGE'
  | 'SPAN_STORE_FAILED'

export class DocumentExtractionError extends Error {
  readonly code: DocumentExtractionErrorCode

  constructor(code: DocumentExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentExtractionError'
    this.code = code
  }
}
