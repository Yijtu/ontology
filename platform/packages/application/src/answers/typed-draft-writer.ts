import { createHash } from 'node:crypto'
import { isResourceRef, isVersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type {
  AssertionEvidenceBinding,
  DraftClaim,
  DraftWriterPort,
  DraftWriterRequest,
  DraftWriterResult,
  EvidenceRecord,
  EvidenceStorePort,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  TypedResultManifest,
  Uuid,
  VerifiedAssertion,
} from '@ontology/contracts'
import { answerDraftContentHash } from '../workflow/canonical'
import { canonicalJson } from '../profiles/canonical'
import { typedResultManifestContentDigest } from './typed-result-manifest'
import { rulePremiseHasSourceLimitation } from './rule-premise-bindings'

/**
 * The typed evidence draft writer (SPEC v0.3a execution-evidence §EX-7.1, §EX-12; issue
 * V03-036 / #207; A.US-011.AC-01/03, A.US-012.AC-02, A.FR-18).
 *
 * It deterministically renders the six result families this phase produces — published facts,
 * entity relations, rule judgements, structured-query cells, document citations and compute
 * output — into the *same* typed `AnswerDraft`/`answer-draft@3` body the hard verifier and the
 * publication gate consume. The writer never invents a value: every rendered claim/assertion
 * binds the exact archived evidence result and JSON pointers the verifier re-reads, so an
 * unbound number, subject, unit, endpoint or quote is a located verification failure rather
 * than a trusted transcription.
 *
 * Two boundaries are load-bearing:
 *
 *  - **No model, no free prose.** The writer is a bounded, single-shot deterministic step. It
 *    starts no agent, adds no model-authored fact and never overrides the shared budget.
 *  - **Same verified version only.** When a typed result manifest context is available the
 *    writer emits an `answer-draft@3` body that pins the result manifest and its pre-draft
 *    finalization receipt by full ref/digest. Because those refs enter the V3 content hash, any
 *    later edit to the manifest or body produces a new draft hash and requires a fresh
 *    verification before it can be published.
 *
 * A truncated or incomplete result is never upgraded to a complete one: the corresponding
 * limitation is declared on the draft and (for a facts page) the draft is refused outright.
 */

export type TypedDraftWriterErrorCode =
  | 'INSUFFICIENT_DATA'
  | 'UNSUPPORTED_RESULT'
  | 'INCOMPLETE_RESULT'

export class TypedDraftWriterError extends Error {
  readonly code: TypedDraftWriterErrorCode
  readonly httpStatus = 422

  constructor(code: TypedDraftWriterErrorCode, message: string) {
    super(message)
    this.name = 'TypedDraftWriterError'
    this.code = code
  }
}

/** The narrow authorized blob-read capability the writer needs (same shape the verifier uses). */
export interface TypedDraftArtifactStore {
  getAuthorized(
    request: { readonly scopeRef: ScopeRef; readonly blobRef: ResourceRef },
    ctx: ToolContext,
  ): Promise<{ readonly integrityVerified: boolean }>
  readAuthorized(
    request: { readonly scopeRef: ScopeRef; readonly blobRef: ResourceRef },
    ctx: ToolContext,
  ): Promise<Uint8Array>
}

/**
 * The exact typed-result bindings an `answer-draft@3` pins. The host resolves them from the
 * archived typed manifest and finalization receipt for the run; the writer never derives a
 * manifest ref from a hash or a mutable head.
 */
export interface TypedResultContext {
  readonly executionBindingRef: ResourceRef
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly finalizationReceiptRef: ResourceRef
  readonly finalizationReceiptDigest: Sha256Digest
  /** Internal proof body used only to authorize a bounded inline preview of a complete table. */
  readonly resultManifest?: TypedResultManifest
}

export interface TypedResultContextSource {
  resolve(input: { readonly runId: Uuid }, ctx: ToolContext): Promise<TypedResultContext | undefined>
}

/**
 * Resolve the pinned typed-result context from a manifest the host has already archived. The
 * digest is recomputed from the manifest body and must equal the archived ref digest, so a
 * mismatched or tampered manifest is refused here instead of being bound into a draft.
 */
export function typedResultContextFor(input: {
  readonly executionBindingRef: ResourceRef
  readonly resultManifest: TypedResultManifest
  readonly resultManifestRef: ResourceRef
  readonly finalizationReceiptRef: ResourceRef
  readonly finalizationReceiptDigest: Sha256Digest
}): TypedResultContext {
  const resultManifestDigest = typedResultManifestContentDigest(input.resultManifest)
  if (resultManifestDigest !== input.resultManifestRef.digest) {
    throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the typed result manifest does not match its archived ref digest')
  }
  return {
    executionBindingRef: input.executionBindingRef,
    resultManifestRef: input.resultManifestRef,
    resultManifestDigest,
    finalizationReceiptRef: input.finalizationReceiptRef,
    finalizationReceiptDigest: input.finalizationReceiptDigest,
    resultManifest: input.resultManifest,
  }
}

export interface TypedDraftWriterOptions {
  readonly evidence: EvidenceStorePort
  readonly artifacts: TypedDraftArtifactStore
  /** When present the writer emits `answer-draft@3`; otherwise it stays on `answer-draft@2`. */
  readonly typedResult?: TypedResultContextSource
  readonly now?: () => string
}

interface Rendered {
  readonly claims: DraftClaim[]
  readonly assertions: VerifiedAssertion[]
  readonly limitations: string[]
}

const emptyRendered = (): Rendered => ({ claims: [], assertions: [], limitations: [] })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function sameRef(value: unknown, expected: ResourceRef): boolean {
  if (!isRecord(value)) return false
  return value['id'] === expected.id && value['version'] === expected.version &&
    value['digest'] === expected.digest && value['kind'] === expected.kind
}

/** A UUIDv5-shaped stable id derived from a namespace string (deterministic per run/evidence). */
function stableUuid(value: string): Uuid {
  const chars = [...createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function syntheticRef(id: string): ResourceRef {
  return { id, version: '1.0.0', digest: sha256DigestOf(id), kind: 'artifact' }
}

function entityRefOr(value: unknown, id: string): ResourceRef {
  return isResourceRef(value) ? value : syntheticRef(id)
}

function valueAt(payload: unknown, pointer: string): unknown {
  if (pointer === '') return payload
  if (!pointer.startsWith('/')) return undefined
  let value = payload
  for (const token of pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (typeof value !== 'object' || value === null) return undefined
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return undefined
      value = value[Number(token)]
    } else {
      value = Object.hasOwn(value, token) ? (value as Record<string, unknown>)[token] : undefined
    }
  }
  return value
}

/* ----------------------------------------------------------------------------------------- */
/* Published facts                                                                            */
/* ----------------------------------------------------------------------------------------- */

interface PublishedFact {
  readonly subjectEntityId: string
  readonly attributeId: string
  readonly value: unknown
  readonly unitCode?: string
}

function factOf(item: unknown): PublishedFact | undefined {
  if (!isRecord(item) || item['kind'] !== 'fact' || !isVersionRef(item['ref']) || !isRecord(item['payload'])) {
    return undefined
  }
  const payload = item['payload']
  if (
    !isNonEmptyString(payload['subjectEntityId']) ||
    !isNonEmptyString(payload['attributeId']) ||
    !isNonEmptyString(payload['sourceStatementId']) ||
    !isVersionRef(payload['schemaRef']) ||
    !Array.isArray(payload['sourceRefs']) ||
    !Object.hasOwn(payload, 'value')
  ) {
    return undefined
  }
  return {
    subjectEntityId: payload['subjectEntityId'],
    attributeId: payload['attributeId'],
    value: payload['value'],
    ...(typeof payload['unitCode'] === 'string' ? { unitCode: payload['unitCode'] } : {}),
  }
}

function renderFacts(
  payload: Record<string, unknown>,
  evidenceRef: ResourceRef,
  resultDigest: Sha256Digest,
  runId: Uuid,
): Rendered {
  if (!Array.isArray(payload['items'])) {
    throw new TypedDraftWriterError('UNSUPPORTED_RESULT', 'a published fact page has no items array')
  }
  if (Array.isArray(payload['gaps']) && payload['gaps'].length > 0) {
    throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'published fact coverage is incomplete; no answer body was drafted')
  }
  if (payload['items'].some((item) => !isRecord(item) || item['kind'] !== 'fact')) {
    throw new TypedDraftWriterError('UNSUPPORTED_RESULT', 'ontology_lookup returned a non-fact or mixed fact page')
  }
  const rendered = emptyRendered()
  for (const [index, item] of payload['items'].entries()) {
    const fact = factOf(item)
    if (fact === undefined) {
      throw new TypedDraftWriterError('UNSUPPORTED_RESULT', 'a published fact lacks a complete schema/entity/source binding')
    }
    const base = `/items/${String(index)}/payload`
    const valueKind = typeof fact.value === 'boolean'
      ? 'boolean'
      : typeof fact.value === 'string'
        ? 'string'
        : typeof fact.value === 'number' || (isRecord(fact.value) && typeof fact.value['amount'] === 'string' && typeof fact.value['unit'] === 'string')
          ? 'quantity'
          : undefined
    const valuePointer = valueKind === 'quantity' && isRecord(fact.value)
      ? `${base}/value/amount`
      : `${base}/value`
    const fieldRefPointer = `${base}/attributeId`
    const subjectPointer = `${base}/subjectEntityId`
    if (valueKind === undefined) {
      throw new TypedDraftWriterError('UNSUPPORTED_RESULT', 'a published fact value type is not supported by the typed answer renderer')
    }
    if (valueKind === 'quantity') {
      if (fact.unitCode === undefined) {
        throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'a numeric published fact has no unit')
      }
      const amount = isRecord(fact.value) ? fact.value['amount'] : fact.value
      if (typeof amount !== 'string' && typeof amount !== 'number') {
        throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'a numeric published fact has no exact amount')
      }
      const claimId = stableUuid(`claim:${runId}:${evidenceRef.id}:${fact.subjectEntityId}:${fact.attributeId}:${String(index)}`)
      rendered.claims.push({
        claimId,
        subject: fact.subjectEntityId,
        predicate: fact.attributeId,
        value: { value: amount, unit: fact.unitCode },
        time: {},
        kind: 'observation',
        references: [{ evidenceRef, resultDigest, valuePointer, unitPointer: `${base}/unitCode`, subjectPointer, fieldRefPointer }],
      })
      continue
    }
    const assertionId = stableUuid(`assertion:${runId}:${evidenceRef.id}:${fact.subjectEntityId}:${fact.attributeId}:${String(index)}`)
    const binding: AssertionEvidenceBinding = { evidenceRef, resultDigest, valuePointer, subjectPointer, fieldRefPointer }
    if (valueKind === 'boolean') {
      rendered.assertions.push({ assertionId, kind: 'boolean', subject: fact.subjectEntityId, predicate: fact.attributeId, value: fact.value as boolean, references: [binding] })
    } else {
      rendered.assertions.push({ assertionId, kind: 'string', subject: fact.subjectEntityId, predicate: fact.attributeId, value: fact.value as string, references: [binding] })
    }
  }
  return rendered
}

