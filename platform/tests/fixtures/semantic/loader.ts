import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject, ValidateFunction } from 'ajv'
import { SCHEMA_DOCUMENTS } from '@ontology/contracts'
import type {
  ControlReadProjectionRequest,
  DecimalQuantity,
  DomainResultStatus,
  EvidenceEnvelope,
  ScopeRef,
  SemanticFilter,
  SourceRef,
  ValidityInterval,
  VersionRef,
} from '@ontology/contracts'

/**
 * LOCAL-048 semantic regression fixture loader.
 *
 * The fixtures are declarative JSON authored from the current SPEC/PRD. This
 * module only reads, validates and canonicalises them: it performs no network,
 * clock, randomness or database access, imports no historical program and reads
 * nothing outside `tests/fixtures/semantic/`. Gold values live in the JSON, not
 * in this code, so consumers (LOCAL-032/033/034/054) can never derive them from
 * a running implementation.
 */

export const semanticFixtureDir = fileURLToPath(new URL('.', import.meta.url))
export const fixtureSchemaFile = 'semantic-fixture.schema.json'
export const fixtureSchemaId = 'https://ontology.local/tests/semantic-fixture.schema.json'

/** Canonical schema documents exported by @ontology/contracts, addressed by $id. */
export const schemaRef = (file: string, defName: string): string =>
  `https://ontology.local/schema/${file}#/$defs/${defName}`

export const SCENARIO_KINDS = [
  'and_prerequisites',
  'or_alternative_support',
  'last_support_retraction',
  'unknown_conflict',
  'numeric_boundary',
  'partial_validity_correction',
  'history_view',
] as const

export type ScenarioKind = (typeof SCENARIO_KINDS)[number]

export type AssertionOp = 'assert' | 'correct' | 'retract'

export type OperationKind =
  | 'publish_assertion'
  | 'correct_assertion'
  | 'retract_assertion'
  | 'evaluate_rule'
  | 'read_projection'

export type AssertionValue = DecimalQuantity | string | boolean

export interface FixtureProvenance {
  specRefs: string[]
  functionalRequirements: string[]
  userStories: string[]
  acceptanceRefs?: string[]
  derivation: string
}

export interface FixtureAssertion {
  assertionId: string
  logicalAssertionId: string
  recordedSeq: string
  op: AssertionOp
  subject: string
  predicate: string
  value?: AssertionValue
  validity: ValidityInterval
  sourceRef: SourceRef
  evidenceId?: string
}

export interface FixtureAlternative {
  alternativeId: string
  assertionId: string
}

export interface FixturePremiseGroup {
  groupId: string
  filter: SemanticFilter
  alternatives: FixtureAlternative[]
}

export interface FixtureRule {
  ruleRef: VersionRef
  ruleId: string
  premiseGroups: FixturePremiseGroup[]
  conclusion: {
    propositionKey: string
    predicate?: string
    value?: AssertionValue
  }
}

export interface FixtureOperationStep {
  stepId: string
  kind: OperationKind
  assertionId?: string
  ruleId?: string
  asOfRecordedSeq?: string
  validAt?: string
}

export interface FixtureSatisfiedBy {
  groupId: string
  alternativeIds: string[]
}

export interface FixtureConclusionExpectation {
  propositionKey: string
  domainStatus: DomainResultStatus
  value?: AssertionValue
  satisfiedBy?: FixtureSatisfiedBy[]
  note?: string
}

export interface FixtureConflictExpectation {
  propositionKey: string
  assertionIds: string[]
  note?: string
}

export interface FixtureEvidenceCondition {
  evidenceId: string
  condition: string
  required: boolean
}

export interface FixtureViewExpectation {
  viewId: string
  description: string
  request: ControlReadProjectionRequest
  isCurrent: boolean
  conclusions: FixtureConclusionExpectation[]
  gaps?: string[]
  conflicts?: FixtureConflictExpectation[]
}

