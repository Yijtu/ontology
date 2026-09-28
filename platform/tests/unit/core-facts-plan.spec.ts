import { describe, expect, it } from 'vitest'
import type { CoreExampleScenario } from '../../apps/api/src/composition/core-example-loader'
import { loadCoreExamples } from '../../apps/api/src/composition/core-example-loader'
import { CoreFactsPlanError, createCoreFactsPlan } from '../../apps/api/src/composition/core-facts-plan'
import type { MappingRef, ScopeRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/application'

const SCOPE: ScopeRef = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

function scenarioById(scenarios: readonly CoreExampleScenario[], scenarioId: string): CoreExampleScenario {
  const scenario = scenarios.find((entry) => entry.scenarioId === scenarioId)
  if (scenario === undefined) throw new Error(`test scenario ${scenarioId} was not loaded`)
  return scenario
}

function resolvedMappingsOf(scenario: CoreExampleScenario): readonly MappingRef[] {
  return scenario.physicalMappings.flatMap((entry) => {
    const object = entry.mapping.objects[0]
    return object === undefined
      ? []
      : [{ ...entry.ref, role: 'catalog' as const, sourceObjectRef: object.sourceObjectRef }]
  })
}

function planInput(
  scenario: CoreExampleScenario,
  question: string,
  overrides: {
    readonly runProfileRef?: CoreExampleScenario['profileRef']
    readonly resolvedProfileHash?: string
    readonly mappingRefs?: readonly MappingRef[]
    readonly definitionRef?: VersionRef
    readonly scopeRef?: ScopeRef
  } = {},
) {
  return {
    scenario,
    runProfileRef: overrides.runProfileRef ?? scenario.profileRef,
    resolvedProfileHash: overrides.resolvedProfileHash ?? sha256DigestOf('resolved-profile-v1'),
    mappingRefs: overrides.mappingRefs ?? resolvedMappingsOf(scenario),
    definitionRef: overrides.definitionRef ?? scenario.definitionRef,
    scopeRef: overrides.scopeRef ?? SCOPE,
    question,
  }
}

describe('core facts small plans', () => {
  const scenarios = loadCoreExamples({ targetScopeRef: SCOPE }).scenarios

  it('keeps the existing single-property facts query as one pinned read-only lookup', () => {
    const scenario = scenarioById(scenarios, 'transport-facility-inspection')
    const plan = createCoreFactsPlan(planInput(scenario, ' facts:inspection_due ', {
      runProfileRef: { ...scenario.profileRef, version: '1.0.1' },
    }))

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({
      stepId: 'facts-1',
      toolId: 'ontology_lookup',
      readOnly: true,
      args: [
        { name: 'scopeRef', required: true, source: { kind: 'literal', value: SCOPE } },
        { name: 'intent', required: true, source: { kind: 'literal', value: 'facts' } },
        {
          name: 'concepts',
          required: true,
          source: {
          kind: 'literal',
            value: [{ namespace: scenario.namespace, conceptId: 'inspection_due', definitionVersion: scenario.definitionRef.version }],
          },
        },
        { name: 'limit', required: true, source: { kind: 'literal', value: 100 } },
      ],
      dependsOn: [],
      failureBehaviour: 'abort',
    })
    expect(plan.planRef).toMatchObject({ kind: 'plan', version: '1.0.0', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) })
    expect(createCoreFactsPlan(planInput(scenario, 'facts:inspection_due', {
      runProfileRef: { ...scenario.profileRef, version: '1.0.1' },
    }))).toEqual(plan)
  })

  it('builds at most three independent lookups pinned to the actual run profile, scope, schema and mappings', () => {
    const scenario = scenarioById(scenarios, 'transport-facility-inspection')
    const question = 'facts:inspection_due, inspection_exempt, facility_id'
    const resolvedMappingRefs = resolvedMappingsOf(scenario).slice(0, 1)
    const runProfileRef = { ...scenario.profileRef, version: '1.0.1' }
    const resolvedProfileHash = sha256DigestOf('transport-active-profile-1.0.1')
    const plan = createCoreFactsPlan(planInput(scenario, question, { runProfileRef, resolvedProfileHash, mappingRefs: resolvedMappingRefs }))

    expect(plan.steps).toHaveLength(3)
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      'facts-1',
      'facts-2',
      'facts-3',
    ])
    for (const step of plan.steps) {
      expect(step).toMatchObject({ toolId: 'ontology_lookup', readOnly: true, dependsOn: [], failureBehaviour: 'abort' })
      expect(step.args.find((argument) => argument.name === 'scopeRef')?.source).toEqual({ kind: 'literal', value: SCOPE })
      expect(step.args.find((argument) => argument.name === 'intent')?.source).toEqual({ kind: 'literal', value: 'facts' })
      expect(step.args.find((argument) => argument.name === 'concepts')?.source).toMatchObject({
        kind: 'literal',
        value: [{ namespace: scenario.namespace, definitionVersion: scenario.definitionRef.version }],
      })
    }

    const otherScope = { ...SCOPE, spaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    const otherScopePlan = createCoreFactsPlan(planInput(scenario, question, {
      scopeRef: otherScope,
      runProfileRef,
      resolvedProfileHash,
      mappingRefs: resolvedMappingRefs,
    }))
    expect(otherScopePlan.planRef.digest).not.toBe(plan.planRef.digest)

    const otherProfilePlan = createCoreFactsPlan(planInput(scenario, question, {
      runProfileRef: { ...scenario.profileRef, version: '1.0.2' },
      resolvedProfileHash,
      mappingRefs: resolvedMappingRefs,
    }))
    expect(otherProfilePlan.planRef.digest).not.toBe(plan.planRef.digest)

    const otherResolvedProfile = createCoreFactsPlan(planInput(scenario, question, {
      runProfileRef,
      resolvedProfileHash: sha256DigestOf('transport-active-profile-1.0.1-revised'),
      mappingRefs: resolvedMappingRefs,
    }))
    expect(otherResolvedProfile.planRef.digest).not.toBe(plan.planRef.digest)

    const otherMappings = createCoreFactsPlan(planInput(scenario, question, {
      runProfileRef,
      resolvedProfileHash,
      mappingRefs: resolvedMappingsOf(scenario).slice(1, 2),
    }))
    expect(otherMappings.planRef.digest).not.toBe(plan.planRef.digest)

    const noPhysicalMappings = createCoreFactsPlan(planInput(scenario, question, {
      runProfileRef,
      resolvedProfileHash,
      mappingRefs: [],
    }))
    expect(noPhysicalMappings.planRef.digest).not.toBe(plan.planRef.digest)

    const industrial = scenarioById(scenarios, 'industrial-asset-maintenance')
    const profileReconfiguredToIndustrial = createCoreFactsPlan(planInput(industrial, 'facts:operating_hours', {
      runProfileRef: { id: scenario.profileRef.id, version: '1.0.2' },
      resolvedProfileHash: sha256DigestOf('transport-profile-reconfigured-to-industrial'),
      mappingRefs: resolvedMappingsOf(industrial),
    }))
    expect(profileReconfiguredToIndustrial.steps).toHaveLength(1)
    expect(profileReconfiguredToIndustrial.steps[0]?.args.find((argument) => argument.name === 'concepts')?.source)
      .toMatchObject({ kind: 'literal', value: [{ namespace: industrial.namespace, conceptId: 'operating_hours' }] })
  })

  it('rejects empty, malformed, duplicate, unknown and over-three property selections', () => {
    const scenario = scenarioById(scenarios, 'transport-facility-inspection')
    const invalidCases = [
      { question: 'facts:', code: 'INVALID_QUESTION' },
      { question: 'facts:inspection_due,,facility_id', code: 'INVALID_QUESTION' },
      { question: 'facts:inspection_due,inspection_due', code: 'DUPLICATE_PROPERTY' },
      { question: 'facts:unregistered_property', code: 'UNKNOWN_PROPERTY' },
      { question: 'facts:a,b,c,d', code: 'TOO_MANY_PROPERTIES' },
      { question: `facts:${'x'.repeat(257)}`, code: 'INVALID_QUESTION' },
      { question: `facts:${'x'.repeat(1_025)}`, code: 'INVALID_QUESTION' },
      { question: 'inspection_due', code: 'INVALID_QUESTION' },
    ] as const

    for (const invalidCase of invalidCases) {
      let thrown: unknown
      try {
        createCoreFactsPlan(planInput(scenario, invalidCase.question))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CoreFactsPlanError)
      expect(thrown).toMatchObject({ code: invalidCase.code })
    }
  })

  it('accepts schema-registered uppercase, dotted and Unicode property identifiers', () => {
    const scenario = scenarioById(scenarios, 'transport-facility-inspection')
    const facility = scenario.industrySchema.objects.find((object) => object.objectId === 'transport_facility')
    const original = facility?.attributes.find((entry) => entry.attributeId === 'inspection_due')
    if (facility === undefined || original === undefined) throw new Error('transport test schema field is missing')
    const customScenario: CoreExampleScenario = {
      ...scenario,
      industrySchema: {
        ...scenario.industrySchema,
        objects: scenario.industrySchema.objects.map((object) => object.objectId === facility.objectId
          ? {
              ...object,
              attributes: [
                ...object.attributes,
                { ...original, attributeId: 'Machine.hours' },
                { ...original, attributeId: '巡检状态' },
              ],
            }
          : object),
      },
    }
    const plan = createCoreFactsPlan(planInput(customScenario, 'facts:Machine.hours, 巡检状态'))

    expect(plan.steps.map((step) => step.stepId)).toEqual(['facts-1', 'facts-2'])
    expect(plan.steps[0]?.args.find((argument) => argument.name === 'concepts')?.source)
      .toMatchObject({ kind: 'literal', value: [{ conceptId: 'Machine.hours' }] })
    expect(plan.steps[1]?.args.find((argument) => argument.name === 'concepts')?.source)
      .toMatchObject({ kind: 'literal', value: [{ conceptId: '巡检状态' }] })
  })

  it('rejects a property id that is ambiguous across schema objects', () => {
    const scenario = scenarioById(scenarios, 'transport-facility-inspection')
    const facility = scenario.industrySchema.objects.find((object) => object.objectId === 'transport_facility')
    const district = scenario.industrySchema.objects.find((object) => object.objectId === 'transport_district')
    const attribute = facility?.attributes.find((entry) => entry.attributeId === 'inspection_due')
    if (facility === undefined || district === undefined || attribute === undefined) throw new Error('transport test schema fields are missing')
    const ambiguousScenario: CoreExampleScenario = {
      ...scenario,
      industrySchema: {
        ...scenario.industrySchema,
        objects: scenario.industrySchema.objects.map((object) => object.objectId === district.objectId
          ? { ...object, attributes: [...object.attributes, { ...attribute }] }
          : object),
      },
    }

    expect(() => createCoreFactsPlan(planInput(ambiguousScenario, 'facts:inspection_due')))
      .toThrowError(expect.objectContaining({ code: 'AMBIGUOUS_PROPERTY' }))
  })

  it('rejects malformed run refs and definition or mapping pins that do not match the selected run snapshot', () => {
    const scenario = scenarioById(scenarios, 'transport-facility-inspection')
    const runProfileRef = { ...scenario.profileRef, version: '1.0.1' }
    const question = 'facts:inspection_due'
    const valid = planInput(scenario, question, { runProfileRef })

    expect(() => createCoreFactsPlan(planInput(scenario, question, {
      runProfileRef: { id: scenario.profileRef.id, version: '' },
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_RUN_PROFILE' }))
    expect(() => createCoreFactsPlan({
      ...valid,
      resolvedProfileHash: 'not-a-digest',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PROFILE_HASH' }))
    expect(() => createCoreFactsPlan({
      ...valid,
      definitionRef: { ...scenario.definitionRef, version: '9.9.9' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_DEFINITION_PIN' }))

    const emptyMappingPlan = createCoreFactsPlan({ ...valid, mappingRefs: [] })
    expect(emptyMappingPlan.planRef.digest).not.toBe(createCoreFactsPlan(valid).planRef.digest)

    const currentMapping = valid.mappingRefs[0]
    if (currentMapping === undefined) throw new Error('test profile mapping pin is missing')
    expect(() => createCoreFactsPlan({
      ...valid,
      mappingRefs: [{ ...currentMapping, digest: sha256DigestOf('unmounted-mapping') }],
    })).toThrowError(expect.objectContaining({ code: 'UNMOUNTED_MAPPING_PIN' }))
    expect(() => createCoreFactsPlan({
      ...valid,
      mappingRefs: [{
        ...currentMapping,
        sourceObjectRef: { ...currentMapping.sourceObjectRef, objectPath: 'other.unmounted_source' },
      }],
    })).toThrowError(expect.objectContaining({ code: 'MAPPING_SOURCE_MISMATCH' }))
  })
})
