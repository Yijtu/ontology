import { sha256DigestOf } from '@ontology/core'
import type {
  CatalogResource,
  ColumnType,
  QueryColumn,
  SourceObjectRef,
  SourceRef,
  SupportedDataType,
} from '@ontology/contracts'

/**
 * A confirmed mapping entry: the only place a physical `schema.relation` name may
 * come from. Model/user text never names a relation directly; the AST validator
 * resolves every table reference through this allowlist.
 */
export interface MappedColumn {
  readonly name: string
  readonly type: ColumnType
  readonly semanticFieldRef?: string
  readonly unit?: string
}

export interface BusinessObjectMapping {
  readonly objectRef: SourceObjectRef
  /** Physical schema. Never exposed to a model. */
  readonly schema: string
  /** Physical relation (table or view). Never exposed to a model. */
  readonly relation: string
  readonly relationKind: 'table' | 'view'
  /** Optional declarative column metadata; catalog discovery still reads the live DB. */
  readonly columns?: readonly MappedColumn[]
  readonly conceptRefs?: readonly string[]
}

export function relationKey(schema: string, relation: string): string {
  return `${schema}\u0000${relation}`
}

export function sourceRefsEqual(left: SourceRef, right: SourceRef): boolean {
  return left.namespace === right.namespace && left.sourceId === right.sourceId
}

export function sourceRefAuthorized(sourceRef: SourceRef, authorized: readonly SourceRef[]): boolean {
  return authorized.some((candidate) => sourceRefsEqual(candidate, sourceRef))
}

/**
 * Resolve a table reference found in the AST to a confirmed mapping. A schema-qualified
 * reference must match exactly; an unqualified reference is accepted only when the
 * allowlist has exactly one relation with that name (ambiguity is a rejection, not a
 * silent pick).
 */
export function resolveMapping(
  allowlist: readonly BusinessObjectMapping[],
  schema: string | undefined,
  relation: string,
): BusinessObjectMapping | undefined {
  if (schema !== undefined) {
    return allowlist.find((entry) => entry.schema === schema && entry.relation === relation)
  }
  const matches = allowlist.filter((entry) => entry.relation === relation)
  return matches.length === 1 ? matches[0] : undefined
}

export function isAmbiguousRelation(
  allowlist: readonly BusinessObjectMapping[],
  schema: string | undefined,
  relation: string,
): boolean {
  return schema === undefined && allowlist.filter((entry) => entry.relation === relation).length > 1
}

export function columnTypeOf(dataType: string): ColumnType {
  const normalized = dataType.toLowerCase()
  if (normalized === 'boolean' || normalized === 'bool') return 'boolean'
  if (
    normalized === 'smallint' ||
    normalized === 'integer' ||
    normalized === 'bigint' ||
    normalized === 'oid' ||
    normalized === 'smallserial' ||
    normalized === 'serial' ||
    normalized === 'bigserial'
  ) {
    return 'integer'
  }
  if (
    normalized === 'numeric' ||
    normalized === 'decimal' ||
    normalized === 'real' ||
    normalized === 'double precision' ||
    normalized === 'money'
  ) {
    return 'decimal'
  }
  if (
    normalized.startsWith('timestamp') ||
    normalized === 'date' ||
    normalized.startsWith('time ')
  ) {
    return 'timestamp'
  }
  if (normalized === 'json' || normalized === 'jsonb') return 'json'
  if (normalized === 'bytea') return 'binary'
  return 'string'
}

export const SUPPORTED_DATA_TYPES: readonly SupportedDataType[] = [
  'string',
  'integer',
  'decimal',
  'boolean',
  'timestamp',
  'json',
  'binary',
]

/**
 * A stable schema revision derived from the exact visible catalog shape. It changes when
 * a visible relation or column changes, so a caller can detect a stale catalog instead of
 * silently reinterpreting it.
 */
export function catalogRevisionOf(resources: readonly CatalogResource[]): string {
  const shape = resources.map((resource) => ({
    objectPath: resource.objectRef.objectPath,
    columns: resource.columns.map((column) => `${column.name}:${column.type}`),
  }))
  return sha256DigestOf(JSON.stringify(shape))
}

export function queryColumnOf(column: MappedColumn): QueryColumn {
  return {
    name: column.name,
    type: column.type,
    ...(column.unit === undefined ? {} : { unit: column.unit }),
    ...(column.semanticFieldRef === undefined ? {} : { semanticFieldRef: column.semanticFieldRef }),
  }
}

export function catalogResourceOf(
  mapping: BusinessObjectMapping,
  columns: readonly QueryColumn[],
  schemaRevision: string,
): CatalogResource {
  return {
    objectRef: mapping.objectRef,
    schemaRevision,
    columns: [...columns],
    ...(mapping.conceptRefs === undefined || mapping.conceptRefs.length === 0
      ? {}
      : { conceptRefs: [...mapping.conceptRefs] }),
  }
}
