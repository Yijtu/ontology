import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDBTypeId, DuckDbAdapterError, DuckDbEngine, DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type { SourceObjectRef } from '@ontology/contracts'
import {
  DUCKDB_SCOPE,
  ENERGY_SOURCE,
  READINGS_ROWS,
  directPlan,
  duckdbContext,
  readingsRelation,
} from '../fixtures/data-query/duckdb-relations'

/**
 * Real DuckDB integration. Nothing here is mocked: the adapter opens a DuckDB instance,
 * materialises the fixture snapshot and executes the queries through the binding.
 */
const NUMBERS_OBJECT: SourceObjectRef = {
  sourceRef: ENERGY_SOURCE,
  objectPath: 'public.numbers',
}

const numbersRelation: RegisteredRelation = {
  relation: 'numbers',
  objectRef: NUMBERS_OBJECT,
  schemaRevision: '2026-09-01',
  columns: [{ name: 'n', type: 'integer' }],
}

const adapter = new DuckDbQueryAdapter({
  relations: [readingsRelation(), numbersRelation],
  catalogSchemaRevision: '2026-09-01',
  now: () => '2026-09-21T00:00:00.000Z',
})

let engineVersion = ''

beforeAll(async () => {
  await adapter.start()
  await adapter.materialiseRelation('readings', READINGS_ROWS)
  const numbers = Array.from({ length: 5000 }, (_, index) => [index + 1] as const)
  await adapter.materialiseRelation('numbers', numbers)
  engineVersion = await adapter.engineVersion()
})

afterAll(() => {
  adapter.close()
})

const snapshotRequest = { consistency: 'repeatable_read' } as const

function limits(overrides: Partial<{ maxRows: number; maxBytes: number; maxDurationMs: number }> = {}) {
  return { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000, ...overrides }
}