/* ----------------------------------------------------------------------------------------- */
/* Relations                                                                                  */
/* ----------------------------------------------------------------------------------------- */

interface LocatedHop {
  readonly hop: Record<string, unknown>
  readonly pointer: string
}

function relationHops(payload: Record<string, unknown>): LocatedHop[] {
  const located: LocatedHop[] = []
  if (Array.isArray(payload['edges'])) {
    payload['edges'].forEach((edge, index) => {
      if (isRecord(edge)) located.push({ hop: edge, pointer: `/edges/${String(index)}` })
    })
  }
  if (Array.isArray(payload['paths'])) {
    payload['paths'].forEach((path, pathIndex) => {
      if (!isRecord(path) || !Array.isArray(path['hops'])) return
      path['hops'].forEach((hop, hopIndex) => {
        if (isRecord(hop)) located.push({ hop, pointer: `/paths/${String(pathIndex)}/hops/${String(hopIndex)}` })
      })
    })
  }
  return located
}

function renderRelations(
  payload: Record<string, unknown>,
  evidenceRef: ResourceRef,
  resultDigest: Sha256Digest,
  runId: Uuid,
): Rendered {
  const rendered = emptyRendered()
  for (const [index, { hop, pointer }] of relationHops(payload).entries()) {
    const relationId = hop['relationId']
    const fromEntityId = hop['fromEntityId']
    const toEntityId = hop['toEntityId']
    if (!isNonEmptyString(relationId) || !isNonEmptyString(fromEntityId) || !isNonEmptyString(toEntityId)) {
      rendered.limitations.push('relation_endpoint_missing')
      continue
    }
    const assertionId = stableUuid(`relation:${runId}:${evidenceRef.id}:${String(index)}:${relationId}`)
    rendered.assertions.push({
      assertionId,
      kind: 'relation_ref',
      subject: fromEntityId,
      predicate: relationId,
      value: { type: relationId, from: entityRefOr(hop['fromRef'], fromEntityId), to: entityRefOr(hop['toRef'], toEntityId) },
      ...(isVersionRef(hop['definitionRef']) ? { definitionRef: hop['definitionRef'] } : {}),
      ...(typeof hop['statementId'] === 'string' ? { statementId: hop['statementId'] } : {}),
      ...(typeof hop['statementVersion'] === 'string' ? { statementVersion: hop['statementVersion'] } : {}),
      references: [{
        evidenceRef,
        resultDigest,
        valuePointer: pointer,
        subjectPointer: `${pointer}/fromEntityId`,
        relationPointer: pointer,
      }],
    })
  }
  return rendered
}

