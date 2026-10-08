import type {
  DecimalString,
  MappingRef,
  ResourceRef,
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Semver,
  Sha256Digest,
  UnitCode,
  Uuid,
  VersionRef,
  ProjectRevisionRef,
} from './generated/contracts'
import type { AttributeValueType } from './semantic-definitions'
import type { SourceLocator, StructuredFormat, StructuredParseOptions } from './structured-parse'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isRevisionString, isSha256Digest, isUuid, isVersionRef } from './asset-workspace'

/**
 * Column-mapping confirmation, unit normalisation and project-record binding
 * (SPEC v0.3a asset-data-ui §3.3/§5/§6.2/§8.1, A.US-002/A.US-006/P.US-008/P.US-013).
 *
 * A customer file names its columns and units however it likes. This boundary maps a
 * chosen worksheet + explicit column correspondence onto the project's canonical
 * definition attributes, normalises every quantity to the attribute's canonical unit with
 * an exact rational factor, and binds the reconciled source rows to stable project-record
 * identities. Physical column names and the file itself never enter an industry declaration.
 *
 * Nothing is guessed: an unsupported header/structure is located explicitly, a missing or
 * duplicated column is an issue, and a wrong/unknown unit stays `pending`/blocked instead of
 * being coerced to the canonical unit without a declared exact conversion.
 */

export const IMPORT_MAPPING_SCHEMA_VERSION = 'import-mapping@1'
export const PROJECT_RECORD_SCHEMA_VERSION = 'project-record@1'

/** Stored provenance, minted by the mapping bridge; requests supply selectors only. */
export interface ProjectFactSourcePin {
  readonly projectRevisionRef: ProjectRevisionRef
  readonly definitionRef: VersionRef
  readonly mappingRef: MappingRef
  readonly recordId: Uuid
  readonly recordRevision: RevisionString
  readonly contentDigest: Sha256Digest
  readonly sourceDigest: Sha256Digest
  readonly sourceRecordedAt: Rfc3339UtcTimestamp
  readonly documentId: Uuid
  readonly parseId: Uuid
  readonly membershipRevision: RevisionString
  readonly visibilityEpoch: RevisionString
  /** Entity candidate whose fields and human identity are authoritative. */
  readonly entityCandidateId: Uuid
}

export interface ProjectFactInput {
  readonly sources: readonly ProjectFactSourcePin[]
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
}

export interface StageProjectFactsRequest {
  readonly documentId: Uuid
  readonly recordRefs: readonly { readonly recordId: Uuid; readonly revision: RevisionString }[]
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
}

export interface ProjectFactPublicationFence {
  readonly candidateId: Uuid
  readonly candidateDigest: Sha256Digest
  readonly source: ProjectFactSourcePin
  readonly instanceRevision: RevisionString
  readonly entityId: string
}

/** Runtime validation at the candidate/publication boundary, including finite source fanout. */
export function assertProjectFactInputShape(value: unknown): asserts value is ProjectFactInput {
  if (!isRecord(value) || !Array.isArray(value['sources']) || value['sources'].length < 1 || value['sources'].length > 2) {
    throw invalidMapping('mapped fact requires one or two stored source pins')
  }
  for (const source of value['sources']) {
    if (!isRecord(source) || !isRecord(source['projectRevisionRef']) || !isUuid(source['projectRevisionRef']['projectId']) || !isRevisionString(source['projectRevisionRef']['revision']) || !isSha256Digest(source['projectRevisionRef']['digest']) ||
      !isVersionRef(source['definitionRef']) || !isRecord(source['mappingRef']) || source['mappingRef']['role'] !== 'catalog' || !isRecord(source['mappingRef']['sourceObjectRef']) || !isVersionRef(source['mappingRef']) || !isUuid(source['recordId']) || !isRevisionString(source['recordRevision']) || !isSha256Digest(source['contentDigest']) || !isSha256Digest(source['sourceDigest']) ||
      !isUuid(source['documentId']) || !isUuid(source['parseId']) || !isUuid(source['entityCandidateId']) || !isRevisionString(source['membershipRevision']) || !isRevisionString(source['visibilityEpoch']) ||
      typeof source['sourceRecordedAt'] !== 'string' || Number.isNaN(Date.parse(source['sourceRecordedAt']))) throw invalidMapping('mapped fact source pin is malformed')
  }
  for (const field of ['validFrom', 'validTo']) {
    const timestamp = value[field]
    if (timestamp !== undefined && (typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp)))) throw invalidMapping('mapped fact valid time is malformed')
  }
  if (typeof value['validFrom'] === 'string' && typeof value['validTo'] === 'string' && Date.parse(value['validTo']) <= Date.parse(value['validFrom'])) throw invalidMapping('mapped fact interval must be nonempty')
}

