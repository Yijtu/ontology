import type {
  AttributeDefinition,
  IdentityScopeDefinition,
  ObjectDefinition,
  SemanticDefinitionVersion,
  SemanticDefinitionVersionDraft,
  StandardProvenance,
  VersionRef,
} from '@ontology/contracts'
import {
  InMemorySemanticMappingRegistry,
  SemanticSchemaVocabularyService,
  definitionVersionDigest,
  type SemanticMapping,
  type SemanticSchemaVocabularyDependencies,
} from '@ontology/semantic-engine'

/**
 * Shared fixtures for the schema-vocabulary tests (LOCAL-075).
 *
 * One published home-energy definition describes the same logical concepts the mapping
 * fixtures physically map, so the vocabulary can be projected without any physical
 * identifier. `MAPPING_A` and `MAPPING_B` differ only physically and must therefore yield
 * the same normalised vocabulary.
 */

export const VOCAB_NAMESPACE = 'home-energy'
export const VOCAB_DEFINITION_ID = 'home-energy.core'
export const VOCAB_DEFINITION_VERSION = '1.0.0'
export const VOCAB_SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const

export const VOCAB_STANDARD_DIGEST = `sha256:${'a'.repeat(64)}`

function provenance(): StandardProvenance[] {
  return [
    {
      standardRef: { id: 'iec-61851-1', version: '1.0.0', digest: VOCAB_STANDARD_DIGEST },
      provenanceKind: 'international_standard',
      clauseRef: '5.2',
    },
  ]
}

const ENERGY_READING: ObjectDefinition = {
  kind: 'object',
  id: 'energy_reading',
  namespace: VOCAB_NAMESPACE,
  displayName: 'Energy Reading',
  identityScopeId: 'energy_reading_identity',
  standardProvenance: provenance(),
}

const METER: ObjectDefinition = {
  kind: 'object',
  id: 'meter',
  namespace: VOCAB_NAMESPACE,
  displayName: 'Meter',
  identityScopeId: 'meter_identity',
  standardProvenance: provenance(),
}

const ENERGY_READING_IDENTITY: IdentityScopeDefinition = {
  kind: 'identity_scope',
  id: 'energy_reading_identity',
  namespace: VOCAB_NAMESPACE,
  objectId: 'energy_reading',
  scopeDimensions: ['source'],
  identityAttributeIds: ['reading_id'],
  standardProvenance: provenance(),
}

const METER_IDENTITY: IdentityScopeDefinition = {
  kind: 'identity_scope',
  id: 'meter_identity',
  namespace: VOCAB_NAMESPACE,
  objectId: 'meter',
  scopeDimensions: ['source'],
  identityAttributeIds: ['meter_key'],
  standardProvenance: provenance(),
}

function attribute(
  id: string,
  objectId: string,
  overrides: Partial<AttributeDefinition>,
): AttributeDefinition {
  return {
    kind: 'attribute',
    id,
    namespace: VOCAB_NAMESPACE,
    objectId,
    valueType: 'string',
    cardinality: { min: 0, max: 1 },
    standardProvenance: provenance(),
    ...overrides,
  }
}

export function vocabularyDefinitionDraft(): SemanticDefinitionVersionDraft {
  return {
    scopeRef: { tenantId: VOCAB_SCOPE.tenantId, spaceId: VOCAB_SCOPE.spaceId },
    definitionId: VOCAB_DEFINITION_ID,
    version: VOCAB_DEFINITION_VERSION,
    namespace: VOCAB_NAMESPACE,
    layer: 'industry_core',
    standardProvenance: provenance(),
    objects: [ENERGY_READING, METER],
    attributes: [
      attribute('reading_id', 'energy_reading', {
        valueType: 'string',
        cardinality: { min: 1, max: 1 },
        identityKey: true,
      }),
      attribute('meter_id', 'energy_reading', {}),
      attribute('recorded_at', 'energy_reading', { valueType: 'timestamp' }),
      attribute('energy_kwh', 'energy_reading', {
        valueType: 'quantity',
        unit: { unitCode: 'kWh', dimension: 'energy' },
      }),
      attribute('status', 'energy_reading', {
        valueType: 'enum',
        enumValues: ['good', 'suspect'],
      }),
      attribute('meter_key', 'meter', {
        valueType: 'string',
        cardinality: { min: 1, max: 1 },
        identityKey: true,
      }),
      attribute('meter_name', 'meter', {}),
    ],
    relations: [],
    identityScopes: [ENERGY_READING_IDENTITY, METER_IDENTITY],
    ruleConstraints: [],
  }
}

/** A published form of the fixture definition: a pinned ref plus a publication time. */
export function publishedVocabularyDefinition(): SemanticDefinitionVersion {
  const draft = vocabularyDefinitionDraft()
  return {
    ...draft,
    ref: {
      id: VOCAB_DEFINITION_ID,
      version: VOCAB_DEFINITION_VERSION,
      digest: definitionVersionDigest(draft),
    },
    publishedAt: '2026-09-01T00:00:00Z',
  }
}

export const VOCAB_DEFINITION_REF: VersionRef = publishedVocabularyDefinition().ref

/** A vocabulary service whose definition resolver serves exactly the given versions. */
export function vocabularyService(
  mappings: readonly SemanticMapping[],
  definitions: readonly SemanticDefinitionVersion[],
): SemanticSchemaVocabularyService {
  const byRef = new Map(definitions.map((definition) => [refKey(definition.ref), definition]))
  const dependencies: SemanticSchemaVocabularyDependencies = {
    mappings: new InMemorySemanticMappingRegistry(mappings),
    resolveDefinition: (ref) => Promise.resolve(byRef.get(refKey(ref))),
  }
  return new SemanticSchemaVocabularyService(dependencies)
}

function refKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}
