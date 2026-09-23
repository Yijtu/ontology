import type { UnitCode, VersionRef } from './generated/contracts'
import type { AttributeValueType } from './semantic-definitions'
import type { ToolContext } from './trusted'

/**
 * The bounded semantic schema vocabulary injected into a SQL-generation request
 * (SPEC C1/C3, US-020, FR-25/26, LOCAL-075).
 *
 * It is built only from a *confirmed* physical mapping and a *published* definition
 * version. It carries canonical concept/field/link ids, value types, units and enum
 * labels — never a physical schema/relation/column name, so the C3 rule (identifiers
 * come only from the confirmed mapping) is unchanged.
 *
 * The whole record is untrusted data: it can never carry a permission, a tool id or a
 * budget, so injecting it cannot raise the caller's authority (INV-07).
 */
export interface VocabularyField {
  /** Canonical field/attribute id; also the output column alias. */
  readonly fieldRef: string
  readonly valueType: AttributeValueType
  readonly identityKey: boolean
  /** Canonical unit code; present for a quantity field only. */
  readonly unitCode?: UnitCode
  /** Canonical allowed values for an enum field. */
  readonly enumValues?: readonly string[]
}

export interface VocabularyConcept {
  readonly conceptId: string
  readonly displayName: string
  readonly fields: readonly VocabularyField[]
}

export interface VocabularyLink {
  readonly linkId: string
  readonly fromConceptId: string
  readonly toConceptId: string
}

/** Why the vocabulary is incomplete. A gap is explicit, never a silent empty schema. */
export type VocabularyGapCode =
  | 'NO_CONFIRMED_MAPPING'
  | 'NO_PUBLISHED_DEFINITION'
  | 'NO_MAPPED_CONCEPT'
  | 'NO_RELEVANT_FIELD'

export interface VocabularyGap {
  readonly code: VocabularyGapCode
  readonly reason: string
}

export interface SchemaVocabulary {
  /**
   * Content-addressed version of the injected vocabulary. The digest covers exactly the
   * pruned concepts/links/gaps, so two physical mappings of the same logical schema
   * resolve to the same vocabulary version.
   */
  readonly vocabularyRef: VersionRef
  readonly concepts: readonly VocabularyConcept[]
  readonly links: readonly VocabularyLink[]
  /** The exact confirmed-mapping / published-definition versions this vocabulary drew from. */
  readonly sources: readonly VersionRef[]
  /** True when the bound dropped at least one relevant concept or field. */
  readonly truncated: boolean
  readonly omittedConceptCount: number
  readonly omittedFieldCount: number
  /** Empty when the vocabulary is complete; otherwise the explicit degradation reasons. */
  readonly gaps: readonly VocabularyGap[]
}

/**
 * A bounded request. The caps keep the injected vocabulary small and deterministic; the
 * caller (not the model) chooses them.
 */
export interface SchemaVocabularyRequest {
  readonly question: string
  readonly mappingRefs: readonly VersionRef[]
  readonly definitionRefs: readonly VersionRef[]
  readonly maxConcepts: number
  readonly maxFields: number
}

/**
 * The schema-construction stage (C3). It resolves confirmed mappings and published
 * definitions into a bounded vocabulary. The application layer receives this by
 * injection and never imports the engine (INV-02).
 */
export interface SchemaVocabularyPort {
  build(request: SchemaVocabularyRequest, ctx: ToolContext): Promise<SchemaVocabulary>
}
