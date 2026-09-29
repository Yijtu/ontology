import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  AttributeDefinition,
  AttributeValueType,
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPutImmutableResponse,
  Cardinality,
  DocumentParseRequest,
  IndustrySchemaSource,
  IdentityScopeDefinition,
  Integrity,
  ObjectDefinition,
  ProvenanceKind,
  RelationDefinition,
  ResourceRef,
  ScopeRef,
  SemanticDefinitionVersion,
  SemanticDefinitionVersionDraft,
  SourceObjectRef,
  StandardProvenance,
  UnitRef,
  VersionRef,
} from '@ontology/contracts'
import {
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  ExtractionPipeline,
  mappingTemplatesOf,
} from '@ontology/application'
import {
  InMemoryDocumentParseStore,
  LocalDocumentExtractionService,
  sha256DigestOfBytes,
} from '@ontology/adapter-extraction-document'
import type { DocumentArtifactStore } from '@ontology/adapter-extraction-document'
import { createBudgetHarness, EDITOR_A } from './job-fixtures'
import { CountingGenerationPort, generationResponse } from './extraction-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'
import { createAjv, expectValid, validator } from '../contracts/helpers'
import {
  buildMappingIndex,
  defineSemanticMapping,
  definitionRecordOf,
  definitionVersionDigest,
  projectIndustrySchema,
  sha256DigestOf,
  type FieldMapping,
  type LinkMapping,
  type MappingDialect,
  type ObjectMapping,
  type SemanticMapping,
  validateDefinitionVersion,
} from '@ontology/semantic-engine'

const EXAMPLES_DIRECTORY = fileURLToPath(new URL('../../deploy/core/examples/', import.meta.url))
const FIXED_NOW = '2026-09-28T00:00:00Z'
const PARSER_VERSION = '1.0.0'

const PROVENANCE_KINDS: ReadonlySet<string> = new Set([
  'international_standard',
  'national_standard',
  'industry_standard',
  'vendor_specification',
  'internal_policy',
  'synthetic_assumption',
])
const ATTRIBUTE_VALUE_TYPES: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'timestamp', 'enum', 'quantity', 'reference',
])

function assetPath(relativePath: string): string {
  return resolve(EXAMPLES_DIRECTORY, relativePath)
}

function readTextAsset(relativePath: string): string {
  return readFileSync(assetPath(relativePath), 'utf8')
}

