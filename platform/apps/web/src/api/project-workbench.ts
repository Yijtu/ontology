import { isStructuredParseSelection } from '@ontology/contracts'
import type {
  ParseCoverage,
  ProfileRef,
  ProjectRecord,
  ProjectRevision,
  ProjectReadinessKind,
  ResourceRef,
  Sha256Digest,
  SourceLocator,
  StructuredFormat,
  StructuredParseOptions,
  StructuredParseStatus,
  StructuredRecordCounts,
  TaskKind,
  VersionRef,
} from '@ontology/contracts'
import type { WorkbenchClient } from './client'
import { ApiError } from './errors'
import { isProjectRecord, isProjectRevision, isResourceRef, isVersionRef } from './projects'
import { isSourceLocator } from './source-views'
import { isProjectEvolutionRecord } from './project-evolution'
import type { ProjectEvolutionRecord } from '@ontology/contracts'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const digest = (value: unknown): value is Sha256Digest =>
  typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const index = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const enumValue = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value)
function invalid(path: string): never {
  throw new ApiError(502, {
    code: 'MALFORMED_RESPONSE',
    message: '服务端返回的项目数据格式无法识别。',
    retryable: false,
    reasons: [path],
    missingCapabilities: [],
  })
}

export interface ProjectBootstrapView {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  readonly created: boolean
  readonly scopeRef: { readonly tenantId: string; readonly spaceId: string }
}
export interface NativeSourceTable {
  readonly tableId: string
  readonly name?: string
  readonly sheetName?: string
  readonly sheetId?: string
  readonly headerRow: number
  readonly columns: readonly {
    readonly columnIndex: number
    readonly header: string
    readonly headerDigest: Sha256Digest
  }[]
  readonly rows: readonly {
    readonly sourceRowKey: string
    readonly cells: readonly {
      readonly columnIndex: number
      readonly raw: string | boolean | null
      readonly locator: SourceLocator
    }[]
  }[]
}
export interface ProjectNativeSource {
  readonly documentId: string
  readonly originalRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly parseId: string
  readonly precision: 'exact' | 'approximate'
  readonly name?: string
  readonly kind: string
  readonly mediaType?: string
  readonly originalMediaType?: string
  readonly format?: string
  readonly options?: Omit<StructuredParseOptions, 'mediaType'>
  readonly tables?: readonly NativeSourceTable[]
  readonly coverage?: ParseCoverage
  readonly previewCoverage?: 'complete' | 'partial'
}
export interface ProjectCanonicalObject {
  readonly objectId: string
  readonly displayName: string
  readonly entities?: readonly { readonly entityId: string; readonly displayName: string }[]
  readonly attributes: readonly {
    readonly attributeId: string
    readonly displayName: string
    readonly valueType: string
    readonly unit?: string
    readonly required: boolean
    readonly minCardinality?: number
    readonly maxCardinality?: number | 'unbounded'
    readonly enumValues?: readonly string[]
    readonly referencesObjectId?: string
  }[]
}
export interface ProjectSourceCatalogue {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  readonly sources: readonly ProjectNativeSource[]
  readonly objects: readonly ProjectCanonicalObject[]
  readonly activeEvolution?: ProjectEvolutionRecord
}
export interface ProjectTaskItem {
  readonly bindingRef: VersionRef
  readonly taskKind: TaskKind
  readonly displayName: string
  readonly parameterSchema: Readonly<Record<string, unknown>>
  readonly requiredCapabilities: readonly string[]
  readonly requiredReadiness: readonly ProjectReadinessKind[]
  readonly available: boolean
  readonly unavailableReasons: readonly string[]
  readonly requiresInputSelection?: boolean
  readonly inputRequirements?: {
    readonly maxDecimalPlaces: number
    readonly units: readonly string[]
    readonly currencies: readonly string[]
    readonly minimumAmount: string
    readonly description: string
    readonly maxRows: number
  }
  readonly objects?: readonly TaskObjectChoice[]
  readonly rules?: readonly {
    readonly ruleId: string
    readonly displayName: string
    readonly objectId: string
  }[]
  readonly relations?: readonly {
    readonly relationId: string
    readonly displayName: string
    readonly fromObjectId: string
    readonly toObjectId: string
  }[]
}
export interface TaskObjectChoice {
  readonly objectId: string
  readonly displayName: string
  readonly entities?: readonly { readonly entityId: string; readonly displayName: string }[]
  readonly attributes?: ProjectCanonicalObject['attributes']
}
export interface ProjectTaskCatalogue {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  readonly tasks: readonly ProjectTaskItem[]
}

