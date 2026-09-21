import { createHash } from 'node:crypto'

/**
 * Content digest format shared with `Sha256Digest`: the algorithm is prefixed so
 * the scheme can evolve without ambiguity. The object key is the bare hex part,
 * so a digest string can never escape the object directory.
 */
export const SHA256_PREFIX = 'sha256:'

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

export function sha256Digest(content: Uint8Array): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(content).digest('hex')}`
}

export function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST.test(value)
}

/** Bare lowercase hex for a validated digest; used as the on-disk object key. */
export function objectKeyForDigest(digest: string): string {
  return digest.slice(SHA256_PREFIX.length)
}