function readJsonAsset(relativePath: string): unknown {
  const body = readTextAsset(relativePath)
  try {
    const value: unknown = JSON.parse(body)
    return value
  } catch (error) {
    throw new Error(`example asset ${relativePath} is not valid JSON`, { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return value
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
  return value
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`)
  return value
}

function asStringArray(value: unknown, path: string): readonly string[] {
  return asArray(value, path).map((entry, index) => asString(entry, `${path}[${String(index)}]`))
}

function parseScopeRef(value: unknown, path: string): ScopeRef {
  const record = asRecord(value, path)
  return {
    tenantId: asString(record['tenantId'], `${path}.tenantId`),
    spaceId: asString(record['spaceId'], `${path}.spaceId`),
  }
}

function parseVersionRef(value: unknown, path: string): VersionRef {
  const record = asRecord(value, path)
  return {
    id: asString(record['id'], `${path}.id`),
    version: asString(record['version'], `${path}.version`),
    digest: asString(record['digest'], `${path}.digest`),
  }
}

function isProvenanceKind(value: unknown): value is ProvenanceKind {
  return typeof value === 'string' && PROVENANCE_KINDS.has(value)
}

function parseProvenance(value: unknown, path: string): StandardProvenance[] {
  return asArray(value, path).map((entry, index) => {
    const at = `${path}[${String(index)}]`
    const record = asRecord(entry, at)
    const provenanceKind = record['provenanceKind']
    if (!isProvenanceKind(provenanceKind)) throw new Error(`${at}.provenanceKind is unsupported`)
    const clauseRef = record['clauseRef']
    return {
      standardRef: parseVersionRef(record['standardRef'], `${at}.standardRef`),
      provenanceKind,
      ...(clauseRef === undefined ? {} : { clauseRef: asString(clauseRef, `${at}.clauseRef`) }),
    }
  })
}

function parseCardinality(value: unknown, path: string): Cardinality {
  const record = asRecord(value, path)
  const max = record['max']
  return {
    min: asNumber(record['min'], `${path}.min`),
    max: max === 'unbounded' ? max : asNumber(max, `${path}.max`),
  }
}

function isAttributeValueType(value: unknown): value is AttributeValueType {
  return typeof value === 'string' && ATTRIBUTE_VALUE_TYPES.has(value)
}

function parseObjectDefinition(value: unknown, path: string): ObjectDefinition {
  const record = asRecord(value, path)
  if (record['kind'] !== 'object') throw new Error(`${path}.kind must be object`)
  return {
    kind: 'object',
    id: asString(record['id'], `${path}.id`),
    namespace: asString(record['namespace'], `${path}.namespace`),
    displayName: asString(record['displayName'], `${path}.displayName`),
    identityScopeId: asString(record['identityScopeId'], `${path}.identityScopeId`),
    standardProvenance: parseProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseAttributeDefinition(value: unknown, path: string): AttributeDefinition {
  const record = asRecord(value, path)
  if (record['kind'] !== 'attribute') throw new Error(`${path}.kind must be attribute`)
  const valueType = record['valueType']
  if (!isAttributeValueType(valueType)) throw new Error(`${path}.valueType is unsupported`)
  const identityKey = record['identityKey']
  const enumValues = record['enumValues']
  const referencesObjectId = record['referencesObjectId']
  const unitValue = record['unit']
  let unit: UnitRef | undefined
  if (unitValue !== undefined) {
    const unitRecord = asRecord(unitValue, `${path}.unit`)
    unit = {
      unitCode: asString(unitRecord['unitCode'], `${path}.unit.unitCode`),
      dimension: asString(unitRecord['dimension'], `${path}.unit.dimension`),
    }
  }
  return {
    kind: 'attribute',
    id: asString(record['id'], `${path}.id`),
    namespace: asString(record['namespace'], `${path}.namespace`),
    objectId: asString(record['objectId'], `${path}.objectId`),
    valueType,
    cardinality: parseCardinality(record['cardinality'], `${path}.cardinality`),
    ...(identityKey === undefined ? {} : { identityKey: asBoolean(identityKey, `${path}.identityKey`) }),
    ...(unit === undefined ? {} : { unit }),
    ...(enumValues === undefined ? {} : { enumValues: asStringArray(enumValues, `${path}.enumValues`) }),
    ...(referencesObjectId === undefined ? {} : {
      referencesObjectId: asString(referencesObjectId, `${path}.referencesObjectId`),
    }),
    standardProvenance: parseProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseRelationDefinition(value: unknown, path: string): RelationDefinition {
  const record = asRecord(value, path)
  if (record['kind'] !== 'relation') throw new Error(`${path}.kind must be relation`)
  return {
    kind: 'relation',
    id: asString(record['id'], `${path}.id`),
    namespace: asString(record['namespace'], `${path}.namespace`),
    fromObjectId: asString(record['fromObjectId'], `${path}.fromObjectId`),
    toObjectId: asString(record['toObjectId'], `${path}.toObjectId`),
    cardinality: parseCardinality(record['cardinality'], `${path}.cardinality`),
    standardProvenance: parseProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseIdentityScopeDefinition(value: unknown, path: string): IdentityScopeDefinition {
  const record = asRecord(value, path)
  if (record['kind'] !== 'identity_scope') throw new Error(`${path}.kind must be identity_scope`)
  return {
    kind: 'identity_scope',
    id: asString(record['id'], `${path}.id`),
    namespace: asString(record['namespace'], `${path}.namespace`),
    objectId: asString(record['objectId'], `${path}.objectId`),
    scopeDimensions: asStringArray(record['scopeDimensions'], `${path}.scopeDimensions`),
    identityAttributeIds: asStringArray(record['identityAttributeIds'], `${path}.identityAttributeIds`),
    standardProvenance: parseProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseDefinitionDraft(value: unknown, path: string): SemanticDefinitionVersionDraft {
  const record = asRecord(value, path)
  const layer = record['layer']
  if (layer !== 'industry_core' && layer !== 'customer_extension') throw new Error(`${path}.layer is unsupported`)
  const ruleConstraints = asArray(record['ruleConstraints'], `${path}.ruleConstraints`)
  if (ruleConstraints.length !== 0) {
    throw new Error(`${path}.ruleConstraints must stay empty; demo rules enter through the extraction pipeline`)
  }
  return {
    scopeRef: parseScopeRef(record['scopeRef'], `${path}.scopeRef`),
    definitionId: asString(record['definitionId'], `${path}.definitionId`),
    version: asString(record['version'], `${path}.version`),
    namespace: asString(record['namespace'], `${path}.namespace`),
    layer,
    standardProvenance: parseProvenance(record['standardProvenance'], `${path}.standardProvenance`),
    objects: asArray(record['objects'], `${path}.objects`).map((entry, index) =>
      parseObjectDefinition(entry, `${path}.objects[${String(index)}]`)),
    attributes: asArray(record['attributes'], `${path}.attributes`).map((entry, index) =>
      parseAttributeDefinition(entry, `${path}.attributes[${String(index)}]`)),
    relations: asArray(record['relations'], `${path}.relations`).map((entry, index) =>
      parseRelationDefinition(entry, `${path}.relations[${String(index)}]`)),
    identityScopes: asArray(record['identityScopes'], `${path}.identityScopes`).map((entry, index) =>
      parseIdentityScopeDefinition(entry, `${path}.identityScopes[${String(index)}]`)),
    ruleConstraints: [],
  }
}

function projectDefinition(draft: SemanticDefinitionVersionDraft): SemanticDefinitionVersion {
  return {
    ...draft,
    ref: {
      id: draft.definitionId,
      version: draft.version,
      digest: definitionVersionDigest(draft),
    },
    publishedAt: FIXED_NOW,
  }
}

function parseSourceObjectRef(value: unknown, path: string): SourceObjectRef {
  const record = asRecord(value, path)
  const sourceRef = asRecord(record['sourceRef'], `${path}.sourceRef`)
  return {
    sourceRef: {
      namespace: asString(sourceRef['namespace'], `${path}.sourceRef.namespace`),
      sourceId: asString(sourceRef['sourceId'], `${path}.sourceRef.sourceId`),
    },
    objectPath: asString(record['objectPath'], `${path}.objectPath`),
  }
}

function parseScalar(value: unknown, path: string): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`${path} must be a JSON scalar`)
}

function parseFieldMapping(value: unknown, path: string): FieldMapping {
  const record = asRecord(value, path)
  const valueType = record['valueType']
  if (!isAttributeValueType(valueType)) throw new Error(`${path}.valueType is unsupported`)
  const unitValue = record['unit']
  let unit: UnitRef | undefined
  if (unitValue !== undefined) {
    const unitRecord = asRecord(unitValue, `${path}.unit`)
    unit = {
      unitCode: asString(unitRecord['unitCode'], `${path}.unit.unitCode`),
      dimension: asString(unitRecord['dimension'], `${path}.unit.dimension`),
    }
  }
  const unitFactorValue = record['unitFactor']
  const valueMapValue = record['valueMap']
  const identityKeyValue = record['identityKey']
  const valueMap = valueMapValue === undefined ? undefined : asArray(valueMapValue, `${path}.valueMap`).map((entry, index) => {
    const at = `${path}.valueMap[${String(index)}]`
    const mapEntry = asRecord(entry, at)
    return {
      physical: parseScalar(mapEntry['physical'], `${at}.physical`),
      canonical: parseScalar(mapEntry['canonical'], `${at}.canonical`),
    }
  })
  return {
    fieldRef: asString(record['fieldRef'], `${path}.fieldRef`),
    column: asString(record['column'], `${path}.column`),
    valueType,
    ...(unit === undefined ? {} : { unit }),
    ...(unitFactorValue === undefined ? {} : { unitFactor: asNumber(unitFactorValue, `${path}.unitFactor`) }),
    ...(valueMap === undefined ? {} : { valueMap }),
    ...(identityKeyValue === undefined ? {} : { identityKey: asBoolean(identityKeyValue, `${path}.identityKey`) }),
  }
}

function parseObjectMapping(value: unknown, path: string): ObjectMapping {
  const record = asRecord(value, path)
  const relationKind = record['relationKind']
  if (relationKind !== 'table' && relationKind !== 'view') throw new Error(`${path}.relationKind is unsupported`)
  return {
    conceptId: asString(record['conceptId'], `${path}.conceptId`),
    sourceObjectRef: parseSourceObjectRef(record['sourceObjectRef'], `${path}.sourceObjectRef`),
    schema: asString(record['schema'], `${path}.schema`),
    relation: asString(record['relation'], `${path}.relation`),
    relationKind,
    estimatedRows: asNumber(record['estimatedRows'], `${path}.estimatedRows`),
    fields: asArray(record['fields'], `${path}.fields`).map((entry, index) =>
      parseFieldMapping(entry, `${path}.fields[${String(index)}]`)),
  }
}

function parseLinkMapping(value: unknown, path: string): LinkMapping {
  const record = asRecord(value, path)
  const joinKind = record['joinKind']
  if (joinKind !== 'inner' && joinKind !== 'left') throw new Error(`${path}.joinKind is unsupported`)
  return {
    linkId: asString(record['linkId'], `${path}.linkId`),
    fromConceptId: asString(record['fromConceptId'], `${path}.fromConceptId`),
    toConceptId: asString(record['toConceptId'], `${path}.toConceptId`),
    fromColumn: asString(record['fromColumn'], `${path}.fromColumn`),
    toColumn: asString(record['toColumn'], `${path}.toColumn`),
    joinKind,
    cardinality: parseCardinality(record['cardinality'], `${path}.cardinality`),
    scope: { maxFanout: asNumber(asRecord(record['scope'], `${path}.scope`)['maxFanout'], `${path}.scope.maxFanout`) },
  }
}

function parseSemanticMapping(value: unknown, path: string): SemanticMapping {
  const record = asRecord(value, path)
  const declaredRef = parseVersionRef(record['mappingRef'], `${path}.mappingRef`)
  const dialectValue = record['dialect']
  if (!isMappingDialect(dialectValue)) throw new Error(`${path}.dialect is unsupported`)
  const body = {
    dialect: dialectValue,
    objects: asArray(record['objects'], `${path}.objects`).map((entry, index) =>
      parseObjectMapping(entry, `${path}.objects[${String(index)}]`)),
    links: asArray(record['links'], `${path}.links`).map((entry, index) =>
      parseLinkMapping(entry, `${path}.links[${String(index)}]`)),
  }
  const mapping = defineSemanticMapping(declaredRef.id, declaredRef.version, body)
  if (mapping.mappingRef.digest !== declaredRef.digest) {
    throw new Error(`${path}.mappingRef.digest does not match the canonical mapping body`)
  }
  return mapping
}

function isMappingDialect(value: unknown): value is MappingDialect {
  return value === 'duckdb' || value === 'postgres'
}

function attrValues(attributes: readonly { readonly attributeId: string; readonly value: string | number | boolean }[]): Map<string, string | number | boolean> {
  return new Map(attributes.map((attribute) => [attribute.attributeId, attribute.value]))
}

function sha256DigestForText(text: string): string {
  return sha256DigestOf(text)
}

class MemoryDocumentArtifacts implements DocumentArtifactStore {
  readonly #staged = new Map<string, Uint8Array>()
  readonly #artifacts = new Map<string, { readonly ref: ResourceRef; readonly mediaType: string; readonly bytes: Uint8Array }>()

  seedOriginal(bytes: Uint8Array): ResourceRef {
    const ref: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: sha256DigestOfBytes(bytes),
      kind: 'document',
    }
    this.#artifacts.set(ref.id, { ref, mediaType: 'text/plain', bytes })
    return ref
  }

  stage(content: Uint8Array): Promise<{ readonly contentDigest: string; readonly byteSize: number }> {
    const contentDigest = sha256DigestOfBytes(content)
    this.#staged.set(contentDigest, content)
    return Promise.resolve({ contentDigest, byteSize: content.byteLength })
  }

  publish(request: {
    readonly contentDigest: string
    readonly mediaType: string
    readonly byteSize: number
    readonly purpose: 'document' | 'artifact'
  }): Promise<BlobPutImmutableResponse> {
    const bytes = this.#staged.get(request.contentDigest)
    if (bytes === undefined || bytes.byteLength !== request.byteSize) {
      return Promise.reject(new Error('staged example artifact is missing or changed'))
    }
    const ref: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: request.contentDigest,
      kind: request.purpose,
    }
    this.#artifacts.set(ref.id, { ref, mediaType: request.mediaType, bytes })
    const integrity: Integrity = { algorithm: 'sha256', digest: request.contentDigest, verifiedAt: FIXED_NOW }
    return Promise.resolve({ blobRef: ref, contentDigest: request.contentDigest, integrity })
  }

  getAuthorized(request: BlobGetAuthorizedRequest): Promise<BlobGetAuthorizedResponse> {
    const stored = this.#artifacts.get(request.blobRef.id)
    if (stored === undefined || stored.ref.digest !== request.blobRef.digest) {
      return Promise.reject(new Error('example document blob is not available'))
    }
    return Promise.resolve({
      blobRef: stored.ref,
      contentDigest: stored.ref.digest,
      mediaType: stored.mediaType,
      byteSize: stored.bytes.byteLength,
      integrityVerified: true,
    })
  }

  readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    const stored = this.#artifacts.get(request.blobRef.id)
    if (stored === undefined || stored.ref.digest !== request.blobRef.digest) {
      return Promise.reject(new Error('example document blob is not available'))
    }
    return Promise.resolve(stored.bytes)
  }
}

describe('synthetic core example assets', () => {
  it('loads valid semantic definition drafts and derives the extraction schemas', () => {
    for (const scenario of [
      {
        directory: 'transport-facility',
        namespace: 'synthetic-transport-facility',
        objectIds: ['transport_facility', 'transport_district'],
        requiredFields: ['facility_id', 'inspection_due', 'inspection_exempt', 'inspection_required'],
      },
      {
        directory: 'industrial-maintenance',
        namespace: 'synthetic-industrial-maintenance',
        objectIds: ['industrial_asset', 'workshop'],
        requiredFields: ['asset_id', 'operating_hours', 'maintenance_exempt', 'maintenance_required'],
      },
    ]) {
      const draft = parseDefinitionDraft(
        readJsonAsset(`${scenario.directory}/definition-draft.json`),
        `${scenario.directory}/definition-draft.json`,
      )
      expect(validateDefinitionVersion(draft), scenario.directory).toEqual([])
      expect(draft.namespace).toBe(scenario.namespace)
      expect(draft.ruleConstraints).toEqual([])

      const schema = projectIndustrySchema(projectDefinition(draft))
      expect(schema.namespace).toBe(scenario.namespace)
      expect(schema.objects.map((object) => object.objectId).sort()).toEqual([...scenario.objectIds].sort())
      const fieldIds = schema.objects.flatMap((object) => object.attributes.map((attribute) => attribute.attributeId))
      for (const field of scenario.requiredFields) expect(fieldIds).toContain(field)
      expect(schema.relations.length).toBeGreaterThan(0)
      expect(schema.identityScopes.length).toBeGreaterThan(0)
    }
  })

  it('parses independent transport and industrial raw records, maps native IDs, and validates ordinary candidates', async () => {
    const transportDraft = parseDefinitionDraft(readJsonAsset('transport-facility/definition-draft.json'), 'transport')
    const industrialDraft = parseDefinitionDraft(readJsonAsset('industrial-maintenance/definition-draft.json'), 'industrial')
    const transportSchema = projectIndustrySchema(projectDefinition(transportDraft))
    const industrialSchema = projectIndustrySchema(projectDefinition(industrialDraft))
    const parseStore = new InMemoryDocumentParseStore()
    const blobStore = new MemoryDocumentArtifacts()
    const parser = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore, now: () => FIXED_NOW })
    const transportDocuments = await Promise.all([
      parseRawDocument(parser, blobStore, 'transport-facility/records/registry-a.txt', {
        namespace: 'synthetic-transport-demo', sourceId: 'registry-a',
      }),
      parseRawDocument(parser, blobStore, 'transport-facility/records/field-review-b.txt', {
        namespace: 'synthetic-transport-demo', sourceId: 'field-review-b',
      }),
      parseRawDocument(parser, blobStore, 'transport-facility/records/districts.txt', {
        namespace: 'synthetic-transport-demo', sourceId: 'district-directory',
      }),
    ])
    const industrialDocuments = await Promise.all([
      parseRawDocument(parser, blobStore, 'industrial-maintenance/records/canonical-layout.txt', {
        namespace: 'synthetic-industrial-demo', sourceId: 'asset-hours-canonical',
      }),
      parseRawDocument(parser, blobStore, 'industrial-maintenance/records/workshops.txt', {
        namespace: 'synthetic-industrial-demo', sourceId: 'workshop-directory',
      }),
    ])
    const industrialMinutesDocument = await parseRawDocument(parser, blobStore, 'industrial-maintenance/records/minutes-layout.txt', {
      namespace: 'synthetic-industrial-demo', sourceId: 'asset-minutes-layout',
    })
    expect(transportDocuments[0]?.chunks).toHaveLength(6)
    expect(transportDocuments[1]?.chunks).toHaveLength(1)
    expect(industrialMinutesDocument.chunks).toHaveLength(7)
    expect(industrialMinutesDocument.chunks.find((chunk) => chunk.text.includes('I-04'))?.text)
      .toContain('"accumulated_minutes": 6000')
    expect(transportDocuments.every((document) => document.coverage.completeness === 'complete')).toBe(true)

    const budget = createBudgetHarness()
    const ledgerId = randomUUID()
    await budget.service.openLedger({ ledgerId, kind: 'background' }, EDITOR_A)
    const candidates = new InMemoryCandidateStore()
    const generation = new CountingGenerationPort()
    const schemaSource: IndustrySchemaSource = new InMemoryIndustrySchemaSource([
      { ref: transportSchema.definitionRef, schema: transportSchema },
      { ref: industrialSchema.definitionRef, schema: industrialSchema },
    ])
    const pipeline = new ExtractionPipeline({
      schemaSource,
      generation,
      candidates,
      budget: budget.service,
      modelRef: { modelId: 'synthetic-example-controlled-generation', version: '1.0.0' },
      outputLimit: { maxTokens: 512 },
      now: () => FIXED_NOW,
    })

    const parseIds = new Map(transportDocuments.map((document) => [document.parseId, document.sourceRef?.sourceId ?? '']))
    const documentsWithSchema = [
      ...transportDocuments.map((document) => ({ document, schema: transportSchema })),
      ...industrialDocuments.map((document) => ({ document, schema: industrialSchema })),
    ]
    for (const { document, schema } of documentsWithSchema) {
      const input = {
        jobId: randomUUID(),
        parseId: document.parseId,
        parserVersion: document.parserVersion,
        pipelineVersion: '1.0.0',
        definitionRef: schema.definitionRef,
        chunks: document.chunks,
        truncatedChunkIds: document.truncatedChunkIds,
      }
      const run = { ledgerId, ctx: EDITOR_A, signal: new AbortController().signal }
      await pipeline.extract(input, run)
      const validation = await pipeline.validate(input, run)
      expect(validation.failed, document.sourceRef?.sourceId).toBe(0)
    }

    const transportEntities = (await candidates.listCandidates(SCOPE_A, { kind: 'entity' }, EDITOR_A))
      .filter((candidate) => candidate.kind === 'entity' && candidate.objectId === 'transport_facility')
    const goldenTransport = new Map([
      ['T-01', { inspection_due: true, inspection_exempt: false, sourceCount: 2 }],
      ['T-02', { inspection_due: true, inspection_exempt: true, sourceCount: 1 }],
      ['T-03', { inspection_due: true, inspection_exempt: undefined, sourceCount: 1 }],
      ['T-04', { inspection_due: false, inspection_exempt: false, sourceCount: 1 }],
      ['T-05', { inspection_due: true, inspection_exempt: undefined, sourceCount: 1 }],
      ['T-06', { inspection_due: undefined, inspection_exempt: false, sourceCount: 1 }],
    ] as const)
    for (const [nativeId, expected] of goldenTransport) {
      const records = transportEntities.filter((candidate) => candidate.kind === 'entity' && candidate.nativeId === nativeId)
      expect(records).toHaveLength(expected.sourceCount)
      for (const record of records) {
        if (record.kind !== 'entity') throw new Error('transport candidate changed kind')
        const attrs = attrValues(record.attributes)
        expect(attrs.get('inspection_due')).toBe(expected.inspection_due)
        expect(attrs.get('inspection_exempt')).toBe(expected.inspection_exempt)
        expect(record.state).toBe('pending_review')
        expect(record.deterministic).toBe(true)
      }
    }
    const t01Sources = transportEntities
      .filter((candidate) => candidate.kind === 'entity' && candidate.nativeId === 'T-01')
      .flatMap((candidate) => candidate.sourceSpans.map((span) => parseIds.get(span.parseId)))
    expect(new Set(t01Sources)).toEqual(new Set(['registry-a', 'field-review-b']))

    const industrialEntities = (await candidates.listCandidates(SCOPE_A, { kind: 'entity' }, EDITOR_A))
      .filter((candidate) => candidate.kind === 'entity' && candidate.objectId === 'industrial_asset')
    const goldenIndustrial = new Map([
      ['I-01', { operating_hours: 120, maintenance_exempt: false }],
      ['I-02', { operating_hours: 120, maintenance_exempt: true }],
      ['I-03', { operating_hours: 90, maintenance_exempt: false }],
      ['I-04', { operating_hours: 100, maintenance_exempt: false }],
      ['I-05', { operating_hours: undefined, maintenance_exempt: false }],
      ['I-06', { operating_hours: 120, maintenance_exempt: undefined }],
    ] as const)
    for (const [nativeId, expected] of goldenIndustrial) {
      const candidate = industrialEntities.find((entry) => entry.kind === 'entity' && entry.nativeId === nativeId)
      expect(candidate, nativeId).toBeDefined()
      if (candidate?.kind !== 'entity') throw new Error(`missing industrial entity ${nativeId}`)
      const attrs = attrValues(candidate.attributes)
      expect(attrs.get('operating_hours')).toBe(expected.operating_hours)
      expect(attrs.get('maintenance_exempt')).toBe(expected.maintenance_exempt)
      expect(candidate.state).toBe('pending_review')
      expect(candidate.deterministic).toBe(true)
    }
    expect(generation.callCount).toBe(0)
    await parseStore.close()
  })

  it('extracts the synthetic policies through the normal rule candidate pipeline without seeding results', async () => {
    const scenarios = [
      {
        directory: 'transport-facility',
        policyPath: 'transport-facility/policy/rule-rt.txt',
        definitionPath: 'transport-facility/definition-draft.json',
        ruleId: 'R-T',
        objectId: 'transport_facility',
        expression: { op: 'compare', attributeId: 'inspection_due', operator: 'eq', value: true },
        exception: { op: 'compare', attributeId: 'inspection_exempt', operator: 'eq', value: true },
        conclusion: { predicate: 'inspection_required', value: true },
      },
      {
        directory: 'industrial-maintenance',
        policyPath: 'industrial-maintenance/policy/rule-ri.txt',
        definitionPath: 'industrial-maintenance/definition-draft.json',
        ruleId: 'R-I',
        objectId: 'industrial_asset',
        expression: { op: 'compare', attributeId: 'operating_hours', operator: 'gte', value: 100, unitCode: 'h' },
        exception: { op: 'compare', attributeId: 'maintenance_exempt', operator: 'eq', value: true },
        conclusion: { predicate: 'maintenance_required', value: true },
      },
    ] as const

    for (const scenario of scenarios) {
      const draft = parseDefinitionDraft(readJsonAsset(scenario.definitionPath), scenario.definitionPath)
      const schema = projectIndustrySchema(projectDefinition(draft))
      const parseStore = new InMemoryDocumentParseStore()
      const blobStore = new MemoryDocumentArtifacts()
      const parser = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore, now: () => FIXED_NOW })
      const parsed = await parseRawDocument(parser, blobStore, scenario.policyPath, {
        namespace: scenario.directory === 'transport-facility' ? 'synthetic-transport-demo' : 'synthetic-industrial-demo',
        sourceId: `${scenario.ruleId.toLowerCase()}-policy`,
      })
      expect(parsed.chunks).toHaveLength(1)

      const budget = createBudgetHarness()
      const ledgerId = randomUUID()
      await budget.service.openLedger({ ledgerId, kind: 'background' }, EDITOR_A)
      const candidates = new InMemoryCandidateStore()
      const generation = new CountingGenerationPort()
      generation.enqueue(generationResponse({
        entities: [],
        relations: [],
        rules: [{
          ruleId: scenario.ruleId,
          objectId: scenario.objectId,
          severity: 'hard',
          impact: 'high',
          expression: scenario.expression,
          exceptions: [scenario.exception],
          conclusion: scenario.conclusion,
        }],
        exceptions: [],
      }))
      const pipeline = new ExtractionPipeline({
        schemaSource: new InMemoryIndustrySchemaSource([{ ref: schema.definitionRef, schema }]),
        generation,
        candidates,
        budget: budget.service,
        modelRef: { modelId: 'synthetic-example-controlled-generation', version: '1.0.0' },
        outputLimit: { maxTokens: 512 },
        now: () => FIXED_NOW,
      })
      const input = {
        jobId: randomUUID(),
        parseId: parsed.parseId,
        parserVersion: parsed.parserVersion,
        pipelineVersion: '1.0.0',
        definitionRef: schema.definitionRef,
        chunks: parsed.chunks,
        truncatedChunkIds: parsed.truncatedChunkIds,
      }
      const run = { ledgerId, ctx: EDITOR_A, signal: new AbortController().signal }
      expect((await candidates.listCandidates(SCOPE_A, {}, EDITOR_A))).toEqual([])
      const extracted = await pipeline.extract(input, run)
      const validation = await pipeline.validate(input, run)
      expect(extracted.ruleCandidates).toBe(1)
      expect(generation.callCount).toBe(1)
      expect(validation.pendingReview).toBe(1)
      const candidatesAfter = await candidates.listCandidates(SCOPE_A, { jobId: input.jobId, kind: 'rule' }, EDITOR_A)
      expect(candidatesAfter).toHaveLength(1)
      const rule = candidatesAfter[0]
      expect(rule?.kind).toBe('rule')
      if (rule?.kind !== 'rule') throw new Error('the synthetic policy did not yield a representable rule candidate')
      expect(rule.ruleId).toBe(scenario.ruleId)
      expect(rule.objectId).toBe(scenario.objectId)
      expect(rule.conclusion).toEqual(scenario.conclusion)
      expect(rule.exceptions).toHaveLength(1)
      expect(rule.exceptions[0]?.condition).toMatchObject(scenario.exception)
      expect(rule.state).toBe('pending_review')
      expect(rule.sourceSpans[0]?.parseId).toBe(parsed.parseId)
      await parseStore.close()
    }
  })

  it('validates full deployment mappings and proves the minute threshold without lossy conversion', () => {
    const transportSchema = projectIndustrySchema(projectDefinition(
      parseDefinitionDraft(readJsonAsset('transport-facility/definition-draft.json'), 'transport'),
    ))
    const industrialSchema = projectIndustrySchema(projectDefinition(
      parseDefinitionDraft(readJsonAsset('industrial-maintenance/definition-draft.json'), 'industrial'),
    ))
    const mappingCases = [
      { path: 'transport-facility/mappings/registry-a.json', schema: transportSchema },
      { path: 'transport-facility/mappings/field-review-b.json', schema: transportSchema },
      { path: 'industrial-maintenance/mappings/canonical-layout.json', schema: industrialSchema },
      { path: 'industrial-maintenance/mappings/minutes-layout.json', schema: industrialSchema },
    ] as const
    const mappings = mappingCases.map(({ path, schema }) => {
      const mapping = parseSemanticMapping(readJsonAsset(path), path)
      const index = buildMappingIndex(mapping)
      expect(index.objects.size).toBe(mapping.objects.length)
      for (const objectMapping of mapping.objects) {
        const object = schema.objects.find((entry) => entry.objectId === objectMapping.conceptId)
        expect(object, `${path}:${objectMapping.conceptId}`).toBeDefined()
        for (const field of objectMapping.fields) {
          const attribute = object?.attributes.find((entry) => entry.attributeId === field.fieldRef)
          expect(attribute, `${path}:${field.fieldRef}`).toBeDefined()
          if (attribute === undefined) continue
          expect(field.valueType).toBe(attribute.valueType)
          expect(field.unit?.unitCode).toBe(attribute.unitCode)
        }
      }
      return mapping
    })
    expect(mappings[0]?.mappingRef.id).not.toBe(mappings[1]?.mappingRef.id)

    const minutes = mappings[3]
    const asset = minutes?.objects.find((object) => object.conceptId === 'industrial_asset')
    const hours = asset?.fields.find((field) => field.fieldRef === 'operating_hours')
    const waiver = asset?.fields.find((field) => field.fieldRef === 'maintenance_exempt')
    expect(hours?.unit).toEqual({ unitCode: 'h', dimension: 'time' })
    expect(hours?.unitFactor).toBe(60)
    expect(waiver?.valueMap).toEqual([
      { physical: 0, canonical: false },
      { physical: 1, canonical: true },
    ])
    const minutesPerHour = BigInt(hours?.unitFactor ?? 0)
    expect(6000n).toBe(100n * minutesPerHour)
    expect(5999n).toBeLessThan(100n * minutesPerHour)

    const rawMinuteFile = readTextAsset('industrial-maintenance/records/minutes-layout.txt')
    expect(rawMinuteFile).toContain('"asset_key": "I-04"')
    expect(rawMinuteFile).toContain('"accumulated_minutes": 6000')
    expect(rawMinuteFile).toContain('"asset_key": "I-CAL-5999"')
    expect(rawMinuteFile).toContain('"accumulated_minutes": 5999')
  })

  it('validates the public synthetic manifests and checks all local content refs', () => {
    const manifestValidator = validator(createAjv(), 'industry.schema.json', 'IndustryManifest')
    for (const scenario of [
      { directory: 'transport-facility', policy: 'transport-facility/policy/rule-rt.txt' },
      { directory: 'industrial-maintenance', policy: 'industrial-maintenance/policy/rule-ri.txt' },
    ]) {
      const manifest: unknown = readJsonAsset(`${scenario.directory}/industry-manifest.json`)
      expectValid(manifestValidator, manifest, scenario.directory)
      const record = asRecord(manifest, scenario.directory)
      const provenance = asArray(record['standardProvenance'], `${scenario.directory}.standardProvenance`)
      expect(provenance.every((entry) => asRecord(entry, 'provenance').provenanceKind === 'synthetic_assumption')).toBe(true)

      const draft = parseDefinitionDraft(readJsonAsset(`${scenario.directory}/definition-draft.json`), scenario.directory)
      const definition = projectDefinition(draft)
      const definitionRef = parseVersionRef(record['definitionsRef'], `${scenario.directory}.definitionsRef`)
      expect(definitionRef.digest).toBe(definitionVersionDigest(draft))
      expect(parseVersionRef(record['identityPolicyRef'], `${scenario.directory}.identityPolicyRef`)).toEqual(definitionRef)
      expect(parseVersionRef(record['rulePolicyRef'], `${scenario.directory}.rulePolicyRef`).digest)
        .toBe(sha256DigestForText(readTextAsset(scenario.policy)))

      const templates: unknown = readJsonAsset(`${scenario.directory}/mapping-templates.json`)
      expect(templates).toEqual(mappingTemplatesOf(definitionRecordOf(definition)))
      const templateDigest = sha256DigestOf(templates)
      expect(parseVersionRef(record['queryTemplatesRef'], `${scenario.directory}.queryTemplatesRef`).digest)
        .toBe(templateDigest)
      const suite = asRecord(readJsonAsset(`${scenario.directory}/test-suite.json`), `${scenario.directory}.test-suite`)
      const suiteRef = parseVersionRef(suite['ref'], `${scenario.directory}.test-suite.ref`)
      expect(parseVersionRef(record['testSuiteRef'], `${scenario.directory}.testSuiteRef`)).toEqual(suiteRef)
      expect(suiteRef.digest).toBe(sha256DigestOf(suite['cases']))
    }

    const index = asRecord(readJsonAsset('index.json'), 'index')
    expect(index['classification']).toBe('public_synthetic_demo_not_an_industry_standard')
    expect(asArray(index['scenarios'], 'index.scenarios')).toHaveLength(2)
  })
})

async function parseRawDocument(
  parser: LocalDocumentExtractionService,
  blobs: MemoryDocumentArtifacts,
  relativePath: string,
  sourceRef: { readonly namespace: string; readonly sourceId: string },
) {
  const bytes = new TextEncoder().encode(readTextAsset(relativePath))
  const originalRef = blobs.seedOriginal(bytes)
  const request: DocumentParseRequest = {
    scopeRef: SCOPE_A,
    originalRef,
    parserVersion: PARSER_VERSION,
    sourceRef,
  }
  return parser.parse(request, EDITOR_A)
}
