import type {
  AttributeDefinition,
  ObjectDefinition,
  SchemaVocabulary,
  SchemaVocabularyPort,
  SchemaVocabularyRequest,
  SemanticDefinitionVersion,
  ToolContext,
  VersionRef,
  VocabularyConcept,
  VocabularyField,
  VocabularyGap,
  VocabularyGapCode,
  VocabularyLink,
} from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import type { SemanticMapping, SemanticMappingRegistry } from './types'

/**
 * Bounded schema-vocabulary construction (SPEC C1/C3, US-020, LOCAL-075).
 *
 * The vocabulary is projected from a *confirmed* physical mapping intersected with a
 * *published* definition version. Only the canonical side is exposed — concept/field/link
 * ids, value types, units and enum labels — so no physical schema, relation or column name
 * ever leaves this module (INV-03). An unmapped concept, an unpublished definition or a
 * physically inconsistent field is omitted rather than guessed.
 *
 * Pruning is deterministic: the question is matched lexically against canonical ids, enum
 * labels and unit codes, and the result is capped. When the cap drops anything the result
 * is explicitly marked truncated; when nothing can be built the result carries an explicit
 * gap instead of an empty schema that would let generation proceed blind.
 */

export interface VocabularyLimits {
  readonly maxConcepts: number
  readonly maxFields: number
}

/** Small by design: the vocabulary is a hint, not a schema dump. */
export const DEFAULT_VOCABULARY_LIMITS: VocabularyLimits = { maxConcepts: 8, maxFields: 32 }

export interface BuildSchemaVocabularyInput {
  readonly question: string
  readonly mappings: readonly SemanticMapping[]
  readonly definitions: readonly SemanticDefinitionVersion[]
  readonly limits: VocabularyLimits
}

interface DefinitionIndex {
  readonly objects: ReadonlyMap<string, ObjectDefinition>
  readonly attributesByObject: ReadonlyMap<string, readonly AttributeDefinition[]>
}

interface ScoredField {
  readonly field: VocabularyField
  readonly score: number
  /** An identity key or the mapped time field: always kept so a join stays expressible. */
  readonly keyField: boolean
}

interface CandidateConcept {
  readonly conceptId: string
  readonly displayName: string
  readonly conceptScore: number
  readonly fields: readonly ScoredField[]
}

const TOKEN_SEPARATOR = /[^a-z0-9\u4e00-\u9fff]+/u

function refKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

function gap(code: VocabularyGapCode, reason: string): VocabularyGap {
  return { code, reason }
}

function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SEPARATOR)
    .filter((token) => token.length >= 2)
}

function relevanceOf(
  questionLower: string,
  tokens: ReadonlySet<string>,
  keys: readonly string[],
): number {
  let score = 0
  for (const key of keys) {
    const normalized = key.toLowerCase()
    if (normalized.length < 2) continue
    if (tokens.has(normalized) || questionLower.includes(normalized)) {
      score += 1
      continue
    }
    // A question token that is a stem of the canonical id ("amount" -> "amount_total")
    // still selects the field; matching stays lexical and deterministic, never model-driven.
    let matches = 0
    for (const token of tokens) {
      if (normalized.includes(token)) matches += 1
    }
    score += matches
  }
  return score
}

function indexDefinitions(definitions: readonly SemanticDefinitionVersion[]): DefinitionIndex {
  const ordered = [...definitions].sort((left, right) => refKey(left.ref).localeCompare(refKey(right.ref)))
  const objects = new Map<string, ObjectDefinition>()
  const attributeLists = new Map<string, AttributeDefinition[]>()
  const attributeIds = new Map<string, Set<string>>()
  for (const version of ordered) {
    for (const object of version.objects) {
      if (!objects.has(object.id)) objects.set(object.id, object)
    }
    for (const attribute of version.attributes) {
      const list = attributeLists.get(attribute.objectId)
      const seen = attributeIds.get(attribute.objectId)
      if (list === undefined || seen === undefined) {
        attributeLists.set(attribute.objectId, [attribute])
        attributeIds.set(attribute.objectId, new Set([attribute.id]))
        continue
      }
      if (seen.has(attribute.id)) continue
      seen.add(attribute.id)
      list.push(attribute)
    }
  }
  return { objects, attributesByObject: attributeLists }
}

