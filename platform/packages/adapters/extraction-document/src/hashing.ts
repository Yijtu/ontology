import { createHash } from 'node:crypto'
import type { Sha256Digest, Uuid } from '@ontology/contracts'

/**
 * Content hashing for parse artifacts. `application` owns the profile canonical
 * hashing; adapters may not import it, so this keeps the tiny amount of hashing
 * the parser needs next to the code that uses it.
 */

export function sha256DigestOfBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function sha256DigestOfText(text: string): Sha256Digest {
  return sha256DigestOfBytes(new TextEncoder().encode(text))
}

/**
 * Stable UUID derived from a seed. Parse ids and chunk ids are content-derived,
 * so re-running the same parse over the same bytes yields the same ids and a
 * retry cannot create a second logical parse of identical input.
 */
export function deterministicUuid(seed: string): Uuid {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`
}
