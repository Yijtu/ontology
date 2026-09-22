import { beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  findIndustryPackViolations,
  hasWellFormedCapabilityRequirements,
  satisfiesContractRange,
  type IndustryManifest,
  type VersionRef,
} from '@ontology/contracts'
import {
  compileSemanticQuery,
  renderCompiledQuery,
  validateDefinitionVersion,
  type SemanticDefinitionVersionDraft,
} from '@ontology/semantic-engine'
import {
  HOME_ENERGY_DEFINITIONS,
  HOME_ENERGY_NAMESPACE,
  HOME_ENERGY_REPRESENTATIVE_QUESTIONS,
  HOME_ENERGY_REQUIRED_OBJECTS,
  buildHomeEnergyManifest,
  checkHomeEnergySemantics,
  type HomeEnergyDefinitionContent,
} from '@ontology/industry-pack-home-energy'
import {
  HOME_ENERGY_COMPILE_BUDGET,
  HOME_ENERGY_MAPPING_A,
  HOME_ENERGY_MAPPING_B,
  SYNTHETIC_DATASET_A_METADATA,
  SYNTHETIC_DATASET_B_METADATA,
  homeEnergyObservationQuery,
  sourceARows,
  sourceBRows,
} from '../fixtures/home-energy'
import { createAjv, expectValid, validator } from '../contracts/helpers'

/**
 * LOCAL-042: the home-energy declaration pack, its purity and its semantic distinctions,
 * plus the proof that two differently named/unit-ed synthetic data sets normalise through
 * their customer mappings to one canonical concept query.
 */

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const

const DUMMY_DEFINITIONS_REF: VersionRef = {
  id: 'home-energy.core',
  version: '0.1.0',
  digest: `sha256:${'3'.repeat(64)}`,
}

let ajv: Ajv2020
let industryManifest: ValidateFunction

function manifest(): IndustryManifest {
  return buildHomeEnergyManifest(DUMMY_DEFINITIONS_REF)
}

function cloneManifest(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest())) as Record<string, unknown>
}

function cloneDefinitions(): HomeEnergyDefinitionContent {
  return structuredClone(HOME_ENERGY_DEFINITIONS)
}

beforeAll(() => {
  ajv = createAjv()
  industryManifest = validator(ajv, 'industry.schema.json', 'IndustryManifest')
})

describe('home-energy IndustryManifest declaration (C1, FR-31, US-023)', () => {
  it('validates against the canonical IndustryManifest schema', () => {
    expectValid(industryManifest, manifest(), 'home-energy manifest')
  })

  it('records maturity, a synthetic-assumption provenance and required capabilities', () => {
    const pack = manifest()
    expect(pack.namespace).toBe(HOME_ENERGY_NAMESPACE)
    expect(pack.maturity).toBe('preview')
    expect(pack.standardProvenance.some((entry) => entry.provenanceKind === 'synthetic_assumption')).toBe(
      true,
    )
    expect(hasWellFormedCapabilityRequirements(pack.requiredCapabilities)).toBe(true)
    for (const requirement of pack.requiredCapabilities) {
      expect(satisfiesContractRange(requirement.versionRange, '1.0.0'), requirement.name).toBe(true)
    }
  })

  it('declares the plan and simulate operations without inlining an implementation', () => {
    const pack = manifest()
    expect(pack.operationRefs?.map((operation) => operation.id)).toEqual([
      'home-energy.plan',
      'home-energy.simulate',
    ])
    expect(pack).not.toHaveProperty('runtimeRef')
    expect(pack).not.toHaveProperty('handlerRef')
  })
})

