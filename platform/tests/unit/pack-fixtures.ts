import type {
  ComponentVersionRecord,
  IndustryManifest,
  MappingRef,
  PackTestSuite,
  VersionRef,
} from '@ontology/contracts'
import { ComponentRegistry } from '@ontology/application'
import {
  InMemoryIndustryPackCatalogue,
  IndustryPackExportService,
  IndustryPackUpgradeService,
  InMemoryIndustryManifestSource,
  ProfileResolver,
} from '@ontology/application'
import { SemanticDefinitionService, InMemorySemanticDefinitionStore } from '@ontology/semantic-engine'
import {
  HOME_ENERGY_DEFINITIONS,
  HOME_ENERGY_NAMESPACE,
  HOME_ENERGY_TEST_SUITE_REF,
  buildHomeEnergyExampleSet,
  buildHomeEnergyManifest,
} from '@ontology/industry-pack-home-energy'
import { AUTOMOTIVE_PREPARATION } from '@ontology/industry-pack-automotive'
import { HEALTH_SERVICES_PREPARATION } from '@ontology/industry-pack-health-services'
import { TRANSPORT_GOVERNMENT_PREPARATION } from '@ontology/industry-pack-transport-government'
import { HOME_ENERGY_MAPPING_A, HOME_ENERGY_MAPPING_B, HOME_ENERGY_SOURCE_B } from '../fixtures/home-energy'
import {
  COMPUTE_HANDLER_REF,
  INDUSTRY_REF,
  RUNTIME_REF,
  SCOPE_A,
  canonicalProfileValidator,
  componentRecord,
  fixedClock,
  registeredComponents,
  sampleProfileSpec,
  seedComponents,
  toolContext,
} from './profile-resolver-fixtures'
import { InMemoryComponentRegistryStore } from '@ontology/application'
import { InMemoryProfileStore } from '@ontology/application'
import { FakeBlobPort, RecordingControlRepository, canonicalManifestValidator } from './component-registry-fixtures'

export { SCOPE_A, INDUSTRY_REF, fixedClock, toolContext, sampleProfileSpec, seedComponents, componentRecord }
export { HOME_ENERGY_NAMESPACE, HOME_ENERGY_MAPPING_A, HOME_ENERGY_MAPPING_B }

export const RUN_A = '33333333-3333-4333-8333-333333333333'

export const PACK_ADMIN_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['platform-admin'], 'pack-admin-a')
export const PACK_EDITOR_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'pack-editor-a')
export const PACK_RUNNER_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['run-controller'], 'pack-runner-a')

export const RUNTIME_V1: VersionRef = RUNTIME_REF
export const RUNTIME_V2: VersionRef = { id: 'runtime-template', version: '1.1.0', digest: `sha256:${'c'.repeat(64)}` }

/**
 * The home-energy pack declares both `compute.home-energy.plan` and `compute.home-energy.simulate`;
 * the shared fixture only registers the plan capability, so the harness registers the extension
 * with both. This keeps preflight honest: every declared capability is genuinely provided.
 */
export function homeEnergyComponents(): ComponentVersionRecord[] {
  return [
    ...registeredComponents().filter((record) => record.manifestRef.id !== 'extension-home-energy'),
    componentRecord({
      kind: 'compute_extension',
      id: 'extension-home-energy',
      version: '1.0.0',
      digest: COMPUTE_HANDLER_REF.digest,
      provides: [
        { name: 'compute.home-energy.plan', version: '1.0.0' },
        { name: 'compute.home-energy.simulate', version: '1.0.0' },
      ],
    }),
  ]
}

/** A differently shaped mapping for the same telemetry role: source B instead of source A. */
export const TELEMETRY_MAPPING_REF_B: MappingRef = {
  id: HOME_ENERGY_MAPPING_B.mappingRef.id,
  version: HOME_ENERGY_MAPPING_B.mappingRef.version,
  digest: HOME_ENERGY_MAPPING_B.mappingRef.digest,
  role: 'telemetry',
  sourceObjectRef: { sourceRef: HOME_ENERGY_SOURCE_B, objectPath: 'public.synthetic_observation_b' },
}

export function homeEnergyTestSuite(): PackTestSuite {
  return {
    ref: HOME_ENERGY_TEST_SUITE_REF,
    cases: [
      {
        caseId: 'E-01',
        question: '在备电要求下比较明天的用电策略',
        expectedCapabilities: ['compute.home-energy.plan'],
        expectedStatus: 'resolved',
      },
      {
        caseId: 'E-02',
        question: '没有遥测后端时如何回答',
        expectedCapabilities: ['telemetry_read'],
        expectedStatus: 'missing_capabilities',
      },
    ],
  }
}

export interface PackHarness {
  readonly catalogue: InMemoryIndustryPackCatalogue
  readonly definitions: InMemorySemanticDefinitionStore
  readonly definitionService: SemanticDefinitionService
  readonly registry: ComponentRegistry
  readonly registryStore: InMemoryComponentRegistryStore
  readonly profileStore: InMemoryProfileStore
  readonly resolver: ProfileResolver
  readonly industry: InMemoryIndustryManifestSource
  readonly exporter: IndustryPackExportService
  readonly upgrader: IndustryPackUpgradeService
  readonly manifest: IndustryManifest
}

/**
 * Build the pack services against the real in-memory stores (unit) so the export/upgrade
 * rules run against the same invariants as the database adapters.
 */
export async function buildPackHarness(): Promise<PackHarness> {
  const definitions = new InMemorySemanticDefinitionStore()
  const definitionService = new SemanticDefinitionService({
    control: new RecordingControlRepository(),
    store: definitions,
    now: fixedClock(),
  })
  const published = await definitionService.publish(
    { scopeRef: SCOPE_A, ...HOME_ENERGY_DEFINITIONS },
    PACK_ADMIN_A,
  )
  const manifest = buildHomeEnergyManifest(published.ref)

  const registryStore = new InMemoryComponentRegistryStore({ now: fixedClock() })
  await seedComponents(registryStore, homeEnergyComponents(), SCOPE_A, PACK_ADMIN_A)

  const registry = new ComponentRegistry({
    control: new RecordingControlRepository(),
    store: registryStore,
    artifacts: new FakeBlobPort(),
    validator: canonicalManifestValidator(),
    now: fixedClock(),
  })

  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, manifest)

  const profileStore = new InMemoryProfileStore()
  const resolver = new ProfileResolver({
    control: new RecordingControlRepository(),
    store: profileStore,
    registry: registryStore,
    industry,
    validator: canonicalProfileValidator(),
    now: fixedClock(),
  })

  const catalogue = new InMemoryIndustryPackCatalogue()
  catalogue.registerPack({
    ref: INDUSTRY_REF,
    manifest,
    testSuite: homeEnergyTestSuite(),
    exampleSet: buildHomeEnergyExampleSet(),
  })
  catalogue.registerPreparation(AUTOMOTIVE_PREPARATION)
  catalogue.registerPreparation(HEALTH_SERVICES_PREPARATION)
  catalogue.registerPreparation(TRANSPORT_GOVERNMENT_PREPARATION)

  const exporter = new IndustryPackExportService({
    catalogue,
    definitions,
    now: fixedClock(),
  })
  const upgrader = new IndustryPackUpgradeService({
    profiles: resolver,
    profileStore,
    registry,
    registryStore,
  })

  return {
    catalogue,
    definitions,
    definitionService,
    registry,
    registryStore,
    profileStore,
    resolver,
    industry,
    exporter,
    upgrader,
    manifest,
  }
}
