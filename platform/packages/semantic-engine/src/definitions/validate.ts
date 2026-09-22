import { findIndustryPackViolations } from '@ontology/contracts'
import type {
  AttributeDefinition,
  AttributeValueType,
  Cardinality,
  IdentityScopeDefinition,
  ObjectDefinition,
  ProvenanceKind,
  RelationDefinition,
  SemanticDefinitionVersion,
  SemanticDefinitionVersionDraft,
  Sha256Digest,
  UnitRef,
} from '@ontology/contracts'
import { definitionKey, isDefinitionIdentifier, isNamespace, isSemverValue, isSha256DigestValue, isUnitCode, sha256DigestOf } from './canonical'
import type { DefinitionValidationIssue } from './errors'

/**
 * Pure, side-effect-free validation of a definition version (SPEC D2–D4, INV-03).
 *
 * Every rule returns classified issues with a precise pointer. Nothing is dropped and no
 * default is substituted: a dangling reference, a contradictory cardinality, a missing
 * unit or an invalid standard provenance all block publication. The service turns the
 * non-empty result into an explicit `INVALID_DEFINITION` error.
 */

const PROVENANCE_KINDS: ReadonlySet<string> = new Set<ProvenanceKind>([
  'international_standard',
  'national_standard',
  'industry_standard',
  'vendor_specification',
  'internal_policy',
  'synthetic_assumption',
])

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])
const NUMERIC_OPERATORS: ReadonlySet<string> = new Set(['lt', 'lte', 'gt', 'gte'])

function isNumericValueType(valueType: AttributeValueType): boolean {
  return valueType === 'number' || valueType === 'quantity'
}

