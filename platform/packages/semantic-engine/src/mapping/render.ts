import type { AggregationKind, ColumnType, ScalarValue } from '@ontology/contracts'
import { SemanticMappingError } from './errors'
import type {
  CompiledExpression,
  CompiledJoin,
  CompiledPredicate,
  CompiledProjection,
  CompiledQuery,
  CompiledSource,
  MappingDialect,
  RenderedQuery,
} from './types'

/**
 * Dialect-specific SQL rendering, kept inside the adapter-facing portion of the compiler
 * boundary. The compiler itself is dialect-neutral; only this module knows that
 * PostgreSQL binds `$n` and DuckDB binds `?`, and that the two engines spell a canonical
 * cast type differently.
 *
 * Every identifier is emitted from the compiled mapping (double-quoted), and every value
 * is emitted as a bound parameter. No user or model text ever reaches the SQL string.
 */

const AGGREGATE_FUNCTIONS: Readonly<Record<AggregationKind, string>> = {
  none: '',
  sum: 'SUM',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
  count: 'COUNT',
  count_distinct: 'COUNT',
  median: '',
  p95: '',
}

const CANONICAL_CAST: Readonly<Record<MappingDialect, Readonly<Record<ColumnType, string>>>> = {
  postgres: {
    string: 'TEXT',
    integer: 'BIGINT',
    decimal: 'NUMERIC(38,10)',
    boolean: 'BOOLEAN',
    timestamp: 'TIMESTAMPTZ',
    json: 'TEXT',
    binary: 'TEXT',
  },
  duckdb: {
    string: 'VARCHAR',
    integer: 'BIGINT',
    decimal: 'DECIMAL(38,10)',
    boolean: 'BOOLEAN',
    timestamp: 'TIMESTAMP',
    json: 'VARCHAR',
    binary: 'VARCHAR',
  },
}

const COMPARISON_SQL: Readonly<Record<string, string>> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function tableReference(source: CompiledSource, dialect: MappingDialect): string {
  if (dialect === 'duckdb' && source.schema === 'main') return quoteIdentifier(source.relation)
  return `${quoteIdentifier(source.schema)}.${quoteIdentifier(source.relation)}`
}

interface RenderState {
  readonly dialect: MappingDialect
  readonly parameters: ScalarValue[]
}

function bindParameter(state: RenderState, value: ScalarValue): string {
  state.parameters.push(value)
  return state.dialect === 'postgres' ? `$${String(state.parameters.length)}` : '?'
}

function renderExpression(state: RenderState, expression: CompiledExpression): string {
  switch (expression.kind) {
    case 'column':
      return `${quoteIdentifier(expression.column.alias)}.${quoteIdentifier(expression.column.column)}`
    case 'scaled':
      return `(${renderExpression(state, expression.operand)} / ${String(expression.factor)})`
    case 'mapped': {
      const operand = renderExpression(state, expression.operand)
      const branches = expression.map
        .map(
          (entry) =>
            `WHEN ${operand} = ${bindParameter(state, entry.physical)} THEN ${bindParameter(state, entry.canonical)}`,
        )
        .join(' ')
      const fallback = expression.fallback === null ? 'NULL' : bindParameter(state, expression.fallback)
      return `CASE WHEN ${operand} IS NULL THEN NULL ${branches} ELSE ${fallback} END`
    }
    case 'aggregate': {
      const fn = AGGREGATE_FUNCTIONS[expression.fn]
      if (fn === '') {
        throw new SemanticMappingError(
          'UNSUPPORTED_AGGREGATION',
          `aggregation "${expression.fn}" has no dialect-neutral rendering`,
        )
      }
      const operand = renderExpression(state, expression.operand)
      return expression.fn === 'count_distinct' ? `${fn}(DISTINCT ${operand})` : `${fn}(${operand})`
    }
  }
}

