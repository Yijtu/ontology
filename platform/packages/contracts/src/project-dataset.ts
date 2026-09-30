import type {
  CompletenessStatus,
  MappingRef,
  ResourceRef,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  ToolCoverage,
  UnitCode,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { AttributeValueType } from './semantic-definitions'
import type { SourceLocator } from './structured-parse'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid, isVersionRef } from './asset-workspace'

/**
 * Project dataset snapshots: the fixed, queryable materialisation of a project's
 * *approved* records (SPEC v0.3a asset-data-ui §3.2/§6.2/§6.3, A.US-006/P.US-013).
 *
 * A project revision pins mappings and an approved-input digest. This boundary turns the
 * bound project records into a canonical, backend-neutral dataset: one row per project
 * record, canonical attribute columns, and every row carrying the exact physical source
 * (original document + parse + locator) each value was read from.
 *
 * The snapshot is deliberately *not* the business backend's mutable state. It has a fixed
 * access identity (`ref` = snapshot id + version + canonical digest) and is activated through
 * the independent readiness projection; a reader that cannot resolve the exact pinned snapshot
 * must report `SNAPSHOT_UNAVAILABLE` instead of silently reading a newer dataset.
 *
 * Two different client column names / units that describe the same business value normalise
 * to the same canonical cell, so the canonical rows (and the canonical digest) are identical;
 * only the `sources` and `mappingRefs` differ, which is exactly the audit trail.
 */

export const PROJECT_DATASET_SCHEMA_VERSION = 'project-dataset-snapshot@1'

/** One canonical projected column, derived from the object's schema, never from a client header. */
export interface ProjectDatasetColumn {
  readonly name: string
  readonly valueType: AttributeValueType
  /** The canonical unit this column is normalised to; present only for a quantity. */
  readonly canonicalUnitCode?: UnitCode
}

/** One canonical cell. The value is always the exact, already-normalised representation. */
export type ProjectDatasetCell =
  | { readonly kind: 'scalar'; readonly value: string | boolean | null }
  | { readonly kind: 'quantity'; readonly value: string; readonly unitCode: UnitCode }

/** The physical object one field was read from: original document + parse + exact locator. */
export interface ProjectDatasetFieldSource {
  readonly fieldId: string
  readonly documentRef: ResourceRef
  readonly parseId: Uuid
  readonly locator: SourceLocator
}

/** One canonical dataset row. `sources` locates every value at its actual physical object. */
export interface ProjectDatasetRow {
  readonly recordId: Uuid
  readonly objectId: string
  readonly sourceRowKey: string
  readonly values: Readonly<Record<string, ProjectDatasetCell>>
  readonly sources: readonly ProjectDatasetFieldSource[]
}

export interface ProjectDatasetCoverage {
  /** Every approved record the snapshot was expected to contain. */
  readonly expectedCount: number
  /** Records actually projected into the snapshot. */
  readonly processedCount: number
  /** Records deliberately excluded, with a reason (partial approvals only). */
  readonly excluded: readonly ProjectDatasetExclusion[]
  readonly completeness: CompletenessStatus
}

export interface ProjectDatasetExclusion {
  readonly recordId: Uuid
  readonly reason: string
}

/**
 * The fixed dataset body. It excludes its own digest and the outer ref, and its canonical
 * digest is computed over `objectId` + `columns` + canonical `values` only, so two mappings
 * of the same business data share one digest.
 */
export interface ProjectDatasetSnapshotBody {
  readonly schemaVersion: 'project-dataset-snapshot@1'
  readonly projectId: Uuid
  readonly objectId: string
  /** The project revision this snapshot was frozen from. */
  readonly projectRevision: RevisionString
  /** Monotonic per project/object dataset revision. */
  readonly datasetRevision: RevisionString
  readonly definitionRef: VersionRef
  readonly mappingRefs: readonly MappingRef[]
  readonly backend: string
  readonly columns: readonly ProjectDatasetColumn[]
  readonly rows: readonly ProjectDatasetRow[]
  readonly coverage: ProjectDatasetCoverage
  readonly recordedAt: string
}

/** The resource reference that pins one immutable dataset snapshot. */
export type ProjectDatasetRef = ResourceRef

export interface ProjectDatasetSnapshot {
  readonly ref: ProjectDatasetRef
  readonly body: ProjectDatasetSnapshotBody
}