describe('DuckDB query adapter (real engine)', () => {
  it('reports the DuckDB engine version from the real binding', () => {
    expect(engineVersion).toMatch(/^v?\d+\.\d+\.\d+/)
  })

  it('returns canonical data, types, coverage and a source snapshot', async () => {
    const ctx = duckdbContext()
    const response = await adapter.execute(
      {
        plan: directPlan({
          sql: 'SELECT meter_id, recorded_at, energy_kwh, is_estimated FROM readings WHERE quality_flag = ? ORDER BY meter_id, recorded_at',
          parameters: [1],
        }),
        limits: limits(),
        snapshotRequest,
      },
      ctx,
    )
    expect(response.columns).toEqual([
      { name: 'meter_id', type: 'string' },
      { name: 'recorded_at', type: 'timestamp' },
      { name: 'energy_kwh', type: 'decimal' },
      { name: 'is_estimated', type: 'boolean' },
    ])
    expect(response.rows).toEqual([
      ['m1', '2026-01-01T00:00:00.000Z', '12.5000', false],
      ['m1', '2026-01-03T00:00:00.000Z', '15.0000', true],
      ['m2', '2026-01-01T00:00:00.000Z', '20.0000', false],
      ['m3', '2026-01-01T00:00:00.000Z', '11.0000', false],
    ])
    expect(response.coverage).toMatchObject({ returned: 4, truncated: false, completeness: 'complete' })
    expect(response.nextCursor).toBeNull()
    expect(response.snapshot.sourceRef).toEqual(ENERGY_SOURCE)
    expect(response.snapshot.schemaVersion).toBe('2026-09-01')
    expect(response.snapshot.consistency).toBe('repeatable_read')
    expect(response.snapshot.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('returns an empty result as a successful page, not an error', async () => {
    const response = await adapter.execute(
      {
        plan: directPlan({
          sql: 'SELECT reading_id FROM readings WHERE quality_flag = ?',
          parameters: [99],
        }),
        limits: limits(),
        snapshotRequest,
      },
      duckdbContext(),
    )
    expect(response.rows).toEqual([])
    expect(response.coverage).toMatchObject({ returned: 0, truncated: false, completeness: 'complete' })
  })

  it('binds filter parameters positionally', async () => {
    const response = await adapter.execute(
      {
        plan: directPlan({
          sql: 'SELECT reading_id FROM readings WHERE meter_id = ? ORDER BY reading_id',
          parameters: ['m2'],
        }),
        limits: limits(),
        snapshotRequest,
      },
      duckdbContext(),
    )
    expect(response.rows).toEqual([['r4'], ['r5']])
  })

  it('marks truncation and paginates with an opaque cursor', async () => {
    const first = await adapter.execute(
      {
        plan: directPlan({
          sql: 'SELECT reading_id FROM readings ORDER BY reading_id',
        }),
        limits: limits({ maxRows: 2 }),
        snapshotRequest,
      },
      duckdbContext(),
    )
    expect(first.rows).toEqual([['r1'], ['r2']])
    expect(first.coverage).toMatchObject({ returned: 2, truncated: true, completeness: 'truncated' })
    expect(first.nextCursor).not.toBeNull()

    const second = await adapter.execute(
      {
        plan: directPlan({ sql: 'SELECT reading_id FROM readings ORDER BY reading_id' }),
        limits: limits({ maxRows: 2 }),
        snapshotRequest,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      },
      duckdbContext(),
    )
    expect(second.rows).toEqual([['r3'], ['r4']])
    expect(second.coverage.truncated).toBe(true)

    const third = await adapter.execute(
      {
        plan: directPlan({ sql: 'SELECT reading_id FROM readings ORDER BY reading_id' }),
        limits: limits({ maxRows: 2 }),
        snapshotRequest,
        ...(second.nextCursor === null ? {} : { cursor: second.nextCursor }),
      },
      duckdbContext(),
    )
    expect(third.rows).toEqual([['r5'], ['r6']])
    expect(third.coverage.truncated).toBe(false)
    expect(third.nextCursor).toBeNull()
  })

  it('honours the byte ceiling by truncating, never silently dropping', async () => {
    const response = await adapter.execute(
      {
        plan: directPlan({ sql: 'SELECT reading_id, energy_kwh FROM readings ORDER BY reading_id' }),
        limits: limits({ maxBytes: 60 }),
        snapshotRequest,
      },
      duckdbContext(),
    )
    expect(response.rows.length).toBeGreaterThan(0)
    expect(response.rows.length).toBeLessThan(6)
    expect(response.coverage.truncated).toBe(true)
    expect(response.coverage.completeness).toBe('truncated')
  })

  it('does not paginate a query that declares its own LIMIT', async () => {
    const response = await adapter.execute(
      {
        plan: directPlan({ sql: 'SELECT reading_id FROM readings ORDER BY reading_id LIMIT 3' }),
        limits: limits({ maxRows: 1000 }),
        snapshotRequest,
      },
      duckdbContext(),
    )
    expect(response.rows).toEqual([['r1'], ['r2'], ['r3']])
    expect(response.coverage.truncated).toBe(false)
    expect(response.nextCursor).toBeNull()
  })

  it('rejects an unregistered object, an unauthorised source and a plan/SQL mismatch', async () => {
    await expect(
      adapter.execute(
        {
          plan: directPlan({
            sql: 'SELECT * FROM secret',
            referencedObjects: [{ sourceRef: ENERGY_SOURCE, objectPath: 'public.secret' }],
          }),
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })

    await expect(
      adapter.execute(
        {
          plan: directPlan({ sql: 'SELECT reading_id FROM readings' }),
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext({ sourceRefs: [] }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      adapter.execute(
        {
          plan: directPlan({ sql: 'SELECT reading_id FROM readings', referencedObjects: [] }),
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })

  it('rejects a parameter-count mismatch and semantic plans', async () => {
    await expect(
      adapter.execute(
        {
          plan: directPlan({ sql: 'SELECT reading_id FROM readings WHERE meter_id = ?' }),
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    await expect(
      adapter.execute(
        {
          plan: {
            mode: 'semantic',
            concepts: ['energy.reading'],
            fields: ['energy.kwh'],
            links: [],
            filters: [],
            orderBy: [],
            limit: 10,
            mappingVersion: { id: 'map', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` },
          },
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })

  it('validates plans without executing them', async () => {
    const valid = await adapter.validate(
      {
        plan: directPlan({ sql: 'SELECT reading_id FROM readings WHERE quality_flag = ?', parameters: [1] }),
        limits: limits(),
      },
      duckdbContext(),
    )
    expect(valid.valid).toBe(true)
    expect(valid.normalizedPlan?.mode).toBe('direct')

    const invalid = await adapter.validate(
      {
        plan: directPlan({ sql: "SELECT * FROM read_csv('/etc/passwd')" }),
        limits: limits(),
      },
      duckdbContext(),
    )
    expect(invalid.valid).toBe(false)
    expect(invalid.rejectedReason?.code).toBe('UNSUPPORTED_QUERY')
  })

  it('describes and lists the catalog with pagination', async () => {
    const described = await adapter.describe({ scopeRef: DUCKDB_SCOPE }, duckdbContext())
    expect(described.schemaRevision).toBe('2026-09-01')
    expect(described.resources.map((resource) => resource.objectRef.objectPath).sort()).toEqual([
      'public.energy_readings',
      'public.numbers',
    ])
    const readings = described.resources.find(
      (resource) => resource.objectRef.objectPath === 'public.energy_readings',
    )
    expect(readings?.columns).toEqual([
      { name: 'reading_id', type: 'string' },
      { name: 'meter_id', type: 'string' },
      { name: 'recorded_at', type: 'timestamp' },
      { name: 'energy_kwh', type: 'decimal' },
      { name: 'quality_flag', type: 'integer' },
      { name: 'is_estimated', type: 'boolean' },
    ])

    const firstPage = await adapter.listResources(
      { scopeRef: DUCKDB_SCOPE, limit: 1 },
      duckdbContext(),
    )
    expect(firstPage.resources).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()
    const secondPage = await adapter.listResources(
      {
        scopeRef: DUCKDB_SCOPE,
        limit: 1,
        ...(firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor }),
      },
      duckdbContext(),
    )
    expect(secondPage.resources).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
  })

  it('cancels a running query by interrupting the engine', async () => {
    const ctx = duckdbContext()
    const plan = directPlan({
      sql: 'SELECT sum(a.n * b.n + c.n * d.n) FROM numbers AS a, numbers AS b, numbers AS c, numbers AS d',
      referencedObjects: [NUMBERS_OBJECT],
    })
    const pending = adapter.execute(
      { plan, limits: limits({ maxDurationMs: 60_000 }), snapshotRequest },
      ctx,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const cancelled = await adapter.cancel({ targetRef: ctx.runId, reason: 'user cancelled' }, ctx)
    expect(cancelled.state).toBe('cancelling')
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('fails with DEADLINE_EXCEEDED when the run deadline has passed', async () => {
    await expect(
      adapter.execute(
        {
          plan: directPlan({ sql: 'SELECT reading_id FROM readings' }),
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext({ deadline: '2020-01-01T00:00:00Z' }),
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  })

  it('rejects a query with no registered source', async () => {
    await expect(
      adapter.execute(
        {
          plan: directPlan({ sql: 'SELECT 1 AS one', referencedObjects: [] }),
          limits: limits(),
          snapshotRequest,
        },
        duckdbContext(),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })
})

describe('DuckDB engine hardening (real engine)', () => {
  it('enforces read-only at the engine level, independently of the AST sandbox', async () => {
    const engine = new DuckDbEngine()
    await engine.start()
    const session = await engine.createSession()
    try {
      await expect(
        session.executeReadOnly('CREATE TABLE forbidden (a INTEGER)', [], 10),
      ).rejects.toThrow(/read-only mode/i)
      await expect(
        session.executeReadOnly('CREATE VIEW forbidden_view AS SELECT 1', [], 10),
      ).rejects.toThrow(/read-only mode/i)
    } finally {
      session.close()
      engine.close()
    }
  })

  it('blocks file access and extension loading even when the AST sandbox is bypassed', async () => {
    const engine = new DuckDbEngine()
    await engine.start()
    const session = await engine.createSession()
    try {
      await expect(
        session.executeReadOnly("SELECT * FROM read_csv('/etc/passwd')", [], 10),
      ).rejects.toThrow(/Permission Error|disabled/i)
      await expect(session.executeReadOnly("ATTACH '/tmp/x.db' AS x", [], 10)).rejects.toThrow(
        /Permission Error|disabled/i,
      )
      await expect(session.executeReadOnly('INSTALL httpfs', [], 10)).rejects.toThrow(
        /Permission Error|disabled/i,
      )
      await expect(session.executeReadOnly('LOAD httpfs', [], 10)).rejects.toThrow(
        /Permission Error|disabled|not found/i,
      )
    } finally {
      session.close()
      engine.close()
    }
  })

  it('reports the DuckDB type ids the adapter normalises from', () => {
    expect(DuckDBTypeId.BIGINT).toBe(5)
    expect(DuckDBTypeId.DECIMAL).toBe(19)
  })
})

describe('DuckDB adapter error classification', () => {
  it('exposes a classified adapter error type', () => {
    const error = new DuckDbAdapterError('UNSUPPORTED_QUERY', 'x')
    expect(error.code).toBe('UNSUPPORTED_QUERY')
    expect(error.remoteStateUnknown).toBe(false)
  })
})