function projectField(
  attribute: AttributeDefinition,
  isTimeField: boolean,
  questionLower: string,
  tokens: ReadonlySet<string>,
): ScoredField {
  const keys = [
    attribute.id,
    ...(attribute.enumValues ?? []),
    ...(attribute.unit === undefined ? [] : [attribute.unit.unitCode]),
  ]
  return {
    field: {
      fieldRef: attribute.id,
      valueType: attribute.valueType,
      identityKey: attribute.identityKey === true,
      ...(attribute.unit === undefined ? {} : { unitCode: attribute.unit.unitCode }),
      ...(attribute.enumValues === undefined ? {} : { enumValues: [...attribute.enumValues] }),
    },
    score: relevanceOf(questionLower, tokens, keys),
    keyField: attribute.identityKey === true || isTimeField,
  }
}

function compareCandidates(left: CandidateConcept, right: CandidateConcept): number {
  if (right.conceptScore !== left.conceptScore) return right.conceptScore - left.conceptScore
  return left.conceptId.localeCompare(right.conceptId)
}

function compareFields(left: ScoredField, right: ScoredField): number {
  if (right.score !== left.score) return right.score - left.score
  if (left.keyField !== right.keyField) return left.keyField ? -1 : 1
  return left.field.fieldRef.localeCompare(right.field.fieldRef)
}

function selectFields(candidate: CandidateConcept, anyMatch: boolean): readonly ScoredField[] {
  const ordered = [...candidate.fields].sort(compareFields)
  if (!anyMatch) return ordered.filter((scored) => scored.keyField)
  if (candidate.conceptScore > 0) return ordered
  return ordered.filter((scored) => scored.score > 0 || scored.keyField)
}

function collectLinks(
  mappings: readonly SemanticMapping[],
  selectedConceptIds: ReadonlySet<string>,
): VocabularyLink[] {
  const links = new Map<string, VocabularyLink>()
  for (const mapping of mappings) {
    for (const link of mapping.links) {
      if (links.has(link.linkId)) continue
      if (!selectedConceptIds.has(link.fromConceptId) || !selectedConceptIds.has(link.toConceptId)) continue
      links.set(link.linkId, {
        linkId: link.linkId,
        fromConceptId: link.fromConceptId,
        toConceptId: link.toConceptId,
      })
    }
  }
  return [...links.values()].sort((left, right) => left.linkId.localeCompare(right.linkId))
}

function collectSources(
  mappings: readonly SemanticMapping[],
  definitions: readonly SemanticDefinitionVersion[],
): VersionRef[] {
  const byKey = new Map<string, VersionRef>()
  for (const mapping of mappings) byKey.set(refKey(mapping.mappingRef), mapping.mappingRef)
  for (const definition of definitions) byKey.set(refKey(definition.ref), definition.ref)
  return [...byKey.values()].sort((left, right) => refKey(left).localeCompare(refKey(right)))
}

function emptyVocabulary(sources: readonly VersionRef[], gaps: readonly VocabularyGap[]): SchemaVocabulary {
  const content = { concepts: [] as VocabularyConcept[], links: [] as VocabularyLink[], truncated: false, gaps }
  return {
    vocabularyRef: { id: 'schema-vocabulary', version: '1.0.0', digest: sha256DigestOf(content) },
    concepts: [],
    links: [],
    sources,
    truncated: false,
    omittedConceptCount: 0,
    omittedFieldCount: 0,
    gaps,
  }
}

