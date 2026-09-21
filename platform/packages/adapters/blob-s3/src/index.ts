/**
 * `blob-s3` is a reserved capability (ADR-08). This package deliberately ships
 * no S3 client and is never registered as supported: an S3-compatible backend
 * is only enabled once a deployment configures it and its contract suite passes.
 * Until then every entry point fails with an explicit `CAPABILITY_NOT_CONFIGURED`
 * so no caller can mistake the placeholder for working storage.
 */
export const S3_BLOB_CAPABILITY = {
  name: 'blob-s3',
  configured: false,
  reason:
    'S3-compatible immutable blob storage is reserved and not configured in this deployment',
} as const

export class S3BlobNotConfiguredError extends Error {
  readonly code = 'CAPABILITY_NOT_CONFIGURED'

  constructor(message = S3_BLOB_CAPABILITY.reason) {
    super(message)
    this.name = 'S3BlobNotConfiguredError'
  }
}

/**
 * There is intentionally no `BlobPort` implementation here. Calling this is a
 * programming error: it never falls back to a local store and never pretends to
 * have written anything.
 */
export function createS3BlobStore(): never {
  throw new S3BlobNotConfiguredError()
}
