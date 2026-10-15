import { isRecord, isUuid, isVersionRef } from '@ontology/contracts'
import type { AssetCandidateVersion, ScopeRef, VersionRef } from '@ontology/contracts'
import { invalidWire } from './ontology'

export interface FormalObjectView { readonly objectId: string; readonly displayName: string; readonly identityScopeId: string }
export interface FormalAttributeView { readonly attributeId: string; readonly objectId: string; readonly valueType: 'string' | 'number' | 'boolean' | 'timestamp' | 'enum' | 'quantity' | 'reference'; readonly min: number; readonly max: number | 'unbounded'; readonly unitCode?: string; readonly dimension?: string; readonly enumValues?: readonly string[]; readonly referencesObjectId?: string }
export interface FormalRelationView { readonly relationId: string; readonly fromObjectId: string; readonly toObjectId: string }
export interface FormalDefinitionView { readonly ref: VersionRef; readonly scopeRef: ScopeRef; readonly objects: readonly FormalObjectView[]; readonly attributes: readonly FormalAttributeView[]; readonly relations: readonly FormalRelationView[]; readonly identityScopes: readonly { readonly identityScopeId: string; readonly objectId: string; readonly scopeDimensions: readonly string[]; readonly identityAttributeIds: readonly string[] }[] }
export interface TermLabelsView { readonly attributes: readonly { readonly objectId: string; readonly attributeId: string; readonly displayName: string }[]; readonly relations: readonly { readonly relationId: string; readonly displayName: string }[] }
const text = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 ? value : invalidWire()
const strings = (value: unknown): readonly string[] => Array.isArray(value) && value.length <= 250 && value.every((row): row is string => typeof row === 'string' && row.length > 0) ? value : invalidWire()
const rows = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) && value.length <= 250 && value.every(isRecord) ? value : invalidWire()
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalidWire()
const unique = (ids: readonly string[]) => { if (new Set(ids).size !== ids.length) return invalidWire() }
export function parseFormalDefinition(value: unknown): FormalDefinitionView {
  if (!isRecord(value) || !isVersionRef(value['ref']) || !isRecord(value['scopeRef']) || !isUuid(value['scopeRef']['tenantId']) || !isUuid(value['scopeRef']['spaceId'])) return invalidWire()
  const objects = rows(value['objects']).map((row): FormalObjectView => { if (row['kind'] !== 'object') return invalidWire(); return { objectId: text(row['id']), displayName: text(row['displayName']), identityScopeId: text(row['identityScopeId']) } })
  const attributes = rows(value['attributes']).map((row): FormalAttributeView => {
    if (row['kind'] !== 'attribute' || !isRecord(row['cardinality'])) return invalidWire()
    const valueType = row['valueType']; if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean' && valueType !== 'timestamp' && valueType !== 'enum' && valueType !== 'quantity' && valueType !== 'reference') return invalidWire()
    const min = integer(row['cardinality']['min']), max = row['cardinality']['max'] === 'unbounded' ? 'unbounded' : integer(row['cardinality']['max'])
    if (max !== 'unbounded' && max < min || valueType === 'quantity' && !isRecord(row['unit']) || valueType !== 'quantity' && row['unit'] !== undefined) return invalidWire()
    return { attributeId: text(row['id']), objectId: text(row['objectId']), valueType, min, max, ...(isRecord(row['unit']) ? { unitCode: text(row['unit']['unitCode']), dimension: text(row['unit']['dimension']) } : {}), ...(valueType === 'enum' ? { enumValues: strings(row['enumValues']) } : {}), ...(valueType === 'reference' ? { referencesObjectId: text(row['referencesObjectId']) } : {}) }
  })
  const relations = rows(value['relations']).map((row): FormalRelationView => { if (row['kind'] !== 'relation') return invalidWire(); return { relationId: text(row['id']), fromObjectId: text(row['fromObjectId']), toObjectId: text(row['toObjectId']) } })
  const identityScopes = rows(value['identityScopes']).map((row) => { if (row['kind'] !== 'identity_scope') return invalidWire(); return { identityScopeId: text(row['id']), objectId: text(row['objectId']), scopeDimensions: strings(row['scopeDimensions']), identityAttributeIds: strings(row['identityAttributeIds']) } })
  unique(objects.map((row) => row.objectId)); unique(attributes.map((row) => row.attributeId)); unique(relations.map((row) => row.relationId)); unique(identityScopes.map((row) => row.identityScopeId))
  if (attributes.some((row) => !objects.some((object) => object.objectId === row.objectId) || row.referencesObjectId !== undefined && !objects.some((object) => object.objectId === row.referencesObjectId)) || relations.some((row) => !objects.some((object) => object.objectId === row.fromObjectId) || !objects.some((object) => object.objectId === row.toObjectId)) || identityScopes.some((row) => !objects.some((object) => object.objectId === row.objectId && object.identityScopeId === row.identityScopeId) || row.identityAttributeIds.some((id) => !attributes.some((attribute) => attribute.objectId === row.objectId && attribute.attributeId === id)))) return invalidWire()
  return { ref: value['ref'], scopeRef: { tenantId: value['scopeRef']['tenantId'], spaceId: value['scopeRef']['spaceId'] }, objects, attributes, relations, identityScopes }
}
export function parseTermLabels(value: unknown, definition: FormalDefinitionView): TermLabelsView {
  if (!isRecord(value)) return invalidWire()
  const attributes = rows(value['attributes']).map((row) => ({ objectId: text(row['objectId']), attributeId: text(row['attributeId']), displayName: text(row['displayName']) })), relations = rows(value['relations']).map((row) => ({ relationId: text(row['relationId']), displayName: text(row['displayName']) }))
  unique(attributes.map((row) => `${row.objectId}:${row.attributeId}`)); unique(relations.map((row) => row.relationId))
  if (attributes.some((row) => !definition.attributes.some((attribute) => attribute.objectId === row.objectId && attribute.attributeId === row.attributeId)) || relations.some((row) => !definition.relations.some((relation) => relation.relationId === row.relationId))) return invalidWire()
  return { attributes, relations }
}
export function formalAttributeLabel(attribute: FormalAttributeView, labels?: TermLabelsView): string { return labels?.attributes.find((row) => row.objectId === attribute.objectId && row.attributeId === attribute.attributeId)?.displayName ?? '未提供名称' }

