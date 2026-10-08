import type { DomainResultStatus } from '@ontology/contracts'
import { ComputeExecutionError } from './errors'

const QUANTITY_UNIT = 'each'

interface ExampleRow {
  readonly id: string
  readonly amount: string
  readonly unit?: string
  readonly currency?: string
}

const SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(SCALE)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an exact DecimalString into a fixed 4-dp integer; exponent/float forms are rejected. */
function parseDecimal(value: string): bigint | undefined {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value)
  if (match === null) return undefined
  const whole = match[1] ?? '0'
  const frac = (match[2] ?? '').padEnd(SCALE, '0').slice(0, SCALE)
  return BigInt(whole) * SCALE_FACTOR + BigInt(frac)
}

function formatDecimal(scaled: bigint): string {
  const whole = scaled / SCALE_FACTOR
  const fraction = (scaled % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/u, '')
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
}

export function decodeInput(bytes: Uint8Array): { readonly rows: readonly ExampleRow[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    throw new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'the example input artifact is not valid JSON', {
      cause: error,
    })
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['rows'])) {
    throw new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'the example input artifact must carry a rows array')
  }
  const rows: ExampleRow[] = []
  for (const entry of parsed['rows']) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['amount'] !== 'string') {
      throw new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'every example input row needs a string id and amount')
    }
    rows.push({
      id: entry['id'],
      amount: entry['amount'],
      ...(typeof entry['unit'] === 'string' ? { unit: entry['unit'] } : {}),
      ...(typeof entry['currency'] === 'string' ? { currency: entry['currency'] } : {}),
    })
  }
  return { rows }
}

interface Aggregation {
  readonly metrics: Readonly<Record<string, unknown>>
  readonly domainStatus: DomainResultStatus
  readonly completeness: 'complete' | 'unknown'
  readonly returned: number
}

/**
 * Aggregate the fixed input. If any row's amount is not an exact DecimalString, the totals are
 * omitted and the result is `unknown`/incomplete — the handler never substitutes a default or a
 * fabricated total for a value it could not compute.
 */
export function aggregate(rows: readonly ExampleRow[]): Aggregation {
  let quantity = 0n
  let cost = 0n
  for (const row of rows) {
    const parsed = parseDecimal(row.amount)
    if (parsed === undefined) {
      return {
        metrics: { record_count: rows.length },
        domainStatus: 'unknown',
        completeness: 'unknown',
        returned: 0,
      }
    }
    if (row.unit === QUANTITY_UNIT) quantity += parsed
    if (row.currency === 'CNY') cost += parsed
  }
  return {
    metrics: {
      record_count: rows.length,
      total_quantity: { amount: formatDecimal(quantity), unit: QUANTITY_UNIT },
      total_cost: { amount: formatDecimal(cost), currency: 'CNY' },
    },
    domainStatus: 'known',
    completeness: 'complete',
    returned: rows.length,
  }
}
