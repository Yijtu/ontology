import { createHash } from 'node:crypto'
import type { Sha256Digest } from '@ontology/contracts'

/**
 * Deterministic serialization and small format predicates shared by validation and
 * digesting. Key ordering is canonical so the digest of a definition version depends
 * only on its content, not on object insertion order.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const entry = source[key]
      if (entry === undefined) continue
      out[key] = canonicalize(entry)
    }
    return out
  }
  return value
}

/** Canonical JSON for hashing. Array order is preserved; object keys are sorted. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256DigestOf(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`
}

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_.-]*$/
const UNIT_CODE_PATTERN = /^(?:[A-Za-z][A-Za-z0-9_./%*^-]*|%)$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isNamespace(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && NAMESPACE_PATTERN.test(value)
}

export function isDefinitionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && IDENTIFIER_PATTERN.test(value)
}

export function isUnitCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && UNIT_CODE_PATTERN.test(value)
}

export function isSha256DigestValue(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function isSemverValue(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

/** Identity of one definition inside a version: the kind plus the id. */
export function definitionKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`
}

export function definitionRefKey(ref: { readonly id: string; readonly version: string }): string {
  return `${ref.id}@${ref.version}`
}
