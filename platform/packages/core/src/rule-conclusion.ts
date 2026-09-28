import type { IndustrySchema, RuleConclusionBinding } from '@ontology/contracts'
import { canonicalDecimalString } from './decimal'

export interface RuleConclusionValidation {
  readonly binding?: RuleConclusionBinding
  readonly reason?: string
}

/** Validate and normalize an untrusted conclusion against the rule's exact object schema. */
export function validateRuleConclusionBinding(
  input: unknown,
  objectId: string,
  schema: IndustrySchema,
): RuleConclusionValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { reason: 'conclusion must be an object with predicate and typed value' }
  }
  const raw = input as Record<string, unknown>
  if (Object.keys(raw).some((key) => key !== 'predicate' && key !== 'value')) {
    return { reason: 'conclusion may contain only predicate and value' }
  }
  if (typeof raw['predicate'] !== 'string' || raw['predicate'].length === 0) {
    return { reason: 'conclusion predicate must be a non-empty attribute id' }
  }
  const object = schema.objects.find((candidate) => candidate.objectId === objectId)
  if (object === undefined) return { reason: `conclusion object ${objectId} is not declared` }
  const attribute = object.attributes.find((candidate) => candidate.attributeId === raw['predicate'])
  if (attribute === undefined) {
    return { reason: `conclusion predicate ${raw['predicate']} is not declared on object ${objectId}` }
  }
  if (attribute.maxCardinality !== 1) {
    return { reason: `conclusion predicate ${raw['predicate']} must be single-valued` }
  }

  const value = raw['value']
  switch (attribute.valueType) {
    case 'boolean':
      return typeof value === 'boolean'
        ? { binding: { predicate: attribute.attributeId, value } }
        : { reason: `conclusion ${attribute.attributeId} requires a boolean value` }
    case 'string':
      return typeof value === 'string'
        ? { binding: { predicate: attribute.attributeId, value } }
        : { reason: `conclusion ${attribute.attributeId} requires a string value` }
    case 'enum':
      if (typeof value !== 'string') return { reason: `conclusion ${attribute.attributeId} requires an enum string` }
      if (!(attribute.enumValues ?? []).includes(value)) {
        return { reason: `conclusion value for ${attribute.attributeId} is outside the declared enum` }
      }
      return { binding: { predicate: attribute.attributeId, value } }
    case 'timestamp':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
        return { reason: `conclusion ${attribute.attributeId} requires an RFC3339 UTC timestamp` }
      }
      return { binding: { predicate: attribute.attributeId, value } }
    case 'number':
    case 'quantity': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { reason: `numeric conclusion ${attribute.attributeId} requires an exact DecimalQuantity` }
      }
      const quantity = value as Record<string, unknown>
      if (Object.keys(quantity).some((key) => key !== 'amount' && key !== 'unit') || typeof quantity['amount'] !== 'string' || typeof quantity['unit'] !== 'string') {
        return { reason: `numeric conclusion ${attribute.attributeId} requires only string amount and unit fields` }
      }
      if (attribute.unitCode === undefined) {
        return { reason: `numeric conclusion ${attribute.attributeId} has no declared unit for exact rule evaluation` }
      }
      if (quantity['unit'] !== attribute.unitCode) {
        return { reason: `conclusion ${attribute.attributeId} requires unit ${attribute.unitCode}` }
      }
      const amount = canonicalDecimalString(quantity['amount'])
      if (amount === undefined || amount.length > 64) {
        return { reason: `conclusion ${attribute.attributeId} has an invalid exact decimal amount` }
      }
      return { binding: { predicate: attribute.attributeId, value: { amount, unit: attribute.unitCode } } }
    }
    case 'reference':
      return { reason: `reference conclusion ${attribute.attributeId} is not supported by the current typed rule evaluator` }
  }
  return { reason: `conclusion ${attribute.attributeId} uses an unsupported schema value type` }
}