function isTable(value: unknown): value is NativeSourceTable {
  return (
    record(value) &&
    text(value['tableId']) &&
    index(value['headerRow']) &&
    value['headerRow'] > 0 &&
    ['name', 'sheetName', 'sheetId'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    Array.isArray(value['columns']) &&
    value['columns'].every(
      (column: unknown) =>
        record(column) &&
        index(column['columnIndex']) &&
        typeof column['header'] === 'string' &&
        digest(column['headerDigest']),
    ) &&
    Array.isArray(value['rows']) &&
    value['rows'].every(
      (row: unknown) =>
        record(row) &&
        text(row['sourceRowKey']) &&
        Array.isArray(row['cells']) &&
        row['cells'].every(
          (cell: unknown) =>
            record(cell) &&
            index(cell['columnIndex']) &&
            isSourceLocator(cell['locator']) &&
            (cell['raw'] === null || typeof cell['raw'] === 'string' || typeof cell['raw'] === 'boolean'),
        ),
    )
  )
}
function isNativeSource(value: unknown): value is ProjectNativeSource {
  return (
    record(value) &&
    text(value['documentId']) &&
    isResourceRef(value['originalRef']) &&
    isResourceRef(value['parseRef']) &&
    text(value['parseId']) &&
    text(value['kind']) &&
    enumValue(value['precision'], ['exact', 'approximate']) &&
    ['name', 'mediaType', 'originalMediaType', 'format'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value['tables'] === undefined || (Array.isArray(value['tables']) && value['tables'].every(isTable))) &&
    (value['options'] === undefined || isStructuredParseSelection(value['options'])) &&
    (value['coverage'] === undefined || isCoverage(value['coverage'])) &&
    (value['previewCoverage'] === undefined ||
      value['previewCoverage'] === 'complete' ||
      value['previewCoverage'] === 'partial')
  )
}
function isCoverage(value: unknown): value is ParseCoverage {
  return (
    record(value) &&
    enumValue(value['status'], ['complete', 'partial', 'failed']) &&
    enumValue(value['completeness'], ['complete', 'partial', 'truncated', 'unknown']) &&
    ['totalUnits', 'parsedUnits', 'skippedUnits'].every((key) => index(value[key])) &&
    strings(value['skippedReasons']) &&
    strings(value['notes'])
  )
}
function isCounts(value: unknown): value is StructuredRecordCounts {
  return (
    record(value) &&
    index(value['total']) &&
    index(value['succeeded']) &&
    index(value['pending']) &&
    index(value['failed']) &&
    index(value['skipped']) &&
    value['total'] === value['succeeded'] + value['pending'] + value['failed'] + value['skipped']
  )
}
function isObject(value: unknown): value is ProjectCanonicalObject {
  return (
    record(value) &&
    text(value['objectId']) &&
    text(value['displayName']) &&
    (value['entities'] === undefined ||
      (Array.isArray(value['entities']) &&
        value['entities'].every(
          (entity: unknown) =>
            record(entity) &&
            text(entity['entityId']) &&
            text(entity['displayName']),
        ))) &&
    Array.isArray(value['attributes']) &&
    value['attributes'].every(
      (field: unknown) =>
        record(field) &&
        text(field['attributeId']) &&
        text(field['displayName']) &&
        text(field['valueType']) &&
        typeof field['required'] === 'boolean' &&
        (field['minCardinality'] === undefined || index(field['minCardinality'])) &&
        (field['maxCardinality'] === undefined || field['maxCardinality'] === 'unbounded' || index(field['maxCardinality'])) &&
        (field['minCardinality'] === undefined || field['maxCardinality'] === undefined || field['maxCardinality'] === 'unbounded' || field['minCardinality'] <= field['maxCardinality']) &&
        (field['unit'] === undefined || typeof field['unit'] === 'string') &&
        (field['enumValues'] === undefined || strings(field['enumValues'])) &&
        (field['referencesObjectId'] === undefined || text(field['referencesObjectId'])),
    )
  )
}
export function isProjectSourceCatalogue(value: unknown): value is ProjectSourceCatalogue {
  return (
    record(value) &&
    isProjectRecord(value['project']) &&
    isProjectRevision(value['revision']) &&
    value['revision'].ref.projectId === value['project'].projectId &&
    Array.isArray(value['sources']) &&
    value['sources'].every(isNativeSource) &&
    Array.isArray(value['objects']) &&
    value['objects'].every(isObject) &&
    (value['activeEvolution'] === undefined ||
      (isProjectEvolutionRecord(value['activeEvolution']) &&
        value['activeEvolution'].plan.targetRevisionRef.projectId === value['project'].projectId))
  )
}
function isTask(value: unknown): value is ProjectTaskItem {
  return (
    record(value) &&
    isVersionRef(value['bindingRef']) &&
    enumValue(value['taskKind'], ['published_facts', 'structured_query', 'rule_judgement', 'relations', 'document_qa', 'compute']) &&
    text(value['displayName']) &&
    record(value['parameterSchema']) &&
    strings(value['requiredCapabilities']) &&
    Array.isArray(value['requiredReadiness']) &&
    value['requiredReadiness'].every((kind: unknown) =>
      enumValue(kind, ['published_semantics', 'dataset', 'document_index']),
    ) &&
    typeof value['available'] === 'boolean' &&
    strings(value['unavailableReasons']) &&
    (value['requiresInputSelection'] === undefined || typeof value['requiresInputSelection'] === 'boolean' && value['taskKind'] === 'compute') &&
    (value['inputRequirements'] === undefined || isInputRequirements(value['inputRequirements']) && value['taskKind'] === 'compute' && value['requiresInputSelection'] === true) &&
    (value['objects'] === undefined ||
      (Array.isArray(value['objects']) &&
        value['objects'].every(
          (object: unknown) =>
            record(object) &&
            text(object['objectId']) &&
            text(object['displayName']) &&
            (object['attributes'] === undefined || isObject(object)) &&
            (object['entities'] === undefined ||
              (Array.isArray(object['entities']) &&
                object['entities'].every(
                  (entity: unknown) =>
                    record(entity) && text(entity['entityId']) && text(entity['displayName']),
                ))),
        ))) &&
    (value['rules'] === undefined ||
      (Array.isArray(value['rules']) &&
        value['rules'].every(
          (rule: unknown) =>
            record(rule) && text(rule['ruleId']) && text(rule['displayName']) && text(rule['objectId']),
        ))) &&
    (value['relations'] === undefined ||
      (Array.isArray(value['relations']) &&
        value['relations'].every(
          (relation: unknown) =>
            record(relation) &&
            text(relation['relationId']) &&
            text(relation['displayName']) &&
            text(relation['fromObjectId']) &&
            text(relation['toObjectId']),
        )))
  )
}
function isInputRequirements(value: unknown): value is NonNullable<ProjectTaskItem['inputRequirements']> {
  return record(value) && index(value['maxDecimalPlaces']) && value['maxDecimalPlaces'] <= 100 &&
    strings(value['units']) && strings(value['currencies']) && text(value['minimumAmount']) &&
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value['minimumAmount']) && text(value['description']) && index(value['maxRows']) && value['maxRows'] > 0
}
export function isProjectTaskCatalogue(value: unknown): value is ProjectTaskCatalogue {
  return (
    record(value) &&
    isProjectRecord(value['project']) &&
    isProjectRevision(value['revision']) &&
    value['revision'].ref.projectId === value['project'].projectId &&
    Array.isArray(value['tasks']) &&
    value['tasks'].every(isTask)
  )
}

