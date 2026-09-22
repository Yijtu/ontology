import { describe, expect, it } from 'vitest'
import {
  InMemoryComponentRegistryStore,
  InMemoryIndustryManifestSource,
  InMemoryProfileStore,
  ProfileResolver,
} from '@ontology/application'
import { RecordingControlRepository } from '../unit/component-registry-fixtures'
import {
  INDUSTRY_REF,
  canonicalProfileValidator,
  fixedClock,
  homeEnergyIndustryManifest,
  sampleProfileSpec,
} from '../unit/profile-resolver-fixtures'
import { PACK_ADMIN_A, PACK_EDITOR_A, SCOPE_A, buildPackHarness, homeEnergyComponents } from '../unit/pack-fixtures'
import { configurationStateOf, notConfiguredModules } from './not-configured'
import { seedComponents } from '../unit/profile-resolver-fixtures'

/**
 * X-08 — an incompatible capability combination fails clearly and never widens access.
 *
 * Preflight is the real application service (LOCAL-041). It must list every missing
 * capability as a typed, explicit item and return no resolved profile, so an unconfigured
 * backend (here a registry without the telemetry component) can never be silently
 * substituted or enabled.
 */

const BROKEN_PROFILE = { id: 'home-energy-broken', version: '1.0.0' }
const VALID_PROFILE = { id: 'home-energy-valid', version: '1.0.0' }

describe('X-08 — unsupported combinations fail with an explicit typed report', () => {
  it('reports a missing required capability and returns no resolved profile', async () => {
    // The real resolver over a registry that deliberately omits the telemetry backend.
    const registryStore = new InMemoryComponentRegistryStore({ now: fixedClock() })
    await seedComponents(
      registryStore,
      homeEnergyComponents().filter((record) => record.manifestRef.id !== 'data-duckdb'),
      SCOPE_A,
      PACK_ADMIN_A,
    )
    const industry = new InMemoryIndustryManifestSource()
    industry.register(INDUSTRY_REF, homeEnergyIndustryManifest())
    const resolver = new ProfileResolver({
      control: new RecordingControlRepository(),
      store: new InMemoryProfileStore(),
      registry: registryStore,
      industry,
      validator: canonicalProfileValidator(),
      now: fixedClock(),
    })

    await resolver.publish(
      { scopeRef: SCOPE_A, profileRef: BROKEN_PROFILE, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    const result = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: BROKEN_PROFILE }, PACK_EDITOR_A)

    expect(result.status).toBe('missing_capabilities')
    expect(result.missingCapabilities?.map((entry) => entry.name)).toContain('telemetry_read')
    expect(result.resolvedProfile).toBeUndefined()
    // The unconfigured backend is explicitly reported as such, not as a passed capability.
    expect(configurationStateOf('data-starrocks')).toBe('not_configured')
    expect(notConfiguredModules().map((module) => module.moduleId)).toContain('data-starrocks')
  })

  it('resolves a supported profile without auto-enabling a disabled tool', async () => {
    const harness = await buildPackHarness()
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: VALID_PROFILE, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    const result = await harness.resolver.preflight({ scopeRef: SCOPE_A, profileRef: VALID_PROFILE }, PACK_EDITOR_A)
    expect(result.status).toBe('resolved')
    const resolved = result.resolvedProfile
    if (resolved === undefined) throw new Error('the supported profile did not resolve')
    const enabledTools = resolved.toolBindings
      .filter((binding) => binding.enabled)
      .map((binding) => binding.toolId)
      .sort()
    expect(enabledTools).toEqual(['data_query', 'document_search', 'ontology_lookup'])
    expect(enabledTools).not.toContain('web_search')
  })
})
