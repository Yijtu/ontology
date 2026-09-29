import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  ScopeRef,
  SemanticFilter,
  SemanticQueryPlan,
  SourceRef,
  ToolContext,
} from '@ontology/contracts'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import type { SemanticMapping } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import type { ToolExecutionOutcome, ToolExecutionRequest } from '@ontology/tool-services'
import { createDuckDbSnapshot } from '../../apps/api/src/composition/core-local-composition'
import { loadCoreExamples } from '../../apps/api/src/composition/core-example-loader'
import type { CoreExampleScenario } from '../../apps/api/src/composition/core-example-loader'

const TARGET_SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const DEADLINE = '2099-01-01T00:00:00Z'
const TRANSPORT_REGISTRY_A: SourceRef = { namespace: 'synthetic-transport-demo', sourceId: 'registry-a' }
const TRANSPORT_FIELD_REVIEW_B: SourceRef = { namespace: 'synthetic-transport-demo', sourceId: 'field-review-b' }
const INDUSTRIAL_CANONICAL: SourceRef = { namespace: 'synthetic-industrial-demo', sourceId: 'asset-hours-canonical' }
const INDUSTRIAL_MINUTES: SourceRef = { namespace: 'synthetic-industrial-demo', sourceId: 'asset-minutes-layout' }

let scenarios: readonly CoreExampleScenario[] = []
let mappings: readonly SemanticMapping[] = []
let snapshot: Awaited<ReturnType<typeof createDuckDbSnapshot>> | undefined
let queryHandler: DataQueryHandler | undefined
let context: ToolContext | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tableRows(outcome: ToolExecutionOutcome): readonly Record<string, unknown>[] {
  const payload = outcome.payload
  if (!isRecord(payload)) throw new Error('the semantic query did not return a table')
  if (payload?.['resultKind'] !== 'table') throw new Error('the semantic query did not return a table')
  const tableValue = payload['table']
  if (!isRecord(tableValue)) throw new Error('the table payload is malformed')
  const table = tableValue
  const columns = table?.['columns']
  const values = table?.['rows']
  if (!Array.isArray(columns) || !Array.isArray(values)) throw new Error('the table payload is malformed')
  const names = columns.map((column) => {
    if (!isRecord(column)) throw new Error('the table contains a malformed column')
    const name = column['name']
    if (typeof name !== 'string') throw new Error('the table contains a column without a name')
    return name
  })
  return values.map((value) => {
    if (!Array.isArray(value) || value.length !== names.length) throw new Error('the table contains a malformed row')
    const row: Record<string, unknown> = {}
    names.forEach((name, index) => {
      row[name] = value[index]
    })
    return row
  })
}

function mapping(id: string): SemanticMapping {
  const found = mappings.find((entry) => entry.mappingRef.id === id)
  if (found === undefined) throw new Error(`test mapping ${id} was not loaded`)
  return found
}

function semanticPlan(
  selectedMapping: SemanticMapping,
  concept: string,
  fields: readonly string[],
  filters: readonly SemanticFilter[] = [],
): SemanticQueryPlan {
  const firstField = fields[0]
  if (firstField === undefined) throw new Error('a semantic query must project at least one field')
  return {
    mode: 'semantic',
    concepts: [concept],
    fields: [...fields],
    links: [],
    filters: [...filters],
    orderBy: [{ fieldRef: firstField, direction: 'asc' }],
    limit: 100,
    mappingVersion: selectedMapping.mappingRef,
  }
}

async function query(
  selectedMapping: SemanticMapping,
  concept: string,
  fields: readonly string[],
  filters: readonly SemanticFilter[] = [],
): Promise<ToolExecutionOutcome> {
  const handler = queryHandler
  const ctx = context
  if (handler === undefined || ctx === undefined) throw new Error('the real DuckDB snapshot is not ready')
  const request: ToolExecutionRequest = {
    callId: randomUUID(),
    toolId: 'data_query',
    arguments: {
      kind: 'query',
      mode: 'semantic',
      queryPlan: semanticPlan(selectedMapping, concept, fields, filters),
    },
    resultLimits: { maxRows: 100, maxBytes: 1_048_576, maxDurationMs: 10_000 },
    deadline: ctx.deadline,
    traceId: ctx.traceId,
    ctx,
    signal: new AbortController().signal,
  }
  return handler.execute(request)
}

