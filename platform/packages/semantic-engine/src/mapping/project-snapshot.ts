import { sha256DigestOf } from '@ontology/core'
import type {
  ProjectDatasetColumn,
  ProjectSnapshotQueryDescriptor,
  SourceObjectRef,
  VersionRef,
} from '@ontology/contracts'
import { canonicalColumnTypeOf } from './types'
import type { FieldMapping, MappingDialect, ObjectMapping, SemanticMapping } from './types'

/**
 * Compile a confirmed *project* mapping into the semantic mapping the SQL compiler consumes
 * (SPEC v0.3a execution-evidence EX-3.1, A.US-007.AC-03 / A.FR-11).
 *
 * A project dataset snapshot (V03-018) is one canonical relation: one row per approved project
 * record, one typed column per object attribute, plus a fixed row identity and the row's exact
 * source locators. This module turns that backend-neutral shape into a `SemanticMapping` whose
 * identifiers come only from the snapshot the caller pinned — never from a model, a client
 * header, or the startup demo data.
 *
 * The compiler upstream validates every identifier (`assertSafeIdentifier`) and the adapter
 * downstream re-checks the relation against its object whitelist, so a mapping built here can
 * only ever reach the exact fixed snapshot it was derived from.
 */

/** The reserved canonical attribute the row identity is projected as. */
export const PROJECT_SNAPSHOT_RECORD_ID_FIELD = 'record_id'
/** The reserved canonical attribute the row's source locators are projected as (JSON text). */
export const PROJECT_SNAPSHOT_SOURCES_FIELD = 'sources_json'

const DEFAULT_ESTIMATED_ROWS = 20_000

export interface BuildProjectSnapshotMappingInput {
  readonly descriptor: ProjectSnapshotQueryDescriptor
  /** Conservative row bound used only for the compiler's transfer budget. */
  readonly estimatedRows?: number
}

function dialectOf(descriptor: ProjectSnapshotQueryDescriptor): MappingDialect {
  return descriptor.dialect === 'postgres' ? 'postgres' : 'duckdb'
}

function unitFor(column: ProjectDatasetColumn): FieldMapping['unit'] {
  if (column.canonicalUnitCode === undefined) return undefined
  return { unitCode: column.canonicalUnitCode, dimension: column.dimension ?? 'quantity' }
}

function fieldsOf(descriptor: ProjectSnapshotQueryDescriptor): FieldMapping[] {
  const fields: FieldMapping[] = []
  for (const column of descriptor.columns) {
    const unit = unitFor(column)
    fields.push({
      fieldRef: column.name,
      column: column.name,
      valueType: column.valueType,
      ...(['number', 'quantity'].includes(column.valueType) ? { exactDecimal: true } : {}),
      ...(unit === undefined ? {} : { unit }),
    })
  }
  // The identity and the located sources are not part of the object's declaration, but they
  // are the rows' fixed physical columns; the query service projects them to attach exact
  // source locators to each returned row. They carry the reserved field refs, so a plan
  // cannot silently request them as business attributes.
  fields.push({
    fieldRef: PROJECT_SNAPSHOT_RECORD_ID_FIELD,
    column: PROJECT_SNAPSHOT_RECORD_ID_FIELD,
    valueType: 'string',
    identityKey: true,
  })
  fields.push({
    fieldRef: PROJECT_SNAPSHOT_SOURCES_FIELD,
    column: PROJECT_SNAPSHOT_SOURCES_FIELD,
    valueType: 'string',
  })
  return fields
}

/**
 * Derive the immutable `VersionRef` for one snapshot relation. It is a pure digest of the
 * snapshot ref, the object and the exact typed columns, so the same approved rows always
 * resolve to the same mapping version and a changed dataset is a new version.
 */
export function projectSnapshotMappingRef(input: BuildProjectSnapshotMappingInput): VersionRef {
  const { descriptor } = input
  const id = `project-snapshot:${descriptor.objectId}`
  return {
    id,
    version: descriptor.snapshotRef.version,
    digest: sha256DigestOf(
      JSON.stringify({
        id,
        snapshotRef: descriptor.snapshotRef,
        objectId: descriptor.objectId,
        dialect: descriptor.dialect,
        schema: descriptor.schema,
        relation: descriptor.relation,
        sourceObjectRef: descriptor.sourceObjectRef,
        columns: descriptor.columns.map((column) => ({
          name: column.name,
          valueType: column.valueType,
          canonicalUnitCode: column.canonicalUnitCode ?? null,
          dimension: column.dimension ?? null,
        })),
      }),
    ),
  }
}

/**
 * Build the semantic mapping over one fixed project snapshot relation. The mapping is
 * intentionally single-object: a project dataset is one canonical relation, and a relation
 * query across objects is V03-027's job, not an implicit cross join here.
 */
export function buildProjectSnapshotMapping(input: BuildProjectSnapshotMappingInput): SemanticMapping {
  const { descriptor } = input
  const fields = fieldsOf(descriptor)
  const sourceObjectRef: SourceObjectRef = {
    sourceRef: descriptor.sourceObjectRef.sourceRef,
    objectPath: descriptor.sourceObjectRef.objectPath,
  }
  const object: ObjectMapping = {
    conceptId: descriptor.objectId,
    sourceObjectRef,
    schema: descriptor.schema,
    relation: descriptor.relation,
    relationKind: descriptor.relationKind,
    estimatedRows: input.estimatedRows ?? DEFAULT_ESTIMATED_ROWS,
    fields,
  }
  return {
    mappingRef: projectSnapshotMappingRef(input),
    dialect: dialectOf(descriptor),
    objects: [object],
    links: [],
  }
}

/** The canonical output column type for one project snapshot attribute. */
export function projectSnapshotColumnType(column: ProjectDatasetColumn): ReturnType<typeof canonicalColumnTypeOf> {
  return canonicalColumnTypeOf(column.valueType)
}
