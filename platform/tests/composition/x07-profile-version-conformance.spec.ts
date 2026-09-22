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
  buildPackHarness,
  componentRecord,
  sampleProfileSpec,
  seedComponents,
} from '../unit/pack-fixtures'

/**
 * X-07 — a new profile version must not silently switch an old run's runtime or backend.
 *
 * The upgrade service is the real application service (LOCAL-041). It publishes a new
 * profile version, and the earlier version keeps its exact pinned runtime and its already
 * resolved manifest. A run pinned to the old version can still resolve it; a version an
 * active run references cannot be retired.
 */

const PROFILE_V1 = { id: 'home-energy-demo', version: '1.0.0' }
const PROFILE_V2 = { id: 'home-energy-demo', version: '2.0.0' }
const RUNTIME_KEY = { kind: 'runtime' as const, id: 'runtime-template', version: '1.0.0' }

function runtimeUpgradeRequest(): UpgradeRequest {
  return {
    scopeRef: SCOPE_A,
    packId: INDUSTRY_REF.id,
    sourceProfileRef: PROFILE_V1,
    targetProfileRef: PROFILE_V2,
    slot: { kind: 'runtime' },
    targetRef: RUNTIME_V2,
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

describe('X-07 — a new profile version does not disturb an existing run', () => {
  it('keeps v1 pinned and its resolved manifest byte-identical after upgrading to v2', async () => {
    const harness = await buildPackHarness()
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    const before = await harness.resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_V1 }, PACK_EDITOR_A)
    if (before.resolvedProfile === undefined) throw new Error('v1 did not resolve')
    const beforeHash = before.resolvedProfile.snapshotHash

    await seedRuntimeV2(harness)
    const outcome = await harness.upgrader.applyUpgrade(runtimeUpgradeRequest(), PACK_EDITOR_A)
    expect(outcome.status).toBe('applicable')
    expect(outcome.preflightStatus).toBe('resolved')
    expect(outcome.published?.profileRef).toEqual(PROFILE_V2)

    // v1 and its resolved manifest keep their exact pinned runtime and snapshot hash.
    const storedV1 = await harness.profileStore.findProfileVersion(PROFILE_V1, SCOPE_A, PACK_EDITOR_A)
    expect(storedV1?.spec.runtimeRef).toEqual(RUNTIME_V1)
    const resolvedV1 = await harness.resolver.getResolvedProfile(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, snapshotHash: beforeHash },
      PACK_EDITOR_A,
    )
    expect(resolvedV1.resolved.runtimeRef).toEqual(RUNTIME_V1)
    expect(resolvedV1.resolved.snapshotHash).toBe(beforeHash)

    // v2 pins the upgraded runtime.
    const storedV2 = await harness.profileStore.findProfileVersion(PROFILE_V2, SCOPE_A, PACK_EDITOR_A)
    expect(storedV2?.spec.runtimeRef).toEqual(RUNTIME_V2)
  })

  it('refuses to retire a version an active run still references', async () => {
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
    expect(assessment.blockers.some((blocker) => blocker.code === 'ACTIVE_REFERENCE_EXISTS')).toBe(true)

    const error = await harness.upgrader
      .retire(RUNTIME_KEY, SCOPE_A, PACK_ADMIN_A)
      .then(() => undefined)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IndustryPackError)
    if (!(error instanceof IndustryPackError)) throw new Error('expected an IndustryPackError')
    expect(error.code).toBe('RETIREMENT_BLOCKED')

    await harness.registry.releaseActiveReference(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, runId: RUN_A },
      PACK_RUNNER_A,
    )
    const retired = await harness.upgrader.retire(RUNTIME_KEY, SCOPE_A, PACK_ADMIN_A)
    expect(retired.lifecycleState).toBe('retired')
  })
})
