import type {
  DataMode,
  InstanceRecordView,
  ProvenanceEvidenceView,
  PublishedAnswer,
  ResourceRef,
  SourceLocator,
  SourceReReadability,
  VersionRef,
} from '@ontology/contracts'
import type { WorkbenchClient } from './client'
import { ApiError } from './errors'
import { isResourceRef, isVersionRef } from './projects'
import { isRevisionString, isUuid } from '@ontology/contracts'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
const enumValue = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value)
const mode = (value: unknown): value is DataMode =>
  enumValue(value, ['synthetic', 'observed', 'forecast', 'simulation', 'live'])
const readable = (value: unknown): value is SourceReReadability =>
  enumValue(value, ['re_readable', 'archived_snapshot_only', 'unverifiable'])
const sha = (value: unknown) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
const axis = (value: unknown) =>
  record(value) && typeof value['complete'] === 'boolean' && optionalString(value['reason'])

export function isSourceLocator(value: unknown): value is SourceLocator {
  if (!record(value)) return false
  if (value['kind'] === 'offset')
    return (
      integer(value['startOffset']) &&
      integer(value['endOffset']) &&
      value['endOffset'] >= value['startOffset'] &&
      optionalString(value['normalizationMapRef'])
    )
  if (value['kind'] === 'page' || value['kind'] === 'approximate_locator')
    return (
      ((value['kind'] === 'approximate_locator' && value['page'] === undefined) ||
        integer(value['page'], 1)) &&
      (value['startOffset'] === undefined || integer(value['startOffset'])) &&
      (value['endOffset'] === undefined || integer(value['endOffset'])) &&
      optionalString(value['normalizationMapRef'])
    )
  if (value['kind'] === 'json_pointer')
    return (
      typeof value['pointer'] === 'string' &&
      integer(value['startByte']) &&
      integer(value['endByte']) &&
      value['endByte'] >= value['startByte'] &&
      text(value['normalizationMapRef'])
    )
  if (value['kind'] !== 'table_cell' && value['kind'] !== 'table_row') return false
  if (
    !enumValue(value['format'], ['csv', 'xlsx']) ||
    !integer(value['recordIndex'], 1) ||
    !integer(value['row'], 1) ||
    !text(value['normalizationMapRef']) ||
    !optionalString(value['sheetId']) ||
    !optionalString(value['sheetName'])
  )
    return false
  if (value['kind'] === 'table_row')
    return (
      integer(value['columnFrom'], 1) &&
      integer(value['columnTo'], 1) &&
      value['columnTo'] >= value['columnFrom']
    )
  return (
    integer(value['column'], 1) &&
    optionalString(value['address']) &&
    (value['startByte'] === undefined || integer(value['startByte'])) &&
    (value['endByte'] === undefined || integer(value['endByte'])) &&
    (value['startByte'] === undefined ||
      value['endByte'] === undefined ||
      value['endByte'] >= value['startByte'])
  )
}
export function sameSourceLocator(left: SourceLocator, right: SourceLocator): boolean {
  const ordered = (value: SourceLocator) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    )
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right))
}