/* ----------------------------------------------------------------------------------------- */
/* Rule judgements                                                                            */
/* ----------------------------------------------------------------------------------------- */

const RULE_COMPUTATION_SCHEMA = 'rule-computation-artifact@1'
const RULE_DERIVATION_SUPPORT_SCHEMA = 'rule-derivation-support-payload@1'

function ruleArtifactOf(payload: Record<string, unknown>): { readonly artifact: Record<string, unknown>; readonly pointer: string } | undefined {
  if (payload['schemaVersion'] === RULE_COMPUTATION_SCHEMA) return { artifact: payload, pointer: '' }
  if (payload['schemaVersion'] === RULE_DERIVATION_SUPPORT_SCHEMA && isRecord(payload['artifact']) && payload['artifact']['schemaVersion'] === RULE_COMPUTATION_SCHEMA) {
    return { artifact: payload['artifact'], pointer: '/artifact' }
  }
  if (isRecord(payload['artifact']) && payload['artifact']['schemaVersion'] === RULE_COMPUTATION_SCHEMA) {
    return { artifact: payload['artifact'], pointer: '/artifact' }
  }
  return undefined
}

function applicabilityVerdict(artifact: Record<string, unknown>): 'true' | 'false' | 'unknown' | 'conflict' | undefined {
  const applicability = artifact['applicability']
  if (!isRecord(applicability)) return undefined
  switch (applicability['state']) {
    case 'applicable':
      return applicability['positiveSupport'] === true ? 'true' : 'unknown'
    case 'not_applicable':
      return 'false'
    case 'unknown':
      return 'unknown'
    case 'conflict':
      return 'conflict'
    default:
      return undefined
  }
}