/**
 * One declared exact conversion from a source unit to the canonical unit, expressed as a
 * rational factor (`numerator`/`denominator`) over exact `DecimalString`s. A float factor is
 * deliberately not representable, so a normalised quantity never loses precision.
 */
export interface ExactUnitConversion {
  readonly fromUnitCode: UnitCode
  readonly toUnitCode: UnitCode
  readonly numerator: DecimalString
  readonly denominator: DecimalString
}

/** Deterministic source-value to canonical-value mapping (enums, booleans, coded strings). */
export interface ValueMappingEntry {
  readonly from: string
  readonly to: string
}

/**
 * The correspondence between one canonical attribute and the source column/JSON leaf it is
 * read from. `columnIndex` is 0-based within the selected record; `pointer` is the exact
 * JSON Pointer for JSON/text records. Both `header` and `headerDigest` pin the physical
 * column so a re-import with a changed header is detected instead of silently re-mapped.
 */
export interface ColumnMappingEntry {
  readonly fieldRef: string
  readonly header: string
  readonly headerDigest: Sha256Digest
  readonly columnIndex: number
  readonly pointer?: string
  /** Verbatim source unit written in the file; absent for a non-quantity. */
  readonly sourceUnitCode?: UnitCode
  /** Canonical unit this field normalises to; must equal the attribute's canonical unit. */
  readonly canonicalUnitCode?: UnitCode
  /** Declared exact conversion; absent means identity. */
  readonly unitConversion?: ExactUnitConversion
  readonly valueMapping?: readonly ValueMappingEntry[]
}

/**
 * A confirmed, immutable import mapping version. `ref` is the mapping reference a
 * `ProjectRevision.mappingRefs` pins; the digest covers exactly the selection and the
 * correspondence, so changing a column or a unit factor is a new version.
 */