export async function bootstrapProject(
  client: WorkbenchClient,
  body: { readonly title: string; readonly profileRef: ProfileRef },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ProjectBootstrapView> {
  const path = '/api/v1/core/project-bootstrap'
  const value = await client.requestJson<unknown>('POST', path, {
    body,
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  if (
    !record(value) ||
    !isProjectRecord(value['project']) ||
    !isProjectRevision(value['revision']) ||
    value['revision'].ref.projectId !== value['project'].projectId ||
    typeof value['created'] !== 'boolean' ||
    !record(value['scopeRef']) ||
    !text(value['scopeRef']['tenantId']) ||
    !text(value['scopeRef']['spaceId'])
  )
    invalid(path)
  return {
    project: value['project'],
    revision: value['revision'],
    created: value['created'],
    scopeRef: { tenantId: value['scopeRef']['tenantId'], spaceId: value['scopeRef']['spaceId'] },
  }
}
export async function readProjectSources(
  client: WorkbenchClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectSourceCatalogue> {
  const path = `/api/v1/core/projects/${encodeURIComponent(projectId)}/source-catalogue`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  if (!isProjectSourceCatalogue(value) || value.project.projectId !== projectId) invalid(path)
  return value
}
export async function readProjectTasks(
  client: WorkbenchClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectTaskCatalogue> {
  const path = `/api/v1/core/projects/${encodeURIComponent(projectId)}/task-catalogue`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  if (!isProjectTaskCatalogue(value) || value.project.projectId !== projectId) invalid(path)
  return value
}

/** A source view is a fixed-answer projection; it is never a generic artifact text viewer. */
export interface AnswerSourceCell {
  readonly raw: string | boolean | null
  readonly locator: SourceLocator
  readonly columnLabel?: string
  readonly rowLabel?: string
}

export interface StructuredProjectImportView {
  readonly parseId: string
  readonly originalRef: ResourceRef
  readonly originalMediaType: string
  readonly format: StructuredFormat
  readonly status: StructuredParseStatus
  readonly counts: StructuredRecordCounts
  readonly coverage: ParseCoverage
  readonly reused: boolean
  readonly documentId?: string
  readonly documentSetRef?: ResourceRef
  readonly documentIndexState?: string
}
export async function importProjectFile(
  client: WorkbenchClient,
  projectId: string,
  body: {
    readonly format: StructuredFormat
    readonly mediaType: string
    readonly contentEncoding: 'base64'
    readonly content: string
    readonly options: { readonly headerRow?: number; readonly sheetName?: string }
  },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<StructuredProjectImportView> {
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/structured-imports`
  const value = await client.requestJson<unknown>('POST', path, {
    body,
    idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
  })
  if (
    !record(value) ||
    !text(value['parseId']) ||
    !isResourceRef(value['originalRef']) ||
    !text(value['originalMediaType']) ||
    value['format'] !== body.format ||
    !['complete', 'incomplete', 'rejected'].includes(String(value['status'])) ||
    !isCounts(value['counts']) ||
    !isCoverage(value['coverage']) ||
    typeof value['reused'] !== 'boolean' ||
    (value['documentId'] !== undefined && !text(value['documentId'])) ||
    (value['documentSetRef'] !== undefined && !isResourceRef(value['documentSetRef'])) ||
    (value['documentIndexState'] !== undefined && !text(value['documentIndexState']))
  )
    invalid(path)
  const counts = value['counts']
  if (
    !index(counts['total']) ||
    !index(counts['succeeded']) ||
    !index(counts['pending']) ||
    !index(counts['failed']) ||
    !index(counts['skipped']) ||
    counts['total'] !== counts['succeeded'] + counts['pending'] + counts['failed'] + counts['skipped']
  )
    invalid(path)
  return {
    parseId: value['parseId'],
    originalRef: value['originalRef'],
    originalMediaType: value['originalMediaType'],
    format: body.format,
    status:
      value['status'] === 'complete'
        ? 'complete'
        : value['status'] === 'incomplete'
          ? 'incomplete'
          : 'rejected',
    counts: {
      total: counts['total'],
      succeeded: counts['succeeded'],
      pending: counts['pending'],
      failed: counts['failed'],
      skipped: counts['skipped'],
    },
    coverage: value['coverage'],
    reused: value['reused'],
    ...(typeof value['documentId'] === 'string' ? { documentId: value['documentId'] } : {}),
    ...(isResourceRef(value['documentSetRef']) ? { documentSetRef: value['documentSetRef'] } : {}),
    ...(typeof value['documentIndexState'] === 'string'
      ? { documentIndexState: value['documentIndexState'] }
      : {}),
  }
}
