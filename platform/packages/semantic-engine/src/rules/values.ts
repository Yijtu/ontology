import type { DecimalQuantity, ScalarValue, SemanticFilter } from '@ontology/contracts'
import { RuleEvaluationError } from './errors'
import type { RuleAssertionValue } from './types'

/**
 * Exact value and filter semantics for rule evaluation (SPEC D5/E4). Numeric comparison uses
 * arbitrary-precision decimal strings, never JSON floats, so a boundary like 20.0 >= 20.0 holds
 * exactly and a negative price is never rounded toward zero.
 */

interface NormalizedDecimal {
  readonly sign: -1 | 0 | 1
  readonly integer: string
  readonly fraction: string
}

function normalizeDecimal(text: string): NormalizedDecimal {
  const trimmed = text.trim()
  const negative = trimmed.startsWith('-')
  const unsigned = negative || trimmed.startsWith('+') ? trimmed.slice(1) : trimmed
  const dot = unsigned.indexOf('.')
  const rawInteger = dot === -1 ? unsigned : unsigned.slice(0, dot)
  const rawFraction = dot === -1 ? '' : unsigned.slice(dot + 1)
  const integer = rawInteger.replace(/^0+(?=\d)/, '')
  const fraction = rawFraction.replace(/0+$/, '')
  if (integer === '' && fraction === '') return { sign: 0, integer: '0', fraction: '' }
  return { sign: negative ? -1 : 1, integer: integer === '' ? '0' : integer, fraction }
}

function compareMagnitude(left: NormalizedDecimal, right: NormalizedDecimal): -1 | 0 | 1 {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1
  }
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1
  const width = Math.max(left.fraction.length, right.fraction.length)
  const leftFraction = left.fraction.padEnd(width, '0')
  const rightFraction = right.fraction.padEnd(width, '0')
  if (leftFraction === rightFraction) return 0
  return leftFraction < rightFraction ? -1 : 1
}

/** Compare two exact decimal strings without ever converting to a float. */
export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const a = normalizeDecimal(left)
  const b = normalizeDecimal(right)
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1
  if (a.sign === 0) return 0
  const magnitude = compareMagnitude(a, b)
  return a.sign === -1 ? (magnitude === 0 ? 0 : magnitude === 1 ? -1 : 1) : magnitude
}

export function isDecimalQuantity(value: unknown): value is DecimalQuantity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['amount'] === 'string' && typeof candidate['unit'] === 'string'
}

/** The exact decimal amount of a quantity or number value, `undefined` for non-numerics. */
export function decimalAmountOf(value: RuleAssertionValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isDecimalQuantity(value)) return value.amount
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  return undefined
}

/** The canonical unit qualifier of a value, `undefined` when the value carries no unit. */
export function unitOf(value: RuleAssertionValue | undefined): string | undefined {
  return isDecimalQuantity(value) ? value.unit : undefined
}

function scalarEquals(value: RuleAssertionValue, scalar: ScalarValue): boolean {
  if (scalar === null) return false
  if (isDecimalQuantity(value)) {
    if (typeof scalar === 'number') return compareDecimal(value.amount, String(scalar)) === 0
    if (typeof scalar === 'string') return compareDecimal(value.amount, scalar) === 0
    return false
  }
  if (typeof value === 'number') {
    if (typeof scalar === 'number') return value === scalar
    if (typeof scalar === 'string') return compareDecimal(String(value), scalar) === 0
    return false
  }
  return value === scalar
}

function numericCompare(value: RuleAssertionValue, scalar: ScalarValue): number | undefined {
  const amount = decimalAmountOf(value)
  if (amount === undefined) return undefined
  if (typeof scalar === 'number') return compareDecimal(amount, String(scalar))
  if (typeof scalar === 'string') return compareDecimal(amount, scalar)
  return undefined
}

const SUPPORTED_OPS: ReadonlySet<SemanticFilter['op']> = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'between',
  'is_not_null',
])

/**
 * Validate the bounded filter subset the evaluator can honour (D5). `is_null` asserts the
 * absence of a value, which is a negation over completeness and needs a declared complete range
 * the model does not carry; it is rejected instead of being read as a missing-data default.
 */
export function assertSupportedFilter(filter: SemanticFilter, label: string): void {
  if (filter.op === 'is_null') {
    throw new RuleEvaluationError(
      'UNSUPPORTED_NEGATION',
      `${label} uses is_null, an unsupported negation over completeness`,
    )
  }
  if (!SUPPORTED_OPS.has(filter.op)) {
    throw new RuleEvaluationError('UNSUPPORTED_FILTER', `${label} uses unsupported operator ${filter.op}`)
  }
  if (filter.op === 'between' && filter.values.length !== 2) {
    throw new RuleEvaluationError('UNSUPPORTED_FILTER', `${label} between needs exactly two bounds`)
  }
  if (filter.op === 'in' && filter.values.length === 0) {
    throw new RuleEvaluationError('UNSUPPORTED_FILTER', `${label} in needs at least one value`)
  }
}

/**
 * Whether a present value matches the filter. A missing value never reaches this function: the
 * caller treats an absent observation as `unknown`, never as `false` (D5).
 */
export function filterMatches(filter: SemanticFilter, value: RuleAssertionValue): boolean {
  switch (filter.op) {
    case 'is_not_null':
      return true
    case 'eq': {
      const target = filter.values[0]
      return target === undefined ? false : scalarEquals(value, target)
    }
    case 'ne': {
      const target = filter.values[0]
      return target === undefined ? false : !scalarEquals(value, target)
    }
    case 'in':
      return filter.values.some((scalar) => scalarEquals(value, scalar))
    case 'lt': {
      const target = filter.values[0]
      const comparison = target === undefined ? undefined : numericCompare(value, target)
      return comparison === -1
    }
    case 'lte': {
      const target = filter.values[0]
      const comparison = target === undefined ? undefined : numericCompare(value, target)
      return comparison === -1 || comparison === 0
    }
    case 'gt': {
      const target = filter.values[0]
      const comparison = target === undefined ? undefined : numericCompare(value, target)
      return comparison === 1
    }
    case 'gte': {
      const target = filter.values[0]
      const comparison = target === undefined ? undefined : numericCompare(value, target)
      return comparison === 1 || comparison === 0
    }
    case 'between': {
      const lower = filter.values[0]
      const upper = filter.values[1]
      if (lower === undefined || upper === undefined) return false
      const low = numericCompare(value, lower)
      const high = numericCompare(value, upper)
      return low !== undefined && high !== undefined && low >= 0 && high <= 0
    }
    case 'is_null':
      return false
    default:
      return false
  }
}