function renderProjection(state: RenderState, projection: CompiledProjection): string {
  const expression = renderExpression(state, projection.expression)
  // Project columns already have a verified exact physical DECIMAL type. Recasting to the
  // legacy mapping's fixed scale would silently round newly published business values.
  if (projection.columnType === 'decimal' && projection.exactDecimal === true) return `${expression} AS ${quoteIdentifier(projection.fieldRef)}`
  const cast = CANONICAL_CAST[state.dialect][projection.columnType]
  return `CAST(${expression} AS ${cast}) AS ${quoteIdentifier(projection.fieldRef)}`
}

function renderPredicate(state: RenderState, predicate: CompiledPredicate): string {
  const expression = renderExpression(state, predicate.expression)
  if (predicate.op === 'is_null') return `${expression} IS NULL`
  if (predicate.op === 'is_not_null') return `${expression} IS NOT NULL`
  if (predicate.op === 'in') {
    const values = predicate.values.map((value) => bindParameter(state, value)).join(', ')
    return `${expression} IN (${values})`
  }
  if (predicate.op === 'between') {
    const low = predicate.values[0]
    const high = predicate.values[1]
    if (low === undefined || high === undefined) {
      throw new SemanticMappingError('INVALID_QUERY_PLAN', 'a between predicate requires two values')
    }
    return `${expression} BETWEEN ${bindParameter(state, low)} AND ${bindParameter(state, high)}`
  }
  const operator = COMPARISON_SQL[predicate.op]
  const value = predicate.values[0]
  if (operator === undefined || value === undefined) {
    throw new SemanticMappingError(
      'INVALID_QUERY_PLAN',
      `predicate "${predicate.op}" cannot be rendered`,
    )
  }
  return `${expression} ${operator} ${bindParameter(state, value)}`
}

function renderJoin(state: RenderState, source: CompiledSource, join: CompiledJoin): string {
  const keyword = join.joinKind === 'left' ? 'LEFT JOIN' : 'JOIN'
  const target = tableReference(source, state.dialect)
  const on = `${quoteIdentifier(join.fromAlias)}.${quoteIdentifier(join.fromColumn)} = ${quoteIdentifier(join.toAlias)}.${quoteIdentifier(join.toColumn)}`
  return `${keyword} ${target} AS ${quoteIdentifier(source.alias)} ON ${on}`
}

/**
 * Render a compiled query to backend SQL plus its ordered parameters. `orderBy` references
 * the output alias and `groupBy` uses ordinals, so a mapped CASE expression is emitted
 * exactly once and its parameters are never duplicated.
 */
export function renderCompiledQuery(query: CompiledQuery): RenderedQuery {
  const state: RenderState = { dialect: query.dialect, parameters: [] }
  const first = query.sources[0]
  if (first === undefined) {
    throw new SemanticMappingError('INVALID_QUERY_PLAN', 'a compiled query requires at least one source')
  }

  const projections = query.projections.map((projection) => renderProjection(state, projection))
  const select = `SELECT ${projections.join(', ')}`

  const from = `FROM ${tableReference(first, state.dialect)} AS ${quoteIdentifier(first.alias)}`
  const joins = query.joins
    .map((join, index) => {
      const source = query.sources[index + 1]
      if (source === undefined) {
        throw new SemanticMappingError('INVALID_QUERY_PLAN', `join ${join.linkId} has no matching source`)
      }
      return renderJoin(state, source, join)
    })
    .join(' ')

  const where =
    query.predicates.length === 0
      ? ''
      : ` WHERE ${query.predicates.map((predicate) => renderPredicate(state, predicate)).join(' AND ')}`

  const groupBy =
    query.groupBy.length === 0
      ? ''
      : ` GROUP BY ${query.groupBy.map((_expression, index) => String(index + 1)).join(', ')}`

  const orderBy =
    query.orderBy.length === 0
      ? ''
      : ` ORDER BY ${query.orderBy
          .map((order) => `${quoteIdentifier(order.fieldRef)} ${order.direction === 'desc' ? 'DESC' : 'ASC'}`)
          .join(', ')}`

  const limit = ` LIMIT ${String(query.limit)}`

  return {
    sql: `${select} ${from}${joins === '' ? '' : ` ${joins}`}${where}${groupBy}${orderBy}${limit}`,
    parameters: [...state.parameters],
    referencedObjects: [...query.referencedObjects],
  }
}
