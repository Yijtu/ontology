import type {
  AttributeDefinition,
  IndustryAttributeSchema,
  IndustryIdentityScopeSchema,
  IndustryObjectSchema,
  IndustryRelationSchema,
  IndustryRuleConstraintSchema,
  IndustryRuleExpression,
  IndustrySchema,
  RuleExpression,
  SemanticDefinitionVersion,
} from '@ontology/contracts'

/**
 * Read-only projection of a published definition version into the extraction contract
 * (`IndustrySchema`). The authoritative model stays in this package; the projection only
 * narrows it to what candidate validation and native identifier mapping consume, so the
 * application layer never imports the definition service.
 *
 * It is pure and side-effect free: it reads a version and returns a new value. It cannot
 * mutate the definition, and a candidate produced from the result can never write back.
 */
function toAttributeSchema(attribute: AttributeDefinition): IndustryAttributeSchema {
  return {
    attributeId: attribute.id,
    valueType: attribute.valueType,
    minCardinality: attribute.cardinality.min,
    maxCardinality: attribute.cardinality.max,
    identityKey: attribute.identityKey === true,
    ...(attribute.unit === undefined
      ? {}
      : { unitCode: attribute.unit.unitCode, dimension: attribute.unit.dimension }),
    ...(attribute.enumValues === undefined ? {} : { enumValues: attribute.enumValues }),
    ...(attribute.referencesObjectId === undefined
      ? {}
      : { referencesObjectId: attribute.referencesObjectId }),
  }
}

function toRuleExpression(expression: RuleExpression): IndustryRuleExpression {
  switch (expression.op) {
    case 'all':
      return { op: 'all', operands: expression.operands.map(toRuleExpression) }
    case 'any':
      return { op: 'any', operands: expression.operands.map(toRuleExpression) }
    case 'not':
      return { op: 'not', operand: toRuleExpression(expression.operand) }
    case 'compare':
      return {
        op: 'compare',
        attributeId: expression.attributeId,
        operator: expression.operator,
        value: expression.value,
      }
    case 'range':
      return {
        op: 'range',
        attributeId: expression.attributeId,
        ...(expression.min === undefined ? {} : { min: expression.min }),
        ...(expression.max === undefined ? {} : { max: expression.max }),
        ...(expression.unit === undefined ? {} : { unitCode: expression.unit.unitCode }),
      }
    case 'relation':
      return { op: 'relation', relationId: expression.relationId }
  }
}

function toRuleConstraintSchema(rule: SemanticDefinitionVersion['ruleConstraints'][number]): IndustryRuleConstraintSchema {
  return {
    ruleId: rule.id,
    objectId: rule.objectId,
    severity: rule.severity,
    expression: toRuleExpression(rule.expression),
  }
}

export function projectIndustrySchema(version: SemanticDefinitionVersion): IndustrySchema {
  const objects: IndustryObjectSchema[] = version.objects.map((object) => ({
    objectId: object.id,
    displayName: object.displayName,
    identityScopeId: object.identityScopeId,
    attributes: version.attributes
      .filter((attribute) => attribute.objectId === object.id)
      .map(toAttributeSchema),
  }))

  const relations: IndustryRelationSchema[] = version.relations.map((relation) => ({
    relationId: relation.id,
    fromObjectId: relation.fromObjectId,
    toObjectId: relation.toObjectId,
    minCardinality: relation.cardinality.min,
    maxCardinality: relation.cardinality.max,
  }))

  const identityScopes: IndustryIdentityScopeSchema[] = version.identityScopes.map((scope) => ({
    identityScopeId: scope.id,
    objectId: scope.objectId,
    scopeDimensions: [...scope.scopeDimensions],
    identityAttributeIds: [...scope.identityAttributeIds],
  }))

  return {
    namespace: version.namespace,
    definitionRef: version.ref,
    objects,
    relations,
    identityScopes,
    ruleConstraints: version.ruleConstraints.map(toRuleConstraintSchema),
  }
}
