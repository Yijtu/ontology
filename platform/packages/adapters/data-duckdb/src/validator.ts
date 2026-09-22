import type { RegisteredRelation } from './config'
import { RelationRegistry } from './config'
import { collectFacts, parseStatement, splitStatements, SqlParseError, SqlLexError } from './ast'
import type { ParsedStatement, SqlFacts } from './ast'
import { tokenize } from './lexer'
import type { SqlToken } from './lexer'
import { DuckDbAdapterError } from './errors'

/**
 * The sandbox. It decides what SQL the adapter will run, from the parsed AST plus the
 * allowlists, never from string inspection (SPEC C3):
 *
 *  - a single read-only SELECT / controlled CTE only (no DDL/DML, no writable CTE, no
 *    recursive CTE, no `SELECT ... INTO`, no multi-statement)
 *  - every relation must resolve to a registered object
 *  - every table function must be explicitly allowlisted (default: none)
 *  - dangerous scalar functions (file/network/extension helpers) are refused
 *  - parameters are positional `?` only
 *
 * The engine is additionally configured read-only and with external access disabled, so
 * the sandbox is defence in depth rather than the only barrier.
 */

const FORBIDDEN_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'ATTACH',
  'DETACH',
  'INSTALL',
  'LOAD',
  'PRAGMA',
  'COPY',
  'EXPORT',
  'IMPORT',
  'CREATE',
  'DROP',
  'ALTER',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'TRUNCATE',
  'VACUUM',
  'GRANT',
  'REVOKE',
  'CALL',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SET',
  'RESET',
  'USE',
  'DESCRIBE',
  'SHOW',
  'SUMMARIZE',
  'ANALYZE',
  'CHECKPOINT',
  'SECRET',
  'EXPORT_DATABASE',
  'IMPORT_DATABASE',
])

const FORBIDDEN_FUNCTIONS: ReadonlySet<string> = new Set([
  'attach',
  'detach',
  'install',
  'load',
  'install_extension',
  'load_extension',
  'read_csv',
  'read_csv_auto',
  'read_parquet',
  'read_json',
  'read_json_auto',
  'read_json_objects',
  'read_ndjson',
  'read_ndjson_auto',
  'read_ndjson_objects',
  'read_text',
  'read_blob',
  'read_xlsx',
  'read_arrow',
  'read_ipc',
  'read_avro',
  'read_duckdb',
  'read_gsheets',
  'glob',
  'sniff_csv',
  'parquet_scan',
  'parquet_metadata',
  'parquet_schema',
  'parquet_file_metadata',
  'parquet_kv_metadata',
  'parquet_bloom_probe',
  'csv_scan',
  'json_scan',
  'sqlite_scan',
  'sqlite_attach',
  'postgres_scan',
  'postgres_scan_pushdown',
  'postgres_query',
  'mysql_scan',
  'mysql_query',
  'iceberg_scan',
  'iceberg_metadata',
  'iceberg_snapshots',
  'delta_scan',
  'st_read',
  'st_read_meta',
  'query',
  'query_table',
  'duckdb_extensions',
  'duckdb_settings',
  'getenv',
  'shell',
  'system',
])

const FORBIDDEN_FUNCTION_PREFIXES: readonly string[] = [
  'read_',
  'scan_',
  'parquet_',
  'csv_',
  'iceberg_',
  'delta_',
  'st_',
  'http_',
  'https_',
  's3_',
  'azure_',
  'gcs_',
  'mysql_',
  'postgres_',
  'sqlite_',
  'pragma_',
  'duckdb_',
]

function forbiddenFunction(name: string): boolean {
  const lower = name.toLowerCase()
  if (FORBIDDEN_FUNCTIONS.has(lower)) return true
  return FORBIDDEN_FUNCTION_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

export interface SandboxValidation {
  readonly parsed: ParsedStatement
  readonly facts: SqlFacts
  readonly referencedRelations: readonly RegisteredRelation[]
}

export interface SandboxInput {
  readonly sql: string
  readonly registry: RelationRegistry
  readonly allowedTableFunctions: ReadonlySet<string>
}

function unsupported(message: string, cause?: unknown): DuckDbAdapterError {
  return new DuckDbAdapterError(
    'UNSUPPORTED_QUERY',
    message,
    cause === undefined ? {} : { cause },
  )
}

/**
 * Validate `sql` against the relation/table-function allowlists. Throws
 * `DuckDbAdapterError('UNSUPPORTED_QUERY')` for anything outside the subset.
 */
export function validateSql(input: SandboxInput): SandboxValidation {
  let tokens: SqlToken[]
  let parsed: ParsedStatement
  try {
    tokens = tokenize(input.sql)
    const statements = splitStatements(tokens).filter((statement) =>
      statement.some((token) => token.kind !== 'end'),
    )
    if (statements.length !== 1) {
      throw unsupported(
        statements.length === 0
          ? 'the statement is empty'
          : 'only a single statement is allowed',
      )
    }
    const first = statements[0]
    if (first === undefined) throw unsupported('the statement is empty')
    parsed = parseStatement(first)
  } catch (error) {
    if (error instanceof DuckDbAdapterError) throw error
    if (error instanceof SqlParseError || error instanceof SqlLexError) {
      throw unsupported(`the SQL is outside the accepted read-only subset: ${error.message}`, error)
    }
    throw error
  }

  const facts = collectFacts(parsed.query)

  for (const token of tokens) {
    if (
      (token.kind === 'keyword' || token.kind === 'identifier') &&
      FORBIDDEN_STATEMENT_KEYWORDS.has(token.upper)
    ) {
      throw unsupported(`"${token.text}" is a forbidden statement keyword`)
    }
  }

  for (const name of facts.functions) {
    if (forbiddenFunction(name)) {
      throw unsupported(`the function "${name}" is not permitted in the read-only subset`)
    }
  }

  const cteNames = new Set(facts.cteNames)
  for (const name of facts.tableFunctions) {
    if (!input.allowedTableFunctions.has(name)) {
      throw unsupported(
        `the table function "${name}" is not registered; file, network and extension-backed table functions are refused`,
      )
    }
  }

  const referencedRelations: RegisteredRelation[] = []
  for (const name of facts.relations) {
    if (cteNames.has(name)) continue
    const relation = input.registry.resolve(name)
    if (relation === undefined) {
      throw unsupported(`the object "${name}" is not registered for this source`)
    }
    referencedRelations.push(relation)
  }

  return { parsed, facts, referencedRelations }
}