function issue(
  out: DefinitionValidationIssue[],
  code: DefinitionValidationIssue['code'],
  pointer: string,
  reason: string,
): void {
  out.push({ code, pointer, reason })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateStandardProvenance(
  provenance: unknown,
  pointer: string,
  out: DefinitionValidationIssue[],
): void {
  if (!Array.isArray(provenance) || provenance.length === 0) {
    issue(out, 'STANDARD_PROVENANCE_MISSING', pointer, 'at least one published standard source is required')
    return
  }
  provenance.forEach((entry, index) => {
    const at = `${pointer}[${index}]`
    if (!isRecord(entry) || !isRecord(entry.standardRef)) {
      issue(out, 'STANDARD_PROVENANCE_INVALID', at, 'standard provenance must be an object with a standardRef')
      return
    }
    if (typeof entry.standardRef.id !== 'string' || entry.standardRef.id.trim().length === 0) {
      issue(out, 'STANDARD_PROVENANCE_INVALID', `${at}.standardRef.id`, 'standardRef.id must not be empty')
    }
    if (!isSemverValue(entry.standardRef.version)) {
      issue(out, 'STANDARD_PROVENANCE_INVALID', `${at}.standardRef.version`, 'standardRef.version must be semver')
    }
    if (!isSha256DigestValue(entry.standardRef.digest)) {
      issue(
        out,
        'STANDARD_PROVENANCE_INVALID',
        `${at}.standardRef.digest`,
        'standardRef.digest must be sha256:<64 lowercase hex>',
      )
    }
    if (typeof entry.provenanceKind !== 'string' || !PROVENANCE_KINDS.has(entry.provenanceKind)) {
      issue(out, 'STANDARD_PROVENANCE_INVALID', `${at}.provenanceKind`, 'unknown provenance kind')
    }
    if (entry.clauseRef !== undefined && (typeof entry.clauseRef !== 'string' || entry.clauseRef.trim().length === 0)) {
      issue(out, 'STANDARD_PROVENANCE_INVALID', `${at}.clauseRef`, 'clauseRef must not be empty when present')
    }
  })
}

function validateCardinality(
  cardinality: Cardinality,
  pointer: string,
  out: DefinitionValidationIssue[],
): boolean {
  if (!isRecord(cardinality)) {
    issue(out, 'CARDINALITY_INVALID', pointer, 'cardinality must be an object')
    return false
  }
  let valid = true
  const { min, max } = cardinality
  if (!Number.isInteger(min) || min < 0) {
    issue(out, 'CARDINALITY_INVALID', `${pointer}.min`, 'min must be an integer >= 0')
    valid = false
  }
  if (max !== 'unbounded') {
    if (!Number.isInteger(max) || max < 1) {
      issue(out, 'CARDINALITY_INVALID', `${pointer}.max`, 'max must be an integer >= 1 or "unbounded"')
      valid = false
    } else if (Number.isInteger(min) && min > max) {
      issue(out, 'CARDINALITY_INVALID', `${pointer}.min`, 'min must not exceed max')
      valid = false
    }
  }
  return valid
}

function isExactlyOne(cardinality: Cardinality): boolean {
  return cardinality.min === 1 && cardinality.max === 1
}

function validateUnit(unit: UnitRef, pointer: string, out: DefinitionValidationIssue[]): void {
  if (!isUnitCode(unit.unitCode)) {
    issue(out, 'UNIT_INVALID', `${pointer}.unitCode`, 'unitCode is not a canonical unit token')
  }
  if (!isDefinitionIdentifier(unit.dimension)) {
    issue(out, 'UNIT_INVALID', `${pointer}.dimension`, 'dimension must be a lowercase identifier')
  }
}

interface DefinitionIndex {
  readonly objects: ReadonlyMap<string, ObjectDefinition>
  readonly attributes: ReadonlyMap<string, AttributeDefinition>
  readonly relations: ReadonlyMap<string, RelationDefinition>
  readonly identityScopes: ReadonlyMap<string, IdentityScopeDefinition>
}

function indexDefinitions(
  draft: SemanticDefinitionVersionDraft,
  base: SemanticDefinitionVersion | undefined,
  out: DefinitionValidationIssue[],
): DefinitionIndex {
  // Resolution maps are seeded from the base version so a customer extension (or an
  // evolved core version) can reference core objects/attributes/relations. Duplicate
  // detection below only looks at the draft; shadowing a base definition is rejected by
  // `validateLayerAndBase` for extensions.
  const objects = new Map<string, ObjectDefinition>(base?.objects.map((definition) => [definition.id, definition]))
  const attributes = new Map<string, AttributeDefinition>(
    base?.attributes.map((definition) => [definition.id, definition]),
  )
  const relations = new Map<string, RelationDefinition>(
    base?.relations.map((definition) => [definition.id, definition]),
  )
  const identityScopes = new Map<string, IdentityScopeDefinition>(
    base?.identityScopes.map((definition) => [definition.id, definition]),
  )
  const seen = new Set<string>()

  const register = <T extends { readonly kind: string; readonly id: string; readonly namespace: string }>(
    pointer: string,
    definition: T,
    target: Map<string, T>,
  ): void => {
    const key = definitionKey(definition.kind, definition.id)
    if (seen.has(key)) {
      issue(out, 'DUPLICATE_DEFINITION', `${pointer}.id`, `${definition.kind} "${definition.id}" is declared twice`)
      return
    }
    seen.add(key)
    if (!isDefinitionIdentifier(definition.id)) {
      issue(out, 'INVALID_IDENTIFIER', `${pointer}.id`, 'definition id must be a lowercase identifier')
    }
    if (!isNamespace(definition.namespace)) {
      issue(out, 'INVALID_NAMESPACE', `${pointer}.namespace`, 'namespace is not a valid pack namespace')
    } else if (definition.namespace !== draft.namespace) {
      issue(
        out,
        'NAMESPACE_MISMATCH',
        `${pointer}.namespace`,
        `definition namespace must equal the version namespace "${draft.namespace}"`,
      )
    }
    target.set(definition.id, definition)
  }

  draft.objects.forEach((definition, index) => {
    register(`$.objects[${index}]`, definition, objects)
    validateStandardProvenance(definition.standardProvenance, `$.objects[${index}].standardProvenance`, out)
  })
  draft.attributes.forEach((definition, index) => {
    register(`$.attributes[${index}]`, definition, attributes)
    validateStandardProvenance(definition.standardProvenance, `$.attributes[${index}].standardProvenance`, out)
  })
  draft.relations.forEach((definition, index) => {
    register(`$.relations[${index}]`, definition, relations)
    validateStandardProvenance(definition.standardProvenance, `$.relations[${index}].standardProvenance`, out)
  })
  draft.identityScopes.forEach((definition, index) => {
    register(`$.identityScopes[${index}]`, definition, identityScopes)
    validateStandardProvenance(
      definition.standardProvenance,
      `$.identityScopes[${index}].standardProvenance`,
      out,
    )
  })
  draft.ruleConstraints.forEach((definition, index) => {
    validateStandardProvenance(
      definition.standardProvenance,
      `$.ruleConstraints[${index}].standardProvenance`,
      out,
    )
    if (!isDefinitionIdentifier(definition.id)) {
      issue(out, 'INVALID_IDENTIFIER', `$.ruleConstraints[${index}].id`, 'definition id must be a lowercase identifier')
    }
    const key = definitionKey(definition.kind, definition.id)
    if (seen.has(key)) {
      issue(
        out,
        'DUPLICATE_DEFINITION',
        `$.ruleConstraints[${index}].id`,
        `rule_constraint "${definition.id}" is declared twice`,
      )
    } else {
      seen.add(key)
    }
    if (!isNamespace(definition.namespace)) {
      issue(out, 'INVALID_NAMESPACE', `$.ruleConstraints[${index}].namespace`, 'namespace is not a valid pack namespace')
    } else if (definition.namespace !== draft.namespace) {
      issue(
        out,
        'NAMESPACE_MISMATCH',
        `$.ruleConstraints[${index}].namespace`,
        `definition namespace must equal the version namespace "${draft.namespace}"`,
      )
    }
  })

  return { objects, attributes, relations, identityScopes }
}

function validateObjects(
  draft: SemanticDefinitionVersionDraft,
  index: DefinitionIndex,
  out: DefinitionValidationIssue[],
): void {
  draft.objects.forEach((definition, position) => {
    const pointer = `$.objects[${position}]`
    if (typeof definition.displayName !== 'string' || definition.displayName.trim().length === 0) {
      issue(out, 'INVALID_IDENTIFIER', `${pointer}.displayName`, 'displayName must not be empty')
    }
    const scope = index.identityScopes.get(definition.identityScopeId)
    if (scope === undefined) {
      issue(
        out,
        'IDENTITY_SCOPE_UNKNOWN',
        `${pointer}.identityScopeId`,
        `identity scope "${definition.identityScopeId}" is not defined in this version`,
      )
    } else if (scope.objectId !== definition.id) {
      issue(
        out,
        'IDENTITY_SCOPE_UNKNOWN',
        `${pointer}.identityScopeId`,
        `identity scope "${scope.id}" belongs to object "${scope.objectId}"`,
      )
    }
  })
}

function validateAttributes(
  draft: SemanticDefinitionVersionDraft,
  index: DefinitionIndex,
  out: DefinitionValidationIssue[],
): void {
  draft.attributes.forEach((definition, position) => {
    const pointer = `$.attributes[${position}]`
    if (!index.objects.has(definition.objectId)) {
      issue(
        out,
        'ATTRIBUTE_OBJECT_UNKNOWN',
        `${pointer}.objectId`,
        `attribute object "${definition.objectId}" is not defined in this version`,
      )
    }
    const cardinalityValid = validateCardinality(definition.cardinality, `${pointer}.cardinality`, out)
    if (definition.identityKey === true) {
      if (definition.valueType !== 'string' && definition.valueType !== 'number' && definition.valueType !== 'timestamp') {
        issue(
          out,
          'IDENTITY_ATTRIBUTE_INVALID',
          `${pointer}.valueType`,
          'an identity key must be a string, number or timestamp',
        )
      }
      if (cardinalityValid && !isExactlyOne(definition.cardinality)) {
        issue(
          out,
          'CARDINALITY_KIND_CONFLICT',
          `${pointer}.cardinality`,
          'an identity key is a single required value and cannot be optional or multi-valued',
        )
      }
    }
    if (definition.valueType === 'quantity') {
      if (definition.unit === undefined) {
        issue(out, 'UNIT_REQUIRED', `${pointer}.unit`, 'a quantity attribute must declare a unit')
      } else {
        validateUnit(definition.unit, pointer, out)
      }
    } else if (definition.unit !== undefined) {
      issue(out, 'UNIT_FORBIDDEN', `${pointer}.unit`, 'only a quantity attribute may declare a unit')
    }

    if (definition.valueType === 'enum') {
      const values = definition.enumValues
      if (!Array.isArray(values) || values.length === 0) {
        issue(out, 'ENUM_REQUIRED', `${pointer}.enumValues`, 'an enum attribute must declare at least one value')
      } else if (new Set(values).size !== values.length) {
        issue(out, 'ENUM_REQUIRED', `${pointer}.enumValues`, 'enum values must be unique')
      }
    } else if (definition.enumValues !== undefined) {
      issue(out, 'ENUM_FORBIDDEN', `${pointer}.enumValues`, 'only an enum attribute may declare enumValues')
    }

    if (definition.valueType === 'reference') {
      const target = definition.referencesObjectId
      if (target === undefined) {
        issue(out, 'REFERENCE_REQUIRED', `${pointer}.referencesObjectId`, 'a reference attribute must name its object')
      } else if (!index.objects.has(target)) {
        issue(
          out,
          'REFERENCE_REQUIRED',
          `${pointer}.referencesObjectId`,
          `referenced object "${target}" is not defined in this version`,
        )
      }
    } else if (definition.referencesObjectId !== undefined) {
      issue(
        out,
        'REFERENCE_FORBIDDEN',
        `${pointer}.referencesObjectId`,
        'only a reference attribute may declare referencesObjectId',
      )
    }
  })
}

function validateRelations(
  draft: SemanticDefinitionVersionDraft,
  index: DefinitionIndex,
  out: DefinitionValidationIssue[],
): void {
  draft.relations.forEach((definition, position) => {
    const pointer = `$.relations[${position}]`
    if (!index.objects.has(definition.fromObjectId)) {
      issue(
        out,
        'RELATION_ENDPOINT_UNKNOWN',
        `${pointer}.fromObjectId`,
        `relation source object "${definition.fromObjectId}" is not defined in this version`,
      )
    }
    if (!index.objects.has(definition.toObjectId)) {
      issue(
        out,
        'RELATION_ENDPOINT_UNKNOWN',
        `${pointer}.toObjectId`,
        `relation target object "${definition.toObjectId}" is not defined in this version`,
      )
    }
    validateCardinality(definition.cardinality, `${pointer}.cardinality`, out)
  })
}

function validateIdentityScopes(
  draft: SemanticDefinitionVersionDraft,
  index: DefinitionIndex,
  out: DefinitionValidationIssue[],
): void {
  draft.identityScopes.forEach((definition, position) => {
    const pointer = `$.identityScopes[${position}]`
    if (!index.objects.has(definition.objectId)) {
      issue(
        out,
        'IDENTITY_SCOPE_UNKNOWN',
        `${pointer}.objectId`,
        `identity scope object "${definition.objectId}" is not defined in this version`,
      )
    }
    if (!Array.isArray(definition.scopeDimensions)) {
      issue(out, 'IDENTITY_SCOPE_EMPTY', `${pointer}.scopeDimensions`, 'scopeDimensions must be an array')
    } else if (definition.scopeDimensions.length === 0) {
      issue(out, 'IDENTITY_SCOPE_EMPTY', `${pointer}.scopeDimensions`, 'an identity scope needs at least one dimension')
    } else {
      definition.scopeDimensions.forEach((dimension, dim) => {
        if (!isDefinitionIdentifier(dimension)) {
          issue(
            out,
            'IDENTITY_SCOPE_EMPTY',
            `${pointer}.scopeDimensions[${dim}]`,
            'scope dimension must be a lowercase identifier',
          )
        }
      })
    }
    if (!Array.isArray(definition.identityAttributeIds)) {
      issue(
        out,
        'IDENTITY_SCOPE_EMPTY',
        `${pointer}.identityAttributeIds`,
        'identityAttributeIds must be an array',
      )
      return
    }
    if (definition.identityAttributeIds.length === 0) {
      issue(
        out,
        'IDENTITY_SCOPE_EMPTY',
        `${pointer}.identityAttributeIds`,
        'an identity scope needs at least one identity attribute',
      )
      return
    }
    definition.identityAttributeIds.forEach((attributeId, attr) => {
      const attribute = index.attributes.get(attributeId)
      if (attribute === undefined) {
        issue(
          out,
          'IDENTITY_SCOPE_ATTRIBUTE_UNKNOWN',
          `${pointer}.identityAttributeIds[${attr}]`,
          `identity attribute "${attributeId}" is not defined in this version`,
        )
        return
      }
      if (attribute.identityKey !== true) {
        issue(
          out,
          'IDENTITY_SCOPE_ATTRIBUTE_UNKNOWN',
          `${pointer}.identityAttributeIds[${attr}]`,
          `attribute "${attributeId}" is not declared as an identity key`,
        )
      }
      if (attribute.objectId !== definition.objectId) {
        issue(
          out,
          'IDENTITY_SCOPE_ATTRIBUTE_UNKNOWN',
          `${pointer}.identityAttributeIds[${attr}]`,
          `attribute "${attributeId}" belongs to object "${attribute.objectId}"`,
        )
      }
    })
  })
}

function validateExpression(
  expression: unknown,
  pointer: string,
  index: DefinitionIndex,
  out: DefinitionValidationIssue[],
): void {
  if (expression === null || typeof expression !== 'object') {
    issue(out, 'RULE_EXPRESSION_INVALID', pointer, 'rule expression must be an object')
    return
  }
  const record = expression as Record<string, unknown>
  const op = record.op
  switch (op) {
    case 'all':
    case 'any': {
      const operands = record.operands
      if (!Array.isArray(operands) || operands.length === 0) {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.operands`, `${String(op)} needs at least one operand`)
        return
      }
      operands.forEach((operand, position) => {
        validateExpression(operand, `${pointer}.operands[${position}]`, index, out)
      })
      return
    }
    case 'not': {
      validateExpression(record.operand, `${pointer}.operand`, index, out)
      return
    }
    case 'compare': {
      const attributeId = record.attributeId
      if (typeof attributeId !== 'string') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.attributeId`, 'compare needs an attribute id')
        return
      }
      const attribute = index.attributes.get(attributeId)
      if (attribute === undefined) {
        issue(
          out,
          'RULE_REFERENCE_UNKNOWN',
          `${pointer}.attributeId`,
          `attribute "${attributeId}" is not defined in this version`,
        )
        return
      }
      const operator = record.operator
      if (typeof operator !== 'string' || !COMPARISON_OPERATORS.has(operator)) {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.operator`, 'unsupported comparison operator')
        return
      }
      if (NUMERIC_OPERATORS.has(operator) && !isNumericValueType(attribute.valueType)) {
        issue(
          out,
          'RULE_EXPRESSION_INVALID',
          `${pointer}.operator`,
          `operator ${operator} requires a numeric attribute`,
        )
      }
      const value = record.value
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.value`, 'compare needs a scalar value')
      }
      return
    }
    case 'range': {
      const attributeId = record.attributeId
      if (typeof attributeId !== 'string') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.attributeId`, 'range needs an attribute id')
        return
      }
      const attribute = index.attributes.get(attributeId)
      if (attribute === undefined) {
        issue(
          out,
          'RULE_REFERENCE_UNKNOWN',
          `${pointer}.attributeId`,
          `attribute "${attributeId}" is not defined in this version`,
        )
        return
      }
      if (!isNumericValueType(attribute.valueType)) {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.attributeId`, 'range requires a numeric attribute')
      }
      const min = record.min
      const max = record.max
      if (min !== undefined && typeof min !== 'number') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.min`, 'range min must be a number')
      }
      if (max !== undefined && typeof max !== 'number') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.max`, 'range max must be a number')
      }
      if (typeof min === 'number' && typeof max === 'number' && min > max) {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.min`, 'range min must not exceed max')
      }
      if (record.unit !== undefined && attribute.valueType !== 'quantity') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.unit`, 'only a quantity attribute may declare a range unit')
      }
      return
    }
    case 'relation': {
      const relationId = record.relationId
      if (typeof relationId !== 'string') {
        issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.relationId`, 'relation expression needs a relation id')
        return
      }
      if (!index.relations.has(relationId)) {
        issue(
          out,
          'RULE_REFERENCE_UNKNOWN',
          `${pointer}.relationId`,
          `relation "${relationId}" is not defined in this version`,
        )
      }
      return
    }
    default:
      issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.op`, `unsupported rule expression "${String(op)}"`)
  }
}