export interface FixtureExpected {
  views: FixtureViewExpectation[]
  evidenceConditions: FixtureEvidenceCondition[]
}

export interface SemanticFixture {
  fixtureId: string
  scenarioKind: ScenarioKind
  title: string
  provenance: FixtureProvenance
  notes?: string[]
  scopeRef: ScopeRef
  assertions: FixtureAssertion[]
  rules: FixtureRule[]
  evidence: EvidenceEnvelope[]
  operations: FixtureOperationStep[]
  expected: FixtureExpected
}

function readJsonFile(name: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(join(semanticFixtureDir, name), 'utf8'))
  return parsed
}

/** Ajv instance with every canonical @ontology/contracts schema registered by $id. */
export function createCanonicalAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    validateFormats: true,
  })
  addFormats(ajv)
  for (const document of SCHEMA_DOCUMENTS) {
    ajv.addSchema(document as SchemaObject)
  }
  return ajv
}

/** Validator for any canonical `$defs` entry, e.g. schemaRef('evidence.schema.json', 'EvidenceEnvelope'). */
export function canonicalValidator(ref: string): ValidateFunction {
  const ajv = createCanonicalAjv()
  const validate = ajv.getSchema(ref)
  if (validate === undefined) throw new Error(`no canonical schema registered for ${ref}`)
  return validate
}

/** Validator for the local fixture envelope, which $refs the canonical schemas. */
export function createFixtureValidator(): ValidateFunction {
  const ajv = createCanonicalAjv()
  ajv.addSchema(readJsonFile(fixtureSchemaFile) as SchemaObject)
  const validate = ajv.getSchema(fixtureSchemaId)
  if (validate === undefined) throw new Error(`no fixture schema registered for ${fixtureSchemaId}`)
  return validate
}

/** Fixture file names in stable sorted order. */
export function fixtureFiles(): string[] {
  return readdirSync(semanticFixtureDir)
    .filter((name) => name.endsWith('.fixture.json'))
    .sort()
}

/** Validate one raw fixture document and return it as a typed fixture. */
export function parseFixture(
  raw: unknown,
  label: string,
  validate: ValidateFunction = createFixtureValidator(),
): SemanticFixture {
  if (!validate(raw)) {
    throw new Error(`fixture ${label} failed schema validation: ${JSON.stringify(validate.errors)}`)
  }
  return raw as SemanticFixture
}

/**
 * Load, validate and return every fixture sorted by fixtureId. Loading twice
 * yields identical values and an identical {@link fixtureSetDigest}.
 */
export function loadFixtures(): SemanticFixture[] {
  const validate = createFixtureValidator()
  const fixtures = fixtureFiles().map((name) => parseFixture(readJsonFile(name), name, validate))
  fixtures.sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0))
  const ids = new Set<string>()
  for (const fixture of fixtures) {
    if (ids.has(fixture.fixtureId)) throw new Error(`duplicate fixtureId ${fixture.fixtureId}`)
    ids.add(fixture.fixtureId)
  }
  return fixtures
}

/** Recursively sort object keys; array order stays significant (operation order). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry))
  if (value !== null && typeof value === 'object') {
    const sorted = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    const result: Record<string, unknown> = {}
    for (const [key, entry] of sorted) result[key] = canonicalize(entry)
    return result
  }
  return value
}

/** Stable, whitespace-free serialisation used for digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** sha256 over the canonical serialisation of the whole fixture set, order-independent. */
export function fixtureSetDigest(fixtures: readonly SemanticFixture[]): string {
  const ordered = [...fixtures].sort((a, b) =>
    a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0,
  )
  return `sha256:${createHash('sha256').update(canonicalJson(ordered)).digest('hex')}`
}

export function fixturesOfKind(
  fixtures: readonly SemanticFixture[],
  kind: ScenarioKind,
): SemanticFixture[] {
  return fixtures.filter((fixture) => fixture.scenarioKind === kind)
}
