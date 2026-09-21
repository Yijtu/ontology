import type {
  ComponentVersionRecord,
  IndustryManifest,
  MissingCapability,
  ModuleLifecycleState,
  PreflightResult,
  ProfileRef,
  ProfileSpec,
  ResolvedCapability,
  ResolvedProfile,
  Rfc3339UtcTimestamp,
  Semver,
  Sha256Digest,
  VersionRef,
} from './generated/contracts'
import { isValidContractRange, satisfiesContractRange } from './semver'

/**
 * C1 preflight algorithm, expressed as pure contract resolution.
 *
 * Steps: validate declared ranges -> reject retired bound versions -> check every required
 * capability -> check logical roles have a mapping -> produce a resolved profile or an
 * explicit missing-capabilities list. A required capability is never silently dropped by
 * intersecting it with what happens to be available; if it does not resolve it is reported.
 */
export interface PreflightInput {
  readonly profileRef: ProfileRef
  readonly profile: ProfileSpec
  readonly industryManifest: IndustryManifest
  readonly components: readonly ComponentVersionRecord[]
  readonly availableCapabilities: readonly ResolvedCapability[]
  readonly outputVersion: Semver
  readonly outputDigest: Sha256Digest
  readonly snapshotHash: Sha256Digest
  readonly checkedAt: Rfc3339UtcTimestamp
  readonly resolvedAt: Rfc3339UtcTimestamp
}

function sameRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}

function refKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}`
}

/** Every exact artifact a profile pins, so preflight can prove none of them is retired. */
export function boundVersionRefs(profile: ProfileSpec): VersionRef[] {
  const refs: VersionRef[] = [profile.industryRef, profile.runtimeRef, profile.policyRef]
  for (const mapping of profile.mappingRefs) {
    refs.push({ id: mapping.id, version: mapping.version, digest: mapping.digest })
  }
  for (const binding of Object.values(profile.backendBindings)) {
    if (binding !== undefined) refs.push(binding.adapterRef)
  }
  for (const binding of Object.values(profile.modelBindings)) {
    if (binding !== undefined) refs.push(binding.modelRef)
  }
  for (const binding of profile.computeBindings) {
    refs.push(binding.handlerRef, binding.inputSchemaRef, binding.outputSchemaRef)
  }
  return refs
}

function dedupeRefs(refs: readonly VersionRef[]): VersionRef[] {
  const seen = new Set<string>()
  const out: VersionRef[] = []
  for (const ref of refs) {
    const key = `${refKey(ref)}#${ref.digest}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

