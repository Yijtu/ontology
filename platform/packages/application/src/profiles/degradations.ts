import type {
  ComponentVersionRecord,
  ExplicitDegradation,
  ProfileSpec,
  ResolvedCapability,
  VersionRef,
} from '@ontology/contracts'
import { refKey } from './canonical'

/**
 * Capability derivation and explicit-degradation recording (C1, US-002/FR-32).
 *
 * A capability is available only from a component that is actually active and not
 * revoked; an unprobed, retired or unimplemented component is never reported as
 * available. Anything the profile declares but cannot configure is recorded as a visible
 * degradation instead of being silently dropped or substituted.
 */

export function isComponentAvailable(record: ComponentVersionRecord): boolean {
  return record.lifecycleState === 'active' && record.manifest.trustStatus !== 'revoked'
}

/** Exact `id@version#digest` keys of the components a binding may resolve to. */
export function availableComponentKeys(records: readonly ComponentVersionRecord[]): Set<string> {
  const keys = new Set<string>()
  for (const record of records) {
    if (isComponentAvailable(record)) keys.add(refKey(record.manifestRef))
  }
  return keys
}

/** Flatten every provided capability of the available components, with its exact provider ref. */
export function capabilitiesFromComponents(
  records: readonly ComponentVersionRecord[],
): ResolvedCapability[] {
  const capabilities: ResolvedCapability[] = []
  for (const record of records) {
    if (!isComponentAvailable(record)) continue
    for (const capability of record.manifest.provides) {
      capabilities.push({ ...capability, sourceComponentRef: record.manifestRef })
    }
  }
  return capabilities
}

function degradation(
  capability: string,
  fallback: ExplicitDegradation['fallback'],
  fallbackReason: string,
): ExplicitDegradation {
  return { capability, reason: 'CAPABILITY_NOT_CONFIGURED', fallback, fallbackReason }
}

function isBound(ref: VersionRef, available: ReadonlySet<string>): boolean {
  return available.has(refKey(ref))
}

/**
 * Record every declared-but-not-configured part of the profile.
 *
 * A disabled binding is an allowed, declared reduction; a binding whose exact component
 * version is not registered/active is an unimplemented component that must stay visible
 * as `CAPABILITY_NOT_CONFIGURED`. In both cases the item is recorded here and never
 * appears in `resolvedCapabilities`.
 */
export function computeExplicitDegradations(
  profile: ProfileSpec,
  availableComponents: ReadonlySet<string>,
): ExplicitDegradation[] {
  const degradations: ExplicitDegradation[] = []

  for (const [role, binding] of Object.entries(profile.modelBindings)) {
    if (binding === undefined) continue
    const configured = binding.enabled && isBound(binding.modelRef, availableComponents)
    if (configured) continue
    degradations.push(
      degradation(
        `model:${role}`,
        binding.fallbackPolicy,
        binding.enabled
          ? `model ${binding.modelRef.id}@${binding.modelRef.version} is not configured; falling back to ${binding.fallbackPolicy}`
          : `model binding ${role} is disabled; falling back to ${binding.fallbackPolicy}`,
      ),
    )
  }

  for (const binding of profile.toolBindings) {
    if (binding.enabled) continue
    degradations.push(
      degradation(`tool:${binding.toolId}`, 'none', `tool binding ${binding.toolId} is disabled`),
    )
  }

  for (const binding of profile.computeBindings) {
    const configured = binding.enabled && isBound(binding.handlerRef, availableComponents)
    if (configured) continue
    const operation = `${binding.operationRef.id}@${binding.operationRef.version}`
    degradations.push(
      degradation(
        `compute:${operation}`,
        'none',
        binding.enabled
          ? `compute handler ${binding.handlerRef.id}@${binding.handlerRef.version} is not configured`
          : `compute binding ${operation} is disabled`,
      ),
    )
  }

  for (const [role, binding] of Object.entries(profile.backendBindings)) {
    if (binding === undefined) continue
    if (isBound(binding.adapterRef, availableComponents)) continue
    degradations.push(
      degradation(
        `backend:${role}`,
        'none',
        `backend adapter ${binding.adapterRef.id}@${binding.adapterRef.version} is not configured for role ${role}`,
      ),
    )
  }

  return degradations.sort((left, right) => {
    const key = (item: ExplicitDegradation): string => `${item.capability}@${item.reason}@${item.fallback}`
    if (key(left) < key(right)) return -1
    if (key(left) > key(right)) return 1
    return 0
  })
}