export interface EditorAttributeChoice extends FormalAttributeView { readonly displayName: string }
export interface EditorRelationChoice extends FormalRelationView { readonly displayName: string }
/** Plain named choices retain real semantic IDs; inherited terms never become fake candidates. */
export function editorObjectChoices(candidates: readonly AssetCandidateVersion[], definition?: FormalDefinitionView) {
  return [...new Map([...(definition?.objects ?? []).map((row) => ({ objectId: row.objectId, displayName: row.displayName })), ...candidates.flatMap((row) => row.payload.kind === 'object' ? [{ objectId: row.logicalId, displayName: row.payload.displayName }] : [])].map((row) => [row.objectId, row])).values()]
}
export function editorAttributeChoices(candidates: readonly AssetCandidateVersion[], definition?: FormalDefinitionView, labels?: TermLabelsView): readonly EditorAttributeChoice[] {
  const current = candidates.flatMap((row): EditorAttributeChoice[] => row.payload.kind !== 'attribute' ? [] : [{ attributeId: row.logicalId, objectId: row.payload.objectLogicalId, displayName: row.payload.displayName, valueType: row.payload.valueType, min: row.payload.minCardinality, max: row.payload.maxCardinality, ...(row.payload.unitCode === undefined ? {} : { unitCode: row.payload.unitCode }), ...(row.payload.dimension === undefined ? {} : { dimension: row.payload.dimension }), ...(row.payload.enumValues === undefined ? {} : { enumValues: row.payload.enumValues }), ...(row.payload.referencesObjectLogicalId === undefined ? {} : { referencesObjectId: row.payload.referencesObjectLogicalId }) }])
  return [...new Map([...(definition?.attributes ?? []).map((row) => ({ ...row, displayName: formalAttributeLabel(row, labels) })), ...current].map((row) => [row.attributeId, row])).values()]
}
export function editorRelationChoices(candidates: readonly AssetCandidateVersion[], definition?: FormalDefinitionView, labels?: TermLabelsView): readonly EditorRelationChoice[] {
  const current = candidates.flatMap((row) => row.payload.kind === 'relation' ? [{ relationId: row.logicalId, fromObjectId: row.payload.fromObjectLogicalId, toObjectId: row.payload.toObjectLogicalId, displayName: row.payload.displayName }] : [])
  return [...new Map([...(definition?.relations ?? []).map((row) => ({ ...row, displayName: labels?.relations.find((label) => label.relationId === row.relationId)?.displayName ?? '未提供名称' })), ...current].map((row) => [row.relationId, row])).values()]
}