function renderRule(
  payload: Record<string, unknown>,
  evidenceRef: ResourceRef,
  resultDigest: Sha256Digest,
  runId: Uuid,
): Rendered {
  const rendered = emptyRendered()
  const found = ruleArtifactOf(payload)
  if (found === undefined) {
    rendered.limitations.push('rule_artifact_unsupported')
    return rendered
  }
  const { artifact, pointer } = found
  if (rulePremiseHasSourceLimitation(payload)) rendered.limitations.push('limited_factual_result')
  const subject = artifact['subjectEntityId']
  const predicate = artifact['predicate']
  const ruleRef = artifact['ruleRef']
  const verdict = applicabilityVerdict(artifact)
  if (!isNonEmptyString(subject) || !isNonEmptyString(predicate) || !isVersionRef(ruleRef) || verdict === undefined) {
    rendered.limitations.push('rule_artifact_incomplete')
    return rendered
  }
  const assertionId = stableUuid(`rule:${runId}:${evidenceRef.id}:${subject}:${predicate}`)
  rendered.assertions.push({
    assertionId,
    kind: 'rule_judgement',
    subject,
    predicate,
    value: verdict,
    ruleRef,
    premiseRefs: Array.isArray(payload['premiseRefs']) ? payload['premiseRefs'].filter(isResourceRef) : [],
    judgementAxis: 'applicability',
    ...(typeof artifact['validAt'] === 'string' ? { asOf: artifact['validAt'] } : {}),
    ...(typeof artifact['computationDigest'] === 'string' ? { computationDigest: artifact['computationDigest'] } : {}),
    references: [{
      evidenceRef,
      resultDigest,
      valuePointer: pointer === '' ? '' : pointer,
      subjectPointer: pointer === '' ? '/subjectEntityId' : `${pointer}/subjectEntityId`,
      rulePointer: pointer,
      ...(typeof artifact['validAt'] === 'string' ? { timePointer: `${pointer}/validAt` } : {}),
    }],
  })
  return rendered
}

/* ----------------------------------------------------------------------------------------- */
/* Document citations                                                                         */
/* ----------------------------------------------------------------------------------------- */

function renderCitation(
  payload: Record<string, unknown>,
  evidenceRef: ResourceRef,
  resultDigest: Sha256Digest,
  runId: Uuid,
): Rendered {
  const rendered = emptyRendered()
  const candidates: readonly { readonly node: Record<string, unknown>; readonly pointer: string }[] = Array.isArray(payload['spans'])
    ? payload['spans'].flatMap((span, index) => (isRecord(span) ? [{ node: span, pointer: `/spans/${String(index)}` }] : []))
    : [{ node: payload, pointer: '' }]
  for (const [index, { node, pointer }] of candidates.entries()) {
    const quote = node['quote'] ?? node['text']
    const subject = node['subject'] ?? node['subjectEntityId']
    const quoteDigest = node['quoteDigest']
    const textDigest = node['textDigest']
    const documentRef = node['documentRef']
    const locator = node['locator']
    const documentVersionRef = node['documentVersionRef']
    const locatorKind = isRecord(locator) ? locator['kind'] : undefined
    if (
      !isNonEmptyString(quote) ||
      !isNonEmptyString(subject) ||
      !isNonEmptyString(quoteDigest) ||
      !isNonEmptyString(textDigest) ||
      !isResourceRef(documentRef) ||
      !isRecord(locator) ||
      (locatorKind !== 'page' && locatorKind !== 'offset' && locatorKind !== 'approximate_locator')
    ) {
      rendered.limitations.push('citation_incomplete')
      continue
    }
    const typedLocator: Extract<VerifiedAssertion, { readonly kind: 'document_quote' }>['locator'] = {
      kind: locatorKind,
      ...(typeof locator['page'] === 'number' ? { page: locator['page'] } : {}),
      ...(typeof locator['startOffset'] === 'number' ? { startOffset: locator['startOffset'] } : {}),
      ...(typeof locator['endOffset'] === 'number' ? { endOffset: locator['endOffset'] } : {}),
      ...(typeof locator['normalizationMapRef'] === 'string' ? { normalizationMapRef: locator['normalizationMapRef'] } : {}),
    }
    const prefix = pointer === '' ? '' : pointer
    const binding: AssertionEvidenceBinding = {
      evidenceRef,
      resultDigest,
      valuePointer: `${prefix}/quote`,
      subjectPointer: `${prefix}/subject`,
      documentPointer: `${prefix}/documentRef`,
      locatorPointer: `${prefix}/locator`,
      quoteDigestPointer: `${prefix}/quoteDigest`,
      textDigestPointer: `${prefix}/textDigest`,
      ...(isResourceRef(documentVersionRef) ? { documentVersionPointer: `${prefix}/documentVersionRef` } : {}),
    }
    const assertionId = stableUuid(`citation:${runId}:${evidenceRef.id}:${String(index)}:${documentRef.id}`)
    if (locatorKind === 'approximate_locator' || node['spanKind'] === 'approximate') {
      const sourceOrigin = node['sourceOrigin']
      const projectionRef = isRecord(sourceOrigin) ? sourceOrigin['projectionRef'] : undefined
      rendered.limitations.push('approximate_document_source', 'limited_factual_result')
      // A structured projection is readable derived data, never a verbatim source quote.
      // Missing origin/projection proof cannot be promoted to an exact citation.
      if (isResourceRef(projectionRef)) rendered.assertions.push({ assertionId, kind: 'artifact_summary', subject,
        predicate: 'structured_source_projection', artifactRef: projectionRef, summary: quote,
        references: [{ ...binding, documentPointer: `${prefix}/sourceOrigin/projectionRef` }],
      })
      continue
    }
    rendered.assertions.push({
      assertionId,
      kind: 'document_quote',
      subject,
      predicate: isNonEmptyString(node['predicate']) ? node['predicate'] : 'document_quote',
      quote,
      documentRef,
      ...(isResourceRef(documentVersionRef) ? { documentVersionRef } : {}),
      locator: typedLocator,
      quoteDigest,
      textDigest,
      precision: 'exact',
      references: [binding],
    })
  }
  return rendered
}

