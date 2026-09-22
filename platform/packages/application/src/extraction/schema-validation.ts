import type {
  CandidateAttributeValue,
  CandidateIssue,
  CandidateIssueCode,
  EntityCandidate,
  IndustryAttributeSchema,
  IndustryAttributeValueType,
  IndustryObjectSchema,
  IndustryRelationSchema,
  IndustrySchema,
  RelationCandidate,
  Uuid,
} from '@ontology/contracts'

/**
 * Deterministic candidate validation against the published industry schema (SPEC D4.3,
 * US-012.A1). It is pure: it reads the schema projection and returns classified issues.
 * It never coerces a value into shape, never drops a candidate and never writes the schema.
 */

export function objectById(schema: IndustrySchema, objectId: string): IndustryObjectSchema | undefined {
  return schema.objects.find((object) => object.objectId === objectId)
}

export function relationById(schema: IndustrySchema, relationId: string): IndustryRelationSchema | undefined {
  return schema.relations.find((relation) => relation.relationId === relationId)
}

function attributeById(object: IndustryObjectSchema, attributeId: string): IndustryAttributeSchema | undefined {
  return object.attributes.find((attribute) => attribute.attributeId === attributeId)
}

function attributeOnAnyObject(schema: IndustrySchema, attributeId: string): boolean {
  return schema.objects.some((object) => attributeById(object, attributeId) !== undefined)
}

function issue(
  out: CandidateIssue[],
  code: CandidateIssueCode,
  message: string,
  field?: string,
): void {
  out.push(field === undefined ? { code, message } : { code, message, field })
}

function valueTypeMatches(valueType: IndustryAttributeValueType, value: string | number | boolean): boolean {
  switch (valueType) {
    case 'string':
      return typeof value === 'string'
    case 'timestamp':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    case 'reference':
      return typeof value === 'string'
    case 'enum':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'quantity':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
  }
  return false
}

function validateAttributeValue(
  out: CandidateIssue[],
  schema: IndustrySchema,
  object: IndustryObjectSchema,
  value: CandidateAttributeValue,
  field: string,
): void {
  const attribute = attributeById(object, value.attributeId)
  if (attribute === undefined) {
    if (attributeOnAnyObject(schema, value.attributeId)) {
      issue(
        out,
        'ATTRIBUTE_NOT_ON_OBJECT',
        `attribute ${value.attributeId} does not belong to object ${object.objectId}`,
        field,
      )
    } else {
      issue(out, 'UNKNOWN_ATTRIBUTE', `attribute ${value.attributeId} is not declared`, field)
    }
    return
  }
  if (!valueTypeMatches(attribute.valueType, value.value)) {
    issue(
      out,
      'TYPE_MISMATCH',
      `attribute ${value.attributeId} expects ${attribute.valueType} but received ${typeof value.value}`,
      field,
    )
    return
  }
  if (attribute.valueType === 'enum') {
    const allowed = attribute.enumValues ?? []
    if (!allowed.includes(String(value.value))) {
      issue(
        out,
        'ENUM_VALUE_INVALID',
        `attribute ${value.attributeId} value is not one of ${allowed.join(', ')}`,
        field,
      )
    }
  }
  if (attribute.valueType === 'quantity' && attribute.unitCode !== undefined) {
    if (value.unitCode !== attribute.unitCode) {
      issue(
        out,
        'UNIT_MISMATCH',
        `attribute ${value.attributeId} expects unit ${attribute.unitCode}`,
        field,
      )
    }
  }
}

function validateCardinality(
  out: CandidateIssue[],
  object: IndustryObjectSchema,
  attributes: readonly CandidateAttributeValue[],
): void {
  const counts = new Map<string, number>()
  for (const value of attributes) {
    counts.set(value.attributeId, (counts.get(value.attributeId) ?? 0) + 1)
  }
  for (const attribute of object.attributes) {
    // Identity keys are resolved by the identity stage (LOCAL-029), so a new entity candidate
    // is not failed for lacking a native key. Non-identity required attributes are enforced.
    if (attribute.identityKey) continue
    const count = counts.get(attribute.attributeId) ?? 0
    if (count < attribute.minCardinality) {
      issue(
        out,
        'CARDINALITY_VIOLATION',
        `attribute ${attribute.attributeId} requires at least ${attribute.minCardinality} value(s)`,
      )
    }
    if (attribute.maxCardinality !== 'unbounded' && count > attribute.maxCardinality) {
      issue(
        out,
        'CARDINALITY_VIOLATION',
        `attribute ${attribute.attributeId} allows at most ${attribute.maxCardinality} value(s)`,
      )
    }
  }
}