/** Validate the provenance fields used by the UI; unknown model/audit extensions are ignored. */
export function isProvenanceView(value: unknown): value is ProvenanceEvidenceView {
  if (
    !record(value) ||
    !text(value['evidenceId']) ||
    !enumValue(value['outcome'], ['verifiable', 'unverifiable']) ||
    !enumValue(value['kind'], [
      'observation',
      'document_span',
      'computation',
      'rule_derivation',
      'identity_decision',
      'model_output',
      'web_page',
    ]) ||
    !mode(value['dataMode']) ||
    !record(value['scopeRef']) ||
    !text(value['scopeRef']['tenantId']) ||
    !text(value['scopeRef']['spaceId']) ||
    !record(value['producedBy']) ||
    !isVersionRef(value['producedBy']['componentRef']) ||
    !optionalString(value['producedBy']['runId']) ||
    !text(value['observedAt']) ||
    !text(value['recordedAt']) ||
    !text(value['revision']) ||
    !sha(value['resultDigest']) ||
    typeof value['integrityVerified'] !== 'boolean' ||
    !optionalString(value['reason']) ||
    !optionalString(value['asOf']) ||
    !optionalString(value['validAt'])
  )
    return false
  if (
    !Array.isArray(value['ruleRefs']) ||
    !value['ruleRefs'].every(isVersionRef) ||
    !Array.isArray(value['premiseGroups']) ||
    !value['premiseGroups'].every(
      (group: unknown) =>
        record(group) &&
        text(group['groupId']) &&
        Array.isArray(group['alternativeEvidenceIds']) &&
        group['alternativeEvidenceIds'].every(text),
    )
  )
    return false
  if (
    value['supportResolution'] !== undefined &&
    (!axis(value['supportResolution']) ||
      !record(value['supportResolution']) ||
      !enumValue(value['supportResolution']['state'], [
        'not_rule',
        'resolved',
        'not_applicable',
        'unknown',
        'conflict',
        'ambiguous',
        'unavailable',
        'incomplete',
      ]))
  )
    return false
  if (value['factSupport'] !== undefined && !axis(value['factSupport'])) return false
  const specification = value['specification']
  if (
    specification !== undefined &&
    (!record(specification) ||
      !axis(specification['coverage']) ||
      !Array.isArray(specification['spans']) ||
      !specification['spans'].every(
        (span: unknown) =>
          record(span) &&
          text(span['parseId']) &&
          text(span['chunkId']) &&
          isSourceLocator(span['locator']) &&
          enumValue(span['spanKind'], ['verbatim', 'normalized', 'approximate']) &&
          enumValue(span['precision'], ['exact', 'approximate']) &&
          sha(span['quoteDigest']) &&
          isResourceRef(span['documentRef']) &&
          isResourceRef(span['documentVersionRef']) &&
          text(span['parserVersion']) &&
          isResourceRef(span['evidenceRef']),
      ))
  )
    return false
  if (
    !Array.isArray(value['sources']) ||
    !value['sources'].every(
      (source: unknown) =>
        record(source) &&
        record(source['sourceRef']) &&
        text(source['sourceRef']['namespace']) &&
        text(source['sourceRef']['sourceId']) &&
        text(source['schemaVersion']) &&
        text(source['readAt']) &&
        sha(source['resultDigest']) &&
        enumValue(source['consistency'], ['immutable', 'repeatable_read', 'read_time', 'unknown']) &&
        readable(source['reReadability']) &&
        optionalString(source['reason']),
    )
  )
    return false
  if (
    typeof value['originalSourceReReadable'] !== 'boolean' ||
    !Array.isArray(value['dependencies']) ||
    !value['dependencies'].every(
      (edge: unknown) =>
        record(edge) &&
        text(edge['fromEvidenceId']) &&
        text(edge['toEvidenceId']) &&
        enumValue(edge['relation'], ['supports', 'contradicts', 'derives_from', 'corrects', 'retracts', 'same_source']) &&
        enumValue(edge['origin'], ['support', 'lineage']) &&
        optionalString(edge['premiseGroup']),
    )
  )
    return false
  return (
    value['archivedResult'] === undefined ||
    (record(value['archivedResult']) &&
      isResourceRef(value['archivedResult']['ref']) &&
      typeof value['archivedResult']['verified'] === 'boolean')
  )
}

export interface SourceCellView {
  readonly raw: string | boolean | null
  readonly locator: SourceLocator
  readonly columnLabel?: string
  readonly rowLabel?: string
}
export interface AnswerSourceFragment {
  readonly precision: 'exact' | 'approximate'
  readonly originalRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly locator: SourceLocator
  readonly text?: string
  readonly cells?: readonly SourceCellView[]
}
const isCells = (value: unknown): value is readonly SourceCellView[] =>
  Array.isArray(value) && value.length <= 128 && value.every((cell: unknown) => record(cell) &&
    (cell['raw'] === null || typeof cell['raw'] === 'string' || typeof cell['raw'] === 'boolean') &&
    isSourceLocator(cell['locator']) && optionalString(cell['columnLabel']) && optionalString(cell['rowLabel']))
