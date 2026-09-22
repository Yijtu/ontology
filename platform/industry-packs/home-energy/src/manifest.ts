import type { CapabilityRequirement, IndustryManifest, VersionRef } from '@ontology/contracts'
import { HOME_ENERGY_NAMESPACE, HOME_ENERGY_STANDARD_PROVENANCE } from './definitions'

/**
 * The `home-energy` `IndustryManifest` (SPEC C1; FR-31/US-023).
 *
 * `definitionsRef` is supplied by the caller because it pins the digest of the exact
 * published definition version. Building the manifest from the real published ref is what
 * lets a preflight resolve it against the definition store instead of trusting a hardcoded
 * digest.
 *
 * The pack declares the capabilities its semantics need (`requiredCapabilities`) and the
 * contract suite that proves it (`testSuiteRef`), records its `maturity`, and cites its
 * published sources. It never carries a runtime binding, SDK dependency, connection
 * address, credential or customer instance.
 */

function ref(id: string, version: string, fill: string): VersionRef {
  return { id, version, digest: `sha256:${fill.repeat(64)}` }
}

export const HOME_ENERGY_IDENTITY_POLICY_REF: VersionRef = ref(
  'home-energy.identity-policy',
  '0.1.0',
  '4',
)
export const HOME_ENERGY_RULE_POLICY_REF: VersionRef = ref('home-energy.rule-policy', '0.1.0', '5')
export const HOME_ENERGY_QUERY_TEMPLATES_REF: VersionRef = ref(
  'home-energy.query-templates',
  '0.1.0',
  '6',
)
export const HOME_ENERGY_TEST_SUITE_REF: VersionRef = ref('home-energy.test-suite', '0.1.0', '7')
export const HOME_ENERGY_EXTENSION_REF: VersionRef = ref('extension-home-energy', '1.0.0', '8')

/**
 * INV-08: the energy solver, time-series semantics and parameter meaning never live in the
 * generic core. The pack declares the capability; a separately published component
 * provides it and a composition root binds a trusted handler.
 */
export const HOME_ENERGY_REQUIRED_CAPABILITIES: readonly CapabilityRequirement[] = [
  { name: 'structured_query', versionRange: { min: '1.0.0', max: '2.0.0' } },
  { name: 'telemetry_read', versionRange: { min: '1.0.0', max: '2.0.0' } },
  { name: 'document_search', versionRange: { min: '1.0.0' } },
  { name: 'compute.home-energy.plan', versionRange: { min: '1.0.0', max: '2.0.0' } },
  { name: 'compute.home-energy.simulate', versionRange: { min: '1.0.0', max: '2.0.0' } },
]

export function buildHomeEnergyManifest(definitionsRef: VersionRef): IndustryManifest {
  return {
    namespace: HOME_ENERGY_NAMESPACE,
    maturity: 'preview',
    standardProvenance: [...HOME_ENERGY_STANDARD_PROVENANCE],
    definitionsRef,
    identityPolicyRef: HOME_ENERGY_IDENTITY_POLICY_REF,
    rulePolicyRef: HOME_ENERGY_RULE_POLICY_REF,
    queryTemplatesRef: HOME_ENERGY_QUERY_TEMPLATES_REF,
    requiredCapabilities: [...HOME_ENERGY_REQUIRED_CAPABILITIES],
    testSuiteRef: HOME_ENERGY_TEST_SUITE_REF,
    operationRefs: [
      { id: 'home-energy.plan', version: '1' },
      { id: 'home-energy.simulate', version: '1' },
    ],
    extensionRefs: [HOME_ENERGY_EXTENSION_REF],
  }
}
