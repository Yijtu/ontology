import type {
  CompletenessStatus,
  MappingRef,
  ResourceRef,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  SourceObjectRef,
  SourceRef,
  ToolCoverage,
  UnitCode,
  Uuid,
  VersionRef,
  ProjectRevisionRef,
} from './generated/contracts'
import { assertProjectFactInputShape } from './project-mapping'
import type { ProjectFactSourcePin } from './project-mapping'
import type { StructuredQueryPort } from './ports'
import type { AttributeValueType } from './semantic-definitions'
import type { SourceLocator } from './structured-parse'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid, isVersionRef, isRevisionString, isSha256Digest } from './asset-workspace'

/**
 * Project dataset snapshots: the fixed, queryable materialisation of a project's
 * official published facts (SPEC v0.3a asset-data-ui §3.2/§6.2/§6.3, A.US-006/P.US-013).
 *
 * A project revision pins mappings and an approved-input digest. This boundary turns the
 * published facts into a canonical, backend-neutral dataset: one row per project
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
 * the complete snapshot identity additionally binds scope, project/definition and published source pins.
 */

export const PROJECT_DATASET_SCHEMA_VERSION = 'project-dataset-snapshot@1'

/** One canonical projected column, derived from the object's schema, never from a client header. */
export interface ProjectDatasetColumn {
  readonly name: string
  readonly valueType: AttributeValueType
  /** The canonical unit this column is normalised to; present only for a quantity. */
  readonly canonicalUnitCode?: UnitCode
  /** The measured dimension the canonical unit belongs to; present only for a quantity. */
  readonly dimension?: string
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
  readonly factSource?: ProjectFactSourcePin
  readonly statementId?: Uuid
  readonly statementVersion?: RevisionString
  readonly recordedAt?: string
  readonly rowDigest?: Sha256Digest
}

/** Compact query-only pin to the full original source array stored in the exact dataset row. */
export const PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION = 'project-dataset-source-origins@1' as const
export interface ProjectDatasetSourceOriginDigest {
  readonly schemaVersion: typeof PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION
  readonly recordId: Uuid
  readonly sourcesDigest: Sha256Digest
}
export function isProjectDatasetSourceOriginDigest(value: unknown): value is ProjectDatasetSourceOriginDigest {
  return isRecord(value) && value['schemaVersion'] === PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION &&
    Object.keys(value).length === 3 && Object.keys(value).every((key) => ['schemaVersion', 'recordId', 'sourcesDigest'].includes(key)) &&
    isUuid(value['recordId']) && isSha256Digest(value['sourcesDigest'])
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
  /** Official publication/identity read point and digest, fixed at projection creation. */
  readonly factRecordedPoint?: { readonly semantic: RevisionString; readonly identity: RevisionString }
  readonly sourceDigest?: Sha256Digest
  readonly projectRevisionRef?: ProjectRevisionRef
}

/** The publication reader supplies canonical rows, never staged project records. */
export interface ProjectPublishedDataset {
  readonly rows: readonly ProjectDatasetRow[]
  readonly coverage: ProjectDatasetCoverage
  readonly factRecordedPoint: { readonly semantic: RevisionString; readonly identity: RevisionString }
  readonly sourceDigest: Sha256Digest
}

export interface ProjectPublishedDatasetSource {
  read(scopeRef: ScopeRef, revision: import('./generated/contracts').ProjectRevision, objectId: string, ctx: ToolContext): Promise<ProjectPublishedDataset>
  /** Re-read current official statements using exact accepted physical record versions. */
  readAtRecordVersions?(scopeRef: ScopeRef, revision: import('./generated/contracts').ProjectRevision, objectId: string, records: readonly { readonly recordId: Uuid; readonly revision: RevisionString }[], ctx: ToolContext): Promise<ProjectPublishedDataset>
}

