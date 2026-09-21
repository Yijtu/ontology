/**
 * Immutable blob storage errors keep a stable, classified code so callers map
 * them to the C6.2 error table instead of inspecting messages.
 *
 * `BLOB_NOT_FOUND` is deliberately the only "cannot read this reference" error:
 * a caller whose tenant/space (or, for a checkpoint, run) does not own the
 * reference receives exactly the same error as a caller asking for content that
 * was never stored. That is what stops a cross-tenant lookup from learning
 * whether some other customer stored the bytes (D3.2).
 */
export type BlobStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'INVALID_REQUEST'
  | 'BLOB_NOT_FOUND'
  | 'BLOB_CONTENT_NOT_STAGED'
  | 'BLOB_DIGEST_MISMATCH'
  | 'BLOB_SIZE_MISMATCH'
  | 'BLOB_MEDIA_TYPE_CONFLICT'
  | 'BLOB_OBJECT_MISSING'
  | 'BLOB_INTEGRITY_MISMATCH'
  | 'BLOB_CHECKPOINT_RUN_REQUIRED'
  | 'BLOB_REGISTRY_FAILED'

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode

  constructor(code: BlobStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BlobStoreError'
    this.code = code
  }
}
