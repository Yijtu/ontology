import { describe, expect, it } from 'vitest'
import type { UpgradeRequest } from '@ontology/contracts'
import { IndustryPackError } from '@ontology/application'
import {
  INDUSTRY_REF,
  PACK_ADMIN_A,
  PACK_EDITOR_A,
  PACK_RUNNER_A,
  RUN_A,
  RUNTIME_V1,
  RUNTIME_V2,
  SCOPE_A,
  TELEMETRY_MAPPING_REF_B,
  buildPackHarness,
  componentRecord,
  sampleProfileSpec,
  seedComponents,
} from './pack-fixtures'

const PROFILE_V1 = { id: 'home-energy-demo', version: '1.0.0' }
const PROFILE_V2 = { id: 'home-energy-demo', version: '2.0.0' }
const RUNTIME_KEY = { kind: 'runtime' as const, id: 'runtime-template', version: '1.0.0' }

function runtimeUpgradeRequest(target: UpgradeRequest['targetRef']): UpgradeRequest {
  return {
    scopeRef: SCOPE_A,
    packId: INDUSTRY_REF.id,
    sourceProfileRef: PROFILE_V1,
    targetProfileRef: PROFILE_V2,
    slot: { kind: 'runtime' },
    targetRef: target,
  }
}

async function seedRuntimeV2(harness: Awaited<ReturnType<typeof buildPackHarness>>): Promise<void> {
  await seedComponents(
    harness.registryStore,
    [
      componentRecord({
        kind: 'runtime',
        id: 'runtime-template',
        version: '1.1.0',
        digest: RUNTIME_V2.digest,
        provides: [{ name: 'agent_runtime', version: '1.1.0' }],
      }),
    ],
    SCOPE_A,
    PACK_ADMIN_A,
  )
}

