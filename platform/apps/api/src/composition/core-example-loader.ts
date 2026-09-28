import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type {
  AttributeDefinition,
  AttributeValueType,
  Cardinality,
  CapabilityRequirement,
  ContractRange,
  IndustryManifest,
  IndustryMaturity,
  IndustrySchema,
  IdentityScopeDefinition,
  MappingTemplate,
  Namespace,
  OperationRef,
  ObjectDefinition,
  PackTestSuite,
  ProfileRef,
  ProvenanceKind,
  RelationDefinition,
  RuleComparisonOperator,
  RuleConstraintDefinition,
  RuleExpression,
  ScopeRef,
  SemanticDefinitionVersion,
  SemanticDefinitionVersionDraft,
  SourceObjectRef,
  SourceRef,
  StandardProvenance,
  UnitRef,
  VersionRef,
} from '@ontology/contracts'
import { SCHEMA_DOCUMENTS, definitionRecordOf } from '@ontology/contracts'
import { findIndustryPackViolations } from '@ontology/contracts'
import {
  buildMappingIndex,
  defineSemanticMapping,
  definitionVersionDigest,
  projectIndustrySchema,
  sha256DigestOf,
  validateDefinitionVersion,
} from '@ontology/semantic-engine'
import type {
  FieldMapping,
  LinkMapping,
  MappingDialect,
  ObjectMapping,
  SemanticMapping,
} from '@ontology/semantic-engine'
import { mappingTemplatesOf } from '@ontology/application'

const DEFAULT_INDEX_PATH = fileURLToPath(new URL('../../../../deploy/core/examples/index.json', import.meta.url))
const INDEX_SCHEMA_VERSION = 'core-synthetic-industry-examples@1'
const INDEX_CLASSIFICATION = 'public_synthetic_demo_not_an_industry_standard'
const MAX_ASSET_BYTES = 8 * 1024 * 1024
const CONTRACT_SCHEMA_BASE = 'https://ontology.local/schema'
const CONTRACT_SCHEMA_FILE_BY_NAME: Readonly<Record<string, string>> = {
  IndustryManifest: 'industry.schema.json',
  ProfileRef: 'industry.schema.json',
  Namespace: 'common.schema.json',
  ScopeRef: 'common.schema.json',
  VersionRef: 'common.schema.json',
  SourceRef: 'common.schema.json',
  SourceObjectRef: 'common.schema.json',
}

export type CoreExampleLoaderErrorCode =
  | 'INVALID_INDEX'
  | 'INVALID_ASSET'
  | 'ASSET_PATH_INVALID'
  | 'ASSET_READ_FAILED'
  | 'INVALID_DEFINITION'
  | 'INVALID_MAPPING'
  | 'CONTENT_DIGEST_MISMATCH'

export class CoreExampleLoaderError extends Error {
  readonly code: CoreExampleLoaderErrorCode

  constructor(code: CoreExampleLoaderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CoreExampleLoaderError'
    this.code = code
  }
}

export interface LoadCoreExamplesOptions {
  /** Defaults to this repository's `deploy/core/examples/index.json`. */
  readonly indexPath?: string
  /** Trusted tenant/space supplied by the host. The file's sample scope is always replaced. */
  readonly targetScopeRef: ScopeRef
}

export interface CoreExampleSourceFile {
  readonly sourceRef: SourceRef
  /** Resolved absolute path, checked to remain within the examples index directory. */
  readonly path: string
  readonly mediaType: string
}

export interface CoreExamplePhysicalMapping {
  readonly mapping: SemanticMapping
  readonly ref: VersionRef
  /** Resolved absolute path, checked to remain within the examples index directory. */
  readonly path: string
}

export interface CoreExampleScenario {
  readonly scenarioId: string
  readonly label: string
  readonly profileRef: ProfileRef
  readonly namespace: Namespace
  readonly industryManifest: IndustryManifest
  /** Validated against the target scope; this remains a draft and is not published here. */
  readonly definitionDraft: SemanticDefinitionVersionDraft
  readonly definitionRef: VersionRef
  /** Pure projection of the validated definition draft for `ExtractionPipeline`. */
  readonly industrySchema: IndustrySchema
  readonly mappingTemplates: readonly MappingTemplate[]
  readonly physicalMappings: readonly CoreExamplePhysicalMapping[]
  readonly rawSources: readonly CoreExampleSourceFile[]
  readonly syntheticPolicy: CoreExampleSourceFile
  readonly testSuite: PackTestSuite
  readonly goldenEntityIds: readonly string[]
  readonly calibrationOnlyEntityIds?: readonly string[]
}

export interface LoadedCoreExamples {
  readonly indexPath: string
  readonly classification: typeof INDEX_CLASSIFICATION
  readonly scenarios: readonly CoreExampleScenario[]
}

interface IndexSourceFile {
  readonly sourceRef: SourceRef
  readonly path: string
  readonly mediaType: string
}

interface IndexMappingFile {
  readonly ref: VersionRef
  readonly path: string
}

interface IndexScenario {
  readonly scenarioId: string
  readonly label: string
  readonly profileRef: ProfileRef
  readonly namespace: Namespace
  readonly industryManifest: string
  readonly definitionDraft: string
  readonly mappingTemplates: string
  readonly testSuite: string
  readonly rawSources: readonly IndexSourceFile[]
  readonly syntheticPolicy: IndexSourceFile
  readonly physicalMappings: readonly IndexMappingFile[]
  readonly goldenEntityIds: readonly string[]
  readonly calibrationOnlyEntityIds?: readonly string[]
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: true })
addFormats(ajv)
for (const document of SCHEMA_DOCUMENTS) ajv.addSchema(document)