export interface ProjectDatasetWriteMeta {
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
}

export interface ProjectDatasetStageResult {
  readonly snapshotRef: ProjectDatasetRef
  readonly rowCount: number
  readonly schemaDigest: Sha256Digest
  /** Digest the backend recomputed from the rows it actually persisted. */
  readonly canonicalDigest: Sha256Digest
  readonly created: boolean
}

export interface ProjectDatasetStageInput {
  readonly body: ProjectDatasetSnapshotBody
  readonly snapshotRef: ProjectDatasetRef
  readonly schemaDigest: Sha256Digest
  readonly canonicalDigest: Sha256Digest
  readonly meta: ProjectDatasetWriteMeta
}

export interface ProjectDatasetQueryRequest {
  readonly snapshotRef: ProjectDatasetRef
  readonly objectId?: string
  readonly limit?: number
  readonly cursor?: string
}

/** One row as read back from the business backend, with its exact source locations. */
export interface ProjectDatasetReadRow {
  readonly recordId: Uuid
  readonly objectId: string
  readonly sourceRowKey: string
  readonly values: Readonly<Record<string, ProjectDatasetCell>>
  readonly sources: readonly ProjectDatasetFieldSource[]
}

export interface ProjectDatasetQueryResult {
  readonly snapshotRef: ProjectDatasetRef
  readonly columns: readonly ProjectDatasetColumn[]
  readonly rows: readonly ProjectDatasetReadRow[]
  readonly coverage: ToolCoverage
}

/**
 * The independent writer port. A materialisation build writes a scoped, staged snapshot in
 * a business backend (DuckDB / business PostgreSQL) through this port only; it never touches
 * the control-store role or the read-only QueryPort.
 */
export interface ProjectDatasetWriterPort {
  readonly backend: string
  stageSnapshot(
    scopeRef: ScopeRef,
    input: ProjectDatasetStageInput,
    ctx: ToolContext,
  ): Promise<ProjectDatasetStageResult>
  /** Drop a stamped snapshot that was never activated; kept for crash cleanup. */
  discardSnapshot(scopeRef: ScopeRef, snapshotRef: ProjectDatasetRef, ctx: ToolContext): Promise<void>
}

/** The read port. It resolves only the exact pinned snapshot and never a mutable "latest". */
export interface ProjectDatasetQueryPort {
  querySnapshot(
    scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectDatasetQueryResult>
}

export type ProjectDatasetErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'PROJECT_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'INPUT_NOT_READY'
  | 'MATERIALIZATION_MISMATCH'
  | 'BACKEND_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SNAPSHOT_UNAVAILABLE'

const DATASET_HTTP_STATUS: Readonly<Record<ProjectDatasetErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  FORBIDDEN: 403,
  PROJECT_NOT_FOUND: 404,
  REVISION_NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  INPUT_NOT_READY: 409,
  MATERIALIZATION_MISMATCH: 409,
  BACKEND_UNAVAILABLE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  SNAPSHOT_UNAVAILABLE: 409,
}

export class ProjectDatasetError extends Error {
  readonly code: ProjectDatasetErrorCode
  readonly httpStatus: number
  readonly reasons: readonly string[]

  constructor(
    code: ProjectDatasetErrorCode,
    message: string,
    options?: ErrorOptions & { readonly reasons?: readonly string[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProjectDatasetError'
    this.code = code
    this.httpStatus = DATASET_HTTP_STATUS[code]
    this.reasons = options?.reasons ?? []
  }
}

export const PROJECT_DATASET_KINDS: readonly AttributeValueType[] = [
  'string',
  'number',
  'boolean',
  'timestamp',
  'enum',
  'quantity',
  'reference',
]

const COMPLETENESS_STATES: readonly CompletenessStatus[] = ['complete', 'partial', 'truncated', 'unknown']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDatasetColumn(value: unknown): value is ProjectDatasetColumn {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['name'])) return false
  if (!PROJECT_DATASET_KINDS.includes(value['valueType'] as AttributeValueType)) return false
  if (value['canonicalUnitCode'] !== undefined && !isNonEmptyString(value['canonicalUnitCode'])) return false
  return true
}

function isDatasetCell(value: unknown): value is ProjectDatasetCell {
  if (!isRecord(value)) return false
  if (value['kind'] === 'scalar') {
    const scalar = value['value']
    return scalar === null || typeof scalar === 'string' || typeof scalar === 'boolean'
  }
  if (value['kind'] === 'quantity') {
    return isNonEmptyString(value['value']) && isNonEmptyString(value['unitCode'])
  }
  return false
}