describe('industry pack compatibility upgrade (LOCAL-041)', () => {
  it('only affects the new profile version; the earlier resolved manifest is untouched', async () => {
    const harness = await buildPackHarness()
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    const before = await harness.resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_V1 }, PACK_EDITOR_A)
    if (before.resolvedProfile === undefined) throw new Error('v1 did not resolve')
    const beforeHash = before.resolvedProfile.snapshotHash

    await seedRuntimeV2(harness)
    const outcome = await harness.upgrader.applyUpgrade(runtimeUpgradeRequest(RUNTIME_V2), PACK_EDITOR_A)
    expect(outcome.status).toBe('applicable')
    expect(outcome.preflightStatus).toBe('resolved')
    expect(outcome.published?.profileRef).toEqual(PROFILE_V2)

    // The old version and its resolved manifest keep their exact pinned runtime.
    const storedV1 = await harness.profileStore.findProfileVersion(PROFILE_V1, SCOPE_A, PACK_EDITOR_A)
    expect(storedV1?.spec.runtimeRef).toEqual(RUNTIME_V1)
    const resolvedV1 = await harness.resolver.getResolvedProfile(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, snapshotHash: beforeHash },
      PACK_EDITOR_A,
    )
    expect(resolvedV1.resolved.runtimeRef).toEqual(RUNTIME_V1)
    expect(resolvedV1.resolved.snapshotHash).toBe(beforeHash)

    // The new version pins the upgraded runtime.
    const storedV2 = await harness.profileStore.findProfileVersion(PROFILE_V2, SCOPE_A, PACK_EDITOR_A)
    expect(storedV2?.spec.runtimeRef).toEqual(RUNTIME_V2)
  })

  it('refuses to uninstall a version referenced by an active run and explains why', async () => {
    const harness = await buildPackHarness()
    await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, to: 'deprecated' },
      PACK_ADMIN_A,
    )
    await harness.registry.acquireActiveReference(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, runId: RUN_A },
      PACK_RUNNER_A,
    )

    const assessment = await harness.upgrader.assessRetirement(RUNTIME_KEY, SCOPE_A, PACK_ADMIN_A)
    expect(assessment.status).toBe('blocked')
    const active = assessment.blockers.find((blocker) => blocker.code === 'ACTIVE_REFERENCE_EXISTS')
    expect(active?.recoverable).toBe(true)
    expect(active?.nextAction).toContain('release')

    const error = await harness.upgrader
      .retire(RUNTIME_KEY, SCOPE_A, PACK_ADMIN_A)
      .then(() => undefined)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IndustryPackError)
    if (!(error instanceof IndustryPackError)) throw new Error('expected an IndustryPackError')
    expect(error.code).toBe('RETIREMENT_BLOCKED')
    expect(error.blockers?.map((blocker) => blocker.code)).toContain('ACTIVE_REFERENCE_EXISTS')

    const stillDeprecated = await harness.registry.getComponent(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1 },
      PACK_ADMIN_A,
    )
    expect(stillDeprecated.lifecycleState).toBe('deprecated')

    await harness.registry.releaseActiveReference(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, runId: RUN_A },
      PACK_RUNNER_A,
    )
    const retired = await harness.upgrader.retire(RUNTIME_KEY, SCOPE_A, PACK_ADMIN_A)
    expect(retired.lifecycleState).toBe('retired')

    const afterRetire = await harness.upgrader.assessRetirement(RUNTIME_KEY, SCOPE_A, PACK_ADMIN_A)
    const alreadyRetired = afterRetire.blockers.find((blocker) => blocker.code === 'VERSION_ALREADY_RETIRED')
    expect(alreadyRetired?.recoverable).toBe(false)
  })

  it('reports a retired target as an explicit, unrecoverable upgrade blocker', async () => {
    const harness = await buildPackHarness()
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    await seedRuntimeV2(harness)
    await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V2, to: 'deprecated' },
      PACK_ADMIN_A,
    )
    await harness.registry.transition(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V2, to: 'retired' },
      PACK_ADMIN_A,
    )

    const assessment = await harness.upgrader.assessUpgrade(runtimeUpgradeRequest(RUNTIME_V2), PACK_EDITOR_A)
    expect(assessment.status).toBe('blocked')
    const retired = assessment.blockers.find((blocker) => blocker.code === 'TARGET_VERSION_RETIRED')
    expect(retired?.recoverable).toBe(false)
    expect(retired?.nextAction).toContain('publish a new version')

    const outcome = await harness.upgrader.applyUpgrade(runtimeUpgradeRequest(RUNTIME_V2), PACK_EDITOR_A)
    expect(outcome.status).toBe('blocked')
    expect(outcome.published).toBeUndefined()
  })

  it('upgrades to a second, differently shaped source mapping and resolves', async () => {
    const harness = await buildPackHarness()
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    const request: UpgradeRequest = {
      scopeRef: SCOPE_A,
      packId: INDUSTRY_REF.id,
      sourceProfileRef: PROFILE_V1,
      targetProfileRef: PROFILE_V2,
      slot: { kind: 'mapping', mappingId: 'home-energy.mapping.ha-anker' },
      targetRef: {
        id: TELEMETRY_MAPPING_REF_B.id,
        version: TELEMETRY_MAPPING_REF_B.version,
        digest: TELEMETRY_MAPPING_REF_B.digest,
      },
      targetMappingRef: TELEMETRY_MAPPING_REF_B,
    }

    const outcome = await harness.upgrader.applyUpgrade(request, PACK_EDITOR_A)
    expect(outcome.status).toBe('applicable')
    expect(outcome.preflightStatus).toBe('resolved')

    const storedV2 = await harness.profileStore.findProfileVersion(PROFILE_V2, SCOPE_A, PACK_EDITOR_A)
    const telemetry = storedV2?.spec.mappingRefs.find((mapping) => mapping.role === 'telemetry')
    expect(telemetry?.id).toBe(TELEMETRY_MAPPING_REF_B.id)
    expect(telemetry?.sourceObjectRef.objectPath).toBe('public.synthetic_observation_b')
    // The backend binding that referenced the replaced mapping is updated too.
    expect(storedV2?.spec.backendBindings.telemetry?.mappingRef).toBe(TELEMETRY_MAPPING_REF_B.id)
  })
})