function validateIdentity(
  out: CandidateIssue[],
  schema: IndustrySchema,
  entity: EntityCandidate,
): void {
  if (!entity.deterministic) return
  const object = objectById(schema, entity.objectId)
  if (object === undefined) return
  const scope = schema.identityScopes.find((entry) => entry.identityScopeId === object.identityScopeId)
  if (scope === undefined) return
  const present = new Set(entity.attributes.map((value) => value.attributeId))
  for (const identityAttributeId of scope.identityAttributeIds) {
    if (!present.has(identityAttributeId)) {
      issue(
        out,
        'MISSING_IDENTITY_ATTRIBUTE',
        `deterministic entity ${entity.objectId} is missing identity attribute ${identityAttributeId}`,
      )
    }
  }
}

function validateSpans(out: CandidateIssue[], spanCount: number): void {
  if (spanCount === 0) {
    issue(out, 'SPAN_NOT_RESOLVED', 'the candidate carries no source span')
  }
}

export function validateEntity(entity: EntityCandidate, schema: IndustrySchema): CandidateIssue[] {
  const out: CandidateIssue[] = []
  validateSpans(out, entity.sourceSpans.length)
  const object = objectById(schema, entity.objectId)
  if (object === undefined) {
    issue(out, 'UNKNOWN_OBJECT', `object ${entity.objectId} is not declared in the industry schema`)
    return out
  }
  entity.attributes.forEach((value, index) => {
    validateAttributeValue(out, schema, object, value, `attributes[${String(index)}]`)
  })
  validateCardinality(out, object, entity.attributes)
  validateIdentity(out, schema, entity)
  return out
}

function validateEndpoint(
  out: CandidateIssue[],
  relation: IndustryRelationSchema,
  endpoint: RelationCandidate['from'],
  entityById: ReadonlyMap<Uuid, EntityCandidate>,
  side: 'from' | 'to',
  expectedObjectId: string,
): void {
  if (endpoint.objectId !== expectedObjectId) {
    issue(
      out,
      'ENDPOINT_TYPE_MISMATCH',
      `relation ${relation.relationId} ${side} endpoint must be object ${expectedObjectId}`,
      side,
    )
  }
  if (endpoint.candidateId !== undefined) {
    const referenced = entityById.get(endpoint.candidateId)
    if (referenced === undefined) {
      issue(
        out,
        'DANGLING_REFERENCE',
        `relation ${relation.relationId} ${side} references an entity candidate that does not exist`,
        side,
      )
    } else if (referenced.objectId !== endpoint.objectId) {
      issue(
        out,
        'ENDPOINT_TYPE_MISMATCH',
        `relation ${relation.relationId} ${side} references a ${referenced.objectId}, not ${endpoint.objectId}`,
        side,
      )
    }
    return
  }
  if (endpoint.nativeId === undefined || endpoint.nativeId.length === 0) {
    issue(
      out,
      'DANGLING_REFERENCE',
      `relation ${relation.relationId} ${side} endpoint has neither a candidate nor a native reference`,
      side,
    )
  }
}

export function validateRelation(
  relation: RelationCandidate,
  schema: IndustrySchema,
  entityById: ReadonlyMap<Uuid, EntityCandidate>,
): CandidateIssue[] {
  const out: CandidateIssue[] = []
  validateSpans(out, relation.sourceSpans.length)
  const declared = relationById(schema, relation.relationId)
  if (declared === undefined) {
    issue(out, 'UNKNOWN_RELATION', `relation ${relation.relationId} is not declared in the industry schema`)
    return out
  }
  validateEndpoint(out, declared, relation.from, entityById, 'from', declared.fromObjectId)
  validateEndpoint(out, declared, relation.to, entityById, 'to', declared.toObjectId)
  return out
}

/** Every issue except an explicit truncation is a hard validation failure (D4.1/D4.3). */
export function isHardIssue(candidateIssue: CandidateIssue): boolean {
  return candidateIssue.code !== 'TRUNCATED_CHUNK'
}

/** Stable de-duplication so a re-validation does not append the same issue twice. */
export function dedupeIssues(issues: readonly CandidateIssue[]): CandidateIssue[] {
  const seen = new Set<string>()
  const out: CandidateIssue[] = []
  for (const entry of issues) {
    const key = `${entry.code}|${entry.field ?? ''}|${entry.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

export function truncatedChunkIssue(chunkId: Uuid): CandidateIssue {
  return {
    code: 'TRUNCATED_CHUNK',
    message: `the source chunk ${chunkId} is known to be truncated; the candidate cannot be treated as complete`,
    field: 'sourceSpans',
  }
}