function validateRuleConstraints(
  draft: SemanticDefinitionVersionDraft,
  index: DefinitionIndex,
  out: DefinitionValidationIssue[],
): void {
  draft.ruleConstraints.forEach((definition, position) => {
    const pointer = `$.ruleConstraints[${position}]`
    if (!index.objects.has(definition.objectId)) {
      issue(
        out,
        'RULE_REFERENCE_UNKNOWN',
        `${pointer}.objectId`,
        `constraint object "${definition.objectId}" is not defined in this version`,
      )
    }
    if (definition.severity !== 'hard' && definition.severity !== 'soft') {
      issue(out, 'RULE_EXPRESSION_INVALID', `${pointer}.severity`, 'severity must be "hard" or "soft"')
    }
    validateExpression(definition.expression, `${pointer}.expression`, index, out)
  })
}

function validateLayerAndBase(
  draft: SemanticDefinitionVersionDraft,
  base: SemanticDefinitionVersion | undefined,
  out: DefinitionValidationIssue[],
): void {
  if (draft.layer !== 'industry_core' && draft.layer !== 'customer_extension') {
    issue(out, 'LAYER_BASE_FORBIDDEN', '$.layer', `unknown definition layer "${String(draft.layer)}"`)
    return
  }
  if (draft.layer === 'customer_extension' && draft.baseRef === undefined) {
    issue(
      out,
      'LAYER_BASE_REQUIRED',
      '$.baseRef',
      'a customer extension must reference the industry-core version it extends',
    )
    return
  }
  if (draft.baseRef === undefined || base === undefined) return
  if (base.layer !== 'industry_core') {
    issue(out, 'LAYER_BASE_FORBIDDEN', '$.baseRef', 'a definition version may only build on an industry-core version')
    return
  }
  if (draft.layer !== 'customer_extension') return

  const baseKeys = new Set<string>()
  for (const definition of base.objects) baseKeys.add(definitionKey(definition.kind, definition.id))
  for (const definition of base.attributes) baseKeys.add(definitionKey(definition.kind, definition.id))
  for (const definition of base.relations) baseKeys.add(definitionKey(definition.kind, definition.id))
  for (const definition of base.identityScopes) baseKeys.add(definitionKey(definition.kind, definition.id))
  for (const definition of base.ruleConstraints) baseKeys.add(definitionKey(definition.kind, definition.id))

  const checkShadowing = (
    definitions: readonly { readonly kind: string; readonly id: string }[],
    field: string,
  ): void => {
    definitions.forEach((definition, position) => {
      if (baseKeys.has(definitionKey(definition.kind, definition.id))) {
        issue(
          out,
          'CORE_SHADOWING_FORBIDDEN',
          `$.${field}[${position}]`,
          `customer extension may not shadow core ${definition.kind} "${definition.id}"`,
        )
      }
    })
  }
  checkShadowing(draft.objects, 'objects')
  checkShadowing(draft.attributes, 'attributes')
  checkShadowing(draft.relations, 'relations')
  checkShadowing(draft.identityScopes, 'identityScopes')
  checkShadowing(draft.ruleConstraints, 'ruleConstraints')
}

