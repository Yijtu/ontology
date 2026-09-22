import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type {
  DirectSqlQueryPlan,
  SourceObjectRef,
  SourceRef,
  ToolCall,
  ToolContext,
  ToolResult,
} from '@ontology/contracts'
import { summarizePackCatalogEntry } from '@ontology/application'
import {
  InMemorySemanticMappingRegistry,
  defineSemanticMapping,
  type SemanticMapping,
} from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import { PACK_EDITOR_A, SCOPE_A, buildPackHarness } from '../unit/pack-fixtures'
import {
  buildGateway,
  gatewayContext,
  openGatewayLedger,
} from '../unit/tool-gateway-fixtures'
import {
  EXPECTED_ROWS,
  LOGICAL_ROWS,
  MAPPING_C,
  OBJECT_C,
  READING_CONCEPT,
  SOURCE_C,
  semanticPlan,
} from '../fixtures/semantic-mapping'
import { compareObservations, observeToolResult } from './conformance'

/**
 * X-04 and X-06 — swapping an industry or a data mapping must not change core execution.
 *
 * X-06: two real DuckDB mappings describe the same canonical concept with different
 * physical column names, units and status encodings. The same semantic plan is compiled
 * against each and executed through the real `DuckDbQueryAdapter`; the canonical rows must
 * be equal. Only the mapping changes.
 *
 * X-04: the same core path (`DataQueryHandler` + real gateway) runs a home-energy semantic
 * query and a no-industry direct query without any industry branch, and the second
 * declaration pack is reported as declared-but-not-mature rather than as a passed business.
 */

const SOURCE_D: SourceRef = { namespace: 'home-energy', sourceId: 'duckdb-warehouse-b' }
const OBJECT_D: SourceObjectRef = { sourceRef: SOURCE_D, objectPath: 'energy_readings_d' }

/** Naming B: different physical columns, a wh-unit and a numeric status encoding. */
const MAPPING_D: SemanticMapping = defineSemanticMapping('home-energy.mapping.d', '2.0.0', {
  dialect: 'duckdb',
  objects: [
    {
      conceptId: READING_CONCEPT,
      sourceObjectRef: OBJECT_D,
      schema: 'main',
      relation: 'energy_readings_d',
      relationKind: 'table',
      estimatedRows: LOGICAL_ROWS.length,
      timeFieldRef: 'recorded_at',
      fields: [
        { fieldRef: 'reading_id', column: 'reading_id', valueType: 'string', identityKey: true },
        { fieldRef: 'meter_id', column: 'meter_id', valueType: 'string' },
        { fieldRef: 'recorded_at', column: 'recorded_at', valueType: 'timestamp' },
        {
          fieldRef: 'energy_kwh',
          column: 'energy_wh',
          valueType: 'quantity',
          unit: { unitCode: 'kWh', dimension: 'energy' },
          unitFactor: 1000,
        },
        {
          fieldRef: 'status',
          column: 'quality_code',
          valueType: 'enum',
          valueMap: [
            { physical: 1, canonical: 'good' },
            { physical: 0, canonical: 'suspect' },
          ],
        },
      ],
    },
  ],
  links: [],
})

const DUCK_RELATION_C: RegisteredRelation = {
  relation: 'energy_readings_c',
  objectRef: OBJECT_C,
  schemaRevision: '2026-09-01',
  columns: [
    { name: 'reading_id', type: 'string' },
    { name: 'meter_id', type: 'string' },
    { name: 'recorded_at', type: 'timestamp' },
    { name: 'energy_kwh', type: 'decimal' },
    { name: 'status_text', type: 'string' },
  ],
  physicalTypes: { energy_kwh: 'DECIMAL(18,4)', recorded_at: 'TIMESTAMP' },
}

const DUCK_RELATION_D: RegisteredRelation = {
  relation: 'energy_readings_d',
  objectRef: OBJECT_D,
  schemaRevision: '2026-09-01',
  columns: [
    { name: 'reading_id', type: 'string' },
    { name: 'meter_id', type: 'string' },
    { name: 'recorded_at', type: 'timestamp' },
    { name: 'energy_wh', type: 'decimal' },
    { name: 'quality_code', type: 'integer' },
  ],
  physicalTypes: { energy_wh: 'DECIMAL(18,1)', recorded_at: 'TIMESTAMP' },
}

function rowsForMappingD(): readonly (readonly (string | number)[])[] {
  return LOGICAL_ROWS.map(([readingId, meterId, recordedAt, kwh, status]) => [
    readingId,
    meterId,
    recordedAt,
    kwh * 1000,
    status === 'good' ? 1 : 0,
  ])
}

function rowsForMappingC(): readonly (readonly (string | number)[])[] {
  return LOGICAL_ROWS.map(([readingId, meterId, recordedAt, kwh, status]) => [
    readingId,
    meterId,
    recordedAt,
    kwh,
    status === 'good' ? 'ok' : 'bad',
  ])
}

const adapter = new DuckDbQueryAdapter({
  relations: [DUCK_RELATION_C, DUCK_RELATION_D],
  catalogSchemaRevision: '2026-09-01',
  consistency: 'repeatable_read',
})

const CTX: ToolContext = gatewayContext({
  sourceRefs: [SOURCE_C, SOURCE_D],
  deadline: '2099-01-01T00:00:00Z',
})

