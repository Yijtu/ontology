import type { DefinitionCandidateKind, IndustryAttributeValueType } from '@ontology/contracts'
import { DefinitionCandidateError } from './errors'

/**
 * The structured generation response the TBox modelling role must answer with. The model
 * output is untrusted data (AGENTS §运行、语义与证据), so every field is checked before it
 * becomes a candidate; a malformed response is a classified failure instead of a coerced shape.
 *
 * `sourceIndex` is optional: when the model cannot cite a source, the candidate is later stored
 * as `pending_confirmation` rather than being dropped (P.US-004.AC-03).
 */
export interface DraftDefinitionCandidate {
  readonly kind: DefinitionCandidateKind
  readonly logicalId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly sourceIndex?: number
  readonly fragmentIndex?: number
  readonly identityAttributeIds?: readonly string[]
  readonly objectLogicalId?: string
  readonly valueType?: IndustryAttributeValueType
  readonly unitCode?: string
  readonly dimension?: string
  readonly enumValues?: readonly string[]
  readonly referencesObjectLogicalId?: string
  readonly minCardinality?: number
  readonly maxCardinality?: number | 'unbounded'
  readonly fromObjectLogicalId?: string
  readonly toObjectLogicalId?: string
}

export interface DraftDefinitionCandidates {
  readonly candidates: readonly DraftDefinitionCandidate[]
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output field "${field}" must be a non-empty string`,
    )
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output field "${field}" must be a string`,
    )
  }
  return value
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output field "${field}" must be an array of strings`,
    )
  }
  return value
}

function optionalSourceIndex(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output field "${field}" must be a non-negative integer source index`,
    )
  }
  return value
}

function optionalCardinality(value: unknown, field: string): number | 'unbounded' | undefined {
  if (value === undefined) return undefined
  if (value === 'unbounded') return 'unbounded'
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output field "${field}" must be a non-negative integer or "unbounded"`,
    )
  }
  return value
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output field "${field}" must be a non-negative integer`,
    )
  }
  return value
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', `model output field "${field}" must be an array`)
  }
  return value
}

function commonOf(entry: Record<string, unknown>, field: string): {
  readonly logicalId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly sourceIndex?: number
  readonly fragmentIndex?: number
} {
  const sourceIndex = optionalSourceIndex(entry['sourceIndex'], `${field}.sourceIndex`)
  const fragmentIndex = optionalSourceIndex(entry['fragmentIndex'], `${field}.fragmentIndex`)
  return {
    logicalId: requireString(entry['logicalId'], `${field}.logicalId`),
    displayName: requireString(entry['displayName'], `${field}.displayName`),
    businessMeaning: requireString(entry['businessMeaning'], `${field}.businessMeaning`),
    suggestedReason: requireString(entry['suggestedReason'], `${field}.suggestedReason`),
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
    ...(fragmentIndex === undefined ? {} : { fragmentIndex }),
  }
}

function rejectFields(entry: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const common = ['logicalId', 'displayName', 'businessMeaning', 'suggestedReason', 'sourceIndex', 'fragmentIndex']
  if (Object.keys(entry).some((key) => !common.includes(key) && !allowed.includes(key))) throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', `model output ${field} contains undeclared fields`)
}

function parseObject(entry: unknown, field: string): DraftDefinitionCandidate {
  if (!isRecord(entry)) {
    throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', `model output ${field} must be an object`)
  }
  rejectFields(entry, ['identityAttributeIds'], field)
  const identity = optionalStringArray(entry['identityAttributeIds'], `${field}.identityAttributeIds`)
  return {
    kind: 'object',
    ...commonOf(entry, field),
    ...(identity === undefined ? {} : { identityAttributeIds: identity }),
  }
}