export interface ProjectDatasetSnapshotMetadata {
  readonly scopeRef: ScopeRef
  readonly snapshotRef: ProjectDatasetRef
  readonly body: Omit<ProjectDatasetSnapshotBody, 'rows'>
  readonly rowContentDigest?: Sha256Digest
  /** DuckDB precision selected from exact input decimals, never by rounding. */
  readonly decimalScales?: Readonly<Record<string, number>>
  readonly activation?: ProjectDatasetActivationReceipt
}

/** Immutable evidence of a successful readiness activation; never a request flag. */
export interface ProjectDatasetActivationReceipt {
  readonly schemaVersion: 'project-dataset-activation@1'
  readonly scopeRef: ScopeRef
  readonly projectRevisionRef: ProjectRevisionRef
  readonly snapshotRef: ProjectDatasetRef
  readonly objectId: string
  readonly sourceDigest: Sha256Digest
  readonly factRecordedPoint: { readonly semantic: RevisionString; readonly identity: RevisionString }
  readonly activatedAt: string
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
  /** Host-only: called after the authoritative readiness store reports this exact ready target. */
  recordActivation(scopeRef: ScopeRef, receipt: ProjectDatasetActivationReceipt, ctx: ToolContext): Promise<void>
}

/** The read port. It resolves only the exact pinned snapshot and never a mutable "latest". */
export interface ProjectDatasetQueryPort {
  getActivation(scopeRef: ScopeRef, snapshotRef: ProjectDatasetRef, ctx: ToolContext): Promise<ProjectDatasetActivationReceipt | undefined>
  querySnapshot(
    scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectDatasetQueryResult>
}

/** The two real business SQL dialects a project snapshot can be queried through. */
export type ProjectQueryDialect = 'postgres' | 'duckdb'

/**
 * The physical, read-only relation one fixed snapshot is queryable through. A semantic SQL
 * compiler resolves the object's canonical attribute ids to `columns` here; the relation is
 * created only from the snapshot's canonical rows and is addressed only by the pinned
 * snapshot ref, never by a mutable "latest" dataset.
 */
export interface ProjectSnapshotQueryDescriptor {
  readonly snapshotRef: ProjectDatasetRef
  readonly objectId: string
  readonly dialect: ProjectQueryDialect
  readonly schema: string
  readonly relation: string
  readonly relationKind: 'table' | 'view'
  /** The fixed source object the generated SQL is bound to and must declare. */
  readonly sourceObjectRef: SourceObjectRef
  readonly columns: readonly ProjectDatasetColumn[]
  /** Adapter-pinned source layout. Missing means the legacy full array in `sources_json`. */
  readonly sourceProjection?: 'full_array' | 'compact_pin'
  readonly metadata?: ProjectDatasetSnapshotMetadata
}

/**
 * A `StructuredQueryPort` that reads one project's fixed dataset snapshots (V03-018) through
 * generated, read-only, whitelisted, Schema-validated SQL. `describeSnapshot` reports the
 * exact physical relation a snapshot was materialised as, so the semantic compiler can build
 * a mapping for it without ever guessing a table or falling back to the startup demo data.
 */
export interface ProjectSnapshotQueryPort extends StructuredQueryPort {
  /** Resolve the physical query relation for a materialised snapshot, or `undefined`. */
  describeSnapshot(
    scopeRef: ScopeRef,
    snapshotRef: ProjectDatasetRef,
    ctx: ToolContext,
  ): Promise<ProjectSnapshotQueryDescriptor | undefined>
}

/** The namespace every project dataset snapshot source ref is minted under. */
export const PROJECT_DATASET_SOURCE_NAMESPACE = 'project-dataset'

/** The fixed `SourceObjectRef` a project snapshot's rows are read as (object = dataset row set). */
export function projectDatasetSourceObjectRef(
  snapshotId: string,
  objectId: string,
): SourceObjectRef {
  return {
    sourceRef: projectDatasetSourceRef(snapshotId),
    objectPath: objectId,
  }
}

/** The fixed `SourceRef` one snapshot is authorized as; there is no mutable override. */
export function projectDatasetSourceRef(snapshotId: string): SourceRef {
  return { namespace: PROJECT_DATASET_SOURCE_NAMESPACE, sourceId: snapshotId }
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
  if (value['dimension'] !== undefined && !isNonEmptyString(value['dimension'])) return false
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
  if (value['factSource'] !== undefined) {
    try { assertProjectFactInputShape({ sources: [value['factSource']] }) } catch { return false }
    if (!isUuid(value['statementId']) || !isRevisionString(value['statementVersion']) ||
      typeof value['recordedAt'] !== 'string' || !isSha256Digest(value['rowDigest'])) return false
  }
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
  if (new Set(columns.map((column) => column.name)).size !== columns.length || columns.some((column) => ['record_id', 'object_id', 'source_row_key', 'values_json', 'sources_json', 'sources_full_json'].includes(column.name.toLowerCase()))) throw invalidDataset('columns contain duplicate or reserved names')
  const rows = body['rows']
  if (!Array.isArray(rows) || !rows.every(isDatasetRow)) throw invalidDataset('rows are malformed')
  if (rows.length > 20_000 || new Set(rows.map((row) => row.recordId)).size !== rows.length) throw invalidDataset('rows exceed the record cap or duplicate physical identities')
  const columnsByName = new Map(columns.map((column) => [column.name, column]))
  for (const row of rows) {
    if (row.objectId !== body['objectId']) throw invalidDataset('a row belongs to another object')
    for (const [name, cell] of Object.entries(row.values)) {
      const column = columnsByName.get(name)
      if (column === undefined) throw invalidDataset('a row contains an undeclared attribute')
      if (cell.kind === 'quantity') {
        if (column.valueType !== 'quantity' || cell.unitCode !== column.canonicalUnitCode || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell.value)) throw invalidDataset('a quantity cell differs from its declared type/unit')
      } else if (cell.value !== null && (column.valueType === 'quantity' || column.valueType === 'boolean' && typeof cell.value !== 'boolean' ||
        column.valueType === 'number' && (typeof cell.value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell.value)) ||
        ['string', 'timestamp', 'enum', 'reference'].includes(column.valueType) && typeof cell.value !== 'string')) throw invalidDataset('a scalar cell differs from its declared type')
    }
  }
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
  if (body['factRecordedPoint'] !== undefined) {
    const point = body['factRecordedPoint']
    const revision = body['projectRevisionRef']
    if (!isRecord(point) || !isRevisionString(point['semantic']) || !isRevisionString(point['identity']) || !isSha256Digest(body['sourceDigest']) ||
      !isRecord(revision) || !isUuid(revision['projectId']) || !isRevisionString(revision['revision']) || !isSha256Digest(revision['digest']) ||
      revision['projectId'] !== body['projectId'] || revision['revision'] !== body['projectRevision']) throw invalidDataset('official fact snapshot pins are malformed')
  }
}

