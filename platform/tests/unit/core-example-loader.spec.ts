import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CoreExampleLoaderError, loadCoreExamples } from '../../apps/api/src/composition/core-example-loader'
import type { ScopeRef } from '@ontology/contracts'

const TARGET_SCOPE: ScopeRef = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const DEFAULT_INDEX = fileURLToPath(new URL('../../deploy/core/examples/index.json', import.meta.url))

describe('loadCoreExamples', () => {
  it('loads both scenarios, replaces sample scope, and returns verified mapping refs and input paths', () => {
    const loaded = loadCoreExamples({ targetScopeRef: TARGET_SCOPE })

    expect(loaded.indexPath).toBe(DEFAULT_INDEX)
    expect(loaded.classification).toBe('public_synthetic_demo_not_an_industry_standard')
    expect(loaded.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      'transport-facility-inspection',
      'industrial-asset-maintenance',
    ])
    const transport = loaded.scenarios[0]
    const industrial = loaded.scenarios[1]
    if (transport === undefined || industrial === undefined) throw new Error('example scenarios were not loaded')

    expect(transport).toMatchObject({
      label: '交通设施巡检（合成演示）',
      profileRef: { id: 'synthetic-transport-facility-demo', version: '1.0.0' },
      namespace: 'synthetic-transport-facility',
      definitionDraft: { scopeRef: TARGET_SCOPE, ruleConstraints: [] },
      industryManifest: { maturity: 'preview', namespace: 'synthetic-transport-facility' },
      industrySchema: { namespace: 'synthetic-transport-facility' },
      goldenEntityIds: ['T-01', 'T-02', 'T-03', 'T-04', 'T-05', 'T-06'],
    })
    expect(transport.physicalMappings.map((entry) => entry.ref.id)).toEqual([
      'synthetic-transport-registry-a',
      'synthetic-transport-field-review-b',
    ])
    expect(transport.rawSources.map((source) => source.sourceRef.sourceId)).toContain('registry-a')
    expect(transport.rawSources.map((source) => source.sourceRef.sourceId)).toContain('field-review-b')
    expect(transport.syntheticPolicy.sourceRef.sourceId).toBe('rule-rt-policy')
    expect(transport.syntheticPolicy.path).toContain('rule-rt.txt')

    const minuteMapping = industrial.physicalMappings.find((entry) => entry.ref.id === 'synthetic-industrial-accumulated-minutes')
    const assetMapping = minuteMapping?.mapping.objects.find((object) => object.conceptId === 'industrial_asset')
    const hoursField = assetMapping?.fields.find((field) => field.fieldRef === 'operating_hours')
    expect(hoursField).toMatchObject({ column: 'accumulated_minutes', unitFactor: 60, unit: { unitCode: 'h', dimension: 'time' } })
    expect(industrial.calibrationOnlyEntityIds).toEqual(['I-CAL-5999'])
    expect(industrial.definitionDraft.scopeRef).toEqual(TARGET_SCOPE)
    expect(industrial.definitionRef.digest).toBe(industrial.industryManifest.definitionsRef.digest)
  })

  it('rejects relative asset traversal from an alternate index directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-example-loader-'))
    try {
      const badIndex = {
        schemaVersion: 'core-synthetic-industry-examples@1',
        classification: 'public_synthetic_demo_not_an_industry_standard',
        scenarios: [{
          scenarioId: 'path-boundary-test',
          label: 'Synthetic path test',
          profileRef: { id: 'synthetic-path-test', version: '1.0.0' },
          namespace: 'synthetic-test',
          industryManifest: '../outside.json',
          definitionDraft: 'definition.json',
          mappingTemplates: 'templates.json',
          testSuite: 'suite.json',
          rawSources: [],
          syntheticPolicy: {
            sourceRef: { namespace: 'synthetic-test', sourceId: 'policy' },
            path: 'policy.txt',
            mediaType: 'text/plain',
          },
          physicalMappings: [],
          goldenEntityIds: [],
        }],
      }
      const indexPath = join(directory, 'index.json')
      writeFileSync(indexPath, JSON.stringify(badIndex), 'utf8')

      let thrown: unknown
      try {
        loadCoreExamples({ indexPath, targetScopeRef: TARGET_SCOPE })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CoreExampleLoaderError)
      expect(thrown).toMatchObject({ code: 'ASSET_PATH_INVALID' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