function parseAttribute(entry: unknown, field: string): DraftDefinitionCandidate {
  if (!isRecord(entry)) {
    throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', `model output ${field} must be an object`)
  }
  rejectFields(entry, ['objectLogicalId', 'valueType', 'unitCode', 'dimension', 'enumValues', 'referencesObjectLogicalId', 'minCardinality', 'maxCardinality'], field)
  const valueType = requireString(entry['valueType'], `${field}.valueType`)
  if (!(VALUE_TYPES as readonly string[]).includes(valueType)) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      `model output ${field}.valueType is not a declared attribute value type`,
    )
  }
  const unitCode = optionalString(entry['unitCode'], `${field}.unitCode`)
  const dimension = optionalString(entry['dimension'], `${field}.dimension`)
  const enumValues = optionalStringArray(entry['enumValues'], `${field}.enumValues`)
  const referencesObjectLogicalId = optionalString(
    entry['referencesObjectLogicalId'],
    `${field}.referencesObjectLogicalId`,
  )
  const minCardinality = optionalCount(entry['minCardinality'], `${field}.minCardinality`)
  const maxCardinality = optionalCardinality(entry['maxCardinality'], `${field}.maxCardinality`)
  return {
    kind: 'attribute',
    ...commonOf(entry, field),
    objectLogicalId: requireString(entry['objectLogicalId'], `${field}.objectLogicalId`),
    valueType: valueType as IndustryAttributeValueType,
    ...(unitCode === undefined ? {} : { unitCode }),
    ...(dimension === undefined ? {} : { dimension }),
    ...(enumValues === undefined ? {} : { enumValues }),
    ...(referencesObjectLogicalId === undefined ? {} : { referencesObjectLogicalId }),
    ...(minCardinality === undefined ? {} : { minCardinality }),
    ...(maxCardinality === undefined ? {} : { maxCardinality }),
  }
}

function parseRelation(entry: unknown, field: string): DraftDefinitionCandidate {
  if (!isRecord(entry)) {
    throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', `model output ${field} must be an object`)
  }
  rejectFields(entry, ['fromObjectLogicalId', 'toObjectLogicalId', 'minCardinality', 'maxCardinality'], field)
  const minCardinality = optionalCount(entry['minCardinality'], `${field}.minCardinality`)
  const maxCardinality = optionalCardinality(entry['maxCardinality'], `${field}.maxCardinality`)
  return {
    kind: 'relation',
    ...commonOf(entry, field),
    fromObjectLogicalId: requireString(entry['fromObjectLogicalId'], `${field}.fromObjectLogicalId`),
    toObjectLogicalId: requireString(entry['toObjectLogicalId'], `${field}.toObjectLogicalId`),
    ...(minCardinality === undefined ? {} : { minCardinality }),
    ...(maxCardinality === undefined ? {} : { maxCardinality }),
  }
}

/**
 * Parse the model's definition-candidate response. A non-JSON body, a missing top-level key or
 * a malformed entry is `INVALID_MODEL_OUTPUT`; the caller records it as a failed batch.
 */
export function parseDefinitionCandidateOutput(text: string): DraftDefinitionCandidates {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      'the definition generation response is not valid JSON',
      { cause: error },
    )
  }
  if (!isRecord(parsed)) {
    throw new DefinitionCandidateError(
      'INVALID_MODEL_OUTPUT',
      'the definition generation response must be a JSON object',
    )
  }
  if (Object.keys(parsed).some((key) => !['objects', 'attributes', 'relations'].includes(key))) throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', 'model output contains undeclared top-level fields')
  const objects = parsed['objects'] === undefined ? [] : requireArray(parsed['objects'], 'objects')
  const attributes = parsed['attributes'] === undefined ? [] : requireArray(parsed['attributes'], 'attributes')
  const relations = parsed['relations'] === undefined ? [] : requireArray(parsed['relations'], 'relations')

  if (objects.length + attributes.length + relations.length > 500) throw new DefinitionCandidateError('INVALID_MODEL_OUTPUT', 'candidate arrays exceed the bounded 500 limit')
  return {
    candidates: [
      ...objects.map((entry, index) => parseObject(entry, `objects[${String(index)}]`)),
      ...attributes.map((entry, index) => parseAttribute(entry, `attributes[${String(index)}]`)),
      ...relations.map((entry, index) => parseRelation(entry, `relations[${String(index)}]`)),
    ],
  }
}
