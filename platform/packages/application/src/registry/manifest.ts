import type { ComponentManifest, FieldError, Sha256Digest } from '@ontology/contracts'
import { isValidContractRange, tryParseSemver } from '@ontology/contracts'

export interface ManifestValidationIssue {
  /** JSON-pointer-ish location of the rejected field. */
  readonly pointer: string
  readonly message: string
}

export interface ManifestValidationResult {
  readonly valid: boolean
  readonly issues: readonly ManifestValidationIssue[]
}

/**
 * Runtime manifest validator. The composition root injects the canonical JSON-Schema
 * validator (built from `@ontology/contracts`'s `SCHEMA_DOCUMENTS`); the application
 * layer never depends on a schema library, and a host that swaps the schema cannot
 * silently weaken registration because the semantic checks below always run.
 */
export type ManifestValidator = (manifest: unknown) => ManifestValidationResult

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const NAMESPACE = /^[a-z][a-z0-9-]*$/
const NETWORK_URL = /:\/\//
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/])/

/** Mirrors the canonical `Sha256Digest` pattern without pulling in a schema library. */
export function isSha256DigestValue(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_DIGEST.test(value)
}

/**
 * Checks the canonical schema cannot express, or that must hold even for a caller
 * supplying a hand-written validator: range ordering (JSON Schema has no comparison),
 * the non-empty `provides` list, duplicate capability names and the "no inline code /
 * no network download" entrypoint rule from C1.
 *
 * The argument is typed, but a caller can hand a non-conforming object at runtime, so
 * every access is guarded instead of trusting the type.
 */
export function validateComponentManifestSemantics(
  manifest: ComponentManifest,
): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = []

  if (typeof manifest.id !== 'string' || manifest.id.trim().length === 0) {
    issues.push({ pointer: '/id', message: 'id must be a non-empty string' })
  }
  if (typeof manifest.version !== 'string' || tryParseSemver(manifest.version) === undefined) {
    issues.push({ pointer: '/version', message: 'version must be a semver string' })
  }
  if (typeof manifest.digest !== 'string' || !SHA256_DIGEST.test(manifest.digest)) {
    issues.push({ pointer: '/digest', message: 'digest must be sha256:<64 lowercase hex>' })
  }
  if (
    typeof manifest.contractRange !== 'object' ||
    manifest.contractRange === null ||
    !isValidContractRange(manifest.contractRange)
  ) {
    issues.push({
      pointer: '/contractRange',
      message: 'contractRange must be a well-formed half-open [min, max) range',
    })
  }

  const provides = Array.isArray(manifest.provides) ? manifest.provides : []
  if (provides.length === 0) {
    issues.push({ pointer: '/provides', message: 'a component must provide at least one capability' })
  }
  const capabilityNames = new Set<string>()
  provides.forEach((capability, index) => {
    const pointer = `/provides/${index}`
    if (typeof capability !== 'object' || capability === null) {
      issues.push({ pointer, message: 'a capability must be an object' })
      return
    }
    if (typeof capability.name !== 'string' || capability.name.trim().length === 0) {
      issues.push({ pointer: `${pointer}/name`, message: 'capability name must be a non-empty string' })
    } else if (capabilityNames.has(capability.name)) {
      issues.push({ pointer: `${pointer}/name`, message: `duplicate capability ${capability.name}` })
    } else {
      capabilityNames.add(capability.name)
    }
    if (typeof capability.version !== 'string' || tryParseSemver(capability.version) === undefined) {
      issues.push({ pointer: `${pointer}/version`, message: 'capability version must be a semver string' })
    }
    if (!Array.isArray(capability.supportedDataTypes) || capability.supportedDataTypes.length === 0) {
      issues.push({
        pointer: `${pointer}/supportedDataTypes`,
        message: 'a capability must declare at least one supported data type',
      })
    }
  })

  const requires = Array.isArray(manifest.requires) ? manifest.requires : []
  requires.forEach((requirement, index) => {
    if (typeof requirement !== 'object' || requirement === null) {
      issues.push({ pointer: `/requires/${index}`, message: 'a capability requirement must be an object' })
      return
    }
    if (
      typeof requirement.versionRange !== 'object' ||
      requirement.versionRange === null ||
      !isValidContractRange(requirement.versionRange)
    ) {
      issues.push({
        pointer: `/requires/${index}/versionRange`,
        message: 'a required capability range must be a well-formed half-open [min, max) range',
      })
    }
  })

  if (
    typeof manifest.entrypointRef !== 'object' ||
    manifest.entrypointRef === null ||
    typeof manifest.entrypointRef.ref !== 'string' ||
    manifest.entrypointRef.ref.trim().length === 0
  ) {
    issues.push({ pointer: '/entrypointRef/ref', message: 'entrypointRef.ref must be a non-empty string' })
  } else if (
    NETWORK_URL.test(manifest.entrypointRef.ref) ||
    ABSOLUTE_PATH.test(manifest.entrypointRef.ref)
  ) {
    issues.push({
      pointer: '/entrypointRef/ref',
      message:
        'entrypointRef must be a registry-resolved reference; a network URL or filesystem path would install code dynamically',
    })
  }

  if (manifest.namespace !== undefined && !NAMESPACE.test(manifest.namespace)) {
    issues.push({ pointer: '/namespace', message: 'namespace must match ^[a-z][a-z0-9-]*$' })
  }

  return issues
}

/** Map validation issues onto the canonical `FieldError` wire shape. */
export function toFieldErrors(issues: readonly ManifestValidationIssue[]): FieldError[] {
  return issues.map((issue) => ({ pointer: issue.pointer, reason: issue.message }))
}