/* ----------------------------------------------------------------------------------------- */
/* Structured query / presentable compute tables                                              */
/* ----------------------------------------------------------------------------------------- */

const SUBJECT_COLUMN = /^(subject|subjectentityid|entity|entityid|id|rowkey)$/u
const NUMERIC_TYPES = new Set(['number', 'decimal', 'integer', 'quantity'])
const BOOLEAN_TYPES = new Set(['boolean', 'bool'])
const ENTITY_TYPES = new Set(['entity', 'entity_ref', 'ref', 'relation_ref'])
const MONEY_TYPES = new Set(['money', 'currency'])
const MAX_INLINE_TABLE_PREVIEW = 128
const RESERVED_TABLE_FIELDS = new Set(['record_id', 'sources_json'])

function columnField(column: Record<string, unknown>, index: number): string {
  if (isNonEmptyString(column['semanticFieldRef'])) return column['semanticFieldRef']
  if (isNonEmptyString(column['name'])) return column['name']
  return `column_${String(index)}`
}

function subjectColumnIndex(columns: readonly Record<string, unknown>[], rowKeys: readonly unknown[], rows: readonly (readonly unknown[])[]): number | undefined {
  const explicit = columns.findIndex((column, index) => {
    void index
    const field = columnField(column, 0).toLowerCase()
    return SUBJECT_COLUMN.test(field) || field.endsWith('_id')
  })
  if (explicit >= 0) return explicit
  if (rowKeys.length > 0) return -1
  void rows
  return undefined
}

function renderTable(
  payload: Record<string, unknown>,
  evidenceRef: ResourceRef,
  resultDigest: Sha256Digest,
  runId: Uuid,
  kind: string,
  preview?: { readonly businessFields: ReadonlySet<string>; readonly maxStatements: number },
): Rendered {
  const rendered = emptyRendered()
  const table = payload['table']
  if (!isRecord(table) || !Array.isArray(table['columns']) || !Array.isArray(table['rows'])) {
    rendered.limitations.push(kind === 'computation' ? 'compute_output_not_inline' : 'structured_query_incomplete')
    return rendered
  }
  const columns = table['columns'].filter(isRecord)
  const rows = table['rows'].filter(Array.isArray)
  const rowKeys: readonly unknown[] = Array.isArray(table['rowKeys']) ? table['rowKeys'] : []
  const coverage = table['coverage'] ?? payload['coverage']
  if (isRecord(coverage) && coverage['truncated'] === true) rendered.limitations.push('result_truncated')
  if (Array.isArray(payload['gaps']) && payload['gaps'].length > 0) rendered.limitations.push('result_incomplete')

  const subjectIndex = subjectColumnIndex(columns, rowKeys, rows)
  if (subjectIndex === undefined) {
    rendered.limitations.push('structured_query_no_subject')
    return rendered
  }
  const subjectPointerFor = (row: number): string =>
    subjectIndex === -1 ? `/table/rowKeys/${String(row)}` : `/table/rows/${String(row)}/${String(subjectIndex)}`

  rowLoop: for (const [rowIndex, row] of rows.entries()) {
    const subject = valueAt(payload, subjectPointerFor(rowIndex))
    if (typeof subject !== 'string' || subject.length === 0) continue
    for (const [columnIndex, column] of columns.entries()) {
      const cell = row[columnIndex]
      if (cell === undefined || cell === null) continue
      const type = isNonEmptyString(column['type']) ? column['type'].toLowerCase() : undefined
      const pointer = `/table/rows/${String(rowIndex)}/${String(columnIndex)}`
      const fieldPointer = `/table/columns/${String(columnIndex)}`
      const field = columnField(column, columnIndex)
      if (RESERVED_TABLE_FIELDS.has(field.toLowerCase())) continue
      if (preview !== undefined && !preview.businessFields.has(field)) continue
      if (type !== undefined && MONEY_TYPES.has(type)) {
        rendered.limitations.push('money_requires_table_manifest')
        continue
      }
      if (type !== undefined && NUMERIC_TYPES.has(type)) {
        const unit = column['unit']
        if (typeof unit !== 'string' || (typeof cell !== 'number' && typeof cell !== 'string')) {
          rendered.limitations.push('numeric_cell_no_unit')
          continue
        }
        const claimId = stableUuid(`cell:${runId}:${evidenceRef.id}:${String(rowIndex)}:${field}`)
        rendered.claims.push({
          claimId,
          subject,
          predicate: field,
          value: { value: cell, unit },
          time: {},
          kind: 'observation',
          references: [{
            evidenceRef,
            resultDigest,
            valuePointer: pointer,
            unitPointer: `${fieldPointer}/unit`,
            subjectPointer: subjectPointerFor(rowIndex),
            fieldRefPointer: fieldPointer,
          }],
        })
        if (preview !== undefined && rendered.claims.length + rendered.assertions.length >= preview.maxStatements) break rowLoop
        continue
      }
      const assertionId = stableUuid(`cell:${runId}:${evidenceRef.id}:${String(rowIndex)}:${field}`)
      const binding: AssertionEvidenceBinding = {
        evidenceRef,
        resultDigest,
        valuePointer: pointer,
        subjectPointer: subjectPointerFor(rowIndex),
        fieldRefPointer: fieldPointer,
      }
      if (type !== undefined && BOOLEAN_TYPES.has(type) && typeof cell === 'boolean') {
        rendered.assertions.push({ assertionId, kind: 'boolean', subject, predicate: field, value: cell, references: [binding] })
      } else if (type !== undefined && ENTITY_TYPES.has(type) && isResourceRef(cell)) {
        rendered.assertions.push({ assertionId, kind: 'entity_ref', subject, predicate: field, value: cell, references: [binding] })
      } else if (typeof cell === 'string') {
        rendered.assertions.push({ assertionId, kind: 'string', subject, predicate: field, value: cell, references: [binding] })
      }
      if (preview !== undefined && rendered.claims.length + rendered.assertions.length >= preview.maxStatements) break rowLoop
    }
  }
  return rendered
}