function fail(
  code: CoreExampleLoaderErrorCode,
  path: string,
  detail: string,
  cause?: unknown,
): never {
  throw new CoreExampleLoaderError(code, `${path}: ${detail}`, cause === undefined ? undefined : { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('INVALID_ASSET', path, 'expected an object')
  return value
}

function arrayOf(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('INVALID_ASSET', path, 'expected an array')
  return value
}

function stringOf(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_ASSET', path, 'expected a non-empty string')
  return value
}

function numberOf(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_ASSET', path, 'expected a finite number')
  return value
}

function booleanOf(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_ASSET', path, 'expected a boolean')
  return value
}

function stringsOf(value: unknown, path: string): readonly string[] {
  return arrayOf(value, path).map((entry, index) => stringOf(entry, `${path}[${String(index)}]`))
}

function validateContractSchema(name: string, value: unknown, path: string): void {
  const schemaFile = CONTRACT_SCHEMA_FILE_BY_NAME[name]
  if (schemaFile === undefined) fail('INVALID_INDEX', path, `canonical schema ${name} is not registered`)
  const validator = ajv.getSchema(`${CONTRACT_SCHEMA_BASE}/${schemaFile}#/$defs/${name}`)
  if (validator === undefined) fail('INVALID_INDEX', path, `canonical ${name} schema is not registered`)
  if (!validator(value)) {
    const detail = (validator.errors ?? []).map((error) => `${error.instancePath || '$'} ${error.message ?? 'invalid'}`).join('; ')
    fail('INVALID_ASSET', path, `canonical ${name} validation failed: ${detail}`)
  }
}

function parseScopeRef(value: unknown, path: string): ScopeRef {
  validateContractSchema('ScopeRef', value, path)
  const record = recordOf(value, path)
  return { tenantId: stringOf(record['tenantId'], `${path}.tenantId`), spaceId: stringOf(record['spaceId'], `${path}.spaceId`) }
}

function isProvenanceKind(value: unknown): value is ProvenanceKind {
  return typeof value === 'string' && PROVENANCE_KINDS.has(value)
}

function isAttributeValueType(value: unknown): value is AttributeValueType {
  return typeof value === 'string' && ATTRIBUTE_TYPES.has(value)
}

function isRuleComparisonOperator(value: unknown): value is RuleComparisonOperator {
  return typeof value === 'string' && COMPARISON_OPERATORS.has(value)
}

function isMappingDialect(value: unknown): value is MappingDialect {
  return value === 'postgres' || value === 'duckdb'
}

function parseProfileRef(value: unknown, path: string): ProfileRef {
  validateContractSchema('ProfileRef', value, path)
  const record = recordOf(value, path)
  return { id: stringOf(record['id'], `${path}.id`), version: stringOf(record['version'], `${path}.version`) }
}

function parseVersionRef(value: unknown, path: string): VersionRef {
  validateContractSchema('VersionRef', value, path)
  const record = recordOf(value, path)
  return {
    id: stringOf(record['id'], `${path}.id`),
    version: stringOf(record['version'], `${path}.version`),
    digest: stringOf(record['digest'], `${path}.digest`),
  }
}

function parseSourceFile(value: unknown, path: string): IndexSourceFile {
  const record = recordOf(value, path)
  validateContractSchema('SourceRef', record['sourceRef'], `${path}.sourceRef`)
  const sourceRecord = recordOf(record['sourceRef'], `${path}.sourceRef`)
  const mediaType = stringOf(record['mediaType'], `${path}.mediaType`).split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'text/plain' && mediaType !== 'text/markdown' && mediaType !== 'text/x-markdown') {
    fail('INVALID_INDEX', `${path}.mediaType`, 'only text formats supported by the local document parser are allowed')
  }
  return {
    sourceRef: {
      namespace: stringOf(sourceRecord['namespace'], `${path}.sourceRef.namespace`),
      sourceId: stringOf(sourceRecord['sourceId'], `${path}.sourceRef.sourceId`),
    },
    path: stringOf(record['path'], `${path}.path`),
    mediaType,
  }
}

function parseIndexScenario(value: unknown, path: string): IndexScenario {
  const record = recordOf(value, path)
  const rawMappings = arrayOf(record['physicalMappings'], `${path}.physicalMappings`).map((entry, index) => {
    const at = `${path}.physicalMappings[${String(index)}]`
    const mapping = recordOf(entry, at)
    return {
      ref: parseVersionRef(mapping['mappingRef'], `${at}.mappingRef`),
      path: stringOf(mapping['path'], `${at}.path`),
    }
  })
  const calibrationIds = record['calibrationOnlyEntityIds']
  const namespace = record['namespace']
  validateContractSchema('Namespace', namespace, `${path}.namespace`)
  return {
    scenarioId: stringOf(record['scenarioId'], `${path}.scenarioId`),
    label: stringOf(record['label'], `${path}.label`),
    profileRef: parseProfileRef(record['profileRef'], `${path}.profileRef`),
    namespace: stringOf(namespace, `${path}.namespace`),
    industryManifest: stringOf(record['industryManifest'], `${path}.industryManifest`),
    definitionDraft: stringOf(record['definitionDraft'], `${path}.definitionDraft`),
    mappingTemplates: stringOf(record['mappingTemplates'], `${path}.mappingTemplates`),
    testSuite: stringOf(record['testSuite'], `${path}.testSuite`),
    rawSources: arrayOf(record['rawSources'], `${path}.rawSources`).map((entry, index) =>
      parseSourceFile(entry, `${path}.rawSources[${String(index)}]`)),
    syntheticPolicy: parseSourceFile(record['syntheticPolicy'], `${path}.syntheticPolicy`),
    physicalMappings: rawMappings,
    goldenEntityIds: stringsOf(record['goldenEntityIds'], `${path}.goldenEntityIds`),
    ...(calibrationIds === undefined ? {} : {
      calibrationOnlyEntityIds: stringsOf(calibrationIds, `${path}.calibrationOnlyEntityIds`),
    }),
  }
}

function parseIndex(value: unknown): { readonly classification: typeof INDEX_CLASSIFICATION; readonly scenarios: readonly IndexScenario[] } {
  const record = recordOf(value, 'index')
  if (record['schemaVersion'] !== INDEX_SCHEMA_VERSION) fail('INVALID_INDEX', 'index.schemaVersion', 'unsupported index version')
  if (record['classification'] !== INDEX_CLASSIFICATION) {
    fail('INVALID_INDEX', 'index.classification', 'synthetic-only classification marker is required')
  }
  const scenarios = arrayOf(record['scenarios'], 'index.scenarios').map((entry, index) =>
    parseIndexScenario(entry, `index.scenarios[${String(index)}]`))
  if (scenarios.length === 0) fail('INVALID_INDEX', 'index.scenarios', 'at least one scenario is required')
  const scenarioIds = new Set<string>()
  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.scenarioId)) fail('INVALID_INDEX', 'index.scenarios', 'scenario IDs must be unique')
    scenarioIds.add(scenario.scenarioId)
  }
  return { classification: INDEX_CLASSIFICATION, scenarios }
}