/**
 * INV-03 / ADR-10 purity scan. It runs on the declaration content (never the trusted
 * scope, which legitimately carries tenant/space ids) and rejects a forbidden field,
 * a connection URL, a credential, executable script text or SQL statement text.
 */
export function scanDefinitionPurity(value: unknown): DefinitionValidationIssue[] {
  return findIndustryPackViolations(value).map((violation) => ({
    code: 'PURITY_VIOLATION' as const,
    pointer: violation.path,
    reason: violation.message,
  }))
}

function declarationContent(draft: SemanticDefinitionVersionDraft): Record<string, unknown> {
  return {
    namespace: draft.namespace,
    layer: draft.layer,
    baseRef: draft.baseRef,
    standardProvenance: draft.standardProvenance,
    objects: draft.objects,
    attributes: draft.attributes,
    relations: draft.relations,
    identityScopes: draft.identityScopes,
    ruleConstraints: draft.ruleConstraints,
  }
}

/**
 * Content digest of a definition version. It covers the declaration only (never the
 * trusted tenant/space scope), so identical core semantics published in two spaces share
 * one digest and the `VersionRef` pins exactly the published content.
 */
export function definitionVersionDigest(draft: SemanticDefinitionVersionDraft): Sha256Digest {
  return sha256DigestOf(declarationContent(draft))
}

