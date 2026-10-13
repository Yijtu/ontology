import { createHash } from 'node:crypto'
import type { Sha256Digest } from '@ontology/contracts'

/**
 * The kernel's single canonical JSON serializer and digest.
 *
 * Object keys are ordered by UTF-16 code unit (NOT `localeCompare`, which depends on the ICU
 * data of the running Node build). `undefined`-valued object entries are dropped, arrays keep
 * their order, and a non-object leaf falls back to `JSON.stringify` (so `undefined`/functions
 * serialize as `null`). This is the JCS-style semantics every layer must share: the digest of a
 * value must depend only on its content, never on insertion order or the host locale.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/** The SHA-256 of a value's canonical JSON. */
export function digestOfCanonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}