export interface ImportMappingVersion {
  readonly schemaVersion: 'import-mapping@1'
  readonly projectId: Uuid
  readonly mappingId: Uuid
  readonly version: Semver
  readonly ref: MappingRef
  readonly definitionRef: VersionRef
  readonly format: StructuredFormat
  readonly parseId: Uuid
  readonly originalRef: ResourceRef
  /** The stored original's media type, pinned so binding re-reads the exact parse selection. */
  readonly originalMediaType: string
  /** The confirmed parser selection (delimiter/quote/sheet/header/range/cap mode). */
  readonly options: Omit<StructuredParseOptions, 'mediaType'>
  readonly objectId: string
  readonly sheetId?: string
  readonly sheetName?: string
  readonly entries: readonly ColumnMappingEntry[]
  readonly digest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export type MappingNormalization = 'identity' | 'exact' | 'unresolved'

export interface MappingSample {
  /** 1-based record index within the selected sheet/record set. */
  readonly recordIndex: number
  /** 1-based original row/record number. */
  readonly row: number
  /** The verbatim original token or selected value. */
  readonly raw: string
  /** The canonical value when it resolves exactly; absent when it does not. */
  readonly canonical?: string
  readonly locator: SourceLocator
}

export interface ColumnPreview {
  readonly fieldRef: string
  readonly valueType: AttributeValueType
  readonly canonicalUnitCode?: UnitCode
  readonly sourceUnitCode?: UnitCode
  readonly normalization: MappingNormalization
  readonly columnIndex: number
  readonly header: string
  readonly samples: readonly MappingSample[]
}

export interface MappingUnmappedColumn {
  readonly columnIndex: number
  readonly header: string
}

/**
 * Why a mapping is not confirmable or a value is not exact. Every code is an explicit,
 * queryable state; nothing is dropped or coerced.
 */
export type MappingIssueCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_TABLE_LAYOUT'
  | 'MISSING_SHEET'
  | 'NO_ROWS'
  | 'UNKNOWN_OBJECT'
  | 'UNKNOWN_ATTRIBUTE'
  | 'ATTRIBUTE_NOT_ON_OBJECT'
  | 'MISSING_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'HEADER_MISMATCH'
  | 'COLUMN_INDEX_OUT_OF_RANGE'
  | 'TYPE_MISMATCH'
  | 'INVALID_DECIMAL'
  | 'MISSING_UNIT'
  | 'UNKNOWN_UNIT'
  | 'UNIT_MISMATCH'
  | 'MISSING_UNIT_CONVERSION'
  | 'VALUE_NOT_MAPPED'

export interface MappingIssue {
  readonly code: MappingIssueCode
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly fieldRef?: string
  readonly columnIndex?: number
  readonly header?: string
  readonly recordIndex?: number
}

/** The non-persisted result of validating a proposed correspondence against a parsed file. */
export interface MappingPreview {
  readonly projectId: Uuid
  readonly definitionRef: VersionRef
  readonly objectId: string
  readonly format: StructuredFormat
  readonly parseId: Uuid
  readonly columns: readonly ColumnPreview[]
  readonly unmappedColumns: readonly MappingUnmappedColumn[]
  readonly issues: readonly MappingIssue[]
  readonly rowCount: number
  readonly confirmable: boolean
}

/** Everything needed to re-read the file and reproduce a preview/confirmation. */
export interface ColumnMappingRequest {
  /** Optional; when present it must equal the project head revision's definition. */
  readonly definitionRef?: VersionRef
  readonly format: StructuredFormat
  readonly parseId: Uuid
  readonly originalRef: ResourceRef
  readonly originalMediaType: string
  readonly options: Omit<StructuredParseOptions, 'mediaType'>
  readonly objectId: string
  readonly sheetId?: string
  readonly sheetName?: string
  readonly entries: readonly ColumnMappingEntry[]
  /** When present, append a new version to this mapping instead of creating a new id. */
  readonly mappingId?: Uuid
}

export type ProjectRecordFieldStatus = 'confirmed' | 'pending' | 'conflict'

export type NormalizedProjectFieldValue =
  | { readonly kind: 'scalar'; readonly value: string | boolean | null }
  | { readonly kind: 'quantity'; readonly value: DecimalString; readonly unitCode: UnitCode }

/** One field of a bound project record, with the verbatim raw token and its source locator. */
export interface ProjectRecordFieldValue {
  readonly fieldId: string
  readonly raw: string | boolean | null
  readonly normalized: NormalizedProjectFieldValue
  readonly sourceUnitCode?: UnitCode
  readonly status: ProjectRecordFieldStatus
  readonly reason?: string
  readonly locator: SourceLocator
}

/**
 * An immutable project-record version. `recordId` is the stable original-record identity
 * derived by the ingestion layer (scope + original digest + source row key), so re-importing
 * identical bytes resolves to the same record while two rows of one entity stay two records.
 */
export interface ProjectRecordVersion {
  readonly schemaVersion: 'project-record@1'
  readonly projectId: Uuid
  readonly recordId: Uuid
  readonly revision: RevisionString
  readonly mappingId: Uuid
  readonly mappingVersion: Semver
  readonly objectId: string
  readonly sourceRowKey: string
  readonly sourceDigest: Sha256Digest
  readonly contentDigest: Sha256Digest
  readonly fields: readonly ProjectRecordFieldValue[]
  readonly status: ProjectRecordFieldStatus
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export type NewProjectRecordVersion = Omit<ProjectRecordVersion, 'revision'>

/**
 * A bind reads the confirmed mapping's pinned parse selection; the client supplies no
 * file, options or media type, so it can never re-read a different layout than was confirmed.
 */
export interface BindRecordsRequest {
  readonly parseId: Uuid
  readonly mappingId: Uuid
  readonly mappingVersion: Semver
}

export interface ProjectRecordCounts {
  readonly total: number
  readonly confirmed: number
  readonly pending: number
  readonly conflict: number
}

export interface BindRecordsResult {
  readonly records: readonly ProjectRecordVersion[]
  readonly counts: ProjectRecordCounts
  readonly created: boolean
}

export interface ProjectRecordQuery {
  readonly objectId?: string
  readonly status?: ProjectRecordFieldStatus
  readonly limit?: number
  readonly cursor?: string
}

export interface ProjectRecordPage {
  readonly records: readonly ProjectRecordVersion[]
  readonly total: number
  readonly nextCursor?: string
}

export interface ProjectMappingWriteMeta {
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
}

export interface InsertMappingResult {
  readonly mapping: ImportMappingVersion
  readonly created: boolean
}

export interface AppendProjectRecordResult {
  readonly records: readonly ProjectRecordVersion[]
  readonly created: boolean
}

export class ProjectMappingStoreError extends Error {
  readonly code:
    | 'SCOPE_MISMATCH'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INVALID_MAPPING'
    | 'INVALID_RECORD'
    | 'MAPPING_NOT_FOUND'
    | 'RECORD_NOT_FOUND'