interface InlineEvidence {
  readonly ref: ResourceRef
  readonly resultDigest: Sha256Digest
  readonly payload: Record<string, unknown>
}

/**
 * Prove that the sole inline table is exactly the complete business table in the pinned
 * result manifest. A manifest ref alone is insufficient: legacy, truncated, ambiguous, or
 * column-mismatched results retain the existing full inline-render behavior.
 */
function completeFormalTableFields(
  typedResult: TypedResultContext | undefined,
  evidence: readonly InlineEvidence[],
): ReadonlySet<string> | undefined {
  if (typedResult === undefined || evidence.length !== 1) return undefined
  const manifest = typedResult.resultManifest
  if (manifest === undefined) return undefined
  if (
    typedResultManifestContentDigest(manifest) !== typedResult.resultManifestDigest ||
    typedResult.resultManifestRef.digest !== typedResult.resultManifestDigest ||
    manifest.schemaVersion !== 'typed-result-manifest@1' ||
    manifest.resultKind !== 'structured_query' ||
    !sameRef(manifest.executionBindingRef, typedResult.executionBindingRef) ||
    manifest.domainStatus !== 'known' ||
    manifest.coverage.truncated ||
    manifest.limitations.length > 0 ||
    manifest.tables.length !== 1
  ) return undefined
  const [entry] = evidence
  if (entry === undefined) return undefined
  const table = entry.payload['table']
  if (!isRecord(table) || !Array.isArray(table['columns']) || !Array.isArray(table['rows'])) return undefined
  const columns = table['columns'].filter(isRecord)
  const rows = table['rows'].filter(Array.isArray)
  const formal = manifest.tables[0]
  const coverage = isRecord(table['coverage']) ? table['coverage'] : entry.payload['coverage']
  const coverageReturned = isRecord(coverage) ? coverage['returned'] : undefined
  const payloadTableId = table['tableId']
  if (
    formal === undefined ||
    !formal.complete ||
    formal.coverage.truncated ||
    formal.coverage.returned !== rows.length ||
    formal.totalRows !== rows.length ||
    formal.pages.reduce((total, page) => total + page.rowCount, 0) !== formal.totalRows ||
    formal.pages.length === 0 ||
    manifest.coverage.returned !== formal.totalRows ||
    !isRecord(coverage) ||
    coverageReturned !== rows.length ||
    coverage['truncated'] !== false ||
    (payloadTableId !== undefined && payloadTableId !== formal.tableId)
  ) return undefined

  const businessColumns = columns.flatMap((column, index) => {
    const field = columnField(column, index)
    return RESERVED_TABLE_FIELDS.has(field.toLowerCase()) ? [] : [field]
  })
  const formalFields = formal.columns.map((column) => column.semanticPredicate)
  if (
    businessColumns.length === 0 ||
    new Set(businessColumns).size !== businessColumns.length ||
    new Set(formalFields).size !== formalFields.length ||
    businessColumns.length !== formalFields.length ||
    businessColumns.some((field) => !formalFields.includes(field))
  ) return undefined

  const outputDigest = sha256DigestOf(canonicalJson([{
    ref: entry.ref,
    resultDigest: entry.resultDigest,
  }]))
  if (manifest.outputDigest !== outputDigest) return undefined
  return new Set(businessColumns)
}

/* ----------------------------------------------------------------------------------------- */
/* The writer                                                                                 */
/* ----------------------------------------------------------------------------------------- */

/* ----------------------------------------------------------------------------------------- */
/* Registered compute metrics                                                                 */
/* ----------------------------------------------------------------------------------------- */