function rowFor(
  rows: readonly Record<string, unknown>[],
  field: string,
  wanted: string,
): Record<string, unknown> {
  const found = rows.find((row) => row[field] === wanted)
  if (found === undefined) throw new Error(`row ${wanted} was not returned in ${field}`)
  return found
}

function exactInteger(value: unknown, expected: bigint): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && BigInt(value) === expected
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value)) return false
  const [wholePart, fractionPart = ''] = value.split('.')
  if (wholePart === undefined || /[1-9]/u.test(fractionPart)) return false
  try {
    return BigInt(wholePart) === expected
  } catch {
    return false
  }
}

function exactDecimalLessThan(value: unknown, integerBound: bigint): boolean {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value)) return false
  const [wholePart, fractionPart = ''] = value.split('.')
  if (wholePart === undefined) return false
  try {
    const whole = BigInt(wholePart)
    return whole < integerBound || (whole === integerBound && /^0*$/u.test(fractionPart))
  } catch {
    return false
  }
}

function contextFor(sourceRefs: readonly SourceRef[]): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TARGET_SCOPE.tenantId,
      subjectId: 'core-business-snapshot-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: RUN_ID,
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: DEADLINE,
    budgetReservation: {
      reservationId: '44444444-4444-4444-8444-444444444444',
      runId: RUN_ID,
      grantedAt: '2026-09-28T00:00:00Z',
      expiresAt: DEADLINE,
    },
    allowedResources: {
      tenantId: TARGET_SCOPE.tenantId,
      spaceId: TARGET_SCOPE.spaceId,
      resourceKinds: ['dataset'],
      sourceRefs: [...sourceRefs],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-core-business-snapshot-test',
  })
}

beforeAll(async () => {
  const loaded = loadCoreExamples({ targetScopeRef: TARGET_SCOPE })
  scenarios = loaded.scenarios
  mappings = scenarios.flatMap((scenario) => scenario.physicalMappings.map((entry) => entry.mapping))
  snapshot = await createDuckDbSnapshot(scenarios)
  const sourceRefs = scenarios.flatMap((scenario) => scenario.rawSources.map((source) => source.sourceRef))
  const uniqueSourceRefs = [...new Map(sourceRefs.map((ref) => [`${ref.namespace}\u0000${ref.sourceId}`, ref])).values()]
  context = contextFor(uniqueSourceRefs)
  queryHandler = new DataQueryHandler({
    query: snapshot,
    mappings: new InMemorySemanticMappingRegistry(mappings),
    consistency: 'immutable',
  })
}, 30_000)

afterAll(() => {
  snapshot?.close()
})