function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    fail('ASSET_READ_FAILED', path, 'asset could not be read', error)
  }
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    fail('INVALID_ASSET', path, 'asset is not valid JSON', error)
  }
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail('ASSET_READ_FAILED', path, 'asset could not be read', error)
  }
}

const PROVENANCE_KINDS: ReadonlySet<string> = new Set([
  'international_standard', 'national_standard', 'industry_standard', 'vendor_specification',
  'internal_policy', 'synthetic_assumption',
])
const ATTRIBUTE_TYPES: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'timestamp', 'enum', 'quantity', 'reference',
])
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte'])

function parseCardinality(value: unknown, path: string): Cardinality {
  const record = recordOf(value, path)
  const min = record['min']
  const max = record['max']
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) fail('INVALID_ASSET', `${path}.min`, 'expected a non-negative integer')
  if (max !== 'unbounded' && (typeof max !== 'number' || !Number.isInteger(max) || max < min)) {
    fail('INVALID_ASSET', `${path}.max`, 'expected an integer not smaller than min, or unbounded')
  }
  return { min, max }
}

function parseUnit(value: unknown, path: string): UnitRef {
  const record = recordOf(value, path)
  return { unitCode: stringOf(record['unitCode'], `${path}.unitCode`), dimension: stringOf(record['dimension'], `${path}.dimension`) }
}

function parseStandardProvenance(value: unknown, path: string): StandardProvenance[] {
  return arrayOf(value, path).map((entry, index) => {
    const at = `${path}[${String(index)}]`
    const record = recordOf(entry, at)
    const provenanceKind = record['provenanceKind']
    if (!isProvenanceKind(provenanceKind)) {
      fail('INVALID_ASSET', `${at}.provenanceKind`, 'unknown provenance kind')
    }
    const clauseRef = record['clauseRef']
    return {
      standardRef: parseVersionRef(record['standardRef'], `${at}.standardRef`),
      provenanceKind,
      ...(clauseRef === undefined ? {} : { clauseRef: stringOf(clauseRef, `${at}.clauseRef`) }),
    }
  })
}