export interface DefinitionValidationOptions {
  /**
   * The already-resolved industry-core base version. The service resolves `baseRef` and
   * checks its digest before validation, so this function never performs I/O.
   */
  readonly base?: SemanticDefinitionVersion
}

function checkDefinitionEntries(entries: unknown, field: string, out: DefinitionValidationIssue[]): void {
  if (!Array.isArray(entries)) {
    issue(out, 'INVALID_IDENTIFIER', `$.${field}`, `${field} must be an array`)
    return
  }
  entries.forEach((entry, position) => {
    if (!isRecord(entry)) {
      issue(out, 'INVALID_IDENTIFIER', `$.${field}[${position}]`, 'definition entry must be an object')
    }
  })
}

/**
 * Structural guard so a malformed runtime payload fails validation with typed issues
 * instead of throwing a TypeError deep inside indexing. It is deliberately shallow: the
 * per-kind checks below own the real rules.
 */
function structuralIssues(draft: SemanticDefinitionVersionDraft): DefinitionValidationIssue[] {
  const out: DefinitionValidationIssue[] = []
  checkDefinitionEntries(draft.objects, 'objects', out)
  checkDefinitionEntries(draft.attributes, 'attributes', out)
  checkDefinitionEntries(draft.relations, 'relations', out)
  checkDefinitionEntries(draft.identityScopes, 'identityScopes', out)
  checkDefinitionEntries(draft.ruleConstraints, 'ruleConstraints', out)
  return out
}