export function preflightProfile(input: PreflightInput): PreflightResult {
  const incompatibleReasons: string[] = []

  for (const requirement of input.industryManifest.requiredCapabilities) {
    if (!isValidContractRange(requirement.versionRange)) {
      incompatibleReasons.push(
        `capability ${requirement.name} declares an invalid contract range [${requirement.versionRange.min}, ${requirement.versionRange.max ?? 'inf'})`,
      )
    }
  }
  for (const component of input.components) {
    if (!isValidContractRange(component.manifest.contractRange)) {
      incompatibleReasons.push(
        `component ${component.manifest.id}@${component.manifest.version} declares an invalid contract range`,
      )
    }
  }

  const retired = new Set(
    input.components
      .filter((component) => component.lifecycleState === 'retired')
      .map((component) => refKey(component.manifestRef)),
  )
  for (const ref of dedupeRefs(boundVersionRefs(input.profile))) {
    if (retired.has(refKey(ref))) {
      incompatibleReasons.push(`bound version ${refKey(ref)} is retired and cannot be activated`)
    }
  }

  // The binding key is the logical role; a binding whose declared role disagrees with its
  // key would be resolved under the wrong role, so it is rejected rather than guessed.
  for (const [role, binding] of Object.entries(input.profile.backendBindings)) {
    if (binding !== undefined && binding.role !== role) {
      incompatibleReasons.push(
        `backend binding key ${role} does not match declared role ${binding.role}`,
      )
    }
  }
  for (const [role, binding] of Object.entries(input.profile.modelBindings)) {
    if (binding !== undefined && binding.role !== role) {
      incompatibleReasons.push(`model binding key ${role} does not match declared role ${binding.role}`)
    }
  }

  const mappedRoles = new Set<string>(input.profile.mappingRefs.map((mapping) => mapping.role))
  for (const role of Object.keys(input.profile.backendBindings)) {
    if (!mappedRoles.has(role)) {
      incompatibleReasons.push(`backend role ${role} has no mapping ref; physical addressing is unresolved`)
    }
  }

  const declaredOperations = new Set(
    input.industryManifest.operationRefs?.map((operation) => `${operation.id}@${operation.version}`) ?? [],
  )
  const enabledOperations = new Set(
    input.profile.computeBindings
      .filter((binding) => binding.enabled)
      .map((binding) => `${binding.operationRef.id}@${binding.operationRef.version}`),
  )
  for (const operation of declaredOperations) {
    if (!enabledOperations.has(operation)) {
      incompatibleReasons.push(`declared operation ${operation} has no enabled compute binding`)
    }
  }

  const missingCapabilities: MissingCapability[] = []
  const resolvedCapabilities: ResolvedCapability[] = []

  for (const requirement of input.industryManifest.requiredCapabilities) {
    const match = input.availableCapabilities.find(
      (capability) =>
        capability.name === requirement.name &&
        satisfiesContractRange(requirement.versionRange, capability.version) &&
        !retired.has(refKey(capability.sourceComponentRef)),
    )
    if (match === undefined) {
      missingCapabilities.push({
        name: requirement.name,
        versionRange: requirement.versionRange,
        requiredBy: input.profile.industryRef,
      })
      continue
    }
    resolvedCapabilities.push(match)
  }

  if (missingCapabilities.length > 0 || incompatibleReasons.length > 0) {
    return {
      status: incompatibleReasons.length > 0 ? 'incompatible' : 'missing_capabilities',
      profileRef: input.profileRef,
      outputVersion: input.outputVersion,
      outputDigest: input.outputDigest,
      checkedAt: input.checkedAt,
      ...(missingCapabilities.length > 0 ? { missingCapabilities } : {}),
      ...(incompatibleReasons.length > 0 ? { incompatibleReasons } : {}),
    }
  }

  const resolvedVersions = dedupeRefs([
    ...boundVersionRefs(input.profile),
    ...resolvedCapabilities.map((capability) => capability.sourceComponentRef),
  ])

  const resolvedProfile: ResolvedProfile = {
    ...input.profile,
    resolvedVersions,
    resolvedCapabilities,
    explicitDegradations: [],
    snapshotHash: input.snapshotHash,
    resolvedAt: input.resolvedAt,
  }

  return {
    status: 'resolved',
    profileRef: input.profileRef,
    outputVersion: input.outputVersion,
    outputDigest: input.outputDigest,
    checkedAt: input.checkedAt,
    resolvedProfile,
  }
}

const LIFECYCLE_TRANSITIONS: Readonly<Record<ModuleLifecycleState, readonly ModuleLifecycleState[]>> = {
  registered: ['validated'],
  validated: ['active'],
  active: ['deprecated'],
  deprecated: ['retired'],
  retired: [],
}

/** Allowed lifecycle moves: registered -> validated -> active -> deprecated -> retired. */
export function nextLifecycleStates(from: ModuleLifecycleState): readonly ModuleLifecycleState[] {
  return LIFECYCLE_TRANSITIONS[from]
}

export function canTransitionLifecycle(from: ModuleLifecycleState, to: ModuleLifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to)
}

/**
 * A version referenced by an active run can never be retired. Retiring is only reachable
 * from `deprecated`, and only when no active run pins that exact id+version.
 */
export function canRetireComponentVersion(
  record: ComponentVersionRecord,
  activeRunVersionRefs: readonly VersionRef[],
): boolean {
  if (record.lifecycleState !== 'deprecated') return false
  return !activeRunVersionRefs.some((ref) => sameRef(ref, record.manifestRef))
}
