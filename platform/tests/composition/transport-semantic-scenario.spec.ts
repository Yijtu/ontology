import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type { SemanticQueryPlan, SourceObjectRef, SourceRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { defineSemanticMapping, InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import { buildGateway, gatewayContext, openGatewayLedger, resolvedProfile } from '../unit/tool-gateway-fixtures'
import { observeToolResult } from './conformance'

const sourceRef: SourceRef = { namespace: 'transport-government', sourceId: 'facility-snapshot' }
const objectRef: SourceObjectRef = { sourceRef, objectPath: 'road_facilities' }
const relation: RegisteredRelation = {
  relation: 'road_facilities', objectRef, schemaRevision: 'transport-fixture@1',
  columns: [
    { name: 'facility_key', type: 'string' },
    { name: 'district_code', type: 'string' },
    { name: 'condition_code', type: 'integer' },
  ],
}
const mapping = defineSemanticMapping('transport.facility-mapping', '1.0.0', {
  dialect: 'duckdb',
  objects: [{
    conceptId: 'road_facility', sourceObjectRef: objectRef,
    schema: 'main', relation: 'road_facilities', relationKind: 'table', estimatedRows: 2,
    fields: [
      { fieldRef: 'facility_id', column: 'facility_key', valueType: 'string', identityKey: true },
      { fieldRef: 'district', column: 'district_code', valueType: 'string' },
      { fieldRef: 'condition', column: 'condition_code', valueType: 'enum', valueMap: [
        { physical: 1, canonical: 'needs_inspection' },
        { physical: 0, canonical: 'clear' },
      ] },
    ],
  }],
  links: [],
})
const plan: SemanticQueryPlan = {
  mode: 'semantic', concepts: ['road_facility'],
  fields: ['facility_id', 'district', 'condition'], links: [],
  filters: [{ fieldRef: 'district', op: 'eq', values: ['north'] }],
  orderBy: [{ fieldRef: 'facility_id', direction: 'asc' }], limit: 10,
  mappingVersion: mapping.mappingRef,
}
const adapter = new DuckDbQueryAdapter({ relations: [relation], catalogSchemaRevision: 'transport-fixture@1' })
const handler = new DataQueryHandler({ query: adapter, mappings: new InMemorySemanticMappingRegistry([mapping]) })
const profile = resolvedProfile({
  industryRef: { id: 'transport-government', version: '1.0.0', digest: sha256DigestOf('transport-government@1.0.0') },
  mappingRefs: [{ ...mapping.mappingRef, role: 'catalog', sourceObjectRef: objectRef }],
  toolBindings: [{ toolId: 'data_query', enabled: true }],
})

beforeAll(async () => {
  await adapter.start()
  await adapter.materialiseRelation('road_facilities', [
    ['bridge-1', 'north', 1],
    ['tunnel-2', 'south', 0],
  ])
})
afterAll(() => adapter.close())

describe('a non-energy industry mounts on the same query and evidence path', () => {
  it('answers a transport semantic query without an energy concept or handler', async () => {
    const ctx = gatewayContext({ sourceRefs: [sourceRef], deadline: '2099-01-01T00:00:00Z' })
    const harness = buildGateway({ handlers: [handler], profile, ctx })
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke({
      callId: crypto.randomUUID(), toolId: 'data_query',
      arguments: { kind: 'query', mode: 'semantic', queryPlan: plan },
    }, ctx)
    const observed = observeToolResult(result)
    expect(observed.status).toBe('ok')
    expect(observed.rows).toEqual([['bridge-1', 'north', 'needs_inspection']])
    expect(observed.evidenceCount).toBe(1)
    expect(result.sourceSnapshots[0]?.sourceRef).toEqual(sourceRef)
  })

  it('still rejects the query when the source was not granted', async () => {
    const ctx = gatewayContext({ sourceRefs: [], deadline: '2099-01-01T00:00:00Z' })
    const harness = buildGateway({ handlers: [handler], profile, ctx })
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke({
      callId: crypto.randomUUID(), toolId: 'data_query',
      arguments: { kind: 'query', mode: 'semantic', queryPlan: plan },
    }, ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
  })
})
