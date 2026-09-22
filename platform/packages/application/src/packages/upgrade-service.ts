import type {
  ComponentKey,
  ComponentRegistryStore,
  ComponentVersionRecord,
  MappingRef,
  ProfileRef,
  ProfileSpec,
  ProfileStore,
  ProfileVersionRecord,
  ScopeRef,
  ToolContext,
  UpgradeAssessment,
  UpgradeBlocker,
  UpgradeBlockerCode,
  UpgradeOutcome,
  UpgradeRequest,
  UpgradeSlot,
  RetirementAssessment,
  RetirementBlockerCode,
  VersionRef,
} from '@ontology/contracts'
import { ComponentRegistry } from '../registry/component-registry'
import { ProfileResolver } from '../profiles/resolver'
import { IndustryPackError } from './errors'
import { assertRole, resolveTrustedScope } from './scope'

const UPGRADE_ROLES: readonly string[] = ['platform-admin', 'profile-editor']
const RETIRE_ROLES: readonly string[] = ['platform-admin']

export interface IndustryPackUpgradeDependencies {
  /** Publishes and preflights the new profile version; a binding change is always a new version. */
  readonly profiles: ProfileResolver
  /** Reads the immutable profile versions the upgrade starts from. */
  readonly profileStore: ProfileStore
  /** Enforces the component lifecycle and the active-run retirement guard. */
  readonly registry: ComponentRegistry
  /** Reads component versions and active references for the assessment. */
  readonly registryStore: ComponentRegistryStore
}

function profileLabel(ref: ProfileRef): string {
  return `${ref.id}@${ref.version}`
}

function componentLabel(key: ComponentKey): string {
  return `${key.kind}/${key.id}@${key.version}`
}

function describeSlot(slot: UpgradeSlot): string {
  switch (slot.kind) {
    case 'industry':
      return 'industry'
    case 'runtime':
      return 'runtime'
    case 'policy':
      return 'policy'
    case 'backend_binding':
      return `backend binding "${slot.role}"`
    case 'mapping':
      return `mapping "${slot.mappingId}"`
  }
}

function slotNotFound(slot: UpgradeSlot): IndustryPackError {
  return new IndustryPackError(
    'SLOT_NOT_FOUND',
    `the source profile has no ${describeSlot(slot)} binding to upgrade`,
  )
}

/** The exact version a slot currently pins, so the assessment can show from -> to. */
export function fromRefOf(spec: ProfileSpec, slot: UpgradeSlot): VersionRef {
  switch (slot.kind) {
    case 'industry':
      return spec.industryRef
    case 'runtime':
      return spec.runtimeRef
    case 'policy':
      return spec.policyRef
    case 'backend_binding': {
      const binding = spec.backendBindings[slot.role]
      if (binding === undefined) throw slotNotFound(slot)
      return binding.adapterRef
    }
    case 'mapping': {
      const mapping = spec.mappingRefs.find((entry) => entry.id === slot.mappingId)
      if (mapping === undefined) throw slotNotFound(slot)
      return { id: mapping.id, version: mapping.version, digest: mapping.digest }
    }
  }
}

/**
 * Apply a slot change to a copy of the spec. The result is a new `ProfileSpec`, which the
 * resolver publishes as a new immutable profile version — the old version, its resolved
 * manifests and every run pinned to them are untouched.
 */
export function applyUpgradeSlot(spec: ProfileSpec, request: UpgradeRequest): ProfileSpec {
  switch (request.slot.kind) {
    case 'industry':
      return { ...spec, industryRef: request.targetRef }
    case 'runtime':
      return { ...spec, runtimeRef: request.targetRef }
    case 'policy':
      return { ...spec, policyRef: request.targetRef }
    case 'backend_binding': {
      const binding = spec.backendBindings[request.slot.role]
      if (binding === undefined) throw slotNotFound(request.slot)
      return {
        ...spec,
        backendBindings: {
          ...spec.backendBindings,
          [request.slot.role]: { ...binding, adapterRef: request.targetRef },
        },
      }
    }
    case 'mapping': {
      const mappingId = request.slot.mappingId
      const existing = spec.mappingRefs.find((entry) => entry.id === mappingId)
      if (existing === undefined) throw slotNotFound(request.slot)
      const target: MappingRef | undefined = request.targetMappingRef
      if (target === undefined) {
        throw new IndustryPackError('INVALID_ARGUMENT', 'a mapping slot requires targetMappingRef')
      }
      if (
        target.id !== request.targetRef.id ||
        target.version !== request.targetRef.version ||
        target.digest !== request.targetRef.digest
      ) {
        throw new IndustryPackError(
          'INVALID_ARGUMENT',
          'targetMappingRef does not match targetRef id/version/digest',
        )
      }
      // The backend binding names the mapping it uses by id, so a replaced mapping must
      // update both the mapping list and the binding that referenced it.
      const backendBindings: ProfileSpec['backendBindings'] = {}
      for (const [role, binding] of Object.entries(spec.backendBindings)) {
        backendBindings[role] =
          binding !== undefined && binding.mappingRef === mappingId
            ? { ...binding, mappingRef: target.id }
            : binding
      }
      return {
        ...spec,
        mappingRefs: spec.mappingRefs.map((entry) => (entry.id === mappingId ? target : entry)),
        backendBindings,
      }
    }
  }
}

