import type {
  ResourceRef,
  StandardProvenance,
  VersionRef,
} from '@ontology/contracts'
import type {
  AttributeDefinition,
  IdentityScopeDefinition,
  ObjectDefinition,
  RelationDefinition,
  RuleConstraintDefinition,
  SemanticDefinitionVersionDraft,
} from '@ontology/semantic-engine'
import { DIGEST_A } from './component-registry-fixtures'

export {
  DIGEST_A,
  DIGEST_B,
  RESERVATION_ID,
  RUN_A,
  SPACE_A,
  SPACE_B,
  TENANT_A,
  TENANT_B,
  fixedClock,
  toolContext,
} from './component-registry-fixtures'
export { RecordingControlRepository } from './component-registry-fixtures'

export const NAMESPACE = 'home-energy'
export const CORE_DEFINITION_ID = 'home-energy.core'
export const EXTENSION_DEFINITION_ID = 'acme.device-extension'
export const DATA_REF_ID = '77777777-7777-4777-8777-777777777777'

/** One published standard source, reused by every definition in the fixtures. */
export function provenance(standardId = 'iec-61851-1'): StandardProvenance[] {
  return [
    {
      standardRef: { id: standardId, version: '1.0.0', digest: DIGEST_A },
      provenanceKind: 'international_standard',
      clauseRef: '5.2',
    },
  ]
}

export function standardRef(standardId = 'iec-61851-1'): VersionRef {
  return { id: standardId, version: '1.0.0', digest: DIGEST_A }
}

export function dataRef(digest = DIGEST_A): ResourceRef {
  return { id: DATA_REF_ID, version: '1.0.0', digest, kind: 'dataset' }
}

const DEVICE_IDENTITY: IdentityScopeDefinition = {
  kind: 'identity_scope',
  id: 'device_identity',
  namespace: NAMESPACE,
  objectId: 'device',
  scopeDimensions: ['source', 'site', 'device_type'],
  identityAttributeIds: ['device_native_id'],
  standardProvenance: provenance(),
}

const METER_IDENTITY: IdentityScopeDefinition = {
  kind: 'identity_scope',
  id: 'meter_identity',
  namespace: NAMESPACE,
  objectId: 'meter',
  scopeDimensions: ['source', 'site'],
  identityAttributeIds: ['meter_native_id'],
  standardProvenance: provenance(),
}

const DEVICE: ObjectDefinition = {
  kind: 'object',
  id: 'device',
  namespace: NAMESPACE,
  displayName: 'Device',
  identityScopeId: 'device_identity',
  standardProvenance: provenance(),
}

const METER: ObjectDefinition = {
  kind: 'object',
  id: 'meter',
  namespace: NAMESPACE,
  displayName: 'Meter',
  identityScopeId: 'meter_identity',
  standardProvenance: provenance(),
}

const DEVICE_NATIVE_ID: AttributeDefinition = {
  kind: 'attribute',
  id: 'device_native_id',
  namespace: NAMESPACE,
  objectId: 'device',
  valueType: 'string',
  cardinality: { min: 1, max: 1 },
  identityKey: true,
  standardProvenance: provenance(),
}

const DEVICE_NAME: AttributeDefinition = {
  kind: 'attribute',
  id: 'device_name',
  namespace: NAMESPACE,
  objectId: 'device',
  valueType: 'string',
  cardinality: { min: 0, max: 1 },
  standardProvenance: provenance(),
}

const RATED_POWER: AttributeDefinition = {
  kind: 'attribute',
  id: 'rated_power',
  namespace: NAMESPACE,
  objectId: 'device',
  valueType: 'quantity',
  cardinality: { min: 0, max: 1 },
  unit: { unitCode: 'kW', dimension: 'power' },
  standardProvenance: provenance(),
}

const DEVICE_KIND: AttributeDefinition = {
  kind: 'attribute',
  id: 'device_kind',
  namespace: NAMESPACE,
  objectId: 'device',
  valueType: 'enum',
  cardinality: { min: 1, max: 1 },
  enumValues: ['charger', 'inverter'],
  standardProvenance: provenance(),
}