export function assertProjectDatasetFieldSourcesShape(value: unknown): asserts value is ProjectDatasetFieldSource[] {
  if (!Array.isArray(value) || !value.every(isFieldSource)) throw invalidDataset('project dataset field sources are malformed')
}

export function assertProjectDatasetMetadataShape(value: unknown): asserts value is ProjectDatasetSnapshotMetadata {
  if (!isRecord(value) || !isRecord(value['scopeRef']) || !isNonEmptyString(value['scopeRef']['tenantId']) || !isNonEmptyString(value['scopeRef']['spaceId']) || !isRecord(value['body'])) throw invalidDataset('dataset metadata is malformed')
  assertProjectDatasetSnapshotShape({ ref: value['snapshotRef'], body: { ...value['body'], rows: [] } })
  if (value['rowContentDigest'] !== undefined && !isSha256Digest(value['rowContentDigest'])) throw invalidDataset('row content digest is malformed')
  if (value['decimalScales'] !== undefined && (!isRecord(value['decimalScales']) || !Object.values(value['decimalScales']).every((scale) => typeof scale === 'number' && Number.isInteger(scale) && scale >= 0 && scale <= 38))) throw invalidDataset('decimal scales are malformed')
  if (value['activation'] !== undefined) {
    assertProjectDatasetActivationShape(value['activation'])
    const receipt = value['activation']
    const ref = value['snapshotRef']
    if (!isResourceRef(ref)) throw invalidDataset('activation snapshot reference is malformed')
    const body = value['body']
    const point = body['factRecordedPoint']
    const revision = body['projectRevisionRef']
    if (!isRecord(point) || !isRecord(revision) || receipt.scopeRef.tenantId !== value['scopeRef']['tenantId'] || receipt.scopeRef.spaceId !== value['scopeRef']['spaceId'] ||
      receipt.snapshotRef.id !== ref.id || receipt.snapshotRef.version !== ref.version || receipt.snapshotRef.digest !== ref.digest ||
      receipt.projectRevisionRef.projectId !== revision['projectId'] || receipt.projectRevisionRef.revision !== revision['revision'] || receipt.projectRevisionRef.digest !== revision['digest'] ||
      receipt.objectId !== body['objectId'] || receipt.sourceDigest !== body['sourceDigest'] || receipt.factRecordedPoint.semantic !== point['semantic'] || receipt.factRecordedPoint.identity !== point['identity']) throw invalidDataset('activation receipt differs from its immutable snapshot pins')
  }
}

