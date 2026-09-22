import { DuckDBTypeId } from '@duckdb/node-api'
import { sha256DigestOf } from '@ontology/core'
import type { ColumnType, QueryColumn, Sha256Digest } from '@ontology/contracts'

/**
 * The cross-backend normalisation contract (SPEC C3.1, X-03).
 *
 * DuckDB and PostgreSQL disagree on JS representation (BIGINT as bigint vs string,
 * NUMERIC as number vs string, timestamps as Date vs string), so the adapter — and only
 * the adapter — maps engine values onto one canonical shape. The same shape is what the
 * PostgreSQL adapter must produce for the X-03 equivalence check:
 *
 *  - integers  → JS number when exactly representable, otherwise an exact decimal string
 *  - decimals  → exact decimal string (never a lossy double)
 *  - floating  → JS number, or "NaN"/"Infinity"/"-Infinity" when not finite
 *  - booleans  → JS boolean
 *  - strings/uuid/enum → JS string
 *  - date/time → RFC3339 UTC timestamp with millisecond precision; DATE is UTC midnight
 *  - interval/time-only → the engine's canonical text form
 *  - binary    → base64 string
 *  - nested    → JSON value with object keys sorted
 *
 * Canonical types are the contract's `ColumnType`; no dialect name leaves this module.
 */
export function normaliseColumnType(typeId: DuckDBTypeId): ColumnType {
  switch (typeId) {
    case DuckDBTypeId.BOOLEAN:
      return 'boolean'
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UHUGEINT:
    case DuckDBTypeId.BIGNUM:
      return 'integer'
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
    case DuckDBTypeId.DECIMAL:
      return 'decimal'
    case DuckDBTypeId.VARCHAR:
    case DuckDBTypeId.ENUM:
    case DuckDBTypeId.UUID:
      return 'string'
    case DuckDBTypeId.DATE:
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
    case DuckDBTypeId.TIMESTAMP_TZ:
      return 'timestamp'
    case DuckDBTypeId.BLOB:
    case DuckDBTypeId.BIT:
      return 'binary'
    case DuckDBTypeId.LIST:
    case DuckDBTypeId.ARRAY:
    case DuckDBTypeId.STRUCT:
    case DuckDBTypeId.MAP:
    case DuckDBTypeId.UNION:
    case DuckDBTypeId.VARIANT:
      return 'json'
    case DuckDBTypeId.TIME:
    case DuckDBTypeId.TIME_TZ:
    case DuckDBTypeId.TIME_NS:
    case DuckDBTypeId.INTERVAL:
    case DuckDBTypeId.SQLNULL:
    case DuckDBTypeId.INVALID:
    default:
      return 'string'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normaliseInteger(raw: unknown): number | string {
  if (typeof raw === 'bigint') {
    return raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(raw)
      : raw.toString()
  }
  if (typeof raw === 'number') return raw
  return String(raw)
}

function normaliseFloating(raw: unknown): number | string {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : String(value)
}

function decimalText(raw: unknown): string {
  if (isRecord(raw) && typeof raw.toString === 'function') return raw.toString()
  return String(raw)
}

function base64Of(raw: unknown): string {
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('base64')
  if (isRecord(raw) && raw.bytes instanceof Uint8Array) {
    return Buffer.from(raw.bytes).toString('base64')
  }
  return String(raw)
}

function normaliseNested(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'bigint') return normaliseInteger(raw)
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : String(raw)
  if (typeof raw === 'boolean' || typeof raw === 'string') return raw
  if (raw instanceof Date) return raw.toISOString()
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('base64')
  if (Array.isArray(raw)) return raw.map((item) => normaliseNested(item))
  if (isRecord(raw)) {
    if (Array.isArray(raw.items)) return raw.items.map((item) => normaliseNested(item))
    if (isRecord(raw.entries)) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(raw.entries).sort()) {
        out[key] = normaliseNested(raw.entries[key])
      }
      return out
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(raw).sort()) out[key] = normaliseNested(raw[key])
    return out
  }
  return String(raw)
}

/** Normalise one engine value into the canonical cross-backend representation. */
export function normaliseValue(typeId: DuckDBTypeId, raw: unknown, js: unknown): unknown {
  if (raw === null || raw === undefined) return null
  switch (typeId) {
    case DuckDBTypeId.BOOLEAN:
      return typeof raw === 'boolean' ? raw : Boolean(raw)
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UHUGEINT:
    case DuckDBTypeId.BIGNUM:
      return normaliseInteger(raw)
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
      return normaliseFloating(raw)
    case DuckDBTypeId.DECIMAL:
      return decimalText(raw)
    case DuckDBTypeId.VARCHAR:
    case DuckDBTypeId.ENUM:
    case DuckDBTypeId.UUID:
      return String(raw)
    case DuckDBTypeId.DATE:
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
    case DuckDBTypeId.TIMESTAMP_TZ:
      return js instanceof Date ? js.toISOString() : String(raw)
    case DuckDBTypeId.TIME:
    case DuckDBTypeId.TIME_TZ:
    case DuckDBTypeId.TIME_NS:
    case DuckDBTypeId.INTERVAL:
      return String(raw)
    case DuckDBTypeId.BLOB:
    case DuckDBTypeId.BIT:
      return base64Of(raw)
    case DuckDBTypeId.LIST:
    case DuckDBTypeId.ARRAY:
    case DuckDBTypeId.STRUCT:
    case DuckDBTypeId.MAP:
    case DuckDBTypeId.UNION:
    case DuckDBTypeId.VARIANT:
      return normaliseNested(raw)
    default:
      return normaliseNested(js)
  }
}

/** Stable JSON: object keys are sorted so a digest does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

export interface NormalisedResult {
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly unknown[][]
}

/**
 * Digest of the canonical result, used as `SourceSnapshot.resultDigest`. Two backends
 * that agree on the canonical columns and rows produce the same digest, which is the
 * machine-checkable form of the X-03 equivalence criterion.
 */
export function resultDigestOf(result: NormalisedResult): Sha256Digest {
  return sha256DigestOf(
    canonicalJson({
      columns: result.columns.map((column) => ({ name: column.name, type: column.type })),
      rows: result.rows,
    }),
  )
}