export function validateDefinitionVersion(
  draft: SemanticDefinitionVersionDraft,
  options?: DefinitionValidationOptions,
): DefinitionValidationIssue[] {
  const structural = structuralIssues(draft)
  if (structural.length > 0) return structural

  const out: DefinitionValidationIssue[] = []

  if (!isNamespace(draft.namespace)) {
    issue(out, 'INVALID_NAMESPACE', '$.namespace', 'namespace is not a valid pack namespace')
  }
  if (!isSemverValue(draft.version)) {
    issue(out, 'INVALID_VERSION', '$.version', 'version must be a semver string')
  }
  if (!isDefinitionIdentifier(draft.definitionId)) {
    issue(out, 'INVALID_IDENTIFIER', '$.definitionId', 'definitionId must be a lowercase identifier')
  }
  validateStandardProvenance(draft.standardProvenance, '$.standardProvenance', out)
  out.push(...scanDefinitionPurity(declarationContent(draft)))

  validateLayerAndBase(draft, options?.base, out)

  const index = indexDefinitions(draft, options?.base, out)
  validateObjects(draft, index, out)
  validateAttributes(draft, index, out)
  validateRelations(draft, index, out)
  validateIdentityScopes(draft, index, out)
  validateRuleConstraints(draft, index, out)

  return out
}
