import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type { QueryColumn } from '@ontology/contracts'
import { ENERGY_SOURCE, duckdbContext } from '../fixtures/data-query/duckdb-relations'

/**
 * X-03: same semantic fixture, DuckDB vs PostgreSQL normalised-result equivalence.
 *
 * The PostgreSQL adapter (LOCAL-012 / #43) is a parallel node and is still a stub on
 * `main`, so the live cross-engine comparison cannot be run without faking it. What this
 * test verifies instead:
 *   1. the DuckDB adapter produces exactly the committed normalised-expected result;
 *   2. the snapshot digest equals an *independently* computed digest of that expected
 *      result (the digest is not read back from the adapter);
 *   3. the fixture is shared, so the PostgreSQL adapter can assert equality against the
 *      same `x03-expected.json`.
 *
 * If the PostgreSQL adapter lands on `main` first, this test fails loudly so the real
 * cross-engine comparison is wired instead of the pending path silently continuing.
 */
interface DatasetFixture {
  readonly relation: string
  readonly objectPath: string
  readonly schemaRevision: string
  readonly columns: readonly QueryColumn[]
  readonly physicalTypes?: Readonly<Record<string, string>>
  readonly rows: readonly (readonly (string | number | boolean | null)[])[]
}

interface ExpectedFixture {
  readonly logicalQuery: string
  readonly postgresQuery: string
  readonly parameters: readonly (string | number | boolean | null)[]
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly (readonly unknown[])[]
  readonly crossEngine: { readonly status: string; readonly note: string }
}

function readJson<T>(relative: string): T {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

const dataset = readJson<DatasetFixture>('../fixtures/data-query/x03-dataset.json')
const expected = readJson<ExpectedFixture>('../fixtures/data-query/x03-expected.json')

const relation: RegisteredRelation = {
  relation: dataset.relation,
  objectRef: { sourceRef: ENERGY_SOURCE, objectPath: dataset.objectPath },
  schemaRevision: dataset.schemaRevision,
  columns: dataset.columns,
  ...(dataset.physicalTypes === undefined ? {} : { physicalTypes: dataset.physicalTypes }),
}

/** Independent canonical JSON + digest, so the adapter's digest is not self-verified. */
function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

function independentDigest(columns: readonly QueryColumn[], rows: readonly (readonly unknown[])[]): string {
  const payload = stableStringify({
    columns: columns.map((column) => ({ name: column.name, type: column.type })),
    rows,
  })
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}

const adapter = new DuckDbQueryAdapter({
  relations: [relation],
  catalogSchemaRevision: dataset.schemaRevision,
  now: () => '2026-09-21T00:00:00.000Z',
})

beforeAll(async () => {
  await adapter.start()
  await adapter.materialiseRelation(dataset.relation, dataset.rows)
})

afterAll(() => {
  adapter.close()
})

describe('X-03 DuckDB normalised-result equivalence', () => {
  it('returns the committed normalised-expected result for the shared fixture', async () => {
    const response = await adapter.execute(
      {
        plan: {
          mode: 'direct',
          statementKind: 'select',
          sql: expected.logicalQuery,
          parameters: [...expected.parameters],
          referencedObjects: [relation.objectRef],
          readOnly: true,
        },
        limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000 },
        snapshotRequest: { consistency: 'repeatable_read' },
      },
      duckdbContext(),
    )
    expect(response.columns).toEqual(expected.columns)
    expect(response.rows).toEqual(expected.rows)
  })

  it('produces a result digest equal to an independently computed digest', async () => {
    const response = await adapter.execute(
      {
        plan: {
          mode: 'direct',
          statementKind: 'select',
          sql: expected.logicalQuery,
          parameters: [...expected.parameters],
          referencedObjects: [relation.objectRef],
          readOnly: true,
        },
        limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000 },
        snapshotRequest: { consistency: 'repeatable_read' },
      },
      duckdbContext(),
    )
    expect(response.snapshot.resultDigest).toBe(
      independentDigest(expected.columns, expected.rows),
    )
  })

  it('records that the real cross-engine comparison is available', () => {
    const postgresIndex = readFileSync(
      fileURLToPath(new URL('../../packages/adapters/data-postgres/src/index.ts', import.meta.url)),
      'utf8',
    ).trim()
    // The PostgreSQL adapter has landed, so the pending path must not be used: the live
    // comparison runs in x03-cross-engine-equivalence.spec.ts.
    expect(postgresIndex).not.toBe('export {}')
    expect(expected.crossEngine.status).toBe('verified')
    expect(expected.postgresQuery).toContain('$1')
    expect(expected.logicalQuery).toContain('?')
  })
})
