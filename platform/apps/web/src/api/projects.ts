import type {
  CapabilityBlocker,
  ColumnMappingEntry,
  CompletenessStatus,
  ImportMappingVersion,
  MappingIssue,
  MappingPreview,
  ProjectReadinessKind,
  ProjectRecord,
  ProjectRecordFieldStatus,
  ProjectRecordVersion,
  ProjectRevision,
  ReadinessProjection,
  ResolvedProfileRef,
  ResourceRef,
  RevisionString,
  StructuredFormat,
  StructuredParseOptions,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

/**
 * The project / source / mapping / readiness view types the public business workspace reads
 * (SPEC v0.3a asset-data-ui §8/§9). They mirror the HTTP `data` envelope of the merged V03-016
 * ~ V03-019 project surface. Every shape is validated at runtime by a guard below, so the panel
 * never renders an unverified number, status or locator as if the server had sent it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRevisionString(value: unknown): value is RevisionString {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function isResourceRef(value: unknown): value is ResourceRef {
  return isRecord(value) && isString(value['id']) && typeof value['version'] === 'string' &&
    isSha256(value['digest']) && typeof value['kind'] === 'string'
}

export function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) && isString(value['id']) && typeof value['version'] === 'string' &&
    isSha256(value['digest'])
}

function isResolvedProfileRef(value: unknown): value is ResolvedProfileRef {
  return isRecord(value) && isString(value['id']) && isString(value['version']) &&
    isSha256(value['snapshotHash'])
}

export function isProjectRecord(value: unknown): value is ProjectRecord {
  return isRecord(value) &&
    isString(value['projectId']) &&
    isString(value['title']) &&
    isRevisionString(value['headRevision']) &&
    (value['state'] === 'draft' || value['state'] === 'active' || value['state'] === 'archived') &&
    typeof value['createdBy'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
}

function isProjectRevisionRef(value: unknown): boolean {
  return isRecord(value) && isString(value['projectId']) && isRevisionString(value['revision']) && isSha256(value['digest'])
}

export function isProjectRevision(value: unknown): value is ProjectRevision {
  return isRecord(value) &&
    isProjectRevisionRef(value['ref']) &&
    isVersionRef(value['industryPackRef']) &&
    isVersionRef(value['definitionRef']) &&
    Array.isArray(value['mappingRefs']) &&
    isResolvedProfileRef(value['profileRef']) &&
    isResourceRef(value['documentSetRef']) &&
    Array.isArray(value['semanticPublicationRefs']) &&
    isRevisionString(value['sourceVisibilityEpoch']) &&
    typeof value['changeReason'] === 'string'
}

const READINESS_STATES: readonly string[] = ['pending', 'building', 'ready', 'failed', 'revoked']
const COMPLETENESS: readonly string[] = ['complete', 'partial', 'truncated', 'unknown']
const READINESS_KINDS: readonly string[] = ['published_semantics', 'dataset', 'document_index']

export function isReadinessProjection(value: unknown): value is ReadinessProjection {
  if (!isRecord(value)) return false
  if (!isProjectRevisionRef(value['projectRevisionRef'])) return false
  if (!READINESS_KINDS.includes(value['kind'] as string)) return false
  if (!isResourceRef(value['targetRef']) && !isVersionRef(value['targetRef'])) return false
  if (!READINESS_STATES.includes(value['state'] as string)) return false
  if (!COMPLETENESS.includes(value['completeness'] as string)) return false
  if (typeof value['expectedCount'] !== 'number' || typeof value['processedCount'] !== 'number' ||
    typeof value['failedCount'] !== 'number') return false
  if (!isSha256(value['targetDigest'])) return false
  if (!isRevisionString(value['fenceRevision'])) return false
  return true
}

export interface ProjectRevisionView {
  readonly revision: ProjectRevision
  readonly readiness: readonly ReadinessProjection[]
  readonly historical: boolean
}

export function isProjectRevisionView(value: unknown): value is ProjectRevisionView {
  return isRecord(value) && isProjectRevision(value['revision']) &&
    Array.isArray(value['readiness']) && value['readiness'].every(isReadinessProjection) &&
    typeof value['historical'] === 'boolean'
}

export interface ProjectReadinessView {
  readonly projectRevisionRef: ProjectRevision['ref']
  readonly projections: readonly ReadinessProjection[]
  readonly requiredReadiness: readonly ProjectReadinessKind[]
  readonly ready: boolean
  readonly blockers: readonly CapabilityBlocker[]
}

export function isProjectReadinessView(value: unknown): value is ProjectReadinessView {
  return isRecord(value) &&
    isProjectRevisionRef(value['projectRevisionRef']) &&
    Array.isArray(value['projections']) && value['projections'].every(isReadinessProjection) &&
    Array.isArray(value['requiredReadiness']) &&
    typeof value['ready'] === 'boolean' &&
    Array.isArray(value['blockers'])
}

export interface ProjectEvolutionView {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  readonly previousRevision: ProjectRevision
  readonly changes: readonly string[]
  readonly readinessInvalidated: readonly ProjectReadinessKind[]
  readonly created: boolean
}

export function isProjectEvolutionView(value: unknown): value is ProjectEvolutionView {
  return isRecord(value) && isProjectRecord(value['project']) && isProjectRevision(value['revision']) &&
    isProjectRevision(value['previousRevision']) && Array.isArray(value['changes']) &&
    Array.isArray(value['readinessInvalidated']) && typeof value['created'] === 'boolean'
}

function isProjectRecordFieldValue(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isString(value['fieldId'])) return false
  const raw = value['raw']
  if (raw !== null && typeof raw !== 'string' && typeof raw !== 'boolean') return false
  const normalized = value['normalized']
  if (!isRecord(normalized)) return false
  if (normalized['kind'] === 'scalar') {
    const scalar = normalized['value']
    return scalar === null || typeof scalar === 'string' || typeof scalar === 'boolean'
  }
  if (normalized['kind'] === 'quantity') {
    return isString(normalized['value']) && isString(normalized['unitCode'])
  }
  return false
}

export function isProjectRecordVersion(value: unknown): value is ProjectRecordVersion {
  return isRecord(value) &&
    value['schemaVersion'] === 'project-record@1' &&
    isString(value['projectId']) && isString(value['recordId']) && isRevisionString(value['revision']) &&
    isString(value['mappingId']) && typeof value['mappingVersion'] === 'string' &&
    isString(value['objectId']) && isString(value['sourceRowKey']) &&
    isSha256(value['sourceDigest']) && isSha256(value['contentDigest']) &&
    Array.isArray(value['fields']) && value['fields'].every(isProjectRecordFieldValue) &&
    (value['status'] === 'confirmed' || value['status'] === 'pending' || value['status'] === 'conflict') &&
    typeof value['actor'] === 'string' && typeof value['recordedAt'] === 'string'
}

export interface ProjectRecordPageView {
  readonly records: readonly ProjectRecordVersion[]
  readonly total: number
  readonly nextCursor?: string
}

export function isProjectRecordPageView(value: unknown): value is ProjectRecordPageView {
  return isRecord(value) && Array.isArray(value['records']) && value['records'].every(isProjectRecordVersion) &&
    typeof value['total'] === 'number' &&
    (value['nextCursor'] === undefined || value['nextCursor'] === null || typeof value['nextCursor'] === 'string')
}

export interface ProjectDatasetStatusView {
  readonly projectId: Uuid
  readonly projectRevisionRef: ProjectRevision['ref']
  readonly objectId: string
  readonly state: 'pending' | 'building' | 'ready' | 'failed' | 'revoked'
  readonly snapshotRef?: ResourceRef
  readonly completeness: CompletenessStatus
  readonly reason?: string
  readonly retryable: boolean
  readonly expectedCount?: number
  readonly processedCount?: number
}

export function isProjectDatasetStatus(value: unknown): value is ProjectDatasetStatusView {
  return isRecord(value) &&
    isString(value['projectId']) &&
    isProjectRevisionRef(value['projectRevisionRef']) &&
    typeof value['objectId'] === 'string' &&
    READINESS_STATES.includes(value['state'] as string) &&
    (value['snapshotRef'] === undefined || isResourceRef(value['snapshotRef'])) &&
    COMPLETENESS.includes(value['completeness'] as string) &&
    typeof value['retryable'] === 'boolean'
}

export type ProjectDocumentIndexState = 'pending' | 'building' | 'ready' | 'stale' | 'failed'

export interface ProjectDocumentIndexStatusView {
  readonly projectId: Uuid
  readonly collectionRef: string
  readonly state: ProjectDocumentIndexState
  readonly visibilityEpoch: RevisionString
  readonly membershipRevision: RevisionString
  readonly indexEpoch?: RevisionString
  readonly generation?: RevisionString
  readonly documentCount: number
  readonly sourceDocumentCount: number
  readonly completeness: CompletenessStatus
  readonly reason?: string
  readonly retryable: boolean
}

const DOCUMENT_INDEX_STATES: readonly string[] = ['pending', 'building', 'ready', 'stale', 'failed']

export function isProjectDocumentIndexStatus(value: unknown): value is ProjectDocumentIndexStatusView {
  return isRecord(value) &&
    isString(value['projectId']) && isString(value['collectionRef']) &&
    DOCUMENT_INDEX_STATES.includes(value['state'] as string) &&
    isRevisionString(value['visibilityEpoch']) && isRevisionString(value['membershipRevision']) &&
    typeof value['documentCount'] === 'number' && typeof value['sourceDocumentCount'] === 'number' &&
    COMPLETENESS.includes(value['completeness'] as string) &&
    typeof value['retryable'] === 'boolean'
}

export interface IndustryPackSummary {
  readonly kind: string
  readonly namespace: string
  readonly displayName: string
  readonly packRef?: VersionRef
  readonly maturity: string
  readonly maturityLabel: string
  readonly usable: boolean
}

export function isIndustryPackSummary(value: unknown): value is IndustryPackSummary {
  return isRecord(value) && typeof value['kind'] === 'string' && isString(value['namespace']) &&
    typeof value['maturity'] === 'string' && typeof value['maturityLabel'] === 'string' &&
    typeof value['usable'] === 'boolean' &&
    (value['packRef'] === undefined || isVersionRef(value['packRef']))
}

export function isImportMappingVersion(value: unknown): value is ImportMappingVersion {
  return isRecord(value) &&
    value['schemaVersion'] === 'import-mapping@1' &&
    isString(value['projectId']) && isString(value['mappingId']) && isString(value['version']) &&
    isRecord(value['ref']) && isVersionRef(value['definitionRef']) &&
    typeof value['format'] === 'string' && isString(value['parseId']) &&
    isResourceRef(value['originalRef']) && isString(value['originalMediaType']) &&
    isRecord(value['options']) && isString(value['objectId']) &&
    Array.isArray(value['entries']) &&
    isSha256(value['digest'])
}

function isMappingIssue(value: unknown): value is MappingIssue {
  return isRecord(value) && isString(value['code']) &&
    (value['severity'] === 'error' || value['severity'] === 'warning') &&
    typeof value['message'] === 'string'
}

export function isMappingPreview(value: unknown): value is MappingPreview {
  return isRecord(value) &&
    isString(value['projectId']) && isVersionRef(value['definitionRef']) &&
    isString(value['objectId']) && typeof value['format'] === 'string' &&
    isString(value['parseId']) && Array.isArray(value['columns']) &&
    Array.isArray(value['unmappedColumns']) && Array.isArray(value['issues']) &&
    value['issues'].every(isMappingIssue) && typeof value['rowCount'] === 'number' &&
    typeof value['confirmable'] === 'boolean'
}

export function isMappingIssueArray(value: unknown): value is readonly MappingIssue[] {
  return Array.isArray(value) && value.every(isMappingIssue)
}

export interface CreateProjectRequest {
  readonly title: string
  readonly industryPackRef: VersionRef
  readonly profileRef: ResolvedProfileRef
  readonly mappingRefs: readonly import('@ontology/contracts').MappingRef[]
  readonly documentSetRef: ResourceRef
}

export interface MountProjectPackRequest {
  readonly expectedRevision: RevisionString
  readonly industryPackRef: VersionRef
  readonly reason: string
  readonly profileRef?: ResolvedProfileRef
  readonly mappingRefs?: readonly import('@ontology/contracts').MappingRef[]
  readonly documentSetRef?: ResourceRef
}

export interface ColumnMappingRequestView {
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
  readonly mappingId?: Uuid
}

export type { ProjectRecordFieldStatus }