function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Project a registered compute result into typed quantity/money claims (SPEC v0.3a §EX-6,
 * §EX-7.1). A registered operation emits `DataQueryOutput(resultKind=computation)` whose
 * `computation.metrics` carry the computed aggregates; each metric object that separates its
 * unit (`unit`) or currency (`currency`) from its exact `amount` becomes one row-bound claim.
 *
 * The projection is deliberately conservative: a bare scalar metric with no unit axis (for
 * example a record count) is *not* turned into a quantity claim, because the verifier requires
 * every decision claim to bind its unit to the archived result. Such a metric is declared as a
 * known limitation instead, so an answer is never silently padded or silently empty.
 */
function renderComputeMetrics(
  payload: Record<string, unknown>,
  evidenceRef: ResourceRef,
  resultDigest: Sha256Digest,
  runId: Uuid,
): Rendered {
  const rendered = emptyRendered()
  const computation = payload['computation']
  if (!isRecord(computation)) {
    rendered.limitations.push('compute_output_not_inline')
    return rendered
  }
  const metrics = computation['metrics']
  if (!isRecord(metrics) || Object.keys(metrics).length === 0) {
    rendered.limitations.push('compute_output_not_inline')
    return rendered
  }
  const operationRef = computation['operationRef']
  const operationId = isRecord(operationRef) && isNonEmptyString(operationRef['id']) ? operationRef['id'] : undefined
  if (operationId === undefined) {
    rendered.limitations.push('compute_output_not_inline')
    return rendered
  }
  const subjectPointer = '/computation/operationRef/id'
  for (const [key, value] of Object.entries(metrics)) {
    if (!isRecord(value)) {
      // A bare scalar (e.g. a record count) has no unit/currency axis to bind.
      rendered.limitations.push('numeric_cell_no_unit')
      continue
    }
    const amount = value['amount']
    if (typeof amount !== 'string' && typeof amount !== 'number') {
      rendered.limitations.push('numeric_cell_no_unit')
      continue
    }
    const unit = isNonEmptyString(value['unit']) ? value['unit'] : undefined
    const currency = isNonEmptyString(value['currency']) ? value['currency'] : undefined
    if (unit === undefined && currency === undefined) {
      rendered.limitations.push('numeric_cell_no_unit')
      continue
    }
    const metricPointer = `/computation/metrics/${escapePointerToken(key)}`
    const unitAxis = unit !== undefined ? 'unit' : 'currency'
    const claimId = stableUuid(`compute:${runId}:${evidenceRef.id}:${key}`)
    rendered.claims.push({
      claimId,
      subject: operationId,
      predicate: key,
      value: { value: amount, unit: unit ?? currency ?? '' },
      time: {},
      kind: 'computation',
      references: [{
        evidenceRef,
        resultDigest,
        valuePointer: `${metricPointer}/amount`,
        unitPointer: `${metricPointer}/${unitAxis}`,
        subjectPointer,
        fieldRefPointer: metricPointer,
      }],
    })
  }
  return rendered
}

function merge(into: Rendered, from: Rendered): void {
  into.claims.push(...from.claims)
  into.assertions.push(...from.assertions)
  into.limitations.push(...from.limitations)
}

function isFactPage(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload['items']) && payload['items'].some((item) => isRecord(item) && item['kind'] === 'fact')
}

export class TypedEvidenceDraftWriter implements DraftWriterPort {
  readonly recoverySafety = 'idempotent' as const
  readonly #options: TypedDraftWriterOptions
  readonly #now: () => string

