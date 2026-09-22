import type { StandardProvenance } from '@ontology/contracts'

/**
 * Structural shape of the `home-energy` declaration pack (SPEC E1–E3, C1; ADR-10, INV-03).
 *
 * The pack may import `@ontology/contracts` only, so these interfaces mirror the
 * semantic-engine definition model structurally instead of importing it. The test suite
 * assigns the pack content to `SemanticDefinitionVersionDraft`, so any drift from the
 * published definition contract is a compile error rather than a silent divergence.
 *
 * Everything here is declaration data: no SDK type, no connection address, no credential,
 * no physical column name and no executable script. Physical naming lives in a customer
 * mapping outside the pack.
 */

export type HomeEnergyAttributeValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'enum'
  | 'quantity'
  | 'reference'

export interface HomeEnergyCardinality {
  readonly min: number
  readonly max: number | 'unbounded'
}

/** Canonical unit plus the physical dimension it measures (e.g. kWh / energy). */
export interface HomeEnergyUnitRef {
  readonly unitCode: string
  readonly dimension: string
}

export interface HomeEnergyObjectDefinition {
  readonly kind: 'object'
  readonly id: string
  readonly namespace: string
  readonly displayName: string
  readonly identityScopeId: string
  readonly standardProvenance: readonly StandardProvenance[]
}

export interface HomeEnergyAttributeDefinition {
  readonly kind: 'attribute'
  readonly id: string
  readonly namespace: string
  readonly objectId: string
  readonly valueType: HomeEnergyAttributeValueType
  readonly cardinality: HomeEnergyCardinality
  readonly identityKey?: boolean
  readonly unit?: HomeEnergyUnitRef
  readonly enumValues?: readonly string[]
  readonly referencesObjectId?: string
  readonly standardProvenance: readonly StandardProvenance[]
}

export interface HomeEnergyRelationDefinition {
  readonly kind: 'relation'
  readonly id: string
  readonly namespace: string
  readonly fromObjectId: string
  readonly toObjectId: string
  readonly cardinality: HomeEnergyCardinality
  readonly standardProvenance: readonly StandardProvenance[]
}

export interface HomeEnergyIdentityScopeDefinition {
  readonly kind: 'identity_scope'
  readonly id: string
  readonly namespace: string
  readonly objectId: string
  readonly scopeDimensions: readonly string[]
  readonly identityAttributeIds: readonly string[]
  readonly standardProvenance: readonly StandardProvenance[]
}

export type HomeEnergyComparisonOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

export type HomeEnergyRuleExpression =
  | { readonly op: 'all'; readonly operands: readonly HomeEnergyRuleExpression[] }
  | { readonly op: 'any'; readonly operands: readonly HomeEnergyRuleExpression[] }
  | { readonly op: 'not'; readonly operand: HomeEnergyRuleExpression }
  | {
      readonly op: 'compare'
      readonly attributeId: string
      readonly operator: HomeEnergyComparisonOperator
      readonly value: string | number | boolean
    }
  | {
      readonly op: 'range'
      readonly attributeId: string
      readonly min?: number
      readonly max?: number
      readonly unit?: HomeEnergyUnitRef
    }
  | { readonly op: 'relation'; readonly relationId: string }

export interface HomeEnergyRuleConstraintDefinition {
  readonly kind: 'rule_constraint'
  readonly id: string
  readonly namespace: string
  readonly objectId: string
  readonly severity: 'hard' | 'soft'
  readonly expression: HomeEnergyRuleExpression
  readonly standardProvenance: readonly StandardProvenance[]
}

/**
 * A complete industry-core declaration version minus the trusted tenant/space scope.
 *
 * The scope is deliberately absent: a shared pack carries no customer instance data, and
 * the definition service mints the scope from the trusted context at publication time.
 */
export interface HomeEnergyDefinitionContent {
  readonly definitionId: string
  readonly version: string
  readonly namespace: string
  readonly layer: 'industry_core'
  readonly standardProvenance: readonly StandardProvenance[]
  readonly objects: readonly HomeEnergyObjectDefinition[]
  readonly attributes: readonly HomeEnergyAttributeDefinition[]
  readonly relations: readonly HomeEnergyRelationDefinition[]
  readonly identityScopes: readonly HomeEnergyIdentityScopeDefinition[]
  readonly ruleConstraints: readonly HomeEnergyRuleConstraintDefinition[]
}
