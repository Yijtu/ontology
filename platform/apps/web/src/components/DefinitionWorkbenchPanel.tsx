import { OntologyReviewWorkbench } from './ontology/OntologyReviewWorkbench'
import type {
  AssetCandidateVersion,
  DefinitionCandidatePayload,
  IndustryAttributeValueType,
} from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'

/**
 * The public definition / rule / action review workbench (V03-012 / #185, SPEC v0.3a §9.2,
 * A.US-003, P.US-004/005/006/007).
 *
 * It lists the definition (object/attribute/relation) candidates with their source, conflicts and
 * generation-vs-draft drift, the rule candidates with their preserved condition, exceptions,
 * applicability and support state, and the action declarations with their capability binding.
 * Editing, rejecting, merging terminology, revising a rule and recording an unsupported rule all
 * call the real management endpoints over If-Match/CAS, so a stale head is refused instead of
 * silently overwritten. A rule outside the executable subset or an unbound/incompatible action is
 * shown with its classified reason and cannot be enabled.
 *
 * The panel is generic: it never names an industry and it mounts no professional view. Scenario UI
 * stays behind the V03-022 mount registry; this panel is injected as the public home.
 */

export interface DefinitionWorkbenchPanelProps {
  readonly client: WorkbenchClient
  readonly workspaceId: string
  readonly readOnly?: boolean
}

export interface DefinitionEditFields {
  displayName: string
  businessMeaning: string
  suggestedReason: string
  valueType: string
  unitCode: string
  fromObjectLogicalId: string
  toObjectLogicalId: string
  identityAttributeIds: string
  reason: string
}

const VALUE_TYPES: readonly IndustryAttributeValueType[] = [
  'string',
  'number',
  'boolean',
  'timestamp',
  'enum',
  'quantity',
  'reference',
]

function isValueType(value: string): value is IndustryAttributeValueType {
  return (VALUE_TYPES as readonly string[]).includes(value)
}

export const EMPTY_EDIT_FIELDS: DefinitionEditFields = {
  displayName: '',
  businessMeaning: '',
  suggestedReason: '',
  valueType: 'string',
  unitCode: '',
  fromObjectLogicalId: '',
  toObjectLogicalId: '',
  identityAttributeIds: '',
  reason: '',
}

export function editFieldsOf(candidate: AssetCandidateVersion): DefinitionEditFields {
  const payload = candidate.payload
  return {
    displayName: payload.displayName,
    businessMeaning: payload.businessMeaning,
    suggestedReason: payload.suggestedReason,
    valueType: payload.kind === 'attribute' ? payload.valueType : 'string',
    unitCode: payload.kind === 'attribute' ? (payload.unitCode ?? '') : '',
    fromObjectLogicalId: payload.kind === 'relation' ? payload.fromObjectLogicalId : '',
    toObjectLogicalId: payload.kind === 'relation' ? payload.toObjectLogicalId : '',
    identityAttributeIds: payload.kind === 'object' ? payload.identityAttributeIds.join(', ') : '',
    reason: '',
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Apply the human edit to the existing candidate payload. The `kind` and every field the form does
 * not touch are preserved, so an edit can never loosen an unrelated type, unit or cardinality.
 */
export function buildEditedPayload(
  payload: DefinitionCandidatePayload,
  fields: DefinitionEditFields,
): DefinitionCandidatePayload {
  const displayName = fields.displayName.trim().length === 0 ? payload.displayName : fields.displayName.trim()
  const businessMeaning = fields.businessMeaning.trim()
  const suggestedReason = fields.suggestedReason.trim()
  const common = {
    logicalId: payload.logicalId,
    displayName,
    businessMeaning: businessMeaning.length === 0 ? payload.businessMeaning : businessMeaning,
    suggestedReason: suggestedReason.length === 0 ? payload.suggestedReason : suggestedReason,
  }
  if (payload.kind === 'object') {
    const identityAttributeIds = splitList(fields.identityAttributeIds)
    return {
      ...payload,
      ...common,
      identityAttributeIds: identityAttributeIds.length === 0 ? payload.identityAttributeIds : identityAttributeIds,
    }
  }
  if (payload.kind === 'attribute') {
    const valueType: IndustryAttributeValueType = isValueType(fields.valueType) ? fields.valueType : payload.valueType
    const unitCode = fields.unitCode.trim()
    return {
      ...payload,
      ...common,
      valueType,
      ...(unitCode.length === 0
        ? payload.unitCode === undefined
          ? {}
          : { unitCode: payload.unitCode }
        : { unitCode }),
    }
  }
  return {
    ...payload,
    ...common,
    fromObjectLogicalId:
      fields.fromObjectLogicalId.trim().length === 0 ? payload.fromObjectLogicalId : fields.fromObjectLogicalId.trim(),
    toObjectLogicalId:
      fields.toObjectLogicalId.trim().length === 0 ? payload.toObjectLogicalId : fields.toObjectLogicalId.trim(),
  }
}

export type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

export function parseJsonText(text: string): JsonParseResult {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'JSON 解析失败' }
  }
}

export function candidateSourceLabel(candidate: AssetCandidateVersion): string {
  if (candidate.sourceRefs.length === 0) return '无来源定位'
  const first = candidate.sourceRefs[0]
  return first === undefined ? '无来源定位' : `${candidate.sourceRefs.length} 项（${first.id.slice(0, 8)}…）`
}

export function isCandidateStale(candidate: AssetCandidateVersion, headRevision: string | undefined): boolean {
  return headRevision !== undefined && candidate.inputDraftRef.revision !== headRevision
}

/** The kind-specific contract a reviewer checks before editing: type/unit, endpoints or identity. */
export function candidateDetailLabel(payload: DefinitionCandidatePayload): string {
  if (payload.kind === 'object') {
    return `身份属性：${payload.identityAttributeIds.length === 0 ? '（未声明）' : payload.identityAttributeIds.join('、')}`
  }
  if (payload.kind === 'attribute') {
    const max = payload.maxCardinality === 'unbounded' ? '*' : String(payload.maxCardinality)
    const unit = payload.unitCode === undefined ? '（无单位）' : payload.unitCode
    return `类型：${payload.valueType} · 单位：${unit} · 基数：${String(payload.minCardinality)}..${max}`
  }
  const max = payload.maxCardinality === 'unbounded' ? '*' : String(payload.maxCardinality)
  return `端点：${payload.fromObjectLogicalId} → ${payload.toObjectLogicalId} · 基数：${String(payload.minCardinality)}..${max}`
}

export function DefinitionWorkbenchPanel(props: DefinitionWorkbenchPanelProps) {
  return <OntologyReviewWorkbench {...props} />
}
