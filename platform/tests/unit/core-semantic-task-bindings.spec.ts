import { describe, expect, it } from 'vitest'
import { coreScenarioTaskBindings, loadCoreExamples } from '@ontology/app-api'
import { TOOL_CATALOGUE } from '@ontology/contracts'
import { createAjv } from '../contracts/helpers'
import { TENANT_A, SPACE_A } from './component-registry-fixtures'

describe('mounted semantic task schemas (#265)', () => {
  it('compiles every published parameter schema and preserves exactly four public tools', () => {
    const scenario = loadCoreExamples({ targetScopeRef: { tenantId: TENANT_A, spaceId: SPACE_A } }).scenarios[0]
    if (scenario === undefined) throw new Error('missing actual mounted scenario')
    const ajv = createAjv()
    for (const binding of coreScenarioTaskBindings(scenario)) expect(() => ajv.compile(binding.parameterSchema)).not.toThrow()
    expect(TOOL_CATALOGUE.map((tool) => tool.toolId)).toEqual(['ontology_lookup', 'data_query', 'document_search', 'web_search'])
    const rule = coreScenarioTaskBindings(scenario).find((binding) => binding.kind === 'rule_judgement')
    if (rule === undefined) throw new Error('missing mounted rule schema')
    const validate = ajv.compile(rule.parameterSchema)
    expect(validate({ rule: 'Inspection policy', entity: 'T-01' })).toBe(true)
    expect(validate({ rule: 'Inspection policy', entity: 'T-01', ruleRef: { id: 'guessed' } })).toBe(false)
  })
})
