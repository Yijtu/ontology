import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SemanticQueryPlan, ToolResult } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { DataQueryHandler } from '@ontology/tool-services'
import { createLocalStructuredProfiles, type LocalStructuredProfiles } from '../../apps/api/src/composition/registered-source-profiles'
import { buildGateway, gatewayContext, openGatewayLedger } from '../unit/tool-gateway-fixtures'

const ref = (id: string) => ({ id, version: '1.0.0', digest: sha256DigestOf(`${id}@1.0.0`) })
let composed: LocalStructuredProfiles

beforeAll(async () => {
  composed = await createLocalStructuredProfiles({
    tenantId: '11111111-1111-4111-8111-111111111111',
    spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    runtimeRef: ref('runtime-local'), policyRef: ref('policy-local'), industryRef: ref('home-energy'),
  })
})
afterAll(() => composed?.close())

async function run(profileIndex: number, siteRef: string, overridePlan?: SemanticQueryPlan): Promise<ToolResult> {
  const profile = composed.profiles[profileIndex]
  if (profile === undefined) throw new Error('missing profile')
  const access = composed.resolveToolAccess(profile.profileRef)
  if (access === undefined) throw new Error('missing profile access')
  const ctx = gatewayContext({ sourceRefs: [...access.sourceRefs], deadline: '2099-01-01T00:00:00Z' })
  const handler = new DataQueryHandler({ query: composed.query, mappings: composed.mappings })
  const harness = buildGateway({ handlers: [handler], ctx, profile: profile.resolvedProfile })
  await openGatewayLedger(harness, ctx)
  return harness.gateway.invoke({
    callId: crypto.randomUUID(), toolId: 'data_query',
    arguments: { kind: 'query', mode: 'semantic', queryPlan: overridePlan ?? profile.planForSite(siteRef) },
  }, ctx)
}

function rows(result: ToolResult): unknown[][] {
  const payload = result.inlineData
  if (typeof payload !== 'object' || payload === null || !('table' in payload)) throw new Error('expected table payload')
  const table = payload.table
  if (typeof table !== 'object' || table === null || !('rows' in table) || !Array.isArray(table.rows)) throw new Error('expected table rows')
  return table.rows as unknown[][]
}

describe('local registered structured profiles', () => {
  it('runs the same semantic SOC question against distinct real DuckDB layouts', async () => {
    const wide = await run(0, 'synthetic-home-1')
    const long = await run(1, 'synthetic-home-1')
    expect(wide.status).toBe('ok')
    expect(long.status).toBe('ok')
    expect(rows(wide)).toEqual(rows(long))
    expect(rows(wide)).toHaveLength(1)
    expect(rows(wide)[0]?.[0]).toBe('synthetic-home-1')
    expect(rows(wide)[0]?.[1]).toBe('45.0000000000')
    expect((wide.inlineData as { table?: { columns?: { unit?: string }[] } }).table?.columns?.[1]?.unit).toBe('%')
    expect(wide.evidenceRefs).toHaveLength(1)
    expect(long.evidenceRefs).toHaveLength(1)
    expect(wide.evidenceRefs[0]?.digest).not.toBe(long.evidenceRefs[0]?.digest)
    expect(composed.profiles[0]?.resolvedProfile.mappingRefs[0]?.digest)
      .not.toBe(composed.profiles[1]?.resolvedProfile.mappingRefs[0]?.digest)
  })

  it('returns an explicit empty result for a site with no SOC data', async () => {
    const result = await run(1, 'unknown-site')
    expect(result.status).toBe('empty')
    expect(rows(result)).toEqual([])
  })

  it('projects the persistent Virtual SOLIX state as a read-time SOC source in both profile layouts', async () => {
    const beforeWide = await run(0, 'virtual-solix-1')
    const beforeLong = await run(1, 'virtual-solix-1')
    expect(rows(beforeWide)[0]?.[1]).toBe('35.0000000000')
    expect(rows(beforeLong)).toEqual(rows(beforeWide))
    await composed.updateVirtualSoc(47.5, '2026-09-24T03:00:00.000Z')
    const afterWide = await run(0, 'virtual-solix-1')
    const afterLong = await run(1, 'virtual-solix-1')
    expect(rows(afterWide)[0]?.[1]).toBe('47.5000000000')
    expect(rows(afterLong)).toEqual(rows(afterWide))
    expect(afterWide.evidenceRefs[0]?.digest).not.toBe(beforeWide.evidenceRefs[0]?.digest)
  })

  it('authorizes only the selected profile’s normalized query source', () => {
    const wide = composed.profiles[0]
    const long = composed.profiles[1]
    if (wide === undefined || long === undefined) throw new Error('missing profiles')
    expect(composed.resolveToolAccess(wide.profileRef)?.sourceRefs).toEqual(wide.sourceRefs)
    expect(composed.resolveToolAccess(long.profileRef)?.sourceRefs).toEqual(long.sourceRefs)
    expect(wide.sourceRefs).not.toEqual(long.sourceRefs)
    expect(composed.resolveToolAccess({ id: 'unknown', version: '1.0.0' })).toBeUndefined()
    expect(() => long.planForSite('')).toThrow(/siteRef/)
  })

  it('rejects a wide-source query under the long profile’s source grant', async () => {
    const widePlan = composed.profiles[0]?.planForSite('synthetic-home-1')
    if (widePlan === undefined) throw new Error('missing wide plan')
    const result = await run(1, 'synthetic-home-1', widePlan)
    expect(result.status).toBe('error')
    expect(result.evidenceRefs).toHaveLength(0)
  })
})
