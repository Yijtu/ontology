import type {
  IndustryAttributeSchema,
  IndustryIdentityScopeSchema,
  IndustryObjectSchema,
  IndustryRelationSchema,
  IndustrySchema,
} from '@ontology/contracts'
import type { AttributeDefinition, SemanticDefinitionVersion } from './types'

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
  }
}
