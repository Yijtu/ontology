import { createHash } from 'node:crypto'
import type {
  MappingRef,
  PlanSpec,
  PlanStep,
  ProfileRef,
  ScopeRef,
  Sha256Digest,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import type { CoreExampleScenario } from './core-example-loader'

export type CoreFactsPlanErrorCode =
  | 'INVALID_QUESTION'
  | 'TOO_MANY_PROPERTIES'
  | 'DUPLICATE_PROPERTY'
  | 'UNKNOWN_PROPERTY'
  | 'AMBIGUOUS_PROPERTY'
  | 'INVALID_RUN_PROFILE'
  | 'INVALID_PROFILE_HASH'
  | 'INVALID_DEFINITION_PIN'
  | 'TOO_MANY_MAPPING_PINS'
  | 'UNMOUNTED_MAPPING_PIN'
  | 'MAPPING_SOURCE_MISMATCH'

/** Safe, explicit rejection for unsupported or unregistered facts shortcuts. */
export class CoreFactsPlanError extends Error {
  readonly code: CoreFactsPlanErrorCode

  constructor(code: CoreFactsPlanErrorCode, message: string) {
    super(message)
    this.name = 'CoreFactsPlanError'
    this.code = code
  }
}

export interface CoreFactsPlanInput {
  /** Scenario selected from the actual resolved profile's mounted industry ref by the host. */
  readonly scenario: CoreExampleScenario
  /** The exact profile id/version pinned into this run; it need not share the scenario's base profile id. */
  readonly runProfileRef: ProfileRef
  /** The run's immutable resolved profile snapshot hash. */
  readonly resolvedProfileHash: Sha256Digest
  /** Mapping refs from that resolved profile, not every mapping in the deployment. */
  readonly mappingRefs: readonly MappingRef[]
  /** The exact mounted semantic definition selected for this run. */
  readonly definitionRef: VersionRef
  /** Trusted tenant/space selected from the request context by the host. */
  readonly scopeRef: ScopeRef
  /** `facts:<property>` or at most three comma-separated registered property IDs. */
  readonly question: string
}

const PLAN_VERSION = '1.0.0'
const MAX_FACT_PROPERTIES = 3
const MAX_MAPPING_REFS = 64
const MAX_QUESTION_BYTES = 1_024
const MAX_PROPERTY_ID_BYTES = 256

/** Build a bounded read-only facts plan using only one validated mounted scenario. */
export function createCoreFactsPlan(input: CoreFactsPlanInput): PlanSpec {
  validateRunPins(input)
  const propertyIds = propertyIdsOf(input.question)
  const attributesById = new Map<string, number>()
  for (const object of input.scenario.industrySchema.objects) {
    for (const attribute of object.attributes) {
      attributesById.set(attribute.attributeId, (attributesById.get(attribute.attributeId) ?? 0) + 1)
    }
  }
  for (const propertyId of propertyIds) {
    const matches = attributesById.get(propertyId) ?? 0
    if (matches === 0) {
      throw new CoreFactsPlanError('UNKNOWN_PROPERTY', 'the requested facts property is not registered in this scenario')
    }
    if (matches !== 1) {
      throw new CoreFactsPlanError('AMBIGUOUS_PROPERTY', 'the requested facts property is not unique in this scenario')
    }
  }

  const scopeRef: ScopeRef = {
    tenantId: input.scopeRef.tenantId,
    spaceId: input.scopeRef.spaceId,
  }
  const mappingRefs = [...input.mappingRefs].sort(compareMappingRefs)
  const steps: PlanStep[] = propertyIds.map((propertyId, index) => ({
    stepId: `facts-${String(index + 1)}`,
    toolId: 'ontology_lookup',
    readOnly: true,
    args: [
      { name: 'scopeRef', required: true, source: { kind: 'literal', value: scopeRef } },
      { name: 'intent', required: true, source: { kind: 'literal', value: 'facts' } },
      {
        name: 'concepts',
        required: true,
        source: {
          kind: 'literal',
            value: [{ namespace: input.scenario.namespace, conceptId: propertyId, definitionVersion: input.definitionRef.version }],
        },
      },
      { name: 'limit', required: true, source: { kind: 'literal', value: 100 } },
    ],
    dependsOn: [],
    failureBehaviour: 'abort',
  }))
  const identity = {
    planKind: 'core-published-facts',
    planVersion: PLAN_VERSION,
    scenarioId: input.scenario.scenarioId,
    namespace: input.scenario.namespace,
    runProfileRef: input.runProfileRef,
    resolvedProfileHash: input.resolvedProfileHash,
    scopeRef,
    definitionRef: input.definitionRef,
    mappingRefs,
    propertyIds,
    steps,
  }
  const digest = sha256DigestOf(canonicalJson(identity))
  return {
    planRef: {
      id: uuidFromDigest(digest),
      version: PLAN_VERSION,
      digest,
      kind: 'plan',
    },
    steps,
  }
}

function validateRunPins(input: CoreFactsPlanInput): void {
  if (
    input.runProfileRef.id.trim().length === 0 ||
    input.runProfileRef.version.trim().length === 0
  ) {
    throw new CoreFactsPlanError('INVALID_RUN_PROFILE', 'the run profile ref is incomplete')
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.resolvedProfileHash)) {
    throw new CoreFactsPlanError('INVALID_PROFILE_HASH', 'the run has no valid resolved profile snapshot hash')
  }
  if (
    !sameVersionRef(input.definitionRef, input.scenario.definitionRef) ||
    !sameVersionRef(input.scenario.industrySchema.definitionRef, input.scenario.definitionRef) ||
    input.scenario.industrySchema.namespace !== input.scenario.namespace
  ) {
    throw new CoreFactsPlanError('INVALID_DEFINITION_PIN', 'the selected definition is not the mounted scenario definition')
  }
  if (input.mappingRefs.length > MAX_MAPPING_REFS) {
    throw new CoreFactsPlanError('TOO_MANY_MAPPING_PINS', 'the resolved profile contains too many mappings for a facts plan')
  }
  for (const resolvedMapping of input.mappingRefs) {
    const mounted = input.scenario.physicalMappings.find((entry) => sameVersionRef(entry.ref, resolvedMapping))
    if (mounted === undefined) {
      throw new CoreFactsPlanError('UNMOUNTED_MAPPING_PIN', 'a resolved mapping ref is not mounted by this scenario')
    }
    if (!mounted.mapping.objects.some((object) => sameSourceObjectRef(object.sourceObjectRef, resolvedMapping.sourceObjectRef))) {
      throw new CoreFactsPlanError('MAPPING_SOURCE_MISMATCH', 'a resolved mapping source is not part of the mounted mapping')
    }
  }
}