const sameRef = (left: ResourceRef | undefined, right: ResourceRef | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
function isFragment(value: unknown): value is AnswerSourceFragment {
  return record(value) && enumValue(value['precision'], ['exact', 'approximate']) && isResourceRef(value['originalRef']) &&
    isResourceRef(value['parseRef']) && isSourceLocator(value['locator']) && optionalString(value['text']) &&
    (value['cells'] === undefined || isCells(value['cells'])) &&
    (value['precision'] === 'approximate' ? Array.isArray(value['cells']) && value['cells'].length > 0 : typeof value['text'] === 'string' || Array.isArray(value['cells']) && value['cells'].length > 0)
}
export interface AnswerSourceView {
  readonly answerId: string
  readonly evidenceId: string
  readonly answerRef: VersionRef
  readonly evidenceRef: ResourceRef
  readonly family: 'document_span' | 'structured_qa' | 'rule_support' | 'data_query'
  readonly precision: 'exact' | 'approximate'
  readonly readability: SourceReReadability
  readonly title: string
  readonly text?: string
  readonly cells?: readonly SourceCellView[]
  readonly fragments?: readonly AnswerSourceFragment[]
  readonly originalRef?: ResourceRef
  readonly parseRef?: ResourceRef
  readonly locator?: SourceLocator
  readonly support?: ProvenanceEvidenceView
  readonly sourceReadLimitation?: string
  readonly archivedPayload?: Readonly<Record<string, unknown>>
  readonly fixedInputRef?: ResourceRef
  readonly fixedDatasetSnapshotRef?: ResourceRef
  readonly sourceCoverage?: SourceReadCoverage
  readonly selectedCell?: SavedCellSelector
  readonly inputArtifacts?: readonly SavedInputArtifactView[]
  readonly dataMode: DataMode
}
export interface SavedCellSelector { readonly tableId: string; readonly rowKey: string; readonly columnRef: string }
export interface SourceReadCoverage {
  readonly mode: 'saved_cell' | 'query_result_sample' | 'compute_input_sample' | 'compute_input_artifacts' | 'unsupported'
  readonly requested: number; readonly verified: number; readonly displayed: number
  readonly knownTotal: number | null; readonly truncated: boolean
  readonly coverage: 'complete' | 'partial' | 'unsupported'
  readonly maxRows: 10; readonly maxFragments: 10
}
export interface SavedInputArtifactView {
  readonly ref: ResourceRef; readonly inputRefPointers: readonly string[]
  readonly byteSize: number; readonly text?: string; readonly textTruncated: boolean
}
function isSelectedCell(value: unknown): value is SavedCellSelector {
  return record(value) && Object.keys(value).length === 3 && ['tableId', 'rowKey', 'columnRef'].every((key) => text(value[key]) && value[key].length <= 1_024)
}
function isSourceCoverage(value: unknown): value is SourceReadCoverage {
  if (!record(value) || !enumValue(value['mode'], ['saved_cell', 'query_result_sample', 'compute_input_sample', 'compute_input_artifacts', 'unsupported']) || !enumValue(value['coverage'], ['complete', 'partial', 'unsupported']) || value['maxRows'] !== 10 || value['maxFragments'] !== 10 || typeof value['truncated'] !== 'boolean' || !integer(value['requested']) || value['requested'] > 10 || !integer(value['verified']) || value['verified'] > value['requested'] || !integer(value['displayed']) || value['displayed'] > value['verified']) return false
  if (value['mode'] === 'unsupported') return value['knownTotal'] === null && value['verified'] === 0 && value['displayed'] === 0 && value['truncated'] && value['coverage'] === 'unsupported'
  return integer(value['knownTotal']) && value['knownTotal'] <= 20_000 && value['knownTotal'] >= value['displayed'] && value['coverage'] === (value['truncated'] ? 'partial' : 'complete') && (value['mode'] === 'compute_input_artifacts' || value['truncated'] === (value['displayed'] < value['knownTotal']))
}
function isInputArtifacts(value: unknown): value is readonly SavedInputArtifactView[] {
  return Array.isArray(value) && value.length <= 10 && value.every((input: unknown) => record(input) && isResourceRef(input['ref']) && integer(input['byteSize']) && input['byteSize'] <= 8 * 1_048_576 && optionalString(input['text']) && (input['text'] === undefined || new TextEncoder().encode(input['text']).byteLength <= 16_384) && typeof input['textTruncated'] === 'boolean' && Array.isArray(input['inputRefPointers']) && input['inputRefPointers'].length > 0 && input['inputRefPointers'].length <= 10 && input['inputRefPointers'].every((pointer: unknown) => typeof pointer === 'string' && /^\/inputRefs\/(?:0|[1-9][0-9]*)$/u.test(pointer)))
}
export function isAnswerSourceView(value: unknown): value is AnswerSourceView {
  if (
    !record(value) ||
    !text(value['answerId']) ||
    !text(value['evidenceId']) ||
    !isVersionRef(value['answerRef']) ||
    !isResourceRef(value['evidenceRef']) ||
    !enumValue(value['family'], ['document_span', 'structured_qa', 'rule_support', 'data_query']) ||
    !enumValue(value['precision'], ['exact', 'approximate']) ||
    !readable(value['readability']) ||
    !text(value['title']) ||
    !optionalString(value['text']) ||
    !optionalString(value['sourceReadLimitation']) ||
    !mode(value['dataMode'])
  )
    return false
  if (
    value['cells'] !== undefined &&
    !isCells(value['cells'])
  )
    return false
  if (value['fragments'] !== undefined) {
    const fragments = value['fragments']
    if (!Array.isArray(fragments) || fragments.length > 10 || !fragments.every(isFragment)) return false
    if (value['family'] === 'data_query') {
      if (!isSourceCoverage(value['sourceCoverage']) || value['precision'] !== 'exact' || fragments.some((fragment) => fragment.precision !== 'exact') || (value['sourceCoverage'].displayed === 0 ? fragments.length !== 0 : fragments.length === 0) || ['originalRef', 'parseRef', 'locator', 'cells'].some((key) => value[key] !== undefined)) return false
    } else {
    if (fragments.length === 0 || !enumValue(value['family'], ['document_span', 'structured_qa'])) return false
    const first = fragments[0]
    if (first === undefined || first.precision !== value['precision'] || !isResourceRef(value['originalRef']) || !sameRef(first.originalRef, value['originalRef']) || !isResourceRef(value['parseRef']) || !sameRef(first.parseRef, value['parseRef']) || !isSourceLocator(value['locator']) || !sameSourceLocator(first.locator, value['locator']) || first.text !== value['text']) return false
    const cells = value['cells']
    if (first.cells === undefined ? cells !== undefined : !isCells(cells) || first.cells.length !== cells.length || first.cells.some((cell, index) => {
      const other = cells[index]
      return other === undefined || cell.raw !== other.raw || cell.columnLabel !== other.columnLabel || cell.rowLabel !== other.rowLabel || !sameSourceLocator(cell.locator, other.locator)
    })) return false
    }
  }
  if (
    (value['originalRef'] !== undefined && !isResourceRef(value['originalRef'])) ||
    (value['parseRef'] !== undefined && !isResourceRef(value['parseRef'])) ||
    (value['locator'] !== undefined && !isSourceLocator(value['locator'])) ||
    (value['support'] !== undefined && !isProvenanceView(value['support']))
    || (value['archivedPayload'] !== undefined && !record(value['archivedPayload']))
    || (value['fixedInputRef'] !== undefined && !isResourceRef(value['fixedInputRef']))
    || (value['fixedDatasetSnapshotRef'] !== undefined && !isResourceRef(value['fixedDatasetSnapshotRef']))
    || (value['sourceCoverage'] !== undefined && !isSourceCoverage(value['sourceCoverage']))
    || (value['selectedCell'] !== undefined && !isSelectedCell(value['selectedCell']))
    || (value['inputArtifacts'] !== undefined && !isInputArtifacts(value['inputArtifacts']))
  )
    return false
  if (['sourceCoverage', 'selectedCell', 'inputArtifacts'].some((key) => value[key] !== undefined) && value['family'] !== 'data_query') return false
  if (value['selectedCell'] !== undefined && !isSourceCoverage(value['sourceCoverage'])) return false
  if (
    value['family'] === 'structured_qa' &&
    (value['precision'] !== 'approximate' ||
      (value['readability'] !== 'unverifiable' &&
        (!Array.isArray(value['cells']) ||
          value['cells'].length === 0 ||
          !isResourceRef(value['originalRef']) ||
          !isResourceRef(value['parseRef']))))
  )
    return false
  return true
}
export interface InstanceFieldSourceView {
  readonly projectId: string
  readonly recordId: string
  readonly recordRevision: string
  readonly fieldId: string
  readonly precision: 'exact' | 'approximate'
  readonly readability: 're_readable'
  readonly originalRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly parseId: string
  readonly locator: SourceLocator
  readonly text?: string
  readonly cells?: readonly SourceCellView[]
}
export function isInstanceFieldSourceView(value: unknown): value is InstanceFieldSourceView {
  return record(value) && isUuid(value['projectId']) && isUuid(value['recordId']) && isRevisionString(value['recordRevision']) && text(value['fieldId']) &&
    enumValue(value['precision'], ['exact', 'approximate']) && value['readability'] === 're_readable' && isResourceRef(value['originalRef']) &&
    isResourceRef(value['parseRef']) && isUuid(value['parseId']) && isSourceLocator(value['locator']) && optionalString(value['text']) &&
    (value['cells'] === undefined || isCells(value['cells'])) && (typeof value['text'] === 'string' || Array.isArray(value['cells']) && value['cells'].length > 0)
}
export async function readInstanceFieldSource(client: Pick<WorkbenchClient, 'requestJson'>, instance: InstanceRecordView, fieldId: string, signal?: AbortSignal): Promise<InstanceFieldSourceView> {
  const path = `/api/v1/core/projects/${encodeURIComponent(instance.projectId)}/instance-records/${encodeURIComponent(instance.recordId)}/fields/${encodeURIComponent(fieldId)}/source?recordRevision=${encodeURIComponent(instance.recordRevision)}`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  const field = instance.fields.find((field) => field.fieldId === fieldId)
  if (!isInstanceFieldSourceView(value) || field === undefined || value.projectId !== instance.projectId || value.recordId !== instance.recordId || value.recordRevision !== instance.recordRevision || value.fieldId !== fieldId || value.parseId !== field.source.parseId || !sameRef(value.originalRef, field.source.documentRef) || !sameSourceLocator(value.locator, field.source.locator) || value.cells?.some((cell) => !sameSourceLocator(cell.locator, value.locator)))
    throw new ApiError(502, { code: 'SOURCE_REFERENCE_MISMATCH', message: '原始来源与当前记录修订或字段定位不一致，已停止展示。', retryable: false, reasons: [], missingCapabilities: [] })
  return value
}
export type AnswerSourceLoader = (
  answer: PublishedAnswer,
  evidenceRef: ResourceRef,
  signal?: AbortSignal,
  selector?: SavedCellSelector,
) => Promise<AnswerSourceView>
export async function readAnswerSource(
  client: Pick<WorkbenchClient, 'requestJson'>,
  answer: PublishedAnswer,
  evidenceRef: ResourceRef,
  signal?: AbortSignal,
  selector?: SavedCellSelector,
): Promise<AnswerSourceView> {
  const query = selector === undefined ? '' : `?${new URLSearchParams({ tableId: selector.tableId, rowKey: selector.rowKey, columnRef: selector.columnRef }).toString()}`
  const path = `/api/v1/core/answers/${encodeURIComponent(answer.answerId)}/sources/${encodeURIComponent(evidenceRef.id)}${query}`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  return boundAnswerSource(value, answer, evidenceRef, selector)
}
export function boundAnswerSource(
  value: unknown,
  answer: PublishedAnswer,
  evidenceRef: ResourceRef,
  selector?: SavedCellSelector,
): AnswerSourceView {
  if (
    !isAnswerSourceView(value) ||
    value.answerId !== answer.answerId ||
    value.evidenceId !== evidenceRef.id ||
    value.answerRef.id !== answer.answerId ||
    value.answerRef.version !== '1.0.0' ||
    value.answerRef.digest !== answer.contentHash ||
    value.evidenceRef.kind !== evidenceRef.kind ||
    value.evidenceRef.id !== evidenceRef.id ||
    value.evidenceRef.version !== evidenceRef.version ||
    value.evidenceRef.digest !== evidenceRef.digest ||
    (selector === undefined ? value.selectedCell !== undefined : value.selectedCell?.tableId !== selector.tableId || value.selectedCell.rowKey !== selector.rowKey || value.selectedCell.columnRef !== selector.columnRef)
  )
    throw new ApiError(502, {
      code: 'SOURCE_REFERENCE_MISMATCH',
      message: '来源版本与当前核验答案不一致，已停止展示。',
      retryable: false,
      reasons: [],
      missingCapabilities: [],
    })
  return value
}
