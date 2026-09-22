import { createHash } from 'node:crypto'
import type { Sha256Digest, Uuid } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

export { canonicalJson, sha256DigestOf }

/**
 * Derive a stable candidate id from its idempotency key. The key already covers the job,
 * the chunk and the canonical value, so a replayed stage produces the same id and the
 * candidate store treats it as the same row. Formatting the digest as a UUID keeps the id
 * valid for a `uuid` column while staying deterministic across processes.
 */
export function candidateIdFor(idempotencyKey: Sha256Digest): Uuid {
  const hex = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex').slice(0, 32)
  const chars = hex.split('')
  chars[12] = '5'
  chars[16] = '8'
  const joined = chars.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`
}