describe('industry pack purity (INV-03, ADR-10)', () => {
  it('accepts the manifest and the definition content as semantics + refs only', () => {
    expect(findIndustryPackViolations(manifest())).toEqual([])
    expect(findIndustryPackViolations(HOME_ENERGY_DEFINITIONS)).toEqual([])
  })

  it('rejects a smuggled credential, URL, physical column, script and customer instance', () => {
    const credential = findIndustryPackViolations({ ...cloneManifest(), credentials: { password: 'x' } })
    expect(credential.map((entry) => entry.code)).toContain('forbidden_field')

    const url = findIndustryPackViolations({
      ...cloneManifest(),
      definitionsRef: { id: 'postgres://user@host/db', version: '1.0.0', digest: DUMMY_DEFINITIONS_REF.digest },
    })
    expect(url.map((entry) => entry.code)).toContain('uri_value')

    const physical = findIndustryPackViolations({ ...cloneManifest(), objectPath: 'public.sensor_reading' })
    expect(physical.map((entry) => entry.code)).toContain('forbidden_field')
    expect(physical.map((entry) => entry.path)).toContain('$.objectPath')

    const script = findIndustryPackViolations({ ...cloneManifest(), queryTemplatesRef: '#!/bin/sh\necho hi' })
    expect(script.map((entry) => entry.code)).toContain('script_value')

    const customerInstance = findIndustryPackViolations({ ...cloneManifest(), siteRef: 'customer-home-a' })
    expect(customerInstance.map((entry) => entry.code)).toContain('forbidden_field')
  })

  it('rejects a Home Assistant address smuggled into the definitions', () => {
    const leaked = cloneDefinitions()
    const violations = findIndustryPackViolations({
      ...leaked,
      attributes: [...leaked.attributes, { kind: 'attribute', id: 'ha_entity', value: 'ws://ha.local/api/websocket' }],
    })
    expect(violations.map((entry) => entry.code)).toContain('uri_value')
  })
})

describe('home-energy definitions validate and keep their distinctions', () => {
  it('publishes without validation issues', () => {
    const draft: SemanticDefinitionVersionDraft = { scopeRef: SCOPE, ...HOME_ENERGY_DEFINITIONS }
    expect(validateDefinitionVersion(draft)).toEqual([])
  })

  it('passes its own semantic checks and defines every required object', () => {
    expect(checkHomeEnergySemantics(HOME_ENERGY_DEFINITIONS)).toEqual([])
    const ids = new Set(HOME_ENERGY_DEFINITIONS.objects.map((object) => object.id))
    for (const required of HOME_ENERGY_REQUIRED_OBJECTS) {
      expect(ids.has(required), required).toBe(true)
    }
  })

  it('fails when power (kW) is conflated with energy (kWh)', () => {
    const conflated = cloneDefinitions()
    const rated = conflated.attributes.find((attribute) => attribute.id === 'rated_power_kw')
    if (rated === undefined) throw new Error('rated_power_kw is missing from the pack')
    const withWrongUnit = { ...rated, unit: { unitCode: 'kWh', dimension: 'energy' } }
    const issues = checkHomeEnergySemantics({
      ...conflated,
      attributes: conflated.attributes.map((attribute) =>
        attribute.id === 'rated_power_kw' ? withWrongUnit : attribute,
      ),
    })
    expect(issues.map((issue) => issue.code)).toContain('CONFLATED_POWER_ENERGY')
  })

  it('fails when a sensor is conflated with a device', () => {
    const conflated = cloneDefinitions()
    const issues = checkHomeEnergySemantics({
      ...conflated,
      attributes: [
        ...conflated.attributes,
        {
          kind: 'attribute',
          id: 'energy_capacity_kwh',
          namespace: HOME_ENERGY_NAMESPACE,
          objectId: 'sensor',
          valueType: 'quantity',
          cardinality: { min: 0, max: 1 },
          unit: { unitCode: 'kWh', dimension: 'energy' },
          standardProvenance: conflated.standardProvenance,
        },
      ],
    })
    expect(issues.map((issue) => issue.code)).toContain('CONFLATED_DEVICE_SENSOR')
  })

  it('fails when a forecast is conflated with an observation', () => {
    const conflated = cloneDefinitions()
    const issues = checkHomeEnergySemantics({
      ...conflated,
      attributes: conflated.attributes.map((attribute) =>
        attribute.id === 'observation_data_mode' ? { ...attribute, enumValues: ['forecast'] } : attribute,
      ),
    })
    expect(issues.map((issue) => issue.code)).toContain('CONFLATED_FORECAST_OBSERVED')
  })
})

