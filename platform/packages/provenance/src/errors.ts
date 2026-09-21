/**
 * Provenance errors keep a stable, classified code. `ARTIFACT_NOT_AUTHORIZED`
 * is intentionally the only "cannot read this artifact" code so an unauthorized
 * reference is indistinguishable from a missing one at the service boundary.
 */
export type ProvenanceErrorCode =
  | 'SCOPE_MISMATCH'
  | 'INVALID_SOURCE_LOCATION'
  | 'ARTIFACT_NOT_AUTHORIZED'
  | 'ARTIFACT_READER_NOT_CONFIGURED'
  | 'PROVENANCE_PERSIST_FAILED'

export class ProvenanceError extends Error {
  readonly code: ProvenanceErrorCode

  constructor(code: ProvenanceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProvenanceError'
    this.code = code
  }
}