function isSourceLocator(value: unknown): value is SourceLocator {
  if (!isRecord(value)) return false
  const kind = value['kind']
  return (
    kind === 'offset' ||
    kind === 'page' ||
    kind === 'approximate_locator' ||
    kind === 'json_pointer' ||
    kind === 'table_cell' ||
    kind === 'table_row'
  )
}

function isFieldSource(value: unknown): value is ProjectDatasetFieldSource {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value['fieldId']) &&
    isResourceRef(value['documentRef']) &&
    isUuid(value['parseId']) &&
    isSourceLocator(value['locator'])
  )
}

function isDatasetRow(value: unknown): value is ProjectDatasetRow {
  if (!isRecord(value)) return false
  if (!isUuid(value['recordId'])) return false
  if (!isNonEmptyString(value['objectId'])) return false
  if (!isNonEmptyString(value['sourceRowKey'])) return false
  const values = value['values']
  if (!isRecord(values)) return false
  if (!Object.values(values).every(isDatasetCell)) return false
  const sourceList = value['sources']
  if (!Array.isArray(sourceList) || !sourceList.every(isFieldSource)) return false
  return true
}

function isMappingRefArray(value: unknown): value is MappingRef[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && isNonEmptyString(entry['id']))
}

/**
 * Validate one fixed dataset snapshot before the store persists it. The projection is a
 * boundary object a later reader trusts, so a malformed column/row/source is refused rather
 * than surfaced as a queryable dataset (AGENTS: boundary data is validated at runtime).
 */
export function assertProjectDatasetSnapshotShape(value: unknown): asserts value is ProjectDatasetSnapshot {
  if (!isRecord(value)) throw invalidDataset('project dataset snapshot must be an object')
  if (!isResourceRef(value['ref'])) throw invalidDataset('snapshot ref is malformed')
  const body = value['body']
  if (!isRecord(body)) throw invalidDataset('snapshot body must be an object')
  if (body['schemaVersion'] !== PROJECT_DATASET_SCHEMA_VERSION) {
    throw invalidDataset(`snapshot body must declare schemaVersion ${PROJECT_DATASET_SCHEMA_VERSION}`)
  }
  if (!isUuid(body['projectId'])) throw invalidDataset('projectId must be a uuid')
  if (!isNonEmptyString(body['objectId'])) throw invalidDataset('objectId must be a non-empty string')
  if (!isNonEmptyString(body['projectRevision'])) throw invalidDataset('projectRevision must be a decimal string')
  if (!isNonEmptyString(body['datasetRevision'])) throw invalidDataset('datasetRevision must be a decimal string')
  if (!isVersionRef(body['definitionRef'])) throw invalidDataset('definitionRef is malformed')
  if (!isMappingRefArray(body['mappingRefs'])) throw invalidDataset('mappingRefs must be a mapping ref array')
  if (!isNonEmptyString(body['backend'])) throw invalidDataset('backend must be a non-empty string')
  const columns = body['columns']
  if (!Array.isArray(columns) || !columns.every(isDatasetColumn)) throw invalidDataset('columns are malformed')
  const rows = body['rows']
  if (!Array.isArray(rows) || !rows.every(isDatasetRow)) throw invalidDataset('rows are malformed')
  const coverage = body['coverage']
  if (!isRecord(coverage)) throw invalidDataset('coverage is malformed')
  for (const field of ['expectedCount', 'processedCount'] as const) {
    if (typeof coverage[field] !== 'number' || !Number.isInteger(coverage[field]) || coverage[field] < 0) {
      throw invalidDataset(`coverage.${field} must be a non-negative integer`)
    }
  }
  if (!Array.isArray(coverage['excluded'])) throw invalidDataset('coverage.excluded must be an array')
  if (!COMPLETENESS_STATES.includes(coverage['completeness'] as CompletenessStatus)) {
    throw invalidDataset('coverage.completeness is not a known status')
  }
  if (!isNonEmptyString(body['recordedAt'])) throw invalidDataset('recordedAt must be a timestamp')
}

function invalidDataset(message: string): ProjectDatasetError {
  return new ProjectDatasetError('INVALID_ARGUMENT', message)
}