export function buildSchemaVocabulary(input: BuildSchemaVocabularyInput): SchemaVocabulary {
  const sources = collectSources(input.mappings, input.definitions)
  const gaps: VocabularyGap[] = []
  if (input.mappings.length === 0) {
    gaps.push(gap('NO_CONFIRMED_MAPPING', 'no confirmed mapping was resolved for this run'))
  }
  if (input.definitions.length === 0) {
    gaps.push(gap('NO_PUBLISHED_DEFINITION', 'no published definition version was resolved for this run'))
  }
  if (gaps.length > 0) return emptyVocabulary(sources, gaps)

  const index = indexDefinitions(input.definitions)
  const questionLower = input.question.toLowerCase()
  const tokens = new Set(tokenize(input.question))

  const candidates: CandidateConcept[] = []
  const seenConcepts = new Set<string>()
  for (const mapping of input.mappings) {
    for (const object of mapping.objects) {
      if (seenConcepts.has(object.conceptId)) continue
      seenConcepts.add(object.conceptId)
      const definitionObject = index.objects.get(object.conceptId)
      if (definitionObject === undefined) continue
      const mappedFieldRefs = new Set(object.fields.map((field) => field.fieldRef))
      const fields = (index.attributesByObject.get(object.conceptId) ?? [])
        .filter((attribute) => mappedFieldRefs.has(attribute.id))
        .map((attribute) =>
          projectField(attribute, attribute.id === object.timeFieldRef, questionLower, tokens),
        )
      if (fields.length === 0) continue
      candidates.push({
        conceptId: object.conceptId,
        displayName: definitionObject.displayName,
        conceptScore: relevanceOf(questionLower, tokens, [object.conceptId, definitionObject.displayName]),
        fields,
      })
    }
  }

  if (candidates.length === 0) {
    return emptyVocabulary(sources, [
      gap('NO_MAPPED_CONCEPT', 'no confirmed mapping concept has a published definition in this scope'),
    ])
  }

  const anyMatch =
    candidates.some((candidate) => candidate.conceptScore > 0) ||
    candidates.some((candidate) => candidate.fields.some((field) => field.score > 0))
  const relevant = candidates.filter(
    (candidate) => candidate.conceptScore > 0 || candidate.fields.some((field) => field.score > 0),
  )
  const selected = [...(anyMatch ? relevant : candidates)].sort(compareCandidates)

  const concepts: VocabularyConcept[] = []
  let omittedConceptCount = 0
  let omittedFieldCount = 0
  let fieldsUsed = 0
  for (const candidate of selected) {
    if (concepts.length >= input.limits.maxConcepts) {
      omittedConceptCount += 1
      omittedFieldCount += candidate.fields.length
      continue
    }
    const kept: VocabularyField[] = []
    for (const scored of selectFields(candidate, anyMatch)) {
      if (fieldsUsed >= input.limits.maxFields) {
        omittedFieldCount += 1
        continue
      }
      kept.push(scored.field)
      fieldsUsed += 1
    }
    if (kept.length === 0) {
      omittedConceptCount += 1
      continue
    }
    concepts.push({ conceptId: candidate.conceptId, displayName: candidate.displayName, fields: kept })
  }

  if (concepts.length === 0) {
    return emptyVocabulary(sources, [
      gap('NO_RELEVANT_FIELD', 'the bounded selection kept no relevant concept or field'),
    ])
  }

  const finalConcepts = [...concepts].sort((left, right) => left.conceptId.localeCompare(right.conceptId))
  const links = collectLinks(input.mappings, new Set(finalConcepts.map((concept) => concept.conceptId)))
  const truncated = omittedConceptCount > 0 || omittedFieldCount > 0
  const content = { concepts: finalConcepts, links, truncated, gaps: [] as VocabularyGap[] }
  return {
    vocabularyRef: { id: 'schema-vocabulary', version: '1.0.0', digest: sha256DigestOf(content) },
    concepts: finalConcepts,
    links,
    sources,
    truncated,
    omittedConceptCount,
    omittedFieldCount,
    gaps: [],
  }
}

export interface SemanticSchemaVocabularyDependencies {
  /** Resolves a confirmed mapping; an unknown or unconfirmed ref resolves to `undefined`. */
  readonly mappings: SemanticMappingRegistry
  /** Resolves a published definition version; an unknown or unpublished ref resolves to `undefined`. */
  readonly resolveDefinition: (
    ref: VersionRef,
    ctx: ToolContext,
  ) => Promise<SemanticDefinitionVersion | undefined>
}

/**
 * The service-side implementation of the schema-construction port. It resolves only
 * confirmed mappings and published definitions, so an unconfirmed mapping or an
 * unpublished draft can never enter the vocabulary. All capability access is injected;
 * the class imports no adapter (INV-02).
 */
export class SemanticSchemaVocabularyService implements SchemaVocabularyPort {
  readonly #deps: SemanticSchemaVocabularyDependencies

  constructor(dependencies: SemanticSchemaVocabularyDependencies) {
    this.#deps = dependencies
  }

  async build(request: SchemaVocabularyRequest, ctx: ToolContext): Promise<SchemaVocabulary> {
    const mappings: SemanticMapping[] = []
    for (const ref of request.mappingRefs) {
      const mapping = this.#deps.mappings.resolve(ref)
      if (mapping !== undefined) mappings.push(mapping)
    }
    const definitions: SemanticDefinitionVersion[] = []
    for (const ref of request.definitionRefs) {
      const version = await this.#deps.resolveDefinition(ref, ctx)
      if (version !== undefined) definitions.push(version)
    }
    return buildSchemaVocabulary({
      question: request.question,
      mappings,
      definitions,
      limits: { maxConcepts: request.maxConcepts, maxFields: request.maxFields },
    })
  }
}