describe('representative questions map to declared concepts', () => {
  it('only references concepts the pack defines', () => {
    const ids = new Set(HOME_ENERGY_DEFINITIONS.objects.map((object) => object.id))
    expect(HOME_ENERGY_REPRESENTATIVE_QUESTIONS.length).toBeGreaterThan(0)
    for (const question of HOME_ENERGY_REPRESENTATIVE_QUESTIONS) {
      expect(question.expectedConcepts.length, question.id).toBeGreaterThan(0)
      for (const concept of question.expectedConcepts) {
        expect(ids.has(concept), `${question.id} -> ${concept}`).toBe(true)
      }
    }
  })
})

describe('two synthetic sources align through their customer mappings (E-01, T003a)', () => {
  it('marks both data sets synthetic and never as a real device specification', () => {
    for (const metadata of [SYNTHETIC_DATASET_A_METADATA, SYNTHETIC_DATASET_B_METADATA]) {
      expect(metadata.synthetic).toBe(true)
      expect(metadata.dataMode).toBe('synthetic')
      expect(metadata.deviceSpecsAreSimulatedAssumptions).toBe(true)
      expect(metadata.note.toLowerCase()).toContain('simulated')
    }
    expect(SYNTHETIC_DATASET_A_METADATA.sourceUnits).not.toEqual(
      SYNTHETIC_DATASET_B_METADATA.sourceUnits,
    )
  })

  it('normalises both mappings to the same canonical projection and units', () => {
    const compiledA = compileSemanticQuery(
      homeEnergyObservationQuery(HOME_ENERGY_MAPPING_A),
      HOME_ENERGY_MAPPING_A,
      { budget: HOME_ENERGY_COMPILE_BUDGET },
    )
    const compiledB = compileSemanticQuery(
      homeEnergyObservationQuery(HOME_ENERGY_MAPPING_B),
      HOME_ENERGY_MAPPING_B,
      { budget: HOME_ENERGY_COMPILE_BUDGET },
    )

    expect(compiledA.projections.map((projection) => projection.fieldRef)).toEqual(
      compiledB.projections.map((projection) => projection.fieldRef),
    )
    expect(compiledA.projections.map((projection) => projection.unit)).toEqual(
      compiledB.projections.map((projection) => projection.unit),
    )
    expect(compiledA.projections.find((projection) => projection.fieldRef === 'power_kw')?.unit).toBe(
      'kW',
    )
    expect(
      compiledA.projections.find((projection) => projection.fieldRef === 'energy_kwh')?.unit,
    ).toBe('kWh')
  })

  it('uses each source unit and encoding only in the mapping, not the pack', () => {
    const renderedA = renderCompiledQuery(
      compileSemanticQuery(homeEnergyObservationQuery(HOME_ENERGY_MAPPING_A), HOME_ENERGY_MAPPING_A, {
        budget: HOME_ENERGY_COMPILE_BUDGET,
      }),
    )
    const renderedB = renderCompiledQuery(
      compileSemanticQuery(homeEnergyObservationQuery(HOME_ENERGY_MAPPING_B), HOME_ENERGY_MAPPING_B, {
        budget: HOME_ENERGY_COMPILE_BUDGET,
      }),
    )

    expect(renderedA.sql).toContain('power_w')
    expect(renderedA.sql).toContain('/ 1000')
    expect(renderedB.sql).toContain('active_power_kw')
    expect(renderedA.parameters).toContain(1)
    expect(renderedB.parameters).toContain('OK')
    expect(findIndustryPackViolations(HOME_ENERGY_DEFINITIONS)).toEqual([])
  })

  it('builds the two physical data sets from the same logical observations', () => {
    expect(sourceARows()).toHaveLength(4)
    expect(sourceBRows()).toHaveLength(4)
    // Same logical power: 3.5 kW is 3500 W in source A and 3.5 kW in source B.
    expect(sourceARows()[0]?.[3]).toBe(3500)
    expect(sourceBRows()[0]?.[3]).toBe(3.5)
    expect(sourceARows()[0]?.[4]).toBe(5250)
    expect(sourceBRows()[0]?.[4]).toBe(5.25)
  })
})
