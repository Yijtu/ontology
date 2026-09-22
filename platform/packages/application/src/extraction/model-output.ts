import type { CandidateAttributeValue } from '@ontology/contracts'
import { ExtractionError } from './errors'

/**
 * The structured generation response the extraction role returns. The model output is
 * untrusted data (AGENTS §运行、语义与证据), so every field is checked before it becomes a
 * candidate; a malformed response fails the stage instead of being coerced into shape.
 */
export interface DraftEntity {
  readonly objectId: string
  readonly attributes: readonly CandidateAttributeValue[]
}

export interface DraftRelationEndpoint {
  readonly objectId: string
  /** Reference to an entity produced in the same response, by zero-based index. */
  readonly entityIndex?: number
  readonly nativeId?: string
}

export interface DraftRelation {
  readonly relationId: string
  readonly from: DraftRelationEndpoint
  readonly to: DraftRelationEndpoint
}

export interface DraftCandidates {
  readonly entities: readonly DraftEntity[]
  readonly relations: readonly DraftRelation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output field "${field}" must be a non-empty string`)
  }
  return value
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output field "${field}" must be an array`)
  }
  return value
}

function parseAttribute(value: unknown, field: string): CandidateAttributeValue {
  if (!isRecord(value)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${field} must be an object`)
  }
  const raw = value['value']
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${field}.value must be a scalar`)
  }
  const unitCode = value['unitCode']
  if (unitCode !== undefined && typeof unitCode !== 'string') {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${field}.unitCode must be a string`)
  }
  return {
    attributeId: requireString(value['attributeId'], `${field}.attributeId`),
    value: raw,
    ...(unitCode === undefined ? {} : { unitCode }),
  }
}

function parseEndpoint(value: unknown, field: string): DraftRelationEndpoint {
  if (!isRecord(value)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${field} must be an object`)
  }
  const entityIndex = value['entityIndex']
  if (entityIndex !== undefined && (typeof entityIndex !== 'number' || !Number.isInteger(entityIndex))) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${field}.entityIndex must be an integer`)
  }
  const nativeId = value['nativeId']
  if (nativeId !== undefined && typeof nativeId !== 'string') {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${field}.nativeId must be a string`)
  }
  return {
    objectId: requireString(value['objectId'], `${field}.objectId`),
    ...(entityIndex === undefined ? {} : { entityIndex }),
    ...(nativeId === undefined ? {} : { nativeId }),
  }
}

export function parseModelCandidates(text: string): DraftCandidates {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', 'the model extraction response is not valid JSON', {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', 'the model extraction response must be a JSON object')
  }
  const rawEntities = parsed['entities'] === undefined ? [] : requireArray(parsed['entities'], 'entities')
  const rawRelations = parsed['relations'] === undefined ? [] : requireArray(parsed['relations'], 'relations')

  const entities: DraftEntity[] = rawEntities.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output entities[${String(index)}] must be an object`)
    }
    const rawAttributes = requireArray(entry['attributes'], `entities[${String(index)}].attributes`)
    return {
      objectId: requireString(entry['objectId'], `entities[${String(index)}].objectId`),
      attributes: rawAttributes.map((attribute, attributeIndex) =>
        parseAttribute(attribute, `entities[${String(index)}].attributes[${String(attributeIndex)}]`),
      ),
    }
  })

  const relations: DraftRelation[] = rawRelations.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output relations[${String(index)}] must be an object`)
    }
    return {
      relationId: requireString(entry['relationId'], `relations[${String(index)}].relationId`),
      from: parseEndpoint(entry['from'], `relations[${String(index)}].from`),
      to: parseEndpoint(entry['to'], `relations[${String(index)}].to`),
    }
  })

  return { entities, relations }
}
