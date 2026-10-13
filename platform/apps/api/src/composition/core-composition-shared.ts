import { createHash } from 'node:crypto'
import type { ResourceRef, SourceRef, Uuid, VersionRef } from '@ontology/contracts'

/** Small pure predicates/keys shared by the Core composition assembly modules. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sourceKey(sourceRef: SourceRef): string {
  return `${sourceRef.namespace}\u0000${sourceRef.sourceId}`
}

export function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

/** A full-reference key, so a runtime selector cannot match a same-id sibling of another version/digest. */
export function versionRefKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

export function sameResourceRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

export function stableUuid(seed: string): Uuid {
  const chars = [...createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
