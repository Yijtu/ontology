import { createHash } from 'node:crypto'
import type {
  BackendBinding,
  ExplicitDegradation,
  ModelBinding,
  ProfileRef,
  ProfileSpec,
  ResolvedCapability,
  ResolvedProfile,
  Sha256Digest,
  VersionRef,
} from '@ontology/contracts'

/**
 * Deterministic content hashing for profiles (C1 "精确保存版本与 hash").
 *
 * The resolved manifest is content-addressed: the same resolved set must always produce
 * the same `snapshotHash`, and a different resolved set must produce a different one. To
 * make that true the canonical form excludes timestamps (`resolvedAt`) and sorts every
 * collection by a stable key, so neither wall-clock time nor input ordering can perturb
 * the hash.
 */

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    out[key] = sortValue(source[key])
  }
  return out
}

/** Stable JSON: object keys sorted recursively, arrays left in their given (already sorted) order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function sha256DigestOf(value: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function refKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareText(key(left), key(right)))
}

function sortBindings<T extends { readonly role: string }>(
  bindings: Readonly<Record<string, T | undefined>>,
): T[] {
  return sortBy(
    Object.values(bindings).filter((binding): binding is T => binding !== undefined),
    (binding) => binding.role,
  )
}

function capabilityKey(capability: ResolvedCapability): string {
  return `${capability.name}@${capability.version}#${refKey(capability.sourceComponentRef)}`
}

function degradationKey(degradation: ExplicitDegradation): string {
  return `${degradation.capability}@${degradation.reason}@${degradation.fallback}`
}

function specContent(spec: ProfileSpec): Record<string, unknown> {
  return {
    industryRef: spec.industryRef,
    mappingRefs: sortBy(spec.mappingRefs, (mapping) => `${mapping.role}@${refKey(mapping)}`),
    runtimeRef: spec.runtimeRef,
    backendBindings: sortBindings<BackendBinding>(spec.backendBindings),
    modelBindings: sortBindings<ModelBinding>(spec.modelBindings),
    toolBindings: sortBy(spec.toolBindings, (binding) => binding.toolId),
    computeBindings: sortBy(
      spec.computeBindings,
      (binding) => `${binding.operationRef.id}@${binding.operationRef.version}`,
    ),
    policyRef: spec.policyRef,
  }
}

/** Content digest of a published ProfileSpec; pins exactly the declaration, not its identity. */
export function profileSpecDigest(spec: ProfileSpec): Sha256Digest {
  return sha256DigestOf(canonicalJson(specContent(spec)))
}

function resolvedContent(profileRef: ProfileRef, resolved: ResolvedProfile): Record<string, unknown> {
  return {
    profileRef: { id: profileRef.id, version: profileRef.version },
    ...specContent(resolved),
    resolvedVersions: sortBy(resolved.resolvedVersions, refKey),
    resolvedCapabilities: sortBy(resolved.resolvedCapabilities, capabilityKey),
    explicitDegradations: sortBy(resolved.explicitDegradations, degradationKey),
  }
}

/**
 * Content hash of a resolved manifest. Timestamps and ordering are excluded, so an
 * identical resolved set hashes identically and a different set cannot collide.
 */
export function resolvedProfileDigest(profileRef: ProfileRef, resolved: ResolvedProfile): Sha256Digest {
  return sha256DigestOf(canonicalJson(resolvedContent(profileRef, resolved)))
}
