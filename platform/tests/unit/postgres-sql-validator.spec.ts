import { describe, expect, it } from 'vitest'
import type { ScalarValue, SourceObjectRef, SourceRef } from '@ontology/contracts'
import { validateReadOnlySql } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping, SqlValidationResult } from '@ontology/adapter-data-postgres'

const SALES_SOURCE: SourceRef = { namespace: 'demo', sourceId: 'sales-db' }
const OTHER_SOURCE: SourceRef = { namespace: 'demo', sourceId: 'other-db' }

const MAPPINGS: readonly BusinessObjectMapping[] = [
  {
    objectRef: { sourceRef: SALES_SOURCE, objectPath: 'sales.orders' },
    schema: 'sales',
    relation: 'orders',
    relationKind: 'table',
  },
  {
    objectRef: { sourceRef: SALES_SOURCE, objectPath: 'sales.customers' },
    schema: 'sales',
    relation: 'customers',
    relationKind: 'table',
  },
  {
    objectRef: { sourceRef: OTHER_SOURCE, objectPath: 'other.secrets' },
    schema: 'other',
    relation: 'secrets',
    relationKind: 'table',
  },
]

const AUTHORIZED: readonly SourceRef[] = [SALES_SOURCE]

function declared(...objectPaths: readonly string[]): SourceObjectRef[] {
  return objectPaths.map((objectPath) => ({ sourceRef: SALES_SOURCE, objectPath }))
}

function validate(
  sql: string,
  options?: {
    readonly parameters?: readonly ScalarValue[]
    readonly declared?: readonly SourceObjectRef[]
    readonly allowlist?: readonly BusinessObjectMapping[]
    readonly authorized?: readonly SourceRef[]
  },
): SqlValidationResult {
  return validateReadOnlySql({
    sql,
    parameters: options?.parameters ?? [],
    allowlist: options?.allowlist ?? MAPPINGS,
    declaredObjects: options?.declared ?? declared('sales.orders'),
    authorizedSourceRefs: options?.authorized ?? AUTHORIZED,
  })
}

function rejectionCode(result: SqlValidationResult): string {
  if (result.valid) throw new Error('expected a rejection')
  return result.code
}

