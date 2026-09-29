import { describe, expect, it } from 'vitest'
import { WorkbenchClient } from '@ontology/app-web/client'

const digest = `sha256:${'a'.repeat(64)}`

describe('Core deployment metadata client', () => {
  it('loads typed scenarios and their explicitly supported tasks', async () => {
    let requested = ''
    const client = new WorkbenchClient({
      baseUrl: 'http://core.test',
      fetchImpl: (input) => {
        requested = String(input)
        return Promise.resolve(new Response(JSON.stringify({ data: {
          classification: 'public_synthetic_demo_not_an_industry_standard',
          operatorEnabled: true,
          models: { generation: false, decision: false },
          scenarios: [{
            scenarioId: 'transport-facility-inspection',
            sourceScenarioId: 'industrial-asset-maintenance',
            label: '交通设施巡检（合成演示）',
            profileRef: { id: 'synthetic-transport-facility-demo', version: '1.0.0' },
            environment: 'local_dev',
            baseProfileSpec: {
              industryRef: { id: 'synthetic-transport-facility', version: '1.0.0', digest },
              mappingRefs: [{
                id: 'transport-mapping', version: '1.0.0', digest, role: 'catalog',
                sourceObjectRef: { sourceRef: { namespace: 'synthetic-transport-demo', sourceId: 'registry-a' }, objectPath: 'records' },
              }],
              runtimeRef: { id: 'runtime-template', version: '1.0.0', digest },
              backendBindings: {},
              modelBindings: {},
              toolBindings: [],
              computeBindings: [],
              policyRef: { id: 'core-local-policy', version: '1.0.0', digest },
            },
            namespace: 'synthetic-transport-facility',
            definitionRef: { id: 'transport-definition', version: '1.0.0', digest },
            availableTasks: ['facts:inspection_due'],
            mappingRefs: [{ id: 'transport-mapping', version: '1.0.0', digest }],
            rawSourceRefs: [{ namespace: 'synthetic-transport-demo', sourceId: 'registry-a' }],
          }],
        } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })

    const deployment = await client.getCoreDeployment()

    expect(requested).toBe('http://core.test/api/v1/core/deployment')
    expect(deployment.scenarios[0]?.availableTasks).toEqual(['facts:inspection_due'])
    expect(deployment.scenarios[0]?.profileRef.id).toBe('synthetic-transport-facility-demo')
    expect(deployment.scenarios[0]?.sourceScenarioId).toBe('industrial-asset-maintenance')
    expect(deployment.scenarios[0]?.baseProfileSpec?.mappingRefs[0]?.sourceObjectRef.objectPath).toBe('records')
  })

  it('rejects malformed or unsafe deployment metadata instead of guessing a scenario', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://core.test',
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ data: {
        classification: 'public_synthetic_demo_not_an_industry_standard',
        operatorEnabled: true,
        models: { generation: false, decision: false },
        scenarios: [{
          scenarioId: 'transport',
          label: 'Transport',
          profileRef: { id: 'transport', version: '1.0.0' },
          environment: 'local_dev',
          namespace: 'synthetic-transport-facility',
          definitionRef: { id: 'transport-definition', version: '1.0.0', digest },
          availableTasks: [],
          mappingRefs: [],
          rawSourceRefs: [],
          baseProfileSpec: {
            industryRef: { id: 'transport-industry', version: '1.0.0', digest },
            mappingRefs: [],
            runtimeRef: { id: 'runtime-template', version: '1.0.0', digest },
            backendBindings: { structured_query: null },
            modelBindings: {},
            toolBindings: [],
            computeBindings: [],
            policyRef: { id: 'core-policy', version: '1.0.0', digest },
          },
        }],
      } }), { status: 200, headers: { 'content-type': 'application/json' } })),
    })

    await expect(client.getCoreDeployment()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