  constructor(
    code: ProjectMappingStoreError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProjectMappingStoreError'
    this.code = code
  }
}

/**
 * Control persistence for immutable import-mapping versions (SPEC v0.3a §4.1/§6.2). A mapping
 * is append-only: a changed correspondence or unit factor is a new `(mappingId, version)` row.
 * Both keys carry the tenant/space scope and the owning project, so one project's layout can
 * never overwrite another's.
 */
export interface ProjectMappingStore {
  insertMapping(
    scopeRef: ScopeRef,
    mapping: ImportMappingVersion,
    meta: ProjectMappingWriteMeta,
    ctx: ToolContext,
  ): Promise<InsertMappingResult>
  getMapping(
    scopeRef: ScopeRef,
    projectId: Uuid,
    mappingId: Uuid,
    version: Semver,
    ctx: ToolContext,
  ): Promise<ImportMappingVersion | undefined>
  listMappings(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ImportMappingVersion[]>
  latestVersion(
    scopeRef: ScopeRef,
    projectId: Uuid,
    mappingId: Uuid,
    ctx: ToolContext,
  ): Promise<Semver | undefined>
}

/**
 * Control persistence for immutable project-record versions (SPEC v0.3a §3.3/§4.1). A bind is
 * append-only: an unchanged content digest reuses the stored revision, a changed one appends
 * the next revision, so a correction never rewrites history.
 */
export interface ProjectRecordStore {
  appendRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    records: readonly NewProjectRecordVersion[],
    meta: ProjectMappingWriteMeta,
    ctx: ToolContext,
  ): Promise<AppendProjectRecordResult>
  listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    query: ProjectRecordQuery,
    ctx: ToolContext,
  ): Promise<ProjectRecordPage>
  getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRecordVersion | undefined>
}

function invalidMapping(message: string): ProjectMappingStoreError {
  return new ProjectMappingStoreError('INVALID_MAPPING', message)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isExactUnitConversion(value: unknown): value is ExactUnitConversion {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value['fromUnitCode']) &&
    isNonEmptyString(value['toUnitCode']) &&
    isNonEmptyString(value['numerator']) &&
    isNonEmptyString(value['denominator'])
  )
}

function isColumnMappingEntry(value: unknown): value is ColumnMappingEntry {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['fieldRef'])) return false
  if (typeof value['header'] !== 'string') return false
  if (!isSha256Digest(value['headerDigest'])) return false
  if (typeof value['columnIndex'] !== 'number' || !Number.isInteger(value['columnIndex']) || value['columnIndex'] < 0) {
    return false
  }
  if (value['pointer'] !== undefined && typeof value['pointer'] !== 'string') return false
  if (value['sourceUnitCode'] !== undefined && !isNonEmptyString(value['sourceUnitCode'])) return false
  if (value['canonicalUnitCode'] !== undefined && !isNonEmptyString(value['canonicalUnitCode'])) return false
  if (value['unitConversion'] !== undefined && !isExactUnitConversion(value['unitConversion'])) return false
  if (value['valueMapping'] !== undefined) {
    if (!Array.isArray(value['valueMapping'])) return false
    if (!value['valueMapping'].every((entry) => isRecord(entry) && typeof entry['from'] === 'string' && typeof entry['to'] === 'string')) {
      return false
    }
  }
  return true
}

