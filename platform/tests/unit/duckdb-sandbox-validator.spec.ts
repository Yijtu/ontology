import { describe, expect, it } from 'vitest'
import { DuckDbAdapterError, RelationRegistry, validateSql } from '@ontology/adapter-data-duckdb'
import { readingsRelation } from '../fixtures/data-query/duckdb-relations'

/**
 * The sandbox is the core of LOCAL-013: every forbidden class must be refused from the
 * parsed AST, not from a string prefix. These tests never start the DuckDB engine, so a
 * failure isolates the validator rather than the database.
 */
const registry = new RelationRegistry([readingsRelation()])
const noTableFunctions: ReadonlySet<string> = new Set()

function accept(sql: string) {
  return validateSql({ sql, registry, allowedTableFunctions: noTableFunctions })
}

function reject(sql: string): DuckDbAdapterError {
  try {
    accept(sql)
  } catch (error) {
    if (error instanceof DuckDbAdapterError) return error
    throw error
  }
  throw new Error(`expected "${sql}" to be rejected`)
}

describe('DuckDB sandbox validator', () => {
  it('accepts a plain read-only SELECT and records its parameters', () => {
    const result = accept(
      'SELECT reading_id, energy_kwh FROM readings WHERE quality_flag = ? ORDER BY recorded_at LIMIT 10',
    )
    expect(result.facts.relations).toEqual(['readings'])
    expect(result.facts.parameters).toBe(1)
    expect(result.facts.hasExplicitLimit).toBe(true)
    expect(result.referencedRelations).toHaveLength(1)
  })

  it('accepts a controlled CTE and a JOIN over registered relations', () => {
    const cte = accept('WITH r AS (SELECT * FROM readings) SELECT count(*) FROM r')
    expect(cte.facts.relations).toEqual(['readings'])
    expect(cte.facts.cteNames).toEqual(['r'])

    const join = accept(
      'SELECT a.reading_id FROM readings AS a JOIN readings AS b ON a.meter_id = b.meter_id',
    )
    expect(join.facts.relations).toEqual(['readings'])
  })

  it('accepts set operations, derived tables and parameterised IN lists', () => {
    expect(() =>
      accept('SELECT meter_id FROM readings UNION ALL SELECT meter_id FROM readings'),
    ).not.toThrow()
    expect(() =>
      accept('SELECT * FROM (SELECT meter_id FROM readings) AS sub'),
    ).not.toThrow()
    expect(() =>
      accept('SELECT * FROM readings WHERE meter_id IN (?, ?)'),
    ).not.toThrow()
  })

  it('rejects unregistered file table functions', () => {
    for (const sql of [
      "SELECT * FROM read_csv('/etc/passwd')",
      "SELECT * FROM read_csv_auto('/etc/passwd')",
      "SELECT * FROM read_parquet('/tmp/x.parquet')",
      "SELECT * FROM read_json('/tmp/x.json')",
      "SELECT * FROM read_ndjson('/tmp/x.ndjson')",
      "SELECT * FROM read_text('/etc/passwd')",
      "SELECT * FROM read_blob('/etc/passwd')",
      "SELECT * FROM glob('/**')",
      "SELECT * FROM parquet_scan('/tmp/x.parquet')",
      "SELECT * FROM sqlite_scan('/tmp/x.db', 't')",
      "SELECT * FROM postgres_scan('host=evil', 'public', 't')",
      "SELECT * FROM query('SELECT 1')",
      "SELECT * FROM query_table('readings')",
      "SELECT * FROM duckdb_settings()",
    ]) {
      expect(reject(sql).code, sql).toBe('UNSUPPORTED_QUERY')
    }
  })

  it('rejects dangerous scalar functions including file/extension helpers', () => {
    for (const sql of [
      "SELECT read_text('/etc/passwd') FROM readings",
      "SELECT glob('/**') FROM readings",
      "SELECT getenv('PATH') FROM readings",
      "SELECT load_extension('httpfs') FROM readings",
      "SELECT install_extension('httpfs') FROM readings",
      "SELECT pragma_enable_external_access(true) FROM readings",
      "SELECT * FROM pragma_database_size()",
    ]) {
      expect(reject(sql).code, sql).toBe('UNSUPPORTED_QUERY')
    }
  })

  it('rejects ATTACH, DETACH, INSTALL and LOAD', () => {
    for (const sql of [
      "ATTACH '/tmp/other.db' AS other",
      "ATTACH DATABASE ':memory:' AS other",
      'DETACH other',
      "INSTALL httpfs",
      "INSTALL 'httpfs'",
      'LOAD httpfs',
      "LOAD 'httpfs'",
    ]) {
      expect(reject(sql).code, sql).toBe('UNSUPPORTED_QUERY')
    }
  })

  it('rejects DDL and DML statements', () => {
    for (const sql of [
      'CREATE TABLE t (a INTEGER)',
      'DROP TABLE readings',
      'ALTER TABLE readings ADD COLUMN x INTEGER',
      'INSERT INTO readings VALUES (1)',
      'UPDATE readings SET quality_flag = 0',
      'DELETE FROM readings',
      'TRUNCATE readings',
      'MERGE INTO readings USING readings AS s ON true WHEN MATCHED THEN DO NOTHING',
      "COPY readings TO '/tmp/out.csv'",
      'PRAGMA enable_external_access',
      "SET enable_external_access = true",
      "CALL pragma_enable_external_access(true)",
      'VACUUM',
      'ANALYZE readings',
    ]) {
      expect(reject(sql).code, sql).toBe('UNSUPPORTED_QUERY')
    }
  })

  it('rejects writable and recursive CTEs', () => {
    expect(
      reject('WITH x AS (INSERT INTO readings VALUES (1) RETURNING *) SELECT * FROM x').code,
    ).toBe('UNSUPPORTED_QUERY')
    expect(
      reject('WITH x AS (DELETE FROM readings RETURNING *) SELECT * FROM x').code,
    ).toBe('UNSUPPORTED_QUERY')
    expect(
      reject('WITH x AS (UPDATE readings SET quality_flag = 0 RETURNING *) SELECT * FROM x').code,
    ).toBe('UNSUPPORTED_QUERY')
    expect(reject('WITH RECURSIVE x AS (SELECT 1) SELECT * FROM x').code).toBe('UNSUPPORTED_QUERY')
  })

  it('rejects multi-statement input and semicolon/comment bypasses', () => {
    expect(reject('SELECT reading_id FROM readings; SELECT meter_id FROM readings').code).toBe(
      'UNSUPPORTED_QUERY',
    )
    expect(
      reject('SELECT reading_id FROM readings -- ;\n; DROP TABLE readings').code,
    ).toBe('UNSUPPORTED_QUERY')
    expect(reject('SELECT reading_id FROM readings /* ; */ ; SELECT 1').code).toBe(
      'UNSUPPORTED_QUERY',
    )
    expect(() => accept('SELECT reading_id FROM readings;')).not.toThrow()
  })

  it('rejects keyword splitting, dollar quoting and named parameters', () => {
    expect(reject('SEL/**/ECT * FROM readings').code).toBe('UNSUPPORTED_QUERY')
    expect(reject('SELECT * FROM readings WHERE meter_id = $1').code).toBe('UNSUPPORTED_QUERY')
    expect(reject("SELECT $$x$$ FROM readings").code).toBe('UNSUPPORTED_QUERY')
    expect(reject('SELECT `meter_id` FROM readings').code).toBe('UNSUPPORTED_QUERY')
  })

  it('rejects SELECT ... INTO and unregistered objects', () => {
    expect(reject('SELECT * INTO other FROM readings').code).toBe('UNSUPPORTED_QUERY')
    expect(reject('SELECT * FROM secret_readings').code).toBe('UNSUPPORTED_QUERY')
    expect(reject('SELECT * FROM readings JOIN secret_readings ON true').code).toBe(
      'UNSUPPORTED_QUERY',
    )
  })

  it('only allows table functions that configuration explicitly registers', () => {
    const allowed = new Set(['generate_series'])
    const result = validateSql({
      sql: 'SELECT * FROM generate_series(1, 3)',
      registry,
      allowedTableFunctions: allowed,
    })
    expect(result.facts.tableFunctions).toEqual(['generate_series'])
    expect(
      reject("SELECT * FROM generate_series(1, 3) WHERE reading_id = read_text('/etc/passwd')").code,
    ).toBe('UNSUPPORTED_QUERY')
  })

  it('accepts a FROM-less SELECT at the validator layer (the adapter requires a source)', () => {
    const result = accept('SELECT 1 AS one')
    expect(result.facts.relations).toEqual([])
    expect(result.referencedRelations).toEqual([])
  })
})
