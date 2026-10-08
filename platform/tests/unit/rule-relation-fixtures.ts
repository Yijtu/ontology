import type { RuleExpressionNode, ScopeRef, SemanticDefinitionVersion } from '@ontology/contracts'
import { definitionVersionDigest } from '@ontology/semantic-engine'

export const targetCondition: RuleExpressionNode = { op: 'all', operands: [
  { op: 'compare', attributeId: 'active', operator: 'eq', value: true, spans: [] },
  { op: 'any', operands: [
    { op: 'range', attributeId: 'power', min: 10, max: 20, unitCode: 'kW', spans: [] },
    { op: 'compare', attributeId: 'alarm', operator: 'eq', value: true, spans: [] },
  ], spans: [] },
], spans: [] }

export const relationCondition: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', targetCondition, spans: [] }

export function relationDefinition(scopeRef: ScopeRef): SemanticDefinitionVersion {
  const common = { namespace: 'relation-test', standardProvenance: [] } as const
  const draft = {
    ...common, scopeRef, definitionId: 'relation.core', version: '1.0.0', layer: 'industry_core' as const,
    objects: ['site', 'meter'].map((id) => ({ ...common, kind: 'object' as const, id, displayName: id, identityScopeId: `${id}_identity` })),
    attributes: [
      ...['site', 'meter'].map((objectId) => ({ ...common, kind: 'attribute' as const, id: `${objectId}_id`, objectId, valueType: 'string' as const, identityKey: true, cardinality: { min: 1, max: 1 } })),
      ...['active', 'alarm'].map((id) => ({ ...common, kind: 'attribute' as const, id, objectId: 'meter', valueType: 'boolean' as const, cardinality: { min: 0, max: 1 } })),
      { ...common, kind: 'attribute' as const, id: 'power', objectId: 'meter', valueType: 'quantity' as const, unit: { unitCode: 'kW', dimension: 'power' }, cardinality: { min: 0, max: 1 } },
    ],
    relations: [{ ...common, kind: 'relation' as const, id: 'meter_of', fromObjectId: 'site', toObjectId: 'meter', cardinality: { min: 0, max: 'unbounded' as const } }],
    identityScopes: ['site', 'meter'].map((objectId) => ({ ...common, kind: 'identity_scope' as const, id: `${objectId}_identity`, objectId, identityAttributeIds: [`${objectId}_id`], scopeDimensions: ['project'] })),
    ruleConstraints: [],
  }
  return { ...draft, ref: { id: draft.definitionId, version: draft.version, digest: definitionVersionDigest(draft) }, publishedAt: '2026-10-01T00:00:00Z' }
}

/** Independently invalid scalar/operator/unit domains for the pinned meter attributes. */
export const invalidRelationTargets: readonly { readonly name: string; readonly targetCondition: RuleExpressionNode }[] = [
  { name: 'boolean ne string', targetCondition: { op: 'compare', attributeId: 'active', operator: 'ne', value: 'true', spans: [] } },
  { name: 'string ne boolean', targetCondition: { op: 'compare', attributeId: 'meter_id', operator: 'ne', value: true, spans: [] } },
  { name: 'boolean ordered comparison', targetCondition: { op: 'compare', attributeId: 'active', operator: 'gt', value: true, spans: [] } },
  { name: 'boolean range', targetCondition: { op: 'range', attributeId: 'active', min: 0, max: 1, spans: [] } },
  { name: 'quantity comparison missing unit', targetCondition: { op: 'compare', attributeId: 'power', operator: 'gte', value: 10, spans: [] } },
  { name: 'quantity comparison wrong unit', targetCondition: { op: 'compare', attributeId: 'power', operator: 'gte', value: 10, unitCode: 'W', spans: [] } },
  { name: 'quantity range missing unit', targetCondition: { op: 'range', attributeId: 'power', min: 10, max: 20, spans: [] } },
  { name: 'quantity range wrong unit', targetCondition: { op: 'range', attributeId: 'power', min: 10, max: 20, unitCode: 'W', spans: [] } },
  { name: 'quantity comparison nonnumeric string', targetCondition: { op: 'compare', attributeId: 'power', operator: 'ne', value: 'high', unitCode: 'kW', spans: [] } },
  { name: 'categorical ordered comparison', targetCondition: { op: 'compare', attributeId: 'meter_id', operator: 'gt', value: 'same-name', spans: [] } },
  { name: 'unit on boolean', targetCondition: { op: 'compare', attributeId: 'active', operator: 'eq', value: true, unitCode: 'kW', spans: [] } },
  { name: 'invalid leaf inside any', targetCondition: { op: 'any', operands: [{ op: 'compare', attributeId: 'active', operator: 'eq', value: true, spans: [] }, { op: 'compare', attributeId: 'active', operator: 'ne', value: 'true', spans: [] }], spans: [] } },
  { name: 'invalid leaf inside all', targetCondition: { op: 'all', operands: [{ op: 'compare', attributeId: 'active', operator: 'eq', value: true, spans: [] }, { op: 'range', attributeId: 'power', min: 10, spans: [] }], spans: [] } },
  { name: 'reversed range', targetCondition: { op: 'range', attributeId: 'power', min: 20, max: 10, unitCode: 'kW', spans: [] } },
]
