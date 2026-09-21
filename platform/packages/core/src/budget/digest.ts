import { createHash } from 'node:crypto'

/**
 * Stable content digest for the budget audit ledger. The caller always builds the
 * payload object literal in a fixed key order, so the digest is reproducible and a
 * replayed reserve/settle appends the same idempotency key instead of a new event.
 */
export function sha256DigestOf(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}