  constructor(options: TypedDraftWriterOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult> {
    const scopeRef: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    let rendered = emptyRendered()
    const usedEvidenceRefs: ResourceRef[] = []
    const seenEvidenceIds = new Set<string>()
    const inlineEvidence: InlineEvidence[] = []
    const entries: { readonly record: EvidenceRecord; readonly payload: Record<string, unknown>; readonly evidenceRef: ResourceRef }[] = []

    for (const entry of request.inputManifest.entries) {
      const evidenceRef = entry.ref
      if (entry.kind !== 'evidence' || evidenceRef === undefined || evidenceRef.kind !== 'evidence') continue
      const record = await this.#options.evidence.get(scopeRef, evidenceRef.id, ctx)
      if (record === undefined || !sameRef(record.evidenceRef, evidenceRef)) continue
      const payload = await this.#readPayload(scopeRef, record, ctx)
      if (payload === undefined) {
        rendered.limitations.push('evidence_unreadable')
        continue
      }
      if (!seenEvidenceIds.has(evidenceRef.id)) {
        usedEvidenceRefs.push(evidenceRef)
        seenEvidenceIds.add(evidenceRef.id)
      }
      inlineEvidence.push({ ref: evidenceRef, resultDigest: record.envelope.resultDigest, payload })
      entries.push({ record, payload, evidenceRef })
    }

    for (const entry of entries) {
      const from = this.#renderEvidence(entry.record, entry.payload, entry.evidenceRef, request.runId)
      merge(rendered, from)
    }

    if (rendered.claims.length + rendered.assertions.length === 0) {
      throw new TypedDraftWriterError('INSUFFICIENT_DATA', 'no complete result-backed statements were available for the answer')
    }

    const typedResult = await this.#options.typedResult?.resolve({ runId: request.runId }, ctx)
    const formalBusinessFields = completeFormalTableFields(typedResult, inlineEvidence)
    if (formalBusinessFields !== undefined) {
      rendered = emptyRendered()
      for (const entry of entries) {
        const preview = { businessFields: formalBusinessFields, maxStatements: MAX_INLINE_TABLE_PREVIEW }
        const from = this.#renderEvidence(entry.record, entry.payload, entry.evidenceRef, request.runId, preview)
        merge(rendered, from)
      }
    }

    const blocks: readonly unknown[] = [
      ...rendered.claims.map((claim) => ({ kind: 'claim', claimId: claim.claimId })),
      ...rendered.assertions.map((assertion) => ({ kind: 'assertion', assertionId: assertion.assertionId })),
    ]
    const limitations = [...new Set(rendered.limitations)].sort()
    const evidenceManifestHash = request.inputManifest.digest
    if (typedResult !== undefined) {
      const contentHash = answerDraftContentHash(
        request.runId,
        blocks,
        evidenceManifestHash,
        rendered.claims,
        rendered.assertions,
        {
          schemaVersion: 'answer-draft@3',
          limitations,
          resultManifestRef: typedResult.resultManifestRef,
          resultManifestDigest: typedResult.resultManifestDigest,
          finalizationReceiptRef: typedResult.finalizationReceiptRef,
          finalizationReceiptDigest: typedResult.finalizationReceiptDigest,
          executionBindingRef: typedResult.executionBindingRef,
        },
      )
      return {
        draft: {
          draftId: stableUuid(`draft:${request.runId}:${evidenceManifestHash}:v3`),
          runId: request.runId,
          schemaVersion: 'answer-draft@3',
          blocks,
          claims: rendered.claims,
          assertions: rendered.assertions,
          evidenceManifestHash,
          contentHash,
          limitations,
          producedInPhase: 'drafting',
          createdAt: this.#now(),
          resultManifestRef: typedResult.resultManifestRef,
          resultManifestDigest: typedResult.resultManifestDigest,
          finalizationReceiptRef: typedResult.finalizationReceiptRef,
          finalizationReceiptDigest: typedResult.finalizationReceiptDigest,
          executionBindingRef: typedResult.executionBindingRef,
        },
        usage: { durationMs: 0, calls: 0, modelTokens: 0 },
        evidenceRefs: usedEvidenceRefs,
        ...(limitations.length === 0 ? {} : { limitations }),
      }
    }

    const contentHash = answerDraftContentHash(
      request.runId,
      blocks,
      evidenceManifestHash,
      rendered.claims,
      rendered.assertions,
      { schemaVersion: 'answer-draft@2', limitations },
    )
    return {
      draft: {
        draftId: stableUuid(`draft:${request.runId}:${evidenceManifestHash}:v2`),
        runId: request.runId,
        schemaVersion: 'answer-draft@2',
        blocks,
        claims: rendered.claims,
        assertions: rendered.assertions,
        evidenceManifestHash,
        contentHash,
        limitations,
        producedInPhase: 'drafting',
        createdAt: this.#now(),
      },
      usage: { durationMs: 0, calls: 0, modelTokens: 0 },
      evidenceRefs: usedEvidenceRefs,
      ...(limitations.length === 0 ? {} : { limitations }),
    }
  }

  async #readPayload(scopeRef: ScopeRef, record: EvidenceRecord, ctx: ToolContext): Promise<Record<string, unknown> | undefined> {
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) return undefined
    try {
      const authorized = await this.#options.artifacts.getAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      if (!authorized.integrityVerified) return undefined
      const bytes = await this.#options.artifacts.readAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return isRecord(decoded) ? decoded : undefined
    } catch {
      return undefined
    }
  }

  #renderEvidence(
    record: EvidenceRecord,
    payload: Record<string, unknown>,
    evidenceRef: ResourceRef,
    runId: Uuid,
    preview?: { readonly businessFields: ReadonlySet<string>; readonly maxStatements: number },
  ): Rendered {
    const resultDigest = record.envelope.resultDigest
    if (isFactPage(payload)) return renderFacts(payload, evidenceRef, resultDigest, runId)
    if (payload['resultKind'] === 'relations' || Array.isArray(payload['edges']) || Array.isArray(payload['paths'])) {
      return renderRelations(payload, evidenceRef, resultDigest, runId)
    }
    if (payload['resultKind'] === 'table' || payload['resultKind'] === 'statistics') {
      return renderTable(payload, evidenceRef, resultDigest, runId, 'table', preview)
    }
    switch (record.envelope.kind) {
      case 'rule_derivation':
        return renderRule(payload, evidenceRef, resultDigest, runId)
      case 'document_span':
        return renderCitation(payload, evidenceRef, resultDigest, runId)
      case 'computation':
        // A presentable compute result renders as a table; the registered operation path emits
        // only `computation.metrics`, which is projected into row-bound quantity/money claims.
        return isRecord(payload['table'])
          ? renderTable(payload, evidenceRef, resultDigest, runId, 'computation', preview)
          : renderComputeMetrics(payload, evidenceRef, resultDigest, runId)
      default: {
        const rendered = emptyRendered()
        rendered.limitations.push('evidence_unsupported')
        return rendered
      }
    }
  }
}
