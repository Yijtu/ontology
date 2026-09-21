import type { ColumnType } from '@ontology/contracts'

/**
 * Stable JSON with sorted object keys, so a digest of the same logical value is
 * reproducible regardless of property order. Kept local to the adapter because
 * `contracts`/`core` must not depend on a service-layer helper.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'))
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

/**
 * Convert a PostgreSQL driver value into a JSON-safe primitive. Timestamps become RFC3339
 * strings and binary values become base64, so the result is deterministic and survives a
 * canonical JSON digest.
 */
export function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map((entry) => normalizeCell(entry))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeCell(entry)
    }
    return out
  }
  return value
}

export function byteLengthOf(value: unknown): number {
  return new TextEncoder().encode(stableJson(value)).byteLength
}

/**
 * Map common PostgreSQL type OIDs to the contract `ColumnType`. Unknown OIDs fall back to
 * `string`, which is the only lossless JSON rendering.
 */
const COLUMN_TYPE_BY_OID: ReadonlyMap<number, ColumnType> = new Map([
  [16, 'boolean'],
  [17, 'binary'],
  [20, 'integer'],
  [21, 'integer'],
  [23, 'integer'],
  [26, 'integer'],
  [114, 'json'],
  [3802, 'json'],
  [700, 'decimal'],
  [701, 'decimal'],
  [1700, 'decimal'],
  [1082, 'timestamp'],
  [1083, 'timestamp'],
  [1114, 'timestamp'],
  [1184, 'timestamp'],
  [1266, 'timestamp'],
  [1042, 'string'],
  [1043, 'string'],
  [25, 'string'],
  [19, 'string'],
  [2950, 'string'],
  [1186, 'string'],
])

export function columnTypeFromOid(dataTypeId: number): ColumnType {
  return COLUMN_TYPE_BY_OID.get(dataTypeId) ?? 'string'
}
