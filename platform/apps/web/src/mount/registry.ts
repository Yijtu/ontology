import type { UiCapabilityMetadata, VersionRef } from '@ontology/contracts'
import type { FrontendScenarioModule, ScenarioModuleView } from './contract'

/**
 * The trusted scenario mount registry (SPEC v0.3a §9.3). A build composition registers the
 * compiled modules it ships; deployment/industry metadata only references a moduleRef. The
 * registry never executes metadata content — it validates the closed `UiCapabilityMetadata`
 * shape, matches it to a registered module and produces a data-only view projection.
 */

export interface MountContext {
  /** Capabilities the trusted request context actually grants. */
  readonly grantedCapabilities: readonly string[]
  /** Module refs the principal is authorized to mount; omit to skip the permission gate. */
  readonly allowedModuleRefs?: readonly VersionRef[]
  readonly readOnly?: boolean
}

export type ScenarioMount =
  | {
      readonly kind: 'mounted'
      readonly module: FrontendScenarioModule
      readonly view: ScenarioModuleView
      readonly readOnly: boolean
    }
  | { readonly kind: 'missing_module'; readonly moduleRef: VersionRef }
  | { readonly kind: 'missing_capability'; readonly moduleRef: VersionRef; readonly missing: readonly string[] }
  | { readonly kind: 'forbidden'; readonly moduleRef: VersionRef }
  | { readonly kind: 'illegal_metadata'; readonly reason: string }

function refKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^sha256:[0-9a-f]{64}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512
}

function isVersionRef(value: unknown): value is VersionRef {
  return (
    isObject(value) &&
    isNonEmptyString(value['id']) &&
    typeof value['version'] === 'string' &&
    SEMVER.test(value['version']) &&
    typeof value['digest'] === 'string' &&
    SHA256.test(value['digest'])
  )
}

const METADATA_KEYS = new Set(['moduleRef', 'taskBindingRefs', 'requiredCapabilities'])

/**
 * Runtime validation of the data-only declaration against mount.schema.json
 * (`additionalProperties: false`). Deployment/industry metadata is untrusted input: an extra
 * `script`, `url`, `bundle` or any other key is rejected rather than silently ignored.
 */
export function isLegalUiCapabilityMetadata(value: unknown): value is UiCapabilityMetadata {
  if (!isObject(value)) return false
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key)) return false
  }
  if (!isVersionRef(value['moduleRef'])) return false

  const taskBindingRefs = value['taskBindingRefs']
  if (!Array.isArray(taskBindingRefs) || !taskBindingRefs.every(isVersionRef)) return false

  const requiredCapabilities = value['requiredCapabilities']
  if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.every(isNonEmptyString)) return false
  if (new Set(requiredCapabilities).size !== requiredCapabilities.length) return false

  return true
}

export class ScenarioModuleRegistry {
  readonly #modules = new Map<string, FrontendScenarioModule>()

  /** Register a compiled module under its moduleRef id@version. */
  register(module: FrontendScenarioModule): void {
    this.#modules.set(refKey(module.ref), module)
  }

  has(ref: VersionRef): boolean {
    return this.#modules.has(refKey(ref))
  }

  resolve(ref: VersionRef): FrontendScenarioModule | undefined {
    return this.#modules.get(refKey(ref))
  }

  get size(): number {
    return this.#modules.size
  }

  /**
   * Resolve one declaration into a mount decision. Validation runs before any module lookup so
   * an illegal declaration never reveals whether a module exists.
   */
  mount(declaration: unknown, context: MountContext): ScenarioMount {
    if (!isLegalUiCapabilityMetadata(declaration)) {
      return { kind: 'illegal_metadata', reason: 'declaration is not a legal UiCapabilityMetadata shape' }
    }

    const moduleRef = declaration.moduleRef
    const allowed = context.allowedModuleRefs
    if (allowed !== undefined && !allowed.some((entry) => refKey(entry) === refKey(moduleRef))) {
      return { kind: 'forbidden', moduleRef }
    }

    const module = this.resolve(moduleRef)
    if (module === undefined) {
      return { kind: 'missing_module', moduleRef }
    }

    if (refKey(module.ref) !== refKey(moduleRef)) {
      return { kind: 'illegal_metadata', reason: 'registered module ref does not match the declaration' }
    }

    const granted = new Set(context.grantedCapabilities)
    const required = new Set([...declaration.requiredCapabilities, ...module.capabilityRequirements])
    const missing = [...required].filter((capability) => !granted.has(capability))
    if (missing.length > 0) {
      return { kind: 'missing_capability', moduleRef, missing }
    }

    return {
      kind: 'mounted',
      module,
      readOnly: context.readOnly === true,
      view: {
        moduleRef: module.ref,
        taskEntries: module.taskEntries,
        capabilityRequirements: module.capabilityRequirements,
        exporters: module.exporters ?? [],
        hasParameterPanel: module.ParameterPanel !== undefined,
        hasResultRenderer: module.ResultRenderer !== undefined,
      },
    }
  }
}