export function assertProjectDatasetActivationShape(value: unknown): asserts value is ProjectDatasetActivationReceipt {
  if (!isRecord(value) || value['schemaVersion'] !== 'project-dataset-activation@1' || !isRecord(value['scopeRef']) ||
    !isNonEmptyString(value['scopeRef']['tenantId']) || !isNonEmptyString(value['scopeRef']['spaceId']) || !isResourceRef(value['snapshotRef']) || value['snapshotRef'].kind !== 'dataset' ||
    !isRecord(value['projectRevisionRef']) || !isUuid(value['projectRevisionRef']['projectId']) || !isRevisionString(value['projectRevisionRef']['revision']) || !isSha256Digest(value['projectRevisionRef']['digest']) ||
    !isNonEmptyString(value['objectId']) || !isSha256Digest(value['sourceDigest']) || !isRecord(value['factRecordedPoint']) || !isRevisionString(value['factRecordedPoint']['semantic']) || !isRevisionString(value['factRecordedPoint']['identity']) ||
    typeof value['activatedAt'] !== 'string' || Number.isNaN(Date.parse(value['activatedAt']))) throw invalidDataset('activation receipt is malformed')
}

/** Compare typed physical columns with the canonical cells without converting decimals to Number. */
export function projectDatasetPhysicalCellsMatch(columns: readonly ProjectDatasetColumn[], canonical: readonly ProjectDatasetRow[], physical: readonly { readonly recordId: string; readonly values: Readonly<Record<string, unknown>> }[]): boolean {
  if (canonical.length !== physical.length) return false
  const decimal = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return undefined
    const negative = value.startsWith('-')
    const [integer = '', fraction = ''] = value.replace(/^-/, '').split('.')
    const trimmed = fraction.replace(/0+$/, '')
    const amount = `${integer}${trimmed === '' ? '' : `.${trimmed}`}`
    return amount === '0' ? '0' : `${negative ? '-' : ''}${amount}`
  }
  return canonical.every((row, index) => {
    const actual = physical[index]
    if (actual?.recordId !== row.recordId) return false
    return columns.every((column) => {
      const expected = row.values[column.name]?.value ?? null
      const value = actual.values[column.name] ?? null
      if (expected === null) return value === null
      if (column.valueType === 'number' || column.valueType === 'quantity') return decimal(expected) !== undefined && decimal(expected) === decimal(value)
      if (column.valueType === 'timestamp') return typeof expected === 'string' && typeof value === 'string' && Date.parse(expected) === Date.parse(value)
      return expected === value
    })
  })
}

function invalidDataset(message: string): ProjectDatasetError {
  return new ProjectDatasetError('INVALID_ARGUMENT', message)
}