function propertyIdsOf(question: string): readonly string[] {
  const trimmed = question.trim()
  const encoder = new TextEncoder()
  if (encoder.encode(trimmed).byteLength > MAX_QUESTION_BYTES) {
    throw new CoreFactsPlanError('INVALID_QUESTION', 'the facts property list exceeds the supported length')
  }
  if (!trimmed.startsWith('facts:')) {
    throw new CoreFactsPlanError('INVALID_QUESTION', 'use facts:<property> or facts:<property>,<property>')
  }
  const value = trimmed.slice('facts:'.length)
  if (value.length === 0) {
    throw new CoreFactsPlanError('INVALID_QUESTION', 'at least one facts property is required')
  }
  const propertyIds = value.split(',').map((property) => property.trim())
  if (propertyIds.length > MAX_FACT_PROPERTIES) {
    throw new CoreFactsPlanError('TOO_MANY_PROPERTIES', 'a facts plan can contain at most three properties')
  }
  if (propertyIds.some((property) => property.length === 0)) {
    throw new CoreFactsPlanError('INVALID_QUESTION', 'the facts property list contains an empty identifier')
  }
  if (propertyIds.some((property) => encoder.encode(property).byteLength > MAX_PROPERTY_ID_BYTES)) {
    throw new CoreFactsPlanError('INVALID_QUESTION', 'a facts property identifier exceeds the supported length')
  }
  if (new Set(propertyIds).size !== propertyIds.length) {
    throw new CoreFactsPlanError('DUPLICATE_PROPERTY', 'a facts property may appear only once in a plan')
  }
  return propertyIds
}

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameSourceObjectRef(left: MappingRef['sourceObjectRef'], right: MappingRef['sourceObjectRef']): boolean {
  return left.objectPath === right.objectPath &&
    left.sourceRef.namespace === right.sourceRef.namespace &&
    left.sourceRef.sourceId === right.sourceRef.sourceId
}

function compareMappingRefs(left: MappingRef, right: MappingRef): number {
  const leftKey = canonicalJson(left)
  const rightKey = canonicalJson(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

function uuidFromDigest(digest: string): string {
  const hex = createHash('sha256').update(digest, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
