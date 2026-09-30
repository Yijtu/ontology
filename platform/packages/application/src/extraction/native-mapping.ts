import type {
  CandidateAttributeValue,
  IndustryAttributeSchema,
  IndustryObjectSchema,
  IndustrySchema,
} from '@ontology/contracts'
import { canonicalJson } from './canonical'

/**
 * Deterministic native-identifier mapping (SPEC D4.2/D4.4, US-012.A2).
 *
 * When a parsed chunk already carries a strong native record — a JSON object that includes
 * every attribute of a declared identity scope — the pipeline maps it straight to an entity
 * candidate and never calls the generation model for that record. The native id stays
 * verbatim; it is disambiguated by the declared identity scope, not rewritten.
 */
export interface NativeEntityMapping {
  readonly objectId: string
  readonly identityScopeId: string
  readonly nativeId: string
  readonly attributes: readonly CandidateAttributeValue[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Recognise a native record in chunk text. Only a JSON object counts; anything else is
 * unstructured text and goes through the generation path.
 */
export function parseNativeRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  return isRecord(parsed) ? parsed : undefined
}

const DECIMAL_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

function attributeValueOf(
  attribute: IndustryAttributeSchema,
  value: string | number | boolean,
): CandidateAttributeValue {
  const unit = attribute.unitCode === undefined ? {} : { unitCode: attribute.unitCode }
  if (typeof value === 'string') {
    // A quantity written as a canonical decimal string keeps the exact token, so it never
    // passes through a lossy `Number` (A §5.3). A non-canonical string stays raw-only and is
    // rejected by validation instead of being silently rewritten.
    const decimal = attribute.valueType === 'quantity' && DECIMAL_TOKEN.test(value) ? value : undefined
    return {
      attributeId: attribute.attributeId,
      value,
      raw: value,
      ...(decimal === undefined ? {} : { decimal }),
      ...unit,
    }
  }
  return { attributeId: attribute.attributeId, value, raw: String(value), ...unit }
}

function attributesOf(object: IndustryObjectSchema, record: Record<string, unknown>): CandidateAttributeValue[] {
  const attributes: CandidateAttributeValue[] = []
  for (const attribute of object.attributes) {
    const value = record[attribute.attributeId]
    if (!isScalar(value)) continue
    attributes.push(attributeValueOf(attribute, value))
  }
  return attributes
}

export function mapNativeEntities(
  schema: IndustrySchema,
  record: Record<string, unknown>,
): NativeEntityMapping[] {
  const mappings: NativeEntityMapping[] = []
  for (const object of schema.objects) {
    const scope = schema.identityScopes.find((entry) => entry.identityScopeId === object.identityScopeId)
    if (scope === undefined || scope.identityAttributeIds.length === 0) continue
    const identityValues = scope.identityAttributeIds.map((attributeId) => record[attributeId])
    if (!identityValues.every(isScalar)) continue
    const nativeId =
      identityValues.length === 1
        ? String(identityValues[0])
        : canonicalJson(
            Object.fromEntries(
              scope.identityAttributeIds.map((attributeId, index) => [attributeId, identityValues[index]]),
            ),
          )
    mappings.push({
      objectId: object.objectId,
      identityScopeId: object.identityScopeId,
      nativeId,
      attributes: attributesOf(object, record),
    })
  }
  return mappings
}