describe('declared read-only SQL subset — accepted', () => {
  it('accepts a single parameterised SELECT', () => {
    const result = validate('SELECT id, amount FROM sales.orders WHERE customer = $1', {
      parameters: ['acme'],
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.referencedObjects).toEqual(declared('sales.orders'))
  })

  it('accepts a controlled read-only CTE', () => {
    const result = validate(
      'WITH recent AS (SELECT id FROM sales.orders WHERE id > $1) SELECT id FROM recent',
      { parameters: [10] },
    )
    expect(result.valid).toBe(true)
  })

  it('accepts an unqualified relation when it is unambiguous', () => {
    const result = validate('SELECT id FROM orders')
    expect(result.valid).toBe(true)
  })

  it('accepts a read-only function on the allowlist and a join', () => {
    const result = validate(
      'SELECT lower(c.name), count(*) FROM sales.orders o JOIN sales.customers c ON o.customer = c.name GROUP BY c.name',
      { declared: declared('sales.orders', 'sales.customers') },
    )
    expect(result.valid).toBe(true)
  })

  it('accepts a read-only compound of SELECTs', () => {
    const result = validate('SELECT id FROM sales.orders UNION ALL SELECT id FROM sales.customers', {
      declared: declared('sales.orders', 'sales.customers'),
    })
    expect(result.valid).toBe(true)
  })

  it('strips trailing comments and separators from the executable statement', () => {
    const result = validate('SELECT id FROM sales.orders WHERE id = $1; -- trailing comment', {
      parameters: [1],
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.executableSql).not.toContain('--')
    expect(result.executableSql).not.toContain(';')
    expect(result.executableSql).toContain('sales.orders')
  })

  it('does not treat a dollar sign inside a string literal as a parameter', () => {
    const result = validate("SELECT id FROM sales.orders WHERE customer = '$1'")
    expect(result.valid).toBe(true)
  })
})

describe('writable CTEs are rejected', () => {
  it('rejects WITH ... AS (INSERT ...)', () => {
    const result = validate(
      'WITH x AS (INSERT INTO sales.orders (id) VALUES (1) RETURNING id) SELECT id FROM x',
    )
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
  })

  it('rejects WITH ... AS (UPDATE ...)', () => {
    const result = validate(
      "WITH x AS (UPDATE sales.orders SET customer = 'x' RETURNING id) SELECT id FROM x",
    )
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
  })

  it('rejects WITH ... AS (DELETE ...)', () => {
    const result = validate('WITH x AS (DELETE FROM sales.orders RETURNING id) SELECT id FROM x')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
  })
})

describe('DDL / DML / session statements are rejected', () => {
  const statements = [
    'CREATE TABLE sales.t (id int)',
    'DROP TABLE sales.orders',
    'ALTER TABLE sales.orders ADD COLUMN x int',
    'TRUNCATE TABLE sales.orders',
    'INSERT INTO sales.orders (id) VALUES (1)',
    'UPDATE sales.orders SET customer = \'x\'',
    'DELETE FROM sales.orders',
    'CREATE EXTENSION postgres_fdw',
    "LOAD 'evil'",
    "COPY sales.orders TO '/tmp/orders.csv'",
    "COPY sales.orders FROM '/tmp/orders.csv'",
    'SET search_path TO other',
    'GRANT SELECT ON sales.orders TO public',
    'EXPLAIN SELECT * FROM sales.orders',
  ]
  for (const statement of statements) {
    it(`rejects ${statement.split(' ').slice(0, 3).join(' ')}`, () => {
      const result = validate(statement)
      expect(result.valid).toBe(false)
      expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
    })
  }
})

describe('dangerous file / network / admin functions are rejected', () => {
  const statements = [
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_read_binary_file('/etc/passwd')",
    "SELECT pg_ls_dir('/')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    'SELECT pg_sleep(10)',
    "SELECT current_setting('search_path')",
    "SELECT set_config('search_path', 'other', true)",
    "SELECT dblink('host=evil', 'select 1')",
    "SELECT query_to_xml('select 1', true, false, '')",
    'SELECT pg_terminate_backend(1)',
    'SELECT pg_catalog.pg_read_file($1)',
  ]
  for (const statement of statements) {
    it(`rejects ${statement}`, () => {
      const result = validate(statement, { parameters: ['/etc/passwd'] })
      expect(result.valid).toBe(false)
      expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
    })
  }
})

describe('arbitrary UDFs and DuckDB-style table functions are rejected', () => {
  const statements = [
    'SELECT my_custom_function(1)',
    'SELECT * FROM my_udf()',
    "SELECT * FROM read_csv('/tmp/x.csv')",
    "SELECT * FROM read_parquet('/tmp/x.parquet')",
    "SELECT * FROM read_json('/tmp/x.json')",
    "SELECT * FROM glob('/tmp/*')",
    "SELECT * FROM delta_scan('/tmp/delta')",
    "SELECT * FROM iceberg_scan('/tmp/iceberg')",
  ]
  for (const statement of statements) {
    it(`rejects ${statement}`, () => {
      const result = validate(statement)
      expect(result.valid).toBe(false)
      expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
    })
  }
})

describe('object allowlist rejects unauthorised access', () => {
  it('rejects a cross-schema relation that is not mapped', () => {
    const result = validate('SELECT * FROM public.orders')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })

  it('rejects a catalog relation', () => {
    const result = validate('SELECT * FROM pg_catalog.pg_class')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })

  it('rejects a mapped relation whose source is not authorised for the principal', () => {
    const result = validate('SELECT * FROM other.secrets')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })

  it('rejects a dangerous relation hidden inside a CTE', () => {
    const result = validate('WITH x AS (SELECT * FROM other.secrets) SELECT * FROM x')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })

  it('rejects an unqualified relation that is ambiguous in the mapping', () => {
    const ambiguous: readonly BusinessObjectMapping[] = [
      ...MAPPINGS,
      {
        objectRef: { sourceRef: SALES_SOURCE, objectPath: 'archive.orders' },
        schema: 'archive',
        relation: 'orders',
        relationKind: 'table',
      },
    ]
    const result = validate('SELECT * FROM orders', { allowlist: ambiguous })
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })

  it('rejects an identifier crafted from user text', () => {
    const result = validate('SELECT * FROM "orders; DROP TABLE sales.orders"')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })
})

describe('multi-statement and comment/separator bypasses are rejected', () => {
  const statements = [
    'SELECT 1; DROP TABLE sales.orders',
    'SELECT * FROM sales.orders; SELECT * FROM sales.customers',
    'SELECT * FROM sales.orders; /* hidden */ DROP TABLE sales.orders',
    'SELECT * FROM sales.orders\n; DELETE FROM sales.orders',
    '/* lead */ DROP TABLE sales.orders',
  ]
  for (const statement of statements) {
    it(`rejects ${JSON.stringify(statement)}`, () => {
      const result = validate(statement)
      expect(result.valid).toBe(false)
      expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
    })
  }

  it('still enforces the AST when the statement is comment-prefixed', () => {
    const result = validate('/* harmless */ SELECT * FROM other.secrets')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('FORBIDDEN')
  })
})

describe('parameter binding', () => {
  it('rejects a parameter index beyond the supplied values', () => {
    const result = validate('SELECT id FROM sales.orders WHERE id = $2', { parameters: [1] })
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('INVALID_ARGUMENT')
  })

  it('accepts an injection-shaped value because it is bound, not interpolated', () => {
    const result = validate('SELECT id FROM sales.orders WHERE customer = $1', {
      parameters: ["x'; DROP TABLE sales.orders; --"],
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.executableSql).not.toContain('DROP TABLE')
    expect(result.referencedObjects).toEqual(declared('sales.orders'))
  })
})

describe('plan/statement consistency', () => {
  it('rejects reading an object the plan did not declare', () => {
    const result = validate('SELECT id FROM sales.customers', { declared: declared('sales.orders') })
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('INVALID_ARGUMENT')
  })

  it('warns when a declared object is not referenced', () => {
    const result = validate('SELECT id FROM sales.orders', {
      declared: declared('sales.orders', 'sales.customers'),
    })
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.warnings.some((warning) => warning.includes('sales.customers'))).toBe(true)
  })

  it('rejects a top-level VALUES statement', () => {
    const result = validate('VALUES (1), (2)')
    expect(result.valid).toBe(false)
    expect(rejectionCode(result)).toBe('UNSUPPORTED_QUERY')
  })
})
