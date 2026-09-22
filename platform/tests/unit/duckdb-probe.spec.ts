import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DATA_DUCKDB_ADAPTER_REF,
  DuckDbAdapterError,
  DuckDbQueryAdapter,
} from '@ontology/adapter-data-duckdb'
import { SecretValue } from '@ontology/contracts'
import type { SourceObjectRef, SourceProbeRequest } from '@ontology/contracts'
import { ENERGY_SOURCE, READINGS_ROWS, duckdbContext, readingsRelation } from '../fixtures/data-query/duckdb-relations'

/**
 * The DuckDB probe runs against the real in-process engine: it reads the live catalog,
 * attempts a real interrupt and observes type support. Nothing here is mocked.
 */
const PROBE_SECRET = 'duckdb-probe-secret-DO-NOT-LEAK-4b21'

const MISSING_OBJECT: SourceObjectRef = {
  sourceRef: ENERGY_SOURCE,
  objectPath: 'public.not_materialised',
}

const adapter = new DuckDbQueryAdapter({
  relations: [readingsRelation()],
  catalogSchemaRevision: '2026-09-01',
  now: () => '2026-09-21T00:00:00.000Z',
})

beforeAll(async () => {
  await adapter.start()
  await adapter.materialiseRelation('readings', READINGS_ROWS)
})

afterAll(() => {
  adapter.close()
})

function probeRequest(overrides: Partial<SourceProbeRequest> = {}): SourceProbeRequest {
  return {
    role: 'telemetry',
    secretRef: 'secret://vault/duckdb',
    secret: new SecretValue(PROBE_SECRET),
    requestedCapabilities: [],
    ...overrides,
  }
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('DuckDB SourceProbeAdapter (real engine)', () => {
  it('reports the observed catalog, pagination, cancellation, consistency and types', async () => {
    const observation = await adapter.probe(probeRequest(), duckdbContext())

    expect(observation.adapterRef).toEqual(DATA_DUCKDB_ADAPTER_REF)
    expect(observation.catalog.resources).toHaveLength(1)
    const resource = observation.catalog.resources[0]
    expect(resource?.objectRef).toEqual(readingsRelation().objectRef)
    expect(resource?.columns.map((column) => column.name)).toEqual([
      'reading_id',
      'meter_id',
      'recorded_at',
      'energy_kwh',
      'quality_flag',
      'is_estimated',
    ])
    expect(resource?.columns.map((column) => column.type)).toEqual([
      'string',
      'string',
      'timestamp',
      'decimal',
      'integer',
      'boolean',
    ])
    expect(observation.catalog.schemaRevision).toBe(observation.snapshot.schemaRevision)

    expect(observation.pagination).toEqual({ kind: 'opaque_cursor', pagesFetched: 1, exhausted: true })
    expect(observation.cancellation).toEqual({ support: 'supported', attempted: true })
    expect(observation.snapshot.consistency).toBe('repeatable_read')
    expect(observation.limits).toMatchObject({ maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000 })
    expect(observation.capabilities.map((capability) => capability.name)).toEqual([
      'catalog.describe',
      'structured_query.execute',
    ])
    // The observed type set is exactly what the engine accepted, in the order the probe tried.
    expect(observation.supportedDataTypes).toEqual([
      'string',
      'integer',
      'decimal',
      'boolean',
      'timestamp',
      'json',
      'binary',
    ])
    expect(JSON.stringify(observation)).not.toContain(PROBE_SECRET)
  }, 60_000)

  it('reports more than one page when the catalog has more than one relation', async () => {
    const twoRelations = new DuckDbQueryAdapter({
      relations: [
        readingsRelation(),
        {
          relation: 'numbers',
          objectRef: { sourceRef: ENERGY_SOURCE, objectPath: 'public.numbers' },
          schemaRevision: '2026-09-01',
          columns: [{ name: 'n', type: 'integer' }],
        },
      ],
      catalogSchemaRevision: '2026-09-01',
    })
    await twoRelations.start()
    await twoRelations.materialiseRelation('readings', READINGS_ROWS)
    await twoRelations.materialiseRelation('numbers', [[1], [2], [3]])
    try {
      const observation = await twoRelations.probe(probeRequest(), duckdbContext())
      expect(observation.pagination).toEqual({ kind: 'opaque_cursor', pagesFetched: 2, exhausted: true })
    } finally {
      twoRelations.close()
    }
  }, 60_000)

  it('fails when a registered relation was never materialised instead of reporting it', async () => {
    const partial = new DuckDbQueryAdapter({
      relations: [
        readingsRelation(),
        {
          relation: 'not_materialised',
          objectRef: MISSING_OBJECT,
          schemaRevision: '2026-09-01',
          columns: [{ name: 'x', type: 'string' }],
        },
      ],
      catalogSchemaRevision: '2026-09-01',
    })
    await partial.start()
    await partial.materialiseRelation('readings', READINGS_ROWS)
    try {
      const error = await failureOf(partial.probe(probeRequest(), duckdbContext()))
      expect(error).toBeInstanceOf(DuckDbAdapterError)
      expect(error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
    } finally {
      partial.close()
    }
  }, 60_000)

  it('fails when the source registers no relation at all', async () => {
    const empty = new DuckDbQueryAdapter({ relations: [], catalogSchemaRevision: '2026-09-01' })
    await empty.start()
    try {
      const error = await failureOf(empty.probe(probeRequest(), duckdbContext()))
      expect(error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
      expect(String((error as Error).message)).not.toContain(PROBE_SECRET)
    } finally {
      empty.close()
    }
  }, 60_000)
})
