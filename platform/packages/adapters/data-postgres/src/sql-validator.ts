import { parse } from 'pgsql-ast-parser'
import type { ErrorCode, ScalarValue, SourceObjectRef, SourceRef } from '@ontology/contracts'
import {
  isAmbiguousRelation,
  resolveMapping,
  sourceRefAuthorized,
} from './mapping'
import type { BusinessObjectMapping } from './mapping'

/**
 * The declared read-only SQL subset.
 *
 * A single read-only `SELECT` (optionally a controlled CTE / read-only compound) is
 * accepted. The subset is enforced by a real parser/AST, not by inspecting the first
 * keyword: every table reference must resolve through the confirmed mapping allowlist,
 * every function call must be on the read-only allowlist, no write/DDL statement may
 * appear anywhere (including inside a CTE), and parameters are always bound.
 */

const ROOT_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'select',
  'with',
  'union',
  'union all',
  'intersect',
  'intersect all',
  'except',
  'except all',
])

const CTE_BIND_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'select',
  'with',
  'union',
  'union all',
  'intersect',
  'intersect all',
  'except',
  'except all',
  'values',
])

/**
 * Statement node types that must never appear anywhere in the tree. Write, DDL, session,
 * transaction, copy and administrative statements all land here, so a writable CTE
 * (`WITH x AS (INSERT ...) SELECT ...`) is rejected even though its root is a SELECT.
 */
const FORBIDDEN_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'truncate table',
  'create table',
  'create index',
  'create sequence',
  'create schema',
  'create extension',
  'create view',
  'create materialized view',
  'create function',
  'create procedure',
  'create trigger',
  'create type',
  'create enum',
  'create composite type',
  'create domain',
  'create role',
  'create policy',
  'create table as',
  'create database',
  'drop table',
  'drop index',
  'drop sequence',
  'drop schema',
  'drop extension',
  'drop view',
  'drop materialized view',
  'drop function',
  'drop database',
  'drop role',
  'drop policy',
  'alter table',
  'alter index',
  'alter sequence',
  'alter schema',
  'alter extension',
  'alter database',
  'alter role',
  'alter function',
  'alter view',
  'refresh materialized view',
  'copy',
  'copy to',
  'copy from',
  'grant',
  'revoke',
  'comment',
  'do',
  'set',
  'reset',
  'transaction',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release savepoint',
  'prepare',
  'execute',
  'deallocate',
  'declare',
  'fetch',
  'close',
  'listen',
  'notify',
  'unlisten',
  'discard',
  'lock',
  'vacuum',
  'analyze',
  'checkpoint',
  'reindex',
  'cluster',
  'explain',
  'show',
  'load',
  'install',
  'attach',
  'detach',
  'create',
  'drop',
  'alter',
])

/**
 * Read-only built-in functions the subset permits. Anything else (a user-defined
 * function, an extension function, a file/network function, a DuckDB-style table
 * function) is rejected, so an arbitrary UDF can never be reached.
 */
const SAFE_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates and window functions
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'variance',
  'var_pop',
  'var_samp',
  'array_agg',
  'string_agg',
  'bool_and',
  'bool_or',
  'every',
  'json_agg',
  'jsonb_agg',
  'json_object_agg',
  'jsonb_object_agg',
  'percentile_cont',
  'percentile_disc',
  'mode',
  'corr',
  'covar_pop',
  'covar_samp',
  'regr_avgx',
  'regr_avgy',
  'regr_count',
  'regr_intercept',
  'regr_r2',
  'regr_slope',
  'regr_sxx',
  'regr_sxy',
  'regr_syy',
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
  // string
  'lower',
  'upper',
  'initcap',
  'length',
  'char_length',
  'character_length',
  'octet_length',
  'bit_length',
  'trim',
  'btrim',
  'ltrim',
  'rtrim',
  'substr',
  'replace',
  'position',
  'strpos',
  'left',
  'right',
  'lpad',
  'rpad',
  'concat',
  'concat_ws',
  'split_part',
  'to_char',
  'to_date',
  'to_timestamp',
  'to_number',
  'reverse',
  'repeat',
  'translate',
  'ascii',
  'chr',
  'quote_ident',
  'quote_literal',
  'quote_nullable',
  'regexp_replace',
  'regexp_matches',
  'regexp_split_to_array',
  'regexp_count',
  'regexp_instr',
  'regexp_substr',
  // math
  'abs',
  'ceil',
  'ceiling',
  'floor',
  'round',
  'trunc',
  'sign',
  'sqrt',
  'cbrt',
  'exp',
  'ln',
  'log',
  'log10',
  'power',
  'pow',
  'mod',
  'div',
  'gcd',
  'lcm',
  'greatest',
  'least',
  'pi',
  'degrees',
  'radians',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  // date/time
  'date_trunc',
  'date_part',
  'age',
  'justify_days',
  'justify_hours',
  'justify_interval',
  'make_date',
  'make_time',
  'make_timestamp',
  'make_timestamptz',
  'make_interval',
  'timezone',
  'now',
  'transaction_timestamp',
  'statement_timestamp',
  // null / conditional
  'coalesce',
  'nullif',
  // json
  'jsonb_build_object',
  'jsonb_build_array',
  'json_build_object',
  'json_build_array',
  'jsonb_extract_path',
  'jsonb_extract_path_text',
  'json_extract_path',
  'json_extract_path_text',
  'jsonb_typeof',
  'json_typeof',
  'jsonb_array_length',
  'json_array_length',
  'jsonb_object_keys',
  'row_to_json',
  'to_json',
  'to_jsonb',
  'jsonb_pretty',
  // arrays and set-returning helpers
  'array_length',
  'cardinality',
  'array_position',
  'array_positions',
  'array_remove',
  'array_append',
  'array_prepend',
  'array_cat',
  'array_to_string',
  'array_to_json',
  'string_to_array',
  'unnest',
  'generate_series',
  'generate_subscripts',
  'width_bucket',
])