const METER_NATIVE_ID: AttributeDefinition = {
  kind: 'attribute',
  id: 'meter_native_id',
  namespace: NAMESPACE,
  objectId: 'meter',
  valueType: 'string',
  cardinality: { min: 1, max: 1 },
  identityKey: true,
  standardProvenance: provenance(),
}

const METER_DEVICE: AttributeDefinition = {
  kind: 'attribute',
  id: 'meter_device',
  namespace: NAMESPACE,
  objectId: 'meter',
  valueType: 'reference',
  cardinality: { min: 0, max: 1 },
  referencesObjectId: 'device',
  standardProvenance: provenance(),
}

const METER_MONITORS_DEVICE: RelationDefinition = {
  kind: 'relation',
  id: 'meter_monitors_device',
  namespace: NAMESPACE,
  fromObjectId: 'meter',
  toObjectId: 'device',
  cardinality: { min: 0, max: 'unbounded' },
  standardProvenance: provenance(),
}

const POWER_POSITIVE: RuleConstraintDefinition = {
  kind: 'rule_constraint',
  id: 'device_rated_power_nonnegative',
  namespace: NAMESPACE,
  objectId: 'device',
  severity: 'hard',
  expression: { op: 'range', attributeId: 'rated_power', min: 0 },
  standardProvenance: provenance(),
}

const KIND_OR_NAME: RuleConstraintDefinition = {
  kind: 'rule_constraint',
  id: 'device_kind_or_name',
  namespace: NAMESPACE,
  objectId: 'device',
  severity: 'soft',
  expression: {
    op: 'all',
    operands: [
      { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'charger' },
      { op: 'not', operand: { op: 'compare', attributeId: 'device_name', operator: 'ne', value: 'retired' } },
    ],
  },
  standardProvenance: provenance(),
}

const METER_HAS_DEVICE: RuleConstraintDefinition = {
  kind: 'rule_constraint',
  id: 'meter_monitors_something',
  namespace: NAMESPACE,
  objectId: 'meter',
  severity: 'soft',
  expression: { op: 'relation', relationId: 'meter_monitors_device' },
  standardProvenance: provenance(),
}

/**
 * A complete, valid industry-core definition version. Every reference resolves, every
 * unit/cardinality/identity scope is consistent and each definition cites a standard.
 */
export function sampleCoreDraft(
  overrides?: Partial<SemanticDefinitionVersionDraft>,
): SemanticDefinitionVersionDraft {
  return {
    scopeRef: { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    definitionId: CORE_DEFINITION_ID,
    version: '1.0.0',
    namespace: NAMESPACE,
    layer: 'industry_core',
    standardProvenance: provenance(),
    objects: [structuredClone(DEVICE), structuredClone(METER)],
    attributes: [
      structuredClone(DEVICE_NATIVE_ID),
      structuredClone(DEVICE_NAME),
      structuredClone(RATED_POWER),
      structuredClone(DEVICE_KIND),
      structuredClone(METER_NATIVE_ID),
      structuredClone(METER_DEVICE),
    ],
    relations: [structuredClone(METER_MONITORS_DEVICE)],
    identityScopes: [structuredClone(DEVICE_IDENTITY), structuredClone(METER_IDENTITY)],
    ruleConstraints: [
      structuredClone(POWER_POSITIVE),
      structuredClone(KIND_OR_NAME),
      structuredClone(METER_HAS_DEVICE),
    ],
    ...overrides,
  }
}

/** A customer extension that adds one attribute to the core `device` object. */
export function sampleExtensionDraft(baseRef: VersionRef): SemanticDefinitionVersionDraft {
  const warranty: AttributeDefinition = {
    kind: 'attribute',
    id: 'acme_warranty_until',
    namespace: NAMESPACE,
    objectId: 'device',
    valueType: 'timestamp',
    cardinality: { min: 0, max: 1 },
    standardProvenance: provenance('acme-internal-policy'),
  }
  return {
    scopeRef: { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    definitionId: EXTENSION_DEFINITION_ID,
    version: '1.0.0',
    namespace: NAMESPACE,
    layer: 'customer_extension',
    baseRef,
    standardProvenance: provenance('acme-internal-policy'),
    objects: [],
    attributes: [warranty],
    relations: [],
    identityScopes: [],
    ruleConstraints: [],
  }
}
