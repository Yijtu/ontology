import type { StructuredParseIssue } from '@ontology/contracts'

/**
 * Classified structured-ingestion failures. A document the parser rejects raises; a document
 * it only partly captured returns an explicit `incomplete` result instead. Neither path ever
 * turns into an empty "success" (SPEC D4.1/§9).
 */
export type StructuredIngestionErrorCode =
  | 'INVALID_REQUEST'
  | 'SCOPE_MISMATCH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'ORIGINAL_UNREADABLE'
  | 'PARSE_REJECTED'
  | 'PARSE_STORE_FAILED'

export interface StructuredIngestionErrorOptions extends ErrorOptions {
  /** Parser diagnostics for a rejected parse, so the caller can report the located reason. */
  readonly issues?: readonly StructuredParseIssue[]
}

export class StructuredIngestionError extends Error {
  readonly code: StructuredIngestionErrorCode
  readonly issues: readonly StructuredParseIssue[]

  constructor(code: StructuredIngestionErrorCode, message: string, options?: StructuredIngestionErrorOptions) {
    super(message, options)
    this.name = 'StructuredIngestionError'
    this.code = code
    this.issues = options?.issues ?? []
  }
}