function summarizePublished(record: ProfileVersionRecord): NonNullable<UpgradeOutcome['published']> {
  return { profileRef: record.profileRef, digest: record.digest, createdAt: record.createdAt }
}

/**
 * Industry-pack compatibility upgrade and retirement (C1, FR-3/31/32, US-023).
 *
 * An upgrade only ever creates a new profile version: the source version, its resolved
 * manifests and every run pinned to them keep their exact versions. A version referenced by
 * an active run can never be retired, and a blocked upgrade or retirement always reports the
 * explicit reason plus whether it is recoverable.
 */
export class IndustryPackUpgradeService {
  readonly #profiles: ProfileResolver
  readonly #profileStore: ProfileStore
  readonly #registry: ComponentRegistry
  readonly #registryStore: ComponentRegistryStore

  constructor(dependencies: IndustryPackUpgradeDependencies) {
    this.#profiles = dependencies.profiles
    this.#profileStore = dependencies.profileStore
    this.#registry = dependencies.registry
    this.#registryStore = dependencies.registryStore
  }

  /**
   * Read-only feasibility check. It never writes: a blocked assessment carries the exact
   * blockers with `recoverable`/`nextAction`, and an applicable one means the target version
   * is a known component that is neither retired nor digest-mismatched.
   */
  async assessUpgrade(request: UpgradeRequest, ctx: ToolContext): Promise<UpgradeAssessment> {
    resolveTrustedScope(request.scopeRef, ctx)
    const source = await this.#profileStore.findProfileVersion(
      request.sourceProfileRef,
      request.scopeRef,
      ctx,
    )
    if (source === undefined) {
      throw new IndustryPackError(
        'PROFILE_NOT_FOUND',
        `profile ${profileLabel(request.sourceProfileRef)} is not published in this scope`,
      )
    }
    if (source.spec.industryRef.id !== request.packId) {
      throw new IndustryPackError(
        'INVALID_ARGUMENT',
        `profile ${profileLabel(request.sourceProfileRef)} binds industry ${source.spec.industryRef.id}, not pack ${request.packId}`,
      )
    }
    const fromRef = fromRefOf(source.spec, request.slot)
    const blockers = await this.#targetBlockers(request, ctx)
    return {
      status: blockers.length === 0 ? 'applicable' : 'blocked',
      sourceProfileRef: request.sourceProfileRef,
      slot: request.slot,
      fromRef,
      targetRef: request.targetRef,
      blockers,
    }
  }

  async applyUpgrade(request: UpgradeRequest, ctx: ToolContext): Promise<UpgradeOutcome> {
    resolveTrustedScope(request.scopeRef, ctx)
    assertRole(ctx, UPGRADE_ROLES, 'upgrading an industry pack binding')

    const assessment = await this.assessUpgrade(request, ctx)
    if (assessment.status === 'blocked') {
      return { status: 'blocked', assessment, blockers: assessment.blockers }
    }

    const source = await this.#profileStore.findProfileVersion(
      request.sourceProfileRef,
      request.scopeRef,
      ctx,
    )
    if (source === undefined) {
      throw new IndustryPackError(
        'PROFILE_NOT_FOUND',
        `profile ${profileLabel(request.sourceProfileRef)} is not published in this scope`,
      )
    }

    const spec = applyUpgradeSlot(source.spec, request)
    const published = await this.#profiles.publish(
      { scopeRef: request.scopeRef, profileRef: request.targetProfileRef, spec, environment: source.environment },
      ctx,
    )
    const preflight = await this.#profiles.preflight(
      { scopeRef: request.scopeRef, profileRef: request.targetProfileRef },
      ctx,
    )
    if (preflight.status !== 'resolved') {
      const blocker: UpgradeBlocker<UpgradeBlockerCode> = {
        code: 'UPGRADE_PREFLIGHT_FAILED',
        message: `the upgraded profile ${profileLabel(request.targetProfileRef)} did not resolve (${preflight.status})`,
        recoverable: true,
        nextAction: 'fix the missing capability or incompatible binding and publish the next profile version',
      }
      return {
        status: 'blocked',
        assessment: { ...assessment, status: 'blocked', blockers: [blocker] },
        published: summarizePublished(published),
        preflightStatus: preflight.status,
        blockers: [blocker],
      }
    }
    return {
      status: 'applicable',
      assessment,
      published: summarizePublished(published),
      preflightStatus: 'resolved',
      blockers: [],
    }
  }

  /**
   * Whether a component version can be uninstalled (retired). A version referenced by an
   * active run is never removable; a retired version can never be resurrected.
   */
  async assessRetirement(
    key: ComponentKey,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<RetirementAssessment> {
    resolveTrustedScope(scopeRef, ctx)
    const record = await this.#registryStore.findVersion(key, scopeRef, ctx)
    if (record === undefined) {
      return {
        status: 'blocked',
        key,
        blockers: [
          {
            code: 'VERSION_NOT_FOUND',
            message: `component ${componentLabel(key)} is not registered`,
            recoverable: false,
            nextAction: 'register or publish the component version first',
          },
        ],
      }
    }

    const blockers: UpgradeBlocker<RetirementBlockerCode>[] = []
    if (record.lifecycleState === 'retired') {
      blockers.push({
        code: 'VERSION_ALREADY_RETIRED',
        message: `component ${componentLabel(key)} is already retired`,
        recoverable: false,
        nextAction: 'a retired version cannot be resurrected; publish a new version instead',
      })
    } else {
      if (record.lifecycleState !== 'deprecated') {
        blockers.push({
          code: 'VERSION_NOT_DEPRECATED',
          message: `component ${componentLabel(key)} is ${record.lifecycleState}, not deprecated`,
          recoverable: true,
          nextAction: 'move the version to deprecated first',
        })
      }
      const references = await this.#registryStore.listActiveReferences(scopeRef, key, ctx)
      if (references.length > 0) {
        blockers.push({
          code: 'ACTIVE_REFERENCE_EXISTS',
          message: `component ${componentLabel(key)} is referenced by ${references.length} active run(s)`,
          recoverable: true,
          nextAction: 'release every active run reference (or wait for the runs to finish) before retiring',
        })
      }
    }
    return { status: blockers.length === 0 ? 'removable' : 'blocked', key, blockers }
  }

  /**
   * Uninstall (retire) a component version. The registry re-checks the active-run guard
   * inside the same transition, so a reference acquired after the assessment still blocks it.
   */
  async retire(key: ComponentKey, scopeRef: ScopeRef, ctx: ToolContext): Promise<ComponentVersionRecord> {
    resolveTrustedScope(scopeRef, ctx)
    assertRole(ctx, RETIRE_ROLES, 'retiring a component version')

    const assessment = await this.assessRetirement(key, scopeRef, ctx)
    if (assessment.status === 'blocked') {
      throw new IndustryPackError(
        'RETIREMENT_BLOCKED',
        `component ${componentLabel(key)} cannot be retired`,
        {
          blockers: assessment.blockers,
          reasons: assessment.blockers.map((blocker) => blocker.message),
        },
      )
    }
    const record = await this.#registryStore.findVersion(key, scopeRef, ctx)
    if (record === undefined) {
      throw new IndustryPackError(
        'RETIREMENT_BLOCKED',
        `component ${componentLabel(key)} is not registered`,
      )
    }
    return this.#registry.transition(
      {
        scopeRef,
        kind: key.kind,
        ref: { id: key.id, version: key.version, digest: record.manifestRef.digest },
        to: 'retired',
      },
      ctx,
    )
  }

  async #targetBlockers(
    request: UpgradeRequest,
    ctx: ToolContext,
  ): Promise<readonly UpgradeBlocker<UpgradeBlockerCode>[]> {
    const components = await this.#registry.listComponents(request.scopeRef, {}, ctx)
    const match = components.find(
      (record) =>
        record.manifestRef.id === request.targetRef.id &&
        record.manifestRef.version === request.targetRef.version,
    )
    if (match === undefined) return []
    if (match.manifestRef.digest !== request.targetRef.digest) {
      return [
        {
          code: 'TARGET_VERSION_DIGEST_MISMATCH',
          message: `component ${request.targetRef.id}@${request.targetRef.version} is registered with digest ${match.manifestRef.digest}, not ${request.targetRef.digest}`,
          recoverable: true,
          nextAction: 'pin the exact digest of the registered version',
        },
      ]
    }
    if (match.lifecycleState === 'retired') {
      return [
        {
          code: 'TARGET_VERSION_RETIRED',
          message: `component ${request.targetRef.id}@${request.targetRef.version} is retired and cannot be upgraded to`,
          recoverable: false,
          nextAction: 'a retired version cannot be resurrected; publish a new version instead',
        },
      ]
    }
    return []
  }
}