/**
 * File, network, server-side, admin and code-executing functions. They are rejected
 * with an explicit message (they are not merely absent from the allowlist).
 */
const DANGEROUS_FUNCTIONS: ReadonlySet<string> = new Set([
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'pg_ls_dir',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'pg_ls_archive_statusdir',
  'pg_logdir_ls',
  'lo_import',
  'lo_export',
  'lo_get',
  'lo_put',
  'lo_unlink',
  'lo_create',
  'lo_open',
  'lo_close',
  'loread',
  'lowrite',
  'dblink',
  'dblink_connect',
  'dblink_exec',
  'postgres_fdw',
  'file_fdw',
  'pg_file_read',
  'pg_file_write',
  'pg_file_rename',
  'pg_file_unlink',
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_import_system_collations',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_promote',
  'pg_stat_reset',
  'pg_advisory_lock',
  'pg_advisory_xact_lock',
  'pg_notify',
  'set_config',
  'current_setting',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'database_to_xml',
  'table_to_xml',
  'schema_to_xml',
])

/** DuckDB-style file/table functions that a PostgreSQL path must also refuse. */
const NON_POSTGRES_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  'read_csv',
  'read_csv_auto',
  'read_parquet',
  'parquet_scan',
  'read_json',
  'read_json_auto',
  'read_ndjson',
  'read_ndjson_auto',
  'read_blob',
  'read_text',
  'read_xlsx',
  'sniff_csv',
  'glob',
  'delta_scan',
  'iceberg_scan',
  'httpfs',
  'sqlite_scan',
])

export interface SqlValidationInput {
  readonly sql: string
  readonly parameters: readonly ScalarValue[]
  readonly allowlist: readonly BusinessObjectMapping[]
  /** The physical objects the plan claims to read (`DirectSqlQueryPlan.referencedObjects`). */
  readonly declaredObjects: readonly SourceObjectRef[]
  /** The principal's authorized source refs (`ToolContext.allowedResources.sourceRefs`). */
  readonly authorizedSourceRefs: readonly SourceRef[]
}

export interface SqlValidationAccepted {
  readonly valid: true
  /**
   * The exact statement span from the original text (leading/trailing comments and
   * separators removed). Safe to wrap for bounded pagination.
   */
  readonly executableSql: string
  readonly referencedObjects: readonly SourceObjectRef[]
  readonly warnings: readonly string[]
}

export interface SqlValidationRejected {
  readonly valid: false
  readonly code: ErrorCode
  readonly reason: string
  readonly warnings: readonly string[]
}

export type SqlValidationResult = SqlValidationAccepted | SqlValidationRejected

interface Rejection {
  readonly code: ErrorCode
  readonly reason: string
}

interface WalkState {
  readonly allowlist: readonly BusinessObjectMapping[]
  readonly authorizedSourceRefs: readonly SourceRef[]
  readonly cteAliases: Set<string>
  readonly objects: Map<string, SourceObjectRef>
  readonly parameters: Set<number>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function statementType(node: unknown): string | undefined {
  return stringField(asRecord(node) ?? {}, 'type')
}

function collectCteAliases(node: unknown, aliases: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectCteAliases(item, aliases)
    return
  }
  const record = asRecord(node)
  if (record === undefined) return
  const type = stringField(record, 'type')
  if (type === 'with' || type === 'with recursive') {
    const bind = record.bind
    if (Array.isArray(bind)) {
      for (const entry of bind) {
        const alias = asRecord(asRecord(entry)?.alias)
        const name = alias === undefined ? undefined : stringField(alias, 'name')
        if (name !== undefined) aliases.add(name)
      }
    }
  }
  for (const value of Object.values(record)) collectCteAliases(value, aliases)
}