describe('Core synthetic business snapshot through the real semantic query path', () => {
  it('queries T-01 from both independent transport SourceRefs', async () => {
    const registry = await query(
      mapping('synthetic-transport-registry-a'),
      'transport_facility',
      ['facility_id', 'inspection_due', 'inspection_exempt'],
      [{ fieldRef: 'facility_id', op: 'eq', values: ['T-01'] }],
    )
    const review = await query(
      mapping('synthetic-transport-field-review-b'),
      'transport_facility',
      ['facility_id', 'inspection_due', 'inspection_exempt'],
      [{ fieldRef: 'facility_id', op: 'eq', values: ['T-01'] }],
    )

    expect(tableRows(registry)).toEqual([
      { facility_id: 'T-01', inspection_due: true, inspection_exempt: false },
    ])
    expect(registry.sources.map((source) => source.sourceRef)).toEqual([TRANSPORT_REGISTRY_A])
    expect(tableRows(review)).toEqual([
      { facility_id: 'T-01', inspection_due: true, inspection_exempt: false },
    ])
    expect(review.sources.map((source) => source.sourceRef)).toEqual([TRANSPORT_FIELD_REVIEW_B])
  })

  it('preserves absent transport due and exemption values as null', async () => {
    const result = await query(
      mapping('synthetic-transport-registry-a'),
      'transport_facility',
      ['facility_id', 'inspection_due', 'inspection_exempt'],
    )
    const rows = tableRows(result)

    expect(rows).toHaveLength(6)
    expect(rowFor(rows, 'facility_id', 'T-03')['inspection_exempt']).toBeNull()
    expect(rowFor(rows, 'facility_id', 'T-05')['inspection_exempt']).toBeNull()
    expect(rowFor(rows, 'facility_id', 'T-06')['inspection_due']).toBeNull()
    expect(rowFor(rows, 'facility_id', 'T-04')['inspection_due']).toBe(false)
  })

  it('returns the same canonical industrial hours and boolean facts from both layouts', async () => {
    const fields = ['asset_id', 'operating_hours', 'maintenance_exempt']
    const canonical = await query(
      mapping('synthetic-industrial-hours-canonical'),
      'industrial_asset',
      fields,
    )
    const minutes = await query(
      mapping('synthetic-industrial-accumulated-minutes'),
      'industrial_asset',
      fields,
      [{ fieldRef: 'asset_id', op: 'in', values: ['I-01', 'I-02', 'I-03', 'I-04', 'I-05', 'I-06'] }],
    )
    const canonicalRows = tableRows(canonical)
    const minuteRows = tableRows(minutes)

    expect(rowFor(canonicalRows, 'asset_id', 'I-01')['maintenance_exempt']).toBe(false)
    expect(rowFor(canonicalRows, 'asset_id', 'I-02')['maintenance_exempt']).toBe(true)
    expect(exactInteger(rowFor(canonicalRows, 'asset_id', 'I-04')['operating_hours'], 100n)).toBe(true)
    expect(rowFor(canonicalRows, 'asset_id', 'I-05')['operating_hours']).toBeNull()
    expect(rowFor(canonicalRows, 'asset_id', 'I-06')['maintenance_exempt']).toBeNull()

    expect(exactInteger(rowFor(minuteRows, 'asset_id', 'I-01')['operating_hours'], 120n)).toBe(true)
    expect(rowFor(minuteRows, 'asset_id', 'I-01')['maintenance_exempt']).toBe(false)
    expect(exactInteger(rowFor(minuteRows, 'asset_id', 'I-02')['operating_hours'], 120n)).toBe(true)
    expect(rowFor(minuteRows, 'asset_id', 'I-02')['maintenance_exempt']).toBe(true)
    expect(exactInteger(rowFor(minuteRows, 'asset_id', 'I-03')['operating_hours'], 90n)).toBe(true)
    expect(exactInteger(rowFor(minuteRows, 'asset_id', 'I-04')['operating_hours'], 100n)).toBe(true)
    expect(rowFor(minuteRows, 'asset_id', 'I-05')['operating_hours']).toBeNull()
    expect(rowFor(minuteRows, 'asset_id', 'I-06')['maintenance_exempt']).toBeNull()
    expect(minutes.sources.map((source) => source.sourceRef)).toEqual([INDUSTRIAL_MINUTES])
    expect(canonical.sources.map((source) => source.sourceRef)).toEqual([INDUSTRIAL_CANONICAL])
  })

  it('keeps 6000 minutes at 100 hours and the 5999-minute calibration row below 100', async () => {
    const result = await query(
      mapping('synthetic-industrial-accumulated-minutes'),
      'industrial_asset',
      ['asset_id', 'operating_hours'],
      [{ fieldRef: 'asset_id', op: 'in', values: ['I-04', 'I-CAL-5999'] }],
    )
    const rows = tableRows(result)
    const boundary = rowFor(rows, 'asset_id', 'I-04')['operating_hours']
    const calibration = rowFor(rows, 'asset_id', 'I-CAL-5999')['operating_hours']

    expect(exactInteger(boundary, 100n)).toBe(true)
    expect(exactDecimalLessThan(calibration, 100n)).toBe(true)
    expect(BigInt(6000) / 60n).toBe(100n)
    expect(5999n).toBeLessThan(100n * 60n)
  })
})
