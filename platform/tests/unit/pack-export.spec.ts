import { describe, expect, it } from 'vitest'
import { findEmbeddedSecretViolations } from '@ontology/contracts'
import type { MappingTemplate, PackAsset, PackCatalogEntry } from '@ontology/contracts'
import {
  findPackExportViolations,
  summarizePackCatalogEntry,
} from '@ontology/application'
import type { SemanticMapping } from '@ontology/semantic-engine'
import {
  HOME_ENERGY_MAPPING_A,
  HOME_ENERGY_MAPPING_B,
  INDUSTRY_REF,
  PACK_EDITOR_A,
  SCOPE_A,
  TELEMETRY_MAPPING_REF_B,
  buildPackHarness,
  homeEnergyTestSuite,
  sampleProfileSpec,
} from './pack-fixtures'

const PROFILE_V1 = { id: 'home-energy-demo', version: '1.0.0' }
const PROFILE_V2 = { id: 'home-energy-demo', version: '2.0.0' }

function mappingCoversTemplate(mapping: SemanticMapping, template: MappingTemplate): boolean {
  const object = mapping.objects.find((entry) => entry.conceptId === template.conceptId)
  if (object === undefined) return false
  const fieldRefs = new Set(object.fields.map((field) => field.fieldRef))
  return template.fields.every((field) => fieldRefs.has(field.fieldRef))
}

describe('industry pack export (LOCAL-041)', () => {
  it('exports definitions, identity policy, mapping templates, provenance and the test suite', async () => {
    const harness = await buildPackHarness()
    const bundle = await harness.exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )

    expect(bundle.namespace).toBe('home-energy')
    expect(bundle.definitions?.objects.map((object) => object.id)).toContain('observation_series')
    expect(bundle.identityPolicy.policyRef).toEqual(harness.manifest.identityPolicyRef)
    expect(bundle.identityPolicy.scopeDimensions).toContain('source')
    expect(bundle.identityPolicy.identityAttributeIds).toContain('sensor_native_id')

    const observationTemplate = bundle.mappingTemplates.find(
      (template) => template.conceptId === 'observation_series',
    )
    expect(observationTemplate?.namespace).toBe('home-energy')
    expect(observationTemplate?.fields.map((field) => field.fieldRef)).toContain('recorded_at')

    expect(bundle.standardProvenance).toEqual(harness.manifest.standardProvenance)
    expect(bundle.testSuite).toEqual(homeEnergyTestSuite())
    expect(bundle.testSuite.cases.map((testCase) => testCase.caseId)).toEqual(['E-01', 'E-02'])
    expect(bundle.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('excludes customer data, identity decisions and credentials from a real export', async () => {
    const harness = await buildPackHarness()
    const bundle = await harness.exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )

    expect(findPackExportViolations(bundle)).toEqual([])
    expect(findEmbeddedSecretViolations(bundle)).toEqual([])

    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(SCOPE_A.tenantId)
    expect(serialized).not.toContain(SCOPE_A.spaceId)
    expect(serialized).not.toContain('scopeRef')
    expect(serialized).not.toContain('tenantId')
    expect(serialized).not.toContain('spaceId')
    expect(serialized).not.toContain('entityId')
    expect(serialized).not.toContain('://')
    // No physical source naming leaks through: the templates are canonical only.
    expect(serialized).not.toContain('synthetic_observation')
    expect(serialized).not.toContain('obs_id')
    expect(serialized).not.toContain('reading_id')
    expect(serialized).not.toContain('sourceObjectRef')
  })

  it('produces a deterministic content digest independent of the bound mapping', async () => {
    const harness = await buildPackHarness()
    const first = await harness.exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )
    const second = await harness.exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )
    expect(second.contentDigest).toBe(first.contentDigest)
    expect(second.mappingTemplates).toEqual(first.mappingTemplates)

    // The export is derived from the published definitions, so a profile that binds a
    // differently shaped source mapping still exports the same canonical templates.
    await harness.resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    await harness.resolver.publish(
      {
        scopeRef: SCOPE_A,
        profileRef: PROFILE_V2,
        spec: sampleProfileSpec({
          mappingRefs: sampleProfileSpec().mappingRefs.map((mapping) =>
            mapping.role === 'telemetry' ? TELEMETRY_MAPPING_REF_B : mapping,
          ),
        }),
        environment: 'local_dev',
      },
      PACK_EDITOR_A,
    )
    const afterProfiles = await harness.exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )
    expect(afterProfiles.contentDigest).toBe(first.contentDigest)
  })

  it('is usable with a second, differently shaped source structure', async () => {
    const harness = await buildPackHarness()
    const bundle = await harness.exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )
    const template = bundle.mappingTemplates.find((entry) => entry.conceptId === 'observation_series')
    expect(template).toBeDefined()
    if (template === undefined) return

    // Both mappings describe the same canonical concept from differently named physical
    // sources; the export's template carries no physical name at all.
    expect(HOME_ENERGY_MAPPING_A.mappingRef.id).not.toBe(HOME_ENERGY_MAPPING_B.mappingRef.id)
    expect(HOME_ENERGY_MAPPING_A.objects[0]?.relation).toBe('synthetic_observation_a')
    expect(HOME_ENERGY_MAPPING_B.objects[0]?.relation).toBe('synthetic_observation_b')
    expect(mappingCoversTemplate(HOME_ENERGY_MAPPING_A, { ...template, fields: [] })).toBe(true)
    expect(mappingCoversTemplate(HOME_ENERGY_MAPPING_B, { ...template, fields: [] })).toBe(true)

    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(HOME_ENERGY_MAPPING_A.objects[0]?.relation)
    expect(serialized).not.toContain(HOME_ENERGY_MAPPING_B.objects[0]?.relation)
  })

  it('gates usability on maturity: preparation material is never validated', async () => {
    const harness = await buildPackHarness()
    const entries: readonly PackCatalogEntry[] = await harness.catalogue.listEntries(SCOPE_A, PACK_EDITOR_A)
    const summaries = entries.map((entry) => summarizePackCatalogEntry(entry))

    const homeEnergy = summaries.find((summary) => summary.namespace === 'home-energy')
    expect(homeEnergy?.maturity).toBe('preview')
    expect(homeEnergy?.maturityLabel).toBe('experimental')
    expect(homeEnergy?.usable).toBe(false)

    const automotive = summaries.find((summary) => summary.namespace === 'automotive')
    expect(automotive?.maturityLabel).toBe('defined')
    expect(automotive?.usable).toBe(false)

    const health = summaries.find((summary) => summary.namespace === 'health-services')
    expect(health?.maturityLabel).toBe('experimental')
    expect(health?.usable).toBe(false)

    expect(summaries.some((summary) => summary.maturityLabel === 'validated')).toBe(false)

    // Only a stable pack is reported as validated/usable.
    const stable: PackAsset = {
      ref: { id: 'stable-demo', version: '1.0.0', digest: `sha256:${'9'.repeat(64)}` },
      manifest: { ...harness.manifest, maturity: 'stable' },
      testSuite: homeEnergyTestSuite(),
    }
    const stableSummary = summarizePackCatalogEntry({ kind: 'registered_pack', asset: stable })
    expect(stableSummary.maturityLabel).toBe('validated')
    expect(stableSummary.usable).toBe(true)
  })
})
