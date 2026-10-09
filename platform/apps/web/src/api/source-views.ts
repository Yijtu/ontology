import type {
  DataMode,
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

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
const mode = (value: unknown): value is DataMode =>
  ['synthetic', 'observed', 'forecast', 'simulation', 'live'].includes(String(value))
const readable = (value: unknown): value is SourceReReadability =>
  ['re_readable', 'archived_snapshot_only', 'unverifiable'].includes(String(value))
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
    !['csv', 'xlsx'].includes(String(value['format'])) ||
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
    !['verifiable', 'unverifiable'].includes(String(value['outcome'])) ||
    ![
      'observation',
      'document_span',
      'computation',
      'rule_derivation',
      'identity_decision',
      'model_output',
      'web_page',
    ].includes(String(value['kind'])) ||
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
      ![
        'not_rule',
        'resolved',
        'not_applicable',
        'unknown',
        'conflict',
        'ambiguous',
        'unavailable',
        'incomplete',
      ].includes(String(value['supportResolution']['state'])))
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
          ['verbatim', 'normalized', 'approximate'].includes(String(span['spanKind'])) &&
          ['exact', 'approximate'].includes(String(span['precision'])) &&
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
        ['immutable', 'repeatable_read', 'read_time', 'unknown'].includes(String(source['consistency'])) &&
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
        ['supports', 'contradicts', 'derives_from', 'corrects', 'retracts', 'same_source'].includes(
          String(edge['relation']),
        ) &&
        ['support', 'lineage'].includes(String(edge['origin'])) &&
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
  readonly cells?: readonly {
    readonly raw: string | boolean | null
    readonly locator: SourceLocator
    readonly columnLabel?: string
    readonly rowLabel?: string
  }[]
  readonly originalRef?: ResourceRef
  readonly parseRef?: ResourceRef
  readonly locator?: SourceLocator
  readonly support?: ProvenanceEvidenceView
  readonly dataMode: DataMode
}
export function isAnswerSourceView(value: unknown): value is AnswerSourceView {
  if (
    !record(value) ||
    !text(value['answerId']) ||
    !text(value['evidenceId']) ||
    !isVersionRef(value['answerRef']) ||
    !isResourceRef(value['evidenceRef']) ||
    !['document_span', 'structured_qa', 'rule_support', 'data_query'].includes(String(value['family'])) ||
    !['exact', 'approximate'].includes(String(value['precision'])) ||
    !readable(value['readability']) ||
    !text(value['title']) ||
    !optionalString(value['text']) ||
    !mode(value['dataMode'])
  )
    return false
  if (
    value['cells'] !== undefined &&
    (!Array.isArray(value['cells']) ||
      !value['cells'].every(
        (cell: unknown) =>
          record(cell) &&
          (cell['raw'] === null || typeof cell['raw'] === 'string' || typeof cell['raw'] === 'boolean') &&
          isSourceLocator(cell['locator']) &&
          optionalString(cell['columnLabel']) &&
          optionalString(cell['rowLabel']),
      ))
  )
    return false
  if (
    (value['originalRef'] !== undefined && !isResourceRef(value['originalRef'])) ||
    (value['parseRef'] !== undefined && !isResourceRef(value['parseRef'])) ||
    (value['locator'] !== undefined && !isSourceLocator(value['locator'])) ||
    (value['support'] !== undefined && !isProvenanceView(value['support']))
  )
    return false
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
export type AnswerSourceLoader = (
  answer: PublishedAnswer,
  evidenceRef: ResourceRef,
  signal?: AbortSignal,
) => Promise<AnswerSourceView>
export async function readAnswerSource(
  client: Pick<WorkbenchClient, 'requestJson'>,
  answer: PublishedAnswer,
  evidenceRef: ResourceRef,
  signal?: AbortSignal,
): Promise<AnswerSourceView> {
  const path = `/api/v1/core/answers/${encodeURIComponent(answer.answerId)}/sources/${encodeURIComponent(evidenceRef.id)}`
  const value = await client.requestJson<unknown>('GET', path, signal === undefined ? {} : { signal })
  return boundAnswerSource(value, answer, evidenceRef)
}
export function boundAnswerSource(
  value: unknown,
  answer: PublishedAnswer,
  evidenceRef: ResourceRef,
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
    value.evidenceRef.digest !== evidenceRef.digest
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