function parseDefinitionObject(value: unknown, path: string): ObjectDefinition {
  const record = recordOf(value, path)
  if (record['kind'] !== 'object') fail('INVALID_ASSET', `${path}.kind`, 'expected object')
  return {
    kind: 'object',
    id: stringOf(record['id'], `${path}.id`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    displayName: stringOf(record['displayName'], `${path}.displayName`),
    identityScopeId: stringOf(record['identityScopeId'], `${path}.identityScopeId`),
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseDefinitionAttribute(value: unknown, path: string): AttributeDefinition {
  const record = recordOf(value, path)
  if (record['kind'] !== 'attribute') fail('INVALID_ASSET', `${path}.kind`, 'expected attribute')
  const valueType = record['valueType']
  if (!isAttributeValueType(valueType)) fail('INVALID_ASSET', `${path}.valueType`, 'unknown attribute type')
  const enumValues = record['enumValues']
  const unit = record['unit']
  const identityKey = record['identityKey']
  const referencesObjectId = record['referencesObjectId']
  if (identityKey !== undefined && typeof identityKey !== 'boolean') fail('INVALID_ASSET', `${path}.identityKey`, 'expected a boolean')
  return {
    kind: 'attribute',
    id: stringOf(record['id'], `${path}.id`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    objectId: stringOf(record['objectId'], `${path}.objectId`),
    valueType,
    cardinality: parseCardinality(record['cardinality'], `${path}.cardinality`),
    ...(identityKey === undefined ? {} : { identityKey }),
    ...(unit === undefined ? {} : { unit: parseUnit(unit, `${path}.unit`) }),
    ...(enumValues === undefined ? {} : { enumValues: arrayOf(enumValues, `${path}.enumValues`).map((entry, index) => stringOf(entry, `${path}.enumValues[${String(index)}]`)) }),
    ...(referencesObjectId === undefined ? {} : { referencesObjectId: stringOf(referencesObjectId, `${path}.referencesObjectId`) }),
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseDefinitionRelation(value: unknown, path: string): RelationDefinition {
  const record = recordOf(value, path)
  if (record['kind'] !== 'relation') fail('INVALID_ASSET', `${path}.kind`, 'expected relation')
  return {
    kind: 'relation',
    id: stringOf(record['id'], `${path}.id`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    fromObjectId: stringOf(record['fromObjectId'], `${path}.fromObjectId`),
    toObjectId: stringOf(record['toObjectId'], `${path}.toObjectId`),
    cardinality: parseCardinality(record['cardinality'], `${path}.cardinality`),
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseDefinitionIdentityScope(value: unknown, path: string): IdentityScopeDefinition {
  const record = recordOf(value, path)
  if (record['kind'] !== 'identity_scope') fail('INVALID_ASSET', `${path}.kind`, 'expected identity_scope')
  return {
    kind: 'identity_scope',
    id: stringOf(record['id'], `${path}.id`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    objectId: stringOf(record['objectId'], `${path}.objectId`),
    scopeDimensions: arrayOf(record['scopeDimensions'], `${path}.scopeDimensions`).map((entry, index) => stringOf(entry, `${path}.scopeDimensions[${String(index)}]`)),
    identityAttributeIds: arrayOf(record['identityAttributeIds'], `${path}.identityAttributeIds`).map((entry, index) => stringOf(entry, `${path}.identityAttributeIds[${String(index)}]`)),
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseRuleExpression(value: unknown, path: string): RuleExpression {
  const record = recordOf(value, path)
  const op = stringOf(record['op'], `${path}.op`)
  switch (op) {
    case 'all':
    case 'any':
      return { op, operands: arrayOf(record['operands'], `${path}.operands`).map((entry, index) => parseRuleExpression(entry, `${path}.operands[${String(index)}]`)) }
    case 'not':
      return { op, operand: parseRuleExpression(record['operand'], `${path}.operand`) }
    case 'compare': {
      const operator = record['operator']
      if (!isRuleComparisonOperator(operator)) fail('INVALID_ASSET', `${path}.operator`, 'unknown comparison operator')
      const compared = record['value']
      if (typeof compared !== 'string' && typeof compared !== 'number' && typeof compared !== 'boolean') fail('INVALID_ASSET', `${path}.value`, 'comparison value must be scalar')
      const unit = record['unit']
      return {
        op,
        attributeId: stringOf(record['attributeId'], `${path}.attributeId`),
        operator,
        value: compared,
        ...(unit === undefined ? {} : { unit: parseUnit(unit, `${path}.unit`) }),
      }
    }
    case 'range': {
      const min = record['min']
      const max = record['max']
      const unit = record['unit']
      return {
        op,
        attributeId: stringOf(record['attributeId'], `${path}.attributeId`),
        ...(min === undefined ? {} : { min: numberOf(min, `${path}.min`) }),
        ...(max === undefined ? {} : { max: numberOf(max, `${path}.max`) }),
        ...(unit === undefined ? {} : { unit: parseUnit(unit, `${path}.unit`) }),
      }
    }
    case 'relation':
      return { op, relationId: stringOf(record['relationId'], `${path}.relationId`) }
    default:
      return fail('INVALID_ASSET', `${path}.op`, 'unknown rule expression operator')
  }
}

function parseRuleConstraint(value: unknown, path: string): RuleConstraintDefinition {
  const record = recordOf(value, path)
  if (record['kind'] !== 'rule_constraint') fail('INVALID_ASSET', `${path}.kind`, 'expected rule_constraint')
  const severity = record['severity']
  if (severity !== 'hard' && severity !== 'soft') fail('INVALID_ASSET', `${path}.severity`, 'expected hard or soft')
  return {
    kind: 'rule_constraint',
    id: stringOf(record['id'], `${path}.id`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    objectId: stringOf(record['objectId'], `${path}.objectId`),
    severity,
    expression: parseRuleExpression(record['expression'], `${path}.expression`),
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
  }
}

function parseDefinitionDraft(value: unknown, path: string, targetScopeRef: ScopeRef): SemanticDefinitionVersionDraft {
  const record = recordOf(value, path)
  const layer = record['layer']
  if (layer !== 'industry_core' && layer !== 'customer_extension') fail('INVALID_ASSET', `${path}.layer`, 'unknown definition layer')
  const draft: SemanticDefinitionVersionDraft = {
    scopeRef: targetScopeRef,
    definitionId: stringOf(record['definitionId'], `${path}.definitionId`),
    version: stringOf(record['version'], `${path}.version`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    layer,
    ...(record['baseRef'] === undefined ? {} : { baseRef: parseVersionRef(record['baseRef'], `${path}.baseRef`) }),
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
    objects: arrayOf(record['objects'], `${path}.objects`).map((entry, index) => parseDefinitionObject(entry, `${path}.objects[${String(index)}]`)),
    attributes: arrayOf(record['attributes'], `${path}.attributes`).map((entry, index) => parseDefinitionAttribute(entry, `${path}.attributes[${String(index)}]`)),
    relations: arrayOf(record['relations'], `${path}.relations`).map((entry, index) => parseDefinitionRelation(entry, `${path}.relations[${String(index)}]`)),
    identityScopes: arrayOf(record['identityScopes'], `${path}.identityScopes`).map((entry, index) => parseDefinitionIdentityScope(entry, `${path}.identityScopes[${String(index)}]`)),
    ruleConstraints: arrayOf(record['ruleConstraints'], `${path}.ruleConstraints`).map((entry, index) => parseRuleConstraint(entry, `${path}.ruleConstraints[${String(index)}]`)),
  }
  const issues = validateDefinitionVersion(draft)
  if (issues.length > 0) fail('INVALID_DEFINITION', path, issues.map((issue) => `${issue.pointer}: ${issue.reason}`).join('; '))
  return draft
}

function parseMappingTemplate(value: unknown, path: string): MappingTemplate {
  const record = recordOf(value, path)
  return {
    conceptId: stringOf(record['conceptId'], `${path}.conceptId`),
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    fields: arrayOf(record['fields'], `${path}.fields`).map((entry, index) => {
      const at = `${path}.fields[${String(index)}]`
      const field = recordOf(entry, at)
      const valueType = field['valueType']
      if (!isAttributeValueType(valueType)) fail('INVALID_ASSET', `${at}.valueType`, 'unknown attribute type')
      const unitCode = field['unitCode']
      return {
        fieldRef: stringOf(field['fieldRef'], `${at}.fieldRef`),
        valueType,
        identityKey: booleanOf(field['identityKey'], `${at}.identityKey`),
        ...(unitCode === undefined ? {} : { unitCode: stringOf(unitCode, `${at}.unitCode`) }),
      }
    }),
  }
}

function parseMappingTemplates(value: unknown, path: string): MappingTemplate[] {
  return arrayOf(value, path).map((entry, index) => parseMappingTemplate(entry, `${path}[${String(index)}]`))
}

function parseTestSuite(value: unknown, path: string): PackTestSuite {
  const record = recordOf(value, path)
  return {
    ref: parseVersionRef(record['ref'], `${path}.ref`),
    cases: arrayOf(record['cases'], `${path}.cases`).map((entry, index) => {
      const at = `${path}.cases[${String(index)}]`
      const testCase = recordOf(entry, at)
      const expectedStatus = testCase['expectedStatus']
      if (expectedStatus !== 'resolved' && expectedStatus !== 'missing_capabilities') {
        fail('INVALID_ASSET', `${at}.expectedStatus`, 'unsupported test case status')
      }
      return {
        caseId: stringOf(testCase['caseId'], `${at}.caseId`),
        question: stringOf(testCase['question'], `${at}.question`),
        expectedCapabilities: stringsOf(testCase['expectedCapabilities'], `${at}.expectedCapabilities`),
        expectedStatus,
      }
    }),
  }
}

function isIndustryMaturity(value: unknown): value is IndustryMaturity {
  return value === 'planned' || value === 'preview' || value === 'stable' || value === 'deprecated'
}

function parseContractRange(value: unknown, path: string): ContractRange {
  const record = recordOf(value, path)
  const max = record['max']
  return {
    min: stringOf(record['min'], `${path}.min`),
    ...(max === undefined ? {} : { max: stringOf(max, `${path}.max`) }),
  }
}

function parseCapabilityRequirement(value: unknown, path: string): CapabilityRequirement {
  const record = recordOf(value, path)
  return {
    name: stringOf(record['name'], `${path}.name`),
    versionRange: parseContractRange(record['versionRange'], `${path}.versionRange`),
  }
}

function parseOperationRef(value: unknown, path: string): OperationRef {
  const record = recordOf(value, path)
  return {
    id: stringOf(record['id'], `${path}.id`),
    version: stringOf(record['version'], `${path}.version`),
  }
}

function parseIndustryManifest(value: unknown, path: string): IndustryManifest {
  validateContractSchema('IndustryManifest', value, path)
  const record = recordOf(value, path)
  const maturity = record['maturity']
  if (!isIndustryMaturity(maturity)) fail('INVALID_ASSET', `${path}.maturity`, 'unknown industry maturity')
  const operationRefs = record['operationRefs']
  const extensionRefs = record['extensionRefs']
  return {
    namespace: stringOf(record['namespace'], `${path}.namespace`),
    maturity,
    standardProvenance: parseStandardProvenance(record['standardProvenance'], `${path}.standardProvenance`),
    definitionsRef: parseVersionRef(record['definitionsRef'], `${path}.definitionsRef`),
    identityPolicyRef: parseVersionRef(record['identityPolicyRef'], `${path}.identityPolicyRef`),
    rulePolicyRef: parseVersionRef(record['rulePolicyRef'], `${path}.rulePolicyRef`),
    queryTemplatesRef: parseVersionRef(record['queryTemplatesRef'], `${path}.queryTemplatesRef`),
    requiredCapabilities: arrayOf(record['requiredCapabilities'], `${path}.requiredCapabilities`).map((entry, index) =>
      parseCapabilityRequirement(entry, `${path}.requiredCapabilities[${String(index)}]`)),
    testSuiteRef: parseVersionRef(record['testSuiteRef'], `${path}.testSuiteRef`),
    ...(operationRefs === undefined ? {} : {
      operationRefs: arrayOf(operationRefs, `${path}.operationRefs`).map((entry, index) =>
        parseOperationRef(entry, `${path}.operationRefs[${String(index)}]`)),
    }),
    ...(extensionRefs === undefined ? {} : {
      extensionRefs: arrayOf(extensionRefs, `${path}.extensionRefs`).map((entry, index) =>
        parseVersionRef(entry, `${path}.extensionRefs[${String(index)}]`)),
    }),
  }
}

function resolveAsset(directory: string, relativePath: string, label: string): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) {
    fail('ASSET_PATH_INVALID', label, 'asset paths must stay relative to the examples index')
  }
  let base: string
  let candidate: string
  try {
    base = realpathSync(directory)
    candidate = realpathSync(resolve(base, relativePath))
  } catch (error) {
    fail('ASSET_READ_FAILED', label, 'asset could not be resolved', error)
  }
  const distance = relative(base, candidate)
  if (distance === '' || distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) {
    fail('ASSET_PATH_INVALID', label, 'asset resolves outside the examples index directory')
  }
  try {
    const status = statSync(candidate)
    if (!status.isFile()) fail('ASSET_PATH_INVALID', label, 'asset path must be a regular file')
    if (status.size > MAX_ASSET_BYTES) fail('ASSET_READ_FAILED', label, 'asset exceeds the size limit')
  } catch (error) {
    if (error instanceof CoreExampleLoaderError) throw error
    fail('ASSET_READ_FAILED', label, 'asset could not be read', error)
  }
  return candidate
}

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function buildSemanticMapping(value: unknown, path: string): SemanticMapping {
  const record = recordOf(value, path)
  const declaredRef = parseVersionRef(record['mappingRef'], `${path}.mappingRef`)
  const dialectValue = record['dialect']
  if (!isMappingDialect(dialectValue)) fail('INVALID_MAPPING', `${path}.dialect`, 'unsupported SQL dialect')
  const mapping: SemanticMapping = defineSemanticMapping(declaredRef.id, declaredRef.version, {
    dialect: dialectValue,
    objects: arrayOf(record['objects'], `${path}.objects`).map((entry, index) => parseObjectMapping(entry, `${path}.objects[${String(index)}]`)),
    links: arrayOf(record['links'], `${path}.links`).map((entry, index) => parseLinkMapping(entry, `${path}.links[${String(index)}]`)),
  })
  if (!sameVersionRef(mapping.mappingRef, declaredRef)) {
    fail('CONTENT_DIGEST_MISMATCH', `${path}.mappingRef`, 'mapping digest does not match its canonical body')
  }
  try {
    buildMappingIndex(mapping)
  } catch (error) {
    fail('INVALID_MAPPING', path, error instanceof Error ? error.message : 'mapping is invalid', error)
  }
  return mapping
}

function parseObjectMapping(value: unknown, path: string): ObjectMapping {
  const record = recordOf(value, path)
  const relationKind = record['relationKind']
  if (relationKind !== 'table' && relationKind !== 'view') fail('INVALID_MAPPING', `${path}.relationKind`, 'unsupported relation kind')
  return {
    conceptId: stringOf(record['conceptId'], `${path}.conceptId`),
    sourceObjectRef: parseSourceObjectRef(record['sourceObjectRef'], `${path}.sourceObjectRef`),
    schema: stringOf(record['schema'], `${path}.schema`),
    relation: stringOf(record['relation'], `${path}.relation`),
    relationKind,
    estimatedRows: numberOf(record['estimatedRows'], `${path}.estimatedRows`),
    fields: arrayOf(record['fields'], `${path}.fields`).map((entry, index) => parseFieldMapping(entry, `${path}.fields[${String(index)}]`)),
  }
}

function parseSourceObjectRef(value: unknown, path: string): SourceObjectRef {
  const record = recordOf(value, path)
  validateContractSchema('SourceObjectRef', record, path)
  const source = recordOf(record['sourceRef'], `${path}.sourceRef`)
  return {
    sourceRef: { namespace: stringOf(source['namespace'], `${path}.sourceRef.namespace`), sourceId: stringOf(source['sourceId'], `${path}.sourceRef.sourceId`) },
    objectPath: stringOf(record['objectPath'], `${path}.objectPath`),
  }
}

function parseFieldMapping(value: unknown, path: string): FieldMapping {
  const record = recordOf(value, path)
  const valueType = record['valueType']
  if (!isAttributeValueType(valueType)) fail('INVALID_MAPPING', `${path}.valueType`, 'unknown attribute type')
  const unitValue = record['unit']
  const unit = unitValue === undefined ? undefined : parseUnit(unitValue, `${path}.unit`)
  const unitFactor = record['unitFactor']
  const identityKey = record['identityKey']
  const valueMap = record['valueMap']
  return {
    fieldRef: stringOf(record['fieldRef'], `${path}.fieldRef`),
    column: stringOf(record['column'], `${path}.column`),
    valueType,
    ...(unit === undefined ? {} : { unit }),
    ...(unitFactor === undefined ? {} : { unitFactor: numberOf(unitFactor, `${path}.unitFactor`) }),
    ...(identityKey === undefined ? {} : { identityKey: booleanOf(identityKey, `${path}.identityKey`) }),
    ...(valueMap === undefined ? {} : { valueMap: arrayOf(valueMap, `${path}.valueMap`).map((entry, index) => {
      const at = `${path}.valueMap[${String(index)}]`
      const mapping = recordOf(entry, at)
      return { physical: scalarOf(mapping['physical'], `${at}.physical`), canonical: scalarOf(mapping['canonical'], `${at}.canonical`) }
    }) }),
  }
}

function scalarOf(value: unknown, path: string): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fail('INVALID_MAPPING', path, 'expected a JSON scalar')
}

function parseLinkMapping(value: unknown, path: string): LinkMapping {
  const record = recordOf(value, path)
  const joinKind = record['joinKind']
  if (joinKind !== 'inner' && joinKind !== 'left') fail('INVALID_MAPPING', `${path}.joinKind`, 'unsupported join kind')
  const scope = recordOf(record['scope'], `${path}.scope`)
  return {
    linkId: stringOf(record['linkId'], `${path}.linkId`),
    fromConceptId: stringOf(record['fromConceptId'], `${path}.fromConceptId`),
    toConceptId: stringOf(record['toConceptId'], `${path}.toConceptId`),
    fromColumn: stringOf(record['fromColumn'], `${path}.fromColumn`),
    toColumn: stringOf(record['toColumn'], `${path}.toColumn`),
    joinKind,
    cardinality: parseCardinality(record['cardinality'], `${path}.cardinality`),
    scope: { maxFanout: numberOf(scope['maxFanout'], `${path}.scope.maxFanout`) },
  }
}

function validateMappingAgainstSchema(mapping: SemanticMapping, schema: IndustrySchema, path: string): void {
  for (const objectMapping of mapping.objects) {
    const object = schema.objects.find((entry) => entry.objectId === objectMapping.conceptId)
    if (object === undefined) fail('INVALID_MAPPING', path, `mapping concept ${objectMapping.conceptId} is not in the definition`)
    for (const field of objectMapping.fields) {
      const attribute = object.attributes.find((entry) => entry.attributeId === field.fieldRef)
      if (attribute === undefined) fail('INVALID_MAPPING', path, `mapping field ${field.fieldRef} is not in ${object.objectId}`)
      if (attribute.valueType !== field.valueType) fail('INVALID_MAPPING', path, `mapping field ${field.fieldRef} has the wrong value type`)
      if (attribute.unitCode !== field.unit?.unitCode) fail('INVALID_MAPPING', path, `mapping field ${field.fieldRef} has the wrong canonical unit`)
    }
  }
  for (const link of mapping.links) {
    const relation = schema.relations.find((entry) => entry.relationId === link.linkId)
    if (relation === undefined || relation.fromObjectId !== link.fromConceptId || relation.toObjectId !== link.toConceptId) {
      fail('INVALID_MAPPING', path, `mapping link ${link.linkId} does not match the definition relation`)
    }
  }
}

function makeProjection(draft: SemanticDefinitionVersionDraft, definitionRef: VersionRef): {
  readonly schema: IndustrySchema
  readonly mappingTemplates: readonly MappingTemplate[]
} {
  // `publishedAt` is needed only by the projection helper's input type; neither the
  // timestamp nor a publication record is returned or persisted by this loader.
  const projectionInput: SemanticDefinitionVersion = {
    ...draft,
    ref: definitionRef,
    publishedAt: '2000-01-01T00:00:00Z',
  }
  const schema = projectIndustrySchema(projectionInput)
  const mappingTemplates = mappingTemplatesOf(definitionRecordOf(projectionInput))
  return { schema, mappingTemplates }
}

function loadScenario(
  directory: string,
  entry: IndexScenario,
  targetScopeRef: ScopeRef,
): CoreExampleScenario {
  const manifestPath = resolveAsset(directory, entry.industryManifest, `${entry.scenarioId}.industryManifest`)
  const industryManifest = parseIndustryManifest(readJsonFile(manifestPath), manifestPath)
  const manifestRecord = recordOf(industryManifest, manifestPath)
  const definitionPath = resolveAsset(directory, entry.definitionDraft, `${entry.scenarioId}.definitionDraft`)
  const definitionDraft = parseDefinitionDraft(readJsonFile(definitionPath), definitionPath, targetScopeRef)
  if (definitionDraft.namespace !== entry.namespace || manifestRecord['namespace'] !== entry.namespace) {
    fail('INVALID_ASSET', entry.scenarioId, 'index, manifest and semantic definition namespaces must match')
  }
  if (findIndustryPackViolations(industryManifest).length > 0) {
    fail('INVALID_ASSET', manifestPath, 'industry manifest contains fields or values forbidden by the industry-pack contract')
  }
  const definitionRef: VersionRef = {
    id: definitionDraft.definitionId,
    version: definitionDraft.version,
    digest: definitionVersionDigest(definitionDraft),
  }
  const manifestDefinitionRef = parseVersionRef(manifestRecord['definitionsRef'], `${manifestPath}.definitionsRef`)
  if (!sameVersionRef(manifestDefinitionRef, definitionRef)) {
    fail('CONTENT_DIGEST_MISMATCH', manifestPath, 'manifest definitionsRef does not pin the loaded definition draft')
  }
  const projection = makeProjection(definitionDraft, definitionRef)
  const manifestQueryRef = parseVersionRef(manifestRecord['queryTemplatesRef'], `${manifestPath}.queryTemplatesRef`)
  const templatesPath = resolveAsset(directory, entry.mappingTemplates, `${entry.scenarioId}.mappingTemplates`)
  const mappingTemplates = parseMappingTemplates(readJsonFile(templatesPath), templatesPath)
  if (sha256DigestOf(mappingTemplates) !== manifestQueryRef.digest) {
    fail('CONTENT_DIGEST_MISMATCH', templatesPath, 'queryTemplatesRef does not pin the mapping templates')
  }
  if (sha256DigestOf(mappingTemplates) !== sha256DigestOf(projection.mappingTemplates)) {
    fail('INVALID_ASSET', templatesPath, 'mapping templates do not match the validated definition draft')
  }
  const policyPath = resolveAsset(directory, entry.syntheticPolicy.path, `${entry.scenarioId}.syntheticPolicy`)
  const policyText = readTextFile(policyPath)
  const policyRef = parseVersionRef(manifestRecord['rulePolicyRef'], `${manifestPath}.rulePolicyRef`)
  if (sha256DigestOf(policyText) !== policyRef.digest) {
    fail('CONTENT_DIGEST_MISMATCH', policyPath, 'rulePolicyRef does not pin the synthetic policy text')
  }
  const rawSources = entry.rawSources.map((source, index) => ({
    ...source,
    path: resolveAsset(directory, source.path, `${entry.scenarioId}.rawSources[${String(index)}]`),
  }))
  const syntheticPolicy: CoreExampleSourceFile = { ...entry.syntheticPolicy, path: policyPath }
  const rawSourceKeys = new Set(rawSources.map((source) => sourceKey(source.sourceRef)))
  const physicalMappings = entry.physicalMappings.map((mappingEntry, index) => {
    const path = resolveAsset(directory, mappingEntry.path, `${entry.scenarioId}.physicalMappings[${String(index)}]`)
    const mapping = buildSemanticMapping(readJsonFile(path), path)
    if (!sameVersionRef(mapping.mappingRef, mappingEntry.ref)) {
      fail('CONTENT_DIGEST_MISMATCH', path, 'index mapping ref does not match the mapping asset')
    }
    validateMappingAgainstSchema(mapping, projection.schema, path)
    for (const object of mapping.objects) {
      if (!rawSourceKeys.has(sourceKey(object.sourceObjectRef.sourceRef))) {
        fail('INVALID_MAPPING', path, `mapping source ${object.sourceObjectRef.sourceRef.sourceId} is not listed in rawSources`)
      }
    }
    return { mapping, ref: mapping.mappingRef, path }
  })
  const testSuitePath = resolveAsset(directory, entry.testSuite, `${entry.scenarioId}.testSuite`)
  const testSuite = parseTestSuite(readJsonFile(testSuitePath), testSuitePath)
  const testSuiteRef = parseVersionRef(manifestRecord['testSuiteRef'], `${manifestPath}.testSuiteRef`)
  if (!sameVersionRef(testSuite.ref, testSuiteRef)) {
    fail('CONTENT_DIGEST_MISMATCH', testSuitePath, 'test suite ref does not match manifest.testSuiteRef')
  }
  if (sha256DigestOf(testSuite.cases) !== testSuite.ref.digest) {
    fail('CONTENT_DIGEST_MISMATCH', testSuitePath, 'test suite digest does not match its cases')
  }
  if (entry.namespace !== industryManifest.namespace) {
    fail('INVALID_INDEX', entry.scenarioId, 'namespace does not match the loaded IndustryManifest')
  }
  return {
    scenarioId: entry.scenarioId,
    label: entry.label,
    profileRef: entry.profileRef,
    namespace: entry.namespace,
    industryManifest,
    definitionDraft,
    definitionRef,
    industrySchema: projection.schema,
    mappingTemplates,
    physicalMappings,
    rawSources,
    syntheticPolicy,
    testSuite,
    goldenEntityIds: entry.goldenEntityIds,
    ...(entry.calibrationOnlyEntityIds === undefined ? {} : { calibrationOnlyEntityIds: entry.calibrationOnlyEntityIds }),
  }
}

function sourceKey(sourceRef: SourceRef): string {
  return `${sourceRef.namespace}\u0000${sourceRef.sourceId}`
}

/** Load and validate the configured synthetic example declarations without seeding or executing anything. */
export function loadCoreExamples(options: LoadCoreExamplesOptions): LoadedCoreExamples {
  const targetScopeRef = parseScopeRef(options.targetScopeRef, 'targetScopeRef')
  const indexPath = resolve(options.indexPath ?? DEFAULT_INDEX_PATH)
  let resolvedIndexPath: string
  try {
    resolvedIndexPath = realpathSync(indexPath)
    const indexStatus = statSync(resolvedIndexPath)
    if (!indexStatus.isFile()) fail('INVALID_INDEX', indexPath, 'indexPath must be a regular file')
    if (indexStatus.size > MAX_ASSET_BYTES) fail('INVALID_INDEX', indexPath, 'index exceeds the size limit')
  } catch (error) {
    if (error instanceof CoreExampleLoaderError) throw error
    fail('ASSET_READ_FAILED', indexPath, 'examples index could not be resolved', error)
  }
  const directory = dirname(resolvedIndexPath)
  const parsedIndex = parseIndex(readJsonFile(resolvedIndexPath))
  const scenarios = parsedIndex.scenarios.map((scenario) => loadScenario(directory, scenario, targetScopeRef))
  const ids = new Set<string>()
  const profileRefs = new Set<string>()
  for (const scenario of scenarios) {
    if (ids.has(scenario.scenarioId)) fail('INVALID_INDEX', resolvedIndexPath, 'scenario ids must be unique')
    ids.add(scenario.scenarioId)
    const refKey = `${scenario.profileRef.id}@${scenario.profileRef.version}`
    if (profileRefs.has(refKey)) fail('INVALID_INDEX', resolvedIndexPath, 'profile refs must be unique')
    profileRefs.add(refKey)
  }
  return { indexPath: resolvedIndexPath, classification: parsedIndex.classification, scenarios }
}