/** Validate one import-mapping version before it is persisted. */
export function assertImportMappingVersionShape(
  value: unknown,
): asserts value is ImportMappingVersion {
  if (!isRecord(value)) throw invalidMapping('import mapping must be an object')
  if (value['schemaVersion'] !== IMPORT_MAPPING_SCHEMA_VERSION) {
    throw invalidMapping(`import mapping must declare schemaVersion ${IMPORT_MAPPING_SCHEMA_VERSION}`)
  }
  if (!isUuid(value['projectId'])) throw invalidMapping('projectId must be a uuid')
  if (!isUuid(value['mappingId'])) throw invalidMapping('mappingId must be a uuid')
  if (!isNonEmptyString(value['version'])) throw invalidMapping('version must be a non-empty semver string')
  if (!isVersionRef(value['definitionRef'])) throw invalidMapping('definitionRef is malformed')
  if (value['format'] !== 'text' && value['format'] !== 'json' && value['format'] !== 'csv' && value['format'] !== 'xlsx') {
    throw invalidMapping('format must be text/json/csv/xlsx')
  }
  if (!isUuid(value['parseId'])) throw invalidMapping('parseId must be a uuid')
  if (!isResourceRef(value['originalRef'])) throw invalidMapping('originalRef is malformed')
  if (!isNonEmptyString(value['originalMediaType'])) throw invalidMapping('originalMediaType must be a non-empty string')
  if (!isRecord(value['options'])) throw invalidMapping('options must be an object')
  if (!isNonEmptyString(value['objectId'])) throw invalidMapping('objectId must be a non-empty string')
  if (!Array.isArray(value['entries']) || value['entries'].length === 0) {
    throw invalidMapping('entries must be a non-empty array')
  }
  if (!value['entries'].every(isColumnMappingEntry)) throw invalidMapping('a mapping entry is malformed')
  if (!isSha256Digest(value['digest'])) throw invalidMapping('digest must be a sha256 digest')
  if (!isNonEmptyString(value['actor'])) throw invalidMapping('actor must be a non-empty string')
  if (!isNonEmptyString(value['recordedAt'])) throw invalidMapping('recordedAt must be a timestamp')
}

function isNormalizedFieldValue(value: unknown): value is NormalizedProjectFieldValue {
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

function isProjectRecordFieldValue(value: unknown): value is ProjectRecordFieldValue {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['fieldId'])) return false
  const raw = value['raw']
  if (raw !== null && typeof raw !== 'string' && typeof raw !== 'boolean') return false
  if (!isNormalizedFieldValue(value['normalized'])) return false
  if (value['status'] !== 'confirmed' && value['status'] !== 'pending' && value['status'] !== 'conflict') {
    return false
  }
  return isRecord(value['locator'])
}

/** Validate one project-record version before it is persisted. */
export function assertProjectRecordVersionShape(
  value: unknown,
): asserts value is ProjectRecordVersion {
  if (!isRecord(value)) throw new ProjectMappingStoreError('INVALID_RECORD', 'project record must be an object')
  if (value['schemaVersion'] !== PROJECT_RECORD_SCHEMA_VERSION) {
    throw new ProjectMappingStoreError('INVALID_RECORD', `project record must declare schemaVersion ${PROJECT_RECORD_SCHEMA_VERSION}`)
  }
  if (!isUuid(value['projectId'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'projectId must be a uuid')
  if (!isUuid(value['recordId'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'recordId must be a uuid')
  if (!isUuid(value['mappingId'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'mappingId must be a uuid')
  if (!isNonEmptyString(value['objectId'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'objectId must be a non-empty string')
  if (!isNonEmptyString(value['sourceRowKey'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'sourceRowKey must be a non-empty string')
  if (!isSha256Digest(value['sourceDigest'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'sourceDigest must be a sha256 digest')
  if (!isSha256Digest(value['contentDigest'])) throw new ProjectMappingStoreError('INVALID_RECORD', 'contentDigest must be a sha256 digest')
  if (!Array.isArray(value['fields']) || !value['fields'].every(isProjectRecordFieldValue)) {
    throw new ProjectMappingStoreError('INVALID_RECORD', 'fields must be a project-record field array')
  }
  if (value['status'] !== 'confirmed' && value['status'] !== 'pending' && value['status'] !== 'conflict') {
    throw new ProjectMappingStoreError('INVALID_RECORD', 'status is not a known project-record status')
  }
}