beforeAll(async () => {
  await adapter.start()
  await adapter.materialiseRelation('energy_readings_c', rowsForMappingC())
  await adapter.materialiseRelation('energy_readings_d', rowsForMappingD())
})

afterAll(() => {
  adapter.close()
})

async function runDataQuery(handler: DataQueryHandler, call: ToolCall): Promise<ToolResult> {
  const harness = buildGateway({ handlers: [handler], ctx: CTX })
  await openGatewayLedger(harness, CTX)
  return harness.gateway.invoke(call, CTX)
}

function semanticCall(callId: string, mapping: SemanticMapping): ToolCall {
  return {
    callId,
    toolId: 'data_query',
    arguments: { kind: 'query', mode: 'semantic', queryPlan: semanticPlan(mapping) },
  }
}

function directCall(callId: string, plan: DirectSqlQueryPlan): ToolCall {
  return { callId, toolId: 'data_query', arguments: { kind: 'query', mode: 'direct', queryPlan: plan } }
}

function semanticHandler(mapping: SemanticMapping): DataQueryHandler {
  return new DataQueryHandler({ query: adapter, mappings: new InMemorySemanticMappingRegistry([mapping]) })
}

describe('X-06 — two real mappings of the same concept produce equal canonical results', () => {
  it('compiles and executes naming A and naming B with only the mapping changed', async () => {
    const runA = await runDataQuery(semanticHandler(MAPPING_C), semanticCall('mapping-a', MAPPING_C))
    const runB = await runDataQuery(semanticHandler(MAPPING_D), semanticCall('mapping-b', MAPPING_D))

    const observationA = observeToolResult(runA)
    const observationB = observeToolResult(runB)
    // The logical evidence digest/source identity legitimately differs because naming A and
    // naming B bind different physical source objects; the canonical result must not.
    expect(
      compareObservations(observationA, observationB, ['logicalEvidenceDigest']),
    ).toEqual([])
    expect(observationA.evidenceCount).toBe(observationB.evidenceCount)
    expect(observationA.status).toBe('ok')
    expect(observationA.rows).toEqual(EXPECTED_ROWS)
    // Each result is tagged with the actual mapping version it used.
    expect(runA.warnings[0]?.message).toContain(`${MAPPING_C.mappingRef.id}@${MAPPING_C.mappingRef.version}`)
    expect(runB.warnings[0]?.message).toContain(`${MAPPING_D.mappingRef.id}@${MAPPING_D.mappingRef.version}`)
  })

  it('runs the home-energy semantic path and the no-industry direct path through the same handler', async () => {
    const semantic = await runDataQuery(semanticHandler(MAPPING_C), semanticCall('home-energy', MAPPING_C))
    const directPlan: DirectSqlQueryPlan = {
      mode: 'direct',
      statementKind: 'select',
      sql: 'SELECT meter_id, energy_kwh FROM energy_readings_c WHERE status_text = ? ORDER BY meter_id',
      parameters: ['ok'],
      referencedObjects: [OBJECT_C],
      readOnly: true,
    }
    const direct = await runDataQuery(
      new DataQueryHandler({ query: adapter, mappings: new InMemorySemanticMappingRegistry([]) }),
      directCall('no-industry', directPlan),
    )

    expect(semantic.status).toBe('ok')
    expect(direct.status).toBe('ok')
    // Both paths went through the same handler class and the same real gateway.
    expect(observeToolResult(direct).rows?.length).toBeGreaterThan(0)
  })
})

describe('X-04 — a second declaration pack is declared but not claimed as mature', () => {
  it('reports home-energy as preview and every other pack as not usable', async () => {
    const harness = await buildPackHarness()
    const entries = await harness.catalogue.listEntries(SCOPE_A, PACK_EDITOR_A)
    const summaries = entries.map((entry) => summarizePackCatalogEntry(entry))
    const homeEnergy = summaries.find((summary) => summary.namespace === 'home-energy')
    expect(homeEnergy?.maturity).toBe('preview')
    expect(homeEnergy?.usable).toBe(false)

    // The other declaration packs exist as preparation material and are not validated business.
    expect(summaries.some((summary) => summary.maturityLabel === 'validated')).toBe(false)
    for (const summary of summaries) expect(summary.usable).toBe(false)
  })
})

describe('X-04 — the core packages contain no industry-specific branch', () => {
  const platformRoot = fileURLToPath(new URL('../..', import.meta.url))
  const corePackages = [
    'packages/core/src',
    'packages/application/src',
    'packages/tool-services/src',
    'packages/semantic-engine/src',
  ]
  const industryToken = /\b(home[-_ ]?energy|energy|solar|battery|meter|kwh)\b/i

  function sourceFiles(relative: string): readonly string[] {
    const root = `${platformRoot.replaceAll('\\', '/')}/${relative}`
    return readdirSync(root, { recursive: true, withFileTypes: false })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => `${root}/${entry}`)
  }

  it('keeps every generic package free of an industry token', () => {
    const offenders: string[] = []
    for (const pkg of corePackages) {
      for (const file of sourceFiles(pkg)) {
        const text = readFileSync(file, 'utf8')
        if (industryToken.test(text)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('X-04 — the DuckDB fixture is real', () => {
  it('reports a real in-process engine version', async () => {
    const version = await adapter.engineVersion()
    expect(version.length).toBeGreaterThan(0)
  })
})