function checkFunctionCall(record: Record<string, unknown>): Rejection | undefined {
  const fn = asRecord(record.function)
  const name = fn === undefined ? undefined : stringField(fn, 'name')
  if (name === undefined) {
    return { code: 'UNSUPPORTED_QUERY', reason: 'a function call without a resolvable name is not allowed' }
  }
  const schema = fn === undefined ? undefined : stringField(fn, 'schema')
  if (schema !== undefined && schema !== 'pg_catalog') {
    return {
      code: 'UNSUPPORTED_QUERY',
      reason: `schema-qualified function ${schema}.${name} is outside the declared read-only subset`,
    }
  }
  const normalized = name.toLowerCase()
  if (DANGEROUS_FUNCTIONS.has(normalized) || normalized.startsWith('pg_')) {
    return {
      code: 'UNSUPPORTED_QUERY',
      reason: `function ${name} is a file/network/administrative function and is never allowed`,
    }
  }
  if (NON_POSTGRES_TABLE_FUNCTIONS.has(normalized)) {
    return {
      code: 'UNSUPPORTED_QUERY',
      reason: `function ${name} is a file/table function outside the declared subset`,
    }
  }
  if (!SAFE_FUNCTIONS.has(normalized)) {
    return {
      code: 'UNSUPPORTED_QUERY',
      reason: `function ${name} is not on the read-only allowlist`,
    }
  }
  return undefined
}

function checkTableReference(
  record: Record<string, unknown>,
  state: WalkState,
): Rejection | undefined {
  const name = asRecord(record.name)
  const relation = name === undefined ? undefined : stringField(name, 'name')
  if (relation === undefined) {
    return { code: 'UNSUPPORTED_QUERY', reason: 'a table reference without a resolvable name is not allowed' }
  }
  const schema = name === undefined ? undefined : stringField(name, 'schema')
  if (schema === undefined && state.cteAliases.has(relation)) return undefined
  if (isAmbiguousRelation(state.allowlist, schema, relation)) {
    return {
      code: 'FORBIDDEN',
      reason: `unqualified relation ${relation} is ambiguous in the confirmed mapping`,
    }
  }
  const mapping = resolveMapping(state.allowlist, schema, relation)
  if (mapping === undefined) {
    return {
      code: 'FORBIDDEN',
      reason: `relation ${schema === undefined ? relation : `${schema}.${relation}`} is not in the principal's confirmed mapping`,
    }
  }
  if (!sourceRefAuthorized(mapping.objectRef.sourceRef, state.authorizedSourceRefs)) {
    return {
      code: 'FORBIDDEN',
      reason: `relation ${mapping.objectRef.objectPath} belongs to a source the principal is not authorized for`,
    }
  }
  state.objects.set(mapping.objectRef.objectPath, mapping.objectRef)
  return undefined
}

function visit(node: unknown, state: WalkState): Rejection | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const rejection = visit(item, state)
      if (rejection !== undefined) return rejection
    }
    return undefined
  }
  const record = asRecord(node)
  if (record === undefined) return undefined
  const type = stringField(record, 'type')
  if (type !== undefined) {
    if (FORBIDDEN_STATEMENT_TYPES.has(type)) {
      return {
        code: 'UNSUPPORTED_QUERY',
        reason: `statement "${type}" is not part of the declared read-only SELECT subset`,
      }
    }
    if (type === 'with' || type === 'with recursive') {
      const bind = record.bind
      if (Array.isArray(bind)) {
        for (const entry of bind) {
          const inner = statementType(asRecord(entry)?.statement)
          if (inner === undefined || !CTE_BIND_ALLOWED_TYPES.has(inner)) {
            return {
              code: 'UNSUPPORTED_QUERY',
              reason: `CTE body "${inner ?? 'unknown'}" is not a read-only SELECT`,
            }
          }
        }
      }
    }
    if (type === 'call') {
      const rejection = checkFunctionCall(record)
      if (rejection !== undefined) return rejection
    }
    if (type === 'table') {
      const rejection = checkTableReference(record, state)
      if (rejection !== undefined) return rejection
    }
    if (type === 'parameter') {
      const raw = stringField(record, 'name')
      const index = raw !== undefined && /^\$\d+$/.test(raw) ? Number(raw.slice(1)) : Number.NaN
      if (!Number.isInteger(index) || index < 1) {
        return { code: 'INVALID_ARGUMENT', reason: `unresolvable parameter ${raw ?? ''}` }
      }
      state.parameters.add(index)
    }
  }
  for (const value of Object.values(record)) {
    const rejection = visit(value, state)
    if (rejection !== undefined) return rejection
  }
  return undefined
}

