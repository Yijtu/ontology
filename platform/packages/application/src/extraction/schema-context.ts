import type { IndustryRuleGrammar, IndustrySchema, Sha256Digest } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from './canonical'

/**
 * The fixed schema context injected into every instance-extraction model request
 * (SPEC v0.3 A §5.3, A.US-004/P.US-008/P.FR-12).
 *
 * The authoritative published definition version is narrowed to the `IndustrySchema`
 * projection, then rendered as one canonical, digest-addressed artifact. It carries the
 * fixed object/attribute types, cardinalities, units, enums, relation endpoints, identity
 * scopes, the declared rule constraints and the frozen rule grammar/support limits, plus
 * the exact-decimal rule. The request records `promptVersion` and `schemaDigest`, so a
 * reviewer can prove which constraints the model actually saw.
 *
 * It is pure: it reads the schema projection and never mutates a definition or a candidate.
 */

/** A fixed, code-owned version of the schema-context template. Bump when the shape changes. */
export const EXTRACTION_SCHEMA_PROMPT_VERSION = 'extraction-schema-context@1'

/**
 * The frozen rule subset the semantic engine can publish and evaluate (EX-4.1/§5.2). It is
 * declared to the model up front so an unsupported form is never proposed and then dropped.
 */
export const SUPPORTED_RULE_GRAMMAR: IndustryRuleGrammar = {
  comparisonOperators: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
  operators: ['all', 'any', 'not', 'compare', 'range', 'relation'],
  maxRelationDepth: 3,
  allowsRuleReferences: false,
  maxRuleDependencyLevels: 3,
}

const DECIMAL_RULE =
  'A quantity or measurement is an exact decimal string matching ^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$ ' +
  '(no exponent, no JSON number, no rounding); keep the verbatim source token separately as raw.'

export interface SchemaContext {
  readonly promptVersion: string
  /** The canonical schema-context text injected verbatim into the request system message. */
  readonly content: string
  readonly digest: Sha256Digest
  readonly grammar: IndustryRuleGrammar
}

/**
 * Render the published schema into the canonical context artifact. The result is
 * deterministic for a fixed schema projection, so the digest changes only when the schema
 * (or the template version) changes.
 */
export function buildSchemaContext(schema: IndustrySchema): SchemaContext {
  const body = {
    promptVersion: EXTRACTION_SCHEMA_PROMPT_VERSION,
    namespace: schema.namespace,
    definition: {
      id: schema.definitionRef.id,
      version: schema.definitionRef.version,
      digest: schema.definitionRef.digest,
    },
    decimal: DECIMAL_RULE,
    objects: schema.objects.map((object) => ({
      objectId: object.objectId,
      displayName: object.displayName,
      identityScopeId: object.identityScopeId,
      attributes: object.attributes.map((attribute) => ({
        attributeId: attribute.attributeId,
        valueType: attribute.valueType,
        minCardinality: attribute.minCardinality,
        maxCardinality: attribute.maxCardinality,
        identityKey: attribute.identityKey,
        ...(attribute.unitCode === undefined ? {} : { unitCode: attribute.unitCode }),
        ...(attribute.dimension === undefined ? {} : { dimension: attribute.dimension }),
        ...(attribute.enumValues === undefined ? {} : { enumValues: attribute.enumValues }),
        ...(attribute.referencesObjectId === undefined
          ? {}
          : { referencesObjectId: attribute.referencesObjectId }),
      })),
    })),
    relations: schema.relations.map((relation) => ({
      relationId: relation.relationId,
      fromObjectId: relation.fromObjectId,
      toObjectId: relation.toObjectId,
      minCardinality: relation.minCardinality,
      maxCardinality: relation.maxCardinality,
    })),
    identityScopes: schema.identityScopes.map((scope) => ({
      identityScopeId: scope.identityScopeId,
      objectId: scope.objectId,
      scopeDimensions: scope.scopeDimensions,
      identityAttributeIds: scope.identityAttributeIds,
    })),
    ruleGrammar: SUPPORTED_RULE_GRAMMAR,
    ruleConstraints: schema.ruleConstraints ?? [],
  }
  const content = canonicalJson(body)
  return {
    promptVersion: EXTRACTION_SCHEMA_PROMPT_VERSION,
    content,
    digest: sha256DigestOf(content),
    grammar: SUPPORTED_RULE_GRAMMAR,
  }
}