function validateParameters(state: WalkState, parameters: readonly ScalarValue[]): Rejection | undefined {
  for (const parameter of parameters) {
    const kind = parameter === null ? 'null' : typeof parameter
    if (kind !== 'null' && kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      return { code: 'INVALID_ARGUMENT', reason: 'parameters must be scalar values' }
    }
  }
  for (const index of state.parameters) {
    if (index > parameters.length) {
      return {
        code: 'INVALID_ARGUMENT',
        reason: `the statement references $${String(index)} but only ${String(parameters.length)} parameter(s) were supplied`,
      }
    }
  }
  return undefined
}

function validateDeclaredObjects(
  state: WalkState,
  declared: readonly SourceObjectRef[],
): { readonly rejection?: Rejection; readonly warnings: string[] } {
  const declaredPaths = new Set(declared.map((objectRef) => objectRef.objectPath))
  for (const objectPath of state.objects.keys()) {
    if (!declaredPaths.has(objectPath)) {
      return {
        rejection: {
          code: 'INVALID_ARGUMENT',
          reason: `the statement reads ${objectPath}, which the plan did not declare in referencedObjects`,
        },
        warnings: [],
      }
    }
  }
  const referenced = new Set(state.objects.keys())
  const warnings: string[] = []
  for (const objectRef of declared) {
    if (!referenced.has(objectRef.objectPath)) {
      warnings.push(`declared object ${objectRef.objectPath} was not referenced by the statement`)
    }
  }
  return { warnings }
}

function executableSpan(sql: string, statement: unknown, start: number, end: number): string {
  const record = asRecord(statement)
  const location = record === undefined ? undefined : asRecord(record._location)
  const startOffset = location === undefined ? start : Number(location.start)
  const endOffset = location === undefined ? end : Number(location.end)
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) {
    return sql.slice(start, end).trim().replace(/;\s*$/, '')
  }
  return sql.slice(startOffset, endOffset)
}

/**
 * Validate a direct-SQL candidate against the declared subset. Returns a rejection with
 * a published error code instead of throwing, so `validate` can report it as data.
 */
export function validateReadOnlySql(input: SqlValidationInput): SqlValidationResult {
  const warnings: string[] = []
  const sql = input.sql.trim()
  if (sql.length === 0) {
    return { valid: false, code: 'INVALID_ARGUMENT', reason: 'sql must not be empty', warnings }
  }

  let statements: unknown[]
  try {
    statements = parse(sql, { locationTracking: true }) as unknown[]
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the SQL could not be parsed'
    return {
      valid: false,
      code: 'UNSUPPORTED_QUERY',
      reason: `the statement is not valid SQL in the declared read-only subset: ${detail.split('\n')[0] ?? detail}`,
      warnings,
    }
  }

  if (statements.length !== 1) {
    return {
      valid: false,
      code: 'UNSUPPORTED_QUERY',
      reason: `exactly one statement is allowed, received ${String(statements.length)}`,
      warnings,
    }
  }
  const statement = statements[0]
  const rootType = statementType(statement)
  if (rootType === undefined || !ROOT_ALLOWED_TYPES.has(rootType)) {
    return {
      valid: false,
      code: 'UNSUPPORTED_QUERY',
      reason: `the root statement "${rootType ?? 'unknown'}" is not a read-only SELECT`,
      warnings,
    }
  }

  const state: WalkState = {
    allowlist: input.allowlist,
    authorizedSourceRefs: input.authorizedSourceRefs,
    cteAliases: new Set(),
    objects: new Map(),
    parameters: new Set(),
  }
  collectCteAliases(statement, state.cteAliases)
  const walked = visit(statement, state)
  if (walked !== undefined) {
    return { valid: false, code: walked.code, reason: walked.reason, warnings }
  }

  const parameterRejection = validateParameters(state, input.parameters)
  if (parameterRejection !== undefined) {
    return { valid: false, code: parameterRejection.code, reason: parameterRejection.reason, warnings }
  }

  const declared = validateDeclaredObjects(state, input.declaredObjects)
  if (declared.rejection !== undefined) {
    return { valid: false, code: declared.rejection.code, reason: declared.rejection.reason, warnings }
  }
  warnings.push(...declared.warnings)

  return {
    valid: true,
    executableSql: executableSpan(sql, statement, 0, sql.length),
    referencedObjects: [...state.objects.values()],
    warnings,
  }
}
